import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { mcpToolToFunctionTool, type McpClientHandle, type McpConnectorSpec } from '../agents/mcp.js'

// Execute the actual turn connection/cleanup blocks without database or model I/O.
function turnFixture(connect: (spec: McpConnectorSpec, opts: any) => Promise<McpClientHandle>) {
  const source = readFileSync(new URL('../agents/turn.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  const seenMcpConnectorNames = new Set<string>()')
  const end = source.indexOf('  for (let hop = 0;', start)
  const closeStart = source.indexOf('    for (const client of mcpClients) {', end)
  const closeEnd = source.indexOf('    await runtime.applyPendingResources', closeStart)
  assert.ok(start > 0 && end > start && closeStart > end && closeEnd > closeStart)
  const body = `async function run(persona, options = {}) {
    const mcpClients = [], mcpToolDefs = [], events = []
    const runCompanyId = 'company', runId = 'run', agentId = 'agent'
    const runtime = { recordEvent: async event => { events.push(event); if (options.eventFailure) throw Error('offline') } }
    try {
      ${source.slice(start, end)}
      options.signal?.throwIfAborted()
      return { events, mcpToolDefs, reply: 'ordinary conversation continued', clients: mcpClients.map(c => c.connector) }
    } finally { ${source.slice(closeStart, closeEnd)} }
  }
  return run`
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function('connectMcpConnector', 'mcpToolToFunctionTool', 'mcpConnectorFailureCache', 'MCP_CONNECT_FAILURE_CACHE_MS', 'MCP_TOOL_SCHEMA_MAX_BYTES', 'errorText', compiled)(
    connect, mcpToolToFunctionTool, new Map(), 30000, 8000, String,
  ) as (persona: any, options?: any) => Promise<any>
}

test('turn: failed connector and failing telemetry preserve the healthy connector and ordinary reply', async () => {
  const closed: string[] = []
  const run = turnFixture(async spec => {
    if (spec.name === 'broken') throw new Error('mock handshake failure')
    return { connector: spec.name, tools: [{ name: 'echo' }], toolNameMap: new Map(),
      callTool: async () => ({ text: 'echo', isError: false }), close: async () => { closed.push(spec.name) } }
  })
  const result = await run({ mcpConnectors: [{ name: 'broken' }, { name: 'healthy' }] }, { eventFailure: true })
  assert.equal(result.reply, 'ordinary conversation continued')
  assert.deepEqual(result.clients, ['healthy'])
  assert.deepEqual(result.mcpToolDefs.map((tool: any) => tool.name), ['mcp__healthy__echo'])
  assert.equal(result.events[0].kind, 'mcp.connector_failed')
  assert.deepEqual(closed, ['healthy'])
})

test('turn: cancellation reaches connections and closes successful siblings', async () => {
  const controller = new AbortController()
  let closed = 0
  const run = turnFixture(async (spec, opts) => {
    assert.equal(opts.signal, controller.signal)
    if (spec.name === 'pending') {
      controller.abort()
      throw new Error('aborted')
    }
    return { connector: spec.name, tools: [], toolNameMap: new Map(),
      callTool: async () => ({ text: '', isError: false }), close: async () => { closed++ } }
  })
  await assert.rejects(run({ mcpConnectors: [{ name: 'healthy' }, { name: 'pending' }] }, { signal: controller.signal }), /abort/i)
  assert.equal(closed, 1)
})
