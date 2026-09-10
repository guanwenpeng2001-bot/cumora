/**
 * Unified fallback routing engine.
 *
 * Every model role resolves to an ordered chain: primary + fallback
 * routes (server_settings, env fallback). A call that fails with a
 * fallbackable error advances to the next hop. Only upstream authentication,
 * quota, rate-limit, server and identified transport failures can advance.
 * Cancellation, local validation and programming errors surface immediately.
 *
 * Embedding deliberately has NO chain: embedding models define
 * incompatible vector spaces, so silently falling over to another model
 * would write vectors into the memory index that recall can't match.
 * The role exists here only to make that exclusion explicit.
 */
import { getServerSetting, getServerSettingList } from '../settings.js'

export type FallbackRole = 'brain' | 'support' | 'compaction' | 'image' | 'audio'

interface LlmError { status?: number; name?: string; code?: string; message?: string; cause?: unknown }

export function isLlmCancellation(e: unknown): boolean {
  const err = e as LlmError | null
  return err?.name === 'AbortError' || err?.name === 'APIUserAbortError' || err?.code === 'ABORT_ERR'
}

/** Called only for errors from an upstream attempt, never tenant authorization. */
export function fallbackReason(e: unknown): string | null {
  if (isLlmCancellation(e)) return null
  const err = e as LlmError | null
  const status = err?.status
  if (typeof status === 'number') {
    return [401, 402, 403, 429].includes(status) || (status >= 500 && status <= 599)
      ? `upstream-http-${status}` : null
  }
  if (err?.name === 'APIConnectionError' || err?.name === 'APIConnectionTimeoutError' || err?.name === 'TimeoutError') {
    return `transport:${err.name}`
  }
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])
  const seen = new Set<unknown>()
  let cause: unknown = e
  while (cause && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause)
    const current = cause as LlmError
    if (isLlmCancellation(current)) return null
    const code = current.code ?? current.message
    if (code && codes.has(code)) return `transport:${code}`
    cause = current.cause
  }
  return null
}

/** True when retrying on the next chain hop has a chance of helping. */
export function isFallbackableError(e: unknown): boolean {
  return fallbackReason(e) !== null
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
