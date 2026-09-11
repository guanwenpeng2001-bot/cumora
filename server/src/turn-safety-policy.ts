export interface BudgetRuleInput {
  agentId: string
  period: 'day' | 'month'
  metric: 'tokens' | 'usd'
  ceiling: number
}

/** Shared by BYOA and managed turns. Three missed 2s probes, each bounded to 5s. */
export const TURN_SAFETY_PROBE = { intervalMs: 2000, timeoutMs: 5000, failures: 3 } as const

export async function boundedSafetyProbe<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DOMException('Safety probe timed out', 'TimeoutError')), TURN_SAFETY_PROBE.timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

function transientSafetyFailure(error: unknown): boolean {
  const e = error as { status?: number; name?: string; code?: string; message?: string; cause?: unknown } | null
  if (!e || typeof e !== 'object') return false
  if (typeof e.status === 'number') return e.status >= 500 && e.status <= 599
  if (e.name === 'TimeoutError') return true
  if (/^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(e.code ?? '')) return true
  // pg's connection/transport timeouts do not consistently carry an error code.
  if (/^(Connection terminated unexpectedly|Connection terminated due to connection timeout|timeout exceeded when trying to connect|Query read timeout)$/i.test(e.message ?? '')) return true
  if (e.name === 'TypeError' && /fetch failed|failed to fetch|network/i.test(e.message ?? '')) return true
  return e.cause !== undefined && e.cause !== error && transientSafetyFailure(e.cause)
}

/** Only transport failures earn grace; an explicit refusal never does. */
export class TurnSafetyGrace {
  private failures = 0
  success(): void { this.failures = 0 }
  shouldStop(error: unknown): boolean {
    return !transientSafetyFailure(error) || ++this.failures >= TURN_SAFETY_PROBE.failures
  }
}

export function parseBudgetRule(value: unknown): BudgetRuleInput {
  if (!value || typeof value !== 'object') throw new Error('invalid budget rule')
  const r = value as Record<string, unknown>
  if (typeof r.agentId !== 'string' || r.agentId.length > 256
    || (r.period !== 'day' && r.period !== 'month')
    || (r.metric !== 'tokens' && r.metric !== 'usd')
    || typeof r.ceiling !== 'number' || !Number.isFinite(r.ceiling) || r.ceiling <= 0
    || (r.metric === 'tokens' && !Number.isSafeInteger(r.ceiling))) {
    throw new Error('上限必须为正数；token 上限必须为安全整数')
  }
  return { agentId: r.agentId, period: r.period, metric: r.metric, ceiling: r.ceiling }
}

export function budgetExceeded(metric: 'tokens' | 'usd', ceiling: number, usage: { tokens: number; usd: number }): boolean {
  return usage[metric] >= ceiling
}

export const TURN_ADMISSION_SQL = `
    SELECT COALESCE(s.paused, FALSE) paused, COALESCE(s.generation, 0)::text generation,
      ARRAY(SELECT r.id FROM turn_budget_rules r
        LEFT JOIN turn_budget_usage u ON u.company_id = r.company_id AND u.agent_id = r.agent_id
          AND u.period = r.period AND u.period_start = date_trunc(r.period, NOW(), 'UTC')
        WHERE r.company_id = $1 AND r.agent_id IN ('', $2)
          AND CASE r.metric WHEN 'tokens' THEN COALESCE(u.tokens, 0) ELSE COALESCE(u.usd, 0) END >= r.ceiling) blocked
    FROM (SELECT 1) x LEFT JOIN company_turn_safety s ON s.company_id = $1`
