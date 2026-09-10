import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import * as modelConfig from '../agents/model-config.js'
import type * as Creation from '../agents/create.js'

const source = ts.transpileModule(readFileSync(new URL('../agents/create.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const input: Creation.CreateAgentRecordInput = {
  companyId: 'company-test', tier: 'pro', maxActiveAgents: 10,
  requestId: 'request-model-001', name: 'Test Agent', systemPrompt: 'Only a test agent',
}
function fixture() {
  const records: any[] = [], statements: string[] = [], inserts: unknown[][] = []
  let connections = 0, releases = 0
  const client = {
    async query(sql: string, values: any[] = []) {
      statements.push(sql)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
      if (sql.startsWith('SELECT id FROM companies')) return { rows: [{ id: input.companyId }], rowCount: 1 }
      if (sql.includes('p.creation_request_id = $2')) return { rows: records.filter(r => r.company_id === values[0] && r.request_id === values[1]) }
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: records.length }] }
      assert.match(sql, /^INSERT INTO participants/)
      inserts.push(values)
      records.push({ id: values[0], company_id: values[10], request_id: values[14], creation_request_hash: values[15], model_config: values[16] ? JSON.parse(values[16]) : null })
      return { rows: [{ id: values[0] }] }
    },
    release() { releases++ },
  }
  const exports = {} as typeof Creation
  new Function('exports', 'require', source)(exports, (name: string) => {
    if (name === 'node:crypto') return { createHash }
    if (name === '../db/pool.js') return { pool: { connect: async () => { connections++; return client } } }
    if (name === './model-config.js') return modelConfig
    if (name === './computer/registry.js') return {
      cloudComputerId: () => 'cloud-test',
      resolveComputerAssignment: () => { throw new Error('Unexpected placement lookup') },
    }
    throw new Error('Unexpected dependency: ' + name)
  })
  return { ...exports, records, inserts, statements, connections: () => connections, releases: () => releases }
}

test('same requestId and normalized modelConfig replay the original agent without a second insert', async () => {
  const f = fixture()
  const first = await f.createAgentRecord({ ...input, modelConfig: { effort: ' HIGH ', maxOutputTokens: 4000, fallbackModels: [' backup ', 'backup', 'last'] } })
  const replay = await f.createAgentRecord({ ...input, modelConfig: { fallbackModels: ['backup', 'last'], maxOutputTokens: 4000, effort: 'high' } })
  assert.equal(first.created, true)
  assert.equal(replay.created, false)
  assert.equal(replay.id, first.id)
  assert.equal(f.inserts.length, 1)
  assert.equal(f.connections(), f.releases())
})

for (const changed of [{ effort: 'low' }, { maxOutputTokens: 2000 }, { contextWindow: 32000 }, { fallbackModels: ['last', 'backup'] }]) {
  test(`same requestId with changed modelConfig returns 409: ${JSON.stringify(changed)}`, async () => {
    const f = fixture()
    const config = { effort: 'high', maxOutputTokens: 4000, contextWindow: 64000, fallbackModels: ['backup', 'last'] }
    await f.createAgentRecord({ ...input, modelConfig: config })
    await assert.rejects(f.createAgentRecord({ ...input, modelConfig: { ...config, ...changed } }),
      error => error instanceof f.AgentCreationError && error.status === 409)
    assert.equal(f.inserts.length, 1)
    assert.equal(f.statements.at(-1), 'ROLLBACK')
    assert.deepEqual(f.records[0].model_config, config)
    assert.equal(f.connections(), f.releases())
  })
}

for (const invalid of [
  { effort: 'ultra' }, { effort: 5 }, { maxOutputTokens: 0 }, { maxOutputTokens: -1 },
  { maxOutputTokens: 1.5 }, { maxOutputTokens: '4000' }, { maxOutputTokens: Infinity },
  { maxOutputTokens: modelConfig.MAX_OUTPUT_TOKENS + 1 }, { contextWindow: NaN },
  { contextWindow: '64000' }, { contextWindow: modelConfig.MAX_CONTEXT_WINDOW + 1 },
]) {
  test(`invalid config returns 400 before any database access: ${Object.keys(invalid)[0]}=${String(Object.values(invalid)[0])}`, async () => {
    const f = fixture()
    await assert.rejects(f.createAgentRecord({ ...input, modelConfig: invalid }),
      error => error instanceof f.AgentCreationError && error.status === 400)
    assert.equal(f.connections(), 0)
    assert.equal(f.inserts.length, 0)
  })
}

test('absent, null and empty overrides persist inheritance and replay identically', async () => {
  const f = fixture()
  const first = await f.createAgentRecord(input)
  for (const config of [null, {}, { fallbackModels: [] }]) {
    const replay = await f.createAgentRecord({ ...input, model: '  ', fastModel: '', modelConfig: config })
    assert.equal(replay.id, first.id)
    assert.equal(replay.created, false)
  }
  assert.equal(f.inserts.length, 1)
  assert.equal(f.inserts[0][8], null)
  assert.equal(f.inserts[0][9], null)
  assert.equal(f.inserts[0][16], null)
})

test('legacy creation hash accepts matching config but rejects changed config', async () => {
  const f = fixture()
  await f.createAgentRecord({ ...input, modelConfig: { effort: 'high' } })
  f.records[0].creation_request_hash = createHash('sha256').update(JSON.stringify({
    name: input.name, role: '', systemPrompt: input.systemPrompt, bio: '', initial: '', avatarBg: '',
    model: null, fastModel: null, tools: ['bash'], computerId: null, engine: null, inherit: false,
  })).digest('base64url')
  assert.equal((await f.createAgentRecord({ ...input, modelConfig: { effort: 'high' } })).created, false)
  await assert.rejects(f.createAgentRecord({ ...input, modelConfig: { effort: 'low' } }),
    error => error instanceof f.AgentCreationError && error.status === 409)
  assert.equal(f.inserts.length, 1)
})

function routeFixture() {
  const f = fixture()
  const router = readFileSync(new URL('../api/router.ts', import.meta.url), 'utf8')
  const begin = router.indexOf('function readAgentBody(')
  const end = router.indexOf("api.put('/agents/:id'", begin)
  assert.ok(begin >= 0 && end > begin)
  const output = ts.transpileModule(router.slice(begin, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  let handler: any, portraits = 0
  class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
  const bindings = {
    api: { post(path: string, fn: any) { assert.equal(path, '/agents'); handler = fn } },
    ...modelConfig, ...f, HttpError,
    requireCompanyRole: async () => ({ userId: 'user-test', companyId: input.companyId }),
    companyPlanTier: async () => 'pro', TIER_LIMITS: { pro: { agentsPerCompany: 10 } },
    pool: { query: async (sql: string) => { assert.match(sql, /INSERT INTO agent_workspace/); return { rows: [] } } },
    joinAllHands: async () => {}, ensureDirectConversation: async () => {},
    generateAndPersistAvatar: async () => { portraits++ },
    console: { log() {}, warn() {} },
    require(name: string) {
      assert.equal(name, '../agents/personas.js')
      return { invalidatePersonaCache() {} }
    },
  }
  new Function(...Object.keys(bindings), output)(...Object.values(bindings))
  return { ...f, portraits: () => portraits, async request(body: Record<string, unknown>) {
    let status = 200, json: any
    const res = { status(value: number) { status = value; return res }, json(value: any) { json = value } }
    try { await handler({ body }, res) } catch (error) {
      if (!(error instanceof HttpError)) throw error
      status = error.status; json = { error: error.message }
    }
    return { status, body: json }
  } }
}

test('POST /agents responds 201, normalized replay 200 and changed modelConfig 409', async () => {
  const f = routeFixture()
  const first = await f.request({ ...input, modelConfig: { effort: ' HIGH ' } })
  assert.equal(first.status, 201)
  const replay = await f.request({ ...input, modelConfig: { effort: 'high' } })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.id, first.body.id)
  assert.equal(replay.body.replayed, true)
  const conflict = await f.request({ ...input, modelConfig: { effort: 'low' } })
  assert.equal(conflict.status, 409)
  assert.match(conflict.body.error, /requestId/)
  assert.equal(f.inserts.length, 1)
  assert.equal(f.portraits(), 1)
})

test('POST /agents rejects invalid effort and numbers with 400 before persistence or model calls', async () => {
  const f = routeFixture()
  for (const config of [{ effort: 'ultra' }, { maxOutputTokens: '4000' }, { contextWindow: -1 }]) {
    const response = await f.request({ ...input, modelConfig: config })
    assert.equal(response.status, 400)
    assert.match(response.body.error, /invalid modelConfig/)
  }
  assert.equal(f.connections(), 0)
  assert.equal(f.inserts.length, 0)
  assert.equal(f.portraits(), 0)
})

test('POST /agents blank models and empty config preserve inherited defaults', async () => {
  const f = routeFixture()
  assert.equal((await f.request({ ...input, model: ' ', fastModel: '', modelConfig: {} })).status, 201)
  assert.equal((await f.request({ ...input, model: null, fastModel: null, modelConfig: null })).status, 200)
  assert.equal(f.inserts[0][8], null)
  assert.equal(f.inserts[0][9], null)
  assert.equal(f.inserts[0][16], null)
})
