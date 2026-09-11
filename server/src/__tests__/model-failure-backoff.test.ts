import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Pool } from 'pg'
import ts from 'typescript'
import * as backoff from '../agents/model-failure-backoff.js'
import type { LlmCallRecord } from '../agents/llm-ledger.js'
import { TurnMessageConsumption } from '../agents/message-consumption.js'
import { decidePodExit } from '../agents/runtime/pod-agent-exit.js'
import { compile, read } from './llm-stream-fixture.js'

function attempts(error = '404 Model "k3" is not supported by any configured account in this group'): LlmCallRecord[] {
  return ['k3', 'k3-256k', 'kimi-for-coding'].map((model, i) => ({
    model, companyId: 'company', purpose: 'agent-turn', latencyMs: 10, status: 'failed', error,
    extras: { logicalCallId: 'logical', httpStatus: 404, stopReason: i === 2 ? 'exhausted' : 'advance' },
  }))
}

function turnFixture() {
  const state: backoff.ModelFailureState = { revision: '7', config_version: '7:agent-models', backoff: null }
  const db = { query: async (sql: string, args: any[]) => {
    if (sql.includes('INSERT INTO server_settings')) state.backoff = args[1]
    return { rows: [{ ...state }] }
  } } as unknown as Pick<Pool, 'query'>
  let records = attempts(), brainCalls = 0, receipts = 0, fingerprints = 0
  const adapter = compile(read('../agents/runtime/llm-stream-execution.ts'), {
    '../../llm-resolver.js': { resolveRoleCall: async () => ({ revision: state.revision }) },
    '../../settings.js': { automationNumber: () => 1000, getTurnBudgetPolicy: () => ({}),
      getServerSettingsSnapshot: () => ({ revision: state.revision }) },
    '../personas.js': { getPersona: async () => ({ companyId: 'company' }) },
    '../model-policy.js': {},
    '../model-failure-backoff.js': { ...backoff,
      readModelFailureState: (company: string, agent: string) => backoff.readModelFailureState(company, agent, db),
      saveModelFailureBackoff: (company: string, agent: string, captured: backoff.ModelFailureState) =>
        backoff.saveModelFailureBackoff(company, agent, captured, Date.now(), db) },
    '../turn.js': { executeAgentTurnHop: async (args: any) => {
      for (const record of records) { brainCalls++; await args.onAttempt(record) }
      throw new Error('Runtime LLM execution failed')
    } },
  })
  const source = read('../agents/turn.ts')
  const ast = ts.createSourceFile('turn.ts', source, ts.ScriptTarget.Latest, true)
  const entry = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runAgentTurn')!
  const inbox = [{ id: 'unfinished', conversation_id: 'room' }]
  const consumption = new TurnMessageConsumption()
  consumption.inject('unfinished', 'room')
  const start = source.indexOf('    // Queued and injected are not completion.')
  const finish = source.slice(start, source.indexOf('    // Steering: also discard', start))
  const cleanup = compile(`export async function cleanup() { ${finish} }`, {}, {
    finalStatus: 'failed', options: {}, consumption, agentId: 'agent', fingerprint: 'unfinished',
    rememberCompletedInbox: () => { fingerprints++ },
    runtime: { markConversationRead: async () => { receipts++; inbox.length = 0 } },
  }).cleanup
  const api = compile(entry.getText(ast), {}, {
    withServerSettingsSnapshot: (fn: () => any) => fn(),
    runtime: { admitTurn: () => backoff.admitModelFailureRetry('company', 'agent', { allowed: true, generation: '3', reason: null }, db) },
    getTurnBudgetPolicy: () => ({ timeoutMs: 0 }), TurnSafetyGrace: class {}, TURN_SAFETY_PROBE: { intervalMs: 100_000 },
    runAgentTurnWithBudget: async () => {
      try {
        await adapter.executeRuntimeStream({ purpose: 'agent-turn', input: [], instructions: '', tools: [] },
          { companyId: 'company', agentId: 'agent' }, new AbortController().signal, async () => {})
      } finally { await cleanup() }
    },
  })
  return { state, inbox, run: () => api.runAgentTurn('agent'), setRecords: (value: LlmCallRecord[]) => { records = value },
    counts: () => ({ brainCalls, receipts, fingerprints }) }
}

test('deterministic model failures gate all turn entries for five minutes without consuming inbox', async t => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const f = turnFixture()
  await assert.rejects(f.run(), /Runtime LLM execution failed/)
  assert.deepEqual(f.counts(), { brainCalls: 3, receipts: 0, fingerprints: 0 })
  for (let i = 0; i < 9; i++) { now += 30_000; await f.run() }
  assert.equal(f.counts().brainCalls, 3, 'nine Pod probes cannot replay the failed input')
  assert.equal(f.inbox[0].id, 'unfinished')
  now += 30_000
  await assert.rejects(f.run())
  assert.equal(f.counts().brainCalls, 6, 'bounded cooldown permits another attempt')
})

for (const change of ['server revision', 'agent model override']) test(`${change} releases cooldown on the next wake`, async t => {
  t.mock.method(Date, 'now', () => 1_000_000)
  const f = turnFixture()
  await assert.rejects(f.run())
  if (change === 'server revision') f.state.revision = '8'
  f.state.config_version = change === 'server revision' ? '8:agent-models' : '7:new-agent-models'
  await assert.rejects(f.run())
  assert.equal(f.counts().brainCalls, 6)
  assert.equal(f.counts().receipts, 0)
})

test('ordinary errors preserve the original retry cadence', async t => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const f = turnFixture()
  f.setRecords(attempts('404 route not found'))
  await assert.rejects(f.run())
  now += 30_000
  await assert.rejects(f.run())
  assert.equal(f.state.backoff, null)
  assert.deepEqual(f.counts(), { brainCalls: 6, receipts: 0, fingerprints: 0 })
  assert.equal(f.inbox.length, 1)
})

test('classification rejects mixed, transient, cancelled, and output-committed chains', () => {
  assert.equal(backoff.isDeterministicModelFailure(attempts()), true)
  for (const error of ['404 not found', 'model temporarily unavailable', 'model has no available accounts', 'connection reset']) {
    assert.equal(backoff.isDeterministicModelFailure(attempts(error)), false, error)
  }
  const mixed = attempts()
  mixed[0].error = 'timeout'
  assert.equal(backoff.isDeterministicModelFailure(mixed), false)
  for (const stopReason of ['cancelled', 'output-committed', 'non-fallbackable-error']) {
    const rows = attempts()
    rows[2].extras!.stopReason = stopReason
    assert.equal(backoff.isDeterministicModelFailure(rows), false)
  }
  assert.equal(backoff.isDeterministicModelFailure([]), false)
})

test('cold-start Pod keeps probing retained inbox through cooldown and can exit once it is empty', () => {
  const source = read('../agents/runtime/pod-agent.ts')
  const ast = ts.createSourceFile('pod.ts', source, ts.ScriptTarget.Latest, true)
  const watcher = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'startIdleWatcher')!
  let tick!: () => void
  let exits = 0
  const state = { busy: false, shuttingDown: false, firstWakeReceived: false,
    lastActivityAt: 0, inboxDeferred: null, hasPendingInbox: true }
  let now = 0
  const api = compile(watcher.getText(ast) + '\nexport { startIdleWatcher }', {}, {
    state, decidePodExit, Date: { now: () => now },
    setInterval: (fn: () => void) => { tick = fn; return { unref() {} } }, clearInterval() {},
  })
  api.startIdleWatcher('agent', 180_000, 90_000, () => { exits++ })
  now = backoff.MODEL_FAILURE_COOLDOWN_MS
  tick()
  assert.equal(exits, 0, 'no-work-exit must not strand the pending cold-start input')
  state.hasPendingInbox = false
  tick()
  assert.equal(exits, 1)
})

const testUrl = process.env.DATABASE_URL
const isolated = testUrl && new URL(testUrl).port === '15432' && new URL(testUrl).pathname === '/cumora_test'
test('PostgreSQL persists cooldown in settings and releases it after configuration changes', { skip: !isolated }, async () => {
  const db = new Pool({ connectionString: testUrl, max: 1 })
  try {
    await db.query('BEGIN')
    // Connection-local tables shadow public tables; rollback removes all test data.
    await db.query(`CREATE TEMP TABLE participants(id text, company_id text, kind text, model text, model_config jsonb);
      CREATE TEMP TABLE server_settings(key text PRIMARY KEY, value text, updated_at timestamptz DEFAULT now());
      INSERT INTO participants VALUES ('agent', 'company', 'agent', NULL, NULL);
      INSERT INTO server_settings(key, value) VALUES ('__settings_revision', '7')`)
    const first = (await backoff.readModelFailureState('company', 'agent', db))!
    await backoff.saveModelFailureBackoff('company', 'agent', first, Date.now(), db)
    const reread = await backoff.readModelFailureState('company', 'agent', db)
    assert.ok(backoff.modelFailureRetryAt(reread))
    assert.equal((await backoff.admitModelFailureRetry('company', 'agent', { allowed: true, reason: null }, db)).allowed, false)
    await db.query("UPDATE server_settings SET value = '8' WHERE key = '__settings_revision'")
    assert.equal(backoff.modelFailureRetryAt(await backoff.readModelFailureState('company', 'agent', db)), null)
    const next = (await backoff.readModelFailureState('company', 'agent', db))!
    await backoff.saveModelFailureBackoff('company', 'agent', next, Date.now(), db)
    await db.query("UPDATE participants SET model_config = '{\"fallbackModels\":[\"working-model\"]}'")
    assert.equal(backoff.modelFailureRetryAt(await backoff.readModelFailureState('company', 'agent', db)), null)
    assert.equal(await backoff.readModelFailureState('foreign-company', 'agent', db), null)
    const paused = { allowed: false, reason: 'emergency_stop', generation: '4' }
    assert.deepEqual(await backoff.admitModelFailureRetry('company', 'agent', paused, db), paused)
    assert.equal((await db.query("SELECT value FROM server_settings WHERE key = '__settings_revision'")).rows[0].value, '8')
    console.log('MODEL_BACKOFF_PG_OK: persisted, revision/override invalidation, tenant isolation, stop priority')
  } finally { await db.query('ROLLBACK'); await db.end() }
})
