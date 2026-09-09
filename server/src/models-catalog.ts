/**
 * Available-models catalog for the settings page's model tab.
 *
 * Merges three sources, in priority order:
 *   1. sub2api live — what the caller's per-platform gateway keys can
 *      actually call right now (skipped silently when the gateway is
 *      unconfigured or the user isn't provisioned)
 *   2. BYOA computers — model catalogs reported by paired daemons
 *      (computers.detected_engines[].modelCatalog)
 *   3. configured settings — the current primaries + fallback chains
 *      (server_settings with env fallback), so a hand-typed model that's
 *      not in any live list is still selectable
 *
 * Bucketed by capability (text/image/audio/embedding) with a 5-minute cache.
 * The BYOA/configured portion is global; only the gateway portion is keyed by
 * user because it depends on that user's sub2api credentials.
 */
import { pool } from './db/pool.js'
import { SETTING_DEFS, getServerSetting, getServerSettingList } from './settings.js'
import { listKeyModels, parseApiKeyMap, sub2apiRoutingConfigured, sub2apiOpenAIBaseURL, SUB2API_PLATFORMS } from './sub2api.js'

export interface ModelCatalog {
  text: string[]
  image: string[]
  audio: string[]
  embedding: string[]
  /** False when the sub2api side contributed nothing — the UI shows the
   *  "gateway unavailable, env fallback" banner off this. */
  gateway: boolean
}

type Bucket = 'text' | 'image' | 'audio' | 'embedding'

function bucketOf(id: string): Bucket {
  const m = id.toLowerCase()
  if (/embed/.test(m)) return 'embedding'
  if (/asr|tts|speech|audio/.test(m)) return 'audio'
  if (/image|imagine|wan\d|z-image|flux|dall/.test(m)) return 'image'
  return 'text'
}

const CACHE_TTL_MS = 5 * 60_000
const globalCache: { models: Set<string>; at: number } = { models: new Set(), at: 0 }
const gatewayCache = new Map<string, { models: Set<string>; at: number }>()

export function invalidateModelCatalog(userId?: string): void {
  if (userId) gatewayCache.delete(userId)
  else {
    globalCache.models = new Set()
    globalCache.at = 0
    gatewayCache.clear()
  }
}

async function gatewayModels(userId: string): Promise<Set<string>> {
  const out = new Set<string>()
  if (!sub2apiRoutingConfigured()) return out
  const { rows } = await pool.query<{ sub2api_api_key: string | null }>(
    `SELECT sub2api_api_key FROM users WHERE id = $1`, [userId],
  )
  const keys = parseApiKeyMap(rows[0]?.sub2api_api_key)
  const base = sub2apiOpenAIBaseURL()
  await Promise.all(SUB2API_PLATFORMS.map(async (p) => {
    const key = keys[p]
    if (!key) return
    for (const m of await listKeyModels(base, key)) out.add(m)
  }))
  return out
}

async function byoaModels(): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const { rows } = await pool.query<{ detected_engines: unknown }>(
      `SELECT detected_engines FROM computers
        WHERE detected_engines IS NOT NULL AND revoked_at IS NULL`,
    )
    for (const row of rows) {
      const engines = row.detected_engines
      if (!Array.isArray(engines)) continue
      for (const e of engines) {
        const models = (e as { modelCatalog?: { models?: Array<{ id?: string }> } })?.modelCatalog?.models
        if (!Array.isArray(models)) continue
        for (const m of models) if (m?.id) out.add(m.id)
      }
    }
  } catch (e) {
    console.warn('[models] BYOA catalog read failed', e instanceof Error ? e.message : e)
  }
  return out
}

/** Configured models from settings (primaries + chains), so hand-written
 *  config stays selectable even when no live source lists it. */
function configuredModels(): Set<string> {
  const out = new Set<string>()
  for (const def of SETTING_DEFS) {
    // `*_model` primaries only — `*_fallback_models` keys don't match this
    // suffix and are collected below.
    if (!def.key.endsWith('_model')) continue
    const v = getServerSetting(def.key)
    if (v) out.add(v)
  }
  for (const key of ['brain_fallback_models', 'support_fallback_models', 'compaction_fallback_models', 'image_fallback_models', 'audio_fallback_models']) {
    for (const m of getServerSettingList(key)) out.add(m)
  }
  return out
}

export async function availableModels(userId: string, refresh: boolean): Promise<ModelCatalog> {
  const now = Date.now()
  const gatewayHit = !refresh ? gatewayCache.get(userId) : undefined
  const globalHit = !refresh && now - globalCache.at < CACHE_TTL_MS ? globalCache.models : null
  const [gateway, global] = await Promise.all([
    gatewayHit && now - gatewayHit.at < CACHE_TTL_MS ? gatewayHit.models : gatewayModels(userId),
    globalHit ?? Promise.all([byoaModels(), Promise.resolve(configuredModels())]).then(([byoa, configured]) => {
      const models = new Set<string>([...byoa, ...configured])
      globalCache.models = models
      globalCache.at = Date.now()
      return models
    }),
  ])
  if (!gatewayHit || now - gatewayHit.at >= CACHE_TTL_MS || refresh) {
    gatewayCache.set(userId, { models: gateway, at: Date.now() })
  }
  const catalog: ModelCatalog = { text: [], image: [], audio: [], embedding: [], gateway: gateway.size > 0 }
  const buckets: Record<Bucket, Set<string>> = { text: new Set(), image: new Set(), audio: new Set(), embedding: new Set() }
  for (const source of [gateway, global]) {
    for (const m of source) buckets[bucketOf(m)].add(m)
  }
  for (const b of ['text', 'image', 'audio', 'embedding'] as const) {
    catalog[b] = [...buckets[b]].sort()
  }
  return catalog
}
