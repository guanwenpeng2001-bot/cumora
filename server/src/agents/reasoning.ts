/** Reasoning-effort knobs. The big brain (agent main turn) and the
 *  cerebellum (triage/compaction/verifier/agenda/convene) are separate
 *  budgets on purpose: gates should stay cheap unless the operator
 *  explicitly cranks them via env. */
import type { ReasoningEffort } from 'openai/resources/shared.js'

export const AGENT_REASONING_EFFORT = (process.env.CUMORA_REASONING_EFFORT ?? 'low') as ReasoningEffort
export const AGENT_MAX_OUTPUT_TOKENS = Number(process.env.CUMORA_AGENT_MAX_OUTPUT_TOKENS ?? 4000)

export const SUPPORT_REASONING_EFFORT = (process.env.CUMORA_SUPPORT_REASONING_EFFORT ?? 'low') as ReasoningEffort
/** Additive token headroom for cerebellum calls, so a cranked effort level's
 *  reasoning doesn't eat the entire output budget. Each call site keeps its
 *  own base budget and adds this on top. */
export const SUPPORT_REASONING_HEADROOM = Number(process.env.CUMORA_SUPPORT_REASONING_HEADROOM ?? 0)
