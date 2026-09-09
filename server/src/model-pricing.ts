/**
 * model_pricing table loader + first-boot seed. The table is the
 * operator-editable price menu behind the usage dashboard; cost.ts's
 * priceFor() consults it (30s snapshot) between the env override and the
 * hardcoded seeds, so price corrections take effect without a restart.
 *
 * Rates are per 1M tokens (USD, list prices). Everything seeded here is a
 * public list price — still reported as `estimated` because the operator's
 * actual contracted rate may differ; only CUMORA_MODEL_PRICES_JSON env
 * overrides count as verified (see cost.ts). Per-image / per-second models
 * carry zeros + a note; their usage isn't token-metered.
 */
import { pool } from './db/pool.js'
import type { ModelPrice } from './agents/cost.js'

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

// Sources: provider official pricing pages, checked 2026-09-09.
// - DeepSeek V4: platform.deepseek.com pricing docs (V4-Flash $0.14/$0.28,
//   V4-Pro $0.435/$0.87 list; cache-hit ≈ 0.1× input, cache-write ≈ 1.25× input)
// - Kimi k3 / kimi-for-coding: subscription (Kimi Code plan) — no metered rate;
//   reference meter-equivalent is the published kimi-k2.7-code list
//   ($0.95/$4.00, cached $0.19), marked by note
// - DashScope image/ASR are per-image / per-second billed — zeros + note
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

/** First-boot seed. Existing rows win (operator edits survive redeploys). */
export async function seedModelPricing(): Promise<void> {
  for (const s of PRICING_SEED) {
    await pool.query(
      `INSERT INTO model_pricing (model, input_per_1m, cached_input_per_1m, cache_write_per_1m, output_per_1m, note, source_url, priced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (model) DO NOTHING`,
      [s.model, s.inPer1M, s.cachedInPer1M, s.cacheWritePer1M, s.outPer1M, s.note ?? null, s.sourceUrl, s.pricedAt],
    )
  }
}

interface DbRow {
  model: string; input_per_1m: number; cached_input_per_1m: number
  cache_write_per_1m: number; output_per_1m: number
  note: string | null; source_url: string | null
  priced_at: Date | string | null; updated_at: Date | string
}

let snapshot: Map<string, ModelPrice> | null = null
let snapshotAt = 0
const REFRESH_MS = 30_000

/** Refresh the DB price snapshot. Failures keep the previous snapshot. */
export async function refreshModelPricing(force = false): Promise<void> {
  if (!force && snapshot && Date.now() - snapshotAt < REFRESH_MS) return
  try {
    const { rows } = await pool.query<DbRow>(`SELECT * FROM model_pricing`)
    snapshot = new Map(rows.map((r) => [r.model, {
      inPer1M: Number(r.input_per_1m),
      cachedInPer1M: Number(r.cached_input_per_1m),
      cacheWritePer1M: Number(r.cache_write_per_1m),
      outPer1M: Number(r.output_per_1m),
    }]))
    snapshotAt = Date.now()
  } catch (e) {
    console.warn('[pricing] refresh failed; serving previous snapshot', e instanceof Error ? e.message : e)
  }
}

/** DB override consulted by cost.ts priceFor (between env overrides and
 *  hardcoded seeds). Returns null when absent/unknown. */
export function dbPriceFor(model: string): ModelPrice | null {
  if (!snapshot || Date.now() - snapshotAt >= REFRESH_MS) void refreshModelPricing()
  if (!snapshot) return null
  const id = model.toLowerCase().trim()
  if (!id) return null
  const direct = snapshot.get(id)
  if (direct) return direct
  for (const [key, price] of snapshot) {
    if (id === key || id.includes(key) || key.includes(id)) return price
  }
  return null
}

/** Full menu for the dashboard's pricing reference / admin edit. */
export async function modelPricingTable(): Promise<ModelPricingRow[]> {
  const { rows } = await pool.query<DbRow>(`SELECT * FROM model_pricing ORDER BY model`)
  return rows.map((r) => ({
    model: r.model,
    inPer1M: Number(r.input_per_1m),
    cachedInPer1M: Number(r.cached_input_per_1m),
    cacheWritePer1M: Number(r.cache_write_per_1m),
    outPer1M: Number(r.output_per_1m),
    note: r.note,
    sourceUrl: r.source_url,
    pricedAt: r.priced_at ? new Date(r.priced_at).toISOString().slice(0, 10) : null,
    updatedAt: new Date(r.updated_at).toISOString(),
  }))
}

/** Admin edit: upsert one row. */
export async function upsertModelPricing(row: Omit<ModelPricingRow, 'updatedAt'>): Promise<void> {
  await pool.query(
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
       updated_at = NOW()`,
    [row.model, row.inPer1M, row.cachedInPer1M, row.cacheWritePer1M, row.outPer1M, row.note, row.sourceUrl, row.pricedAt],
  )
  await refreshModelPricing(true)
}
