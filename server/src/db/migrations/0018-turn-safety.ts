import { createHash } from 'node:crypto'

export const TURN_SAFETY_SQL = `
CREATE TABLE company_turn_safety (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  generation BIGINT NOT NULL DEFAULT 0,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE turn_budget_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL CHECK (period IN ('day', 'month')),
  metric TEXT NOT NULL CHECK (metric IN ('tokens', 'usd')),
  ceiling DOUBLE PRECISION NOT NULL CHECK (ceiling > 0 AND ceiling < 'Infinity'::float8),
  UNIQUE (company_id, agent_id, period, metric)
);
CREATE TABLE turn_budget_usage (
  company_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  period TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  tokens BIGINT NOT NULL DEFAULT 0,
  usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, agent_id, period, period_start)
);
CREATE TABLE turn_safety_events (
  id BIGSERIAL PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id TEXT,
  kind TEXT NOT NULL,
  actor_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe TEXT UNIQUE
);
CREATE INDEX turn_safety_events_company ON turn_safety_events(company_id, created_at DESC);
-- Counters survive raw-ledger retention. Inserts and corrections are applied in
-- the same transaction as the usage row; ON CONFLICT retries never double count.
CREATE FUNCTION update_turn_budget_usage() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r RECORD; delta INTEGER; scope TEXT; grain TEXT;
BEGIN
  FOR delta IN 0..(CASE WHEN TG_OP = 'UPDATE' THEN 1 ELSE 0 END) LOOP
    IF TG_OP = 'UPDATE' AND delta = 0 THEN r := OLD; ELSE r := NEW; END IF;
    IF r.company_id IS NULL THEN CONTINUE; END IF;
    FOREACH scope IN ARRAY CASE WHEN r.agent_id IS NULL OR r.agent_id = '' THEN ARRAY[''] ELSE ARRAY['', r.agent_id] END LOOP
      FOREACH grain IN ARRAY ARRAY['day', 'month'] LOOP
        INSERT INTO turn_budget_usage(company_id, agent_id, period, period_start, tokens, usd)
        VALUES (r.company_id, scope, grain, date_trunc(grain, r.created_at, 'UTC'),
          (r.input_tokens::bigint + r.cached_input_tokens + r.cache_creation_tokens + r.output_tokens) *
            CASE WHEN TG_OP = 'UPDATE' AND delta = 0 THEN -1 ELSE 1 END,
          r.cost_usd * CASE WHEN TG_OP = 'UPDATE' AND delta = 0 THEN -1 ELSE 1 END)
        ON CONFLICT (company_id, agent_id, period, period_start) DO UPDATE
          SET tokens = turn_budget_usage.tokens + EXCLUDED.tokens, usd = turn_budget_usage.usd + EXCLUDED.usd;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER turn_budget_usage_write AFTER INSERT OR UPDATE ON llm_calls
FOR EACH ROW EXECUTE FUNCTION update_turn_budget_usage();
-- Import canonical completed hours, then raw calls for uncovered hours. This
-- preserves current-period usage even when raw-call retention already ran.
WITH v2_hours AS (
 SELECT DISTINCT r.company_id, r.bucket_hour FROM llm_calls_rollup_v2 r CROSS JOIN llm_rollup_state st
 WHERE r.bucket_hour >= date_trunc('month', NOW(), 'UTC')
   AND r.bucket_hour >= st.coverage_from AND r.bucket_hour < st.completed_through
), v1_hours AS (
 SELECT DISTINCT r.company_id, r.bucket_hour FROM llm_calls_rollup r
 WHERE r.bucket_hour >= date_trunc('month', NOW(), 'UTC')
   AND r.bucket_hour < date_trunc('hour', NOW(), 'UTC')
   AND NOT EXISTS (SELECT 1 FROM v2_hours v WHERE v.company_id = r.company_id AND v.bucket_hour = r.bucket_hour)
   AND NOT EXISTS (SELECT 1 FROM llm_calls l WHERE l.company_id = r.company_id
     AND l.created_at >= r.bucket_hour AND l.created_at < r.bucket_hour + INTERVAL '1 hour')
), seed AS (
 SELECT l.company_id, l.agent_id, l.created_at,
   l.input_tokens::bigint + l.cached_input_tokens + l.cache_creation_tokens + l.output_tokens AS tokens, l.cost_usd
 FROM llm_calls l WHERE l.created_at >= date_trunc('month', NOW(), 'UTC')
   AND NOT EXISTS (SELECT 1 FROM v2_hours v WHERE v.company_id = l.company_id
     AND l.created_at >= v.bucket_hour AND l.created_at < v.bucket_hour + INTERVAL '1 hour')
 UNION ALL
 SELECT r.company_id, r.agent_id, r.bucket_hour,
   r.input_tokens + r.cached_input_tokens + r.cache_creation_tokens + r.output_tokens, r.cost_usd
 FROM llm_calls_rollup_v2 r JOIN v2_hours v USING(company_id, bucket_hour)
 UNION ALL
 SELECT r.company_id, r.agent_id, r.bucket_hour,
   r.input_tokens + r.cached_input_tokens + r.cache_creation_tokens + r.output_tokens, r.cost_usd
 FROM llm_calls_rollup r JOIN v1_hours v USING(company_id, bucket_hour)
)
INSERT INTO turn_budget_usage(company_id, agent_id, period, period_start, tokens, usd)
SELECT company_id, scope, grain, date_trunc(grain, created_at, 'UTC'), SUM(tokens), SUM(cost_usd)
FROM seed CROSS JOIN LATERAL unnest(CASE WHEN agent_id IS NULL OR agent_id = '' THEN ARRAY[''] ELSE ARRAY['', agent_id] END) scope
CROSS JOIN unnest(ARRAY['day', 'month']) grain WHERE company_id IS NOT NULL
GROUP BY company_id, scope, grain, date_trunc(grain, created_at, 'UTC');

`

export function turnSafetyChecksum(): string {
  return createHash('sha256').update(TURN_SAFETY_SQL).digest('hex')
}
