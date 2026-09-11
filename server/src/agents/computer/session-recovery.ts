import { engineFailureOf, type EngineRunResult } from './engine.js'

export interface SessionRecoveryArgs {
  signal?: AbortSignal
  resumeSessionId: string | null
  run: (resumeSessionId: string | null) => Promise<EngineRunResult>
  reset: () => Promise<void>
  onFreshRetry?: () => void
}

/** Resume once, then retry exactly once without a session only when the engine
 * explicitly proves the target is missing before prompt submission. Ambiguous failures are never replayed
 * because the first attempt may already have produced external side effects. */
export async function runWithSessionRecovery(args: SessionRecoveryArgs): Promise<EngineRunResult> {
  args.signal?.throwIfAborted()
  const first = await args.run(args.resumeSessionId)
  const failure = engineFailureOf(first, !!args.resumeSessionId)
  if (failure && !first.failure) first.failure = failure
  if (!args.resumeSessionId || failure?.kind !== 'resume-not-found'
      || first.executionPhase !== 'not-started') return first

  args.signal?.throwIfAborted()
  await args.reset()
  args.signal?.throwIfAborted()
  args.onFreshRetry?.()
  const fresh = await args.run(null)
  const freshFailure = engineFailureOf(fresh, false)
  if (freshFailure && !fresh.failure) fresh.failure = freshFailure
  return fresh
}
