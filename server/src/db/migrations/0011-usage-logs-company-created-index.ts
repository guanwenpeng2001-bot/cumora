import { createHash } from 'node:crypto'

/** Migration 0011: tenant/range index for the raw usage log drill-down. */
export const USAGE_LOGS_INDEX_NAME = 'idx_llm_calls_company_created'
export const USAGE_LOGS_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${USAGE_LOGS_INDEX_NAME}
  ON llm_calls(company_id, created_at DESC)`

export function usageLogsIndexChecksum(): string {
  return createHash('sha256').update(USAGE_LOGS_INDEX_SQL).digest('hex')
}