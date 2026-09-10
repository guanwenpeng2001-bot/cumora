import assert from 'node:assert/strict'
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

function fixture() {
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
      if (name === './db/pool.js') return { pool }
      if (name === './env.js') return { env }
      if (name === './sub2api.js') return {}
      if (name === './managed-pod-settings.js') return { getManagedPodSettings: () => null }
      throw new Error('unexpected dependency: ' + name)
    },
    process: { env: {} }, console: { warn() {} },
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
    ...f.settings,
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
    keepRecentPairs: 2, strategy: 'summary', summaryMaxChars: 4000, maxHops: 200, timeoutMs: 0, revision: '0',
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
    keepRecentPairs: 0, strategy: 'drop-and-marker', summaryMaxChars: 250, maxHops: 9, timeoutMs: 1000, revision: '1',
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
  ]) await assert.rejects(f.settings.writeServerSettings({ [key]: value }))
  assert.equal(f.connections, 0)
  await f.settings.writeServerSettings({ compaction_soft_ratio: '0.85', compaction_hard_ratio: '0.9' })
  const before = f.settings.getServerSettingsSnapshot()
  await assert.rejects(f.settings.writeServerSettings({ compaction_hard_ratio: '0.8', agent_max_hops: '3' }), /soft < hard/)
  assert.equal(f.settings.getServerSettingsSnapshot(), before)
  assert.equal(f.data.has('agent_max_hops'), false)
  await f.settings.writeServerSettings({ compaction_hard_ratio: '0.99', compaction_soft_ratio: '0.97' })
  await assert.rejects(f.settings.writeServerSettings({ compaction_hard_ratio: null }), /soft < hard/)
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
    assert.equal(snapshot.sources[key], 'env', key)
  }
  const otherKeys = [
    'idle_enabled', 'idle_interval_ms', 'idle_min_quiet_min', 'agenda_gate_enabled', 'agenda_error_mode',
    'scanner_enabled', 'scanner_interval_ms', 'scanner_min_messages', 'scanner_window_hours',
    'steer_enabled', 'byoa_group_steer_enabled', 'byoa_group_steer_interval_ms',
    'synthetic_gate_enabled', 'synthetic_gate_failure_mode', 'inbox_triage_failure_mode', 'triage_rate_limit_mode',
    'cloud_inbox_triage_timeout_ms', 'synthetic_gate_timeout_ms', 'byoa_triage_timeout_ms',
    'triage_backoff_base_ms', 'triage_backoff_max_ms', 'support_inbox_triage_output_tokens',
    'support_synthetic_gate_output_tokens', 'low_priority_wake_budget_per_minute', 'agent_turn_rate_per_minute',
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
    assert.equal(inherited.sources[key], 'env', key)
  }
  assert.equal(inherited.settings.idle_enabled, 'false')
  assert.equal(inherited.settings.support_inbox_triage_output_tokens, '2500')
})
