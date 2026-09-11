import assert from 'node:assert/strict'
import { test } from 'node:test'
import { budgetExceeded, parseBudgetRule } from '../turn-safety-policy.js'
import { HttpRuntimeClient } from '../agents/runtime/http-client.js'

test('budget rules validate all scope/period/metric combinations and reject unsafe limits', () => {
  for (const agentId of ['', 'agent-a']) for (const period of ['day', 'month']) for (const metric of ['tokens', 'usd']) {
    const input = { agentId, period, metric, ceiling: 100 }
    assert.deepEqual(parseBudgetRule(input), input)
  }
  for (const ceiling of [0, -1, NaN, Infinity, '100', null, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseBudgetRule({ agentId: '', period: 'day', metric: 'tokens', ceiling }))
  }
  assert.equal(parseBudgetRule({ agentId: '', period: 'month', metric: 'usd', ceiling: 0.05 }).ceiling, 0.05)
  for (const value of [null, {}, [], { agentId: '', period: 'year', metric: 'usd', ceiling: 3 },
    { agentId: '', period: 'day', metric: 'credits', ceiling: 3 }]) assert.throws(() => parseBudgetRule(value))
})

test('fuses trip at the exact threshold, independently for token and cost limits', () => {
  assert.equal(budgetExceeded('tokens', 100, { tokens: 99, usd: 10 }), false)
  assert.equal(budgetExceeded('tokens', 100, { tokens: 100, usd: 0 }), true)
  assert.equal(budgetExceeded('usd', 0.25, { tokens: 1, usd: 0.25 }), true)
})

test('runtime admission pins stop generation on ack and checks validity without changing it', async () => {
  const requests: { path: string; generation: string | null }[] = []
  const client = new HttpRuntimeClient({ baseUrl: 'http://runtime.invalid', token: 'test', fetchImpl: async (url, init) => {
    const path = new URL(String(url)).pathname
    requests.push({ path, generation: new Headers(init?.headers).get('X-Turn-Generation') })
    if (path === '/turn-admission') return Response.json({ allowed: true, generation: '7', reason: null })
    if (path === '/turn-valid') return Response.json({ valid: false })
    return Response.json({ ok: true })
  } })
  assert.equal((await client.admitTurn('a')).allowed, true)
  assert.equal(await client.validateTurn('a', '7'), false)
  await client.markConversationRead({ agentId: 'a', conversationId: 'c', upToMessageId: 'm' })
  await client.confirmStopped('a', '8')
  assert.equal(requests.find(r => r.path === '/conversation/mark-read')?.generation, '7')
  assert.equal(requests.find(r => r.path === '/stop-confirmed')?.generation, '7')
})

test('admission and interrupted acknowledgements fail closed on HTTP errors', async () => {
  const client = new HttpRuntimeClient({ baseUrl: 'http://runtime.invalid', token: 'test', fetchImpl: async () => Response.json({ error: 'turn stopped' }, { status: 409 }) })
  await assert.rejects(client.admitTurn('a'), /409/)
  await assert.rejects(client.validateTurn('a', '0'), /409/)
  await assert.rejects(client.markConversationRead({ agentId: 'a', conversationId: 'c', upToMessageId: 'm' }), /409/)
})
