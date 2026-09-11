/**
 * Unit tests for `decidePodExit` — the pure helper extracted from
 * pod-agent.ts's idle watcher. Each branch corresponds to a distinct
 * pod-shutdown scenario; together they pin the post-incident
 * (FUSE-cap, 2026-05-20) recycle policy.
 *
 * Run: node --import tsx --test server/src/__tests__/pod-agent-exit.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decidePodExit } from '../agents/runtime/pod-agent-exit.js'

const IDLE_MS = 3 * 60_000  // 3 min — current default
const NO_WORK_MS = 90_000   // 90 s — current default

const baseState = {
  busy: false,
  shuttingDown: false,
  lastActivityAt: 1_000_000,
  firstWakeReceived: false,
}

test('keeps running while inside both windows', () => {
  // Pod 30s old, last activity 30s ago, no wake yet — keep going.
  const r = decidePodExit({ ...baseState, lastActivityAt: 970_000 }, 970_000, 1_000_000, IDLE_MS, NO_WORK_MS)
  assert.equal(r, null)
})

test('busy pod never exits even if both thresholds crossed', () => {
  // Pod has been busy continuously; both timers exceeded but we
  // must not interrupt a turn.
  const r = decidePodExit(
    { ...baseState, busy: true, lastActivityAt: 0 },
    0,
    10 * 60_000,  // 10 min uptime
    IDLE_MS,
    NO_WORK_MS,
  )
  assert.equal(r, null)
})

test('shuttingDown pod is left to the existing exit path', () => {
  const r = decidePodExit(
    { ...baseState, shuttingDown: true, lastActivityAt: 0 },
    0,
    10 * 60_000,
    IDLE_MS,
    NO_WORK_MS,
  )
  assert.equal(r, null)
})

test('no-work-exit fires when boot is older than NO_WORK_MS and no SSE wake arrived', () => {
  // Pod booted at t=0, current t=95s, no firstWakeReceived. Exit.
  const r = decidePodExit(
    { ...baseState, lastActivityAt: 0, firstWakeReceived: false },
    0,
    95_000,
    IDLE_MS,
    NO_WORK_MS,
  )
  assert.match(r ?? '', /no-work-exit/)
})

test('no-work-exit does NOT fire if firstWakeReceived (even with no recent activity)', () => {
  // Pod got a wake at boot, did one turn, then went quiet. The
  // idle window (3 min) hasn't elapsed yet — keep going.
  const r = decidePodExit(
    { ...baseState, lastActivityAt: 0, firstWakeReceived: true },
    0,
    95_000,
    IDLE_MS,
    NO_WORK_MS,
  )
  assert.equal(r, null)
})

test('idle-exit fires after IDLE_MS of quiet with a wake history', () => {
  // Pod got real work earlier, then quiet for full IDLE_MS.
  const r = decidePodExit(
    { ...baseState, firstWakeReceived: true, lastActivityAt: 0 },
    0,
    IDLE_MS + 1_000,
    IDLE_MS,
    NO_WORK_MS,
  )
  assert.match(r ?? '', /^idle \d+s ≥ \d+s$/)
})

test('idle-exit message reports seconds at second-precision', () => {
  const r = decidePodExit(
    { ...baseState, firstWakeReceived: true, lastActivityAt: 0 },
    0,
    200_000,
    180_000,
    NO_WORK_MS,
  )
  assert.match(r ?? '', /^idle 200s ≥ 180s$/)
})

test('no-work-exit takes priority over idle-exit when both conditions met', () => {
  // Pod has been alive 4 min, no wake ever, no recent activity.
  // Both conditions are true; no-work-exit is the more specific signal.
  const r = decidePodExit(
    { ...baseState, lastActivityAt: 0, firstWakeReceived: false },
    0,
    4 * 60_000,
    IDLE_MS,
    NO_WORK_MS,
  )
  assert.match(r ?? '', /no-work-exit/)
})

test('keeps running while NO_WORK_MS not yet crossed', () => {
  // Pod is 60s old, no wake yet — still within no-work window.
  const r = decidePodExit(
    { ...baseState, lastActivityAt: 0, firstWakeReceived: false },
    0,
    60_000,
    IDLE_MS,
    NO_WORK_MS,
  )
  assert.equal(r, null)
})

// Exercise the actual Pod drain and timers without booting main(), Redis or DB.
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mergeWakeTurnOptions, parseWakeData } from '../agents/runtime/wake-options.js'

function drainFixture() {
  const source = readFileSync(new URL('../agents/runtime/pod-agent.ts', import.meta.url), 'utf8')
  const start = source.indexOf('interface RunnerState')
  const end = source.indexOf('// parseSseStream + SseEvent')
  const ast = ts.createSourceFile('pod.ts', source, ts.ScriptTarget.Latest, true)
  const idle = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'startIdleWatcher')!
  const output = ts.transpileModule(source.slice(start, end) + idle.getText(ast) + '\nexport { drain, state, startInboxProbe, startIdleWatcher }', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  let now = 1_000_000
  let inbox = [{ id: 'old' }]
  const contexts = new AsyncLocalStorage<string>()
  const timers: Array<{ context: string | undefined; fn: () => void; ms: number; cleared: boolean; interval: boolean; unref: () => void }> = []
  const timer = (fn: () => void, ms: number, interval: boolean) => {
    const value = { context: contexts.getStore(), fn, ms, interval, cleared: false, unref() {} }
    timers.push(value)
    return value
  }
  const calls: any[] = []
  let run: (options: any) => Promise<void> = async options => {
    options.onInboxDeferred({ messageIds: ['old'], retryAt: now + 120_000 })
  }
  const deps = {
    Date: { now: () => now }, mergeWakeTurnOptions, parseWakeData, decidePodExit,
    process: { env: {} },
    runtime: { loadInbox: async (_id: string, options: { excludeMessageIds?: string[]; onlyMessageIds?: string[] } = {}) =>
      inbox.filter(row => !options.excludeMessageIds?.includes(row.id)
        && (!options.onlyMessageIds || options.onlyMessageIds.includes(row.id))) },
    runAgentTurn: async (_id: string, options: any) => { calls.push(options); await run(options) },
    setTimeout: (fn: () => void, ms: number) => timer(fn, ms, false),
    setInterval: (fn: () => void, ms: number) => timer(fn, ms, true),
    clearTimeout: (value: typeof timers[number]) => { value.cleared = true },
    clearInterval: (value: typeof timers[number]) => { value.cleared = true },
  }
  const pod: Record<string, any> = {}
  new Function('exports', ...Object.keys(deps), output)(pod, ...Object.values(deps))
  return { pod, calls, timers, contexts, advance: (ms: number) => { now += ms },
    inbox: (rows: Array<{ id: string }>) => { inbox = rows },
    run: (fn: typeof run) => { run = fn } }
}
const flushDrain = () => new Promise(resolve => setImmediate(resolve))

test('Pod wake and 30s probe respect a 120s defer boundary; deadline retries without another wake', async () => {
  const f = drainFixture()
  await f.pod.drain('a')
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.pod.state.inboxDeferred.messageIds, ['old'])
  f.advance(30_000)
  await f.pod.drain('a', { trigger: 'message.new' })
  f.pod.startInboxProbe('a')
  const probe = f.timers.find(t => t.interval && t.ms === 30_000)!
  probe.fn()
  await flushDrain()
  assert.equal(f.calls.length, 1, 'duplicate wakes and probes do not bypass the unchanged boundary')
  f.run(async () => {})
  f.advance(90_000)
  f.timers.find(t => !t.interval && !t.cleared)!.fn()
  await flushDrain()
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].trigger, 'message.new')
  assert.equal(f.pod.state.inboxDeferred, null)
})

test('Pod clears obsolete deferred messages after external acknowledgement and admits the new boundary', async () => {
  const f = drainFixture()
  await f.pod.drain('a')
  f.inbox([{ id: 'new' }])
  f.run(async () => {})
  await f.pod.drain('a')
  assert.equal(f.calls.length, 2)
  assert.equal(f.pod.state.inboxDeferred, null)
  assert.ok(f.timers[0].cleared)
})

test('Pod coalesces concurrent wakes and applies defer before a queued rerun', async () => {
  const f = drainFixture()
  let release!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  f.run(async options => { await paused; options.onInboxDeferred({ messageIds: ['old'], retryAt: 1_120_000 }) })
  const first = f.pod.drain('a')
  await flushDrain()
  await Promise.all([f.pod.drain('a'), f.pod.drain('a')])
  release()
  await first
  assert.equal(f.calls.length, 1)
  assert.equal(f.pod.state.busy, false)
})

test('Pod idle/no-work exit cannot erase an outstanding in-memory defer boundary', async () => {
  const f = drainFixture()
  await f.pod.drain('a')
  let exits = 0
  f.pod.startIdleWatcher('a', 1000, 1000, () => { exits++ })
  f.advance(2000)
  f.timers.find(t => t.interval)!.fn()
  assert.equal(exits, 0)
  f.inbox([])
  f.run(async () => {})
  await f.pod.drain('a')
  f.advance(2000)
  f.timers.find(t => t.interval)!.fn()
  assert.equal(exits, 1)
})


test('Pod retry timer is scheduled outside the completed turn settings context', async () => {
  const f = drainFixture()
  f.run(async options => f.contexts.run('old-revision', async () => {
    options.onInboxDeferred({ messageIds: ['old'], retryAt: 1_120_000 })
  }))
  await f.pod.drain('a')
  const retry = f.timers.find(t => !t.interval && !t.cleared)!
  assert.equal(retry.context, undefined, 'timer must not pin the old turn revision')
})

for (const source of ['wake', 'probe']) {
  test(`Pod new human message bypasses old defer through ${source}`, async () => {
    const f = drainFixture()
    await f.pod.drain('a')
    f.advance(30_000)
    f.inbox([{ id: 'old' }, { id: 'human-new' }])
    f.run(async () => {})
    if (source === 'wake') await f.pod.drain('a', { trigger: 'message.new' })
    else {
      f.pod.startInboxProbe('a')
      f.timers.find(t => t.interval && t.ms === 30_000)!.fn()
      await flushDrain()
    }
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.pod.state.inboxDeferred.messageIds, ['old'], 'new human work cannot acknowledge old deferred work')
    assert.deepEqual(f.calls[1].excludeInboxMessageIds, ['old'])
    assert.ok(f.timers[0].cleared, 'old deadline is rearmed after the fresh turn')
  })
}
