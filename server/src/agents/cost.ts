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
import { captureDbPricing, refreshModelPricing } from '../model-pricing.js'
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
  version?: string
  matchedModel?: string
  match?: 'exact' | 'route' | 'alias' | 'fallback'
  unpriced?: string
}

// Seeded prices — ALL treated as ESTIMATES (verified: false). The claude tiers
// are Anthropic's published list prices to the best of our knowledge (cache-read
// ≈ 0.1× input, cache-write ≈ 1.25× input), but we can't verify at runtime that
// they're current for the EXACT model variant in use (e.g. a specific 4.x), and
// the gpt-5.* ids are Cumora's internal cloud aliases whose true upstream rate we
// don't know at all. So nothing here is presented as authoritative: a figure is
// only `verified` (non-estimated) when the OPERATOR supplies the real contracted
// rate via CUMORA_MODEL_PRICES_JSON. Everything else surfaces as an estimate.
const SEED_PRICES: Record<string, ModelPrice> = {
  'gpt-5.5':      { inPer1M: 2.5, cachedInPer1M: 0.25, cacheWritePer1M: 2.5, outPer1M: 10, verified: false },
  'gpt-5.4-mini': { inPer1M: 0.25, cachedInPer1M: 0.025, cacheWritePer1M: 0.25, outPer1M: 2, verified: false },
  // Claude — Anthropic published list prices (input / cache-read = "cache hits &
  // refreshes" / 5m cache-write / output, per 1M). Explicit aliases below preserve
  // legacy variants. Legacy Opus 4.1 ($15/$75) differs from current Opus (4.5–4.8)
  // ($5/$25). Haiku here = Haiku 4.5 ($1/$5); Sonnet 4.x = $3/$15.
  'claude-opus-4-1': { inPer1M: 15, cachedInPer1M: 1.5, cacheWritePer1M: 18.75, outPer1M: 75, verified: false },
  'claude-opus':   { inPer1M: 5, cachedInPer1M: 0.5, cacheWritePer1M: 6.25, outPer1M: 25, verified: false },
  'claude-sonnet': { inPer1M: 3, cachedInPer1M: 0.3, cacheWritePer1M: 3.75, outPer1M: 15, verified: false },
  'claude-haiku':  { inPer1M: 1, cachedInPer1M: 0.1, cacheWritePer1M: 1.25, outPer1M: 5, verified: false },
}

// Unknown models have no billable rate; preserve the missing-price reason.
const FALLBACK_PRICE: ModelPrice = { inPer1M: 0, cachedInPer1M: 0, cacheWritePer1M: 0, outPer1M: 0, verified: false, unpriced: 'no-price' }

export function validModelPrice(value: unknown): value is ModelPrice {
  if (!value || typeof value !== 'object') return false
  const p = value as ModelPrice
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
    p ??= lookup(id) ?? (Object.hasOwn(SEED_PRICES, id) ? { ...SEED_PRICES[id]!, source: 'legacy' } : null)
    const alias = Object.hasOwn(PRICE_ALIASES, id) ? PRICE_ALIASES[id] : undefined
    if (!p && alias) {
      p = lookup(alias) ?? { ...SEED_PRICES[alias]!, source: 'compatibility' }
      matchedModel = alias
      match = 'alias'
      p = { ...p, verified: false }
    }
    if (!p) { p = { ...FALLBACK_PRICE, source: 'compatibility' }; match = 'fallback'; matchedModel = '' }
    const price = { ...p, matchedModel, match }
    return Object.freeze({ ...price, version: p.version ?? priceVersion(price) })
  }
}

/** Calls wait for the initial/expired DB load before freezing a price menu. */
export async function captureCallPricing(): Promise<ReturnType<typeof capturePricing>> {
  await refreshModelPricing()
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
  for (const model of Object.keys(SEED_PRICES)) add(model)
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
