import assert from 'node:assert/strict'
import { after, beforeEach, test, type TestContext } from 'node:test'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'
const registry = await import('../agents/computer/registry.js')
const { pool } = await import('../db/pool.js')
const { redis, sub } = await import('../redis.js')

// Every database entry point is mocked; this suite never needs a live database.
beforeEach((t) => {
  ;(t as TestContext).mock.method(pool, 'query', async () => { throw new Error('unexpected database query') })
  ;(t as TestContext).mock.method(pool, 'connect', async () => { throw new Error('unexpected database connection') })
})
after(async () => { await pool.end(); redis.disconnect(); sub.disconnect() })

const metadata = { id: 'work', label: 'Work', model: 'work/main', fastModel: 'work/fast' }
const computer = { kind: 'local', available_engines: ['claude', 'kimi', 'zcode', 'codex'],
  detected_engines: [{ id: 'claude', providerProfiles: [metadata] }] }
const assignment = { companyId: 'company', computerId: 'computer', engine: 'claude', inherit: false, providerProfile: 'work' }

test('profile assignment requires explicit available Claude and advertised metadata', async (t) => {
  t.mock.method(pool, 'query', async (sql: string, values: unknown[]) => {
    assert.match(sql, /company_id = \$2 AND revoked_at IS NULL/)
    assert.match(sql, /FOR SHARE/)
    return { rows: values[1] === 'company' ? [computer] : [] }
  })
  assert.deepEqual(await registry.resolveComputerAssignment(assignment), { kind: 'local', engine: 'claude', inherit: false })
  for (const changed of [
    { engine: 'kimi' }, { engine: 'zcode' }, { engine: 'codex' }, { engine: 'bogus' },
    { engine: undefined }, { inherit: true }, { providerProfile: 'missing' },
    { providerProfile: '../work' }, { companyId: 'foreign' },
  ]) assert.equal(await registry.resolveComputerAssignment({ ...assignment, ...changed }), null)
  for (const engine of ['kimi', 'zcode']) {
    assert.equal((await registry.resolveComputerAssignment({ ...assignment, engine, providerProfile: null }))?.engine, engine)
  }
})

test('profile assignment and pins share one update and never modify managed model_config', async (t) => {
  const updates: Array<{ sql: string; values: unknown[] }> = []
  t.mock.method(pool, 'query', async (sql: string, values: unknown[]) => {
    if (sql.includes('SELECT kind')) return { rows: [computer] }
    assert.match(sql, /^UPDATE participants/)
    assert.doesNotMatch(sql, /model_config/)
    updates.push({ sql, values })
    return { rows: [], rowCount: 1 }
  })
  assert.ok(await registry.assignAgentToComputer({ ...assignment, agentId: 'agent', model: 'work/pin', fastModel: null }))
  assert.equal(updates.length, 1)
  assert.match(updates[0].sql, /provider_profile = \$6/)
  assert.deepEqual(updates[0].values, ['computer', 'claude', false, 'work/pin', null, 'work', 'agent', 'company'])
  await registry.assignAgentToComputer({ ...assignment, agentId: 'agent', providerProfile: null })
  assert.equal(updates[1].values[3], null)
})

test('profile discovery excludes old daemons and preserves pins and resource payloads', async (t) => {
  const skills = [{ name: 'skill', description: 'fixture', files: [] }]
  const row = { id: 'agent', name: 'Agent', role: null, systemPrompt: null, engine: 'claude',
    model: null as string | null, fastModel: null, providerProfile: 'work', availableEngines: ['claude'],
    engineDefaults: { claude: { model: 'wrong/default', fastModel: 'wrong/fast' } },
    detectedEngines: [{ id: 'claude', modelCatalog: { models: [], defaultModel: 'wrong/catalog' } }],
    skillsJson: skills, mcpJson: [] }
  t.mock.method(pool, 'query', async (sql: string, values: unknown[]) => {
    assert.match(sql, /\(\$2::boolean OR p.provider_profile IS NULL\)/)
    assert.match(sql, /p.provider_profile AS "providerProfile"/)
    assert.deepEqual(values.slice(0, 1), ['computer'])
    return { rows: values[1] ? [row] : [] }
  })
  assert.deepEqual(await registry.listAgentsForComputer('computer'), [])
  const [agent] = await registry.listAgentsForComputer('computer', true)
  assert.equal(agent.providerProfile, 'work')
  assert.equal(agent.model, null)
  assert.equal(agent.fastModel, null)
  assert.deepEqual(agent.skills, skills)
  assert.deepEqual(agent.mcpConnectors, [])
  assert.ok(agent.resourceVersion)
  row.model = 'work/pinned'
  assert.equal((await registry.listAgentsForComputer('computer', true))[0].model, 'work/pinned')
})

test('runtime token requests must match the assigned profile id, including legacy null', async (t) => {
  const seen: unknown[][] = []
  t.mock.method(pool, 'query', async (sql: string, values: unknown[]) => {
    assert.match(sql, /p.provider_profile IS NOT DISTINCT FROM \$3::text/)
    assert.match(sql, /c.revoked_at IS NULL/)
    seen.push(values)
    return { rows: [] }
  })
  assert.equal(await registry.mintAgentRuntimeToken({ computerId: 'computer', agentId: 'agent' }), null)
  assert.equal(await registry.mintAgentRuntimeToken({ computerId: 'computer', agentId: 'agent', providerProfile: 'work' }), null)
  assert.deepEqual(seen, [['agent', 'computer', null], ['agent', 'computer', 'work']])
})

test('server engine serialization strips credentials and accepts profiles only for Claude', () => {
  const privateProfile = { ...metadata, baseUrl: 'https://private.example.test', auth: { apiKey: 'fixture-secret' }, fingerprint: 'private-digest' }
  const result = registry.sanitizeDetectedEngines(['claude', 'kimi', 'zcode', 'codex'].map(id => ({ id, providerProfiles: [privateProfile] })), ['claude', 'kimi', 'zcode', 'codex'])
  assert.deepEqual(result.find(e => e.id === 'claude')?.providerProfiles, [metadata])
  for (const entry of result.filter(e => e.id !== 'claude')) assert.equal(entry.providerProfiles, undefined)
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|private\.example|baseUrl|apiKey|auth|private-digest|fingerprint/)
})
