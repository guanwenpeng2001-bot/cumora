/** Pure provider usage parsing shared by the server and standalone BYOA CLI. */
export interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0,
}

/** The subset of provider usage fields we read (OpenAI Responses + Anthropic). */
interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Map an OpenAI Responses `usage` to cache-aware TokenUsage. OpenAI's
 *  `input_tokens` is the TOTAL input INCLUDING the cached portion, so we subtract
 *  `input_tokens_details.cached_tokens` to get the uncached part. OpenAI auto-
 *  caches with no separate write charge → cacheCreationTokens = 0. */
export function usageFromOpenAI(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as RawUsage
  const total = Number(u.input_tokens ?? 0)
  const cached = Number(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0)
  return {
    inputTokens: Math.max(0, total - cached),
    cachedInputTokens: cached,
    cacheCreationTokens: 0,
    outputTokens: Number(u.output_tokens ?? 0),
  }
}

/** Strict mapper for tracked calls: absent/incomplete usage stays unknown. */
export function measuredUsage(raw: unknown, protocol: 'responses' | 'chat'): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const input = u[protocol === 'chat' ? 'prompt_tokens' : 'input_tokens']
  const output = u[protocol === 'chat' ? 'completion_tokens' : 'output_tokens']
  const details = u[protocol === 'chat' ? 'prompt_tokens_details' : 'input_tokens_details'] as { cached_tokens?: unknown } | undefined
  const cached = details?.cached_tokens ?? 0
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!valid(input) || !valid(output) || !valid(cached) || cached > input) return null
  return { inputTokens: input - cached, cachedInputTokens: cached, cacheCreationTokens: 0, outputTokens: output }
}

/** Map an Anthropic / Claude Code stream-json `usage` to TokenUsage. Anthropic's
 *  `input_tokens` already EXCLUDES the cached read/write portions, which are
 *  reported separately as cache_read_input_tokens / cache_creation_input_tokens. */
export function usageFromClaude(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as RawUsage
  return {
    inputTokens: Number(u.input_tokens ?? 0),
    cachedInputTokens: Number(u.cache_read_input_tokens ?? 0),
    cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
  }
}

/** Sum two usages (accumulate across the multiple model hops of one turn). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

/** True when there's any token signal at all (distinguishes "measured but zero"
 *  from "no usage reported", e.g. codex). */
export function hasUsage(u: TokenUsage): boolean {
  return u.inputTokens + u.cachedInputTokens + u.cacheCreationTokens + u.outputTokens > 0
}
