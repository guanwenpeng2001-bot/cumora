import { createHash } from 'node:crypto'

export const LEDGER_RECONCILIATION_SQL = `
-- Price amounts and metadata are immutable. Publication may only close an open
-- effective interval; old attempts always retain their immutable price_snapshot.
CREATE OR REPLACE FUNCTION guard_model_price_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'effective_to') IS DISTINCT FROM (to_jsonb(OLD)-'effective_to')
    OR OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL OR NEW.effective_to<=OLD.effective_from THEN
    RAISE EXCEPTION 'price versions are immutable';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'price versions are immutable'; END IF;
 PERFORM 1 FROM model_offerings WHERE id=NEW.offering_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM model_pricing_versions p WHERE p.offering_id=NEW.offering_id
   AND tstzrange(p.effective_from,p.effective_to,'[)') && tstzrange(NEW.effective_from,NEW.effective_to,'[)')) THEN
   RAISE EXCEPTION 'overlapping price version';
 END IF;
 RETURN NEW;
END $$;
-- Preserve the old price catalogue as historical compatibility versions only.
-- A bare name is imported only when exactly one offering has that request name.
-- This does not reprice old calls or authorize these prices for future usage.
INSERT INTO model_pricing_versions(id,offering_id,version,effective_from,effective_to,unit_schema,rates,origin,note)
 SELECT 'legacy:'||o.id,o.id,0,LEAST(p.updated_at,NOW()-INTERVAL '1 microsecond'),NOW(),
   '{"unit":"token","per":"1000000"}'::jsonb,
   jsonb_build_object('input',p.input_per_1m::numeric::text,'cache_read',p.cached_input_per_1m::numeric::text,
     'cache_write',p.cache_write_per_1m::numeric::text,'output',p.output_per_1m::numeric::text),
   'legacy_compatibility',p.note
 FROM model_offerings o JOIN model_pricing p ON p.model=o.request_model
 WHERE (SELECT COUNT(*) FROM model_offerings x WHERE x.request_model=o.request_model)=1
   AND p.input_per_1m>=0 AND p.cached_input_per_1m>=0 AND p.cache_write_per_1m>=0 AND p.output_per_1m>=0;
CREATE TABLE llm_gateway_receipts (
 attempt_id TEXT NOT NULL, gateway_request_id TEXT NOT NULL, event_version BIGINT NOT NULL,
 evidence JSONB NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(gateway_request_id,event_version)
);
ALTER TABLE llm_calls ADD CONSTRAINT llm_v2_identity CHECK(schema_version<>2 OR record_kind='decision' OR
 (attempt_id IS NOT NULL AND source_kind IS NOT NULL AND source_id IS NOT NULL AND requested_model IS NOT NULL AND request_model IS NOT NULL));
ALTER TABLE llm_calls ADD CONSTRAINT llm_v2_event_identity CHECK(schema_version<>2 OR event_id IS NULL OR
 (source_kind='byoa' AND company_id IS NOT NULL AND computer_id IS NOT NULL AND engine_session_id IS NOT NULL));
ALTER TABLE llm_calls ADD CONSTRAINT llm_actual_model_evidence CHECK(schema_version<>2 OR
 (actual_model_state='not_reported' AND actual_model IS NULL) OR (actual_model_state IN ('reported','inferred') AND actual_model IS NOT NULL));
`
export function ledgerReconciliationChecksum(): string { return createHash('sha256').update(LEDGER_RECONCILIATION_SQL).digest('hex') }
