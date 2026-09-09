/**
 * Unified fallback routing engine.
 *
 * Every model role resolves to an ordered chain: primary + fallback
 * routes (server_settings, env fallback). A call that fails with a
 * fallbackable error advances to the next hop; a non-fallbackable error
 * (400/401 — the request itself is wrong or the credential is bad, no
 * other hop would help) surfaces immediately.
 *
 * Fallbackable: 402 (quota/billing), 429 (rate limit), 5xx, and network
 * errors (no HTTP status at all). Everything else is caller's problem.
 *
 * Embedding deliberately has NO chain: embedding models define
 * incompatible vector spaces, so silently falling over to another model
 * would write vectors into the memory index that recall can't match.
 * The role exists here only to make that exclusion explicit.
 */
import { getServerSetting, getServerSettingList } from '../settings.js'

export type FallbackRole = 'brain' | 'support' | 'compaction' | 'image' | 'audio'

interface ErrorWithStatus { status?: number }

/** True when retrying on the next chain hop has a chance of helping. */
export function isFallbackableError(e: unknown): boolean {
  const status = (e as ErrorWithStatus | null)?.status
  if (typeof status === 'number') {
    return status === 402 || status === 429 || status >= 500
  }
  // No status → network/transport failure (DNS, reset, timeout).
  return true
}

/** Ordered chain for a role: [primary, ...fallbacks], deduped. */
export function resolvedChain(role: FallbackRole): string[] {
  const primary = getServerSetting(`${role}_model`)
  const fallbacks = getServerSettingList(`${role}_fallback_models`)
  return [...new Set([primary, ...fallbacks].filter(Boolean))]
}

export interface FallbackResult<T> {
  value: T
  model: string
}

/** Run `fn` against each model and return the model that produced the value. */
export async function runWithFallbackResult<T>(
  chain: string[],
  fn: (model: string) => Promise<T>,
  onAdvance?: (from: string, to: string, err: unknown) => void,
): Promise<FallbackResult<T>> {
  if (chain.length === 0) {
    throw new Error('Fallback chain is empty: no primary model or fallback model is configured')
  }
  let lastErr: unknown = null
  for (let i = 0; i < chain.length; i++) {
    try {
      return { value: await fn(chain[i]!), model: chain[i]! }
    } catch (e) {
      lastErr = e
      if (!isFallbackableError(e) || i === chain.length - 1) throw e
      if (onAdvance) onAdvance(chain[i]!, chain[i + 1]!, e)
      else console.warn(`[fallback] ${chain[i]} failed, trying ${chain[i + 1]}:`, e instanceof Error ? e.message.slice(0, 200) : e)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** Backwards-compatible value-only fallback helper. */
export async function runWithFallback<T>(
  chain: string[],
  fn: (model: string) => Promise<T>,
  onAdvance?: (from: string, to: string, err: unknown) => void,
): Promise<T> {
  return (await runWithFallbackResult(chain, fn, onAdvance)).value
}
