/** Reasoning-effort knobs. The big brain (agent main turn) and the
 *  cerebellum (triage/compaction/verifier/agenda/convene) are separate
 *  budgets on purpose: gates should stay cheap unless the operator
 *  explicitly cranks them. Read from server_settings at call time (30s
 *  refresh), falling back to the CUMORA_* env vars — edits in the
 *  settings page take effect without a restart. */
import type { ReasoningEffort } from 'openai/resources/shared.js'
import { getServerSetting } from '../settings.js'

export function agentReasoningEffort(): ReasoningEffort {
  return (getServerSetting('agent_reasoning_effort') || 'low') as ReasoningEffort
}

export function agentMaxOutputTokens(): number {
  return Number(getServerSetting('agent_max_output_tokens') || 4000)
}

export function supportReasoningEffort(): ReasoningEffort {
  return (getServerSetting('support_reasoning_effort') || 'low') as ReasoningEffort
}

/** Additive token headroom for cerebellum calls, so a cranked effort level's
 *  reasoning doesn't eat the entire output budget. Each call site keeps its
 *  own base budget and adds this on top. */
export function supportReasoningHeadroom(): number {
  return Number(getServerSetting('support_reasoning_headroom') || 0)
}
