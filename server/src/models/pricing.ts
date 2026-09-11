import type { UnpricedReason } from '../../../shared/llm-usage-contract.js'
import type { TokenUsage } from '../agents/token-usage.js'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'

const SCALE = 1_000_000_000_000n
export function fixed(value: string): bigint {
  if (!/^\d+(?:\.\d{1,12})?$/.test(value)) throw new Error('invalid nonnegative decimal')
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'))
}
export function decimal(value: bigint): string {
  return `${value / SCALE}.${(value % SCALE).toString().padStart(12, '0')}`
}
export interface PriceVersion {
  id: string; currency: string; unit_schema: { unit: string; per?: string; tiers?: Array<{ upTo: number | null; rates: Record<string, string> }> }
  rates: Record<string, string>
}
export function priceUsage(price: PriceVersion | null, usage: TokenUsage | null | undefined,
  units?: { unit: string; quantity: number } | null, external = false): { amount: string | null; reason: UnpricedReason | null } {
  const no = (reason: UnpricedReason) => ({ amount: null, reason })
  if (external) return no('external_subscription')
  if (usage && ![usage.inputTokens, usage.cachedInputTokens, usage.cacheCreationTokens, usage.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647)) return no('invalid_usage')
  if (!usage && !units) return no('usage_unavailable')
  if (!price) return no('no_price')
  const unit = price.unit_schema.unit
  if (!['token', 'second', 'image', 'request'].includes(unit)) return no('unsupported_billing_unit')
  try {
    let total = 0n
    if (unit === 'token') {
      if (!usage) return no('usage_unavailable')
      const context = usage.inputTokens + usage.cachedInputTokens + usage.cacheCreationTokens
      const tiers = price.unit_schema.tiers
      const rates = tiers ? tiers.find(t => t.upTo === null || context <= t.upTo)?.rates : price.rates
      if (!rates) return no('price_version_missing')
      for (const [key, quantity] of Object.entries({ input: usage.inputTokens, cache_read: usage.cachedInputTokens, cache_write: usage.cacheCreationTokens, output: usage.outputTokens })) {
        if (quantity === 0) continue
        if (rates[key] === undefined) return no('price_version_missing')
        total += BigInt(quantity) * fixed(rates[key])
      }
      const per = BigInt(price.unit_schema.per ?? '1000000')
      if (per <= 0n) return no('price_version_missing')
      total /= per
    } else {
      if (!units || units.unit !== unit) return no('unit_quantity_unavailable')
      if (!Number.isFinite(units.quantity) || units.quantity < 0 || unit !== 'second' && !Number.isSafeInteger(units.quantity)) return no('invalid_usage')
      if (price.rates.unit === undefined) return no('price_version_missing')
      // Durations derived from sample counts need not have a terminating decimal.
      // Quantize the quantity at our fixed scale; monetary multiplication stays BigInt.
      total = fixed(units.quantity.toFixed(12)) * fixed(price.rates.unit) / SCALE
    }
    return { amount: decimal(total), reason: null }
  } catch { return no('price_version_missing') }
}

export function validatePricePublication(value: unknown): { effectiveFrom: string; effectiveTo: string | null; unitSchema: PriceVersion['unit_schema']; rates: Record<string,string>; note: string | null } {
  if (!value || typeof value !== 'object') throw new Error('invalid price version')
  const v=value as Record<string,unknown>, schema=v.unitSchema as PriceVersion['unit_schema']
  if(v.currency!==undefined && v.currency!=='USD') throw new Error('reference prices must use USD')
  if (!schema || !['token','second','image','request'].includes(schema.unit)) throw new Error('unsupported billing unit')
  if (schema.per !== undefined && !/^[1-9]\d{0,9}$/.test(schema.per)) throw new Error('invalid pricing denominator')
  const rates=(r: unknown): Record<string,string> => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('invalid rates')
    const entries=Object.entries(r)
    if (!entries.length || entries.some(([key,value])=>!['input','cache_read','cache_write','output','unit'].includes(key) || typeof value!=='string')) throw new Error('rates must be decimal strings')
    for(const [,value] of entries) fixed(value as string)
    return r as Record<string,string>
  }
  const parsedRates=rates(v.rates)
  if(schema.tiers) {
    if(!Array.isArray(schema.tiers) || schema.tiers.length>20) throw new Error('invalid tiers')
    let previous=0
    for(const [i,t] of schema.tiers.entries()) {
      if(t.upTo===null ? i!==schema.tiers.length-1 : !Number.isSafeInteger(t.upTo) || t.upTo<=previous) throw new Error('invalid tier boundary')
      previous=t.upTo ?? previous;rates(t.rates)
    }
  }
  const from=typeof v.effectiveFrom==='string' ? Date.parse(v.effectiveFrom) : NaN
  const to=v.effectiveTo==null ? null : typeof v.effectiveTo==='string' ? Date.parse(v.effectiveTo) : NaN
  if(!Number.isFinite(from) || to!==null && (!Number.isFinite(to) || to<=from)) throw new Error('invalid effective interval')
  return {effectiveFrom:new Date(from).toISOString(),effectiveTo:to===null ? null : new Date(to).toISOString(),unitSchema:schema,rates:parsedRates,note:typeof v.note==='string' ? v.note.slice(0,1000) : null}
}
export async function publishPriceVersion(offeringId: string, value: ReturnType<typeof validatePricePublication>): Promise<string> {
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    if(!(await client.query('SELECT id FROM model_offerings WHERE id=$1 FOR UPDATE',[offeringId])).rows.length) throw new Error('offering not found')
    const id=randomUUID()
    await client.query(`UPDATE model_pricing_versions SET effective_to=$2 WHERE offering_id=$1 AND effective_to IS NULL AND effective_from<$2`,[offeringId,value.effectiveFrom])
    await client.query(`INSERT INTO model_pricing_versions(id,offering_id,version,effective_from,effective_to,unit_schema,rates,origin,verified_at,note)
      SELECT $1,$2,COALESCE(MAX(version),0)+1,$3,$4,$5,$6,'operator',NOW(),$7 FROM model_pricing_versions WHERE offering_id=$2`,
    [id,offeringId,value.effectiveFrom,value.effectiveTo,JSON.stringify(value.unitSchema),JSON.stringify(value.rates),value.note])
    await client.query('COMMIT');return id
  } catch(e) {await client.query('ROLLBACK');throw e} finally {client.release()}
}
