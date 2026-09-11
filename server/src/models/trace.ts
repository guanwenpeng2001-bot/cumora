import { AsyncLocalStorage } from 'node:async_hooks'

export interface CallTrace { traceId: string; attemptId: string; gatewayRequestId?: string; upstreamRequestId?: string }
const active = new AsyncLocalStorage<CallTrace>()
export function withCallTrace<T>(trace: CallTrace, send: () => Promise<T>): Promise<T> { return active.run(trace, send) }
export const tracedFetch: typeof fetch = async (input, init) => {
  const trace = active.getStore()
  if (!trace) return fetch(input, init)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set('X-Cumora-Attempt-Id', trace.attemptId)
  headers.set('traceparent', `00-${trace.traceId.replaceAll('-', '')}-${trace.attemptId.replaceAll('-', '').slice(0,16)}-01`)
  const response = await fetch(input, { ...init, headers })
  trace.gatewayRequestId = response.headers.get('x-request-id') ?? undefined
  trace.upstreamRequestId = response.headers.get('x-upstream-request-id') ?? undefined
  return response
}
