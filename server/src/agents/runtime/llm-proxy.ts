import type { Request, Response } from 'express'
import type { LlmCallContext } from '../llm-ledger.js'

export interface RuntimeTextRequest {
  api: 'responses' | 'chat'
  purpose: 'completion-verify' | 'compaction' | 'steer-summary' | 'convene-speech' | 'convene-decision' | 'inbox-triage' | 'agenda' | 'synthetic-wake-gate' | 'palette' | 'gender' | 'message-routing'
  args: Record<string, unknown>
  runId?: string
  conversationId?: string
  options?: { maxRetries?: number; timeout?: number }
}

const PURPOSES = new Set(['completion-verify', 'compaction', 'steer-summary', 'convene-speech', 'convene-decision', 'inbox-triage', 'agenda', 'synthetic-wake-gate', 'palette', 'gender', 'message-routing'])
const FORBIDDEN_ARGS = new Set(['signal', 'headers', 'baseURL', 'apiKey', 'fetch', 'timeout', 'maxRetries'])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The runtime selects a business operation, never a credential, endpoint or tenant. */
export function parseRuntimeTextRequest(value: unknown): RuntimeTextRequest {
  if (!record(value) || typeof value.api !== 'string' || !['responses', 'chat'].includes(value.api)
    || typeof value.purpose !== 'string' || !PURPOSES.has(value.purpose) || !record(value.args)
    || Object.keys(value).some(key => !['api', 'purpose', 'args', 'runId', 'conversationId', 'options'].includes(key))
    || Object.keys(value.args).some(key => FORBIDDEN_ARGS.has(key))
    || (value.args.stream !== undefined && value.args.stream !== false)
    || ['runId', 'conversationId'].some(key => value[key] !== undefined
      && (typeof value[key] !== 'string' || !value[key] || String(value[key]).length > 256))) {
    throw new Error('Invalid runtime text request')
  }
  if (value.options !== undefined && (!record(value.options)
    || Object.keys(value.options).some(key => !['maxRetries', 'timeout'].includes(key))
    || (value.options.maxRetries !== undefined && (!Number.isSafeInteger(value.options.maxRetries) || Number(value.options.maxRetries) < 0 || Number(value.options.maxRetries) > 10))
    || (value.options.timeout !== undefined && (!Number.isSafeInteger(value.options.timeout) || Number(value.options.timeout) < 1 || Number(value.options.timeout) > 2_147_483_647)))) {
    throw new Error('Invalid runtime text options')
  }
  const input = value.api === 'chat' ? value.args.messages : value.args.input
  if (!(typeof input === 'string' && input.length > 0) && !Array.isArray(input)) {
    throw new Error('Text input required')
  }
  return value as unknown as RuntimeTextRequest
}

export interface RuntimeTextDependencies {
  authorize: (context: LlmCallContext) => Promise<boolean>
  execute: (context: LlmCallContext, api: 'responses' | 'chat', args: Record<string, unknown>, options: { signal: AbortSignal; maxRetries?: number; timeout?: number }) => Promise<unknown>
  timeoutMs: number
}

/** Owns cancellation until the response is fully written, including authorization. */
export async function serveRuntimeText(
  identity: { agentId: string; companyId: string }, req: Request, res: Response, deps: RuntimeTextDependencies,
): Promise<void> {
  let body: RuntimeTextRequest
  try { body = parseRuntimeTextRequest(req.body) }
  catch { res.status(400).json({ error: 'invalid runtime text request' }); return }
  const context: LlmCallContext = {
    ...identity, purpose: body.purpose, domain: 'managed',
    role: ['compaction', 'completion-verify', 'steer-summary'].includes(body.purpose) ? 'compaction'
      : body.purpose === 'convene-speech' ? 'brain' : 'support',
    runId: body.runId, conversationId: body.conversationId,
  }
  const controller = new AbortController()
  const disconnect = () => { if (!res.writableEnded) controller.abort(new DOMException('Runtime disconnected', 'AbortError')) }
  req.once('aborted', disconnect)
  res.once('close', disconnect)
  const timer = setTimeout(() => controller.abort(new DOMException('Runtime LLM deadline exceeded', 'TimeoutError')), deps.timeoutMs)
  try {
    if (!await deps.authorize(context)) { res.status(403).json({ error: 'runtime LLM context is not authorized' }); return }
    controller.signal.throwIfAborted()
    const result = await deps.execute(context, body.api, body.args, { ...body.options, signal: controller.signal })
    controller.signal.throwIfAborted()
    if (!res.destroyed) res.json(result)
  } catch (error) {
    if (res.destroyed) return
    const status = (error as { status?: unknown } | null)?.status
    const timeout = controller.signal.reason?.name === 'TimeoutError' || (error as Error)?.name === 'TimeoutError'
    // Provider messages can contain URLs, request headers or credential fragments.
    // Only status crosses this boundary; the executor records each provider hop.
    res.status(timeout ? 504 : typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502)
      .json({ error: timeout ? 'runtime LLM timed out' : 'runtime LLM execution failed' })
  } finally {
    clearTimeout(timer)
    req.off('aborted', disconnect)
    res.off('close', disconnect)
  }
}
