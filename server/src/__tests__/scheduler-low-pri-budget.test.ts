/**
 * Unit tests for the low-priority wake budget — the post-incident
 * (FUSE-cap, 2026-05-20) backpressure that caps idle/scanner-driven
 * agent spawns at 20/min per cumora-server process.
 *
 * Run: node --import tsx --test server/src/__tests__/scheduler-low-pri-budget.test.ts
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { enqueueWakeJob, claimWakeJobs, finishWakeJob, renewWakeJob } from '../agents/wake-queue.js'
import { wakeQueueFixture } from './wake-queue-fixture.js'

// Run production declarations against in-memory I/O, without importing the
// server's eagerly connected Redis singleton or touching a database.
function schedulerFixture(overrides: Record<string, any> = {}) {
  const source = readFileSync(new URL('../agents/scheduler.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('scheduler.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['_consumeLowPriorityWakeBudget', '_resetLowPriorityWakeBudgetForTests',
    '_shouldRetryEnsurePodFailure', '_shouldRetryWakeFailure', '_wakeRetryDelayMs',
    'triageRetryDelayMs', 'shouldDeliverToMutedAgent', 'escapeRegex', 'wakeRetryId',
    'scheduleWakeRetry', 'postWakeRetryExhaustedNotice', 'pollWakeRetriesOnce',
    'wakeOne', 'wakeOneCaptured', 'claimAndWake', 'persistMessageWake', 'runClaimedWakeJob', 'fanOutWake', 'startWakeRetryWorker']
  const constants = ['lowPriWindowStart', 'lowPriUsed', 'lowPriDroppedInWindow',
    'SAFE_MESSAGE_ENSURE_FAILURE', 'MESSAGE_WAKE_RETRY_MAX_ATTEMPTS', 'WAKE_RETRY_MAX_ATTEMPTS',
    'WAKE_RETRY_QUEUE', 'WAKE_EVENT_QUEUE', 'WAKE_RETRY_BATCH_SIZE']
  const selected = ast.statements.filter(n =>
    ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '') ||
    ts.isVariableStatement(n) && n.declarationList.declarations.some(d => constants.includes(d.name.getText(ast))),
  ).map(n => n.getText(ast)).join('\n')
  const output = ts.transpileModule(selected + '\nexport { ' + names.join(', ') + ' }', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  let now = 1_000_000
  const queue = wakeQueueFixture()
  const jobs = queue.hash('cumora:wake-retry:jobs'), due = queue.sorted('cumora:wake-retry:due')
  const wakes: any[] = [], notices: any[] = [], scripts = queue.scripts
  const deps = {
    enqueueWakeJob, claimWakeJobs, finishWakeJob, renewWakeJob,
    wakeFanoutSem: { run: (task: () => any) => task() },
    wake: async () => {}, probePodApplication: async () => 'not_applied',
    Date: { now: () => now }, Math: { ...Math, min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, random: () => 0 },
    automationNumber: (key: string) => key === 'triage_backoff_base_ms' ? 30_000 : key === 'triage_backoff_max_ms' ? 60_000 : 20,
    withServerSettingsSnapshot: (fn: () => any) => fn(),
    resolveAgentHost: async () => ({ status: 'resolved', kind: 'managed', tier: 'pro' }),
    isByoaKind: (kind: string) => kind === 'byoa',
    triageWakeRecipient: async () => ({ triageNote: 'one decision', triageBoundary: 'boundary' }),
    deliverWake: async (...args: any[]) => { wakes.push(args); return 1 },
    ensurePod: async () => ({ ok: true, created: true }),
    notifyAlert: async () => {},
    inprocClient: { loadInbox: async () => [{ id: 'unread' }], postSystemNotice: async (notice: any) => { notices.push(notice); return { posted: true } } },
    redis: queue.store,
    ...overrides,
  }
  const api: Record<string, any> = {}
  new Function('exports', ...Object.keys(deps), output)(api, ...Object.values(deps))
  return { api, queue, jobs, due, wakes, notices, scripts, advance: (ms: number) => { now += ms } }
}
const { api: { _consumeLowPriorityWakeBudget, _resetLowPriorityWakeBudgetForTests,
  _shouldRetryEnsurePodFailure, _shouldRetryWakeFailure, _wakeRetryDelayMs, shouldDeliverToMutedAgent } } = schedulerFixture()

beforeEach(() => { _resetLowPriorityWakeBudgetForTests() })

test('first 20 calls allowed within a 60s window', () => {
  const t = 1_000_000
  for (let i = 0; i < 20; i++) {
    assert.equal(_consumeLowPriorityWakeBudget(t), true, `call ${i + 1} should be allowed`)
  }
})

test('call 21 within the same window is rejected', () => {
  const t = 1_000_000
  for (let i = 0; i < 20; i++) _consumeLowPriorityWakeBudget(t)
  assert.equal(_consumeLowPriorityWakeBudget(t), false)
})

test('budget resets after 60s', () => {
  const t0 = 1_000_000
  for (let i = 0; i < 20; i++) _consumeLowPriorityWakeBudget(t0)
  assert.equal(_consumeLowPriorityWakeBudget(t0), false, 'still rejected before window rolls')
  // 60s later, window rolls
  const t1 = t0 + 60_000
  assert.equal(_consumeLowPriorityWakeBudget(t1), true, 'allowed after window roll')
})

test('budget does NOT reset before 60s', () => {
  const t0 = 1_000_000
  for (let i = 0; i < 20; i++) _consumeLowPriorityWakeBudget(t0)
  assert.equal(_consumeLowPriorityWakeBudget(t0 + 59_999), false)
})

test('many rejections in a window are absorbed, then the next window is fresh', () => {
  const t0 = 2_000_000
  for (let i = 0; i < 20; i++) _consumeLowPriorityWakeBudget(t0)
  // 500 rejections — what a crashloop-recovery burst would look like
  for (let i = 0; i < 500; i++) {
    assert.equal(_consumeLowPriorityWakeBudget(t0), false)
  }
  // After the window
  const t1 = t0 + 60_000
  assert.equal(_consumeLowPriorityWakeBudget(t1), true)
})

test('wake retry delay backs off and caps at 60s', () => {
  assert.equal(_wakeRetryDelayMs(0), 5_000)
  assert.equal(_wakeRetryDelayMs(1), 10_000)
  assert.equal(_wakeRetryDelayMs(2), 20_000)
  assert.equal(_wakeRetryDelayMs(3), 40_000)
  assert.equal(_wakeRetryDelayMs(4), 60_000)
  assert.equal(_wakeRetryDelayMs(50), 60_000)
})

test('message ensurePod retries require confirmed pre-apply capacity denial', () => {
  // Ambiguous apply failures must not replay a durable message. Only a
  // structured capacity denial proves there is no cold-start drain to race.
  assert.equal(_shouldRetryEnsurePodFailure('message.new', 'capacity_denied: cluster fuse saturated'), true)
  assert.equal(_shouldRetryEnsurePodFailure('message.new', 'pod_apply_failed: timeout'), false)
  assert.equal(_shouldRetryEnsurePodFailure('message.new', 'watchdog_timeout: 180s'), false)
  assert.equal(_shouldRetryEnsurePodFailure('message.new', 'other: capacity_denied'), false)
  assert.equal(_shouldRetryEnsurePodFailure('message.new', 'cluster fuse saturated'), false)
  assert.equal(_shouldRetryEnsurePodFailure('message.new', 'already running'), false)
  assert.equal(_shouldRetryEnsurePodFailure('message.new', 'no such agent'), false)
  // manual wakes (CLI / admin) still retry — explicit delivery contract.
  assert.equal(_shouldRetryEnsurePodFailure('manual', 'pod apply failed'), true)
  assert.equal(_shouldRetryEnsurePodFailure('manual', 'no such agent'), false)
  // Synthetic wakes are handled by the inline poll loop in wakeOne,
  // not by the queue.
  assert.equal(_shouldRetryEnsurePodFailure('idle', 'cluster fuse saturated'), false)
  assert.equal(_shouldRetryEnsurePodFailure('background_scan', 'cluster fuse saturated'), false)
})

test('host-resolution failure retries before any execution location was selected', () => {
  assert.equal(
    _shouldRetryWakeFailure('message.new', 'host lookup failed', 'host_resolution'),
    true,
  )
  assert.equal(
    _shouldRetryWakeFailure('idle', 'host lookup failed', 'host_resolution'),
    true,
  )
  // The existing duplicate-turn protection remains intact for ordinary pod
  // failures after placement was successfully resolved.
  assert.equal(
    _shouldRetryWakeFailure('message.new', 'pod apply failed', 'ensure_pod'),
    false,
  )
})

test('muted agent delivery only allows direct, exact mention, or quote reply', () => {
  const base = { agentId: 'nova-12', conversationKind: 'group', body: 'ordinary room chatter', quotedAuthorId: null }
  assert.equal(shouldDeliverToMutedAgent(base), false)
  assert.equal(shouldDeliverToMutedAgent({ ...base, conversationKind: 'direct' }), true)
  assert.equal(shouldDeliverToMutedAgent({ ...base, body: 'please check this @nova-12' }), true)
  assert.equal(shouldDeliverToMutedAgent({ ...base, body: 'ping @NOVA-12, please' }), true)
  assert.equal(shouldDeliverToMutedAgent({ ...base, body: 'this is for @nova-123' }), false, 'prefix mentions must not leak through')
  assert.equal(shouldDeliverToMutedAgent({ ...base, body: 'email@nova-12 is not a mention' }), false)
  assert.equal(shouldDeliverToMutedAgent({ ...base, quotedAuthorId: 'nova-12' }), true)
})

const enqueue = (f: ReturnType<typeof schedulerFixture>, attempt = 1, failureClass = 'triage', options = {}) =>
  f.api.scheduleWakeRetry('agent', 'message.new', 'convo', null, { placementTriage: true, ...options }, attempt, 'temporary failure', failureClass)

test('retry identity survives host-to-triage transition; earlier deadline and latest boundary are retained', async () => {
  const f = schedulerFixture()
  await enqueue(f, 4, 'host_resolution')
  const firstDue = [...f.due.values()][0]
  await enqueue(f, 1, 'triage', { triageBoundary: 'new-boundary' })
  assert.equal(f.jobs.size, 1)
  const job = JSON.parse([...f.jobs.values()][0])
  assert.equal(job.id, 'agent:message.new:convo:-')
  assert.equal(job.options.triageBoundary, 'new-boundary')
  assert.equal(job.attempt, 4)
  assert.ok([...f.due.values()][0] < firstDue)
  assert.equal(job.failureClass, 'triage')
})

test('two workers atomically claim one due retry once', async () => {
  const f = schedulerFixture()
  await enqueue(f)
  f.advance(60_000)
  await Promise.all([f.api.pollWakeRetriesOnce(), f.api.pollWakeRetriesOnce()])
  assert.equal(f.wakes.length, 1)
  assert.equal(f.jobs.size, 0)
  assert.equal(f.due.size, 0)
})

test('enqueue during a claimed wake is not deleted by the old worker', async () => {
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const f = schedulerFixture({ deliverWake: async () => { entered(); await blocked; return 1 } })
  await enqueue(f)
  f.advance(60_000)
  const polling = f.api.pollWakeRetriesOnce()
  await started
  await enqueue(f, 2)
  release()
  await polling
  assert.equal(f.jobs.size, 1)
  assert.equal(JSON.parse([...f.jobs.values()][0]).attempt, 2)
})

test('resting triage exhaustion retains a low-frequency inbox probe and heals without a new message', async () => {
  let classifications = 0, spawns = 0
  const f = schedulerFixture({ deliverWake: async () => 0,
    ensurePod: async () => { spawns++; return { ok: true, created: true } },
    triageWakeRecipient: async () => {
    classifications++
    return { triageNote: 'recovered', triageBoundary: 'boundary' }
  } })
  await enqueue(f, 6)
  assert.equal(f.notices.length, 1)
  assert.equal(JSON.parse([...f.jobs.values()][0]).options.recoveryProbe, true)
  f.advance(299_999)
  await f.api.pollWakeRetriesOnce()
  assert.equal(classifications, 0)
  f.advance(1)
  await f.api.pollWakeRetriesOnce()
  assert.equal(classifications, 1)
  assert.equal(spawns, 1, 'resting Pod is started after classifier recovery')
  assert.equal(f.wakes.length, 0, 'cold-start drain needs no replay')
  assert.equal(f.jobs.size, 1, 'apply is not yet delivery')
})

test('recovery probe stops for an externally drained inbox', async () => {
  const f = schedulerFixture({ inprocClient: { loadInbox: async () => [], postSystemNotice: async () => ({ posted: false }) } })
  await enqueue(f, 6)
  f.advance(300_000)
  await f.api.pollWakeRetriesOnce()
  assert.equal(f.wakes.length, 0)
  assert.equal(f.jobs.size, 0)
})

test('Redis delivery failure retains its retry class and recovers', async () => {
  let calls = 0
  const f = schedulerFixture({ deliverWake: async () => { if (++calls === 1) throw new Error('command timed out'); return 1 } })
  await f.api.wakeOne('agent', 'message.new', 'convo', null, { placementTriage: true })
  const job = JSON.parse([...f.jobs.values()][0])
  assert.equal(job.failureClass, 'delivery')
  f.advance(60_000)
  await f.api.pollWakeRetriesOnce()
  assert.equal(calls, 2)
  assert.equal(f.jobs.size, 0)
})

for (const code of ['capacity_denied', 'pod_apply_failed', 'watchdog_timeout']) {
  test(`production ensurePod result ${code} follows replay safety contract`, async () => {
    let triages = 0
    const f = schedulerFixture({ deliverWake: async () => 0,
      triageWakeRecipient: async () => { triages++; return { triageNote: 'single triage', triageBoundary: 'boundary' } },
      ensurePod: async (_id: string, options: any) => {
        const triage = options && typeof options.then === 'function' ? await options : options
        assert.equal(triage.triageNote, 'single triage')
        return { ok: false, created: false, code, reason: 'temporary failure', applyState: code === 'capacity_denied' ? 'not_applied' : 'unknown' }
      } })
    await f.api.wakeOne('agent', 'message.new', 'convo', null, { placementTriage: true })
    assert.equal(triages, 1, 'preserve fix-lm single triage with forwarded boundary')
    assert.equal(f.jobs.size, 1, 'ambiguous failures retain a probe; pre-apply failures retry')
  })
}

test('initial events persist before fan-out and survive worker failure', async () => {
  let attempts = 0
  const f = schedulerFixture({ wake: async () => { if (++attempts === 1) throw Error('recipient lookup offline') } })
  const event = { type: 'message.new', message: { id: 'm' } }
  await f.api.claimAndWake(event)
  await f.api.claimAndWake(event)
  const events = f.queue.hash('cumora:wake-event:jobs')
  assert.equal(events.size, 1)
  assert.equal(attempts, 0, 'publishing only persists; completion requires fan-out')
  await f.api.pollWakeRetriesOnce()
  assert.equal(events.size, 1)
  f.advance(300_000)
  await f.api.pollWakeRetriesOnce()
  assert.equal(attempts, 2)
  assert.equal(events.size, 0)
})

test('online managed wake never calls ensurePod or podHealth', async () => {
  let delivered = false
  const f = schedulerFixture({
    ensurePod: () => { assert.fail('Kubernetes must not enter an online delivery') },
    deliverWake: async () => { delivered = true; return 1 },
  })
  assert.equal(await f.api.wakeOne('agent', 'message.new', 'convo', null, { placementTriage: true }), true)
  assert.equal(delivered, true)
})

test('cold wake tries delivery before starting Pod and keeps reconciliation until subscribed', async () => {
  const order: string[] = []
  const f = schedulerFixture({ deliverWake: async () => { order.push('deliver'); return 0 },
    ensurePod: async () => { order.push('ensure'); return { ok: true, created: true, applyState: 'applied' } },
  })
  await f.api.wakeOne('agent', 'message.new', 'convo', null, { placementTriage: true })
  assert.deepEqual(order, ['deliver', 'ensure'])
  assert.equal(JSON.parse([...f.jobs.values()][0]).options.applyState, 'applied')
})

test('a thrown host lookup is queued before runtime selection', async () => {
  const f = schedulerFixture({ resolveAgentHost: async () => { throw new Error('lookup timed out') } })
  await f.api.wakeOne('agent', 'message.new', 'convo', null, { placementTriage: true })
  assert.equal(f.wakes.length, 0)
  assert.equal(JSON.parse([...f.jobs.values()][0]).failureClass, 'host_resolution')
})

test('a failed recovery inbox probe retains recovery even after an ensure-pod capacity failure', async () => {
  const f = schedulerFixture({ inprocClient: {
    loadInbox: async () => { throw new Error('inbox timed out') },
    postSystemNotice: async () => ({ posted: false }),
  } })
  await f.api.scheduleWakeRetry('agent', 'message.new', 'convo', null,
    { placementTriage: true }, 6, 'capacity_denied: busy', 'ensure_pod')
  f.advance(300_000)
  await f.api.pollWakeRetriesOnce()
  const job = JSON.parse([...f.jobs.values()][0])
  assert.equal(job.failureClass, 'host_resolution')
  assert.equal(job.options.recoveryProbe, true)
  assert.equal(f.wakes.length, 0)
})

test('continued triage outage re-enters bounded retries after a recovery probe, then probes again', async () => {
  const f = schedulerFixture({ triageWakeRecipient: async () => ({
    triageDeferred: { reason: 'classifier down', retryAt: 0 }, triageBoundary: 'same',
  }) })
  await enqueue(f, 6)
  f.advance(300_000)
  await f.api.pollWakeRetriesOnce()
  assert.equal(JSON.parse([...f.jobs.values()][0]).attempt, 1)
  for (let i = 0; i < 5; i++) { f.advance(60_000); await f.api.pollWakeRetriesOnce() }
  assert.equal(JSON.parse([...f.jobs.values()][0]).options.recoveryProbe, true)
  assert.equal(f.wakes.length, 0, 'outage never bypasses the triage gate')
})

for (const observed of ['unknown', 'applied', 'not_applied', 'recoverable']) test(`unknown apply probes ${observed} before deciding to create`, async () => {
  let probes = 0, applies = 0
  const f = schedulerFixture({ deliverWake: async () => 0,
    probePodApplication: async () => { probes++; return observed },
    ensurePod: async () => { applies++; return { ok: true, created: true, applyState: 'applied' } },
  })
  await f.api.wakeOne('agent', 'message.new', 'convo', null, { placementTriage: true, applyState: 'unknown' })
  assert.equal(probes, 1)
  assert.equal(applies, observed === 'not_applied' || observed === 'recoverable' ? 1 : 0)
  assert.equal(f.jobs.size, 1)
})

test('pre-apply bootstrap failure retries without relying on the capacity code', async () => {
  const f = schedulerFixture({ deliverWake: async () => 0,
    ensurePod: async () => ({ ok: false, created: false, code: 'pod_apply_failed', reason: 'bootstrap offline', applyState: 'not_applied' }),
  })
  await f.api.wakeOne('agent', 'message.new', 'convo', null, { placementTriage: true })
  assert.equal(JSON.parse([...f.jobs.values()][0]).options.applyState, 'not_applied')
})

test('fan-out durably preserves each recipient and message identity', async () => {
  const f = schedulerFixture()
  await f.api.fanOutWake(['a', 'b'], 'c', null, null, 'm1')
  await f.api.fanOutWake(['a', 'b'], 'c', null, null, 'm1')
  await f.api.fanOutWake(['a'], 'c', null, null, 'm2')
  assert.equal(f.jobs.size, 3)
  assert.equal(f.wakes.length, 0)
})
