/**
 * Server-wide model settings — runtime-editable, no restart.
 *
 * Storage: `server_settings` key-value table (migration 0007). Read side
 * is a sync in-memory snapshot with a 30s refresh; writes commit atomically
 * and install a complete versioned snapshot before returning. Every key falls back to its env var when the
 * DB has no row (fresh installs, or a pod that booted before the first
 * refresh landed), so behavior without the table is exactly the pre-DB
 * behavior.
 *
 * Roles: brain (agent main turn) / support (cerebellum gates) /
 * compaction (context compaction) / image / audio / embed. Text roles
 * additionally carry reasoning effort + output cap + an ordered fallback
 * chain; image/audio carry fallback chains. Embed carries NO fallback —
 * switching embedding models changes the vector space, so a silent
 * fallback would corrupt semantic memory recall (see fallback.ts).
 */
import type { PoolClient, QueryConfig } from 'pg'
import { pool } from './db/pool.js'
import { env, resolveDirectLlmEnv } from './env.js'
import { parseApiKeyMap, sub2apiOpenAIBaseURL } from './sub2api.js'
import { DIRECT_LLM_SLOTS, getManagedPodSettings, installManagedPodSettings, type ManagedPodSettings } from './managed-pod-settings.js'

export interface SettingDef {
  key: string
  type: 'model' | 'list' | 'string' | 'integer' | 'reasoning' | 'json'
  required?: boolean
  pod?: boolean
  /** Env fallback when the DB has no row. */
  envValue: () => string
}

/** The full key inventory. Values are always stored as strings; list-typed
 *  keys are comma-separated. */
export const SETTING_DEFS: readonly SettingDef[] = [
  { key: 'llm_config', pod: true, type: 'json', envValue: () => '' },
  { key: 'sub2api_group_config', type: 'json', envValue: () => '' },
  { key: 'brain_model', pod: true, type: 'model', required: true, envValue: () => env.OPENAI_MODEL ?? '' },
  { key: 'brain_fallback_models', pod: true, type: 'list', envValue: () => '' },
  { key: 'support_model', pod: true, type: 'model', required: true, envValue: () => env.OPENAI_MODEL_SUPPORT ?? '' },
  { key: 'support_fallback_models', pod: true, type: 'list', envValue: () => '' },
  { key: 'compaction_model', pod: true, type: 'model', required: true, envValue: () => env.OPENAI_COMPACTION_MODEL ?? '' },
  { key: 'compaction_fallback_models', pod: true, type: 'list', envValue: () => '' },
  { key: 'image_model', pod: true, type: 'model', required: true, envValue: () => env.OPENAI_IMAGE_MODEL ?? '' },
  { key: 'image_fallback_models', pod: true, type: 'list', envValue: () => process.env.OPENAI_IMAGE_FALLBACK_MODELS ?? '' },
  { key: 'audio_model', pod: true, type: 'model', required: true, envValue: () => process.env.OPENAI_AUDIO_MODEL ?? '' },
  { key: 'audio_fallback_models', pod: true, type: 'list', envValue: () => process.env.OPENAI_AUDIO_FALLBACK_MODELS ?? '' },
  { key: 'embed_model', pod: true, type: 'model', required: true, envValue: () => process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small' },
  { key: 'agent_reasoning_effort', pod: true, type: 'reasoning', envValue: () => process.env.CUMORA_REASONING_EFFORT ?? 'low' },
  { key: 'agent_max_output_tokens', pod: true, type: 'integer', envValue: () => process.env.CUMORA_AGENT_MAX_OUTPUT_TOKENS ?? '4000' },
  { key: 'support_reasoning_effort', pod: true, type: 'reasoning', envValue: () => process.env.CUMORA_SUPPORT_REASONING_EFFORT ?? 'low' },
  { key: 'support_reasoning_headroom', pod: true, type: 'integer', envValue: () => process.env.CUMORA_SUPPORT_REASONING_HEADROOM ?? '0' },
  // Not a model — the skills tab's local hub directory.
  { key: 'local_skillhub_path', type: 'string', envValue: () => process.env.LOCAL_SKILLHUB_PATH ?? '' },
]

const KNOWN_KEYS = new Set(SETTING_DEFS.map((d) => d.key))

/** Exported for the HTTP layer's 400 validation; writeServerSettings
 *  re-checks as defense in depth. */
export const KNOWN_SETTING_KEYS: ReadonlySet<string> = KNOWN_KEYS

const REFRESH_MS = 30_000
const REFRESH_FAILURE_BACKOFF_MS = 5_000

const REVISION_KEY = '__settings_revision'
const INHERIT_PREFIX = '__settings_inherit:'

export interface ServerSettingsSnapshot {
  /** Decimal string: preserves PostgreSQL bigint precision across JSON. */
  revision: string
  settings: Readonly<Record<string, string>>
  sources: Readonly<Record<string, 'db' | 'env'>>
  diagnostics?: readonly string[]
  source?: 'db' | 'env' | 'bootstrap'
}

let snapshot: ServerSettingsSnapshot | null = null
let snapshotAt = 0
let lastRefreshFailureAt = 0
let refreshing: Promise<void> | null = null
let generation = 0
let writing: Promise<unknown> = Promise.resolve()

function makeSnapshot(rows: { key: string; value: string }[], defaults?: Readonly<Record<string, string>>): ServerSettingsSnapshot {
  const values = new Map(rows.map((r) => [r.key, r.value]))
  const revision = values.get(REVISION_KEY) ?? '0'
  if (!/^\d+$/.test(revision)) throw new Error('invalid settings revision')
  const diagnostics: string[] = []
  const settings: Record<string, string> = {}
  const sources: Record<string, 'db' | 'env'> = {}
  for (const def of SETTING_DEFS) {
    const fallback = defaults ? defaults[def.key] ?? '' : def.envValue()
    settings[def.key] = values.get(def.key) ?? fallback
    sources[def.key] = values.has(def.key) ? 'db' : 'env'
    try { validateServerSettings({ [def.key]: settings[def.key] }) } catch {
      diagnostics.push(`invalid-setting:${def.key}`)
      console.warn('[settings] invalid value; using env/default', def.key)
      settings[def.key] = fallback
      sources[def.key] = 'env'
      try { validateServerSettings({ [def.key]: settings[def.key] }) } catch { settings[def.key] = '' }
    }
  }
  return Object.freeze({ revision, source: 'db', settings: Object.freeze(settings), sources: Object.freeze(sources), diagnostics: Object.freeze(diagnostics) })
}

function installSnapshot(next: ServerSettingsSnapshot): void {
  if (snapshot && BigInt(next.revision) < BigInt(snapshot.revision)) return
  snapshot = next
  snapshotAt = Date.now()
  lastRefreshFailureAt = 0
}

function podPolicy(policy: ServerSettingsSnapshot): ServerSettingsSnapshot {
  const allowed = SETTING_DEFS.filter(def => def.pod)
  return Object.freeze({
    revision: policy.revision, source: policy.source,
    settings: Object.freeze(Object.fromEntries(allowed.map(def => [def.key, policy.settings[def.key]]))),
    sources: Object.freeze(Object.fromEntries(allowed.map(def => [def.key, policy.sources[def.key]]))),
    diagnostics: policy.diagnostics,
  })
}

async function readManagedPodSettings(base: ManagedPodSettings): Promise<ManagedPodSettings> {
  // One statement gives policy and owner identity the same MVCC snapshot.
  const { rows } = await pool.query<{
    settings: { key: string; value: string }[]
    owner_user_id: string; sub2api_api_key: string | null; authorization_version: string
  }>({
    text: `SELECT c.owner_user_id, u.sub2api_api_key, u.xmin::text AS authorization_version,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('key', s.key, 'value', s.value))
               FROM server_settings s WHERE s.key = ANY($3::text[])), '[]'::jsonb) AS settings
           FROM participants p JOIN companies c ON c.id = p.company_id
           JOIN users u ON u.id = c.owner_user_id
          WHERE p.id = $1 AND c.id = $2`,
    values: [base.agentId, base.gateway.companyId, [...SETTING_DEFS.filter(def => def.pod).map(def => def.key), REVISION_KEY]],
    query_timeout: 5_000,
  } as QueryConfig & { query_timeout: number })
  const row = rows[0]
  if (!row) throw new Error('Managed Pod owner identity unavailable')
  return {
    ...base, source: 'db', policy: podPolicy(makeSnapshot(row.settings, base.defaults)),
    gateway: {
      companyId: base.gateway.companyId, ownerId: row.owner_user_id, generation: 0,
      authorizationVersion: `${row.owner_user_id}:${row.authorization_version}:0:${base.gateway.baseURL}`,
      keys: parseApiKeyMap(row.sub2api_api_key), baseURL: base.gateway.baseURL,
    },
  }
}

/** Called only by the main service; runtime-only credentials stay outside public settings. */
export async function createManagedPodBootstrap(agentId: string, companyId: string, mapURL: (url: string) => string): Promise<ManagedPodSettings> {
  const base: ManagedPodSettings = {
    version: 1, agentId, source: 'bootstrap', policy: podPolicy(getServerSettingsSnapshot()),
    defaults: Object.fromEntries(SETTING_DEFS.filter(def => def.pod).map(def => [def.key, def.envValue()])),
    gateway: { companyId, ownerId: '', authorizationVersion: '', generation: 0, keys: {}, baseURL: mapURL(sub2apiOpenAIBaseURL()) },
    direct: Object.fromEntries(DIRECT_LLM_SLOTS.map(slot => {
      const direct = resolveDirectLlmEnv(slot)
      return [slot, { ...direct, baseURL: mapURL(direct.baseURL) }]
    })) as ManagedPodSettings['direct'],
  }
  // A failed owner read must not be mistaken for an unprovisioned owner.
  const next = await readManagedPodSettings(base)
  return { ...next, source: 'bootstrap', policy: { ...next.policy, source: 'bootstrap' } }
}

function installPodBootstrap(): ManagedPodSettings | null {
  const managed = getManagedPodSettings()
  if (managed && !snapshot) {
    for (const def of SETTING_DEFS.filter(def => def.pod)) {
      if (typeof managed.policy.settings[def.key] !== 'string' || typeof managed.defaults[def.key] !== 'string'
        || !['db', 'env'].includes(managed.policy.sources[def.key])) throw new Error('Incomplete managed Pod policy')
    }
    installSnapshot(Object.freeze({ ...managed.policy, source: managed.source }))
  }
  return managed
}

/** Install bootstrap before the first turn, then wait at most five seconds. */
export async function initializeManagedPodSettings(waitMs = 5_000): Promise<void> {
  installPodBootstrap()
  if (!snapshot) installSnapshot(Object.freeze({ ...makeSnapshot([]), source: 'env' }))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([loadServerSettings(), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
  startServerSettingsRefresher()
  console.log(`[settings] Pod ready source=${snapshot!.source} revision=${snapshot!.revision}`)
}

/** Forced refreshes wait for older queries, then perform their own read. */
export async function refreshServerSettings(force = false): Promise<void> {
  const managed = installPodBootstrap()
  if (refreshing) {
    if (!force) return refreshing
    await refreshing
    return refreshServerSettings(true)
  }
  if (!force && snapshot && Date.now() - snapshotAt < REFRESH_MS) return
  if (!force && lastRefreshFailureAt && Date.now() - lastRefreshFailureAt < REFRESH_FAILURE_BACKOFF_MS) return
  const startedGeneration = generation
  refreshing = (async () => {
    try {
      if (managed) {
        const next = await readManagedPodSettings(managed)
        if (startedGeneration === generation && (!snapshot || BigInt(next.policy.revision) >= BigInt(snapshot.revision))) {
          installManagedPodSettings(next)
          installSnapshot(next.policy)
        }
      } else {
        const { rows } = await pool.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
        const next = makeSnapshot(rows)
        if (startedGeneration === generation) installSnapshot(next)
      }
    } catch (e) {
      if (startedGeneration === generation) lastRefreshFailureAt = Date.now()
      console.warn(`[settings] refresh failed; retaining source=${snapshot?.source ?? 'env'} revision=${snapshot?.revision ?? '0'}`)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export function getServerSettingsSnapshot(): ServerSettingsSnapshot {
  installPodBootstrap()
  if (!snapshot || Date.now() - snapshotAt >= REFRESH_MS) void refreshServerSettings()
  return snapshot ?? Object.freeze({ ...makeSnapshot([]), source: 'env' })
}

/** Sync read from one complete, immutable snapshot. */
export function getServerSetting(key: string): string {
  return getServerSettingsSnapshot().settings[key] ?? ''
}

/** List-typed read: comma-separated → trimmed string array. */
export function getServerSettingList(key: string): string[] {
  return getServerSetting(key).split(',').map((s) => s.trim()).filter(Boolean)
}

/** First-boot seed: copy env values into the table, never overwriting
 *  existing rows (operator edits win over later .env changes). */
export async function seedServerSettingsFromEnv(): Promise<void> {
  if (process.env.CUMORA_AGENT_ID || getManagedPodSettings()) throw new Error('Managed Pods cannot seed server settings')
  await commitSettings(async (client) => {
    await client.query(
      `INSERT INTO server_settings (key, value)
       SELECT e.key, e.value FROM jsonb_each_text($1::jsonb) e
       WHERE NOT EXISTS (SELECT 1 FROM server_settings s WHERE s.key = $2 || e.key)
       ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d.envValue()]))), INHERIT_PREFIX],
    )
  })
}

/** Main-service boot hook; Pods must use the read-only loader. */
export async function initServerSettings(): Promise<void> {
  await seedServerSettingsFromEnv()
}

export async function loadServerSettings(): Promise<void> {
  await refreshServerSettings(true)
}

/** Periodic refresh so multi-process deployments (server + pods) converge
 *  without a restart. Unref'd — never keeps a process alive. */
let refreshTimer: ReturnType<typeof setInterval> | undefined
export function startServerSettingsRefresher(): void {
  refreshTimer ??= setInterval(() => void refreshServerSettings(), REFRESH_MS)
  refreshTimer.unref()
}

// ── role model getters (sync; snapshot + env fallback) ──────────────────

export function getBrainModel(): string { return getServerSetting('brain_model') }
export function getSupportModel(): string { return getServerSetting('support_model') }
export function getCompactionModel(): string { return getServerSetting('compaction_model') }
export function getImageModel(): string { return getServerSetting('image_model') }
export function getAudioModel(): string { return getServerSetting('audio_model') }
export function getEmbedModel(): string { return getServerSetting('embed_model') }

export class InvalidServerSettingError extends Error {}

export function validateServerSettings(entries: Record<string, unknown>): asserts entries is Record<string, string | null> {
  for (const [key, value] of Object.entries(entries)) {
    const def = SETTING_DEFS.find((d) => d.key === key)
    if (!def) throw new InvalidServerSettingError('unknown setting key: ' + key)
    if (value === null) {
      if (def.required && !def.envValue().trim()) throw new InvalidServerSettingError('setting ' + key + ' has no inherited value')
      continue
    }
    if (typeof value !== 'string') throw new InvalidServerSettingError('setting ' + key + ' must be a string or null to inherit')
    if (def.required && !value.trim()) throw new InvalidServerSettingError('setting ' + key + ' must not be empty; use null to inherit')
    if (def.type === 'json') {
      if (key === 'llm_config') parseLlmConfig(value, true)
      else parseGroupConfig(value, true)
    }
    if (def.type === 'integer' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || (key === 'agent_max_output_tokens' && Number(value) === 0))) {
      throw new InvalidServerSettingError('invalid integer setting: ' + key)
    }
    if (def.type === 'reasoning' && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
      throw new InvalidServerSettingError('invalid reasoning setting: ' + key)
    }
  }
}

function commitSettings(mutate: (client: PoolClient) => Promise<void>): Promise<ServerSettingsSnapshot> {
  if (process.env.CUMORA_AGENT_ID || getManagedPodSettings()) return Promise.reject(new Error('Managed Pod settings are read-only'))
  const pending = writing.then(async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Serialize all settings writers, including first-boot seed, across processes.
      await client.query('LOCK TABLE server_settings IN SHARE ROW EXCLUSIVE MODE')
      await mutate(client)
      await client.query(
        `INSERT INTO server_settings (key, value) VALUES ($1, '1')
         ON CONFLICT (key) DO UPDATE SET value = (server_settings.value::bigint + 1)::text, updated_at = NOW()`,
        [REVISION_KEY],
      )
      const { rows } = await client.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
      const next = makeSnapshot(rows)
      await client.query('COMMIT')
      generation++
      installSnapshot(next)
      return next
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  })
  writing = pending.catch(() => {})
  return pending
}

/** Null restores inheritance; explicit empty strings remain valid only for optional values. */
export async function writeServerSettings(entries: Record<string, string | null>): Promise<ServerSettingsSnapshot> {
  validateServerSettings(entries)
  if (typeof entries.sub2api_group_config === 'string' && entries.sub2api_group_config.trim()) {
    const { validateSub2apiGroupSelection } = await import('./sub2api.js')
    await validateSub2apiGroupSelection(parseGroupConfig(entries.sub2api_group_config, true))
  }
  const rows = Object.entries(entries)
  return commitSettings(async (client) => {
    if (rows.some(([key]) => ['embed_model', 'llm_config', 'sub2api_group_config'].includes(key))) {
      const current = await client.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
      const before = makeSnapshot(current.rows).settings
      const after = { ...before }
      for (const [key, value] of rows) after[key] = value ?? SETTING_DEFS.find(d => d.key === key)!.envValue()
      if (embeddingSpace(before) !== embeddingSpace(after)) {
        const column = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'agent_workspace' AND column_name = 'embedding') AS exists`,
        )
        if (column.rows[0]?.exists) {
          const vectors = await client.query<{ exists: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM agent_workspace WHERE embedding IS NOT NULL) AS exists',
          )
          if (vectors.rows[0]?.exists) throw new InvalidServerSettingError(
            'embedding_space_locked: existing vectors require the same embedding model and route (1536 dimensions); a dedicated migration is required',
          )
        }
      }
    }
    for (const [key, value] of rows) {
      await client.query('DELETE FROM server_settings WHERE key = $1', [value === null ? key : INHERIT_PREFIX + key])
      await client.query(
        `INSERT INTO server_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [value === null ? INHERIT_PREFIX + key : key, value ?? 'true'],
      )
    }
  })
}

export async function writeInEmbeddingSpace(expected: ServerSettingsSnapshot, write: (client: PoolClient) => Promise<void>): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE server_settings IN SHARE MODE')
    const { rows } = await client.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
    if (embeddingSpace(expected.settings) !== embeddingSpace(makeSnapshot(rows).settings)) {
      await client.query('ROLLBACK')
      console.warn('[embed] embedding_space_changed: discarding stale vector')
      return false
    }
    await write(client)
    await client.query('COMMIT')
    return true
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

function embeddingSpace(settings: Readonly<Record<string, string>>): string {
  const config = parseLlmConfig(settings.llm_config ?? '')
  const model = config.roles.find(r => r.role === 'embed' && r.purpose === undefined)?.models[0]
    ?? settings.embed_model.trim()
  const metadata = config.models.find(m => m.model === model)
  const route = config.routes.find(r => r.id === metadata?.route)
  return JSON.stringify({
    model, legacyModel: settings.embed_model.trim(), dimensions: 1536,
    route: route ? [route.kind, route.platform ?? null, route.env ?? null, route.protocol ?? null] : null,
    protocol: metadata?.protocol ?? null,
    groups: route?.kind === 'direct' ? null : ['free', 'pro', 'max'].map(tier =>
      parseGroupConfig(settings.sub2api_group_config ?? '')[tier as 'free' | 'pro' | 'max']?.[route?.platform ?? 'openai'] ?? null),
  })
}

export const LLM_ROLES = ['brain', 'support', 'compaction', 'image', 'audio', 'embed'] as const
export type LlmRole = typeof LLM_ROLES[number]
export type LlmProtocol = 'responses' | 'chat' | 'images' | 'dashscope-image' | 'embeddings'
export interface LlmRouteConfig {
  id: string
  kind: 'gateway' | 'direct'
  platform?: 'openai' | 'kimi' | 'deepseek' | 'grok'
  env?: 'text' | 'image' | 'audio' | 'embed' | 'novita' | 'orcarouter'
  protocol?: LlmProtocol
}
export interface LlmModelMetadata {
  model: string
  route?: string
  roles?: LlmRole[]
  protocol?: LlmProtocol
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  contextWindow?: number
  maxOutputTokens?: number
  thinking?: boolean
  tools?: boolean
  vision?: boolean
}
export interface LlmRoleConfig { role: LlmRole; purpose?: string; models: string[] }
export interface LlmConfig { version: 1; routes: LlmRouteConfig[]; models: LlmModelMetadata[]; roles: LlmRoleConfig[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v === v.trim()
const protocols = ['responses', 'chat', 'images', 'dashscope-image', 'embeddings']

export function parseLlmConfig(raw: string, strict = false): LlmConfig {
  const empty: LlmConfig = { version: 1, routes: [], models: [], roles: [] }
  if (!raw.trim()) return empty
  try {
    const c: unknown = JSON.parse(raw)
    const check = (ok: unknown) => { if (!ok) throw new Error('schema') }
    check(object(c))
    const b = c as Record<string, unknown>
    check(Object.keys(b).every(k => ['version', 'routes', 'models', 'roles'].includes(k)) && b.version === 1)
    for (const key of ['routes', 'models', 'roles']) check(b[key] === undefined || Array.isArray(b[key]))
    const config = { ...empty, ...b } as LlmConfig
    const ids = new Set<string>()
    for (const r of config.routes) {
      check(object(r) && Object.keys(r).every(k => ['id', 'kind', 'platform', 'env', 'protocol'].includes(k)))
      check(nonempty(r.id) && !ids.has(r.id)); ids.add(r.id)
      check(['gateway', 'direct'].includes(r.kind))
      check(r.protocol === undefined || protocols.includes(r.protocol))
      check(r.kind === 'gateway' ? r.env === undefined && (r.platform === undefined || ['openai', 'kimi', 'deepseek', 'grok'].includes(r.platform))
        : r.platform === undefined && ['text', 'image', 'audio', 'embed', 'novita', 'orcarouter'].includes(r.env!))
    }
    const models = new Set<string>()
    for (const m of config.models) {
      check(object(m) && Object.keys(m).every(k => ['model', 'route', 'roles', 'protocol', 'effort', 'contextWindow', 'maxOutputTokens', 'thinking', 'tools', 'vision'].includes(k)))
      check(nonempty(m.model) && !models.has(m.model)); models.add(m.model)
      check(m.route === undefined || ids.has(m.route))
      check(m.protocol === undefined || protocols.includes(m.protocol))
      check(m.roles === undefined || (Array.isArray(m.roles) && m.roles.length > 0 && m.roles.every(r => LLM_ROLES.includes(r))))
      check(m.effort === undefined || ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(m.effort))
      for (const key of ['thinking', 'tools', 'vision'] as const) check(m[key] === undefined || typeof m[key] === 'boolean')
      for (const [key, max] of [['contextWindow', 2_000_000], ['maxOutputTokens', 1_000_000]] as const) check(m[key] === undefined || (Number.isSafeInteger(m[key]) && m[key]! > 0 && m[key]! <= max))
    }
    const roles = new Set<string>()
    for (const r of config.roles) {
      check(object(r) && Object.keys(r).every(k => ['role', 'purpose', 'models'].includes(k)))
      check(LLM_ROLES.includes(r.role) && (r.purpose === undefined || nonempty(r.purpose)))
      const id = JSON.stringify([r.role, r.purpose]); check(!roles.has(id)); roles.add(id)
      check(Array.isArray(r.models) && r.models.length > 0 && r.models.every(nonempty))
      check(r.role !== 'embed' || (r.models.length === 1 && r.purpose === undefined))
    }
    return config
  } catch {
    if (strict) throw new InvalidServerSettingError('invalid llm_config schema')
    console.warn('[settings] invalid llm_config; using legacy role settings')
    return empty
  }
}

export type Sub2apiGroupConfig = Partial<Record<'free' | 'pro' | 'max', Partial<Record<'openai' | 'kimi' | 'deepseek' | 'grok', number>>>>
export function parseGroupConfig(raw: string, strict = false): Sub2apiGroupConfig {
  if (!raw.trim()) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!object(value)) throw new Error('schema')
    for (const [tier, groups] of Object.entries(value)) {
      if (!['free', 'pro', 'max'].includes(tier) || !object(groups)) throw new Error('schema')
      for (const [platform, id] of Object.entries(groups)) {
        if (!['openai', 'kimi', 'deepseek', 'grok'].includes(platform) || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('schema')
      }
    }
    return value as Sub2apiGroupConfig
  } catch {
    if (strict) throw new InvalidServerSettingError('invalid sub2api_group_config schema')
    console.warn('[settings] invalid sub2api_group_config; using env mapping')
    return {}
  }
}
