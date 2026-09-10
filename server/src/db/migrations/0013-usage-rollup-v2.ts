import { createHash } from 'node:crypto'

export const USAGE_ROLLUP_V2_SQL = `
CREATE TABLE llm_calls_rollup_v2 (LIKE llm_calls_rollup INCLUDING DEFAULTS);
ALTER TABLE llm_calls_rollup_v2
  ADD COLUMN route TEXT,
  ADD COLUMN platform TEXT,
  ADD COLUMN unknown_calls BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN unpriced_calls BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_llm_rollup_v2_key ON llm_calls_rollup_v2
  (bucket_hour, company_id, agent_id, purpose, model, source, daemon_version, route, platform)
  NULLS NOT DISTINCT;
CREATE INDEX idx_llm_rollup_v2_company_hour ON llm_calls_rollup_v2(company_id, bucket_hour);
CREATE TABLE llm_rollup_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  coverage_from TIMESTAMPTZ,
  completed_through TIMESTAMPTZ,
  aggregated_at TIMESTAMPTZ,
  attempted_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'paused'))
);
INSERT INTO llm_rollup_state(id) VALUES (TRUE);
`

export function usageRollupV2Checksum(): string {
  return createHash('sha256').update(USAGE_ROLLUP_V2_SQL).digest('hex')
}
