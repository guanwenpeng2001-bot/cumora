import {createHash} from 'node:crypto'
export const ROLLUP_MODEL_EVIDENCE_SQL=`
ALTER TABLE llm_calls_rollup_v3 ADD COLUMN actual_model TEXT, ADD COLUMN request_model TEXT,
 ADD COLUMN actual_model_state TEXT NOT NULL DEFAULT 'not_reported';
-- The same string is not the same evidence. Previously certified groups must be
-- rebuilt before serving v3 with these dimensions; readers use raw while dirty.
UPDATE llm_rollup_state_v3 SET dirty=TRUE,revision=revision+1;
`
export function rollupModelEvidenceChecksum():string{return createHash('sha256').update(ROLLUP_MODEL_EVIDENCE_SQL).digest('hex')}
