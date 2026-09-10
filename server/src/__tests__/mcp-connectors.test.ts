/**
 * Unit tests for MCP connector validation + per-engine config generators
 * (all pure — no DB). Run:
 *   node --import tsx --test server/src/__tests__/mcp-connectors.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateConnector, buildClaudeMcpServers, buildClaudeMcpJson,
  mergeClaudeSecureMcpConfig, buildCodexMcpArgs, type McpConnectorRow,
} from '../mcp-connectors.js'

const stdio: McpConnectorRow = {
  id: 'mcp-1', companyId: 'c1', name: 'fs-local', type: 'stdio',
  command: 'npx', args: ['-y', '@mcp/fs', '/data'], env: { API_KEY: 'x' },
  url: null, headers: {}, enabled: true, createdAt: '2026-01-01',
}
const http: McpConnectorRow = {
  id: 'mcp-2', companyId: 'c1', name: 'remote-api', type: 'http',
  command: null, args: [], env: {},
  url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer t' },
  enabled: true, createdAt: '2026-01-01',
}

// ── validateConnector ─────────────────────────────────────────────────────

test('validateConnector accepts stdio and http shapes', () => {
  assert.equal(validateConnector({ name: 'fs-local', type: 'stdio', command: 'npx', args: ['-y'] }), null)
  assert.equal(validateConnector({ name: 'remote-api', type: 'http', url: 'https://x.example/mcp' }), null)
})

test('validateConnector rejects bad names / missing fields', () => {
  assert.match(validateConnector({ name: 'Bad Name', type: 'stdio', command: 'x' }) ?? '', /name/)
  assert.match(validateConnector({ name: 'a__b', type: 'stdio', command: 'x' }) ?? '', /__/)
  assert.match(validateConnector({ name: 'ok', type: 'stdio' }) ?? '', /command/)
  assert.match(validateConnector({ name: 'ok', type: 'http', url: 'ftp://x' }) ?? '', /url/)
  assert.match(validateConnector({ name: 'ok', type: 'grpc' }) ?? '', /type/)
})

// ── Claude config generation ──────────────────────────────────────────────

test('buildClaudeMcpServers: stdio and http shapes, disabled dropped', () => {
  const out = buildClaudeMcpServers([stdio, http, { ...stdio, id: 'mcp-3', name: 'off', enabled: false }])
  assert.deepEqual(out['fs-local'], { command: 'npx', args: ['-y', '@mcp/fs', '/data'], env: { API_KEY: 'x' } })
  assert.deepEqual(out['remote-api'], { type: 'http', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer t' } })
  assert.equal(out['off'], undefined)
})

test('buildClaudeMcpJson wraps in mcpServers', () => {
  const parsed = JSON.parse(buildClaudeMcpJson([http])) as { mcpServers: Record<string, unknown> }
  assert.ok(parsed.mcpServers['remote-api'])
})

test('mergeClaudeSecureMcpConfig: bridge wins name clashes; malformed input passes through', () => {
  const bridge = JSON.stringify({ mcpServers: { cumora: { command: 'node' } } })
  const merged = JSON.parse(mergeClaudeSecureMcpConfig(bridge, [http])) as { mcpServers: Record<string, unknown> }
  assert.ok(merged.mcpServers['cumora'])
  assert.ok(merged.mcpServers['remote-api'])
  // operator connector named 'cumora' cannot shadow the bridge
  const clash = JSON.parse(mergeClaudeSecureMcpConfig(bridge, [{ ...http, name: 'cumora' }])) as { mcpServers: Record<string, { command?: string }> }
  assert.equal(clash.mcpServers['cumora']?.command, 'node')
  assert.equal(mergeClaudeSecureMcpConfig('not-json', [http]), 'not-json')
  assert.equal(mergeClaudeSecureMcpConfig(bridge, []), bridge)
})

// ── Codex argv generation ─────────────────────────────────────────────────

test('buildCodexMcpArgs: one -c pair per connector, dashes normalized, escaping', () => {
  const args = buildCodexMcpArgs([stdio, http])
  assert.deepEqual(args, [
    '-c', 'mcp_servers.fs_local={command="npx",args=["-y","@mcp/fs","/data"],env={API_KEY="x"},default_tools_approval_mode="approve"}',
    '-c', 'mcp_servers.remote_api={url="https://mcp.example.com/sse",http_headers={"Authorization"="Bearer t"},default_tools_approval_mode="approve"}',
  ])
  // backslash/quote escaping
  const esc = buildCodexMcpArgs([{ ...stdio, command: 'C:\\tools\\"x".exe', args: [] }])
  assert.match(esc[1] ?? '', /command="C:\\\\tools\\\\\\"x\\"\.exe"/)
})

test('Codex rejects normalized name collisions and preserves the built-in cumora bridge', (t) => {
  const warnings: string[] = []
  t.mock.method(console, 'warn', (line: string) => warnings.push(line))
  const args = buildCodexMcpArgs([stdio, { ...http, name: 'fs_local' }, { ...http, name: 'cumora' }, http])
  assert.equal(args.filter(arg => arg.startsWith('mcp_servers.fs_local=')).length, 1)
  assert.equal(args.some(arg => arg.startsWith('mcp_servers.cumora=')), false)
  assert.equal(args.some(arg => arg.startsWith('mcp_servers.remote_api=')), true)
  assert.equal(warnings.length, 2)
  assert.ok(warnings.every(line => line.includes('failed')))
  assert.ok(warnings.every(line => !line.includes('Bearer t')))
})

test('Codex headers preserve quoted names and control-character escaping in TOML', () => {
  const args = buildCodexMcpArgs([{ ...http, headers: { Authorization: 'Bearer t', 'X-Api-Key': 'a"b', 'X-Extra': '中文' } },
    { ...stdio, args: ['line1\nline2\tend'], env: { 'key.with.dot': 'value' } }])
  assert.ok(args[1].includes('http_headers={"Authorization"="Bearer t","X-Api-Key"="a\\"b","X-Extra"="中文"}'))
  assert.ok(args[3].includes(String.raw`args=["line1\nline2\tend"]`))
  assert.ok(args[3].includes('env={"key.with.dot"="value"}'))
})

test('Codex TOML escapes DEL rather than emitting a forbidden literal character', () => {
  const args = buildCodexMcpArgs([{ ...stdio, args: [String.fromCharCode(127)] }])
  assert.ok(args[1].includes(String.raw`args=["\u007f"]`))
  assert.equal(args[1].includes(String.fromCharCode(127)), false)
})
