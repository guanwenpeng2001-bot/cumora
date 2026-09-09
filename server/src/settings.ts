/**
 * Server-wide model settings — runtime-editable, no restart.
 *
 * Storage: `server_settings` key-value table (migration 0007). Read side
 * is a sync in-memory snapshot with a 30s refresh; write side upserts and
 * invalidates immediately. Every key falls back to its env var when the
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
import { pool } from './db/pool.js'
import { env } from './env.js'

export interface SettingDef {
  key: string
  /** Env fallback when the DB has no row. */
  envValue: () => string
}

/** The full key inventory. Values are always stored as strings; list-typed
 *  keys are comma-separated. */
export const SETTING_DEFS: readonly SettingDef[] = [
  { key: 'brain_model',                 envValue: () => env.OPENAI_MODEL },
  { key: 'brain_fallback_models',       envValue: () => '' },
  { key: 'support_model',               envValue: () => env.OPENAI_MODEL_SUPPORT },
  { key: 'support_fallback_models',     envValue: () => '' },
  { key: 'compaction_model',            envValue: () => env.OPENAI_COMPACTION_MODEL },
  { key: 'compaction_fallback_models',  envValue: () => '' },
  { key: 'image_model',                 envValue: () => env.OPENAI_IMAGE_MODEL },
  { key: 'image_fallback_models',       envValue: () => process.env.OPENAI_IMAGE_FALLBACK_MODELS ?? '' },
  { key: 'audio_model',                 envValue: () => process.env.OPENAI_AUDIO_MODEL ?? '' },
  { key: 'audio_fallback_models',       envValue: () => process.env.OPENAI_AUDIO_FALLBACK_MODELS ?? '' },
  { key: 'embed_model',                 envValue: () => process.env.OPENAI_EMBED_MODEL ?? '' },
  { key: 'agent_reasoning_effort',      envValue: () => process.env.CUMORA_REASONING_EFFORT ?? 'low' },
  { key: 'agent_max_output_tokens',     envValue: () => process.env.CUMORA_AGENT_MAX_OUTPUT_TOKENS ?? '4000' },
  { key: 'support_reasoning_effort',    envValue: () => process.env.CUMORA_SUPPORT_REASONING_EFFORT ?? 'low' },
  { key: 'support_reasoning_headroom',  envValue: () => process.env.CUMORA_SUPPORT_REASONING_HEADROOM ?? '0' },
  // Not a model — the skills tab's local hub directory.
  { key: 'local_skillhub_path',         envValue: () => process.env.LOCAL_SKILLHUB_PATH ?? '' },
]

const KNOWN_KEYS = new Set(SETTING_DEFS.map((d) => d.key))

/** Exported for the HTTP layer's 400 validation; writeServerSettings
 *  re-checks as defense in depth. */
export const KNOWN_SETTING_KEYS: ReadonlySet<string> = KNOWN_KEYS

const REFRESH_MS = 30_000

let snapshot: Map<string, string> | null = null
let snapshotAt = 0
let refreshing: Promise<void> | null = null

async function loadFromDb(): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ key: string; value: string }>(`SELECT key, value FROM server_settings`)
  return new Map(rows.map((r) => [r.key, r.value]))
}

/** Refresh the snapshot. Concurrent calls coalesce; failures keep the
 *  previous snapshot (env fallback still applies per key). */
export async function refreshServerSettings(force = false): Promise<void> {
  if (!force && snapshot && Date.now() - snapshotAt < REFRESH_MS) return
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      snapshot = await loadFromDb()
      snapshotAt = Date.now()
    } catch (e) {
      // DB down / table missing during boot races — keep serving env values.
      console.warn('[settings] refresh failed; serving previous/env values', e instanceof Error ? e.message : e)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/** Sync read: DB value when present, else the env fallback. Triggers a
 *  background refresh when the snapshot is empty or stale. */
export function getServerSetting(key: string): string {
  if (!snapshot || Date.now() - snapshotAt >= REFRESH_MS) void refreshServerSettings()
  const v = snapshot?.get(key)
  if (v !== undefined) return v
  const def = SETTING_DEFS.find((d) => d.key === key)
  return def ? def.envValue() : ''
}

/** List-typed read: comma-separated → trimmed string array. */
export function getServerSettingList(key: string): string[] {
  return getServerSetting(key).split(',').map((s) => s.trim()).filter(Boolean)
}

/** First-boot seed: copy env values into the table, never overwriting
 *  existing rows (operator edits win over later .env changes). */
export async function seedServerSettingsFromEnv(): Promise<void> {
  await pool.query(
    `INSERT INTO server_settings (key, value)
     SELECT * FROM jsonb_each_text($1::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d.envValue()])))],
  )
}

/** Boot hook: seed + warm the snapshot. */
export async function initServerSettings(): Promise<void> {
  await seedServerSettingsFromEnv()
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

/** Write path (settings API). Unknown keys are rejected. Invalidates the
 *  snapshot immediately so the next read sees the write. */
export async function writeServerSettings(entries: Record<string, string>): Promise<void> {
  const rows = Object.entries(entries)
  for (const [key] of rows) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`unknown setting key: ${key}`)
  }
  for (const [key, value] of rows) {
    await pool.query(
      `INSERT INTO server_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    )
  }
  await refreshServerSettings(true)
}
