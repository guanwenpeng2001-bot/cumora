import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import * as triage from '../agents/triage-core.js'
import { normalizeByoaSource } from '../agents/runtime/byoa-source.js'

// Execute the real consumers with fake I/O; no database, CLI, or provider is opened.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
function compile(source: string, globals: Record<string, unknown>) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', ...Object.keys(globals), output)(exports, ...Object.values(globals))
  return exports
}
function declarations(path: string, names: string[]) {
  const source = read(path)
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return ast.statements.filter(n =>
    ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '') ||
    ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast))),
  ).map(n => n.getText(ast)).join('\n')
}
function daemonFixture(result: any, options: { payload?: any; backoffUntil?: number; abort?: boolean; mkdirFails?: boolean; deliveryFails?: number } = {}) {
  const source = read('../agents/computer/daemon.ts')
  const ast = ts.createSourceFile('daemon.ts', source, ts.ScriptTarget.Latest, true)
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'AgentRunner') as ts.ClassDeclaration
  const methods = cls.members.filter(n => n.name && ['inboxTriage', 'recordTriageUsage', 'assertRunning'].includes(n.name.getText(ast))).map(n => n.getText(ast)).join('\n')
  const reports: any[] = [], warnings: string[] = []
  let calls = 0
  let timeout: (() => void) | undefined
  const payload = 'payload' in options ? options.payload : { instructions: 'classify', input: 'message', messageIds: ['m1'] }
  const { Runner } = compile(`export class Runner { ${methods} }`, {
    ...triage, randomUUID, AbortController, Date, runtimePolicy: { values: { triageTimeoutMs: 1 } }, TRIAGE_DIR: 'fake-triage', CURRENT_VERSION: 'test-daemon',
    acquireRunnerSlot: async (semaphore: { acquire: () => Promise<void> }) => semaphore.acquire(),
    triageSem: { acquire: async () => {}, release() {} }, spawnPacer: { gate: async () => {} },
    setTimeout: (fn: () => void) => { if (options.abort) timeout = fn; return 1 }, clearTimeout() {},
    mkdir: async () => { if (options.mkdirFails) throw new Error('local directory failure') },
    runtimeGet: async () => payload,
    runtimeBest: async (_url: string, path: string, _token: string, report: any) => {
      assert.equal(path, '/triage')
      reports.push(structuredClone(report))
      return reports.length <= (options.deliveryFails ?? 0) ? null : { ok: true }
    },
    usageFromClaude: (usage: any) => ({ inputTokens: usage.input_tokens, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: usage.output_tokens }),
    redactProviderSecret: (value: unknown) => value,
    console: { warn: (message: string) => warnings.push(message) },
  })
  const runner = new Runner()
  Object.assign(runner, { triageBackoffUntil: options.backoffUntil ?? 0, cfg: { serverUrl: 'fake' }, agent: { id: 'a' }, triageModel: () => 'requested-model',
    triageModelPin: () => 'requested-model', engineEnv: () => ({}),
    teardown: { signal: new AbortController().signal }, stopped: false, provider: null,
    adapter: { id: 'codex', classify: async () => { calls++; timeout?.(); if (result instanceof Error) throw result; return result } },
  })
  return { reports, warnings, calls: () => calls, run: () => runner.inboxTriage('token', new Map([['c', ['m1']]])) }
}
const valid = { text: '{"actionable":false,"reason":"already answered"}' }
for (const [name, result, status, category] of [
  ['success without usage', valid, 'ok', undefined],
  ['success with usage', { ...valid, usage: { input_tokens: 3, output_tokens: 2 }, model: 'actual-model' }, 'ok', undefined],
  ['thrown failure', new Error('provider failed'), 'failed', 'classifier-error'],
  ['rate limit', { text: '', error: '429 rate limit' }, 'rate_limited', 'rate-limited'],
  ['empty output', { text: '' }, 'failed', 'invalid-result'],
  ['invalid JSON', { text: 'not JSON', usage: { input_tokens: 3, output_tokens: 2 } }, 'failed', 'invalid-result'],
  ['partial verdict', { text: '{"actionable":true' }, 'failed', 'invalid-result'],
] as const) {
  test(`local classification reports ${name}`, async () => {
    const f = daemonFixture(result)
    const verdict = await f.run()
    assert.equal(f.calls(), 1)
    assert.equal(f.reports.length, 1)
    const row = f.reports[0]
    assert.equal(row.status, status)
    assert.equal(row.error, category ?? null)
    assert.equal(row.source, 'byoa-codex')
    assert.equal(row.daemonVersion, 'test-daemon')
    assert.match(row.callId, /^[0-9a-f-]{36}$/)
    assert.ok(row.latencyMs >= 0)
    assert.equal(row.actualModel, 'model' in result ? result.model : null)
    assert.equal(row.usage === null, !('usage' in result))
    if (category) { assert.equal(verdict.outcome, 'defer'); assert.equal(verdict.ackAllowed, false) }
  })
}
test('timeout is reported even if the adapter returns a verdict', async () => {
  const f = daemonFixture(valid, { abort: true })
  assert.equal((await f.run()).outcome, 'defer')
  assert.equal(f.reports[0].status, 'timeout')
})
test('deterministic verdict, stale/missing payload and pre-call filesystem failure do not invent calls', async () => {
  for (const options of [{ payload: { verdict: { actionable: false, reason: 'empty', source: 'empty-inbox' } } },
    { payload: null }, { payload: { instructions: 'x', input: 'x', messageIds: [] } }, { mkdirFails: true }]) {
    const f = daemonFixture(valid, options)
    await f.run()
    assert.equal(f.calls(), 0)
    assert.equal(f.reports.length, 0)
  }
})
test('ambiguous report delivery retries with the same ID; exhausted delivery is visible', async () => {
  for (const deliveryFails of [1, 2]) {
    const f = daemonFixture(valid, { deliveryFails })
    assert.equal((await f.run()).outcome, 'ignore')
    assert.equal(f.reports.length, 2)
    assert.equal(f.reports[0].callId, f.reports[1].callId)
    assert.equal(f.warnings.length, deliveryFails === 2 ? 1 : 0)
  }
})

function serverFixture() {
  const rows: any[] = [], economics: any[] = [], handlers = new Map<string, any>()
  let failInsert = false, authorized = true
  let lockTail = Promise.resolve()
  const ledger = compile(declarations('../agents/llm-ledger.ts', ['LLM_CALL_COLUMNS', 'llmCallValues', 'recordLlmCallsBatch']) + '\nexport { llmCallValues }', {
    randomUUID, EMPTY_USAGE: { inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 },
    effectiveCostUsd: () => ({ usd: 0.1, estimated: false }),
    priceFor: () => ({}),
    validModelPrice: () => false,
  })
  const serverSource = read('../agents/runtime/server.ts')
  const routes = serverSource.slice(serverSource.indexOf("runtimeRouter.post('/triage'"), serverSource.indexOf('// Heartbeat a long engine turn'))
  compile(declarations('../agents/runtime/server.ts', ['MAX_LLM_HOPS_PER_BATCH', 'MAX_PG_INTEGER', 'LLM_CALL_STATUSES', 'isPlainRecord', 'isNonNegativePgInteger', 'isRuntimeTokenUsage']) + '\n' + routes, {
    normalizeByoaSource, runtimeRouter: { post: (path: string, handler: any) => handlers.set(path, handler) }, withAgent: (fn: any) => fn,
    recordTriage: async (row: any) => { economics.push(row) },
    require: (name: string) => { assert.equal(name, '../llm-ledger.js'); return ledger },
    withRuntimeAgentRunAuthorization: async ({ task }: any) => {
      if (!authorized) return { authorized: false }
      let unlock: (() => void) | undefined
      const staged: any[] = []
      const client = { query: async (sql: string, params: any[]) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          const previous = lockTail
          lockTail = new Promise<void>(resolve => { unlock = resolve })
          await previous
          return { rows: [] }
        }
        if (sql.includes('SELECT extras')) {
          assert.ok(unlock, 'dedup lookup must hold transaction lock')
          assert.match(sql, /extras->>'callId' IS NOT NULL/, 'lookup explicitly implies the partial index predicate')
          return { rows: rows.filter(r => r.companyId === params[0] && r.agentId === params[1] && r.source === params[2] && params[3].includes(r.extras.callId)).map(r => ({ call_id: r.extras.callId })) }
        }
        assert.match(sql, /^INSERT INTO llm_calls/)
        if (failInsert) throw new Error('fake DB failure')
        for (let i = 0; i < params.length; i += 21) {
          const v = params.slice(i, i + 21)
          staged.push({ companyId: v[1], agentId: v[2], purpose: v[5], source: v[6], model: v[7], measured: v[15],
            latencyMs: v[16], status: v[17], error: v[18], extras: JSON.parse(v[19]), daemonVersion: v[20] })
        }
        return { rows: [] }
      } }
      try { const result = await task(client); rows.push(...staged); return { authorized: true, result } }
      finally { unlock?.() }
    },
  })
  return { rows, economics, ledger, fail: (value: boolean) => { failInsert = value }, authorize: (value: boolean) => { authorized = value },
    async call(path: string, body: any, companyId = 'company', agentId = 'agent') {
      let status = 200, response: any
      const res = { status(n: number) { status = n; return res }, json(value: any) { response = value } }
      await handlers.get(path)({ sub: agentId, companyId }, { body: structuredClone(body) }, res)
      return { status, body: response }
    },
  }
}
const report = { source: 'byoa-codex', daemonVersion: 'test-daemon', model: 'requested', actualModel: 'actual', callId: 'call-1', actionable: false, reason: 'done', latencyMs: 12 }
test('both endpoints use the real ledger mapping for missing, zero, measured and failed usage', async () => {
  const f = serverFixture()
  for (const usage of [null, { inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 },
    { inputTokens: 3, cachedInputTokens: 1, cacheCreationTokens: 0, outputTokens: 2 }]) {
    await f.call('/triage', { ...report, callId: randomUUID(), usage })
    const row = f.rows.at(-1)
    assert.equal(row.measured, usage !== null)
    assert.equal(row.extras.measurement, usage ? 'measured' : 'unknown')
    assert.deepEqual(row.extras.usage, usage)
    assert.equal(row.extras.actualModel, 'actual')
  }
  await f.call('/triage', { ...report, status: 'failed', error: 'classifier-error' })
  assert.equal(f.rows.at(-1).status, 'failed')
  assert.equal(f.rows.at(-1).error, 'classifier-error')
  assert.equal(f.rows.at(-1).measured, false)
  assert.equal(f.rows.at(-1).daemonVersion, report.daemonVersion)
})
test('duplicate batch, cross-route concurrent delivery and replay each record exactly once', async () => {
  const f = serverFixture()
  const hop = { purpose: 'inbox-triage', extras: { callId: report.callId }, model: report.model }
  const results = await Promise.all([
    f.call('/triage', report), f.call('/llm-calls', { source: report.source, hops: [hop, hop] }), f.call('/triage', report),
  ])
  assert.equal(results.reduce((sum, r) => sum + r.body.inserted, 0), 1)
  assert.equal(f.rows.length, 1)
  assert.equal(f.economics.length, 1)
  assert.equal((await f.call('/triage', report)).body.inserted, 0)
  await f.call('/triage', report, 'other-company')
  assert.equal(f.rows.length, 2)
})
test('failed inserts roll back and allow retry; authorization failure writes nothing', async () => {
  const f = serverFixture()
  f.fail(true)
  await assert.rejects(f.call('/triage', report), /fake DB failure/)
  assert.equal(f.rows.length, 0)
  assert.equal(f.economics.length, 0)
  f.fail(false)
  assert.equal((await f.call('/triage', report)).body.inserted, 1)
  f.authorize(false)
  assert.equal((await f.call('/triage', { ...report, callId: 'new' })).status, 404)
  assert.equal(f.rows.length, 1)
})
test('legacy protocol remains accepted; malformed new fields write nothing', async () => {
  const f = serverFixture()
  for (const patch of [{ callId: '' }, { callId: null }, { callId: 7 }, { status: 'bad' }, { latencyMs: -1 }, { usage: {} }, { actualModel: 7 }]) {
    assert.equal((await f.call('/triage', { ...report, ...patch })).status, 400)
  }
  assert.equal(f.rows.length, 0)
  assert.equal((await f.call('/triage', { source: 'byoa-codex', actionable: false })).status, 200)
  assert.equal(f.rows[0].measured, false)
})
test('local brain remains BYOA while server agenda retains cloud ledger source', async () => {
  const f = serverFixture()
  await f.call('/llm-calls', { source: 'byoa-codex', daemonVersion: 'v1', hops: [{ purpose: 'agent-turn', model: 'local', callId: 'brain-1' }] })
  assert.equal(f.rows[0].purpose, 'agent-turn')
  assert.equal(f.rows[0].source, 'byoa-codex')
  const cloud = f.ledger.llmCallValues({ companyId: 'company', purpose: 'agenda', model: 'cloud-model', latencyMs: 0, status: 'ok' })
  assert.equal(cloud[5], 'agenda')
  assert.equal(cloud[6], 'cloud')
  assert.equal(cloud[20], null)
})

test('callId identity includes source and agent, and no-callId reports remain repeatable', async () => {
  const f = serverFixture()
  await f.call('/triage', report)
  await f.call('/triage', { ...report, source: 'byoa-claude' })
  assert.equal(f.rows.length, 2, 'different normalized sources have independent identities')
  await f.call('/triage', report, 'company', 'other-agent')
  assert.equal(f.rows.length, 3, 'different agents have independent identities')
  const legacy = { source: report.source, hops: [{ model: 'legacy', purpose: 'agent-turn' }] }
  assert.equal((await f.call('/llm-calls', legacy)).body.inserted, 1)
  assert.equal((await f.call('/llm-calls', legacy)).body.inserted, 1)
  assert.equal(f.rows.length, 5)
})

test('BYOA cooldown reads human verdict without calling the local classifier', async () => {
  const f = daemonFixture(valid, { backoffUntil: Date.now() + 600_000,
    payload: { messageIds: ['m1'], verdict: { actionable: true, reason: 'human waiting', promptNote: 'Reply to the human', source: 'human-dm' } } })
  assert.equal((await f.run()).outcome, 'execute')
  assert.equal(f.calls(), 0)
  assert.equal(f.reports.length, 0)
})

test('BYOA cooldown defers model-only payload without extending its deadline or acknowledging', async () => {
  const deadline = Date.now() + 600_000
  const f = daemonFixture(valid, { backoffUntil: deadline })
  for (let i = 0; i < 3; i++) {
    const verdict = await f.run()
    assert.equal(verdict.outcome, 'defer')
    assert.equal(verdict.ackAllowed, false)
    assert.equal(verdict.retryAt, deadline)
  }
  assert.equal(f.calls(), 0)
  assert.equal(f.reports.length, 0)
})
