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
import type { PoolClient } from 'pg'
import { pool } from './db/pool.js'
import { env } from './env.js'

export interface SettingDef {
  key: string
  type: 'model' | 'list' | 'string' | 'integer' | 'reasoning'
  required?: boolean
  /** Env fallback when the DB has no row. */
  envValue: () => string
}

/** The full key inventory. Values are always stored as strings; list-typed
 *  keys are comma-separated. */
export const SETTING_DEFS: readonly SettingDef[] = [
  { key: 'brain_model', type: 'model', required: true, envValue: () => env.OPENAI_MODEL ?? '' },
  { key: 'brain_fallback_models', type: 'list', envValue: () => '' },
  { key: 'support_model', type: 'model', required: true, envValue: () => env.OPENAI_MODEL_SUPPORT ?? '' },
  { key: 'support_fallback_models', type: 'list', envValue: () => '' },
  { key: 'compaction_model', type: 'model', required: true, envValue: () => env.OPENAI_COMPACTION_MODEL ?? '' },
  { key: 'compaction_fallback_models', type: 'list', envValue: () => '' },
  { key: 'image_model', type: 'model', required: true, envValue: () => env.OPENAI_IMAGE_MODEL ?? '' },
  { key: 'image_fallback_models', type: 'list', envValue: () => process.env.OPENAI_IMAGE_FALLBACK_MODELS ?? '' },
  { key: 'audio_model', type: 'model', required: true, envValue: () => process.env.OPENAI_AUDIO_MODEL ?? '' },
  { key: 'audio_fallback_models', type: 'list', envValue: () => process.env.OPENAI_AUDIO_FALLBACK_MODELS ?? '' },
  { key: 'embed_model', type: 'model', required: true, envValue: () => process.env.OPENAI_EMBED_MODEL ?? '' },
  { key: 'agent_reasoning_effort', type: 'reasoning', envValue: () => process.env.CUMORA_REASONING_EFFORT ?? 'low' },
  { key: 'agent_max_output_tokens', type: 'integer', envValue: () => process.env.CUMORA_AGENT_MAX_OUTPUT_TOKENS ?? '4000' },
  { key: 'support_reasoning_effort', type: 'reasoning', envValue: () => process.env.CUMORA_SUPPORT_REASONING_EFFORT ?? 'low' },
  { key: 'support_reasoning_headroom', type: 'integer', envValue: () => process.env.CUMORA_SUPPORT_REASONING_HEADROOM ?? '0' },
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
}

let snapshot: ServerSettingsSnapshot | null = null
let snapshotAt = 0
let lastRefreshFailureAt = 0
let refreshing: Promise<void> | null = null
let generation = 0
let writing: Promise<unknown> = Promise.resolve()

function makeSnapshot(rows: { key: string; value: string }[]): ServerSettingsSnapshot {
  const values = new Map(rows.map((r) => [r.key, r.value]))
  const revision = values.get(REVISION_KEY) ?? '0'
  if (!/^\d+$/.test(revision)) throw new Error('invalid settings revision')
  const settings: Record<string, string> = {}
  const sources: Record<string, 'db' | 'env'> = {}
  for (const def of SETTING_DEFS) {
    settings[def.key] = values.get(def.key) ?? def.envValue()
    sources[def.key] = values.has(def.key) ? 'db' : 'env'
  }
  return Object.freeze({ revision, settings: Object.freeze(settings), sources: Object.freeze(sources) })
}

function installSnapshot(next: ServerSettingsSnapshot): void {
  if (snapshot && BigInt(next.revision) < BigInt(snapshot.revision)) return
  snapshot = next
  snapshotAt = Date.now()
  lastRefreshFailureAt = 0
}

/** Forced refreshes wait for older queries, then perform their own read. */
export async function refreshServerSettings(force = false): Promise<void> {
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
      const { rows } = await pool.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
      const next = makeSnapshot(rows)
      if (startedGeneration === generation) installSnapshot(next)
    } catch (e) {
      if (startedGeneration === generation) lastRefreshFailureAt = Date.now()
      console.warn('[settings] refresh failed; serving previous/env values', e instanceof Error ? e.message : e)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export function getServerSettingsSnapshot(): ServerSettingsSnapshot {
  if (!snapshot || Date.now() - snapshotAt >= REFRESH_MS) void refreshServerSettings()
  return snapshot ?? makeSnapshot([])
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
export function startServerSettingsRefresher(): void {
  setInterval(() => void refreshServerSettings(true), REFRESH_MS).unref()
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
    if (def.type === 'integer' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || (key === 'agent_max_output_tokens' && Number(value) === 0))) {
      throw new InvalidServerSettingError('invalid integer setting: ' + key)
    }
    if (def.type === 'reasoning' && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
      throw new InvalidServerSettingError('invalid reasoning setting: ' + key)
    }
  }
}

function commitSettings(mutate: (client: PoolClient) => Promise<void>): Promise<ServerSettingsSnapshot> {
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
  const rows = Object.entries(entries)
  return commitSettings(async (client) => {
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
