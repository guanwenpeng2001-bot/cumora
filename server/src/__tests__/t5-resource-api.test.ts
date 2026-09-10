import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { pool } from '../db/pool.js'
import * as skills from '../skill-library.js'
import * as mcp from '../mcp-connectors.js'

test('skills/MCP endpoint contracts: role redaction, errors and strict ID arrays', async (t) => {
  type Req = { params: { id: string }; body: Record<string, unknown>; query: Record<string, unknown> }
  type Res = { status(code: number): Res; json(body: unknown): void }
  type Handler = (req: Req, res: Res) => Promise<void>
  const handlers = new Map<string, Handler>()
  const api = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path: string, handler: Handler) => handlers.set(method + ' ' + path, handler)]))
  let role = 'member'
  let writes = 0
  const connector = { id: 'm1', company_id: 'c1', name: 'one', type: 'stdio', command: 'command-secret',
    args: ['arg-secret'], env: { TOKEN: 'env-secret' }, url: 'https://url-secret',
    headers: { Authorization: 'header-secret' }, enabled: true, created_at: new Date(), on: true }
  const query = async (sql: string, params?: unknown[]) => {
    if (sql.includes('company_members')) return { rows: [{ role }] }
    if (sql.includes('SELECT id FROM participants')) return { rows: params?.[0] === 'a' ? [{ id: 'a' }] : [] }
    if (sql.includes('FROM mcp_connectors')) return { rows: [connector] }
    if (sql === 'LOCK TABLE mcp_connectors IN SHARE ROW EXCLUSIVE MODE') return { rows: [] }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
    writes++
    throw new Error('unexpected query')
  }
  t.mock.method(pool, 'query', query)
  t.mock.method(pool, 'connect', async () => ({ query, release() {} }))
  class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }
  const source = readFileSync(new URL('../api/router.ts', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('function resourceSafe('), source.indexOf("api.put('/usage/pricing'"))
  runInNewContext(ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    ...skills, ...mcp, api, pool, HttpError, PRIVILEGED_ROLES: new Set(['owner', 'admin']),
    requireCompany: async () => ({ userId: 'u1', companyId: 'c1' }),
    requireCompanyRole: async () => {
      if (!['owner', 'admin'].includes(role)) throw new HttpError(403, 'forbidden')
      return { userId: 'u1', companyId: 'c1' }
    },
    safe: (handler: Handler) => async (req: Req, res: Res) => {
      try { await handler(req, res) } catch (e) {
        if (!(e instanceof HttpError)) throw e
        res.status(e.status).json({ error: e.message })
      }
    },
  })
  const call = async (route: string, body: Record<string, unknown> = {}, id = 'a') => {
    let status = 200
    let result: unknown
    const res: Res = { status(code) { status = code; return res }, json(value) { result = value } }
    await handlers.get(route)!({ params: { id }, body, query: {} }, res)
    return { status, json: JSON.stringify(result) }
  }

  for (const route of ['get /mcp-connectors', 'get /agents/:id/mcp-connectors']) {
    const member = await call(route)
    assert.equal(member.status, 200)
    assert.ok(!member.json.includes('-secret'))
    role = 'admin'
    assert.ok((await call(route)).json.includes('env-secret'))
    role = 'member'
  }
  assert.equal((await call('get /agents/:id/mcp-connectors', {}, 'foreign')).status, 404)
  assert.equal((await call('get /agents/:id/skills', {}, 'foreign')).status, 404)
  assert.equal((await call('post /mcp-connectors', { name: 'x' })).status, 403)
  role = 'admin'
  for (const [route, field] of [['put /agents/:id/skills', 'skillIds'], ['put /agents/:id/mcp-connectors', 'connectorIds']]) {
    assert.equal((await call(route, { [field]: ['valid', 1] })).status, 400)
    assert.equal((await call(route, { [field]: [] }, 'foreign')).status, 404)
  }
  assert.equal((await call('post /mcp-connectors', { name: 'x', type: 'stdio', command: 'node', enabled: 'false' })).status, 400)
  const old = process.env.SKILLHUB_URL
  t.after(() => { if (old === undefined) delete process.env.SKILLHUB_URL; else process.env.SKILLHUB_URL = old })
  process.env.SKILLHUB_URL = ''
  assert.equal((await call('post /skills/install', { hubId: 'x' })).status, 409)
  process.env.SKILLHUB_URL = 'https://hub.invalid'
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
  assert.equal((await call('post /skills/install', { hubId: 'x' })).status, 404)
  fetchMock.mock.mockImplementation(async () => { throw new Error('unreachable') })
  assert.equal((await call('post /skills/install', { hubId: 'x' })).status, 503)
  fetchMock.mock.mockImplementation(async () => Response.json({ files: [] }))
  assert.equal((await call('post /skills/install', { hubId: 'x' })).status, 400)
  assert.equal(writes, 0)
})
