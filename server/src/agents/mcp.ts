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
import { spawn, type ChildProcess } from 'node:child_process'
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
 *  ([a-z0-9_-]); tool names from third-party servers get sanitized here. */
export function prefixedToolName(connector: string, tool: string): string {
  const clean = tool.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `mcp__${connector}__${clean}`.slice(0, 64)
}

/** Parse the wire prefix. The tool portion is still the sanitized wire name;
 *  the connected client reverses it through its per-connection name map. */
export function splitPrefixedToolName(name: string): { connector: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep === rest.length - 2) return null
  return { connector: rest.slice(0, sep), tool: rest.slice(sep + 2) }
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
    for (const id of this.pending.keys()) this.settle(id, err)
  }
}

const CLIENT_INFO = { name: 'cumora-mcp', version: '0.1.0' }
const PROTOCOL_VERSION = '2024-11-05'

async function handshake(pump: RpcPump, send: (p: string, id: number, signal: AbortSignal) => void): Promise<void> {
  await pump.call('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }, CONNECT_TIMEOUT_MS, send)
  send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), 0, AbortSignal.timeout(CALL_TIMEOUT_MS))
}

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
function connectStdio(spec: McpConnectorSpec, cwd: string): { pump: RpcPump; child: ChildProcess } {
  const child = spawn(spec.command ?? '', spec.args ?? [], {
    cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pump = new RpcPump()
  child.stdin?.on('error', (e) => pump.failAll(e))
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
  child.stdout?.on('end', () => consume(decoder.end()))
  child.on('error', (e) => pump.failAll(e))
  child.on('exit', (code) => pump.failAll(new McpError(`MCP server exited (code ${code})`)))
  return { pump, child }
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
    pump.fail(id, new McpError(`MCP http ${res.status}`))
    return
  }
  const ct = (res.headers.get('content-type') ?? '').toLowerCase()
  const text = await res.text()
  if (ct.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const data = t.slice(5).trim()
      if (!data) continue
      try { pump.onMessage(JSON.parse(data)) } catch { /* skip */ }
    }
    return
  }
  if (!text.trim()) return
  try { pump.onMessage(JSON.parse(text)) } catch { /* skip */ }
}

/** Connect one connector: initialize handshake + tools/list. Throws on
 *  failure — the caller (turn.ts) degrades to "connector unavailable this
 *  turn" per the lifecycle contract. */
export async function connectMcpConnector(
  spec: McpConnectorSpec,
  opts: { cwd: string },
): Promise<McpClientHandle> {
  let pump: RpcPump
  let child: ChildProcess | null = null
  let send: (payload: string, id: number, signal: AbortSignal) => void

  if (spec.type === 'stdio') {
    const s = connectStdio(spec, opts.cwd)
    pump = s.pump
    child = s.child
    send = (p) => {
      const stdin = child?.stdin
      if (!stdin || !stdin.writable) {
        pump.failAll(new McpError('MCP server stdin is not writable'))
        return
      }
      try {
        stdin.write(p + '\n')
      } catch (e) {
        pump.failAll(e instanceof Error ? e : new Error(String(e)))
      }
    }
  } else {
    const h = connectHttp(spec)
    pump = h.pump
    send = (p, id, signal) => {
      void httpSend(h.url, h.headers, p, pump, id, signal).catch((e) => {
        pump.fail(id, e instanceof Error ? e : new Error(String(e)))
      })
    }
  }

  await handshake(pump, send)
  const listed = (await pump.call('tools/list', {}, LIST_TIMEOUT_MS, send)) as { tools?: McpToolDef[] }
  const tools = Array.isArray(listed?.tools) ? listed.tools : []
  const toolNameMap = new Map<string, string>()
  for (const tool of tools) {
    const wireName = prefixedToolName(spec.name, tool.name)
    const previous = toolNameMap.get(wireName)
    if (previous !== undefined) {
      if (child && child.exitCode === null) child.kill('SIGTERM')
      throw new McpError(`MCP connector ${spec.name} has tool name collision: ${previous} and ${tool.name} → ${wireName}`)
    }
    toolNameMap.set(wireName, tool.name)
  }

  return {
    connector: spec.name,
    tools,
    toolNameMap,
    async callTool(name, args, signal) {
      const wireName = toolNameMap.has(name) ? name : prefixedToolName(spec.name, name)
      const originalName = toolNameMap.get(wireName)
      if (originalName === undefined) throw new McpError(`MCP tool ${name} is not available on connector ${spec.name}`)
      const result = await pump.call('tools/call', { name: originalName, arguments: args }, CALL_TIMEOUT_MS, send, signal)
      return mcpResultToText(result)
    },
    async close() {
      pump.failAll(new McpError('client closed'))
      if (child) {
        if (child.exitCode !== null) return
        child.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000)
          child.once('exit', () => { clearTimeout(t); resolve() })
        })
      }
    },
  }
}
