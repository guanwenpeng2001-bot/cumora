import { PaginationError } from '../api/list-pagination.js'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type * as Settings from '../settings.js'

const source = readFileSync(new URL('../settings.ts', import.meta.url), 'utf8')
const routerSource = readFileSync(new URL('../api/router.ts', import.meta.url), 'utf8')
const REVISION = '__settings_revision'
const INHERIT = '__settings_inherit:'
const rowsOf = (values: Map<string, string>) => [...values].map(([key, value]) => ({ key, value }))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(clock?: { now: number; ticks: Array<() => void> }, processEnv: Record<string, string> = {}) {
  let data = new Map<string, string>([['brain_model', 'old'], [REVISION, '0']])
  const statements: string[] = []
  let failKey = ''
  let failSelect = false
  let failCommit = false
  let holdRead: ReturnType<typeof deferred<{ rows: ReturnType<typeof rowsOf> }>> | undefined
  let reads = 0
  let connections = 0
  let releases = 0
  const env = {
    OPENAI_MODEL: 'env-brain', OPENAI_MODEL_SUPPORT: 'env-support', OPENAI_COMPACTION_MODEL: 'env-compact',
    OPENAI_IMAGE_MODEL: 'env-image', OPENAI_AUDIO_MODEL: 'env-audio', OPENAI_EMBED_MODEL: 'env-embed',
  }
  const pool = {
    async query(sql: string) {
      assert.equal(sql, 'SELECT key, value FROM server_settings')
      reads++
      if (failSelect) throw new Error('read failure')
      const held = holdRead
      holdRead = undefined
      return held ? held.promise : { rows: rowsOf(data) }
    },
    async connect() {
      connections++
      let working: Map<string, string> | undefined
      let locked = false
      return {
        async query(sql: string, params: string[] = []) {
          statements.push(sql)
          if (sql === 'BEGIN') working = new Map(data)
          else if (sql === 'LOCK TABLE server_settings IN SHARE ROW EXCLUSIVE MODE') locked = true
          else if (sql === 'ROLLBACK') working = undefined
          else if (sql === 'COMMIT') {
            if (failCommit) throw new Error('commit failure')
            data = new Map(working!)
          } else {
            assert.ok(working && locked, 'all reads and mutations use the locked transaction')
            if (sql.startsWith('DELETE')) working.delete(params[0])
            else if (sql.includes('jsonb_each_text')) {
              for (const [key, value] of Object.entries(JSON.parse(params[0]) as Record<string, string>)) {
                if (!working.has(key) && !working.has(INHERIT + key)) working.set(key, value)
              }
            } else if (sql.startsWith('INSERT')) {
              if (params[0] === failKey) throw new Error('second key failure')
              working.set(params[0], params[0] === REVISION ? String(BigInt(working.get(REVISION) ?? '0') + 1n) : params[1])
            } else if (sql === 'SELECT key, value FROM server_settings') {
              if (failSelect) throw new Error('read failure')
              return { rows: rowsOf(working) }
            } else throw new Error('unexpected SQL: ' + sql)
          }
          return { rows: [] }
        },
        release() { releases++ },
      }
    },
  }
  const exports = {} as typeof Settings
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports,
    require(name: string) {
      if (name === 'node:async_hooks') return { AsyncLocalStorage }
      if (name === './db/pool.js') return { pool }
      if (name === './env.js') return {
        env,
        defaultOpenAIImageModel: () => env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2',
        resolveDirectLlmEnv: () => ({ configured: false, protocol: 'images' }),
      }
      if (name === './sub2api.js') return { validateSub2apiGroupSelection: async () => {}, tierGroups: (tier: string, raw: string) => JSON.parse(raw || '{}')[tier] ?? {} }
      if (name === './managed-pod-settings.js') return { getManagedPodSettings: () => null }
      throw new Error('unexpected dependency: ' + name)
    },
    process: { env: { ...env, ...processEnv } }, console: { warn() {}, error() {} },
    Date: clock ? class extends Date { static now() { return clock.now } } : Date,
    setInterval: (tick: () => void) => { assert.ok(clock); clock.ticks.push(tick); return { unref() {}, tick } },
    clearInterval: (timer: { tick: () => void }) => { assert.ok(clock); const index = clock.ticks.indexOf(timer.tick); if (index >= 0) clock.ticks[index] = () => {} },
  })
  return {
    settings: exports, statements, env,
    get data() { return data }, get reads() { return reads },
    get connections() { return connections }, get releases() { return releases },
    failKey(key: string) { failKey = key }, failRead(value = true) { failSelect = value },
    failCommit(value = true) { failCommit = value },
    holdRead() { holdRead = deferred(); return holdRead },
  }
}

test('second key failure rolls back values and revision; queue recovers and releases clients', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  const before = f.settings.getServerSettingsSnapshot()
  f.failKey('support_model')
  await assert.rejects(f.settings.writeServerSettings({ brain_model: 'new', support_model: 'new-support' }), /second key/)
  assert.equal(f.data.get('brain_model'), 'old')
  assert.equal(f.data.get(REVISION), '0')
  assert.equal(f.settings.getServerSettingsSnapshot(), before)
  assert.ok(f.statements.includes('ROLLBACK'))
  f.failKey('')
  assert.equal((await f.settings.writeServerSettings({ brain_model: 'recovered' })).revision, '1')
  assert.equal(f.connections, f.releases)
})

test('late old SELECT cannot replace a committed complete snapshot; forced refresh is not swallowed', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  const old = rowsOf(f.data)
  const held = f.holdRead()
  const refresh = f.settings.refreshServerSettings(true)
  const forced = f.settings.refreshServerSettings(true)
  const committed = await f.settings.writeServerSettings({ brain_model: 'new', support_model: 'new-support' })
  assert.equal(f.settings.getServerSettingsSnapshot(), committed)
  assert.equal(f.settings.getBrainModel(), 'new')
  held.resolve({ rows: old })
  await Promise.all([refresh, forced])
  assert.equal(f.reads, 3)
  assert.equal(f.settings.getServerSettingsSnapshot().revision, committed.revision)
  assert.equal(f.settings.getSupportModel(), 'new-support')
})

test('DB refresh, transaction read and commit failures preserve the last valid snapshot', async () => {
  const f = fixture()
  const committed = await f.settings.writeServerSettings({ brain_model: 'valid' })
  f.failRead()
  await f.settings.refreshServerSettings(true)
  await assert.rejects(f.settings.writeServerSettings({ brain_model: 'bad' }), /read failure/)
  assert.equal(f.settings.getServerSettingsSnapshot(), committed)
  assert.equal(f.data.get('brain_model'), 'valid')
  f.failRead(false)
  f.failCommit()
  await assert.rejects(f.settings.writeServerSettings({ brain_model: 'bad' }), /commit failure/)
  assert.equal(f.settings.getServerSettingsSnapshot(), committed)
  assert.equal(f.data.get(REVISION), committed.revision)
})

test('inheritance survives main-service seed; read-only boot never writes', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  assert.equal(f.connections, 0)
  const reset = await f.settings.writeServerSettings({ brain_model: null, brain_fallback_models: '' })
  assert.equal(reset.settings.brain_model, 'env-brain')
  assert.equal(reset.sources.brain_model, 'env')
  assert.equal(reset.sources.brain_fallback_models, 'db')
  await f.settings.initServerSettings()
  assert.equal(f.data.has('brain_model'), false)
  assert.equal(f.settings.getBrainModel(), 'env-brain')
  await f.settings.writeServerSettings({ brain_model: 'override' })
  assert.equal(f.data.has(INHERIT + 'brain_model'), false)
  assert.equal(f.settings.getServerSettingsSnapshot().sources.brain_model, 'db')
})

test('required empty values, invalid typed values and internal keys are rejected before DB access', async () => {
  const f = fixture()
  const invalidEntries: Record<string, string | null>[] = [
    { brain_model: '' }, { support_model: '   ' }, { agent_max_output_tokens: '0' },
    { support_reasoning_headroom: '-1' }, { agent_max_output_tokens: '2.5' },
    { agent_reasoning_effort: 'invalid' }, { [REVISION]: '99' }, { [INHERIT + 'brain_model']: 'true' },
  ]
  for (const entries of invalidEntries) await assert.rejects(f.settings.writeServerSettings(entries), f.settings.InvalidServerSettingError)
  f.env.OPENAI_MODEL = ''
  await assert.rejects(f.settings.writeServerSettings({ brain_model: null }), /no inherited value/)
  assert.equal(f.connections, 0)
  await f.settings.writeServerSettings({ agent_reasoning_effort: 'none', support_reasoning_headroom: '0' })
})

test('revision survives reload, retains bigint precision and rejects lower remote revisions', async () => {
  const f = fixture()
  f.data.set(REVISION, '9007199254740993')
  await f.settings.loadServerSettings()
  const next = await f.settings.writeServerSettings({ brain_model: 'latest' })
  assert.equal(next.revision, '9007199254740994')
  f.data.set(REVISION, '1')
  f.data.set('brain_model', 'stale')
  await f.settings.refreshServerSettings(true)
  assert.equal(f.settings.getServerSettingsSnapshot(), next)
  assert.ok(Object.isFrozen(next) && Object.isFrozen(next.settings) && Object.isFrozen(next.sources))
})

type Request = { authUserId?: string; body?: unknown }
type Result = Settings.ServerSettingsSnapshot & { ok?: boolean; error?: string }
type Handler = (req: Request, res: unknown, next: (error: unknown) => void) => Promise<void>

// Evaluate the actual settings handlers and auth/error helpers without importing
// unrelated router services (Redis, background workers or model clients).
function routes(f: ReturnType<typeof fixture>) {
  const ast = ts.createSourceFile('router.ts', routerSource, ts.ScriptTarget.Latest, true)
  const helpers = new Set(['HttpError', 'requireAuth', 'requireSiteAdmin', 'safe'])
  const selected = ast.statements.filter((node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return helpers.has(node.name.text)
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false
    const first = node.expression.arguments[0]
    return first && ts.isStringLiteral(first) && first.text === '/settings/models'
  }).map((node) => node.getText(ast)).join('\n')
  assert.equal(selected.includes("api.put('/settings/models'"), true)
  const handlers = new Map<string, Handler>()
  let admin = true
  let invalidations = 0
  runInNewContext(ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    ...f.settings, PaginationError,
    api: {
      get(path: string, handler: Handler) { handlers.set('GET ' + path, handler) },
      put(path: string, handler: Handler) { handlers.set('PUT ' + path, handler) },
    },
    pool: { async query(sql: string) {
      assert.equal(sql, 'SELECT is_admin FROM users WHERE id = $1')
      return { rows: [{ is_admin: admin }] }
    } },
    invalidateModelCatalog() { invalidations++ },
    console: { error() {} },
  })
  return {
    setAdmin(value: boolean) { admin = value },
    get invalidations() { return invalidations },
    async request(method: string, body?: unknown, authUserId: string | undefined = 'user') {
      let status = 200
      let result!: Result
      const res = { status(code: number) { status = code; return res }, json(value: Result) { result = value } }
      await handlers.get(method + ' /settings/models')!({ authUserId, body }, res, (error) => { throw error })
      return { status, body: result }
    },
  }
}

test('concurrent PUTs publish increasing complete revisions; immediate GET matches each commit', async () => {
  const f = fixture()
  const api = routes(f)
  const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => api.request('PUT', {
    settings: { brain_model: 'brain-' + i, support_model: 'support-' + i },
  })))
  replies.forEach((reply, i) => {
    assert.equal(reply.status, 200)
    assert.equal(reply.body.ok, true)
    assert.equal(reply.body.revision, String(i + 1))
    assert.equal(reply.body.settings.brain_model, 'brain-' + i)
    assert.equal(reply.body.settings.support_model, 'support-' + i)
  })
  assert.equal(f.settings.getServerSettingsSnapshot().revision, '12')
  const last = await api.request('PUT', { settings: { brain_model: 'read-after-write' } })
  const read = await api.request('GET')
  assert.equal(read.body.revision, last.body.revision)
  assert.equal(read.body.settings, last.body.settings)
  assert.equal(f.settings.getBrainModel(), 'read-after-write')
  assert.equal(api.invalidations, 13)
})

test('settings endpoints keep site-admin authorization and distinguish null from illegal empty values', async () => {
  const f = fixture()
  const api = routes(f)
  api.setAdmin(false)
  assert.equal((await api.request('PUT', { settings: { brain_model: 'denied' } })).status, 403)
  assert.equal((await api.request('GET')).status, 403)
  assert.equal((await api.request('PUT', { settings: {} }, '')).status, 401)
  assert.equal(f.connections, 0)
  api.setAdmin(true)
  for (const settings of [[], { brain_model: '' }, { brain_model: 4 }, { unknown: 'value' }]) {
    assert.equal((await api.request('PUT', { settings })).status, 400)
  }
  assert.equal(f.connections, 0)
  const reset = await api.request('PUT', { settings: { brain_model: null } })
  assert.equal(reset.body.settings.brain_model, 'env-brain')
  assert.equal(reset.body.sources.brain_model, 'env')
  assert.equal(reset.body.ok, true)
  assert.equal(reset.body.sources.compaction_soft_ratio, 'default')
  const override = await api.request('PUT', { settings: { idle_interval_ms: '900000' } })
  assert.equal(override.body.sources.idle_interval_ms, 'db')
  assert.equal((await api.request('GET')).body.sources.idle_interval_ms, 'db')
})

test('failed initial read serves a complete env snapshot without seeding', async () => {
  const f = fixture()
  f.failRead()
  await f.settings.loadServerSettings()
  const current = f.settings.getServerSettingsSnapshot()
  assert.equal(current.revision, '0')
  assert.equal(current.settings.brain_model, 'env-brain')
  assert.equal(current.settings.support_model, 'env-support')
  assert.equal(current.sources.brain_model, 'env')
  assert.equal(f.connections, 0)
})

test('failed PUT returns no success, does not invalidate catalog, and leaves GET at the old revision', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  const api = routes(f)
  const before = await api.request('GET')
  f.failKey('support_model')
  await assert.rejects(api.request('PUT', { settings: { brain_model: 'partial', support_model: 'failed' } }), /second key/)
  const after = await api.request('GET')
  assert.equal(after.body, before.body)
  assert.equal(api.invalidations, 0)
})


test('turn budget defaults retain existing limits and expose managed next-turn scope', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  const policy = f.settings.getTurnBudgetPolicy()
  assert.deepEqual(JSON.parse(JSON.stringify(policy)), {
    autoEnabled: true, softRatio: 0.75, hardRatio: 0.95, outputBytes: 600,
    keepRecentPairs: 2, strategy: 'summary', summaryMaxChars: 4000, maxHops: 200, timeoutMs: 0,
    streamIdleTimeoutMs: 240000, streamWallTimeoutMs: 360000, revision: '0',
  })
  assert.ok(Object.isFrozen(policy))
  const def = f.settings.SETTING_DEFS.find(d => d.key === 'agent_turn_timeout_ms')!
  assert.equal(def.scope, 'managed')
  assert.equal(def.effect, 'next-turn')
  assert.match(def.description!, /BYOA.*local CUMORA_TURN_TIMEOUT_MS/)
  await f.settings.writeServerSettings({ auto_compaction_enabled: 'false', compaction_output_bytes: '321',
    compaction_keep_recent_pairs: '0', compaction_strategy: 'drop-and-marker', compaction_summary_max_chars: '250',
    agent_max_hops: '9', agent_turn_timeout_ms: '1000', compaction_soft_ratio: '0.6', compaction_hard_ratio: '0.8' })
  assert.equal(policy.maxHops, 200, 'already captured turn policy cannot change')
  const next = f.settings.getTurnBudgetPolicy()
  assert.deepEqual(JSON.parse(JSON.stringify(next)), {
    autoEnabled: false, softRatio: 0.6, hardRatio: 0.8, outputBytes: 321,
    keepRecentPairs: 0, strategy: 'drop-and-marker', summaryMaxChars: 250, maxHops: 9, timeoutMs: 1000,
    streamIdleTimeoutMs: 240000, streamWallTimeoutMs: 360000, revision: '1',
  })
  await f.settings.writeServerSettings({ agent_max_hops: null, agent_turn_timeout_ms: null })
  assert.equal(f.settings.getTurnBudgetPolicy().maxHops, 200)
  assert.equal(f.settings.getTurnBudgetPolicy().timeoutMs, 0)
})

test('turn budget rejects invalid values and validates partial ratio updates in the locked transaction', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  for (const [key, value] of [
    ['auto_compaction_enabled', '0'], ['compaction_strategy', 'anything'], ['compaction_soft_ratio', '0'],
    ['compaction_hard_ratio', '1'], ['compaction_soft_ratio', 'NaN'], ['compaction_output_bytes', '0'],
    ['compaction_summary_max_chars', '-1'], ['compaction_keep_recent_pairs', '1.5'],
    ['agent_max_hops', '0'], ['agent_turn_timeout_ms', '2147483648'],
    ['agent_stream_idle_timeout_ms', '0'], ['agent_stream_wall_timeout_ms', '0'],
  ]) await assert.rejects(f.settings.writeServerSettings({ [key]: value }))
  assert.equal(f.connections, 0)
  await f.settings.writeServerSettings({ compaction_soft_ratio: '0.85', compaction_hard_ratio: '0.9' })
  const before = f.settings.getServerSettingsSnapshot()
  await assert.rejects(f.settings.writeServerSettings({ compaction_hard_ratio: '0.8', agent_max_hops: '3' }), /soft < hard/)
  assert.equal(f.settings.getServerSettingsSnapshot(), before)
  assert.equal(f.data.has('agent_max_hops'), false)
  await f.settings.writeServerSettings({ compaction_hard_ratio: '0.99', compaction_soft_ratio: '0.97' })
  await assert.rejects(f.settings.writeServerSettings({ compaction_hard_ratio: null }), /soft < hard/)
  await assert.rejects(f.settings.writeServerSettings({
    agent_stream_idle_timeout_ms: '400000', agent_stream_wall_timeout_ms: '360000',
  }), /idle <= wall/)
  await assert.rejects(f.settings.writeServerSettings({ stall_min_ms: '400000', stall_max_ms: '300000' }), /min <= max/)
})

test('invalid stored ratio ordering produces a diagnostic and a valid fallback pair', async () => {
  const f = fixture()
  f.data.set('compaction_soft_ratio', '0.98')
  f.data.set('compaction_hard_ratio', '0.8')
  await f.settings.loadServerSettings()
  assert.equal(f.settings.getTurnBudgetPolicy().softRatio, 0.75)
  assert.equal(f.settings.getTurnBudgetPolicy().hardRatio, 0.95)
  assert.ok(f.settings.getServerSettingsSnapshot().diagnostics?.includes('invalid-setting:compaction-ratios'))
})


test('turn definitions publish all nine defaults alongside automation and cerebellum settings', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  const defaults: Record<string, string> = {
    auto_compaction_enabled: 'true', compaction_soft_ratio: '0.75', compaction_hard_ratio: '0.95',
    compaction_output_bytes: '600', compaction_keep_recent_pairs: '2', compaction_strategy: 'summary',
    compaction_summary_max_chars: '4000', agent_max_hops: '200', agent_turn_timeout_ms: '0',
    agent_stream_idle_timeout_ms: '240000', agent_stream_wall_timeout_ms: '360000',
  }
  const snapshot = f.settings.getServerSettingsSnapshot()
  for (const [key, value] of Object.entries(defaults)) {
    const defs = snapshot.definitions!.filter(def => def.key === key)
    assert.equal(defs.length, 1, key)
    assert.equal(defs[0].defaultValue, value, key)
    assert.equal(defs[0].scope, 'managed', key)
    assert.equal(defs[0].effect, 'next-turn', key)
    assert.equal(defs[0].pod, true, key)
    assert.equal(snapshot.settings[key], value, key)
    assert.equal(snapshot.sources[key], 'default', key)
  }
  const otherKeys = [
    'idle_enabled', 'idle_interval_ms', 'idle_min_quiet_min', 'agenda_gate_enabled', 'agenda_error_mode',
    'scanner_enabled', 'scanner_interval_ms', 'scanner_min_messages', 'scanner_window_hours',
    'steer_enabled', 'byoa_group_steer_enabled', 'byoa_group_steer_interval_ms',
    'synthetic_gate_enabled', 'synthetic_gate_failure_mode', 'inbox_triage_failure_mode', 'triage_rate_limit_mode',
    'cloud_inbox_triage_timeout_ms', 'synthetic_gate_timeout_ms', 'byoa_triage_timeout_ms',
    'triage_backoff_base_ms', 'triage_backoff_max_ms', 'support_inbox_triage_output_tokens',
    'support_synthetic_gate_output_tokens', 'low_priority_wake_budget_per_minute', 'agent_turn_rate_per_minute',
    'stall_min_ms', 'stall_max_ms', 'nudge_cooldown_ms', 'nudge_cooldown_fallback_ms',
  ]
  for (const key of otherKeys) assert.equal(snapshot.definitions!.filter(def => def.key === key).length, 1, key)
  await f.settings.writeServerSettings({ agent_max_hops: '12', idle_enabled: 'false', support_inbox_triage_output_tokens: '2500' })
  assert.equal(f.settings.getTurnBudgetPolicy().maxHops, 12)
  assert.equal(f.settings.getServerSetting('idle_enabled'), 'false')
  assert.equal(f.settings.getServerSetting('support_inbox_triage_output_tokens'), '2500')
  await f.settings.writeServerSettings(Object.fromEntries(Object.keys(defaults).map(key => [key, null])))
  const inherited = f.settings.getServerSettingsSnapshot()
  for (const [key, value] of Object.entries(defaults)) {
    assert.equal(inherited.settings[key], value, key)
    assert.equal(inherited.sources[key], 'default', key)
  }
  assert.equal(inherited.settings.idle_enabled, 'false')
  assert.equal(inherited.settings.support_inbox_triage_output_tokens, '2500')
})

test('Pod domain preserves defaults, fixed safety floors, and actual application boundaries', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  const expected = {
    pod_admission_enabled: 'true', pod_admission_max: '40', pod_fuse_threshold: '0.90',
    pod_capacity_unknown_mode: 'closed', pod_assignment_policy: 'deny', pod_gc_enabled: 'true',
    chrome_pvc_gc_enabled: 'true', cluster_monitor_enabled: 'true', agent_run_sweeper_enabled: 'true',
    cluster_monitor_pending_min: '20', cluster_monitor_ratio_min: '0.95',
    cluster_monitor_sustained_ms: '300000', cluster_monitor_alert_cooldown_ms: '1800000',
  }
  const snapshot = f.settings.getServerSettingsSnapshot()
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(snapshot.settings[key], value, key)
    assert.equal(snapshot.definitions!.filter(def => def.key === key).length, 1, key)
  }
  for (const [key, value] of Object.entries({ pod_admission_enabled: 'false', pod_capacity_unknown_mode: 'open', pod_assignment_policy: 'allow' })) {
    await assert.rejects(f.settings.writeServerSettings({ [key]: value }), /read-only/)
    await assert.rejects(f.settings.writeServerSettings({ [key]: null }), /read-only/)
    f.data.set(key, value)
  }
  await f.settings.loadServerSettings()
  for (const key of ['pod_admission_enabled', 'pod_capacity_unknown_mode', 'pod_assignment_policy']) {
    assert.equal(f.settings.getServerSetting(key), expected[key as keyof typeof expected])
    assert.ok(f.settings.getServerSettingsSnapshot().diagnostics!.includes(`invalid-setting:${key}`))
  }
  for (const [key, effect] of [
    ['pod_admission_max', 'next-admission'], ['pod_idle_ms', 'next-create'],
    ['pod_no_work_ms', 'next-create'], ['wake_fanout_concurrency', 'restart'],
    ['kubectl_max_concurrency', 'restart'], ['chrome_pvc_size', 'restart-next-create'],
    ['chrome_pvc_storage_class', 'restart-next-create'],
  ]) assert.equal(snapshot.definitions!.find(def => def.key === key)!.effect, effect)
  await assert.rejects(f.settings.writeServerSettings({ wake_fanout_concurrency: '10' }), /read-only/)
  f.data.set('wake_fanout_concurrency', '999')
  await f.settings.loadServerSettings()
  assert.equal(f.settings.getServerSetting('wake_fanout_concurrency'), '6')
  assert.equal(f.settings.getServerSettingsSnapshot().sources.wake_fanout_concurrency, 'default')
  assert.ok(f.settings.getServerSettingsSnapshot().diagnostics!.includes('ignored-db-setting:wake_fanout_concurrency'))
})

test('Pod tunables validate new input, retain valid writes and support inheritance', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  for (const [key, value] of [
    ['pod_admission_max', '-1'], ['pod_admission_max', '1.5'], ['pod_fuse_threshold', '0'],
    ['pod_fuse_threshold', '1'], ['pod_fuse_threshold', 'NaN'], ['cluster_monitor_ratio_min', 'Infinity'],
    ['cluster_monitor_pending_min', '0'], ['cluster_monitor_sustained_ms', '-1'],
    ['pod_gc_interval_ms', '2147483648'], ['agent_run_sweeper_enabled', '0'],
  ]) await assert.rejects(f.settings.writeServerSettings({ [key]: value }))
  assert.equal(f.connections, 0)
  await f.settings.writeServerSettings({ pod_admission_max: '10', pod_fuse_threshold: '0.8', cluster_monitor_pending_min: '5', pod_gc_interval_ms: '0' })
  assert.equal(f.settings.getServerSetting('pod_admission_max'), '10')
  assert.equal(f.settings.getServerSetting('pod_fuse_threshold'), '0.8')
  assert.equal(f.settings.getServerSetting('pod_gc_interval_ms'), '0')
  await f.settings.writeServerSettings({ pod_admission_max: null, pod_gc_interval_ms: null })
  assert.equal(f.settings.getServerSetting('pod_admission_max'), '40')
  assert.equal(f.settings.getServerSetting('pod_gc_interval_ms'), '60000')
})

test('agenda heartbeat defaults to five minutes and preserves env and runtime overrides', async () => {
  for (const [processEnv, expected] of [
    [{}, '300000'], [{ IDLE_INTERVAL_MS: '60000' }, '60000'],
    [{ IDLE_INTERVAL_MS: '0' }, '0'], [{ IDLE_INTERVAL_MS: 'invalid' }, '300000'],
  ] as Array<[Record<string, string>, string]>) {
    const f = fixture(undefined, processEnv)
    await f.settings.loadServerSettings()
    assert.equal(f.settings.getServerSetting('idle_interval_ms'), expected)
    const def = f.settings.SETTING_DEFS.find(d => d.key === 'idle_interval_ms')!
    assert.equal(def.defaultValue, '300000')
    assert.equal(def.scope, 'server')
    assert.equal(def.effect, 'next-tick')
    assert.match(def.description!, /Agenda.*5 minutes/)
    await f.settings.writeServerSettings({ idle_interval_ms: '600000' })
    assert.equal(f.settings.automationNumber('idle_interval_ms'), 600000)
    await f.settings.writeServerSettings({ idle_interval_ms: null })
    assert.equal(f.settings.getServerSetting('idle_interval_ms'), expected)
    for (const value of ['-1', '1.5', '2147483648']) {
      assert.throws(() => f.settings.validateServerSettings({ idle_interval_ms: value }))
    }
  }
})

test('agenda heartbeat waits five minutes, reschedules live and pauses without overlapping active work', async () => {
  const clock = { now: 0, ticks: [] as Array<() => void> }
  const f = fixture(clock)
  await f.settings.loadServerSettings()
  const held = deferred<void>()
  let runs = 0
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  f.settings.startAutomationTimer('idle_enabled', 'idle_interval_ms', async () => {
    runs++
    if (runs === 1) await held.promise
  })
  for (const now of [60000, 299999]) {
    clock.now = now
    clock.ticks[0]()
    await flush()
    assert.equal(runs, 0)
  }
  clock.now = 300000
  clock.ticks[0]()
  await flush()
  assert.equal(runs, 1)
  await f.settings.writeServerSettings({ idle_interval_ms: '600000' })
  clock.ticks[0]()
  clock.now = 900000
  clock.ticks[0]()
  await flush()
  assert.equal(runs, 1)
  held.resolve()
  await flush()
  clock.ticks[0]()
  await flush()
  assert.equal(runs, 2)
  for (const pause of [{ idle_interval_ms: '0' }, { idle_enabled: 'false', idle_interval_ms: '300000' }] as Array<Record<string, string>>) {
    await f.settings.writeServerSettings(pause)
    clock.ticks[0]()
    clock.now += 1000000
    clock.ticks[0]()
    await flush()
    assert.equal(runs, 2)
  }
  await f.settings.writeServerSettings({ idle_enabled: 'true', idle_interval_ms: null })
  clock.ticks[0]()
  clock.now += 299999
  clock.ticks[0]()
  await flush()
  assert.equal(runs, 2)
  clock.now++
  clock.ticks[0]()
  await flush()
  assert.equal(runs, 3)
})

test('Pod worker timer disables, re-enables and reschedules without cancelling or overlapping an in-flight tick', async () => {
  const clock = { now: 1000, ticks: [] as Array<() => void> }
  const f = fixture(clock)
  await f.settings.loadServerSettings()
  const held = deferred<void>()
  let runs = 0
  let finished = 0
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  f.settings.startAutomationTimer('pod_gc_enabled', 'pod_gc_interval_ms', async () => {
    runs++
    if (runs === 1) await held.promise
    finished++
  }, { immediate: true, unref: true })
  clock.ticks[0]()
  await flush()
  assert.equal(runs, 1)
  await f.settings.writeServerSettings({ pod_gc_enabled: 'false' })
  clock.now += 1000
  clock.ticks[0]()
  assert.equal(finished, 0)
  await f.settings.writeServerSettings({ pod_gc_enabled: 'true', pod_gc_interval_ms: '500' })
  clock.ticks[0]()
  clock.now += 1000
  clock.ticks[0]()
  await flush()
  assert.equal(runs, 1)
  held.resolve()
  await flush()
  assert.equal(finished, 1)
  clock.ticks[0]()
  await flush()
  assert.equal(runs, 2)
  await f.settings.writeServerSettings({ pod_gc_interval_ms: '0' })
  clock.ticks[0]()
  clock.now += 1000
  clock.ticks[0]()
  await flush()
  assert.equal(runs, 2)
  await f.settings.writeServerSettings({ pod_gc_interval_ms: '1000' })
  clock.ticks[0]()
  clock.now += 999
  clock.ticks[0]()
  await flush()
  assert.equal(runs, 2)
  clock.now++
  clock.ticks[0]()
  await flush()
  assert.equal(runs, 3)
})


test('operations settings preserve defaults, validate bounds and allow inheritance', async () => {
  const f = fixture()
  f.data.set('workspace_runtime_cleanup_enabled', 'false')
  await f.settings.loadServerSettings()
  const defaults: Record<string, string> = {
    email_retry_interval_ms: '60000', email_gc_interval_ms: '86400000', db_gc_interval_ms: '300000',
    workspace_cleanup_interval_ms: '60000',
    poll_sweep_interval_ms: '60000', llm_rollup_interval_ms: '120000',
    chrome_pvc_gc_interval_ms: '3600000', chrome_pvc_gc_idle_days: '30',
    db_gc_batch: '10000', db_gc_ws_tickets_days: '1', db_gc_agent_log_days: '30',
    db_gc_agent_events_days: '30', db_gc_agent_runs_days: '30', db_gc_llm_calls_days: '90',
    workspace_cleanup_batch: '8', workspace_cleanup_retention_days: '7', llm_rollup_retention_hours: '2280',
    agent_run_stale_age_ms: '600000',
  }
  for (const [key, value] of Object.entries(defaults)) {
    assert.equal(f.settings.getServerSetting(key), value, key)
    assert.equal(f.settings.getServerSettingsSnapshot().definitions!.filter(def => def.key === key).length, 1)
  }
  for (const [key, value] of Object.entries({ email_retry_interval_ms: '-1', db_gc_batch: '0',
    workspace_cleanup_batch: '33', db_gc_llm_calls_days: '1.5', llm_rollup_interval_ms: '2147483648',
    llm_rollup_retention_hours: '-1' })) {
    await assert.rejects(f.settings.writeServerSettings({ [key]: value }))
  }
  await f.settings.writeServerSettings({ db_gc_llm_calls_days: '0', llm_rollup_interval_ms: '0', workspace_cleanup_interval_ms: '0' })
  assert.equal(f.settings.automationNumber('db_gc_llm_calls_days'), 0)
  assert.equal(f.settings.automationNumber('llm_rollup_interval_ms'), 0)
  assert.equal(f.settings.automationNumber('workspace_cleanup_interval_ms'), 0)
  assert.ok(!f.settings.getServerSettingsSnapshot().definitions!.some(def => def.key === 'workspace_runtime_cleanup_enabled'))
  await assert.rejects(f.settings.writeServerSettings({ workspace_runtime_cleanup_enabled: 'true' }))
  assert.equal(f.data.get('workspace_runtime_cleanup_enabled'), 'false', 'legacy DB row is preserved without migration')
  await f.settings.writeServerSettings(Object.fromEntries(Object.keys(defaults).map(key => [key, null])))
  for (const [key, value] of Object.entries(defaults)) assert.equal(f.settings.getServerSetting(key), value)
})

test('DB worker pause, resume, interval change and stop/start cannot overlap a held transaction', async () => {
  const clock = { now: 0, ticks: [] as Array<() => void> }
  const f = fixture(clock)
  await f.settings.loadServerSettings()
  await f.settings.writeServerSettings({ db_gc_interval_ms: '1000', db_gc_agent_log_days: '0',
    db_gc_agent_events_days: '0', db_gc_agent_runs_days: '0', db_gc_llm_calls_days: '0' })
  const held = deferred<void>()
  let connections = 0, active = 0, peak = 0
  const days: number[] = []
  const api: Record<string, any> = {}
  const js = ts.transpileModule(readFileSync(new URL('../db-gc.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(js, { exports: api, console: { log() {}, error() {} }, require(name: string) {
    if (name === './settings.js') return f.settings
    if (name === './metrics.js') return { inc() {} }
    assert.equal(name, './db/pool.js')
    return { pool: { async connect() {
      connections++; active++; peak = Math.max(peak, active)
      const first = connections === 1
      return { release() { active-- }, async query(sql: string, params: number[] = []) {
        if (first && sql === 'BEGIN') await held.promise
        if (sql.startsWith('SELECT')) days.push(params[0])
        return { rows: [], rowCount: 0 }
      } }
    } } }
  } })
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  const tick = async (advance = 0) => { clock.now += advance; for (const work of [...clock.ticks]) work(); await flush() }
  api.startDbGcWorker(); api.startDbGcWorker()
  assert.equal(clock.ticks.length, 1, 'start is idempotent')
  await tick(1000)
  assert.equal(connections, 1)
  await f.settings.writeServerSettings({ db_gc_interval_ms: '0', db_gc_ws_tickets_days: '5' })
  await tick(5000)
  await f.settings.writeServerSettings({ db_gc_interval_ms: '200' })
  await tick(); await tick(500)
  api.stopDbGcWorker(); api.startDbGcWorker()
  await tick(500)
  assert.equal(connections, 1)
  held.resolve(); await flush()
  assert.deepEqual(days, [1], 'in-flight tick retains its settings snapshot')
  await tick()
  assert.equal(connections, 2)
  assert.deepEqual(days, [1, 5], 'next tick applies retention changes')
  assert.equal(peak, 1)
  await f.settings.writeServerSettings({ db_gc_interval_ms: '1000' })
  await tick(); await tick(999)
  assert.equal(connections, 2)
  await tick(1)
  assert.equal(connections, 3)
  api.stopDbGcWorker(); await tick(5000)
  assert.equal(connections, 3)
})

test('operations worker starts disabled, gates nudges, and recovers after failure', async () => {
  const clock = { now: 0, ticks: [] as Array<() => void> }
  const f = fixture(clock)
  await f.settings.loadServerSettings()
  await f.settings.writeServerSettings({ workspace_cleanup_interval_ms: '0' })
  let runs = 0
  const worker = f.settings.createOperationsWorker('workspace_cleanup_interval_ms', async () => {
    runs++
    if (runs === 1) throw new Error('injected failure')
  }, { immediate: true, unref: true })
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  worker.start(); worker.nudge(); await flush()
  assert.equal(runs, 0)
  await f.settings.writeServerSettings({ workspace_cleanup_interval_ms: '500' })
  clock.ticks[0](); clock.now = 499; clock.ticks[0](); await flush()
  assert.equal(runs, 0)
  clock.now = 500; clock.ticks[0](); await flush()
  assert.equal(runs, 1)
  worker.nudge(); await flush()
  assert.equal(runs, 2)
  worker.stop(); worker.nudge(); clock.now = 5000; clock.ticks[0](); await flush()
  assert.equal(runs, 2)
})


test('workspace cleanup uses configured batch and retention with mandatory runtime cleanup', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  const calls: { sql: string; params: unknown[] }[] = []
  const runtimeCalls: string[] = []
  const api: Record<string, any> = {}
  const js = ts.transpileModule(readFileSync(new URL('../workspace-cleanup.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const dependencies: Record<string, unknown> = {
    './settings.js': f.settings,
    'node:crypto': { randomUUID: () => 'test-worker' },
    './storage.js': { storage: {}, normalizeStorageKey: (key: string) => key },
    './agents/runtime/orchestrator.js': {
      async deletePod(agentId: string) { runtimeCalls.push(`pod:${agentId}`) },
      async deleteChromeProfilePvc(agentId: string, options: { waitForDeletion?: boolean }) {
        assert.equal(options.waitForDeletion, true)
        runtimeCalls.push(`pvc:${agentId}`)
      },
    },
    './db/pool.js': { pool: { async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      if (sql.includes('UPDATE workspace_cleanup_jobs j')) return { rows: [{ id: 'job', agent_ids: ['agent'], storage_keys: [] }] }
      return { rows: [] }
    } } },
  }
  runInNewContext(js, { exports: api, process: { pid: 1 }, require(name: string) {
    if (name.includes('documents/')) return {}
    assert.ok(name in dependencies, `unexpected dependency ${name}`)
    return dependencies[name]
  } })
  await f.settings.writeServerSettings({ workspace_cleanup_retention_days: '0', workspace_cleanup_batch: '3' })
  assert.equal((await api.drainWorkspaceCleanupJobs()).completed, 1)
  assert.deepEqual(runtimeCalls, ['pod:agent', 'pvc:agent'])
  assert.ok(!calls.some(c => c.sql.startsWith('DELETE')))
  const claim = calls.find(c => c.sql.includes('SKIP LOCKED'))!
  assert.ok(claim)
  assert.ok(claim.params.includes(3))
  calls.length = 0
  await f.settings.writeServerSettings({ workspace_cleanup_retention_days: '14' })
  await api.drainWorkspaceCleanupJobs()
  assert.deepEqual(Array.from(calls.find(c => c.sql.startsWith('DELETE'))!.params), [14])
})

test('stale-run expiry is disabled by zero and retains running-only scope and default age', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  const calls: { sql: string; params: unknown[] }[] = []
  const api: Record<string, any> = {}
  const js = ts.transpileModule(readFileSync(new URL('../agents/observability.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(js, { exports: api, require(name: string) {
    if (name === '../settings.js') return f.settings
    if (name === '../db/pool.js') return { pool: { async query(sql: string, params: unknown[]) { calls.push({ sql, params }); return { rows: [] } } } }
    if (name === './cost.js' || name === 'node:crypto') return {}
    throw new Error('unexpected dependency: ' + name)
  } })
  await f.settings.writeServerSettings({ agent_run_stale_age_ms: '0' })
  await api.markStaleAgentRuns()
  assert.equal(calls.length, 0)
  await f.settings.writeServerSettings({ agent_run_stale_age_ms: null })
  await api.markStaleAgentRuns()
  assert.deepEqual(Array.from(calls[0].params), [600_000])
  assert.ok(calls[0].sql.includes("WHERE status = 'running'"))
})

test('BYOA policy has a versioned allowlist and preserves BYOA backoff defaults', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  const initial = f.settings.getByoaRuntimePolicyValues()
  assert.equal(initial.values.bigBrainConcurrency, 6)
  assert.equal(initial.values.triageConcurrency, 8)
  assert.equal(initial.values.triageBackoffMaxMs, 600_000)
  const saved = await f.settings.writeServerSettings({ byoa_big_brain_concurrency: '2', byoa_spawn_interval_ms: '1000', byoa_group_steer_enabled: 'false', byoa_triage_timeout_ms: '7000' })
  const next = f.settings.getByoaRuntimePolicyValues()
  assert.equal(next.revision, saved.revision)
  assert.equal(next.values.bigBrainConcurrency, 2)
  assert.equal(next.values.spawnIntervalMs, 1000)
  assert.equal(next.values.groupSteerEnabled, false)
  assert.equal(next.values.triageTimeoutMs, 7000)
  assert.equal(Object.keys(next.values).length, 8)
  for (const def of f.settings.SETTING_DEFS.filter(d => d.scope === 'byoa')) assert.equal(def.effect, 'next-gate')
})

test('BYOA rejects invalid concurrency/pacing/backoff and restores inheritance', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  for (const entries of [{ byoa_big_brain_concurrency: '0' }, { byoa_triage_concurrency: '1.5' }, { byoa_spawn_interval_ms: '-1' }, { byoa_triage_timeout_ms: '0' }, { byoa_triage_backoff_base_ms: '600001' }] as Array<Record<string, string>>) {
    await assert.rejects(f.settings.writeServerSettings(entries))
  }
  await f.settings.writeServerSettings({ byoa_triage_backoff_base_ms: '700000', byoa_triage_backoff_max_ms: '800000', byoa_big_brain_concurrency: '1' })
  assert.equal(f.settings.getByoaRuntimePolicyValues().values.triageBackoffBaseMs, 700000)
  await f.settings.writeServerSettings({ byoa_big_brain_concurrency: null })
  assert.equal(f.settings.getByoaRuntimePolicyValues().values.bigBrainConcurrency, 6)
})

test('invalid stored BYOA backoff emits diagnostics and retains the original safe defaults', async () => {
  const f = fixture()
  f.data.set('byoa_triage_backoff_base_ms', '700000')
  f.data.set('byoa_triage_backoff_max_ms', '600000')
  await f.settings.loadServerSettings()
  assert.equal(f.settings.getByoaRuntimePolicyValues().values.triageBackoffBaseMs, 30000)
  assert.equal(f.settings.getByoaRuntimePolicyValues().values.triageBackoffMaxMs, 600000)
  assert.ok(f.settings.getServerSettingsSnapshot().diagnostics?.some(d => d.includes('byoa_triage_backoff')))
})


test('setting sources distinguish explicit env at default value, DB, inheritance and invalid fallback', async () => {
  const f = fixture(undefined, { IDLE_INTERVAL_MS: '900000', DB_GC_BATCH: 'invalid' })
  await f.settings.loadServerSettings()
  let snapshot = f.settings.getServerSettingsSnapshot()
  assert.equal(snapshot.sources.idle_interval_ms, 'env')
  assert.equal(snapshot.sources.scanner_interval_ms, 'default')
  assert.equal(snapshot.sources.db_gc_batch, 'default')
  assert.ok(snapshot.diagnostics?.includes('invalid-env-setting:db_gc_batch'))
  await f.settings.writeServerSettings({ idle_interval_ms: '900000', scanner_interval_ms: '90000' })
  snapshot = f.settings.getServerSettingsSnapshot()
  assert.equal(snapshot.sources.idle_interval_ms, 'db')
  assert.equal(snapshot.sources.scanner_interval_ms, 'db')
  await f.settings.writeServerSettings({ idle_interval_ms: null, scanner_interval_ms: null })
  snapshot = f.settings.getServerSettingsSnapshot()
  assert.equal(snapshot.sources.idle_interval_ms, 'env')
  assert.equal(snapshot.sources.scanner_interval_ms, 'default')
  f.data.set('compaction_soft_ratio', '0.98')
  f.data.set('compaction_hard_ratio', '0.8')
  await f.settings.loadServerSettings()
  assert.equal(f.settings.getServerSettingsSnapshot().sources.compaction_soft_ratio, 'default')
  assert.equal(f.settings.getServerSettingsSnapshot().sources.compaction_hard_ratio, 'default')
  assert.ok(routerSource.includes('res.json(getServerSettingsSnapshot())'))
})

test('auxiliary stream deadline is validated, revisioned, resettable and fixed within a turn', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  const key = 'compaction_stream_timeout_ms'
  const def = f.settings.SETTING_DEFS.find(d => d.key === key)!
  assert.equal(def.type, 'integer')
  assert.equal(def.pod, true)
  assert.equal(def.scope, 'managed')
  assert.equal(def.effect, 'next-turn')
  assert.equal(def.unit, 'milliseconds')
  assert.equal(f.settings.getServerSetting(key), '30000')
  for (const value of ['0', '-1', '1.5', 'NaN', '2147483648']) {
    await assert.rejects(f.settings.writeServerSettings({ [key]: value }))
  }
  for (const value of ['1', '2147483647', '45000']) {
    await f.settings.writeServerSettings({ [key]: value })
    assert.equal(f.settings.getServerSetting(key), value)
  }
  await f.settings.withServerSettingsSnapshot(async () => {
    await f.settings.writeServerSettings({ [key]: '60000' })
    assert.equal(f.settings.getServerSettingsSnapshot().settings[key], '45000')
  })
  assert.equal(f.settings.getServerSetting(key), '60000')
  await f.settings.writeServerSettings({ [key]: null })
  assert.equal(f.settings.getServerSetting(key), '30000')
  assert.equal(f.settings.getServerSettingsSnapshot().sources[key], 'default')
})


test('group configuration commits a durable versioned cursor job, preserves it on rollback and skips unrelated saves', async () => {
  const f = fixture()
  await f.settings.loadServerSettings()
  const raw = JSON.stringify({ pro: { zhipu: 42 } })
  const next = await f.settings.writeServerSettings({ sub2api_group_config: raw })
  const job = JSON.parse(f.data.get('__sub2api_group_resync')!)
  assert.equal(job.version, next.revision)
  assert.deepEqual(job.groups.pro, { zhipu: 42 })
  assert.equal(job.cursor, null)
  assert.equal(job.done, false)
  assert.ok(f.statements.every(sql => !sql.includes('users') && !sql.includes('sub2api_sync_intents')))
  const persisted = f.data.get('__sub2api_group_resync')
  await f.settings.writeServerSettings({ brain_model: 'other' })
  await f.settings.writeServerSettings({ sub2api_group_config: raw })
  assert.equal(f.data.get('__sub2api_group_resync'), persisted)
  f.failCommit(true)
  await assert.rejects(f.settings.writeServerSettings({ sub2api_group_config: JSON.stringify({ pro: { zhipu: 43 } }) }), /commit failure/)
  assert.equal(f.data.get('__sub2api_group_resync'), persisted)
  assert.equal(f.data.get('sub2api_group_config'), raw)
})
