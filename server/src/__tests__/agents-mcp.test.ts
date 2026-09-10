/**
 * Unit tests for the managed-runtime MCP client (phase 6):
 * tool-name prefixing/merging/routing pure functions + a live
 * initialize/list/call round-trip against a temporary echo MCP server
 * spawned over stdio. Run:
 *   node --import tsx --test server/src/__tests__/agents-mcp.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prefixedToolName, splitPrefixedToolName, mcpToolToFunctionTool,
  mcpResultToText, connectMcpConnector, stdioEnvironment,
} from '../agents/mcp.js'

// ── prefixedToolName / splitPrefixedToolName ─────────────────────────────

test('prefixedToolName builds mcp__<connector>__<tool>', () => {
  assert.equal(prefixedToolName('fs-local', 'read_file'), 'mcp__fs-local__read_file')
})

test('prefixedToolName sanitizes tool names and truncates to 64', () => {
  assert.equal(prefixedToolName('api', 'fail.me now'), 'mcp__api__fail_me_now')
  const long = prefixedToolName('api', 'x'.repeat(100))
  assert.equal(long.length, 64)
  assert.ok(long.startsWith('mcp__api__'))
})

test('splitPrefixedToolName round-trips and rejects non-MCP names', () => {
  assert.deepEqual(splitPrefixedToolName('mcp__fs-local__read_file'), { connector: 'fs-local', tool: 'read_file' })
  assert.equal(splitPrefixedToolName('bash'), null)
  assert.equal(splitPrefixedToolName('mcp__'), null)
  assert.equal(splitPrefixedToolName('mcp__only'), null)
  assert.equal(splitPrefixedToolName('mcp__c__'), null)
})

// ── mcpToolToFunctionTool ────────────────────────────────────────────────

test('mcpToolToFunctionTool passes inputSchema through, strict off', () => {
  const schema = { type: 'object', properties: { text: { type: 'string' } } }
  const def = mcpToolToFunctionTool('api', { name: 'echo', description: 'echo back', inputSchema: schema })
  assert.equal(def.type, 'function')
  assert.equal(def.name, 'mcp__api__echo')
  assert.deepEqual(def.parameters, schema)
  assert.equal(def.strict, false)
})

test('mcpToolToFunctionTool defaults schema/description when absent', () => {
  const def = mcpToolToFunctionTool('api', { name: 'ping' })
  assert.deepEqual(def.parameters, { type: 'object', properties: {} })
  assert.equal(def.description, '')
})

// ── mcpResultToText ──────────────────────────────────────────────────────

test('mcpResultToText joins text content and surfaces isError', () => {
  assert.deepEqual(
    mcpResultToText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }),
    { text: 'a\nb', isError: true },
  )
  assert.deepEqual(
    mcpResultToText({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    { text: 'boom', isError: true },
  )
  assert.deepEqual(mcpResultToText(null), { text: '', isError: false })
})

// ── live stdio round-trip against a temporary echo MCP server ────────────

const ECHO_SERVER = `
let buf = ''
process.stdin.on('data', (c) => {
  buf += c.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '0.0.1' } })
    } else if (msg.method === 'tools/list') {
      reply(msg.id, { tools: [
        { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'fail', description: 'always errors' },
      ] })
    } else if (msg.method === 'tools/call') {
      if (msg.params.name === 'echo') reply(msg.id, { content: [{ type: 'text', text: String((msg.params.arguments || {}).text || '') }] })
      else reply(msg.id, { content: [{ type: 'text', text: 'boom' }], isError: true })
    }
  }
})
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }
`

test('connectMcpConnector: initialize/list/call round-trip over stdio', async (t) => {
  const serverPath = join(tmpdir(), `cumora-echo-mcp-${process.pid}.js`)
  writeFileSync(serverPath, ECHO_SERVER, 'utf8')
  t.after(() => rmSync(serverPath, { force: true }))

  const client = await connectMcpConnector(
    { name: 'echo-srv', type: 'stdio', command: process.execPath, args: [serverPath] },
    { cwd: tmpdir() },
  )
  t.after(() => client.close().catch(() => { /* best-effort */ }))

  assert.deepEqual(client.tools.map((tool) => tool.name), ['echo', 'fail'])

  const ok = await client.callTool('echo', { text: 'hello mcp' })
  assert.deepEqual(ok, { text: 'hello mcp', isError: false })

  const bad = await client.callTool('fail', {})
  assert.equal(bad.isError, true)
  assert.equal(bad.text, 'boom')

  await client.close()
})

test('connectMcpConnector: connect failure rejects (turn degrades)', async () => {
  await assert.rejects(
    connectMcpConnector(
      { name: 'dead', type: 'stdio', command: process.execPath, args: ['-e', 'process.exit(1)'] },
      { cwd: tmpdir() },
    ),
  )
})

const FAILURE_SERVER = String.raw`
const fs = require('node:fs')
fs.writeFileSync(process.env.MCP_TEST_PID, String(process.pid))
setTimeout(() => process.exit(0), 10000).unref()
const mode = process.env.MCP_TEST_MODE
if (mode === 'tree') {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10000)'], { stdio: 'ignore', windowsHide: true })
  fs.writeFileSync(process.env.MCP_TEST_PID + '.child', String(child.pid))
}
process.stdin.setEncoding('utf8')
let input = ''
process.stdin.on('data', chunk => {
  input += chunk
  let nl
  while ((nl = input.indexOf('\n')) >= 0) {
    const msg = JSON.parse(input.slice(0, nl)); input = input.slice(nl + 1)
    if (!msg.id) continue
    if (mode === msg.method + '-timeout') continue
    if (mode === msg.method + '-error' || mode === 'tree') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'fixture failure' } }) + '\n')
      continue
    }
    let result = { protocolVersion: '2024-11-05', capabilities: {} }
    if (msg.method === 'tools/list') result = { tools: mode === 'collision'
      ? [{ name: 'same.name' }, { name: 'same_name' }]
      : mode === 'truncation' ? [{ name: 'x'.repeat(80) + 'a' }, { name: 'x'.repeat(80) + 'b' }]
      : mode === 'invalid-name' ? [{ name: null }]
      : mode === 'invalid-list' ? null : [{ name: 'echo' }] }
    if (mode === 'invalid-handshake' && msg.method === 'initialize') result = {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  }
})
`

for (const mode of ['initialize-error', 'tools/list-error', 'initialize-timeout', 'tools/list-timeout', 'collision', 'invalid-name', 'invalid-list', 'invalid-handshake', 'truncation', 'tree']) {
  test(`failed stdio ${mode}: child has exited before rejection`, async (t) => {
    const { mkdtempSync, readFileSync, existsSync } = await import('node:fs')
    const root = mkdtempSync(join(tmpdir(), 'mcp-failure-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const pidFile = join(root, 'pid')
    await assert.rejects(connectMcpConnector({ name: 'broken', type: 'stdio', command: process.execPath,
      args: ['-e', FAILURE_SERVER], env: { MCP_TEST_MODE: mode, MCP_TEST_PID: pidFile } },
    { cwd: root, connectTimeoutMs: 500 }), /MCP/)
    // The fixture writes its pid asynchronously at spawn; wait briefly on slow CI.
    const pidDeadline = Date.now() + 5000
    while (!existsSync(pidFile) && Date.now() < pidDeadline) await new Promise((r) => setTimeout(r, 25))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    if (mode === 'tree') assert.throws(() => process.kill(Number(readFileSync(pidFile + '.child', 'utf8')), 0), { code: 'ESRCH' })
  })
}

test('spawn ENOENT rejects and cleanup is bounded', async () => {
  await assert.rejects(connectMcpConnector({ name: 'missing', type: 'stdio', command: join(tmpdir(), 'absent-mcp-command') },
    { cwd: tmpdir(), connectTimeoutMs: 500 }), /ENOENT/)
})

async function httpFixture(t: import('node:test').TestContext, mode = 'json') {
  const { createServer } = await import('node:http')
  const requests: Array<{ method: string; headers: import('node:http').IncomingHttpHeaders; params?: any }> = []
  const disconnected: string[] = []
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer mock' || req.headers['x-test-key'] !== 'mock-extra') {
      res.writeHead(401).end(); return
    }
    if (req.method === 'DELETE') { requests.push({ method: 'DELETE', headers: req.headers }); res.writeHead(204).end(); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const msg = JSON.parse(body)
    requests.push({ method: msg.method, headers: req.headers, params: msg.params })
    if (msg.method !== 'initialize' && req.headers['mcp-session-id'] !== 'mock-session') { res.writeHead(400).end(); return }
    if (mode === 'notify-error' && !msg.id) { res.writeHead(403).end(); return }
    if (!msg.id) { res.writeHead(202).end(); return }
    if ((mode === 'list-error' && msg.method === 'tools/list') || (mode === 'initialize-error' && msg.method === 'initialize')) {
      res.writeHead(503).end(); return
    }
    if (msg.method === 'tools/call' && msg.params.arguments.wait) {
      res.on('close', () => disconnected.push('call')); return
    }
    const result = msg.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} } }
      : msg.method === 'tools/list' ? { tools: [{ name: 'echo.with punctuation' }] }
      : { content: [{ type: 'text', text: `${msg.params.name}:${msg.params.arguments.text}` }] }
    res.setHeader('mcp-session-id', 'mock-session')
    if (mode === 'sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = `data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\r\n\r\n`
      res.write(event.slice(0, -1))
      setTimeout(() => res.write(event.slice(-1)), 5)
      // Deliberately leave the SSE stream open; receiving the RPC must suffice.
    } else { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address() as import('node:net').AddressInfo
  return { spec: { name: 'http-echo', type: 'http' as const, url: `http://127.0.0.1:${address.port}/mcp`,
    headers: { Authorization: 'Bearer mock', 'X-Test-Key': 'mock-extra' } }, requests, disconnected }
}

for (const mode of ['json', 'sse']) {
  test(`HTTP ${mode}: actual call, reversible name, auth, session and close`, async (t) => {
    const fixture = await httpFixture(t, mode)
    const client = await connectMcpConnector(fixture.spec, { cwd: tmpdir(), connectTimeoutMs: 1000 })
    t.after(() => client.close())
    const result = await client.callTool(prefixedToolName(fixture.spec.name, 'echo.with punctuation'), { text: '中文' })
    assert.equal(result.text, 'echo.with punctuation:中文')
    await Promise.all([client.close(), client.close()])
    assert.equal(fixture.requests.filter(r => r.method === 'DELETE').length, 1)
    await assert.rejects(client.callTool('echo.with punctuation', {}), /closed/)
  })
}

for (const mode of ['initialize-error', 'list-error', 'notify-error']) {
  test(`HTTP ${mode}: rejects without reporting a connection`, async (t) => {
    const fixture = await httpFixture(t, mode)
    await assert.rejects(connectMcpConnector(fixture.spec, { cwd: tmpdir(), connectTimeoutMs: 500 }), /MCP http/)
    assert.equal(fixture.requests.filter(r => r.method === 'DELETE').length, mode === 'initialize-error' ? 0 : 1)
  })
}

test('HTTP single-RPC cancellation and timeout leave other calls usable', async (t) => {
  const fixture = await httpFixture(t)
  const client = await connectMcpConnector(fixture.spec, { cwd: tmpdir(), callTimeoutMs: 150 })
  t.after(() => client.close())
  const controller = new AbortController()
  const cancelled = assert.rejects(client.callTool('echo.with punctuation', { wait: true }, controller.signal), /aborted/)
  const good = client.callTool('echo.with punctuation', { text: 'first' })
  setTimeout(() => controller.abort(), 30)
  await cancelled
  assert.equal((await good).text, 'echo.with punctuation:first')
  await assert.rejects(client.callTool('echo.with punctuation', { wait: true }), /timed out/)
  assert.equal((await client.callTool('echo.with punctuation', { text: 'after' })).text, 'echo.with punctuation:after')
  await client.close()
})

test('connector underscores and tool-leading underscores remain reversible', () => {
  for (const connector of ['a_', 'a_u', 'a_b', 'a_-b']) {
    for (const tool of ['_tool', '__tool', 'plain']) {
      assert.deepEqual(splitPrefixedToolName(prefixedToolName(connector, tool)), { connector, tool })
    }
  }
})

test('unrepresentable connector name fails before spawning', async () => {
  await assert.rejects(connectMcpConnector({ name: 'a'.repeat(64), type: 'stdio', command: 'must-not-spawn' },
    { cwd: tmpdir() }), /reversible tool name/)
})

test('stdio cancellation affects one RPC, preserving the connection and original tool name', async (t) => {
  const source = ECHO_SERVER.replace("if (msg.params.name === 'echo')", "if (msg.params.arguments?.wait) continue; if (msg.params.name === 'echo')")
  const serverPath = join(tmpdir(), `cumora-mcp-cancel-${process.pid}.cjs`)
  writeFileSync(serverPath, source)
  t.after(() => rmSync(serverPath, { force: true }))
  const client = await connectMcpConnector({ name: 'echo_', type: 'stdio', command: process.execPath, args: [serverPath] }, { cwd: tmpdir() })
  t.after(() => client.close())
  const controller = new AbortController()
  const cancelled = assert.rejects(client.callTool('echo', { wait: true }, controller.signal), /aborted/)
  controller.abort()
  await cancelled
  const result = await client.callTool(prefixedToolName('echo_', 'echo'), { text: 'still alive' })
  assert.equal(result.text, 'still alive')
})


test('stdio env excludes ambient credentials and runtime/bootstrap/loader settings', () => {
  const childEnv = stdioEnvironment({ CONNECTOR_TOKEN: 'connector-only', LANG: 'C.UTF-8' }, {
    PATH: '/bin', HOME: '/home/agent', LANG: 'C', SYSTEMROOT: 'C:/Windows',
    DATABASE_URL: 'db-secret', REDIS_URL: 'redis-secret', OPENAI_API_KEY: 'provider-secret',
    NOVITA_API_KEY: 'novita-secret', ORCAROUTER_API_KEY: 'router-secret',
    CUMORA_AGENT_RUNTIME_TOKEN: 'jwt', CUMORA_MANAGED_POD_BOOTSTRAP: 'all-the-keys',
    NODE_OPTIONS: '--require malicious-loader', HTTPS_PROXY: 'http://proxy-with-credentials',
  })
  assert.deepEqual(childEnv, { PATH: '/bin', HOME: '/home/agent', LANG: 'C.UTF-8',
    SYSTEMROOT: 'C:/Windows', CONNECTOR_TOKEN: 'connector-only' })
})

test('stdio env permits only explicitly supplied connector credentials', () => {
  assert.deepEqual(stdioEnvironment({ OPENAI_API_KEY: 'connector-key' }, { OPENAI_API_KEY: 'server-key' }),
    { OPENAI_API_KEY: 'connector-key' })
  if (process.platform === 'win32') {
    assert.deepEqual(stdioEnvironment({ PATH: 'explicit' }, { Path: 'inherited' }), { PATH: 'explicit' })
  }
})

test('HTTP transport rejects redirects on every JSON-RPC request', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    assert.equal(init?.redirect, 'error')
    throw new TypeError('redirect rejected')
  })
  await assert.rejects(connectMcpConnector({ name: 'redirect', type: 'http', url: 'https://mcp.example.com' }, { cwd: '.' }), /redirect rejected/)
})
