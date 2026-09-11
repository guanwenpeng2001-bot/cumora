export class RuntimeLlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'RuntimeLlmError'
  }
}

export async function waitForRuntimeOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {})
    throw signal.reason
  }
  let onAbort!: () => void
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Versioned SSE frames; never replay a request after headers or a lost terminal frame. */
export async function streamRuntimeLlm<T>(path: string, body: unknown, options: {
  signal?: AbortSignal | null
  timeoutMs?: number
  baseUrl?: string
  token?: string
  fetchImpl?: typeof fetch
  onEvent: (kind: string, data: unknown) => Promise<void>
}): Promise<T> {
  const baseUrl = options.baseUrl ?? process.env.CUMORA_AGENT_RUNTIME_URL
  const token = options.token ?? process.env.CUMORA_AGENT_RUNTIME_TOKEN
  if (!baseUrl || !token) throw new RuntimeLlmError('Runtime LLM requires a runtime URL and token')
  const timeoutMs = options.timeoutMs ?? 360_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RuntimeLlmError('Invalid runtime LLM timeout')
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  signal.throwIfAborted()
  const timer = setTimeout(() => controller.abort(new DOMException('Runtime LLM timed out', 'TimeoutError')), timeoutMs)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/llm/${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body), signal, redirect: 'error',
    })
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
      await response.body?.cancel()
      throw new RuntimeLlmError('Runtime LLM stream unavailable', response.status)
    }
    reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let pending = ''
    while (true) {
      const chunk = await waitForRuntimeOperation(reader.read(), signal)
      signal.throwIfAborted()
      if (chunk.done) throw new RuntimeLlmError('Runtime LLM stream ended before result')
      pending += decoder.decode(chunk.value, { stream: true })
      let boundary: number
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        if (frame.length > 8 * 1024 * 1024) throw new RuntimeLlmError('Runtime LLM frame exceeds limit')
        if (!frame.startsWith('data: ')) continue
        const event = JSON.parse(frame.slice(6)) as { version: number; kind: string; data: unknown }
        if (event.version !== 1 || typeof event.kind !== 'string') throw new RuntimeLlmError('Invalid runtime LLM frame')
        if (event.kind === 'error') {
          const failure = event.data as { status?: number; timeout?: boolean }
          if (failure.timeout) throw new DOMException('Runtime LLM timed out', 'TimeoutError')
          throw new RuntimeLlmError('Runtime LLM execution failed', failure.status)
        }
        if (event.kind === 'result') return event.data as T
        await waitForRuntimeOperation(options.onEvent(event.kind, event.data), signal)
        signal.throwIfAborted()
      }
      if (pending.length > 8 * 1024 * 1024) throw new RuntimeLlmError('Runtime LLM frame exceeds limit')
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof RuntimeLlmError || (error as Error)?.name === 'TimeoutError') throw error
    throw new RuntimeLlmError('Runtime LLM unavailable or returned an invalid stream')
  } finally {
    clearTimeout(timer)
    controller.abort()
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}

/** No automatic replay: a lost response may already have incurred provider spend. */
export async function callRuntimeLlm<T>(path: string, body: unknown, options: {
  signal?: AbortSignal | null
  timeoutMs?: number
  baseUrl?: string
  token?: string
  fetchImpl?: typeof fetch
} = {}): Promise<T> {
  const baseUrl = options.baseUrl ?? process.env.CUMORA_AGENT_RUNTIME_URL
  const token = options.token ?? process.env.CUMORA_AGENT_RUNTIME_TOKEN
  if (!baseUrl || !token) throw new RuntimeLlmError('Runtime LLM requires a runtime URL and token')
  const timeoutMs = options.timeoutMs ?? 360_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RuntimeLlmError('Invalid runtime LLM timeout')
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  signal.throwIfAborted()
  const timer = setTimeout(() => controller.abort(new DOMException('Runtime LLM timed out', 'TimeoutError')), timeoutMs)
  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/llm/${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal, redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new RuntimeLlmError(`Runtime LLM request failed (${response.status})`, response.status)
    }
    const result = await response.json() as T
    signal.throwIfAborted()
    return result
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof RuntimeLlmError) throw error
    throw new RuntimeLlmError('Runtime LLM unavailable or returned an invalid response')
  } finally {
    clearTimeout(timer)
  }
}
