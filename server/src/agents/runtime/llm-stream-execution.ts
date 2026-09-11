import type { ResponseInputItem } from 'openai/resources/responses/responses'
import { resolveRoleCall } from '../../llm-resolver.js'
import { automationNumber, getTurnBudgetPolicy, getServerSettingsSnapshot } from '../../settings.js'
import { isDeterministicModelFailure, readModelFailureState, saveModelFailureBackoff } from '../model-failure-backoff.js'
import type { LlmCallContext, LlmCallRecord } from '../llm-ledger.js'
import { getPersona } from '../personas.js'
import { enforceModelPolicy, realTaskModel } from '../model-policy.js'
import { executeAgentTurnHop, executeAuxiliaryStream, parseCompletionVerification } from '../turn.js'
import type { RuntimeStreamEmit, RuntimeStreamRequest } from './llm-stream.js'

export async function resolveRuntimeBrainPlan(context: LlmCallContext, signal?: AbortSignal) {
  const persona = await getPersona(context.agentId!)
  if (!persona || persona.companyId !== context.companyId) throw new Error('Runtime persona unavailable')
  return resolveRoleCall(context.companyId ?? null, 'managed', 'brain', 'agent-turn', {
    id: context.agentId!, model: persona.model ? enforceModelPolicy(realTaskModel(persona.model), 'agent-turn') : undefined, modelConfig: persona.modelConfig,
  }, undefined, signal)
}

/** Provider diagnostics stay in the server ledger, never in the Pod transport. */
function publicStreamEvent(event: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...event }
  if (copy.error) copy.error = { message: 'Provider stream failed' }
  if (copy.type === 'error') return { type: 'error', message: 'Provider stream failed' }
  if (copy.response && typeof copy.response === 'object') {
    const response = { ...copy.response as Record<string, unknown> }
    if (response.error) response.error = { message: 'Provider stream failed' }
    copy.response = response
  }
  return copy
}

export async function executeRuntimeStream(body: RuntimeStreamRequest, context: LlmCallContext, signal: AbortSignal, emit: RuntimeStreamEmit) {
  const attempts: LlmCallRecord[] = []
  const onAttempt = async (record: LlmCallRecord) => {
    attempts.push(record)
    const extras = record.extras ?? {}
    const publicExtras = Object.fromEntries([
      'logicalCallId', 'attempt', 'role', 'purpose', 'requestedModel', 'requestModel', 'actualModel',
      'route', 'routeKind', 'platform', 'protocol', 'plannedProtocol', 'usageProtocol', 'revision', 'authorizationVersion',
      'contextWindow', 'contextWindowSource', 'status', 'failureStage', 'httpStatus', 'failureReason',
      'nextCandidate', 'nextCandidateReason', 'stopReason', 'usage', 'rawUsage', 'measurement',
      'sdkMaxRetries', 'sdkRetryPolicy', 'sdkRetriesIndividuallyObservable',
      'pendingSettlement',
    ].filter(key => key in extras).map(key => [key, extras[key]]))
    await emit('attempt', { ...context, model: record.model, status: record.status, usage: record.usage,
      reasoningTokens: record.reasoningTokens, latencyMs: record.latencyMs, error: null,
      extras: { ...context.extras, ...publicExtras } })
  }
  if (body.purpose === 'agent-turn') {
    const configuration = await readModelFailureState(context.companyId!, context.agentId!)
    const plan = await resolveRuntimeBrainPlan(context, signal)
    try {
      const result = await executeAgentTurnHop({ plan, context, signal, input: body.input as ResponseInputItem[],
        instructions: body.instructions, tools: body.tools!,
        wallTimeoutMs: automationNumber('agent_stream_wall_timeout_ms'),
        idleTimeoutMs: automationNumber('agent_stream_idle_timeout_ms'), onAttempt,
        compactionPolicy: getTurnBudgetPolicy(),
        requestEvent: data => emit('request', data),
        retryEvent: (kind, data) => emit('retry', { kind, data: { ...data, reason: 'Provider attempt retry' } }),
        streamEvent: event => emit('delta', publicStreamEvent(event as unknown as Record<string, unknown>)),
      })
      return { ...result, state: { ...result.state, responseTextByPart: [...result.state.responseTextByPart] } }
    } catch (error) {
      if (!signal.aborted && configuration && configuration.revision === getServerSettingsSnapshot().revision
        && isDeterministicModelFailure(attempts)) {
        // Persist before delivering failure to the Pod, so the next probe (or a
        // replacement Pod) cannot replay the retained inbox during cooldown.
        await saveModelFailureBackoff(context.companyId!, context.agentId!, configuration)
      }
      throw error
    }
  }
  return executeAuxiliaryStream({ purpose: body.purpose, companyId: context.companyId ?? null, agentId: context.agentId!,
    instructions: body.instructions, input: body.input as ResponseInputItem[], outputTokens: body.outputTokens!, signal, onAttempt,
    extras: context.extras,
    streamEvent: event => emit('delta', publicStreamEvent(event)),
    parse: text => {
      if (body.purpose === 'completion-verify') {
        if (!parseCompletionVerification(text)) throw new Error('Completion verifier returned invalid JSON')
      } else if (!text.trim()) throw new Error('Empty summary from LLM')
      return text
    },
  })
}
