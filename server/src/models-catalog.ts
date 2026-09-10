import { pool } from './db/pool.js'
import { SETTING_DEFS, getServerSetting, getServerSettingList, getServerSettingsSnapshot, parseLlmConfig } from './settings.js'
import { SUB2API_PLATFORMS, type Platform, type KeyModelsResult } from './sub2api.js'
import { TenantLlmAccessError, resolveTenantLlmContext, tenantModelSnapshot, invalidateTenantModelSnapshot } from './tenant-llm-context.js'

export interface ModelCatalog {
  text: string[]
  image: string[]
  audio: string[]
  embedding: string[]
  /** Compatibility flag: discovery succeeded or retained a same-version snapshot. */
  gateway: boolean
  platforms?: Partial<Record<Platform, { status: KeyModelsResult['status']; stale: boolean; models: string[]; diagnostic?: KeyModelsResult['diagnostic'] }>>
  byoa?: Array<{ companyId: string; computerId: string; engine: string; models: string[] }>
}

type Bucket = 'text' | 'image' | 'audio' | 'embedding'

function bucketOf(id: string): Bucket {
  const m = id.toLowerCase()
  if (/embed/.test(m)) return 'embedding'
  if (/asr|tts|speech|audio/.test(m)) return 'audio'
  if (/image|imagine|wan\d|z-image|flux|dall/.test(m)) return 'image'
  return 'text'
}

export function invalidateModelCatalog(companyId?: string): void {
  invalidateTenantModelSnapshot(companyId)
}

async function byoaModels(companyId: string, computerId?: string, engine?: string): Promise<NonNullable<ModelCatalog['byoa']>> {
  const { rows } = await pool.query<{ id: string; detected_engines: unknown }>(
    `SELECT id, detected_engines FROM computers
      WHERE company_id = $1 AND revoked_at IS NULL AND kind <> 'cloud'
        AND ($2::text IS NULL OR id = $2)`, [companyId, computerId ?? null],
  )
  const out: NonNullable<ModelCatalog['byoa']> = []
  for (const row of rows) {
    if (!Array.isArray(row.detected_engines)) continue
    for (const e of row.detected_engines) {
      if (!e || typeof e.id !== 'string' || (engine && e.id !== engine)) continue
      const models = e.modelCatalog?.models
      if (!Array.isArray(models)) continue
      out.push({ companyId, computerId: row.id, engine: e.id, models: models.filter((m) => typeof m?.id === 'string' && m.id).map((m) => m.id) })
    }
  }
  return out
}

/** Configured models from settings (primaries + chains), so hand-written
 *  config stays selectable even when no live source lists it. */
function configuredModels(): Set<string> {
  const config = parseLlmConfig(getServerSettingsSnapshot().settings.llm_config ?? '')
  const out = new Set<string>([...config.models.map(m => m.model), ...config.roles.flatMap(r => [...r.models, ...(r.directTargets ?? []).map(t => t.model)])])
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

export async function availableModels(userId: string, refresh: boolean, companyId?: string, computerId?: string, engine?: string): Promise<ModelCatalog> {
  // Preserve callers that omit company, using the same oldest-membership default as the API.
  if (!companyId) {
    const { rows } = await pool.query<{ company_id: string }>(
      'SELECT company_id FROM company_members WHERE user_id = $1 ORDER BY joined_at ASC LIMIT 1', [userId],
    )
    companyId = rows[0]?.company_id
  }
  if (!companyId) throw new TenantLlmAccessError('No company membership')
  const context = await resolveTenantLlmContext(companyId, userId)
  const [snapshot, byoa] = await Promise.all([
    tenantModelSnapshot(context, refresh), byoaModels(companyId, computerId, engine),
  ])
  // Recheck membership before releasing a potentially slow discovery response.
  const current = await resolveTenantLlmContext(companyId, userId)
  if (current.authorizationVersion !== snapshot.authorizationVersion) return availableModels(userId, refresh, companyId, computerId, engine)
  const catalog: ModelCatalog = { text: [], image: [], audio: [], embedding: [], gateway: false, platforms: {}, byoa }
  const config = parseLlmConfig(getServerSettingsSnapshot().settings.llm_config ?? '')
  const addModel = (model: string) => {
    const roles = config.models.find(m => m.model === model)?.roles ?? config.roles.filter(r => r.models.includes(model) || r.directTargets?.some(t => t.model === model)).map(r => r.role)
    const targets: Bucket[] = roles.length ? roles.map(r => r === 'embed' ? 'embedding' : r === 'image' || r === 'audio' ? r : 'text') : [bucketOf(model)]
    for (const target of targets) buckets[target].add(model)
  }
  const buckets: Record<Bucket, Set<string>> = { text: new Set(), image: new Set(), audio: new Set(), embedding: new Set() }
  for (const platform of SUB2API_PLATFORMS) {
    const result = snapshot.platforms[platform]
    catalog.platforms![platform] = { status: result.status, stale: result.stale, models: [...result.models].sort(), diagnostic: result.diagnostic }
    if (result.ok || result.stale) catalog.gateway = true
    for (const model of result.models) addModel(model)
  }
  for (const model of configuredModels()) addModel(model)
  for (const entry of byoa) for (const model of entry.models) addModel(model)
  for (const b of ['text', 'image', 'audio', 'embedding'] as const) catalog[b] = [...buckets[b]].sort()
  return catalog
}
