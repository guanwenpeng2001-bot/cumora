/**
 * Token → cost accounting for the triage cost-effectiveness measurement.
 *
 * The whole point of this module is to compare, HONESTLY, the cost of a small-
 * brain triage against the big-brain turn it shields. That comparison is only
 * fair when it is CACHE-AWARE: a triage runs in a fresh, cold session so EVERY
 * input token is billed at the full (uncached) rate, whereas a persistent big-
 * brain session reads most of its input from the prompt cache at ~0.1× the
 * price. So a "saving" can secretly be a loss. We price each tier separately.
 *
 * Prices are per 1M tokens, in USD, list prices. For BYOA agents the operator
 * pays a flat-rate subscription, so the dollar figure here is "meter-equivalent"
 * — what the same computation WOULD cost on the metered API — which is the
 * honest basis for "is this triage worth it". Override real contracted rates via
 * the editable DB menu (legacy CUMORA_MODEL_PRICES_JSON imports once); only
 * legacy operator-contracted env rates count as `verified` — every seeded default is reported as an estimate.
 */

/** A cache-aware token breakdown for one model call. All counts are the RAW
 *  (uncached) counts as the provider reports them: `inputTokens` excludes the
 *  cached portion; `cachedInputTokens` is the cache-READ portion (cheap);
 *  `cacheCreationTokens` is the cache-WRITE portion (a premium over input). */
import { captureDbPricing, modelPricingSeeds, seedPriceFor } from '../model-pricing.js'
import { createHash } from 'node:crypto'

import type { TokenUsage } from './token-usage.js'
export { type TokenUsage, EMPTY_USAGE, usageFromOpenAI, measuredUsage, usageFromClaude, addUsage, hasUsage } from './token-usage.js'

export interface ModelPrice {
  inPer1M: number
  cachedInPer1M: number
  cacheWritePer1M: number
  outPer1M: number
  /** true only for prices supplied by the operator (env override) — a real
   *  contracted rate. Seeded defaults are estimates and report `estimated`. */
  verified?: boolean
  source?: 'env' | 'database' | 'legacy' | 'compatibility'
  sourceUrl?: string | null
  pricedAt?: string | null
  note?: string | null
  version?: string
  matchedModel?: string
  match?: 'exact' | 'route' | 'alias' | 'fallback'
  unit?: 'second' | 'image'
  usdPerUnit?: number
  unpriced?: string
}

// Official seed provenance and native-unit media notes live in model-pricing.ts.
// Published list prices remain estimates for subscriptions and reseller routes.
// Unknown models have no billable rate; preserve the missing-price reason.
const FALLBACK_PRICE: ModelPrice = { inPer1M: 0, cachedInPer1M: 0, cacheWritePer1M: 0, outPer1M: 0, verified: false, unpriced: 'no-price' }

export function validModelPrice(value: unknown): value is ModelPrice {
  if (!value || typeof value !== 'object') return false
  const p = value as ModelPrice
  if (p.unit !== undefined && (!['second', 'image'].includes(p.unit) || typeof p.usdPerUnit !== 'number' || !Number.isFinite(p.usdPerUnit) || p.usdPerUnit < 0)) return false
  return [p.inPer1M, p.cachedInPer1M, p.cacheWritePer1M, p.outPer1M]
    .every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
}

export function priceVersion(price: ModelPrice): string {
  return createHash('sha256').update(JSON.stringify(price)).digest('hex')
}

let cachedEnvSource: string | undefined
let cachedEnvPrices: Record<string, ModelPrice> = Object.freeze(Object.create(null))

/** Cache by env contents: setting/env refreshes invalidate on the next read,
 * while previously captured calls retain their immutable price map. */
export function legacyEnvPrices(): Record<string, ModelPrice> {
  const source = process.env.CUMORA_MODEL_PRICES_JSON ?? '{}'
  if (source === cachedEnvSource) return cachedEnvPrices
  const result: Record<string, ModelPrice> = Object.create(null)
  cachedEnvSource = source
  cachedEnvPrices = Object.freeze(Object.create(null))
  try {
    const parsed: unknown = JSON.parse(source)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return cachedEnvPrices
    for (const [key, value] of Object.entries(parsed)) {
      const id = key.trim().toLowerCase()
      if (!id || !value || typeof value !== 'object' || Array.isArray(value)) continue
      const raw = value as Record<string, unknown>
      const rate = (v: unknown): number => v == null ? 0
        : typeof v === 'number' || (typeof v === 'string' && v.trim()) ? Number(v) : NaN
      const price = { inPer1M: rate(raw.inPer1M), cachedInPer1M: rate(raw.cachedInPer1M),
        cacheWritePer1M: rate(raw.cacheWritePer1M), outPer1M: rate(raw.outPer1M) }
      if (!validModelPrice(price)) continue
      result[id] = Object.freeze({ ...price, verified: true, source: 'env' })
    }
  } catch (err) {
    console.warn('[cost] CUMORA_MODEL_PRICES_JSON is not valid JSON — ignoring:', err instanceof Error ? err.message : err)
  }
  cachedEnvPrices = Object.freeze(result)
  return cachedEnvPrices
}

// Explicit compatibility aliases only; unknown suffixes never inherit a tier price.
const PRICE_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku', sonnet: 'claude-sonnet', opus: 'claude-opus',
  'claude-haiku-4-5': 'claude-haiku', 'claude-haiku-4-5-20251001': 'claude-haiku',
  'claude-sonnet-4-5': 'claude-sonnet', 'claude-sonnet-4-5-20250929': 'claude-sonnet',
  'claude-sonnet-4-6': 'claude-sonnet',
  'claude-opus-4-5': 'claude-opus', 'claude-opus-4-6': 'claude-opus',
  'claude-opus-4-7': 'claude-opus', 'claude-opus-4-8': 'claude-opus',
  'claude-opus-4-1-20250805': 'claude-opus-4-1',
  'claude-opus-4-6-thinking': 'claude-opus',
  'gemini-3.8-flash-high': 'gemini-3.8-flash',
  'gemini-3.7-flash-high': 'gemini-3.7-flash',
  'gemini-3.1-pro-high': 'gemini-3.1-pro-preview',
  'gpt-5.5-2026-04-23': 'gpt-5.5',
  'qwen3-asr-flash-2025-09-08': 'qwen3-asr-flash',
  'qwen3-asr-flash-2026-02-10': 'qwen3-asr-flash',
  'qwen3-asr-flash-filetrans-2025-11-17': 'qwen3-asr-flash-filetrans',
  'qwen3-asr-flash-realtime-2025-10-27': 'qwen3-asr-flash-realtime',
  'qwen3-asr-flash-realtime-2026-02-10': 'qwen3-asr-flash-realtime',
  'fun-asr-2025-11-07': 'fun-asr', 'fun-asr-2025-08-25': 'fun-asr',
  'fun-asr-mtl-2025-08-25': 'fun-asr-mtl',
  'fun-asr-realtime-2025-11-07': 'fun-asr-realtime',
  'qwen-image-max-2025-12-30': 'qwen-image-max',
  'qwen-image-plus-2026-01-09': 'qwen-image-plus',
  'qwen-image-2.0-2026-03-03': 'qwen-image-2.0',
  'qwen-image-2.0-pro-2026-03-03': 'qwen-image-2.0-pro',
  'qwen-image-2.0-pro-2026-04-22': 'qwen-image-2.0-pro',
  'qwen-image-2.0-pro-2026-06-22': 'qwen-image-2.0-pro',
  'gpt-image-2-2026-04-21': 'gpt-image-2',
  'qwen3-coder-plus-2025-09-23': 'qwen3-coder-plus',
  'qwen3-coder-plus-2025-07-22': 'qwen3-coder-plus',
  'qwen3-coder-flash-2025-07-28': 'qwen3-coder-flash',

}

// Only known provider namespaces are removable. A reseller's rate is an API
// equivalent estimate, never a verified bill. Do not strip arbitrary suffixes:
// realtime/highspeed/pro/region suffixes can select a different price.
function priceAlias(id: string): string | undefined {
  if (Object.hasOwn(PRICE_ALIASES, id)) return PRICE_ALIASES[id]
  const bare = id.replace(/^(?:openai|anthropic|google|models|qwen|dashscope|zhipu|minimax|moonshot|deepseek|orcarouter|novita)\//, '')
  if (bare !== id) return seedPriceFor(bare) ? bare : Object.hasOwn(PRICE_ALIASES, bare) ? PRICE_ALIASES[bare] : undefined
  return undefined
}

/** Freeze the menu before sending, including prices for returned model IDs.
 * Route-specific rows use the exact key `${route}/${model}`. */
export function capturePricing(): (model: string | null | undefined, route?: string) => Readonly<ModelPrice> {
  const db = captureDbPricing()
  const env = legacyEnvPrices()
  return (model, route) => {
    const id = (model ?? '').trim().toLowerCase()
    const routeKey = route ? `${route.trim().toLowerCase()}/${id}` : ''
    const lookup = (key: string): ModelPrice | null => db(key) ?? env[key] ?? null
    let p = routeKey ? lookup(routeKey) : null
    let matchedModel = p ? routeKey : id
    let match: ModelPrice['match'] = p ? 'route' : 'exact'
    p ??= lookup(id) ?? seedPriceFor(id)
    const alias = priceAlias(id)
    if (!p && alias) {
      p = lookup(alias) ?? seedPriceFor(alias)
      matchedModel = alias
      match = 'alias'
      if (p) p = { ...p, verified: false, source: p.source ?? 'compatibility' }
    }
    if (!p) { p = { ...FALLBACK_PRICE, source: 'compatibility' }; match = 'fallback'; matchedModel = '' }
    const price: ModelPrice = { ...p, source: p.source ?? 'legacy', matchedModel, match }
    return Object.freeze({ ...price, version: p.version ?? priceVersion(price) })
  }
}

/** Freeze the current menu without waiting on a pricing SELECT.
 * Missing/stale DB rows kick a background refresh; this call uses the last
 * good snapshot (or env/seed) so a candidate send is never blocked. */
export async function captureCallPricing(): Promise<ReturnType<typeof capturePricing>> {
  return capturePricing()
}

/** Exact route/model → exact model → explicit alias → clearly estimated fallback. */
export function priceFor(model: string | null | undefined, route?: string): Readonly<ModelPrice> {
  return capturePricing()(model, route)
}

/** The full known price menu (seeded tiers + any operator env overrides), for a
 *  UI reference table so users can see exactly what each model costs. `estimated`
 *  is true for everything except operator-supplied (CUMORA_MODEL_PRICES_JSON) rates. */
export function modelPriceTable(): Array<{
  model: string; inPer1M: number; cachedInPer1M: number; cacheWritePer1M: number; outPer1M: number; estimated: boolean
}> {
  const rows: Array<{ model: string; inPer1M: number; cachedInPer1M: number; cacheWritePer1M: number; outPer1M: number; estimated: boolean }> = []
  const add = (model: string): void => {
    const p = priceFor(model)
    if (rows.some((r) => r.model === model)) return
    rows.push({ model, inPer1M: p.inPer1M, cachedInPer1M: p.cachedInPer1M, cacheWritePer1M: p.cacheWritePer1M, outPer1M: p.outPer1M, estimated: p.verified !== true })
  }
  for (const model of Object.keys(legacyEnvPrices())) add(model)
  for (const { model } of modelPricingSeeds()) add(model)
  return rows
}

/** Cache-aware effective cost in USD for one model call. `estimated` is true when
 *  the price is a seeded guess / fallback rather than an operator-supplied rate —
 *  surface it in the UI so the dollar figure is never mistaken for a real bill. */
export function effectiveCostUsd(model: string | null | undefined, usage: TokenUsage, p: Readonly<ModelPrice> = priceFor(model)): { usd: number; estimated: boolean } {
  const usd =
    (usage.inputTokens * p.inPer1M +
      usage.cachedInputTokens * p.cachedInPer1M +
      usage.cacheCreationTokens * p.cacheWritePer1M +
      usage.outputTokens * p.outPer1M) / 1_000_000
  return { usd, estimated: p.verified !== true }
}

/** Total cost expressed in "uncached-input-token equivalents" — a price-free way
 *  to compare calls on one scale (how many fresh input tokens this call's spend
 *  is worth at the model's own rates). Useful when the operator distrusts the $. */
export function inputEquivalentTokens(model: string | null | undefined, usage: TokenUsage): number {
  const p = priceFor(model)
  if (p.inPer1M <= 0) return usage.inputTokens + usage.cachedInputTokens + usage.cacheCreationTokens + usage.outputTokens
  const { usd } = effectiveCostUsd(model, usage)
  return Math.round((usd * 1_000_000) / p.inPer1M)
}

/** Cache-hit rate = cache-read input / total input tokens (0..1). NaN-safe → 0. */
export function cacheHitRate(usage: TokenUsage): number {
  const totalInput = usage.inputTokens + usage.cachedInputTokens
  return totalInput > 0 ? usage.cachedInputTokens / totalInput : 0
}
