import { randomUUID } from 'node:crypto'
import { pool } from './db/pool.js'
import { deliver } from './agents/runtime/wake-bus.js'
import { TURN_ADMISSION_SQL, type BudgetRuleInput } from './turn-safety-policy.js'

// All admission reads use indexed state/counters, never a ledger aggregation.
export async function turnAdmission(companyId: string, agentId: string): Promise<{ allowed: boolean; generation: string; reason: string | null }> {
  const { rows } = await pool.query<{ paused: boolean; generation: string; blocked: string[] }>(TURN_ADMISSION_SQL, [companyId, agentId])
  const state = rows[0]
  if (state.blocked.length) {
    await pool.query(`INSERT INTO turn_safety_events(company_id, agent_id, kind, detail, dedupe)
      SELECT $1, $2, 'budget_tripped', jsonb_build_object('ruleId', id, 'period', period, 'ceiling', ceiling),
        id || ':' || $2 || ':' || date_trunc(period, NOW(), 'UTC')::text || ':' || ceiling::text
      FROM turn_budget_rules WHERE company_id = $1 AND id = ANY($3::text[])
      ON CONFLICT (dedupe) DO NOTHING`, [companyId, agentId, state.blocked])
  }
  return { allowed: !state.paused && !state.blocked.length, generation: state.generation,
    reason: state.paused ? 'emergency_stop' : state.blocked.length ? 'budget_exceeded' : null }
}

export async function safetySnapshot(companyId: string) {
  const [state, rules, agents, events] = await Promise.all([
    pool.query(`SELECT paused, generation::text, changed_at FROM company_turn_safety WHERE company_id = $1`, [companyId]),
    pool.query(`SELECT r.*, COALESCE(u.tokens, 0)::float8 tokens, COALESCE(u.usd, 0) usd,
      date_trunc(r.period, NOW(), 'UTC') + CASE r.period WHEN 'day' THEN INTERVAL '1 day' ELSE INTERVAL '1 month' END resets_at
      FROM turn_budget_rules r LEFT JOIN turn_budget_usage u ON u.company_id = r.company_id
        AND u.agent_id = r.agent_id AND u.period = r.period AND u.period_start = date_trunc(r.period, NOW(), 'UTC')
      WHERE r.company_id = $1 ORDER BY r.agent_id, r.period, r.metric`, [companyId]),
    pool.query(`SELECT id, name FROM participants WHERE company_id = $1 AND kind = 'agent' AND departed_at IS NULL ORDER BY name`, [companyId]),
    pool.query(`SELECT agent_id, kind, detail, created_at FROM turn_safety_events WHERE company_id = $1 ORDER BY id DESC LIMIT 100`, [companyId]),
  ])
  return { state: state.rows[0] ?? { paused: false, generation: '0' }, rules: rules.rows, agents: agents.rows, events: events.rows }
}

export async function saveBudget(companyId: string, actorId: string, rule: BudgetRuleInput) {
  if (rule.agentId) {
    const agent = await pool.query(`SELECT 1 FROM participants WHERE id = $1 AND company_id = $2 AND kind = 'agent' AND departed_at IS NULL`, [rule.agentId, companyId])
    if (!agent.rowCount) throw new Error('agent 不属于当前公司')
  }
  await pool.query(`INSERT INTO turn_budget_rules(id, company_id, agent_id, period, metric, ceiling)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (company_id, agent_id, period, metric)
    DO UPDATE SET ceiling = EXCLUDED.ceiling`, [randomUUID(), companyId, rule.agentId, rule.period, rule.metric, rule.ceiling])
  await safetyEvent(companyId, null, 'budget_configured', actorId, rule)
}

async function safetyEvent(companyId: string, agentId: string | null, kind: string, actorId: string | null, detail: unknown) {
  await pool.query(`INSERT INTO turn_safety_events(company_id, agent_id, kind, actor_id, detail) VALUES ($1,$2,$3,$4,$5)`,
    [companyId, agentId, kind, actorId, JSON.stringify(detail)])
}

export async function removeBudget(companyId: string, actorId: string, id: string) {
  await pool.query(`DELETE FROM turn_budget_rules WHERE id = $1 AND company_id = $2`, [id, companyId])
  await safetyEvent(companyId, null, 'budget_removed', actorId, { id })
}

export async function emergencyStop(companyId: string, actorId: string) {
  const client = await pool.connect()
  let generation: string
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId])
    const { rows } = await client.query(`INSERT INTO company_turn_safety(company_id, paused, generation)
      VALUES ($1, TRUE, 1) ON CONFLICT (company_id) DO UPDATE SET paused = TRUE,
        generation = company_turn_safety.generation + 1, changed_at = NOW() RETURNING generation::text`, [companyId])
    generation = rows[0].generation
    await client.query(`INSERT INTO turn_safety_events(company_id, kind, actor_id, detail)
      VALUES ($1, 'emergency_paused', $2, $3)`, [companyId, actorId, JSON.stringify({ generation })])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
  const agents = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM participants
    WHERE company_id = $1 AND kind = 'agent' AND departed_at IS NULL`, [companyId])
  // One failed delivery must not prevent stopping the remaining agents.
  const outcomes = await Promise.all(agents.rows.map(async agent => {
    let status = 'pending'
    try { if (await deliver(agent.id, { kind: 'stop', generation })) status = 'sent' } catch { /* durable pause still applies */ }
    await safetyEvent(companyId, agent.id, 'emergency_stop', actorId, { generation, status })
    return { ...agent, status }
  }))
  return { paused: true, generation, agents: outcomes }
}

export async function resumeTurns(companyId: string, actorId: string) {
  await pool.query(`UPDATE company_turn_safety SET paused = FALSE, changed_at = NOW() WHERE company_id = $1`, [companyId])
  await safetyEvent(companyId, null, 'emergency_resumed', actorId, {})
}

export async function confirmStopped(companyId: string, agentId: string, generation: string) {
  await pool.query(`INSERT INTO turn_safety_events(company_id, agent_id, kind, detail, dedupe)
    SELECT $1, $2, 'stop_confirmed', jsonb_build_object('generation', generation::text),
      $1 || ':' || $2 || ':stop:' || generation::text
    FROM company_turn_safety WHERE company_id = $1 AND paused = TRUE
      AND generation >= $3::bigint ON CONFLICT (dedupe) DO NOTHING`, [companyId, agentId, generation])
}

export async function canAcknowledge(companyId: string, generation: string | undefined): Promise<boolean> {
  const { rows } = await pool.query(`SELECT paused, generation::text FROM company_turn_safety WHERE company_id = $1`, [companyId])
  return !rows[0]?.paused && (rows[0]?.generation ?? '0') === (generation ?? '0')
}
