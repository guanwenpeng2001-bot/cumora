import { createHash } from 'node:crypto'

export const LLM_LEDGER_V2_SQL = `
ALTER TABLE llm_calls
 ADD COLUMN trace_id TEXT, ADD COLUMN logical_call_id TEXT, ADD COLUMN attempt_id TEXT,
 ADD COLUMN attempt_no INTEGER, ADD COLUMN parent_span_id TEXT, ADD COLUMN gateway_request_id TEXT,
 ADD COLUMN upstream_request_id TEXT, ADD COLUMN actor_user_id TEXT, ADD COLUMN billing_subject_id TEXT,
 ADD COLUMN computer_id TEXT, ADD COLUMN engine TEXT, ADD COLUMN profile_ref TEXT,
 ADD COLUMN engine_session_id TEXT, ADD COLUMN event_id TEXT,
 ADD COLUMN source_kind TEXT CHECK(source_kind IN ('sub2api','env','byoa')),
 ADD COLUMN source_id TEXT, ADD COLUMN provider_id TEXT, ADD COLUMN publisher_id TEXT,
 ADD COLUMN platform TEXT, ADD COLUMN route_id TEXT, ADD COLUMN offering_id TEXT,
 ADD COLUMN capability TEXT, ADD COLUMN role TEXT, ADD COLUMN execution_location TEXT,
 ADD COLUMN requested_model TEXT, ADD COLUMN request_model TEXT, ADD COLUMN actual_model TEXT,
 ADD COLUMN canonical_model_id TEXT, ADD COLUMN actual_model_state TEXT NOT NULL DEFAULT 'not_reported'
   CHECK(actual_model_state IN ('reported','inferred','not_reported')),
 ADD COLUMN mapping_revision TEXT,
 ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'attempt' CHECK(record_kind IN ('attempt','decision')),
 ADD COLUMN observation_granularity TEXT NOT NULL DEFAULT 'provider_request' CHECK(observation_granularity IN ('provider_request','engine_turn')),
 ADD COLUMN failure_stage TEXT, ADD COLUMN error_origin TEXT, ADD COLUMN reason_code TEXT,
 ADD COLUMN http_status INTEGER, ADD COLUMN dispatched_at TIMESTAMPTZ, ADD COLUMN finished_at TIMESTAMPTZ,
 ADD COLUMN output_committed BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN units JSONB, ADD COLUMN usage_state TEXT NOT NULL DEFAULT 'unknown', ADD COLUMN usage_provenance TEXT,
 ADD COLUMN raw_usage JSONB, ADD COLUMN reference_cost_usd NUMERIC(30,12), ADD COLUMN upstream_cost_usd NUMERIC(30,12),
 ADD COLUMN quota_debit NUMERIC(30,12), ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD',
 ADD COLUMN price_version_id TEXT, ADD COLUMN tariff_version_id TEXT, ADD COLUMN price_snapshot JSONB,
 ADD COLUMN pricing_state TEXT NOT NULL DEFAULT 'unpriced',
 ADD COLUMN unpriced_reason TEXT CHECK(unpriced_reason IN ('no_price','usage_unavailable','unit_quantity_unavailable','unsupported_billing_unit','unknown_alias','price_version_missing','external_subscription','invalid_usage')),
 ADD COLUMN settlement_state TEXT NOT NULL DEFAULT 'pending',
 ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1, ADD COLUMN catalog_revision TEXT,
 ADD COLUMN binding_revision TEXT, ADD COLUMN entitlement_revision TEXT,
 ADD COLUMN occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ADD COLUMN received_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- Historical rows retain their quality marker. No model-name/provider guessing or deletion of duplicates.
UPDATE llm_calls SET occurred_at=created_at, received_at=created_at,
 source_kind=CASE WHEN source LIKE 'byoa-%' THEN 'byoa' WHEN extras->>'routeKind'='gateway' THEN 'sub2api' WHEN extras->>'routeKind'='direct' THEN 'env' END,
 requested_model=COALESCE(extras->>'requestedModel',model), request_model=COALESCE(extras->>'requestModel',extras->>'requestedModel',model),
 actual_model=NULLIF(extras->>'actualModel',''), actual_model_state=CASE WHEN NULLIF(extras->>'actualModel','') IS NULL THEN 'not_reported' ELSE 'reported' END,
 route_id=extras->>'route', platform=extras->>'platform', logical_call_id=extras->>'logicalCallId',
 usage_state=CASE WHEN measured THEN 'reported' ELSE 'unknown' END, usage_provenance='legacy_unknown',
 reference_cost_usd=CASE WHEN measured AND COALESCE(extras->>'unpriced','') IN ('','false') THEN cost_usd END,
 pricing_state=CASE WHEN measured AND COALESCE(extras->>'unpriced','') IN ('','false') THEN 'priced' ELSE 'unpriced' END,
 unpriced_reason=CASE WHEN NOT measured THEN 'usage_unavailable' ELSE 'price_version_missing' END;
CREATE TABLE model_pricing_versions (
 id TEXT PRIMARY KEY, offering_id TEXT NOT NULL REFERENCES model_offerings(id), version INTEGER NOT NULL,
 effective_from TIMESTAMPTZ NOT NULL, effective_to TIMESTAMPTZ, currency TEXT NOT NULL DEFAULT 'USD',
 unit_schema JSONB NOT NULL, rates JSONB NOT NULL, origin TEXT NOT NULL, verified_at TIMESTAMPTZ, note TEXT,
 UNIQUE(offering_id,version), CHECK(effective_to IS NULL OR effective_to>effective_from)
);
-- Serialize publication per offering and prohibit edits to historical snapshots.
CREATE FUNCTION guard_model_price_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'price versions are immutable'; END IF;
 PERFORM 1 FROM model_offerings WHERE id=NEW.offering_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM model_pricing_versions p WHERE p.offering_id=NEW.offering_id
  AND tstzrange(p.effective_from,p.effective_to,'[)') && tstzrange(NEW.effective_from,NEW.effective_to,'[)')) THEN
  RAISE EXCEPTION 'overlapping price version';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER model_price_immutable BEFORE INSERT OR UPDATE OR DELETE ON model_pricing_versions FOR EACH ROW EXECUTE FUNCTION guard_model_price_version();
CREATE TABLE llm_settlement_outbox (attempt_id TEXT PRIMARY KEY, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE llm_ledger_instances (id TEXT PRIMARY KEY, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE llm_rollup_state_v3 (
 bucket_hour TIMESTAMPTZ PRIMARY KEY, dirty BOOLEAN NOT NULL DEFAULT TRUE, aggregated_at TIMESTAMPTZ,
 status TEXT NOT NULL DEFAULT 'pending', revision BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE llm_calls_rollup_v3 (
 bucket_hour TIMESTAMPTZ NOT NULL, company_id TEXT, agent_id TEXT, run_id TEXT, purpose TEXT, model TEXT, source TEXT,
 source_kind TEXT, source_id TEXT, provider_id TEXT, platform TEXT, route TEXT, offering_id TEXT, capability TEXT, role TEXT,
 logical_call_id TEXT, daemon_version TEXT, observation_granularity TEXT,
 calls BIGINT NOT NULL, ok_calls BIGINT NOT NULL, failed_calls BIGINT NOT NULL, rate_limited_calls BIGINT NOT NULL,
 input_tokens BIGINT, cached_input_tokens BIGINT, cache_creation_tokens BIGINT, output_tokens BIGINT, reasoning_tokens BIGINT,
 cost_usd NUMERIC(30,12), cost_estimated BOOLEAN, reference_cost_usd NUMERIC(30,12), upstream_cost_usd NUMERIC(30,12), quota_debit NUMERIC(30,12),
 unknown_calls BIGINT, unpriced_calls BIGINT, quality_unknown_calls BIGINT, pending_calls BIGINT
);
CREATE INDEX llm_rollup_v3_company_bucket ON llm_calls_rollup_v3(company_id,bucket_hour);
CREATE FUNCTION dirty_llm_bucket() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN
  INSERT INTO llm_rollup_state_v3(bucket_hour) VALUES(date_trunc('hour',OLD.occurred_at,'UTC'))
   ON CONFLICT(bucket_hour) DO UPDATE SET dirty=TRUE,revision=llm_rollup_state_v3.revision+1;
 END IF;
 IF TG_OP <> 'DELETE' THEN
  INSERT INTO llm_rollup_state_v3(bucket_hour) VALUES(date_trunc('hour',NEW.occurred_at,'UTC'))
   ON CONFLICT(bucket_hour) DO UPDATE SET dirty=TRUE,revision=llm_rollup_state_v3.revision+1;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER llm_calls_dirty_v3 AFTER INSERT OR UPDATE OR DELETE ON llm_calls FOR EACH ROW EXECUTE FUNCTION dirty_llm_bucket();
INSERT INTO llm_rollup_state_v3(bucket_hour) SELECT DISTINCT date_trunc('hour',occurred_at,'UTC') FROM llm_calls;
`
export const LLM_LEDGER_V2_INDEXES = [
 `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS llm_calls_attempt_v2 ON llm_calls(attempt_id) WHERE schema_version=2 AND attempt_id IS NOT NULL`,
 `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS llm_calls_event_v2 ON llm_calls(company_id,computer_id,engine_session_id,event_id) WHERE schema_version=2 AND event_id IS NOT NULL`,
 `CREATE INDEX CONCURRENTLY IF NOT EXISTS llm_calls_occurred_v2 ON llm_calls(company_id,occurred_at)`,
]
export function llmLedgerV2Checksum(): string { return createHash('sha256').update(LLM_LEDGER_V2_SQL).digest('hex') }
export function llmLedgerV2IndexesChecksum(): string { return createHash('sha256').update(LLM_LEDGER_V2_INDEXES.join('\n')).digest('hex') }
