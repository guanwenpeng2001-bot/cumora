/**
 * Model policy — the big (brain) model is spent ONLY on real tasks: an agent's
 * actual conversational output that humans read. Everything else (triage,
 * summarization, classification, palette, gender inference, …) is auxiliary
 * "cerebellum" work and MUST run on the small support model.
 *
 * `enforceModelPolicy` is the single chokepoint. Pass the model you intend to
 * use plus the purpose; if a non-real-task purpose is about to spend the big
 * model it logs loudly AND falls back to the support model — so a regression is
 * caught immediately ("及时发现") and contained rather than silently burning
 * brain-model tokens.
 */
import { getBrainModel, getSupportModel, getCompactionModel } from '../settings.js'
import { notifyAlert } from '../alerting.js'

export type ModelPurpose =
  // Real tasks — the ONLY purposes allowed to use the big/brain model.
  | 'agent-turn' // main turn: the agent responding to a real conversation
  | 'convene-speech' // convene: the agent's spoken contribution in a live session
  // Auxiliary cerebellum work — MUST use the small support model.
  | 'inbox-triage'
  | 'completion-verify'
  | 'compaction'
  | 'steer-summary'
  | 'convene-decision'
  | 'agenda'
  | 'palette'
  | 'gender'
  | 'message-routing'

const REAL_TASK_PURPOSES: ReadonlySet<ModelPurpose> = new Set<ModelPurpose>([
  'agent-turn',
  'convene-speech',
])

/** The small/cerebellum model for all auxiliary work. */
export function supportModel(): string {
  return getSupportModel()
}

/** The big/brain model for a real task (a per-agent override wins). */
export function realTaskModel(personaModel?: string | null): string {
  return personaModel?.trim() || getBrainModel()
}

/**
 * Guard a model selection at the call site. Returns the model to actually use.
 * If a non-real-task purpose is about to spend the big model, log an error and
 * fall back to the support model so the misuse is both surfaced and contained.
 */
export function roleForPurpose(purpose: ModelPurpose): 'brain' | 'support' | 'compaction' {
  if (REAL_TASK_PURPOSES.has(purpose)) return 'brain'
  return ['compaction', 'completion-verify', 'steer-summary'].includes(purpose) ? 'compaction' : 'support'
}

export function enforceModelPolicy(model: string, purpose: ModelPurpose): string {
  const role = roleForPurpose(purpose)
  const auxiliary = role === 'compaction' ? getCompactionModel() : getSupportModel()
  if (role !== 'brain' && model === getBrainModel() && model !== auxiliary) {
    const msg =
      `[model-policy] VIOLATION: purpose "${purpose}" attempted the BIG model "${model}". ` +
      `Only real tasks (${[...REAL_TASK_PURPOSES].join(', ')}) may use the big model; ` +
      `forcing the ${role} model "${auxiliary}".`
    console.error(msg)
    // P0: an unnecessary big-brain selection reached runtime — page immediately.
    // notifyAlert never throws/blocks; fire-and-forget so the policy stays sync.
    void notifyAlert({
      label: 'model-policy.violation',
      error: new Error(`big model used for non-real-task purpose "${purpose}"`),
      extras: { purpose, attemptedModel: model, forcedModel: auxiliary },
    })
    return auxiliary
  }
  return model
}
