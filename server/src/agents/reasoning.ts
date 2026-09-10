/** Reasoning-effort knobs. The big brain (agent main turn) and the
 *  cerebellum (triage/compaction/verifier/agenda/convene) are separate
 *  budgets on purpose: gates should stay cheap unless the operator
 *  explicitly cranks them. Read from server_settings at call time (30s
 *  refresh), falling back to the CUMORA_* env vars — edits in the
 *  settings page take effect without a restart. */
import type { ReasoningEffort } from 'openai/resources/shared.js'
import { getServerSetting } from '../settings.js'
import { MAX_OUTPUT_TOKENS, REASONING_EFFORTS } from './model-config.js'

export type ConfiguredReasoningEffort = Exclude<ReasoningEffort, null>

function readReasoningEffort(key: string, fallback: ConfiguredReasoningEffort): ConfiguredReasoningEffort {
  const value = getServerSetting(key)?.trim().toLowerCase() ?? ''
  if (!value) return fallback
  if (!REASONING_EFFORTS.has(value)) {
    console.warn(`[settings] invalid reasoning effort for ${key}: ${JSON.stringify(value)} — using fallback ${fallback}`)
    return fallback
  }
  return value as ConfiguredReasoningEffort
}

export function agentReasoningEffort(): ConfiguredReasoningEffort {
  return readReasoningEffort('agent_reasoning_effort', 'low')
}

export function agentMaxOutputTokens(): number {
  return readTokenBudget('agent_max_output_tokens', 4000, 1)
}

export function supportReasoningEffort(): ConfiguredReasoningEffort {
  return readReasoningEffort('support_reasoning_effort', 'none')
}

export function reasoningOptions(effort: ConfiguredReasoningEffort): { reasoning?: { effort: ReasoningEffort } } {
  if (!REASONING_EFFORTS.has(effort)) throw new Error('invalid reasoning effort')
  return effort === 'none' ? {} : { reasoning: { effort } }
}

export function supportReasoningOptions(): { reasoning?: { effort: ReasoningEffort } } {
  return reasoningOptions(supportReasoningEffort())
}

/** Additive token headroom for cerebellum calls, so a cranked effort level's
 *  reasoning doesn't eat the entire output budget. Each call site keeps its
 *  own base budget and adds this on top. */
export function supportReasoningHeadroom(): number {
  return readTokenBudget('support_reasoning_headroom', 0, 0)
}

function readTokenBudget(key: string, fallback: number, min: number): number {
  const raw = getServerSetting(key)?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > MAX_OUTPUT_TOKENS) {
    console.warn(`[settings] invalid token budget for ${key}: ${JSON.stringify(raw)} — using fallback ${fallback}`)
    return fallback
  }
  return value
}
