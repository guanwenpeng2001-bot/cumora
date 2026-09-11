import { randomUUID } from 'node:crypto'
import { pool } from './db/pool.js'
import { resolveRoleCall, type RoleCallPlan, type RoleCallCandidate, type RoleCallAgent } from './llm-resolver.js'
import { getLlmCandidateClient } from './llm.js'
import { validateRoleCallAuth } from './tenant-llm-context.js'
import { fallbackReason, isLlmCancellation } from './agents/fallback.js'
import { capturePricing, measuredUsage, type TokenUsage } from './agents/cost.js'
import { recordLlmCall, classifyLlmCallError, type LlmCallContext, type LlmCallRecord } from './agents/llm-ledger.js'
import { getServerSettingsSnapshot, parseLlmConfig } from './settings.js'

export interface LlmAttemptState {
  units?: LlmCallRecord['units']
  usage: TokenUsage | null
  rawUsage: unknown
  usageProtocol?: 'responses' | 'chat'
  protocol?: RoleCallCandidate['protocol']
  reasoningTokens?: number
  actualModel: string | null
  contextWindow?: number
  contextWindowSource?: 'catalog' | 'family' | 'unknown-fallback'
  /** Set before publishing output, executing a tool, or creating external state. */
  committed: boolean
}

export interface LlmExecutionOptions<T> {
  plan: RoleCallPlan
  context: LlmCallContext
  signal?: AbortSignal | null
  logicalCallId?: string
  sdkMaxRetries?: number
  /** Resolve clients and validate locally before returning the actual send operation. */
  prepare: (candidate: RoleCallCandidate, state: LlmAttemptState) => Promise<() => Promise<T>>
  /** Streaming consumers must finish here and mark the first committed output. */
  consume?: (value: T, state: LlmAttemptState) => Promise<T>
  retry?: { maxRetries: number; shouldRetry: (error: unknown, candidate: RoleCallCandidate) => boolean }
  transportRetry?: { maxRetries: number; shouldRetry: (error: unknown) => boolean }
  onRetry?: (reason: 'retry-without-images' | 'retry-provider-connection', candidate: RoleCallCandidate, error: unknown) => Promise<void>
  record?: (record: LlmCallRecord) => Promise<void>
  /** Transport observation is separate from the single authoritative ledger writer. */
  onAttempt?: (record: LlmCallRecord) => Promise<void>
  log?: (event: Record<string, unknown>) => void
}

/** Owns the complete application hop, including consumption, with exactly one record. */
export async function executeLlmPlan<T>(options: LlmExecutionOptions<T>): Promise<T> {
  const { plan, context, signal } = options
  await validateRoleCallAuth(plan)
  if (context.companyId !== plan.companyId || context.purpose !== plan.purpose) throw new Error('LLM plan context mismatch')
  if (!plan.candidates.length) throw new Error('LLM candidate chain is empty')
  const candidates = plan.candidates.filter(candidate => candidate.available)
  if (!candidates.length) throw new Error('LLM candidate chain has no available candidates')
  const logicalCallId = options.logicalCallId ?? randomUUID()
  const checkAbort = () => { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError') }
  // Freeze once per logical call. TTL expiry only kicks a background SELECT;
  // a 401/403 hop must not wait on pricing or block the next candidate on ledger I/O.
  const pricing = capturePricing()
  for (const candidate of candidates) {
    void getLlmCandidateClient(plan, candidate).catch(() => {})
  }
  let retryCount = 0
  let attempt = 0
  let transportRetryCount = 0
  for (let index = 0; index < candidates.length; index++) {
    checkAbort()
    await validateRoleCallAuth(plan)
    const candidate = candidates[index]!
    const state: LlmAttemptState = { usage: null, rawUsage: null, actualModel: null, committed: false }
    const start = Date.now()
    let value: T | undefined
    let error: unknown
    let failed = false
    let prepared = false
    try {
      const send = await options.prepare(candidate, state)
      await validateRoleCallAuth(plan)
      checkAbort()
      prepared = true
      value = await send()
      if (options.consume) value = await options.consume(value, state)
      checkAbort()
    } catch (err) {
      failed = true
      error = err
    }
    const cancelled = signal?.aborted || isLlmCancellation(error)
    const transport = failed && prepared && !cancelled && options.transportRetry?.shouldRetry(error)
    const rawReason = failed && !cancelled ? (!prepared ? 'prepare-failed' : fallbackReason(error)) ?? (transport ? 'transport:provider-connection' : null) : null
    // The cloud cerebellum is best-effort: a candidate-specific gateway 400
    // (model not schedulable, group mismatch) must not kill the call —
    // advance to the next candidate and record why.
    const support400 = rawReason === null && failed && !cancelled && prepared && plan.role === 'support'
      && (error as { status?: unknown } | null)?.status === 400
    const reason = support400 ? 'upstream-http-400' : rawReason
    const imageRetry = failed && prepared && !state.committed && !cancelled && options.retry
      && retryCount < options.retry.maxRetries
      && options.retry.shouldRetry(error, candidate)
    const transportRetry = failed && !state.committed && !cancelled && transport
      && transportRetryCount < (options.transportRetry?.maxRetries ?? 0)
    const retryReason = imageRetry ? 'retry-without-images' : transportRetry ? 'retry-provider-connection' : null
    const retry = retryReason !== null
    const next = retry ? candidate : failed && reason && !state.committed && !cancelled ? candidates[index + 1] : undefined
    const status = failed ? classifyLlmCallError(error) : 'ok'
    const extras = {
      ...context.extras, logicalCallId, attempt: ++attempt,
      role: plan.role, purpose: plan.purpose, requestedModel: candidate.model,
      requestModel: candidate.requestModel, actualModel: state.actualModel,
      route: candidate.route.id, routeKind: candidate.route.kind, platform: candidate.route.platform ?? null,
      protocol: state.protocol ?? candidate.protocol, plannedProtocol: candidate.protocol, usageProtocol: state.usageProtocol ?? null, revision: plan.revision, authorizationVersion: plan.authorizationVersion ?? null,
      contextWindow: state.contextWindow ?? null, contextWindowSource: state.contextWindowSource ?? null,
      status, failureStage: failed ? prepared ? 'execution' : 'prepare' : null, httpStatus: (error as { status?: number } | null)?.status ?? null,
      failureReason: cancelled ? 'cancelled' : reason ?? (failed ? 'non-fallbackable-error' : null),
      nextCandidate: next?.model ?? null, nextCandidateReason: retryReason ?? (next ? reason : null),
      stopReason: !failed ? 'completed' : cancelled ? 'cancelled' : state.committed ? 'output-committed' : next ? 'advance' : !reason ? 'non-fallbackable-error' : 'exhausted',
      usage: state.usage, rawUsage: state.rawUsage, measurement: state.usage ? 'measured' : 'unknown',
      sdkMaxRetries: options.sdkMaxRetries ?? null, sdkRetryPolicy: options.sdkMaxRetries === undefined ? 'client-default' : 'request-override', sdkRetriesIndividuallyObservable: false,
    }
    const record: LlmCallRecord = {
      ...context, model: state.actualModel ?? candidate.model, usage: state.usage, units: state.units,
      pricing: pricing(state.actualModel ?? candidate.model, candidate.route.id),
      reasoningTokens: state.reasoningTokens, latencyMs: Date.now() - start, status,
      error: failed ? (error instanceof Error ? error.message : String(error)) : null, extras,
    }
    // Snapshot the attempt now; persistence must not hold up the next hop or response.
    void Promise.resolve().then(() => (options.record ?? recordLlmCall)(record))
      .catch(error => { console.warn('[llm-execution] recorder failed', error instanceof Error ? error.message : String(error)) })
    const log = options.log ?? ((event: Record<string, unknown>) => { if (failed) console.warn('[llm-execution]', JSON.stringify(event)) })
    log(extras)
    await options.onAttempt?.(record)
    if (!failed) return value as T
    if (!next) throw error
    if (retryReason) {
      if (imageRetry) retryCount++
      else transportRetryCount++
      await options.onRetry?.(retryReason, candidate, error)
      index--
    } else transportRetryCount = 0
  }
  throw new Error('LLM candidate chain is empty')
}

type TextArgs = { model?: string; stream?: boolean } & Record<string, unknown>
type TextResponse = { usage?: unknown; model?: string } & Record<string, unknown>
type TextOptions = { signal?: AbortSignal | null; maxRetries?: number } & Record<string, unknown>

function roleForContext(ctx: LlmCallContext): RoleCallPlan['role'] {
  if (ctx.role) return ctx.role
  if (ctx.purpose === 'agent-turn' || ctx.purpose === 'convene-speech') return 'brain'
  if (['compaction', 'completion-verify', 'steer-summary'].includes(ctx.purpose)) return 'compaction'
  if (ctx.purpose === 'avatar-image' || ctx.purpose === 'agent-image') return 'image'
  return 'support'
}

async function textPlan(ctx: LlmCallContext, model?: string, signal?: AbortSignal): Promise<RoleCallPlan> {
  const role = roleForContext(ctx)
  const snapshot = getServerSettingsSnapshot()
  let captured = snapshot
  // Legacy callers may explicitly select a model. Keep that override in this
  // call's snapshot while resolving each candidate's metadata and route afresh.
  if (!ctx.role && model && model !== snapshot.settings[`${role}_model`]) {
    const config = parseLlmConfig(snapshot.settings.llm_config ?? '')
    const selected = config.roles.find(r => r.role === role && r.purpose === ctx.purpose) ?? config.roles.find(r => r.role === role && r.purpose === undefined)
    if (selected) selected.models = [model, ...selected.models.slice(1)]
    captured = { ...snapshot, settings: { ...snapshot.settings, [`${role}_model`]: model, llm_config: JSON.stringify(config) } }
  }
  let agent: RoleCallAgent = { ...ctx.agent, id: ctx.agentId ?? ctx.agent?.id }
  if (role === 'support' && agent.id && ctx.companyId) {
    const { rows } = await pool.query<{ model_config: unknown; computer_support_model: string | null }>(
      `SELECT p.model_config,
              CASE WHEN p.provider_profile IS NULL AND c.kind <> 'cloud'
                THEN c.engine_defaults -> p.engine ->> 'fastModel' END AS computer_support_model
         FROM participants p
         LEFT JOIN computers c ON c.id = p.computer_id AND c.company_id = p.company_id AND c.revoked_at IS NULL
        WHERE p.id = $1 AND p.company_id = $2 AND p.kind = 'agent' AND p.departed_at IS NULL`,
      [agent.id, ctx.companyId],
    )
    if (rows[0]) agent = { ...agent, modelConfig: rows[0].model_config, computerSupportModel: rows[0].computer_support_model }
  }
  return resolveRoleCall(ctx.companyId, ctx.domain ?? (ctx.companyId ? 'managed' : 'server'), role, ctx.purpose,
    agent, captured, signal)
}

export function responsesToChat(args: TextArgs): TextArgs {
  if (args.previous_response_id || args.conversation) throw new Error('Stateful Responses input cannot move to a Chat route')
  const messages: Record<string, unknown>[] = []
  if (args.instructions) messages.push({ role: 'system', content: args.instructions })
  const input = typeof args.input === 'string' ? [{ role: 'user', content: args.input }] : args.input
  if (!Array.isArray(input)) throw new Error('Responses input must be text or an array')
  let pendingCalls: Record<string, unknown>[] = []
  const flushCalls = () => {
    if (pendingCalls.length) messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls })
    pendingCalls = []
  }
  for (const item of input) {
    if (item.type === 'function_call') {
      pendingCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } })
      continue
    }
    flushCalls()
    if (item.type === 'function_call_output') messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output })
    else if (item.role) {
      const content = Array.isArray(item.content) ? item.content.map((part: Record<string, unknown>) => {
        if (part.type === 'input_text' || part.type === 'output_text') return { type: 'text', text: part.text }
        if (part.type === 'input_image') return { type: 'image_url', image_url: { url: part.image_url, detail: part.detail } }
        throw new Error('Unsupported Responses content for Chat route')
      }) : item.content
      messages.push({ role: item.role, content })
    } else throw new Error('Unsupported Responses item for Chat route')
  }
  flushCalls()
  const { input: _input, instructions: _instructions, max_output_tokens, reasoning, text, ...rest } = args
  const body: TextArgs = { ...rest, messages }
  if (max_output_tokens !== undefined) body.max_completion_tokens = max_output_tokens
  if (reasoning) body.reasoning_effort = (reasoning as { effort?: unknown }).effort
  const format = (text as { format?: { type?: string } } | undefined)?.format
  if (format) {
    const { type, ...schema } = format
    body.response_format = type === 'json_schema' ? { type, json_schema: schema } : format
  }
  if (Array.isArray(args.tools)) body.tools = args.tools.map(tool => {
    if (tool.type !== 'function') throw new Error('Unsupported Responses tool for Chat route')
    const { type: _type, ...fn } = tool
    return { type: 'function', function: fn }
  })
  if (args.tool_choice && typeof args.tool_choice === 'object') {
    const choice = args.tool_choice as { type?: string; name?: string }
    if (choice.type !== 'function' || !choice.name) throw new Error('Unsupported Responses tool choice for Chat route')
    body.tool_choice = { type: 'function', function: { name: choice.name } }
  }
  return body
}

function chatToResponses(response: TextResponse): TextResponse {
  const choices = response.choices as Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> | undefined
  const message = choices?.[0]?.message
  const output: Record<string, unknown>[] = []
  if (message?.content) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content, annotations: [] }] })
  for (const tool of message?.tool_calls ?? []) output.push({ type: 'function_call', call_id: tool.id, name: tool.function.name, arguments: tool.function.arguments })
  const u = response.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: unknown; completion_tokens_details?: unknown } | undefined
  return { ...response, object: 'response', output, output_text: message?.content ?? '',
    usage: u ? { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens, input_tokens_details: u.prompt_tokens_details, output_tokens_details: u.completion_tokens_details } : undefined }
}

/** Compatibility non-streaming entry. Streaming callsites migrate with their consumer. */
export async function executeTrackedText(ctx: LlmCallContext, api: 'responses' | 'chat', args: TextArgs, options?: unknown): Promise<TextResponse> {
  if (args.stream) throw new Error('Streaming execution requires an explicit consumer')
  if (args.model !== undefined && (typeof args.model !== 'string' || !args.model.trim())) throw new Error('Invalid LLM model')
  const opts = (options ?? {}) as TextOptions
  const signal = opts.signal ?? args.signal as AbortSignal | undefined
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  if (process.env.CUMORA_RUNTIME_CLIENT === 'http') {
    const { callRuntimeLlm } = await import('./agents/runtime/llm-http.js')
    const { signal: _signal, ...body } = args
    return callRuntimeLlm<TextResponse>('text', {
      api, purpose: ctx.purpose, args: body, runId: ctx.runId ?? undefined,
      conversationId: ctx.conversationId ?? undefined,
      options: { maxRetries: opts.maxRetries, timeout: opts.timeout },
    }, { signal })
  }
  const plan = await textPlan(ctx, args.model, signal)
  return executeLlmPlan({ plan, context: ctx, signal, sdkMaxRetries: opts.maxRetries,
    prepare: async (candidate, state) => {
      if (!['responses', 'chat'].includes(candidate.protocol)) throw new Error('Non-text LLM protocol')
      const { signal: _signal, ...body } = args
      const shim = api === 'responses' && candidate.route.kind === 'direct' && ['novita', 'orcarouter'].includes(candidate.route.env ?? '')
      const model = shim ? `${candidate.route.env}/${candidate.requestModel}` : candidate.requestModel
      const request: TextArgs = { ...body, model }
      const cap = candidate.parameters.maxOutputTokens
      const tokenKey = api === 'responses' ? 'max_output_tokens' : 'max_completion_tokens'
      if (request[tokenKey] !== undefined && (!Number.isSafeInteger(request[tokenKey]) || Number(request[tokenKey]) <= 0)) throw new Error('Invalid LLM token budget')
      if (cap !== undefined) request[tokenKey] = typeof request[tokenKey] === 'number' ? Math.min(request[tokenKey] as number, cap) : cap
      if (api === 'responses') {
        if (candidate.parameters.effort) request.reasoning = { effort: candidate.parameters.effort }
        else delete request.reasoning
      } else {
        if (candidate.parameters.effort) request.reasoning_effort = candidate.parameters.effort
        else delete request.reasoning_effort
      }
      const useChat = api === 'chat' || (candidate.protocol === 'chat' && !shim)
      state.protocol = useChat ? 'chat' : candidate.protocol
      state.usageProtocol = useChat ? 'chat' : 'responses'
      const outbound = api === 'responses' && useChat ? responsesToChat(request) : request
      const client = await getLlmCandidateClient(plan, candidate)
      return async () => {
        const resource = useChat ? client.chat.completions : client.responses
        const response = await (resource.create as unknown as (a: unknown, o?: unknown) => Promise<TextResponse>).call(resource, outbound, { ...opts, signal })
        state.rawUsage = response.usage ?? null
        state.usage = measuredUsage(response.usage, useChat ? 'chat' : 'responses')
        state.actualModel = typeof response.model === 'string' ? response.model : null
        const usage = response.usage as Record<string, { reasoning_tokens?: number }> | undefined
        const reasoning = usage?.[useChat ? 'completion_tokens_details' : 'output_tokens_details']?.reasoning_tokens
        if (typeof reasoning === 'number' && Number.isSafeInteger(reasoning) && reasoning >= 0) state.reasoningTokens = reasoning
        return api === 'responses' && useChat ? chatToResponses(response) : response
      }
    },
  })
}
