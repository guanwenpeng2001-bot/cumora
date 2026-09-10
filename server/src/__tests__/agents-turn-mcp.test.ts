import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { inboxTriageBoundary, parseWakeData } from '../agents/runtime/wake-options.js'
import { mcpToolToFunctionTool, type McpClientHandle, type McpConnectorSpec } from '../agents/mcp.js'

// Execute the actual turn connection/cleanup blocks without database or model I/O.
function turnFixture(connect: (spec: McpConnectorSpec, opts: any) => Promise<McpClientHandle>) {
  const source = readFileSync(new URL('../agents/turn.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  const seenMcpConnectorNames = new Set<string>()')
  const end = source.indexOf('  const plan = await resolveRoleCall', start)
  const closeStart = source.indexOf('    for (const client of mcpClients) {', end)
  const closeEnd = source.indexOf('    if (turnExecuted) await runtime.applyPendingResources', closeStart)
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
  return new Function('connectMcpConnector', 'mcpToolToFunctionTool', 'mcpConnectorFailureCache', 'MCP_CONNECT_FAILURE_CACHE_MS', 'MCP_FAILURE_CACHE_MAX', 'MCP_TOOL_SCHEMA_MAX_BYTES', 'errorText', 'capTtlMap', compiled)(
    connect, mcpToolToFunctionTool, new Map(), 30000, 2048, 8000, String,
    (map: Map<string, number>, max: number, expired: (value: number) => boolean) => {
      for (const [key, value] of map) if (expired(value)) map.delete(key)
      while (map.size >= max) {
        const first = map.keys().next().value
        if (first === undefined) break
        map.delete(first)
      }
    },
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


function runBlock(body: string, dependencies: Record<string, unknown>) {
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies))
}

for (const mode of ['failed', 'rejected', 'applied']) {
  test(`turn: resources ${mode} do not abort inbox processing, even when telemetry fails`, async () => {
    const source = readFileSync(new URL('../agents/turn.ts', import.meta.url), 'utf8')
    const start = source.indexOf('  const resources = await runtime.applyPendingResources')
    const end = source.indexOf('  const persona =', start)
    const eventStart = source.indexOf('    if (resourcesUnavailable) {', end)
    const eventEnd = source.indexOf('    // Reuse scheduler execute', eventStart)
    assert.ok(start > 0 && end > start && eventStart > end && eventEnd > eventStart)
    const events: any[] = []
    const run = runBlock(`return async function() {
      ${source.slice(start, end)}
      await runtime.loadInbox(agentId)
      ${source.slice(eventStart, eventEnd)}
      return { continued: true, resourcesUnavailable }
    }`, {
      agentId: 'a', runId: 'run', runCompanyId: 'company',
      runtime: {
        applyPendingResources: async () => {
          if (mode === 'rejected') throw Error('transport failed')
          return { status: mode, version: 'v2', error: mode === 'failed' ? 'skill_conflict' : undefined }
        },
        loadInbox: async () => [{ id: 'unread' }],
        recordEvent: async (event: any) => { events.push(event); throw Error('telemetry offline') },
      },
    })
    const result = await run()
    assert.equal(result.continued, true)
    assert.equal(result.resourcesUnavailable, mode !== 'applied')
    assert.equal(events.length, mode === 'applied' ? 0 : 1)
    if (events.length) assert.equal(events[0].kind, 'resources.unavailable')
  })
}

for (const scenario of ['matching', 'changed', 'unclassified', 'ignore', 'defer']) {
  test(`turn: ${scenario} inbox preserves triage authority and acknowledgement semantics`, async () => {
    const source = readFileSync(new URL('../agents/turn.ts', import.meta.url), 'utf8')
    const start = source.indexOf('  const hasCurrentTriage =')
    const end = source.indexOf('  const memoryQuery =', start)
    assert.ok(start > 0 && end > start)
    const inbox = [{ id: 'one', conversation_id: 'c' }, { id: 'two', conversation_id: 'c' }]
    const options = scenario === 'unclassified' ? {} : parseWakeData(JSON.stringify({
      reason: 'message.new', triageNote: 'scheduler execute',
      triageBoundary: inboxTriageBoundary(scenario === 'matching' ? [...inbox].reverse() : [{ id: 'one' }]),
    })).options
    let calls = 0
    const reads: any[] = [], deferred: any[] = []
    const run = runBlock(`return async function(options) {
      let triageNote = options.triageNote || '', preloadedContext, finalStatus, finalSummary
      ${source.slice(start, end)}
      return 'continue to brain'
    }`, {
      inbox, inboxTriageBoundary, isBriefedManualWake: false, agentId: 'a', runId: 'run',
      runCompanyId: 'company', persona: { companyId: 'company' }, convoIds: ['c'],
      loadContext: async () => [], triageDisposition: (v: any) => v,
      classifyInboxTriage: async () => {
        calls++
        return { outcome: scenario === 'ignore' || scenario === 'defer' ? scenario : 'execute',
          ackAllowed: scenario === 'ignore', source: 'classifier', promptNote: 'work', reason: 'classified', retryAt: 12345 }
      },
      runtime: { markConversationRead: async (args: any) => { reads.push(args) }, recordEvent: async () => {} },
    })
    const result = await run({ ...options, onInboxDeferred: (value: any) => deferred.push(value) })
    assert.equal(calls, scenario === 'matching' ? 0 : 1)
    assert.equal(result, scenario === 'ignore' || scenario === 'defer' ? undefined : 'continue to brain')
    assert.deepEqual(reads, scenario === 'ignore' ? [{ agentId: 'a', conversationId: 'c', upToMessageId: 'two' }] : [])
    assert.deepEqual(deferred, scenario === 'defer' ? [{ messageIds: ['one', 'two'], retryAt: 12345 }] : [])
  })
}
