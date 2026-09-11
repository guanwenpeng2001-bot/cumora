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

interface PricingSeed extends ModelPrice {
  model: string
  note: string
  sourceUrl: string
  pricedAt: string
}

const CHECKED_AT = '2026-09-11'
const OPENAI = 'https://developers.openai.com/api/docs/pricing'
const ALIBABA = 'https://www.alibabacloud.com/help/en/model-studio/model-pricing'
const DEEPSEEK = 'https://api-docs.deepseek.com/quick_start/pricing/'
const CLAUDE = 'https://platform.claude.com/docs/en/about-claude/pricing'
const GOOGLE = 'https://ai.google.dev/gemini-api/docs/pricing'
const MINIMAX = 'https://platform.minimax.io/docs/guides/pricing-paygo'
const ZHIPU = 'https://docs.z.ai/guides/overview/pricing'
const XAI = 'https://docs.x.ai/developers/pricing'

// One reference menu for both cold-start lookup and the existing DB seed path.
// USD, standard online API rates; no batch, subscription or reseller discounts.
// Context/time tiers remain documented in notes. Native units are snapshotted
// with the price and ledger extras without changing historical token columns.
function tokenSeed(model: string, input: number, cached: number, write: number, output: number,
  sourceUrl: string, note = '标准在线 API；缓存写入未单列时按普通输入估算'): PricingSeed {
  return { model, inPer1M: input, cachedInPer1M: cached, cacheWritePer1M: write, outPer1M: output,
    sourceUrl, pricedAt: CHECKED_AT, note, verified: false }
}
// Structured USD reference rates transcribed from the existing y9 official seed notes.
const MEDIA_USD: Record<string, number> = {
  'qwen3-asr-flash': 0.000032, 'qwen3-asr-flash-filetrans': 0.000032,
  'qwen3-asr-flash-realtime': 0.000047, 'fun-asr': 0.000032,
  'fun-asr-mtl': 0.000032, 'fun-asr-realtime': 0.000047, 'whisper-1': 0.0001,
  'qwen-image-max': 0.071677, 'qwen-image-2.0-pro': 0.071676,
  'qwen-image-2.0': 0.028671, 'qwen-image-plus': 0.028671, 'qwen-image': 0.035,
  'wan2.7-image-pro': 0.068761, 'wan2.7-image': 0.027504, 'wan2.6-image': 0.028671,
}
function mediaSeed(model: string, unit: 'second' | 'image' | 'modality-token', note: string, sourceUrl = ALIBABA): PricingSeed {
  const usdPerUnit = MEDIA_USD[model]
  return { ...tokenSeed(model, 0, 0, 0, 0, sourceUrl, `[unit:${unit}] ${note}；按备注北京参考档估算，非免费`),
    ...(unit !== 'modality-token' && usdPerUnit !== undefined ? { unit, usdPerUnit }
      : { unpriced: 'media-tier-pricing-unavailable' }) }
}
const DEEPSEEK_NOTE = '峰时参考：周一至周五 UTC 01–04/06–10；谷时输入/缓存/输出减半；缓存写入按普通输入估算'
const GOOGLE_NOTE = '标准文本价；2026-12-31 前促销，2027-01-01 起输入/缓存/输出翻倍；缓存存储 $0.50/M token/小时另计，写入按输入估算'
const PRICING_SEED: PricingSeed[] = [
  tokenSeed('gpt-6-astra', 10, 1, 12.5, 50, OPENAI, '标准价，输入≤272K；长上下文输入/缓存/写入×2，输出×1.5'),
  tokenSeed('gpt-5.6-sol', 4, 0.4, 5, 20, OPENAI, '标准短上下文价；促销至少至2026-11-21；长上下文输入/缓存/写入×2，输出×1.5'),
  tokenSeed('gpt-5.6-terra', 2, 0.2, 2.5, 12, OPENAI, '标准短上下文价；长上下文输入/缓存/写入×2，输出×1.5'),
  tokenSeed('gpt-5.6-luna', 0.2, 0.02, 0.25, 1.2, OPENAI, '标准短上下文价；长上下文输入/缓存/写入×2，输出×1.5'),
  tokenSeed('gpt-5.5', 5, 0.5, 5, 30, 'https://developers.openai.com/api/docs/models/gpt-5.5', '标准价，输入≤272K；长上下文输入×2/输出×1.5；缓存写入按普通输入估算'),
  tokenSeed('gpt-5.4-mini', 0.75, 0.075, 0.75, 4.5, 'https://developers.openai.com/api/docs/models/gpt-5.4-mini'),
  tokenSeed('text-embedding-3-small', 0.02, 0, 0, 0, 'https://developers.openai.com/api/docs/models/text-embedding-3-small', '仅输入计费；无缓存/输出计费'),
  tokenSeed('deepseek-flash', 0.3, 0.006, 0.3, 1.2, DEEPSEEK, DEEPSEEK_NOTE),
  tokenSeed('deepseek-v4-flash', 0.3, 0.006, 0.3, 1.2, DEEPSEEK, `官方已映射 DeepSeek-V4.1-Flash；${DEEPSEEK_NOTE}`),
  tokenSeed('deepseek-v4-flash-vision-exp', 0.3, 0.006, 0.3, 1.2, DEEPSEEK, `官方已映射 DeepSeek-V4.1-Flash；${DEEPSEEK_NOTE}`),
  tokenSeed('deepseek-v4-pro', 1.32, 0.044, 1.32, 3.96, DEEPSEEK, `${DEEPSEEK_NOTE}；2026-09-14 北京12:00起官方将改为Flash价，需复核种子`),
  tokenSeed('claude-opus-4-1', 15, 1.5, 18.75, 75, CLAUDE, 'Opus 4.1；5分钟缓存写入；仅存量云平台提供'),
  tokenSeed('claude-opus', 5, 0.5, 6.25, 25, CLAUDE, 'Opus 4.5–4.8兼容档；5分钟缓存写入'),
  tokenSeed('claude-sonnet', 3, 0.3, 3.75, 15, CLAUDE, 'Sonnet 4.5/4.6兼容档；5分钟缓存写入'),
  tokenSeed('claude-haiku', 1, 0.1, 1.25, 5, CLAUDE, 'Haiku 4.5兼容档；5分钟缓存写入'),
  tokenSeed('claude-opus-5', 5, 0.5, 6.25, 25, CLAUDE, '标准价；5分钟缓存写入'),
  tokenSeed('claude-sonnet-5', 2, 0.2, 2.5, 10, CLAUDE, '标准价；5分钟缓存写入'),
  tokenSeed('claude-fable-5', 10, 1, 12.5, 50, CLAUDE, '标准价；5分钟缓存写入'),
  tokenSeed('claude-fable-5-1', 10, 0.25, 12.5, 50, CLAUDE, '标准价；5分钟缓存写入'),
  tokenSeed('claude-mythos-5', 10, 1, 12.5, 50, CLAUDE, '限量供应；5分钟缓存写入'),
  tokenSeed('claude-mythos-5-1', 10, 0.25, 12.5, 50, CLAUDE, '限量供应；5分钟缓存写入'),
  tokenSeed('gemini-3.8-flash', 0.75, 0.075, 0.75, 3.75, GOOGLE, GOOGLE_NOTE),
  tokenSeed('gemini-3.7-flash', 0.75, 0.075, 0.75, 3.75, GOOGLE, GOOGLE_NOTE),
  tokenSeed('gemini-3.1-pro-preview', 2, 0.2, 2, 12, GOOGLE, '标准价，输入≤200K；长上下文输入/缓存×2，输出×1.5；缓存存储$4.50/M token/小时另计；写入按输入估算'),
  tokenSeed('gemini-2.5-pro', 1.25, 0.125, 1.25, 10, GOOGLE, '标准价，输入≤200K；长上下文输入/缓存×2，输出×1.5；缓存存储$4.50/M token/小时另计；写入按输入估算'),
  tokenSeed('gemini-2.5-flash-lite', 0.1, 0.01, 0.1, 0.4, GOOGLE, '标准文本/图片/视频价；音频输入$0.30/M；缓存存储$1/M token/小时另计；写入按输入估算'),
  tokenSeed('grok-4.6', 2, 0.5, 2, 6, XAI, '标准价，输入<200K；≥200K输入/缓存/输出×2；写入按输入估算'),
  tokenSeed('grok-4.5', 2, 0.3, 2, 6, XAI, '标准价，输入<200K；≥200K输入/缓存/输出×2；写入按输入估算'),
  tokenSeed('grok-4.3', 1.25, 0.2, 1.25, 2.5, XAI, '标准价，输入<200K；≥200K输入/缓存/输出×2；写入按输入估算'),
  tokenSeed('minimax-m3', 0.3, 0.06, 0.3, 1.2, MINIMAX, '标准价，输入≤512K；>512K输入/缓存/输出×2；写入按输入估算'),
  tokenSeed('minimax-m2.7', 0.3, 0.06, 0.375, 1.2, MINIMAX),
  tokenSeed('minimax-m2.7-highspeed', 0.6, 0.06, 0.375, 2.4, MINIMAX),
  tokenSeed('minimax-m2.5', 0.3, 0.03, 0.375, 1.2, MINIMAX),
  tokenSeed('minimax-m2.5-highspeed', 0.6, 0.03, 0.375, 2.4, MINIMAX),
  tokenSeed('minimax-m2.1', 0.3, 0.03, 0.375, 1.2, MINIMAX),
  tokenSeed('minimax-m2', 0.3, 0.03, 0.375, 1.2, MINIMAX),
  ...([
    ['glm-5.3-flash', 0.15, 0.03, 0.5], ['glm-5.3', 1.4, 0.26, 4.4],
    ['glm-5.2', 1.4, 0.26, 4.4], ['glm-5.1', 1.4, 0.26, 4.4],
    ['glm-5', 1, 0.2, 3.2], ['glm-4.7', 0.6, 0.11, 2.2],
    ['glm-4.7-flashx', 0.07, 0.01, 0.4], ['glm-4.6', 0.6, 0.11, 2.2],
    ['glm-4.5', 0.6, 0.11, 2.2], ['glm-4.5-air', 0.2, 0.03, 1.1],
    ['glm-4.7-flash', 0, 0, 0], ['glm-4.5-flash', 0, 0, 0],
  ] as const).map(([model, input, cached, output]) => tokenSeed(model, input, cached, 0, output, ZHIPU, 'Z.AI国际标准价；缓存写入限时免费')),
  tokenSeed('qwen-max', 0.345, 0.345, 0.345, 1.377, ALIBABA, '北京/中国内地；未公开缓存折扣，缓存读写按普通输入估算；非qwen3.8-max'),
  tokenSeed('qwen3-coder-plus', 0.574, 0.0574, 0.7175, 2.294, ALIBABA, '北京；输入≤32K基础档，长上下文阶梯另计；5分钟显式缓存读10%/写125%；隐式缓存读20%；缓存来源https://help.aliyun.com/zh/model-studio/context-cache'),
  tokenSeed('qwen3-coder-flash', 0.144, 0.0144, 0.18, 0.574, ALIBABA, '北京；输入≤32K基础档，长上下文阶梯另计；5分钟显式缓存读10%/写125%；隐式缓存读20%；缓存来源https://help.aliyun.com/zh/model-studio/context-cache'),
  tokenSeed('text-embedding-v4', 0.072, 0, 0, 0, ALIBABA, '北京；仅输入计费；新加坡$0.07/M token'),
  tokenSeed('kimi-k3', 3, 3, 3, 15, ALIBABA, '百炼国际代理价；月之暗面动态价表未能提取；缓存读写按输入估算；不能映射Kimi Code订阅别名k3'),
  tokenSeed('kimi-k2.7-code', 0.95, 0.95, 0.95, 4, ALIBABA, '百炼国际代理价；缓存读写按输入估算；不能映射kimi-for-coding订阅'),
  mediaSeed('qwen3-asr-flash', 'second', '北京输入CNY 0.00022/秒（国际站USD 0.000032/秒）；新加坡USD 0.000035/秒；输出免费'),
  mediaSeed('qwen3-asr-flash-filetrans', 'second', '北京输入CNY 0.00022/秒（USD 0.000032/秒）；新加坡USD 0.000035/秒；输出免费'),
  mediaSeed('qwen3-asr-flash-realtime', 'second', '北京输入CNY 0.00033/秒（USD 0.000047/秒）；新加坡USD 0.00009/秒；输出免费'),
  mediaSeed('fun-asr', 'second', '北京输入CNY 0.00022/秒（USD 0.000032/秒）；新加坡USD 0.000035/秒；输出免费'),
  mediaSeed('fun-asr-mtl', 'second', '北京输入CNY 0.00022/秒（USD 0.000032/秒）；新加坡USD 0.000035/秒；输出免费'),
  mediaSeed('fun-asr-realtime', 'second', '北京输入CNY 0.00033/秒（USD 0.000047/秒）；新加坡USD 0.00009/秒；输出免费'),
  mediaSeed('whisper-1', 'second', '输入USD 0.006/分钟，即USD 0.0001/秒', 'https://developers.openai.com/api/docs/models/whisper-1'),
  mediaSeed('qwen-image-max', 'image', '输出北京USD 0.071677/张；新加坡USD 0.075/张；输入免费'),
  mediaSeed('qwen-image-2.0-pro', 'image', '输出北京USD 0.071676/张；新加坡USD 0.075/张；输入免费'),
  mediaSeed('qwen-image-2.0', 'image', '输出北京USD 0.028671/张；新加坡USD 0.035/张；输入免费'),
  mediaSeed('qwen-image-plus', 'image', '输出北京USD 0.028671/张；新加坡USD 0.03/张；输入免费'),
  mediaSeed('qwen-image', 'image', '输出北京/新加坡USD 0.035/张；输入免费'),
  mediaSeed('wan2.7-image-pro', 'image', '输出北京USD 0.068761/张；新加坡USD 0.075/张；输入免费'),
  mediaSeed('wan2.7-image', 'image', '输出北京USD 0.027504/张；新加坡USD 0.03/张；输入免费'),
  mediaSeed('wan2.6-image', 'image', '输出北京USD 0.028671/张；新加坡USD 0.03/张；输入免费'),
  mediaSeed('z-image-turbo', 'image', '北京USD 0.01434/张（prompt_extend=false）或0.02868/张（true）；新加坡USD 0.015/0.03/张；输入免费'),
  mediaSeed('gpt-image-2', 'modality-token', '标准：文本输入/缓存USD 5/1.25每M token；图像输入/缓存/输出USD 8/2/30每M token；需区分模态，不能用合并token计价', OPENAI),
]

/** Copies keep callers from changing the seed used on the next server boot. */
export function modelPricingSeeds(): PricingSeed[] {
  return PRICING_SEED.map(s => ({ ...s }))
}
export function seedPriceFor(model: string): Readonly<ModelPrice> | null {
  const seed = PRICING_SEED.find(s => s.model === model)
  if (!seed) return null
  const { model: _model, ...price } = seed
  return Object.freeze(price)
}

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
let retryAfter = 0
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
    note: publicNote(r.note),
    unpriced: [r.input_per_1m, r.cached_input_per_1m, r.cache_write_per_1m, r.output_per_1m].every(n => Number(n) === 0)
      ? seedPriceFor(r.model.trim().toLowerCase())?.unpriced : undefined,
    sourceUrl: r.source_url, pricedAt: r.priced_at ? new Date(r.priced_at).toISOString().slice(0, 10) : null,
  }
  // Only untouched legacy media placeholders inherit unit rates.
  if (p.source === 'legacy' && [p.inPer1M, p.cachedInPer1M, p.cacheWritePer1M, p.outPer1M].every(n => n === 0)) {
    const seed = seedPriceFor(r.model.trim().toLowerCase())
    if (seed?.unit) Object.assign(p, { unit: seed.unit, usdPerUnit: seed.usdPerUnit,
      sourceUrl: seed.sourceUrl, pricedAt: seed.pricedAt, note: seed.note, unpriced: undefined })
  }
  if (!validModelPrice(p)) throw new Error(`Invalid model price: ${r.model}`)
  const version = priceVersion({ ...p, version: new Date(r.updated_at).toISOString() })
  return Object.freeze({ ...p, version })
}

/** Refresh failures and stale SELECTs cannot replace a newer edit or snapshot. */
export async function refreshModelPricing(force = false): Promise<void> {
  if (process.env.CUMORA_RUNTIME_CLIENT === 'http') return
  if (!force && (Date.now() < retryAfter || (snapshot && Date.now() - snapshotAt < REFRESH_MS))) return
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
      retryAfter = 0
    } catch (e) {
      if (sequence === refreshSequence) retryAfter = Date.now() + REFRESH_MS
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
      note: price.source === 'legacy' ? `${price.pricedAt === CHECKED_AT ? '官方刊例参考，按备注档位估算' : '兼容估算，非当前官方报价'}；${price.note ?? ''}` : price.note ?? null,
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
    snapshot = new Map(snapshot ?? []).set(row.model, price)
  })
  pendingEdit = edit.catch(() => {})
  await edit
}
