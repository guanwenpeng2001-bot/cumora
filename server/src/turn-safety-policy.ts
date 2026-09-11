export interface BudgetRuleInput {
  agentId: string
  period: 'day' | 'month'
  metric: 'tokens' | 'usd'
  ceiling: number
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
