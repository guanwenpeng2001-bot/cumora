/**
 * Minimal MCP client for the managed runtime (phase 6). No dependencies:
 * JSON-RPC over newline-delimited stdio, or streamable HTTP (JSON or SSE
 * answers). Only three methods — initialize, tools/list, tools/call —
 * which is all a tool-surface bridge needs.
 *
 * Layering: turn.ts connects an agent's enabled connectors at turn start
 * and closes them in the turn's finally. Stdio connectors spawn INSIDE
 * the agent's pod with cwd pinned to the agent workspace; http connectors
 * dial only the registry URL.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** DB-free connector spec (structurally matches mcp_connectors rows). */
export interface McpConnectorSpec {
  name: string
  type: 'stdio' | 'http'
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  url?: string | null
  headers?: Record<string, string>
}

export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpToolResult {
  /** Joined text content (the model-facing payload). */
  text: string
  isError: boolean
}

const CONNECT_TIMEOUT_MS = 15_000
const LIST_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 60_000

/* ── tool-name prefixing (pure, unit-tested) ──────────────────────────── */

/** `mcp__<connector>__<tool>` — sanitized so the wire name matches
 *  OpenAI's tool-name charset. Connector names are registry-validated
 *  ([a-z0-9_-]); underscores are escaped to keep the separator reversible.
 *  Tool names from third-party servers get sanitized here. */
export function prefixedToolName(connector: string, tool: string): string {
  const clean = tool.replace(/[^a-zA-Z0-9_-]/g, '_')
  const encodedConnector = connector.replace(/_/g, '_u')
  return `mcp__${encodedConnector}__${clean}`.slice(0, 64)
}

/** Parse the wire prefix. The tool portion is still the sanitized wire name;
 *  the connected client reverses it through its per-connection name map. */
export function splitPrefixedToolName(name: string): { connector: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep === rest.length - 2) return null
  return { connector: rest.slice(0, sep).replace(/_u/g, '_'), tool: rest.slice(sep + 2) }
}

/** MCP tool schema → OpenAI Responses function-tool def, name prefixed. */
export function mcpToolToFunctionTool(connector: string, tool: McpToolDef): {
  type: 'function'
  name: string
  description: string
  parameters: { [key: string]: unknown } | null
  strict: boolean
} {
  return {
    type: 'function',
    name: prefixedToolName(connector, tool.name),
    description: tool.description ?? '',
    parameters: (tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} }) as { [key: string]: unknown },
    strict: false,
  }
}

/** tools/call result → joined text. Throws-free: caller maps isError onto
 *  the ToolResult shape. */
export function mcpResultToText(result: unknown): McpToolResult {
  const r = (result ?? {}) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
  const parts = Array.isArray(r.content) ? r.content : []
  const textParts = parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
  const text = textParts.join('\n')
  const unsupportedTypes = [...new Set(parts
    .filter((p) => !p || p.type !== 'text' || typeof p.text !== 'string')
    .map((p) => p?.type ?? 'unknown'))]
  const unsupportedText = unsupportedTypes.length > 0
    ? `MCP returned unsupported content type(s): ${unsupportedTypes.join(', ')}`
    : ''
  return {
    text: text || unsupportedText,
    isError: r.isError === true || unsupportedTypes.length > 0,
  }
}

/* ── JSON-RPC plumbing ────────────────────────────────────────────────── */

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string
  result?: unknown
  error?: { code: number; message: string }
}

class McpError extends Error {}

interface PendingRpc {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  controller: AbortController
  abortCleanup?: () => void
}

/** Shared request/response matcher. Transport pushes decoded JSON-RPC
 *  messages to `onMessage`; `call` resolves by id with a timeout. */
class RpcPump {
  private terminalError: Error | undefined
  private nextId = 1
  private pending = new Map<number, PendingRpc>()
  private settle(id: number, err?: Error, value?: unknown): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.abortCleanup?.()
    if (err) {
      entry.controller.abort()
      entry.reject(err)
    } else {
      entry.resolve(value)
    }
  }
  onMessage(msg: unknown): void {
    const m = (msg ?? {}) as JsonRpcResponse
    if (m.id === undefined || m.id === null) return // notification
    const id = typeof m.id === 'string' ? Number(m.id) : m.id
    const entry = this.pending.get(id)
    if (!entry) return
    if (m.error) this.settle(id, new McpError(`MCP error ${m.error.code}: ${m.error.message}`))
    else this.settle(id, undefined, m.result)
  }
  call(
    method: string,
    params: unknown,
    timeoutMs: number,
    send: (payload: string, id: number, signal: AbortSignal) => void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.terminalError)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        this.settle(id, new McpError(`MCP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const entry: PendingRpc = { resolve, reject, timer, controller }
      if (signal) {
        const onAbort = () => this.settle(id, new McpError(`MCP ${method} aborted`))
        entry.abortCleanup = () => signal.removeEventListener('abort', onAbort)
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, entry)
      if (signal?.aborted) {
        this.settle(id, new McpError(`MCP ${method} aborted`))
        return
      }
      try {
        send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), id, controller.signal)
      } catch (e) {
        this.settle(id, e instanceof Error ? e : new Error(String(e)))
      }
    })
  }
  fail(id: number, err: Error): void {
    this.settle(id, err)
  }
  failAll(err: Error): void {
    this.terminalError = err
    for (const id of this.pending.keys()) this.settle(id, err)
  }
}

const CLIENT_INFO = { name: 'cumora-mcp', version: '0.1.0' }
const PROTOCOL_VERSION = '2024-11-05'

export interface McpClientHandle {
  /** Connector name (registry). */
  connector: string
  tools: McpToolDef[]
  /** Wire tool name → original server tool name. */
  toolNameMap: ReadonlyMap<string, string>
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>
  close(): Promise<void>
}

/** stdio transport: spawn the command with cwd pinned to the agent
 *  workspace; newline-delimited JSON-RPC on stdout. */
function connectStdio(spec: McpConnectorSpec, cwd: string): { pump: RpcPump; child: ChildProcess; close: () => Promise<void> } {
  const pump = new RpcPump()
  const child = spawn(spec.command ?? '', spec.args ?? [], {
    cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  // Install ownership before any protocol work, including spawn errors.
  let exited = false
  const closed = new Promise<void>((resolve) => child.once('close', () => { exited = true; resolve() }))
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    pump.failAll(new McpError('client closed'))
    if (exited) return
    if (process.platform === 'win32' && child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'],
        { windowsHide: true, timeout: 2000 }, () => resolve()))
    }
    const signalTree = (signal: NodeJS.Signals) => {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); return } catch { /* group already gone */ }
      }
      if (!exited) child.kill(signal)
    }
    const timer = setTimeout(() => signalTree('SIGKILL'), 2000)
    try {
      signalTree('SIGTERM')
      await closed
    } finally {
      clearTimeout(timer)
      if (process.platform !== 'win32') signalTree('SIGKILL')
    }
  })()
  child.stdin?.on('error', (e) => pump.failAll(e))
  child.stderr?.resume()
  const decoder = new StringDecoder('utf8')
  let buf = ''
  const consume = (text: string) => {
    buf += text
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (!line) continue
      try { pump.onMessage(JSON.parse(line)) } catch { /* non-JSON log line */ }
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => consume(decoder.write(chunk)))
  child.stdout?.on('end', () => { consume(decoder.end()); pump.failAll(new McpError('MCP server stdout closed')) })
  child.on('error', (e) => pump.failAll(e))
  child.on('exit', (code) => pump.failAll(new McpError(`MCP server exited (code ${code})`)))
  return { pump, child, close }
}

/** streamable-HTTP transport: POST JSON-RPC; accept JSON or SSE bodies. */
function connectHttp(spec: McpConnectorSpec): { pump: RpcPump; url: string; headers: Record<string, string> } {
  const pump = new RpcPump()
  return {
    pump,
    url: spec.url ?? '',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(spec.headers ?? {}),
    },
  }
}

async function httpSend(
  url: string,
  headers: Record<string, string>,
  payload: string,
  pump: RpcPump,
  id: number,
  signal: AbortSignal,
): Promise<void> {
  // Streamable-HTTP: the JSON-RPC response arrives WITH the POST (inline
  // JSON or an SSE body). Either way it routes straight back into the pump.
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: payload,
    signal,
  })
  if (!res.ok) {
    await res.body?.cancel()
    throw new McpError(`MCP http ${res.status}`)
  }
  const sessionId = res.headers.get('mcp-session-id')
  if (sessionId) headers['mcp-session-id'] = sessionId
  if (id === 0 || res.status === 202) { await res.body?.cancel(); return }
  const ct = (res.headers.get('content-type') ?? '').toLowerCase()
  if (ct.includes('text/event-stream') && res.body) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n')
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (!data) continue
          let message: JsonRpcResponse
          try { message = JSON.parse(data) as JsonRpcResponse } catch { continue }
          pump.onMessage(message)
          if (String(message.id) === String(id)) return
        }
        if (done) throw new McpError('MCP HTTP stream ended without a response')
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  const message = await res.json() as JsonRpcResponse
  if (String(message.id) !== String(id)) throw new McpError('MCP HTTP response id mismatch')
  pump.onMessage(message)
}

/** Connect one connector: initialize handshake + tools/list. Throws on
 *  failure — the caller (turn.ts) degrades to "connector unavailable this
 *  turn" per the lifecycle contract. */
export async function connectMcpConnector(
  spec: McpConnectorSpec,
  opts: { cwd: string; signal?: AbortSignal; connectTimeoutMs?: number; callTimeoutMs?: number },
): Promise<McpClientHandle> {
  opts.signal?.throwIfAborted()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(spec.name) || spec.name.includes('__')) {
    throw new McpError('Invalid MCP connector name')
  }
  if (prefixedToolName(spec.name, '').length >= 64) {
    throw new McpError('MCP connector name leaves no room for a reversible tool name')
  }
  const lifetime = new AbortController()
  const connecting = AbortSignal.any([AbortSignal.timeout((opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS) + (opts.connectTimeoutMs ?? LIST_TIMEOUT_MS)), ...(opts.signal ? [opts.signal] : [])])
  const sending = new Set<Promise<void>>()
  let setProtocolVersion = (_version: string) => {}
  let pump = new RpcPump()
  let closeTransport: () => Promise<void> = async () => {}
  let closing: Promise<void> | undefined
  let closed = false
  const close = () => closing ??= (async () => {
    closed = true
    lifetime.abort()
    pump.failAll(new McpError('client closed'))
    await closeTransport()
    await Promise.allSettled(sending)
  })()
  let send: (payload: string, id: number, signal: AbortSignal) => Promise<void>
  try {
    if (spec.type === 'stdio') {
      const transport = connectStdio(spec, opts.cwd)
      pump = transport.pump
      closeTransport = transport.close
      send = async (payload) => {
        const stdin = transport.child.stdin
        if (!stdin?.writable) throw new McpError('MCP server stdin is not writable')
        await new Promise<void>((resolve, reject) => stdin.write(payload + '\n', e => e ? reject(e) : resolve()))
      }
    } else if (spec.type === 'http') {
      const h = connectHttp(spec)
      pump = h.pump
      setProtocolVersion = version => { h.headers['mcp-protocol-version'] = version }
      send = (payload, id, signal) => httpSend(h.url, h.headers, payload, pump, id, AbortSignal.any([signal, lifetime.signal]))
      closeTransport = async () => {
        await Promise.allSettled(sending)
        if (!h.headers['mcp-session-id']) return
        await fetch(h.url, { method: 'DELETE', headers: h.headers, signal: AbortSignal.timeout(2000) })
          .then(async response => { await response.body?.cancel() }).catch(() => {})
      }
    } else { throw new McpError('Unsupported MCP transport') }
    const dispatch = (payload: string, id: number, signal: AbortSignal) => {
      const request = send(payload, id, signal).catch(e => pump.fail(id, e instanceof Error ? e : new Error(String(e))))
      sending.add(request)
      void request.finally(() => sending.delete(request))
    }
    const timeout = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
    const initialized = await pump.call('initialize', {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO,
    }, timeout, dispatch, connecting) as { protocolVersion?: string; capabilities?: unknown }
    if (!initialized || typeof initialized.protocolVersion !== 'string' || !initialized.capabilities) {
      throw new McpError('Invalid MCP initialize response')
    }
    setProtocolVersion(initialized.protocolVersion)
    await send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), 0, connecting)
    const tools: McpToolDef[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const listed = await pump.call('tools/list', cursor ? { cursor } : {}, opts.connectTimeoutMs ?? LIST_TIMEOUT_MS, dispatch, connecting) as { tools?: McpToolDef[]; nextCursor?: string }
      if (!listed || !Array.isArray(listed.tools)) throw new McpError('Invalid MCP tools/list response')
      tools.push(...listed.tools)
      cursor = listed.nextCursor
      if (cursor !== undefined && (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 100)) {
        throw new McpError('Invalid MCP tools/list cursor')
      }
      if (cursor) cursors.add(cursor)
    } while (cursor)
    const toolNameMap = new Map<string, string>()
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) throw new McpError('Invalid MCP tool name')
      const wireName = prefixedToolName(spec.name, tool.name)
      const previous = toolNameMap.get(wireName)
      if (previous !== undefined) throw new McpError(`MCP connector ${spec.name} has tool name collision: ${previous} and ${tool.name} → ${wireName}`)
      toolNameMap.set(wireName, tool.name)
    }
    return {
      connector: spec.name, tools, toolNameMap,
      async callTool(name, args, signal) {
        if (closed) throw new McpError('client closed')
        const wireName = toolNameMap.has(name) ? name : prefixedToolName(spec.name, name)
        const originalName = toolNameMap.get(wireName)
        if (originalName === undefined) throw new McpError(`MCP tool ${name} is not available on connector ${spec.name}`)
        const result = await pump.call('tools/call', { name: originalName, arguments: args }, opts.callTimeoutMs ?? CALL_TIMEOUT_MS, dispatch, signal)
        return mcpResultToText(result)
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
