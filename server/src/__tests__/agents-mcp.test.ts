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
  mcpResultToText, connectMcpConnector,
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
