import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { BYOA_SYNC_INTERVALS, ByoaPolicyController, ByoaSemaphore, makeByoaPolicy, parseByoaPolicy, parseByoaPolicyReport, type ByoaPolicyValues } from '../agents/computer/runtime-policy.js'

const local: ByoaPolicyValues = {
  bigBrainConcurrency: 6, triageConcurrency: 8, spawnIntervalMs: 500,
  triageTimeoutMs: 30_000, triageBackoffBaseMs: 30_000, triageBackoffMaxMs: 600_000,
  groupSteerEnabled: true, groupSteerIntervalMs: 8000,
}
const policy = (revision: string, changes: Partial<ByoaPolicyValues> = {}) => makeByoaPolicy(revision, { ...local, ...changes })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('first boot with old server retains local configuration and reports no application', () => {
  const c = new ByoaPolicyController({ ...local, triageTimeoutMs: 123 })
  assert.equal(c.receive(undefined), false)
  assert.equal(c.values.triageTimeoutMs, 123)
  assert.deepEqual(c.report(), { schemaVersion: 1, received: null, applied: null })
})

test('online update, disconnect and reconnect retain the last valid policy and reject late revisions', () => {
  const applied: number[] = []
  const c = new ByoaPolicyController(local, p => applied.push(p.spawnIntervalMs))
  assert.ok(c.receive(policy('1', { spawnIntervalMs: 900, groupSteerEnabled: false })))
  assert.equal(c.receive(null), false)
  assert.equal(c.values.spawnIntervalMs, 900)
  assert.ok(c.receive(policy('2', { triageTimeoutMs: 7000 })))
  assert.equal(c.receive(policy('1')), false)
  assert.equal(c.values.triageTimeoutMs, 7000)
  assert.equal(c.report().applied, policy('2', { triageTimeoutMs: 7000 }).version)
  c.receive(policy('2', { triageTimeoutMs: 7000 }))
  assert.deepEqual(applied, [900, 500])
})

test('lower concurrency drains active brain and triage work, then admits queued work under the new cap', async () => {
  const c = new ByoaPolicyController(local)
  c.receive(policy('1'))
  await Promise.all([c.bigBrain.acquire(), c.bigBrain.acquire(), c.triage.acquire()])
  const next = policy('2', { bigBrainConcurrency: 1, triageConcurrency: 1 })
  c.receive(next)
  assert.equal(c.report().received, next.version)
  assert.equal(c.report().applied, policy('1').version)
  const started: string[] = []
  const first = c.bigBrain.acquire().then(() => { started.push('first') })
  const second = c.bigBrain.acquire().then(() => { started.push('second') })
  c.bigBrain.release()
  c.bigBrain.release()
  await flush()
  assert.deepEqual(started, [])
  c.triage.release()
  await first
  assert.deepEqual(started, ['first'])
  assert.equal(c.report().applied, next.version)
  c.bigBrain.release()
  await second
  assert.deepEqual(started, ['first', 'second'])
  c.bigBrain.release()
})

test('latest pending snapshot wins and increased capacity drains the FIFO queue', async () => {
  const c = new ByoaPolicyController({ ...local, bigBrainConcurrency: 1 })
  await c.bigBrain.acquire()
  c.receive(policy('1', { bigBrainConcurrency: 1 }))
  c.receive(policy('2', { bigBrainConcurrency: 3 }))
  const queued = [c.bigBrain.acquire(), c.bigBrain.acquire(), c.bigBrain.acquire()]
  c.bigBrain.release()
  await Promise.all(queued)
  assert.equal(c.bigBrain.active, 3)
  assert.equal(c.report().applied, policy('2', { bigBrainConcurrency: 3 }).version)
  queued.forEach(() => { c.bigBrain.release() })
})

test('semaphore reserves a released slot before a new arrival can steal it', async () => {
  const s = new ByoaSemaphore(1)
  await s.acquire()
  const order: number[] = []
  const a = s.acquire().then(() => { order.push(1) })
  s.release()
  const b = s.acquire().then(() => { order.push(2) })
  await a
  assert.deepEqual(order, [1])
  assert.equal(s.active, 1)
  s.release()
  await b
  s.release()
  assert.deepEqual(order, [1, 2])
})

test('policy parser rejects malformed, unsupported and corrupt snapshots without losing valid state', () => {
  const c = new ByoaPolicyController(local)
  c.receive(policy('3'))
  for (const raw of [policy('4', { triageBackoffBaseMs: 700_000 }), policy('4', { triageConcurrency: 0 }),
    policy('4', { spawnIntervalMs: NaN }), policy('4', { triageTimeoutMs: 1.5 }),
    { ...policy('4'), version: 'bad' }, { ...policy('4'), schemaVersion: 2 }]) {
    assert.equal(c.receive(raw), false)
    assert.equal(c.report().applied, policy('3').version)
  }
})

test('wire projection excludes local models, credentials, endpoint and engine compression', () => {
  const parsed = parseByoaPolicy({ ...policy('1'), model: 'remote', fastModel: 'remote-fast', endpoint: 'secret', credentials: 'secret', compaction: {} })!
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(policy('1')).sort())
  assert.equal(JSON.stringify(parsed).includes('secret'), false)
  assert.deepEqual(BYOA_SYNC_INTERVALS, { policyHeartbeatMs: 30_000, resourceSyncMs: 60_000 })
})

test('reports require an explicit compatible protocol and cannot claim applied without receipt', () => {
  for (const raw of [undefined, {}, { version: 'new' }, { schemaVersion: 2 },
    { schemaVersion: 1, received: null, applied: policy('1').version },
    { schemaVersion: 1, received: policy('1').version, applied: policy('2').version }]) {
    assert.equal(parseByoaPolicyReport(raw), null)
  }
})

function compile(source: string, globals: Record<string, unknown>) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', ...Object.keys(globals), output)(exports, ...Object.values(globals))
  return exports
}
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
function registryFixture() {
  const source = read('../agents/computer/registry.ts')
  const ast = ts.createSourceFile('registry.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['computerPolicyKey', 'currentByoaRuntimePolicy', 'computerPolicyState', 'syncComputerRuntimePolicy', 'getComputerPolicyState']
  const selected = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '')).map(n => n.getText(ast)).join('\n')
  const saved = new Map<string, string>()
  let current = policy('1')
  let fail = false
  const f = compile(selected + '\nexport { getComputerPolicyState }', {
    makeByoaPolicy, parseByoaPolicyReport, BYOA_SYNC_INTERVALS,
    getByoaRuntimePolicyValues: () => { const { schemaVersion, revision, version, ...values } = current; return { revision, values } },
    redis: {
      set: async (key: string, value: string, ex: string, ttl: number) => { if (fail) throw new Error('offline'); assert.equal(ex, 'EX'); assert.equal(ttl, 120); saved.set(key, value) },
      get: async (key: string) => { if (fail) throw new Error('offline'); return saved.get(key) },
    },
  })
  return {
    syncComputerRuntimePolicy: f.syncComputerRuntimePolicy as typeof import('../agents/computer/registry.js').syncComputerRuntimePolicy,
    getComputerPolicyState: f.getComputerPolicyState as (companyId: string, computerId: string) => Promise<import('../agents/computer/registry.js').ByoaPolicyState>,
    saved, update: (p: typeof current) => { current = p }, fail: () => { fail = true },
  }
}

test('server records received/applied per tenant; old daemon heartbeat clears prior application', async () => {
  const f = registryFixture()
  const c = new ByoaPolicyController(local)
  let response = await f.syncComputerRuntimePolicy('company-a', 'device', c.report())
  assert.equal(response.runtimePolicyState.status, 'pending')
  c.receive(response.runtimePolicy)
  response = await f.syncComputerRuntimePolicy('company-a', 'device', c.report())
  assert.equal(response.runtimePolicyState.status, 'applied')
  assert.equal((await f.getComputerPolicyState('company-b', 'device')).status, 'unknown')
  f.update(policy('2'))
  assert.equal((await f.getComputerPolicyState('company-a', 'device')).status, 'pending')
  await c.bigBrain.acquire()
  c.receive(policy('2'))
  response = await f.syncComputerRuntimePolicy('company-a', 'device', c.report())
  assert.equal(response.runtimePolicyState.status, 'received')
  c.bigBrain.release()
  await f.syncComputerRuntimePolicy('company-a', 'device', c.report())
  assert.equal((await f.getComputerPolicyState('company-a', 'device')).status, 'applied')
  response = await f.syncComputerRuntimePolicy('company-a', 'device', undefined)
  assert.equal(response.runtimePolicyState.status, 'unsupported')
  assert.equal((await f.getComputerPolicyState('company-a', 'device')).applied, null)
  assert.equal(response.runtimePolicyState.policyHeartbeatMs, 30_000)
  assert.equal(response.runtimePolicyState.resourceSyncMs, 60_000)
})

test('Redis outage does not block policy delivery and read status becomes unknown', async () => {
  const f = registryFixture()
  f.fail()
  assert.equal((await f.syncComputerRuntimePolicy('c', 'd', undefined)).runtimePolicy.version, policy('1').version)
  assert.equal((await f.getComputerPolicyState('c', 'd')).status, 'unknown')
})

function heartbeatFixture() {
  const source = read('../agents/computer/daemon.ts')
  const ast = ts.createSourceFile('daemon.ts', source, ts.ScriptTarget.Latest, true)
  const run = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'doRun') as ts.FunctionDeclaration
  const names = ['heartbeatOnce', 'heartbeatInFlight', 'heartbeat']
  const selected = run.body!.statements.filter(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast)))).map(n => n.getText(ast)).join('\n')
  const c = new ByoaPolicyController(local)
  const requests: any[] = []
  let result: any = { ok: true, json: async () => ({ runtimePolicy: policy('1') }) }
  const f = compile(selected + '\nexport { heartbeat }', {
    runtimePolicy: c, cfg: { serverUrl: 'https://fake.invalid', deviceToken: 'fake' },
    CURRENT_VERSION: 'test', SUPERVISED: false, engineInventory: { current: ['codex'] },
    HTTP_TIMEOUT_MS: 100, AbortSignal: { timeout: () => undefined }, rescanEngines: () => {},
    fetch: async (_url: string, init: any) => { requests.push(JSON.parse(init.body)); if (result instanceof Error) throw result; return result },
  })
  return { heartbeat: f.heartbeat, c, requests, respond: (next: any) => { result = next } }
}

test('actual daemon heartbeat consumes policy, reports it next time and survives network/legacy responses', async () => {
  const f = heartbeatFixture()
  await Promise.all([f.heartbeat(), f.heartbeat()])
  assert.equal(f.requests.length, 1, 'overlapping heartbeats coalesce')
  assert.equal(f.requests[0].runtimePolicy.applied, null)
  assert.equal(f.c.report().applied, policy('1').version)
  f.respond(new Error('offline'))
  await f.heartbeat()
  assert.equal(f.requests[1].runtimePolicy.applied, policy('1').version)
  assert.equal(f.c.report().applied, policy('1').version)
  f.respond({ ok: true, json: async () => ({ detectRequested: false }) })
  await f.heartbeat()
  assert.equal(f.c.report().applied, policy('1').version)
  f.respond({ ok: false })
  await f.heartbeat()
  assert.equal(f.c.report().applied, policy('1').version)
  f.respond({ ok: true, json: async () => ({ runtimePolicy: policy('2', { spawnIntervalMs: 1500 }) }) })
  await f.heartbeat()
  assert.equal(f.c.values.spawnIntervalMs, 1500)
})

test('actual router heartbeat authorizes the device and carries the optional policy protocol', async () => {
  const source = read('../api/router.ts')
  const start = source.indexOf("api.post('/computers/heartbeat'")
  const end = source.indexOf('// Mint a per-agent', start)
  let handler: any
  const f = registryFixture()
  compile(source.slice(start, end), {
    api: { post: (_path: string, callback: any) => { handler = callback } }, safe: (fn: any) => fn,
    requireDevice: async () => ({ companyId: 'authenticated-company', computerId: 'authenticated-device' }),
    heartbeatComputer: async (id: string) => { assert.equal(id, 'authenticated-device'); return true },
    syncComputerRuntimePolicy: f.syncComputerRuntimePolicy,
  })
  let response: any
  await handler({ body: { companyId: 'forged', runtimePolicy: { schemaVersion: 1, received: null, applied: null } } }, { json: (body: any) => { response = body } })
  assert.equal(response.ok, true)
  assert.equal(response.detectRequested, true)
  assert.ok(parseByoaPolicy(response.runtimePolicy))
  assert.deepEqual([...f.saved.keys()], ['cumora:byoa-policy:authenticated-company:authenticated-device'])
})

test('actual adaptive pacer takes the new base and preserves adaptive rate-limit behavior', async () => {
  const source = read('../agents/computer/daemon.ts')
  const ast = ts.createSourceFile('daemon.ts', source, ts.ScriptTarget.Latest, true)
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'AdaptivePacer')!
  let now = 0
  const waits: number[] = []
  const { AdaptivePacer } = compile(cls.getText(ast) + '\nexport { AdaptivePacer }', {
    Date: { now: () => now }, setTimeout: (done: () => void, ms: number) => { waits.push(ms); now += ms; done() },
    console: { warn() {}, log() {} },
  })
  const p = new AdaptivePacer(500)
  await p.gate()
  await p.gate()
  assert.deepEqual(waits, [500])
  p.setBase(1200)
  await p.gate()
  assert.equal(waits.at(-1), 1200)
  p.onRateLimited()
  assert.equal(p.intervalMs, 2400)
  for (let i = 0; i < 5; i++) p.onOk()
  assert.equal(p.intervalMs, 1200)
  p.setBase(10_000)
  p.onRateLimited()
  assert.equal(p.intervalMs, 10_000, 'adaptive cap never lowers an explicitly larger base')
})

test('actual group steer respects the policy toggle and throttle while direct human pings remain enabled', async () => {
  const source = read('../agents/computer/daemon.ts')
  const ast = ts.createSourceFile('daemon.ts', source, ts.ScriptTarget.Latest, true)
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'AgentRunner') as ts.ClassDeclaration
  const method = cls.members.find(n => n.name?.getText(ast) === 'maybeSteer')!.getText(ast)
  const c = new ByoaPolicyController(local)
  let row = { id: 'm1', conversation_id: 'c', conversation_kind: 'group', author_kind: 'agent', body: 'hello' }
  const { Runner } = compile(`export class Runner { ${method} }`, {
    runtimePolicy: c, Date: { now: () => 10_000 }, runtimeGet: async () => ({ rows: [row] }), console: { log() {} },
  })
  const notices: string[] = []
  const runner = new Runner()
  Object.assign(runner, { engineSession: { alive: true, steer: (text: string) => notices.push(text) },
    ensureToken: async () => {}, cfg: { serverUrl: 'fake' }, agent: { id: 'a' }, lastGroupSteerAt: 0 })
  c.receive(policy('1', { groupSteerEnabled: false }))
  await runner.maybeSteer('c')
  assert.equal(notices.length, 0)
  row = { ...row, author_kind: 'human' }
  await runner.maybeSteer('c')
  assert.equal(notices.length, 1)
  row = { ...row, id: 'm2', author_kind: 'agent' }
  c.receive(policy('2', { groupSteerIntervalMs: 20_000 }))
  await runner.maybeSteer('c')
  assert.equal(notices.length, 1)
  c.receive(policy('3', { groupSteerIntervalMs: 5000 }))
  await runner.maybeSteer('c')
  assert.equal(notices.length, 2)
  assert.match(notices[1], /bodies withheld/)
})

for (const fail of [false, true]) test(`resource materialization drains coalesced wakes after ${fail ? 'failure' : 'success'}`, async () => {
  const source = read('../agents/computer/daemon.ts')
  const ast = ts.createSourceFile('daemon.ts', source, ts.ScriptTarget.Latest, true)
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'AgentRunner') as ts.ClassDeclaration
  const method = cls.members.find(n => n.name?.getText(ast) === 'queueResources')!.getText(ast)
  const { Runner } = compile(`export class Runner { ${method} }`, { structuredClone })
  const runner = new Runner()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const kicks: string[] = []
  Object.assign(runner, {
    busy: false, stopped: false, pendingRerun: false,
    applyPendingResources: async () => { await gate; if (fail) throw new Error('materialization failed') },
    kickTurn: (reason: string) => {
      assert.equal(runner.busy, false)
      runner.pendingRerun = false
      kicks.push(reason)
    },
  })
  const applying = runner.queueResources({ id: 'a' })
  assert.equal(runner.busy, true)
  assert.deepEqual(kicks, [])
  runner.pendingRerun = true
  await runner.queueResources({ id: 'a', resourceVersion: '2' })
  release()
  if (fail) await assert.rejects(applying, /materialization failed/)
  else await applying
  assert.deepEqual(kicks, ['resources-applied'])
  assert.equal(runner.busy, false)
  runner.applyPendingResources = async () => {}
  await runner.queueResources({ id: 'a' })
  assert.equal(kicks.length, 1, 'no wake means no extra turn')
  runner.stopped = true
  runner.pendingRerun = true
  await runner.queueResources({ id: 'a' })
  assert.equal(kicks.length, 1, 'a stopped runner must not be revived')
})
