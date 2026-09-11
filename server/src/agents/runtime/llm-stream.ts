import { once } from 'node:events'
import type { Request, Response } from 'express'
import type { LlmCallContext } from '../llm-ledger.js'
import { waitForRuntimeOperation } from './llm-http.js'

export interface RuntimeStreamRequest {
  purpose: 'agent-turn' | 'completion-verify' | 'compaction' | 'steer-summary'
  input: unknown[]
  instructions: string
  tools?: unknown[]
  outputTokens?: number
  runId?: string
  conversationId?: string
  extras?: Record<string, number | boolean>
}

export function parseRuntimeStreamRequest(value: unknown): RuntimeStreamRequest {
  const body = value as RuntimeStreamRequest
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['purpose', 'input', 'instructions', 'tools', 'outputTokens', 'runId', 'conversationId', 'extras'].includes(key))
    || !['agent-turn', 'completion-verify', 'compaction', 'steer-summary'].includes(body.purpose)
    || !Array.isArray(body.input) || typeof body.instructions !== 'string'
    || (body.purpose === 'agent-turn' ? !Array.isArray(body.tools) || body.outputTokens !== undefined
      : body.tools !== undefined || !Number.isSafeInteger(body.outputTokens) || body.outputTokens! < 1 || body.outputTokens! > 16_384)
    || [body.runId, body.conversationId].some(id => id !== undefined && (typeof id !== 'string' || !id || id.length > 256))) {
    throw new Error('Invalid runtime stream request')
  }
  if (body.extras !== undefined && (!body.extras || typeof body.extras !== 'object' || Array.isArray(body.extras)
    || Object.entries(body.extras).some(([key, value]) => !['hop', 'itemsDropped', 'inputCharsBefore', 'inputTokensBefore', 'batchSize', 'hadDraft'].includes(key)
      || (key === 'hadDraft' ? typeof value !== 'boolean' : !Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 2_147_483_647)))) {
    throw new Error('Invalid runtime stream metadata')
  }
  return body
}

export type RuntimeStreamEmit = (kind: string, data: unknown) => Promise<void>

export async function serveRuntimeStream(identity: { agentId: string; companyId: string }, req: Request, res: Response, deps: {
  timeoutMs: number
  authorize: (context: LlmCallContext) => Promise<boolean>
  execute: (body: RuntimeStreamRequest, context: LlmCallContext, signal: AbortSignal, emit: RuntimeStreamEmit) => Promise<unknown>
}): Promise<void> {
  let body: RuntimeStreamRequest
  try { body = parseRuntimeStreamRequest(req.body) }
  catch { res.status(400).json({ error: 'invalid runtime stream request' }); return }
  const context: LlmCallContext = { ...identity, domain: 'managed', purpose: body.purpose,
    role: body.purpose === 'agent-turn' ? 'brain' : 'compaction', runId: body.runId, conversationId: body.conversationId, extras: body.extras }
  const controller = new AbortController()
  const disconnect = () => { if (!res.writableEnded) controller.abort(new DOMException('Runtime disconnected', 'AbortError')) }
  req.once('aborted', disconnect)
  res.once('close', disconnect)
  const timer = setTimeout(() => controller.abort(new DOMException('Runtime LLM timed out', 'TimeoutError')), deps.timeoutMs)
  const emit: RuntimeStreamEmit = async (kind, data) => {
    controller.signal.throwIfAborted()
    if (!res.write(`data: ${JSON.stringify({ version: 1, kind, data })}\n\n`)) {
      await once(res, 'drain', { signal: controller.signal })
    }
  }
  try {
    if (!await waitForRuntimeOperation(deps.authorize(context), controller.signal)) { res.status(403).json({ error: 'runtime LLM context is not authorized' }); return }
    controller.signal.throwIfAborted()
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const result = await waitForRuntimeOperation(deps.execute(body, context, controller.signal, emit), controller.signal)
    await emit('result', result)
    res.end()
  } catch (error) {
    if (res.destroyed) return
    const status = (error as { status?: unknown })?.status
    const timeout = controller.signal.reason?.name === 'TimeoutError' || (error as Error)?.name === 'TimeoutError'
      || (error as { code?: string })?.code === 'ETIMEDOUT'
    const failure = { timeout, status: typeof status === 'number' && status >= 400 && status <= 599 ? status : timeout ? 504 : 502 }
    if (!res.headersSent) res.status(failure.status).json({ error: 'runtime LLM execution failed' })
    else res.end(`data: ${JSON.stringify({ version: 1, kind: 'error', data: failure })}\n\n`)
  } finally {
    clearTimeout(timer)
    controller.abort()
    req.off('aborted', disconnect)
    res.off('close', disconnect)
  }
}
