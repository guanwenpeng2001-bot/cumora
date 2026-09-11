import type { Pool } from 'pg'
import type { LlmCallRecord } from './llm-ledger.js'

export const MODEL_FAILURE_COOLDOWN_MS = 5 * 60_000
type Store = Pick<Pool, 'query'>
export interface ModelFailureState {
  config_version: string
  revision: string
  backoff: string | null
}

/** A bare 404, a temporary empty pool, quota, or a mixed failure chain is
 * insufficient evidence. Only an exhausted chain of explicit model rejection
 * can defer a whole agent; provider diagnostics never leave the server. */
export function isDeterministicModelFailure(attempts: readonly LlmCallRecord[]): boolean {
  const last = attempts.at(-1)
  const callId = last?.extras?.logicalCallId
  return typeof callId === 'string' && last?.extras?.stopReason === 'exhausted'
    && attempts.length > 0 && attempts.every(attempt => {
      const status = attempt.extras?.httpStatus
      return attempt.extras?.logicalCallId === callId && attempt.status === 'failed'
        && [400, 404, 422].includes(Number(status))
        && /model\b[^\n]*(?:not supported|unsupported|does not exist|(?:not available|unavailable) (?:in|for) (?:the |this |current )?(?:account|group))|unsupported\s+model\b/i.test(attempt.error ?? '')
    })
}

function key(companyId: string, agentId: string): string {
  return `__agent_model_backoff:${companyId}:${agentId}`
}

async function store(): Promise<Store> {
  return (await import('../db/pool.js')).pool
}

/** Read the current DB revision, not a turn's immutable settings snapshot.
 * Agent overrides also invalidate cooldown immediately. Internal settings keys
 * are ignored by the settings catalog and never bump its public revision. */
export async function readModelFailureState(companyId: string, agentId: string, db?: Store): Promise<ModelFailureState | null> {
  const result = await (db ?? await store()).query<ModelFailureState>(`
    SELECT COALESCE(r.value, '0') AS revision,
      COALESCE(r.value, '0') || ':' || md5(jsonb_build_array(p.model, p.model_config)::text) AS config_version,
      b.value AS backoff
    FROM participants p
    LEFT JOIN server_settings r ON r.key = '__settings_revision'
    LEFT JOIN server_settings b ON b.key = $3
    WHERE p.company_id = $1 AND p.id = $2 AND p.kind = 'agent'`,
  [companyId, agentId, key(companyId, agentId)])
  return result.rows[0] ?? null
}

export function modelFailureRetryAt(state: ModelFailureState | null, now = Date.now()): number | null {
  if (!state?.backoff) return null
  try {
    const saved = JSON.parse(state.backoff) as { configVersion?: unknown; retryAt?: unknown }
    return saved.configVersion === state.config_version && typeof saved.retryAt === 'number'
      && Number.isFinite(saved.retryAt) && saved.retryAt > now
      ? Math.min(saved.retryAt, now + MODEL_FAILURE_COOLDOWN_MS) : null
  } catch { return null }
}

export async function saveModelFailureBackoff(companyId: string, agentId: string, state: ModelFailureState,
  now = Date.now(), db?: Store): Promise<void> {
  await (db ?? await store()).query(`INSERT INTO server_settings(key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  [key(companyId, agentId), JSON.stringify({ configVersion: state.config_version, retryAt: now + MODEL_FAILURE_COOLDOWN_MS })])
}

export async function admitModelFailureRetry<T extends { allowed: boolean; reason: string | null }>(
  companyId: string, agentId: string, admission: T, db?: Store,
): Promise<T> {
  // Emergency stop and budget decisions retain priority and their own reason.
  if (!admission.allowed) return admission
  const retryAt = modelFailureRetryAt(await readModelFailureState(companyId, agentId, db))
  return retryAt === null ? admission : { ...admission, allowed: false, reason: 'model_configuration_backoff' }
}
