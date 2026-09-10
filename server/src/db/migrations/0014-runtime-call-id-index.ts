import { createHash } from 'node:crypto'

/** Same identity as runtime report deduplication. Keep legacy duplicate rows:
 * a unique index would reject existing histories or require deleting usage.
 * Reports without callId are excluded and retain their legacy behavior.
 * Transactional DDL keeps index creation and the migration ledger atomic.
 */
export const RUNTIME_CALL_ID_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_llm_calls_runtime_call_id
  ON llm_calls(company_id, agent_id, source, (extras->>'callId'))
  WHERE extras->>'callId' IS NOT NULL`

export function runtimeCallIdIndexChecksum(): string {
  return createHash('sha256').update(RUNTIME_CALL_ID_INDEX_SQL).digest('hex')
}
