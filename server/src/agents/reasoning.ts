/** Reasoning-effort knobs. The big brain (agent main turn) and the
 *  cerebellum (triage/compaction/verifier/agenda/convene) are separate
 *  budgets on purpose: gates should stay cheap unless the operator
 *  explicitly cranks them. Read from server_settings at call time (30s
 *  refresh), falling back to the CUMORA_* env vars — edits in the
 *  settings page take effect without a restart. */
import type { ReasoningEffort } from 'openai/resources/shared.js'
import { getServerSetting } from '../settings.js'

export type ConfiguredReasoningEffort = Exclude<ReasoningEffort, null>

const REASONING_EFFORTS = new Set<ConfiguredReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

function readReasoningEffort(key: string, fallback: ConfiguredReasoningEffort): ConfiguredReasoningEffort {
  const value = getServerSetting(key)?.trim().toLowerCase() ?? ''
  if (!value) return fallback
  return REASONING_EFFORTS.has(value as ConfiguredReasoningEffort)
    ? value as ConfiguredReasoningEffort
    : fallback
}

export function agentReasoningEffort(): ConfiguredReasoningEffort {
  return readReasoningEffort('agent_reasoning_effort', 'low')
}

export function agentMaxOutputTokens(): number {
  const value = Number(getServerSetting('agent_max_output_tokens'))
  return Number.isFinite(value) && value > 0 ? value : 4000
}

export function supportReasoningEffort(): ConfiguredReasoningEffort {
  return readReasoningEffort('support_reasoning_effort', 'none')
}

export function reasoningOptions(effort: ConfiguredReasoningEffort): { reasoning?: { effort: ReasoningEffort } } {
  return effort === 'none' ? {} : { reasoning: { effort: effort as ReasoningEffort } }
}

export function supportReasoningOptions(): { reasoning?: { effort: ReasoningEffort } } {
  return reasoningOptions(supportReasoningEffort())
}

/** Additive token headroom for cerebellum calls, so a cranked effort level's
 *  reasoning doesn't eat the entire output budget. Each call site keeps its
 *  own base budget and adds this on top. */
export function supportReasoningHeadroom(): number {
  const value = Number(getServerSetting('support_reasoning_headroom'))
  return Number.isFinite(value) && value >= 0 ? value : 0
}
