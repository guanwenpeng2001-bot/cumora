import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type * as Settings from '../settings.js'
import type * as Managed from '../managed-pod-settings.js'
import type * as Env from '../env.js'
import type * as Tenant from '../tenant-llm-context.js'
import type * as Resolver from '../llm-resolver.js'

const read = (name: string) => readFileSync(new URL(`../${name}.ts`, import.meta.url), 'utf8')
const transpile = (source: string) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(bootstrap?: Managed.ManagedPodSettings, extraEnv: Record<string, string> = {}) {
  const processEnv: Record<string, string> = {
    OPENAI_API_KEY: 'direct-text-key', OPENAI_BASE_URL: 'https://direct.invalid/v1',
    OPENAI_MODEL: 'env-brain', OPENAI_MODEL_SUPPORT: 'env-support',
    OPENAI_COMPACTION_MODEL: 'env-compact', OPENAI_AUDIO_MODEL: 'env-audio',
    OPENAI_IMAGE_API_KEY: 'direct-image-key', OPENAI_IMAGE_PROVIDER: 'dashscope',
    OPENAI_IMAGE_NATIVE_BASE_URL: 'https://image.invalid/api/v1',
    OPENAI_EMBED_API_KEY: 'direct-embed-key', OPENAI_EMBED_BASE_URL: 'https://embed.invalid/v1',
    NOVITA_API_KEY: 'direct-novita-key', ORCAROUTER_API_KEY: 'direct-orcarouter-key',
    SUB2API_INTERNAL_URL: 'https://gateway.invalid', SUB2API_ADMIN_KEY: 'never-pod-admin',
    AGENT_RUNTIME_SECRET: 'never-pod-server-signing-secret', LOCAL_SKILLHUB_PATH: 'never-pod-local-path',
    ...extraEnv,
  }
  if (bootstrap) {
    processEnv.CUMORA_AGENT_ID = bootstrap.agentId
    processEnv.CUMORA_MANAGED_POD_BOOTSTRAP = JSON.stringify(bootstrap)
  }
  let rows = [
    { key: '__settings_revision', value: '17' }, { key: 'brain_model', value: 'db-brain' },
    { key: 'brain_fallback_models', value: 'fallback-a,fallback-b' },
    { key: 'support_model', value: 'db-support' }, { key: 'agent_max_output_tokens', value: '7123' },
    { key: 'local_skillhub_path', value: 'never-pod-db-path' },
  ]
  let owner = { owner_user_id: 'owner-a', authorization_version: '101',
    sub2api_api_key: JSON.stringify({ openai: 'owner-openai', kimi: 'owner-kimi', deepseek: 'owner-deepseek', grok: 'owner-grok' }) }
  let failure = false
  let held: ReturnType<typeof deferred<{ rows: unknown[] }>> | undefined
  const queries: unknown[] = []
  const messages: string[] = []
  const intervals: { fn: () => void; ms: number }[] = []
  const pool = {
    async query(query: string | { text: string; values: unknown[]; query_timeout: number }) {
      queries.push(query)
      if (failure) throw new Error('DB failure containing a secret must not be logged')
      if (typeof query === 'string') {
        assert.equal(query, 'SELECT key, value FROM server_settings')
        return { rows }
      }
      assert.match(query.text, /p.id = \$1 AND c.id = \$2/)
      assert.equal(query.query_timeout, 5_000)
      assert.deepEqual(plain(query.values.slice(0, 2)), ['agent-a', 'company-a'])
      const result = { rows: [{ ...owner, settings: rows.filter(row => (query.values[2] as string[]).includes(row.key)) }] }
      if (held) { const wait = held; held = undefined; return wait.promise }
      return result
    },
    async connect() { throw new Error('Pod must not write or open transactions') },
  }
  let now = Date.now()
  class Clock extends Date { static now() { return now } }
  const modules = new Map<string, Record<string, any>>()
  function load(name: string): any {
    if (modules.has(name)) return modules.get(name)
    const exports: Record<string, any> = {}
    modules.set(name, exports)
    runInNewContext(transpile(read(name)), {
      exports, URL, Date: Clock, setTimeout, clearTimeout,
      setInterval(fn: () => void, ms: number) { intervals.push({ fn, ms }); return { unref() {} } },
      console: { warn: (...args: unknown[]) => messages.push(args.join(' ')), log: (...args: unknown[]) => messages.push(args.join(' ')) },
      process: { env: processEnv, exit(code: number) { throw new Error(`unexpected exit ${code}`) } },
      require(dep: string) {
        if (dep === 'dotenv/config') return {}
        if (dep === 'node:crypto') return { randomBytes, randomUUID }
        const target = posix.normalize(posix.join(posix.dirname(name), dep)).replace(/\.js$/, '')
        if (target === 'db/pool') return { pool }
        return load(target)
      },
    })
    return exports
  }
  const settings = load('settings') as typeof Settings
  const env = load('env') as typeof Env
  const managed = load('managed-pod-settings') as typeof Managed
  const tenant = load('tenant-llm-context') as typeof Tenant
  const resolver = load('llm-resolver') as typeof Resolver
  load('sub2api').listKeyModelsWithStatus = async (_base: string, key: string) => ({
    models: new Set([key.replace('owner-', '') + '-model']), ok: true, status: 'ok',
  })
  return { settings, env, managed, tenant, resolver, queries, messages, intervals, processEnv,
    advance(ms: number) { now += ms },
    fail(value = true) { failure = value },
    setRows(next: typeof rows) { rows = next },
    setOwner(next: typeof owner) { owner = next },
    hold() { held = deferred(); return held },
  }
}

async function bootstrap(extraEnv: Record<string, string> = {}) {
  const main = fixture(undefined, extraEnv)
  const config = await main.settings.createManagedPodBootstrap('agent-a', 'company-a', value => value)
  return { main, config }
}

test('bootstrap includes every runtime policy, six direct slots and only the owner platform keys', async () => {
  const { main, config } = await bootstrap()
  assert.equal(config.policy.revision, '17')
  assert.equal(config.policy.settings.brain_model, 'db-brain')
  assert.equal(config.defaults.brain_model, 'env-brain')
  assert.equal(config.policy.settings.agent_max_output_tokens, '7123')
  assert.equal(config.policy.settings.brain_fallback_models, 'fallback-a,fallback-b')
  assert.deepEqual(Object.keys(config.direct), ['text', 'image', 'audio', 'embed', 'novita', 'orcarouter'])
  assert.equal(config.gateway.keys.kimi, 'owner-kimi')
  assert.equal(config.direct.text.apiKey, 'direct-text-key')
  assert.equal(config.direct.image.protocol, 'dashscope-image')
  assert.equal(config.direct.audio.apiKey, 'direct-image-key')
  assert.equal(Object.keys(config.policy.settings).length, main.settings.SETTING_DEFS.filter(def => def.pod).length)
  assert.doesNotMatch(JSON.stringify(config), /never-pod|local_skillhub_path|sub2api_group_config|ADMIN_KEY|RUNTIME_SECRET/)
  assert.doesNotMatch(JSON.stringify(config.policy), /owner-openai|direct-text-key/)
})

test('first turn uses a complete bootstrap during DB failure and cannot seed or write', async () => {
  const { config } = await bootstrap()
  const pod = fixture(config, { OPENAI_MODEL: 'wrong-env', OPENAI_API_KEY: 'wrong-direct' })
  pod.fail()
  await pod.settings.initializeManagedPodSettings()
  assert.equal(pod.settings.getBrainModel(), 'db-brain')
  assert.equal(pod.settings.getSupportModel(), 'db-support')
  assert.equal(pod.settings.getServerSettingsSnapshot().source, 'bootstrap')
  assert.equal(pod.env.resolveDirectLlmEnv('text').apiKey, 'direct-text-key')
  assert.equal((await pod.tenant.resolveTenantLlmContext('company-a')).keys.grok, 'owner-grok')
  await assert.rejects(pod.settings.seedServerSettingsFromEnv(), /cannot seed/)
  await assert.rejects(pod.settings.writeServerSettings({ brain_model: 'illegal' }), /read-only/)
  await assert.rejects(pod.tenant.resolveTenantLlmContext('company-b'), /does not authorize/)
  await assert.rejects(pod.tenant.resolveTenantLlmContext('company-a', 'member'), /does not authorize/)
  assert.match(pod.messages.join('\n'), /source=bootstrap revision=17/)
  assert.doesNotMatch(pod.messages.join('\n'), /containing a secret/)
  assert.equal(pod.intervals.length, 1)
  pod.settings.startServerSettingsRefresher()
  assert.equal(pod.intervals.length, 1)
})

test('bounded first read preserves bootstrap and late success installs policy and identity together', async () => {
  const { config } = await bootstrap()
  const pod = fixture(config)
  const held = pod.hold()
  await pod.settings.initializeManagedPodSettings(5)
  assert.equal(pod.settings.getServerSettingsSnapshot().source, 'bootstrap')
  assert.equal((await pod.tenant.resolveTenantLlmContext('company-a')).ownerId, 'owner-a')
  held.resolve({ rows: [{ owner_user_id: 'owner-b', authorization_version: '102', sub2api_api_key: 'new-owner-key',
    settings: [{ key: '__settings_revision', value: '18' }, { key: 'brain_model', value: 'new-brain' }] }] })
  await pod.settings.refreshServerSettings()
  assert.equal(pod.settings.getBrainModel(), 'new-brain')
  assert.equal(pod.settings.getSupportModel(), 'env-support')
  assert.equal(pod.settings.getServerSettingsSnapshot().source, 'db')
  assert.equal((await pod.tenant.resolveTenantLlmContext('company-a')).ownerId, 'owner-b')
  assert.equal(pod.env.resolveDirectLlmEnv('text').apiKey, 'direct-text-key')
  assert.ok(Object.isFrozen(pod.managed.getManagedPodSettings()?.gateway.keys))
})

test('healthy 30-second refresh converges, reset inherits original env, failure and old revision retain whole snapshot', async () => {
  const { config } = await bootstrap()
  const pod = fixture(config)
  await pod.settings.initializeManagedPodSettings()
  pod.setRows([{ key: '__settings_revision', value: '18' }, { key: 'support_model', value: 'updated-support' }])
  pod.setOwner({ owner_user_id: 'owner-b', authorization_version: '202', sub2api_api_key: '{"kimi":"rotated-kimi"}' })
  pod.advance(30_000)
  assert.equal(pod.intervals[0].ms, 30_000)
  pod.intervals[0].fn()
  await pod.settings.refreshServerSettings()
  assert.equal(pod.settings.getBrainModel(), 'env-brain')
  assert.equal(pod.settings.getSupportModel(), 'updated-support')
  assert.equal(pod.settings.getServerSettingsSnapshot().revision, '18')
  const context = await pod.tenant.resolveTenantLlmContext('company-a')
  assert.deepEqual(plain(context.keys), { kimi: 'rotated-kimi' })
  const saved = pod.managed.getManagedPodSettings()
  pod.fail()
  await pod.settings.refreshServerSettings(true)
  assert.equal(pod.managed.getManagedPodSettings(), saved)
  pod.fail(false)
  pod.setRows([{ key: '__settings_revision', value: '16' }])
  pod.setOwner({ owner_user_id: 'stale-owner', authorization_version: '100', sub2api_api_key: 'stale-key' })
  await pod.settings.refreshServerSettings(true)
  assert.equal(pod.managed.getManagedPodSettings(), saved)
  // Key rotation need not change server_settings revision.
  pod.setRows([{ key: '__settings_revision', value: '18' }])
  pod.setOwner({ owner_user_id: 'owner-b', authorization_version: '203', sub2api_api_key: '' })
  await pod.settings.refreshServerSettings(true)
  assert.deepEqual(plain((await pod.tenant.resolveTenantLlmContext('company-a')).keys), {})
})

test('pure env deployment and all four owner platforms resolve through the unchanged resolver', async () => {
  const { config } = await bootstrap({ SUB2API_INTERNAL_URL: '', SUB2API_ADMIN_KEY: '' })
  const directPod = fixture(config)
  directPod.fail()
  await directPod.settings.initializeManagedPodSettings()
  const direct = await directPod.resolver.resolveRoleCall('company-a', 'managed', 'brain', 'turn')
  assert.equal(direct.candidates[0].route.kind, 'direct')
  assert.equal(direct.candidates[0].available, true)
  assert.equal(direct.routable, false)
  const gateway = fixture((await bootstrap()).config)
  gateway.fail()
  await gateway.settings.initializeManagedPodSettings()
  for (const platform of ['openai', 'kimi', 'deepseek', 'grok']) {
    const plan = await gateway.resolver.resolveRoleCall('company-a', 'managed', 'brain', 'turn', { model: `${platform}-model` })
    assert.equal(plan.candidates[0].route.kind, 'gateway')
    assert.equal(plan.candidates[0].route.platform, platform)
    assert.equal(plan.candidates[0].available, true)
    assert.equal(plan.revision, '17')
    assert.doesNotMatch(JSON.stringify(plan), /owner-kimi|direct-text-key/)
  }
  assert.equal(gateway.queries.length, 1, 'business identity reads do not query DB')
})

test('main-service owner lookup failure is not disguised as direct fallback; incomplete bootstrap fails closed', async () => {
  const main = fixture()
  main.fail()
  await assert.rejects(main.settings.createManagedPodBootstrap('agent-a', 'company-a', value => value), /DB failure/)
  const { config } = await bootstrap()
  const incomplete = plain(config)
  delete (incomplete.policy.settings as Record<string, string>).support_model
  const pod = fixture(incomplete)
  await assert.rejects(pod.settings.initializeManagedPodSettings(), /Incomplete/)
  assert.equal(pod.queries.length, 0)
})

function functionsFrom(file: string, names: string[]): string {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
  return ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text))
    .map(node => node.getText(ast)).join('\n') + '\n' + names.map(name => `exports.${name} = ${name}`).join('\n')
}

test('unchanged candidate client uses owner platform keys and direct credentials separately', async () => {
  const pod = fixture((await bootstrap()).config)
  pod.fail()
  await pod.settings.initializeManagedPodSettings()
  const exports: { getLlmCandidateClient?: (plan: unknown, candidate: unknown) => Promise<{ options: { apiKey: string; baseURL: string } }> } = {}
  runInNewContext(transpile(functionsFrom('llm', ['getLlmCandidateClient'])), {
    exports, testLlmOverride: null, SDK_MAX_RETRIES: 0, SDK_TIMEOUT_MS: 100,
    resolveTenantLlmContext: pod.tenant.resolveTenantLlmContext, resolveDirectLlmEnv: pod.env.resolveDirectLlmEnv,
    OpenAI: class { constructor(public options: unknown) {} }, withProviderRouting: (client: unknown) => client,
  })
  for (const platform of ['openai', 'kimi', 'deepseek', 'grok']) {
    const plan = await pod.resolver.resolveRoleCall('company-a', 'managed', 'brain', 'turn', { model: `${platform}-model` })
    const client = await exports.getLlmCandidateClient!(plan, plan.candidates[0])
    assert.equal(client.options.apiKey, `owner-${platform}`)
    assert.equal(client.options.baseURL, 'https://gateway.invalid/v1')
  }
  const direct = await pod.resolver.resolveRoleCall(null, 'managed', 'brain', 'turn')
  const client = await exports.getLlmCandidateClient!(direct, direct.candidates[0])
  assert.equal(client.options.apiKey, 'direct-text-key')
  assert.equal(client.options.baseURL, 'https://direct.invalid/v1')
})

test('manifest round-trips bootstrap and never transmits the server signing secret or admin settings', async () => {
  const { main, config } = await bootstrap()
  const exports: { podManifest?: (args: unknown) => string } = {}
  const names = ['podManifest', 'podUrl', 'yamlQuote', 'dnsLabelValue', 'safeName', 'podName']
  runInNewContext(transpile(functionsFrom('agents/runtime/orchestrator', names)), {
    exports, URL, randomBytes, env: main.env.env, PULL_SECRETS: [], POD_SERVICE_ACCOUNT: '',
    CHROME_PROFILE_ON_PVC: false, CHROME_PVC_SIZE: '500Mi',
    getBrainModel: main.settings.getBrainModel, getSupportModel: main.settings.getSupportModel,
    getCompactionModel: main.settings.getCompactionModel, agentReasoningEffort: () => 'low',
    agentMaxOutputTokens: () => 4000, supportReasoningEffort: () => 'low', supportReasoningHeadroom: () => 0,
  })
  const manifest = exports.podManifest!({ agentId: 'agent-a', token: 'scoped-runtime-token', image: 'test-image',
    serverUrl: 'https://runtime.invalid', openaiKey: config.direct.text.apiKey, openaiBaseUrl: config.direct.text.baseURL,
    bootstrap: config, idleMs: 100, noWorkMs: 100 })
  assert.doesNotMatch(manifest, /never-pod|SUB2API_ADMIN_KEY|local_skillhub_path|sub2api_group_config/)
  const value = manifest.match(/name: CUMORA_MANAGED_POD_BOOTSTRAP\n\s+value: (.+)/)![1]
  assert.deepEqual(JSON.parse(JSON.parse(value)), plain(config))
  const secret = JSON.parse(manifest.match(/name: AGENT_RUNTIME_SECRET\n\s+value: (.+)/)![1])
  assert.match(secret, /^[a-f0-9]{64}$/)
  // Exercise the production image's real env gate with the isolated per-Pod value.
  const pod = fixture(config, { NODE_ENV: 'production', AGENT_RUNTIME_SECRET: secret, SUB2API_ADMIN_KEY: '' })
  assert.equal(pod.env.env.SUB2API_ADMIN_KEY, '')
  assert.match(manifest, /name: OPENAI_API_KEY\n\s+value: \|-\n\s+direct-text-key/)
  const source = read('agents/runtime/pod-agent')
  assert.ok(source.indexOf('await initializeManagedPodSettings()') < source.indexOf("await runtime.setStatus(agentId, 'avail')"))
})

test('new CLI children inherit the latest complete snapshot after a running Pod refresh', async () => {
  const pod = fixture((await bootstrap()).config)
  await pod.settings.initializeManagedPodSettings()
  pod.setRows([{ key: '__settings_revision', value: '19' }, { key: 'brain_model', value: 'child-brain' }])
  await pod.settings.refreshServerSettings(true)
  const child = fixture(JSON.parse(pod.processEnv.CUMORA_MANAGED_POD_BOOTSTRAP))
  child.fail()
  assert.equal(child.settings.getBrainModel(), 'child-brain')
  assert.equal(child.settings.getServerSettingsSnapshot().revision, '19')
})


test('legacy Pod bootstrap inherits the optional turn policy and refreshes it without writes', async () => {
  const { config } = await bootstrap()
  const old = plain(config)
  for (const def of fixture().settings.SETTING_DEFS.filter(d => d.scope === 'managed')) {
    delete (old.policy.settings as Record<string, string>)[def.key]
    delete (old.policy.sources as Record<string, string>)[def.key]
    delete (old.defaults as Record<string, string>)[def.key]
  }
  const pod = fixture(old)
  pod.fail()
  await pod.settings.initializeManagedPodSettings(1)
  const first = pod.settings.getTurnBudgetPolicy()
  assert.equal(first.maxHops, 200)
  assert.equal(first.softRatio, 0.75)
  assert.equal(first.outputBytes, 600)
  pod.fail(false)
  pod.setRows([{ key: '__settings_revision', value: '18' },
    { key: 'agent_max_hops', value: '9' }, { key: 'auto_compaction_enabled', value: 'false' }])
  await pod.settings.refreshServerSettings(true)
  assert.equal(pod.settings.getTurnBudgetPolicy().maxHops, 9)
  assert.equal(pod.settings.getTurnBudgetPolicy().autoEnabled, false)
  assert.equal(pod.settings.getTurnBudgetPolicy().hardRatio, 0.95)
  assert.equal(first.maxHops, 200)
})
