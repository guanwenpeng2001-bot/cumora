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
    '-c', 'mcp_servers.fs_local={command="npx",args=["-y","@mcp/fs","/data"],env={API_KEY="x"}}',
    '-c', 'mcp_servers.remote_api={url="https://mcp.example.com/sse"}',
  ])
  // backslash/quote escaping
  const esc = buildCodexMcpArgs([{ ...stdio, command: 'C:\\tools\\"x".exe', args: [] }])
  assert.match(esc[1] ?? '', /command="C:\\\\tools\\\\\\"x\\"\.exe"/)
})
