import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import type * as Orchestrator from '../agents/runtime/orchestrator.js'

const source = readFileSync(new URL('../agents/runtime/orchestrator.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function cluster() {
  const state = {
    cap: 40, used: 0, activeLeases: 0, maxLeases: 0, locks: 0, releases: 0,
    nodeError: false, malformedPods: false, denyPlacement: false, existingPhase: '',
    deleteError: false, lockError: false, unlockError: false, destroyed: 0, denyAfterHealth: false, lookupError: false, warnings: [] as string[],
    manifests: [] as string[], commands: [] as string[][], alerts: [] as unknown[],
    onApply: undefined as (() => void) | undefined,
  }
  const pool = {
    async connect() {
      return {
        async query(sql: string, values: string[]) {
          assert.equal(values.length, 1)
          assert.equal(values[0], '7643178926307')
          if (sql.includes('pg_try_advisory_lock(')) {
            if (state.lockError) throw new Error('database unavailable')
            if (state.activeLeases) return { rows: [{ locked: false }] }
            state.locks++
            state.activeLeases++
            state.maxLeases = Math.max(state.maxLeases, state.activeLeases)
            return { rows: [{ locked: true }] }
          } else if (sql.includes('pg_advisory_unlock(')) {
            if (state.unlockError) throw new Error('connection lost')
            state.activeLeases--
            return { rows: [{ unlocked: true }] }
          } else assert.fail(sql)
        },
        release(discard: boolean) { state.releases++; if (discard) { state.destroyed++; state.activeLeases = 0 } },
      }
    },
  }
  function replica(processEnv: Record<string, string> = {}) {
    const settings: Record<string, string> = {
      pod_admission_max: '40', pod_fuse_threshold: '0.90', pod_idle_ms: '180000', pod_no_work_ms: '90000',
      cluster_monitor_pending_min: '20', cluster_monitor_ratio_min: '0.95', cluster_monitor_sustained_ms: '300000',
      cluster_monitor_alert_cooldown_ms: '1800000',
    }
    const env = {
      NODE_ENV: 'production', KUBECTL_MAX_CONCURRENCY: 8, SUB2API_INTERNAL_URL: '', SUB2API_PUBLIC_URL: '',
      AGENT_RUNTIME_SERVER_URL: 'https://runtime.invalid', DATABASE_URL: 'postgres://test.invalid/test',
      REDIS_URL: 'redis://test.invalid', NOVITA_API_KEY: '', NOVITA_BASE_URL: '', ORCAROUTER_API_KEY: '', ORCAROUTER_BASE_URL: '',
    }
    const timers: Array<{ enabled: string; interval: string; tick: () => Promise<void>; options: unknown }> = []
    const exports = {} as typeof Orchestrator
    let now = 1000
    const spawn = (_command: string, args: string[]) => {
      const command = args.slice(args.indexOf('-n') + 2)
      state.commands.push(command)
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        kill() { assert.fail('no fake child should time out') },
        stdin: { end(manifest?: string) {
          queueMicrotask(() => {
            let out = ''
            let code = 0
            let err = ''
            if (command[0] === 'get' && command[1] === 'nodes') {
              if (state.nodeError) { code = 1; err = 'Forbidden' }
              else out = JSON.stringify({ items: [{ status: { capacity: { 'devic.es/fuse': String(state.cap) } } }] })
            } else if (command[0] === 'get' && command[1] === 'pods') {
              if (command.includes('--no-headers')) out = ''
              else out = state.malformedPods ? 'not json' : JSON.stringify({ items: Array.from({ length: state.used }, () => ({ status: { phase: 'Running' } })) })
            } else if (command[0] === 'get' && command[1] === 'pod') {
              out = JSON.stringify({ status: { phase: state.existingPhase } })
              if (state.denyAfterHealth) state.denyPlacement = true
            } else if (command[0] === 'apply') {
              assert.equal(state.activeLeases, 1, 'Pod apply remains inside the cross-replica admission lease')
              assert.match(manifest!, /kind: Pod/)
              state.manifests.push(manifest!)
              state.onApply?.()
              state.used++
            } else if (command[0] === 'delete') {
              if (state.deleteError) { code = 1; err = 'Forbidden' }
              else state.existingPhase = ''
            } else assert.fail('unexpected kubectl command: ' + command.join(' '))
            child.stdout.emit('data', out)
            child.stderr.emit('data', err)
            child.emit('exit', code)
          })
        } },
      })
      return child
    }
    runInNewContext(compiled, {
      exports, URL, AbortController, setTimeout, clearTimeout, setImmediate,
      Date: class extends Date { static now() { return now } },
      process: { env: { CUMORA_CHROME_PROFILE_PVC: 'false', ...processEnv } },
      console: { log() {}, warn(message: string) { state.warnings.push(message) }, error() {} },
      require(name: string) {
        if (name === 'node:crypto') return { randomBytes }
        if (name === 'node:child_process') return { spawn }
        if (name === '../../env.js') return { env }
        if (name === '../../db/pool.js') return { pool }
        if (name === '../../settings.js') return {
          getServerSettingsSnapshot: () => ({ revision: '1', settings: { ...settings } }),
          automationNumber: (key: string) => Number(settings[key]),
          createManagedPodBootstrap: async () => ({ direct: { text: { apiKey: '', baseURL: '' } } }),
          getBrainModel: () => 'brain', getSupportModel: () => 'support', getCompactionModel: () => 'compact',
          startAutomationTimer: (enabled: string, interval: string, tick: () => Promise<void>, options: unknown) => {
            timers.push({ enabled, interval, tick, options })
            return { unref() {} }
          },
        }
        if (name === '../reasoning.js') return { agentReasoningEffort: () => 'low', agentMaxOutputTokens: () => 4000, supportReasoningEffort: () => 'low', supportReasoningHeadroom: () => 0 }
        if (name === './inproc-client.js') return { inprocClient: { loadPersona: async () => ({ companyId: 'company' }) } }
        if (name === './jwt.js') return { signAgentToken: () => 'fake-token' }
        if (name === '../../alerting.js') return { notifyAlert: async (alert: unknown) => { state.alerts.push(alert) } }
        if (name === '../../concurrency.js') return { Semaphore: class { run<T>(fn: () => T) { return fn() } } }
        if (name === '../computer/registry.js') return {
          resolveAgentHost: async () => ({}),
          managedPodPlacement: () => state.lookupError ? { status: 'denied', code: 'placement_lookup_failed', reason: 'lookup failed' } : state.denyPlacement
            ? { status: 'denied', code: 'placement_denied', reason: 'invalid placement' }
            : { status: 'allowed', companyId: 'company', computerId: null, runtimeAssignmentId: 'assignment' },
        }
        throw new Error('unexpected dependency ' + name)
      },
    })
    return { api: exports, env, settings, timers, advance(ms: number) { now += ms } }
  }
  return { state, replica }
}

test('zero, unavailable and malformed capacity all refuse a new Pod without a Pod apply', async () => {
  for (const failure of ['zero', 'unavailable', 'malformed']) {
    const c = cluster()
    if (failure === 'zero') c.state.cap = 0
    if (failure === 'unavailable') c.state.nodeError = true
    if (failure === 'malformed') c.state.malformedPods = true
    const result = await c.replica().api.ensurePod('agent')
    assert.equal(result.ok, false, failure)
    assert.equal(!result.ok && result.code, 'capacity_denied', failure)
    assert.equal(c.state.manifests.length, 0)
    assert.equal(c.state.locks, c.state.releases)
  }
})

test('threshold and cap updates govern the next admission while cached samples retain raw cluster capacity', async () => {
  const c = cluster()
  c.state.used = 8
  const r = c.replica()
  assert.equal((await r.api.getClusterFuseUtilization()).cap, 40)
  r.settings.pod_admission_max = '10'
  const cached = await r.api.getClusterFuseUtilization()
  assert.equal(cached.cached, true)
  assert.equal(cached.cap, 10)
  assert.equal(cached.ratio, 0.8)
  r.settings.pod_fuse_threshold = '0.8'
  assert.equal((await r.api.ensurePod('denied')).ok, false)
  r.settings.pod_admission_max = '20'
  r.settings.pod_idle_ms = '120000'
  assert.equal((await r.api.ensurePod('allowed')).ok, true)
  assert.match(c.state.manifests[0], /name: CUMORA_AGENT_IDLE_MS\s+value: "120000"/)
  assert.equal(c.state.commands.some(command => command[0] === 'delete'), false)
})

test('independent replicas serialize fresh reads and Pod applies across the last admission slot', async () => {
  const c = cluster()
  c.state.used = 35
  const replicas = [c.replica(), c.replica(), c.replica()]
  await Promise.all(replicas.map(r => r.api.getClusterFuseUtilization()))
  const results = await Promise.all(replicas.map((r, i) => r.api.ensurePod('agent-' + i)))
  assert.equal(results.filter(r => r.created).length, 1)
  assert.equal(results.filter(r => !r.ok && r.code === 'capacity_denied').length, 2)
  assert.equal(c.state.used, 36)
  assert.equal(c.state.maxLeases, 1)
  assert.equal(c.state.locks, 1)
  assert.equal(c.state.releases, 3)
})

test('lowering admission settings leaves in-flight and already-running Pods intact', async () => {
  const c = cluster()
  const r = c.replica()
  c.state.onApply = () => { r.settings.pod_fuse_threshold = '0.01'; r.settings.pod_admission_max = '1' }
  assert.equal((await r.api.ensurePod('in-flight')).ok, true)
  c.state.existingPhase = 'Running'
  c.state.nodeError = true
  assert.equal((await r.api.ensurePod('existing')).ok, true)
  assert.equal(c.state.commands.some(command => command[0] === 'delete'), false)
  assert.equal(c.state.manifests.length, 1)
})

test('invalid placement cleans up only managed Pods without applying despite attempted policy bypass', async () => {
  const c = cluster()
  c.state.denyPlacement = true
  const r = c.replica()
  r.settings.pod_assignment_policy = 'allow'
  const result = await r.api.ensurePod('agent')
  assert.equal(!result.ok && result.code, 'placement_denied')
  assert.equal(c.state.commands.length, 1)
  assert.equal(c.state.commands[0][0], 'delete')
  assert.ok(c.state.commands[0].includes('app=cumora-agent,cumora.agent=agent'))
  assert.ok(c.state.commands[0].includes('--wait=false'))
})

test('monitor consumes changed thresholds and cooldown on subsequent samples', async () => {
  const c = cluster()
  c.state.used = 20
  const r = c.replica()
  await r.api.pollClusterFusePressureOnce()
  r.advance(400000)
  await r.api.pollClusterFusePressureOnce()
  assert.equal(c.state.alerts.length, 0)
  Object.assign(r.settings, { cluster_monitor_ratio_min: '0.4', cluster_monitor_sustained_ms: '100', cluster_monitor_alert_cooldown_ms: '500' })
  await r.api.pollClusterFusePressureOnce()
  r.advance(101)
  await r.api.pollClusterFusePressureOnce()
  assert.equal(c.state.alerts.length, 1)
  r.advance(100)
  await r.api.pollClusterFusePressureOnce()
  assert.equal(c.state.alerts.length, 1)
  r.settings.cluster_monitor_alert_cooldown_ms = '50'
  await r.api.pollClusterFusePressureOnce()
  assert.equal(c.state.alerts.length, 2)
})

test('production Pod GC, monitor and PVC GC register runtime schedules with accurate keys', () => {
  const r = cluster().replica()
  r.api.startCompletedPodGc()
  r.api.startClusterFuseMonitor()
  r.api.startChromeProfilePvcGc({ intervalMs: 0, idleThresholdMs: 100, runtimeSettings: true })
  assert.deepEqual(r.timers.map(t => [t.enabled, t.interval]), [
    ['pod_gc_enabled', 'pod_gc_interval_ms'],
    ['cluster_monitor_enabled', 'cluster_monitor_interval_ms'],
    ['chrome_pvc_gc_enabled', 'chrome_pvc_gc_interval_ms'],
  ])
})

test('main-service run sweeper uses the runtime worker and retains the existing stale-run age policy', async () => {
  const mainSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('index.ts', mainSource, ts.ScriptTarget.Latest, true)
  let call: ts.CallExpression | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'startStaleAgentRunSweeper') call = node
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(call, 'main service starts the shared worker')
  let tick!: () => Promise<void>
  let calls = 0
  let starts = 0
  const messages: string[] = []
  const api: Record<string, any> = {}
  const compiled = ts.transpileModule(readFileSync(new URL('../agents/observability.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(compiled, { exports: api, console: { warn(message: string) { messages.push(message) } }, require(name: string) {
    if (name === '../settings.js') return {
      createOperationsWorker(interval: string, work: () => Promise<void>, opts: { enabledKey: string; immediate: boolean; unref: boolean }) {
        assert.equal(opts.enabledKey, 'agent_run_sweeper_enabled')
        assert.equal(interval, 'agent_run_sweeper_interval_ms')
        assert.equal(opts.immediate, true)
        assert.equal(opts.unref, true)
        tick = work
        return { start(intervalMs?: number) { assert.equal(intervalMs, undefined); starts++ }, stop() {} }
      },
      automationNumber(key: string) { assert.equal(key, 'agent_run_stale_age_ms'); return 600_000 },
    }
    if (name === '../db/pool.js') return { pool: { async query(sql: string, params: unknown[]) {
      calls++
      assert.ok(sql.includes("WHERE status = 'running'"))
      assert.deepEqual(Array.from(params), [600_000], 'retains the ten-minute stale-run threshold')
      return { rows: [{ id: 'run-1' }] }
    } } }
    if (name === './cost.js' || name === 'node:crypto') return {}
    throw new Error('unexpected dependency ' + name)
  } })
  runInNewContext(ts.transpileModule(call.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    startStaleAgentRunSweeper: api.startStaleAgentRunSweeper,
  })
  assert.equal(starts, 1)
  assert.equal(calls, 0)
  await tick()
  assert.equal(calls, 1)
  assert.ok(messages[0].includes('closed 1 stale running agent run(s): run-1'))
})

test('PVC idle retention zero keeps live agents while preserving orphan and departed cleanup', () => {
  const r = cluster().replica()
  const args = {
    pvcs: [{ name: 'live-pvc', agentId: 'live' }, { name: 'gone-pvc', agentId: 'gone' }, { name: 'orphan-pvc', agentId: 'orphan' }],
    agents: new Map([
      ['live', { departedAt: null, lastWakeAt: new Date('2026-01-01') }],
      ['gone', { departedAt: new Date('2026-08-01'), lastWakeAt: null }],
    ]),
    now: new Date('2026-09-01'), idleThresholdMs: 0,
  }
  assert.deepEqual(Array.from(r.api.planIdlePvcGc(args), p => p.pvcName), ['gone-pvc', 'orphan-pvc'])
  assert.deepEqual(Array.from(r.api.planIdlePvcGc({ ...args, idleThresholdMs: 30 * 86400000 }), p => p.pvcName),
    ['live-pvc', 'gone-pvc', 'orphan-pvc'])
})

test('FUSE denial gives actionable plugin guidance and recovers after capacity is advertised', async () => {
  const c = cluster()
  const r = c.replica()
  c.state.cap = 0
  const denied = await r.api.ensurePod('agent')
  assert.match(denied.reason, /generic-device-plugin.note.*kubectl describe nodes/)
  assert.ok(c.state.warnings.some(w => w.includes('FUSE admission denied')))
  c.state.cap = 40
  assert.equal((await r.api.ensurePod('agent')).created, true)
})

test('busy or failed admission lease returns bounded capacity denial and releases the connection', async () => {
  for (const failure of ['busy', 'error']) {
    const c = cluster()
    if (failure === 'busy') c.state.activeLeases = 1
    else c.state.lockError = true
    const result = await c.replica().api.ensurePod('agent')
    assert.equal(!result.ok && result.code, 'capacity_denied')
    assert.equal(c.state.manifests.length, 0)
    assert.equal(c.state.releases, 1)
  }
})

test('unlock failure destroys the session instead of returning a locked connection to the pool', async () => {
  const c = cluster()
  c.state.unlockError = true
  assert.equal((await c.replica().api.ensurePod('agent')).ok, true)
  assert.equal(c.state.destroyed, 1)
  assert.equal(c.state.activeLeases, 0)
})

test('Running and Pending Pods are cleaned up when placement is revoked during health lookup', async () => {
  for (const phase of ['Running', 'Pending']) {
    const c = cluster()
    c.state.existingPhase = phase
    c.state.denyAfterHealth = true
    const result = await c.replica().api.ensurePod('agent')
    assert.equal(!result.ok && result.code, 'placement_denied')
    assert.equal(c.state.existingPhase, '')
    assert.equal(c.state.manifests.length, 0)
    assert.ok(c.state.commands.some(cmd => cmd[0] === 'delete' && cmd.includes('--wait=false')))
  }
})

test('placement lookup failure never deletes a Pod, cleanup failure is explicit', async () => {
  const c = cluster()
  c.state.lookupError = true
  const r = c.replica()
  assert.equal((await r.api.ensurePod('agent')).ok, false)
  assert.equal(c.state.commands.length, 0)
  c.state.lookupError = false
  c.state.denyPlacement = true
  c.state.deleteError = true
  const result = await r.api.ensurePod('agent')
  assert.equal(!result.ok && result.code, 'pod_reap_failed')
  assert.ok(c.state.warnings.some(w => w.includes('placement cleanup failed')))
})

test('terminal Pod reap failure stops apply and a later successful reap allows recreation', async () => {
  for (const phase of ['Succeeded', 'Failed', 'Unknown']) {
    const c = cluster()
    c.state.existingPhase = phase
    c.state.deleteError = true
    const r = c.replica()
    const result = await r.api.ensurePod('agent')
    assert.equal(!result.ok && result.code, 'pod_reap_failed')
    assert.match(result.reason, /Forbidden/)
    assert.equal(c.state.manifests.length, 0)
    assert.ok(c.state.warnings.some(w => w.includes('pod reap failed')))
    c.state.deleteError = false
    assert.equal((await r.api.ensurePod('agent')).created, true)
  }
})

test('Pod URL rewriting is limited to local deployments and respects gateway path boundaries', async () => {
  const c = cluster()
  const cloud = c.replica({ CUMORA_KUBECTL_CONTEXT: 'gke-production' })
  for (const url of ['postgres://user:password@127.0.0.1:5432/db', 'http://localhost:8080', 'http://sub2api:8080', 'redis://redis:6379']) {
    assert.equal(cloud.api.podUrl(url), url)
  }
  const local = c.replica({ CUMORA_KUBECTL_CONTEXT: 'docker-desktop' })
  assert.equal(local.api.podUrl('postgres://db:5432/db'), 'postgres://host.docker.internal:5432/db')
  assert.equal(local.api.podUrl('http://localhost:5181'), 'http://host.docker.internal:5181')
  assert.throws(() => local.api.podUrl('http://sub2api:8080/v1'), /SUB2API_PUBLIC_URL/)
  local.env.SUB2API_INTERNAL_URL = 'http://sub2api:8080'
  local.env.SUB2API_PUBLIC_URL = 'http://localhost:8082'
  assert.equal(local.api.podUrl('http://sub2api:8080/v1?x=1'), 'http://host.docker.internal:8082/v1?x=1')
  local.env.SUB2API_INTERNAL_URL = 'https://gateway.invalid/api'
  local.env.SUB2API_PUBLIC_URL = 'https://public.invalid/base'
  assert.equal(local.api.podUrl('https://gateway.invalid/api2'), 'https://gateway.invalid/api2')
  assert.equal(local.api.podUrl('https://gateway.invalid/api/v1'), 'https://public.invalid/base/v1')
  const disabled = c.replica({ CUMORA_KUBECTL_CONTEXT: 'docker-desktop', CUMORA_POD_HOST_REWRITE: 'false' })
  assert.equal(disabled.api.podUrl('http://localhost:8080'), 'http://localhost:8080')
  const explicit = c.replica({ CUMORA_POD_HOST_REWRITE: 'true' })
  assert.equal(explicit.api.podUrl('redis://redis:6379'), 'redis://host.docker.internal:6379')
  local.env.DATABASE_URL = 'malformed-secret-password'
  const result = await local.api.ensurePod('agent')
  assert.equal(!result.ok && result.code, 'pod_apply_failed')
  assert.doesNotMatch(result.reason, /malformed-secret-password/)
  assert.equal(c.state.manifests.length, 0)
})
