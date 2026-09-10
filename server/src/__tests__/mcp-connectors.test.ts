/**
 * Unit tests for MCP connector validation + per-engine config generators
 * (all pure — no DB). Run:
 *   node --import tsx --test server/src/__tests__/mcp-connectors.test.ts
 */
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { buildEngineCodexMcpInjection } from '../agents/computer/engine.js'
import { refreshServerSettings, validateServerSettings } from '../settings.js'
import { pool } from '../db/pool.js'
import { setAgentConnectors, upsertConnector } from '../mcp-connectors.js'
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

test('Codex rejects normalized collisions atomically with structured failures', () => {
  const connectors = [stdio, { ...http, name: 'fs_local' }, { ...http, name: 'cumora' }, http]
  const result = buildEngineCodexMcpInjection(connectors)
  assert.deepEqual(result.args, [])
  assert.deepEqual(result.failures, [
    { name: 'fs_local', error: 'mcp_name_conflict' },
    { name: 'cumora', error: 'mcp_name_conflict' },
  ])
  assert.throws(() => buildCodexMcpArgs(connectors), /names conflict/)
  assert.ok(!JSON.stringify(result).includes('Bearer t'))
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


test('daemon reports failed for normalized and built-in conflicts', () => {
  const source = readFileSync(new URL('../agents/computer/daemon.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('daemon.ts', source, ts.ScriptTarget.Latest, true)
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'AgentRunner') as ts.ClassDeclaration
  const method = cls.members.find(n => n.name?.getText(ast) === 'resourceResult')!.getText(ast)
  const js = ts.transpile(`class Runner { ${method} }; return Runner`, { target: ts.ScriptTarget.ES2022 })
  const Runner = new Function('buildEngineCodexMcpInjection', js)(buildEngineCodexMcpInjection)
  const runner = new Runner()
  runner.adapter = { id: 'codex' }
  for (const mcpConnectors of [[stdio, { ...http, name: 'fs_local' }], [{ ...http, name: 'cumora' }]]) {
    assert.equal(runner.resourceResult({ resourceVersion: 'v1', mcpConnectors }).status, 'failed')
  }
  assert.deepEqual(runner.resourceResult({ resourceVersion: 'v2', mcpConnectors: [stdio, http] }), { version: 'v2', status: 'applied' })
  runner.adapter.id = 'claude'
  assert.equal(runner.resourceResult({ resourceVersion: 'v3', mcpConnectors: [{ ...http, name: 'cumora' }] }).status, 'failed')
})

test('Codex binding and bound connector updates reject conflicts before mutation', async (t) => {
  const sqls: string[] = []
  let names = ['a-b', 'a_b']
  const query = async (sql: string) => {
    sqls.push(sql)
    if (sql.includes('SELECT id, name FROM mcp_connectors')) return { rows: names.map((name, i) => ({ id: String(i), name })) }
    if (sql.includes('SELECT engine')) return { rows: [{ engine: 'codex' }] }
    if (sql.includes('SELECT p.id AS agent_id')) return { rows: [{ agent_id: 'a', name: 'a-b' }] }
    if (sql.includes('SELECT id FROM participants')) return { rows: [{ id: 'a' }] }
    return { rows: [] }
  }
  t.mock.method(pool, 'connect', async () => ({ query, release() {} }))
  await assert.rejects(setAgentConnectors('c1', 'a', ['0', '1']), { status: 409 })
  names = ['cumora']
  await assert.rejects(setAgentConnectors('c1', 'a', ['0']), { status: 409 })
  await assert.rejects(upsertConnector('c1', { id: 'm', name: 'a_b', type: 'stdio', command: 'node' }), { status: 409 })
  assert.equal(sqls.filter(sql => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)).length, 0)
})

test('private HTTP hosts require explicit site opt-in', async (t) => {
  const urls = ['http://127.1', 'http://2130706433', 'http://169.254.1.1', 'http://10.1.2.3',
    'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.0.1', 'http://localhost.',
    'http://x.internal.', 'http://metadata.google.internal', 'http://instance-data.ec2.internal',
    'http://sub2api:8080', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[fe80::1]', 'http://[fd00::1]']
  const check = (url: string) => validateConnector({ name: 'private', type: 'http', url })
  let settingRows: { key: string; value: string }[] = []
  const origQuery = pool.query
  // t.mock.method does not reliably replace the pg Pool's prototype query here;
  // assign directly and restore in finally.
  ;(pool as unknown as { query: unknown }).query = async () => ({ rows: [...settingRows, { key: '__settings_revision', value: String(Date.now()) }] })
  try {
    await refreshServerSettings(true)
    for (const url of urls) assert.match(check(url) ?? '', /mcp_allow_private_hosts/, url)
    for (const url of ['http://172.15.0.1', 'https://172.32.0.1', 'https://mcp.example.com']) assert.equal(check(url), null)
    validateServerSettings({ mcp_allow_private_hosts: 'true' })
    assert.throws(() => validateServerSettings({ mcp_allow_private_hosts: 'yes' }))
    settingRows = [{ key: 'mcp_allow_private_hosts', value: 'true' }, { key: '__settings_revision', value: String(Date.now()) }]
    await refreshServerSettings(true)
    for (const url of urls) assert.equal(check(url), null, url)
  } finally {
    ;(pool as unknown as { query: unknown }).query = origQuery
    await refreshServerSettings(true)
  }
})
