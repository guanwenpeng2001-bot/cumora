import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { pool } from '../db/pool.js'
import { setAgentSkills, agentSkillsFor, enabledSkillsForAgent } from '../skill-library.js'
import { setAgentConnectors, agentConnectorsFor, enabledConnectorsForAgent, listConnectors, upsertConnector } from '../mcp-connectors.js'

const connectionString = process.env.INTEGRATION_DATABASE_URL
test('T5 isolated PostgreSQL: tenant binding, rollback, delivery and summaries', { skip: !connectionString }, async (t) => {
  const url = new URL(connectionString!)
  // CI provides a fresh postgres service (isolated by definition); locally only
  // the coordinator-designated throwaway instance on port 15432 is allowed.
  const isCiService = process.env.CI === 'true' && url.hostname === 'localhost' && url.pathname.endsWith('_test')
  assert.ok(isCiService || (['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '15432'), 'only designated isolated PostgreSQL allowed')
  const db = new Client({ connectionString })
  await db.connect()
  t.after(async () => { await db.end() })
  await db.query([
    "CREATE TEMP TABLE participants (id text PRIMARY KEY, company_id text, kind text, departed_at timestamptz, computer_id text, engine text);",
    "CREATE TEMP TABLE computers (id text PRIMARY KEY, kind text);",
    "CREATE TEMP TABLE skills (id text PRIMARY KEY, company_id text, name text, description text, source text, hub_id text, files jsonb DEFAULT '[]', created_at timestamptz DEFAULT now());",
    "CREATE TEMP TABLE mcp_connectors (id text PRIMARY KEY, company_id text, name text, type text, command text, args jsonb DEFAULT '[]', env jsonb DEFAULT '{}', url text, headers jsonb DEFAULT '{}', enabled boolean DEFAULT true, created_at timestamptz DEFAULT now());",
    "CREATE TEMP TABLE agent_skills (agent_id text REFERENCES participants(id), skill_id text REFERENCES skills(id), PRIMARY KEY(agent_id, skill_id));",
    "CREATE TEMP TABLE agent_mcp_connectors (agent_id text REFERENCES participants(id), connector_id text REFERENCES mcp_connectors(id), PRIMARY KEY(agent_id, connector_id));",
    "INSERT INTO computers VALUES ('local', 'local');",
    "INSERT INTO participants VALUES ('a', 'c1', 'agent', NULL, 'local', 'claude'), ('b', 'c2', 'agent', NULL, 'local', 'claude'), ('human', 'c1', 'human', NULL, NULL, NULL), ('departed', 'c1', 'agent', now(), 'local', 'claude');",
    "INSERT INTO skills (id, company_id, name, description, source) VALUES ('s1', 'c1', 'one', 'fixture', 'paste'), ('s2', 'c2', 'two', 'fixture', 'paste');",
    "INSERT INTO mcp_connectors (id, company_id, name, type, command, args, env, url, headers, enabled) VALUES ('m1', 'c1', 'one', 'stdio', 'command-secret', '[\"arg-secret\"]', '{\"TOKEN\":\"env-secret\"}', 'https://url-secret', '{\"Authorization\":\"header-secret\"}', true), ('m2', 'c2', 'two', 'http', NULL, '[]', '{}', 'https://tenant-two-secret', '{}', true), ('off', 'c1', 'off', 'stdio', 'node', '[]', '{}', NULL, '{}', false);",
    "INSERT INTO agent_skills VALUES ('a', 's1');",
    "INSERT INTO agent_mcp_connectors VALUES ('a', 'm1');",
  ].join('\n'))
  let injectFailure = false
  let mutations = 0
  const query = async (sql: string, params?: unknown[]) => {
    if (/^\s*(INSERT|DELETE|UPDATE)/.test(sql)) mutations++
    if (injectFailure && sql.includes('INSERT INTO agent_')) throw new Error('injected insert failure')
    return db.query(sql, params)
  }
  t.mock.method(pool, 'query', query)
  t.mock.method(pool, 'connect', async () => ({ query, release() {} }))

  await t.test('invalid agents reject reads and writes without mutation', async () => {
    const before = mutations
    for (const agent of ['b', 'missing', 'human', 'departed']) {
      await assert.rejects(setAgentSkills('c1', agent, ['s1']), { status: 404 })
      await assert.rejects(setAgentConnectors('c1', agent, ['m1']), { status: 404 })
      await assert.rejects(agentSkillsFor('c1', agent), { status: 404 })
      await assert.rejects(agentConnectorsFor('c1', agent), { status: 404 })
    }
    assert.equal(mutations, before)
  })

  await t.test('mixed resources and disabled connectors reject; insert failures roll back deletions', async () => {
    const before = mutations
    await assert.rejects(setAgentSkills('c1', 'a', ['s1', 's2']), { status: 400 })
    await assert.rejects(setAgentSkills('c1', 'a', ['missing']), { status: 400 })
    await assert.rejects(setAgentConnectors('c1', 'a', ['m1', 'm2']), { status: 400 })
    await assert.rejects(setAgentConnectors('c1', 'a', ['off']), { status: 400 })
    assert.equal(mutations, before)
    injectFailure = true
    await assert.rejects(setAgentSkills('c1', 'a', ['s1']), /injected/)
    await assert.rejects(setAgentConnectors('c1', 'a', ['m1']), /injected/)
    injectFailure = false
    assert.equal((await db.query('SELECT * FROM agent_skills')).rowCount, 1)
    assert.equal((await db.query('SELECT * FROM agent_mcp_connectors')).rowCount, 1)
  })

  await t.test('valid writes, de-duplication and unbind work', async () => {
    await setAgentSkills('c1', 'a', ['s1', 's1'])
    await setAgentConnectors('c1', 'a', ['m1', 'm1'])
    assert.equal((await agentSkillsFor('c1', 'a'))[0].enabled, true)
    assert.equal((await agentConnectorsFor('c1', 'a')).find((c) => c.connector.id === 'm1')?.enabled, true)
    await setAgentSkills('c1', 'a', [])
    await setAgentConnectors('c1', 'a', [])
    assert.equal((await agentSkillsFor('c1', 'a'))[0].enabled, false)
    assert.ok((await agentConnectorsFor('c1', 'a')).every((c) => !c.enabled))
    await setAgentSkills('c1', 'a', ['s1'])
    await setAgentConnectors('c1', 'a', ['m1'])
  })

  await t.test('historical cross-company bindings cannot enter enabled delivery queries', async () => {
    await db.query("INSERT INTO agent_skills VALUES ('a','s2')")
    await db.query("INSERT INTO agent_mcp_connectors VALUES ('a','m2')")
    assert.deepEqual((await enabledSkillsForAgent('a')).map((s) => s.id), ['s1'])
    assert.deepEqual((await enabledConnectorsForAgent('a')).map((c) => c.id), ['m1'])
    assert.deepEqual((await agentSkillsFor('c1', 'a')).map((s) => s.skill.id), ['s1'])
    assert.ok((await agentConnectorsFor('c1', 'a')).every((s) => s.connector.companyId === 'c1'))
  })

  await t.test('ordinary summaries hide all config secrets; privileged/runtime reads retain them', async () => {
    for (const items of [await listConnectors('c1'), await agentConnectorsFor('c1', 'a')]) {
      const json = JSON.stringify(items)
      for (const secret of ['command-secret', 'arg-secret', 'env-secret', 'url-secret', 'header-secret', 'tenant-two-secret']) assert.ok(!json.includes(secret), secret)
    }
    assert.equal((await listConnectors('c1', { redactSecrets: false })).find((c) => c.id === 'm1')?.env.TOKEN, 'env-secret')
    assert.equal((await agentConnectorsFor('c1', 'a', { redactSecrets: false })).find((c) => c.connector.id === 'm1')?.connector.headers.Authorization, 'header-secret')
    assert.equal((await enabledConnectorsForAgent('a'))[0].env.TOKEN, 'env-secret')
  })

  await t.test('device delivery SQL filters resource and computer ownership and revoked devices', async () => {
    await db.query("ALTER TABLE participants ADD name text, ADD role text, ADD system_prompt text, ADD model text, ADD fast_model text, ADD provider_profile text")
    await db.query("ALTER TABLE computers ADD company_id text, ADD revoked_at timestamptz, ADD available_engines jsonb DEFAULT '[]', ADD detected_engines jsonb DEFAULT '[]', ADD engine_defaults jsonb DEFAULT '{}'")
    await db.query("UPDATE computers SET company_id = 'c1'")
    const source = readFileSync(new URL('../agents/computer/registry.ts', import.meta.url), 'utf8')
    const start = source.indexOf('`SELECT p.id, p.name', source.indexOf('export async function listAgentsForComputer')) + 1
    const sql = source.slice(start, source.indexOf('`', start))
    const delivered = (await db.query(sql, ['local'])).rows
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].id, 'a')
    assert.deepEqual(delivered[0].skillsJson.map((s: { name: string }) => s.name), ['one'])
    assert.deepEqual(delivered[0].mcpJson.map((c: { name: string }) => c.name), ['one'])
    assert.equal(delivered[0].mcpJson[0].env.TOKEN, 'env-secret')
    await db.query('UPDATE computers SET revoked_at = now()')
    assert.equal((await db.query(sql, ['local'])).rowCount, 0)
  })

  await t.test('upsert cannot overwrite another company connector by id', async () => {
    await assert.rejects(upsertConnector('c1', { id: 'm2', name: 'attack', type: 'stdio', command: 'node' }), { status: 404 })
    assert.equal((await db.query("SELECT name FROM mcp_connectors WHERE id = 'm2'")).rows[0].name, 'two')
  })
})
