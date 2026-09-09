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

/** Inverse of prefixedToolName. Returns null for non-MCP names. */
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
  const text = parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
  return { text, isError: r.isError === true }
}

/* ── JSON-RPC plumbing ────────────────────────────────────────────────── */

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string
  result?: unknown
  error?: { code: number; message: string }
}

class McpError extends Error {}

/** Shared request/response matcher. Transport pushes decoded JSON-RPC
 *  messages to `onMessage`; `call` resolves by id with a timeout. */
class RpcPump {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  onMessage(msg: unknown): void {
    const m = (msg ?? {}) as JsonRpcResponse
    if (m.id === undefined || m.id === null) return // notification
    const id = typeof m.id === 'string' ? Number(m.id) : m.id
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (m.error) entry.reject(new McpError(`MCP error ${m.error.code}: ${m.error.message}`))
    else entry.resolve(m.result)
  }
  call(method: string, params: unknown, timeoutMs: number, send: (payload: string) => void): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError(`MCP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }
  failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }
}

const CLIENT_INFO = { name: 'cumora-mcp', version: '0.1.0' }
const PROTOCOL_VERSION = '2024-11-05'

async function handshake(pump: RpcPump, send: (p: string) => void): Promise<void> {
  await pump.call('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }, CONNECT_TIMEOUT_MS, send)
  send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
}

export interface McpClientHandle {
  /** Connector name (registry). */
  connector: string
  tools: McpToolDef[]
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>
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
  let buf = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (!line) continue
      try { pump.onMessage(JSON.parse(line)) } catch { /* non-JSON log line */ }
    }
  })
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

async function httpSend(url: string, headers: Record<string, string>, payload: string, pump: RpcPump, timeoutMs: number): Promise<void> {
  // Streamable-HTTP: the JSON-RPC response arrives WITH the POST (inline
  // JSON or an SSE body). Either way it routes straight back into the pump.
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new McpError(`MCP http ${res.status}`)
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
  let send: (payload: string) => void

  if (spec.type === 'stdio') {
    const s = connectStdio(spec, opts.cwd)
    pump = s.pump
    child = s.child
    send = (p) => child?.stdin?.write(p + '\n')
  } else {
    const h = connectHttp(spec)
    pump = h.pump
    send = (p) => { void httpSend(h.url, h.headers, p, pump, CALL_TIMEOUT_MS).catch((e) => pump.failAll(e instanceof Error ? e : new Error(String(e)))) }
  }

  await handshake(pump, send)
  const listed = (await pump.call('tools/list', {}, LIST_TIMEOUT_MS, send)) as { tools?: McpToolDef[] }
  const tools = Array.isArray(listed?.tools) ? listed.tools : []

  return {
    connector: spec.name,
    tools,
    async callTool(name, args) {
      const result = await pump.call('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS, send)
      return mcpResultToText(result)
    },
    async close() {
      pump.failAll(new McpError('client closed'))
      if (child) {
        child.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000)
          child.once('exit', () => { clearTimeout(t); resolve() })
        })
      }
    },
  }
}
