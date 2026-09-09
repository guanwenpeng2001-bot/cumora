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

/** Lenient parse of the JSONB column / API payload. Unknown keys and
 *  wrong-typed values are dropped; returns null when nothing valid remains
 *  (so callers can store null instead of an empty object). */
export function parseAgentModelConfig(raw: unknown): AgentModelConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const b = raw as Record<string, unknown>
  const out: AgentModelConfig = {}
  if (typeof b.effort === 'string' && b.effort.trim()) out.effort = b.effort.trim() as ReasoningEffort
  if (typeof b.contextWindow === 'number' && Number.isFinite(b.contextWindow) && b.contextWindow > 0) {
    out.contextWindow = Math.floor(b.contextWindow)
  }
  if (typeof b.maxOutputTokens === 'number' && Number.isFinite(b.maxOutputTokens) && b.maxOutputTokens > 0) {
    out.maxOutputTokens = Math.floor(b.maxOutputTokens)
  }
  if (typeof b.thinking === 'boolean') out.thinking = b.thinking
  if (Array.isArray(b.fallbackModels)) {
    const list = b.fallbackModels.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    if (list.length > 0) out.fallbackModels = [...new Set(list.map((m) => m.trim()))]
  }
  return Object.keys(out).length > 0 ? out : null
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
