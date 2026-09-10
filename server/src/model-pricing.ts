/** Operator-editable token prices. Legacy rates survive the one-time env import.
 * Provenance lives in the existing note column; no historical ledger is repriced. */
import { pool } from './db/pool.js'
import { legacyEnvPrices, validModelPrice, priceVersion, type ModelPrice } from './agents/cost.js'

export interface ModelPricingRow extends ModelPrice {
  model: string
  note: string | null
  sourceUrl: string | null
  pricedAt: string | null
  updatedAt: string
}

interface PricingSeed {
  model: string
  inPer1M: number
  cachedInPer1M: number
  cacheWritePer1M: number
  outPer1M: number
  note?: string
  sourceUrl: string
  pricedAt: string
}

// Preserve the pre-T33 reference menu, not a claim of current official rates.
// Subscription equivalents and cache-write approximations remain estimates.
// Official references: https://developers.openai.com/api/docs/pricing,
// https://api-docs.deepseek.com/quick_start/pricing, https://platform.moonshot.ai/docs/pricing,
// https://help.aliyun.com/zh/model-studio/models. Admin edits select the applicable rate.
const PRICING_SEED: PricingSeed[] = [
  { model: 'k3', inPer1M: 0.95, cachedInPer1M: 0.19, cacheWritePer1M: 1.19, outPer1M: 4.0, note: '订阅制(Kimi Code)无单价;此为 k2.7-code 刊例等效参考', sourceUrl: 'https://platform.moonshot.ai/docs/pricing', pricedAt: '2026-09-09' },
  { model: 'kimi-for-coding', inPer1M: 0.95, cachedInPer1M: 0.19, cacheWritePer1M: 1.19, outPer1M: 4.0, note: '同上,订阅等效参考', sourceUrl: 'https://platform.moonshot.ai/docs/pricing', pricedAt: '2026-09-09' },
  { model: 'deepseek-v4-flash', inPer1M: 0.14, cachedInPer1M: 0.014, cacheWritePer1M: 0.175, outPer1M: 0.28, sourceUrl: 'https://platform.deepseek.com/docs/pricing', pricedAt: '2026-09-09' },
  { model: 'deepseek-v4-pro', inPer1M: 0.435, cachedInPer1M: 0.0435, cacheWritePer1M: 0.54, outPer1M: 0.87, sourceUrl: 'https://platform.deepseek.com/docs/pricing', pricedAt: '2026-09-09' },
  { model: 'gpt-5.5', inPer1M: 2.5, cachedInPer1M: 0.25, cacheWritePer1M: 2.5, outPer1M: 10, sourceUrl: 'https://openai.com/api/pricing', pricedAt: '2026-09-09' },
  { model: 'gpt-5.4-mini', inPer1M: 0.25, cachedInPer1M: 0.025, cacheWritePer1M: 0.25, outPer1M: 2, sourceUrl: 'https://openai.com/api/pricing', pricedAt: '2026-09-09' },
  { model: 'qwen-max', inPer1M: 2.5, cachedInPer1M: 0.25, cacheWritePer1M: 3.13, outPer1M: 7.5, note: '百炼刊例(qwen3.8-max 档)', sourceUrl: 'https://help.aliyun.com/zh/model-studio/models', pricedAt: '2026-09-09' },
  { model: 'text-embedding-v4', inPer1M: 0.05, cachedInPer1M: 0, cacheWritePer1M: 0, outPer1M: 0, sourceUrl: 'https://help.aliyun.com/zh/model-studio/models', pricedAt: '2026-09-09' },
  { model: 'qwen-image-max', inPer1M: 0, cachedInPer1M: 0, cacheWritePer1M: 0, outPer1M: 0, note: '图像按张计费,非 token 计量', sourceUrl: 'https://help.aliyun.com/zh/model-studio/models', pricedAt: '2026-09-09' },
  { model: 'qwen3-asr-flash', inPer1M: 0, cachedInPer1M: 0, cacheWritePer1M: 0, outPer1M: 0, note: 'ASR 按时长计费,非 token 计量', sourceUrl: 'https://help.aliyun.com/zh/model-studio/models', pricedAt: '2026-09-09' },
]

const NOTE_PREFIX = '[cumora-pricing:v1:'
const noteFor = (kind: 'env' | 'legacy' | 'admin', note: string | null): string =>
  `${NOTE_PREFIX}${kind}]${note ?? ''}`
const publicNote = (note: string | null): string | null =>
  note?.replace(/^\[cumora-pricing:v1:(?:env|legacy|admin)\]/, '') || null

/** Import effective env rates once. A persisted marker prevents later boots
 * from undoing admin edits; existing non-env prices are never overwritten. */
export async function seedModelPricing(): Promise<void> {
  for (const [model, p] of Object.entries(legacyEnvPrices())) {
    await pool.query(
      `INSERT INTO model_pricing (model, input_per_1m, cached_input_per_1m, cache_write_per_1m, output_per_1m, note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (model) DO UPDATE SET
         input_per_1m = EXCLUDED.input_per_1m, cached_input_per_1m = EXCLUDED.cached_input_per_1m,
         cache_write_per_1m = EXCLUDED.cache_write_per_1m, output_per_1m = EXCLUDED.output_per_1m,
         note = EXCLUDED.note || COALESCE(model_pricing.note, ''), source_url = NULL, priced_at = NULL,
         updated_at = NOW()
       WHERE COALESCE(model_pricing.note, '') NOT LIKE '[cumora-pricing:v1:%'`,
      [model, p.inPer1M, p.cachedInPer1M, p.cacheWritePer1M, p.outPer1M, noteFor('env', null)],
    )
  }
  for (const s of PRICING_SEED) {
    await pool.query(
      `INSERT INTO model_pricing (model, input_per_1m, cached_input_per_1m, cache_write_per_1m, output_per_1m, note, source_url, priced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (model) DO NOTHING`,
      [s.model, s.inPer1M, s.cachedInPer1M, s.cacheWritePer1M, s.outPer1M,
        noteFor('legacy', s.note ?? null), s.sourceUrl, s.pricedAt],
    )
  }
  await refreshModelPricing(true)
}

interface DbRow {
  model: string; input_per_1m: number; cached_input_per_1m: number
  cache_write_per_1m: number; output_per_1m: number
  note: string | null; source_url: string | null
  priced_at: Date | string | null; updated_at: Date | string
}

let snapshot: Map<string, Readonly<ModelPrice>> | null = null
let snapshotAt = 0
let refreshSequence = 0
let installedSequence = 0
let editRevision = 0
let pendingRefresh: Promise<void> | null = null
const REFRESH_MS = 30_000

function dbRowPrice(r: DbRow): Readonly<ModelPrice> {
  const inheritedEnv = !r.note?.startsWith(NOTE_PREFIX) ? legacyEnvPrices()[r.model.trim().toLowerCase()] : null
  const p: ModelPrice = inheritedEnv ?? {
    inPer1M: Number(r.input_per_1m), cachedInPer1M: Number(r.cached_input_per_1m),
    cacheWritePer1M: Number(r.cache_write_per_1m), outPer1M: Number(r.output_per_1m),
    verified: r.note?.startsWith(noteFor('env', null)) === true,
    source: r.note?.startsWith(noteFor('admin', null)) ? 'database' : r.note?.startsWith(noteFor('env', null)) ? 'env' : 'legacy',
    sourceUrl: r.source_url, pricedAt: r.priced_at ? new Date(r.priced_at).toISOString().slice(0, 10) : null,
  }
  if (!validModelPrice(p)) throw new Error(`Invalid model price: ${r.model}`)
  const version = priceVersion({ ...p, version: new Date(r.updated_at).toISOString() })
  return Object.freeze({ ...p, version })
}

/** Refresh failures and stale SELECTs cannot replace a newer edit or snapshot. */
export async function refreshModelPricing(force = false): Promise<void> {
  if (!force && snapshot && Date.now() - snapshotAt < REFRESH_MS) return
  if (!force && pendingRefresh) return pendingRefresh
  const sequence = ++refreshSequence
  const revision = editRevision
  const refresh = (async () => {
    try {
      const { rows } = await pool.query<DbRow>(`SELECT * FROM model_pricing`)
      const next = new Map(rows.map(r => [r.model.trim().toLowerCase(), dbRowPrice(r)]))
      if (revision !== editRevision || sequence < installedSequence) return
      snapshot = next
      installedSequence = sequence
      snapshotAt = Date.now()
    } catch (e) {
      console.warn('[pricing] refresh failed; serving previous snapshot', e instanceof Error ? e.message : e)
    }
  })()
  pendingRefresh = refresh
  await refresh
  if (pendingRefresh === refresh) pendingRefresh = null
}

export function captureDbPricing(): (model: string) => Readonly<ModelPrice> | null {
  if (!snapshot || Date.now() - snapshotAt >= REFRESH_MS) void refreshModelPricing()
  const captured = snapshot
  return model => captured?.get(model.trim().toLowerCase()) ?? null
}

export function dbPriceFor(model: string): Readonly<ModelPrice> | null {
  return captureDbPricing()(model)
}

/** Full menu for the dashboard's pricing reference / admin edit. */
export async function modelPricingTable(): Promise<ModelPricingRow[]> {
  const { rows } = await pool.query<DbRow>(`SELECT * FROM model_pricing ORDER BY model`)
  return rows.map((r) => {
    const price = dbRowPrice(r)
    return {
      ...price, model: r.model,
      note: price.source === 'legacy' ? `兼容估算，非当前官方报价；${publicNote(r.note) ?? ''}` : publicNote(r.note),
      sourceUrl: price.sourceUrl ?? null, pricedAt: price.pricedAt ?? null,
      updatedAt: new Date(r.updated_at).toISOString(),
    }
  })
}

export function validateModelPricing(value: unknown): Omit<ModelPricingRow, 'updatedAt'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pricing object required')
  const b = value as Record<string, unknown>
  const model = typeof b.model === 'string' ? b.model.trim().toLowerCase() : ''
  if (!model) throw new Error('model required')
  const rate = (value: unknown): number => {
    if (value === undefined) return 0
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('rates must be non-negative numbers')
    return value
  }
  const nullableText = (value: unknown, name: string): string | null => {
    if (value === undefined || value === null || value === '') return null
    if (typeof value !== 'string') throw new Error(`${name} must be a string`)
    return value
  }
  const sourceUrl = nullableText(b.sourceUrl, 'sourceUrl')
  if (sourceUrl !== null) {
    let url: URL
    try { url = new URL(sourceUrl) } catch { throw new Error('sourceUrl must be an HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('sourceUrl must be an HTTP(S) URL')
  }
  const pricedAt = nullableText(b.pricedAt, 'pricedAt')
  if (pricedAt !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(pricedAt)
    || !Number.isFinite(Date.parse(pricedAt)) || new Date(pricedAt).toISOString().slice(0, 10) !== pricedAt)) {
    throw new Error('pricedAt must be a valid YYYY-MM-DD date')
  }
  return { model, inPer1M: rate(b.inPer1M), cachedInPer1M: rate(b.cachedInPer1M),
    cacheWritePer1M: rate(b.cacheWritePer1M), outPer1M: rate(b.outPer1M),
    note: nullableText(b.note, 'note'), sourceUrl, pricedAt }
}

let pendingEdit: Promise<void> = Promise.resolve()
/** Admin edits install their returned row before reporting success. */
export async function upsertModelPricing(input: Omit<ModelPricingRow, 'updatedAt'>): Promise<void> {
  const row = validateModelPricing(input)
  const edit = pendingEdit.then(async () => {
    const { rows } = await pool.query<DbRow>(
      `INSERT INTO model_pricing (model, input_per_1m, cached_input_per_1m, cache_write_per_1m, output_per_1m, note, source_url, priced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (model) DO UPDATE SET
         input_per_1m = EXCLUDED.input_per_1m,
         cached_input_per_1m = EXCLUDED.cached_input_per_1m,
         cache_write_per_1m = EXCLUDED.cache_write_per_1m,
         output_per_1m = EXCLUDED.output_per_1m,
         note = EXCLUDED.note,
         source_url = EXCLUDED.source_url,
         priced_at = EXCLUDED.priced_at,
         updated_at = NOW()
       RETURNING *`,
      [row.model, row.inPer1M, row.cachedInPer1M, row.cacheWritePer1M, row.outPer1M,
        noteFor('admin', row.note), row.sourceUrl, row.pricedAt],
    )
    const price = dbRowPrice(rows[0]!)
    editRevision++
    snapshot = new Map(snapshot).set(row.model, price)
  })
  pendingEdit = edit.catch(() => {})
  await edit
}
