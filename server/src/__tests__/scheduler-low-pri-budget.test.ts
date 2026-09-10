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

// Run production declarations against in-memory I/O, without importing the
// server's eagerly connected Redis singleton or touching a database.
function schedulerFixture(overrides: Record<string, any> = {}) {
  const source = readFileSync(new URL('../agents/scheduler.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('scheduler.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['_consumeLowPriorityWakeBudget', '_resetLowPriorityWakeBudgetForTests',
    '_shouldRetryEnsurePodFailure', '_shouldRetryWakeFailure', '_wakeRetryDelayMs',
    'triageRetryDelayMs', 'shouldDeliverToMutedAgent', 'escapeRegex', 'wakeRetryId',
    'scheduleWakeRetry', 'postWakeRetryExhaustedNotice', 'pollWakeRetriesOnce',
    'wakeOne', 'wakeOneCaptured', 'claimAndWake', 'startWakeRetryWorker']
  const constants = ['lowPriWindowStart', 'lowPriUsed', 'lowPriDroppedInWindow',
    'SAFE_MESSAGE_ENSURE_FAILURE', 'MESSAGE_WAKE_RETRY_MAX_ATTEMPTS', 'WAKE_RETRY_MAX_ATTEMPTS',
    'WAKE_RETRY_DUE_KEY', 'WAKE_RETRY_JOB_KEY', 'WAKE_RETRY_BATCH_SIZE']
  const selected = ast.statements.filter(n =>
    ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '') ||
    ts.isVariableStatement(n) && n.declarationList.declarations.some(d => constants.includes(d.name.getText(ast))),
  ).map(n => n.getText(ast)).join('\n')
  const output = ts.transpileModule(selected + '\nexport { ' + names.join(', ') + ' }', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  let now = 1_000_000
  const jobs = new Map<string, string>(), due = new Map<string, number>()
  const wakes: any[] = [], notices: any[] = [], scripts: string[] = []
  const deps = {
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
    redis: { eval: async (script: string, _count: number, _jobs: string, _due: string, ...args: any[]) => {
      scripts.push(script)
      if (script.includes('ZRANGEBYSCORE')) {
        assert.match(script, /HGET/)
        assert.match(script, /HDEL/)
        assert.match(script, /ZREM/)
        const claimed: string[] = []
        for (const [id, score] of [...due].sort((a, b) => a[1] - b[1])) {
          if (score > args[0] || claimed.length >= args[1]) continue
          const raw = jobs.get(id)
          due.delete(id); jobs.delete(id)
          if (raw) claimed.push(raw)
        }
        return claimed
      }
      assert.match(script, /math.min/)
      assert.match(script, /math.max/)
      const [id, raw, at] = args
      const incoming = JSON.parse(raw), previous = jobs.get(id)
      if (previous) incoming.attempt = Math.max(JSON.parse(previous).attempt, incoming.attempt)
      jobs.set(id, JSON.stringify(incoming)); due.set(id, Math.min(due.get(id) ?? at, at))
      return 1
    } },
    ...overrides,
  }
  const api: Record<string, any> = {}
  new Function('exports', ...Object.keys(deps), output)(api, ...Object.values(deps))
  return { api, jobs, due, wakes, notices, scripts, advance: (ms: number) => { now += ms } }
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
  assert.equal(job.id, 'agent:message.new:convo')
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
  assert.equal(f.jobs.size, 0)
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
        return { ok: false, created: false, code, reason: 'temporary failure' }
      } })
    await f.api.wakeOne('agent', 'message.new', 'convo', null, { placementTriage: true })
    assert.equal(triages, 1, 'preserve fix-lm single triage with forwarded boundary')
    assert.equal(f.jobs.size, code === 'capacity_denied' ? 1 : 0)
  })
}

test('message claim renews across a long fan-out and cannot renew another owner', async () => {
  let now = 0, sequence = 0, fanouts = 0
  let claim: { owner: string; until: number } | null = null
  const timers: Array<{ fn: () => void; cleared: boolean; unref: () => void }> = []
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const f = schedulerFixture({ randomUUID: () => String(++sequence), wake: async () => { fanouts++; await blocked },
    setInterval: (fn: () => void) => { const t = { fn, cleared: false, unref() {} }; timers.push(t); return t },
    clearInterval: (t: typeof timers[number]) => { t.cleared = true },
    redis: {
      set: async (_key: string, owner: string, _ex: string, seconds: number) => {
        if (claim && claim.until > now) return null
        claim = { owner, until: now + seconds * 1000 }; return 'OK'
      },
      eval: async (script: string, _n: number, _key: string, owner: string) => {
        assert.match(script, /GET/); assert.match(script, /EXPIRE/)
        if (!claim || claim.owner !== owner) return 0
        claim.until = now + 300_000; return 1
      },
    },
  })
  const first = f.api.claimAndWake({ message: { id: 'm' } })
  await new Promise(resolve => setImmediate(resolve))
  for (let i = 0; i < 20; i++) { now += 30_000; timers[0].fn() }
  await f.api.claimAndWake({ message: { id: 'm' } })
  assert.equal(fanouts, 1, '600s fan-out still has one owner')
  claim = { owner: 'new-owner', until: now + 1 }
  timers[0].fn()
  assert.equal(claim.until, now + 1)
  release(); await first
  assert.equal(timers[0].cleared, true)
})

test('message.new cold start overlaps inbox triage with ensurePod', async () => {
  let triageStarted = false, ensureStarted = false
  let releaseTriage!: () => void, releaseEnsure!: () => void
  const triageGate = new Promise<void>(resolve => { releaseTriage = resolve })
  const ensureGate = new Promise<void>(resolve => { releaseEnsure = resolve })
  const f = schedulerFixture({
    deliverWake: async () => 0,
    triageWakeRecipient: async () => {
      triageStarted = true
      await triageGate
      return { triageNote: 'n', triageBoundary: 'b' }
    },
    ensurePod: async () => {
      ensureStarted = true
      await ensureGate
      return { ok: true, created: true }
    },
  })
  const pending = f.api.wakeOne('agent', 'message.new', 'convo', null, { placementTriage: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(triageStarted, true)
  assert.equal(ensureStarted, true)
  releaseTriage()
  releaseEnsure()
  await pending
  assert.equal(f.wakes.length, 0)
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
