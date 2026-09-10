/**
 * Per-agent model configuration (participants.model_config JSONB).
 *
 * Resolution order at turn time: agent model_config → global server_settings
 * (settings.ts, DB → env) → hardcoded defaults. Every field is optional;
 * absent means "inherit the global brain role's setting".
 *
 * Phase 2 scope: managed agents only. BYOA agents are engine-managed — their
 * model pins flow through the engine assignment path (model/fast_model),
 * and this config is ignored for them by the UI.
 */
import type { ReasoningEffort } from 'openai/resources/shared.js'

export interface AgentModelConfig {
  /** Reasoning effort override for the main turn. */
  effort?: ReasoningEffort
  /** Context window in tokens; undefined = follow the model heuristic. */
  contextWindow?: number
  /** Output token cap for the main turn. */
  maxOutputTokens?: number
  /** Thinking toggle. false = omit the reasoning field entirely. */
  thinking?: boolean
  /** Ordered fallback chain for the main model. Empty/absent = follow the
   *  global brain role's chain. */
  fallbackModels?: string[]
}

export const MAX_CONTEXT_WINDOW = 2_000_000
export const MAX_OUTPUT_TOKENS = 1_000_000
export const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

export class InvalidAgentModelConfigError extends Error {}

function normalizeAgentModelConfig(raw: unknown, strict: boolean): AgentModelConfig | null {
  const invalid = (path: string) => {
    if (strict) throw new InvalidAgentModelConfigError(`invalid modelConfig: ${path}`)
    console.warn('[model-config:invalid-history]', { path })
  }
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    invalid('modelConfig must be an object or null')
    return null
  }
  const b = raw as Record<string, unknown>
  const out: AgentModelConfig = {}
  for (const key of Object.keys(b)) {
    if (!['effort', 'contextWindow', 'maxOutputTokens', 'thinking', 'fallbackModels'].includes(key)) {
      invalid('unknown field')
    }
  }
  if (b.effort !== undefined) {
    const effort = typeof b.effort === 'string' ? b.effort.trim().toLowerCase() : ''
    if (REASONING_EFFORTS.has(effort)) out.effort = effort as ReasoningEffort
    else invalid('effort must be none/minimal/low/medium/high/xhigh')
  }
  for (const [key, max] of [['contextWindow', MAX_CONTEXT_WINDOW], ['maxOutputTokens', MAX_OUTPUT_TOKENS]] as const) {
    const value = b[key]
    if (value === undefined) continue
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max) out[key] = value
    else invalid(`${key} must be an integer between 1 and ${max}`)
  }
  if (b.thinking !== undefined) {
    if (typeof b.thinking === 'boolean') out.thinking = b.thinking
    else invalid('thinking must be a boolean')
  }
  if (b.fallbackModels !== undefined) {
    if (!Array.isArray(b.fallbackModels)) invalid('fallbackModels must be an ordered array')
    else {
      const list: string[] = []
      for (const [index, model] of b.fallbackModels.entries()) {
        if (typeof model !== 'string' || !model.trim()) invalid(`fallbackModels[${index}] must be a nonempty string`)
        else if (!list.includes(model.trim())) list.push(model.trim())
      }
      if (list.length) out.fallbackModels = list
    }
  }
  return Object.keys(out).length ? out : null
}

/** Strict new writes; null/empty objects and empty chains restore inheritance. */
export function validateAgentModelConfig(raw: unknown): AgentModelConfig | null {
  return normalizeAgentModelConfig(raw, true)
}

/** Historical JSONB stays readable; discarded fields emit diagnostic markers. */
export function parseAgentModelConfig(raw: unknown): AgentModelConfig | null {
  return normalizeAgentModelConfig(raw, false)
}

/** The agent turn's fallback chain. An explicit agent chain wins outright;
 *  otherwise the agent follows the global brain chain (its own primary
 *  first, then every global hop it isn't). Returns null when there is
 *  nothing beyond the primary — the caller then lets the client's
 *  model-matched global fallback handle it (covers the "agent unpinned"
 *  case without double-wrapping). */
export function agentTurnChain(
  primary: string,
  mc: AgentModelConfig | null,
  globalBrainChain: string[],
): string[] | null {
  if (mc?.fallbackModels?.length) {
    return [...new Set([primary, ...mc.fallbackModels])]
  }
  const follow = globalBrainChain.filter((m) => m !== primary)
  return follow.length > 0 ? [primary, ...follow] : null
}
