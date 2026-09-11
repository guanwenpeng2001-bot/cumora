import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { pool } from '../db/pool.js'
import { MODEL_HUB_SQL } from '../db/migrations/0019-model-hub.js'
import { buildModelImport, persistModelImport } from '../models/import.js'
import { modelCatalog } from '../models/catalog.js'
import { modelHubFixture } from './model-hub-fixture.js'
import { assertModelCatalog } from '../../../shared/model-contract.js'

test('catalog reads current membership, isolates computer/profile and keeps env visible without gateway credentials', async t => {
  const url = process.env.DATABASE_URL
  if (!url || !new URL(url).pathname.endsWith('/cumora_test')) return t.skip('Requires explicitly isolated cumora_test DATABASE_URL')
  const pg = new Pool({ connectionString: url, max: 1 })
  const client = await pg.connect(), schema = `catalog_access_${randomUUID().replaceAll('-', '')}`
  try {
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query(`SET search_path TO ${schema}`)
    await client.query(MODEL_HUB_SQL)
    await client.query(`CREATE TABLE users(id TEXT PRIMARY KEY,sub2api_api_key TEXT);
      CREATE TABLE companies(id TEXT PRIMARY KEY,owner_user_id TEXT);
      CREATE TABLE company_members(company_id TEXT,user_id TEXT);
      CREATE TABLE computers(id TEXT,company_id TEXT,kind TEXT,status TEXT,last_seen_at TIMESTAMPTZ,revoked_at TIMESTAMPTZ);
      CREATE TABLE participants(id TEXT,company_id TEXT,kind TEXT,departed_at TIMESTAMPTZ);
      INSERT INTO users VALUES ('owner-a',NULL),('owner-b',NULL);
      INSERT INTO companies VALUES ('company-a','owner-a'),('company-b','owner-b');
      INSERT INTO company_members VALUES ('company-a','member-a'),('company-b','member-b');
      INSERT INTO computers VALUES ('computer-a','company-a','local','online',NOW(),NULL),('computer-b','company-b','local','online',NOW(),NULL);
      INSERT INTO participants VALUES ('atlas-4b42','company-a','agent',NULL),('test-codex-01','company-a','agent',NULL);`)
    await persistModelImport(client, buildModelImport(modelHubFixture()))
    const connectMock = t.mock.method(pool, 'connect', async () => ({ query: client.query.bind(client), release() {} }))
    const dto = await modelCatalog('member-a', 'company-a')
    assertModelCatalog(dto)
    assert(dto.offerings.some(o => o.sourceKind === 'env'))
    assert(dto.offerings.filter(o => o.sourceKind === 'sub2api').every(o => o.availability.reasonCodes.includes('owner-platform-credential-missing')))
    const other = await modelCatalog('member-b', 'company-b')
    assert(!other.offerings.some(o => o.sourceKind === 'byoa'))
    assert(!other.bindings.some(b => b.scopeType === 'agent' || b.scopeType === 'computer'))
    await assert.rejects(modelCatalog('member-b', 'company-a'), /access denied/)
    await assert.rejects(modelCatalog('member-b', 'company-b', { computerId: 'computer-a' }), /access denied/)
    const profile = await modelCatalog('member-a', 'company-a', { domain: 'byoa', computerId: 'computer-a', engine: 'codex', profileId: 'custom' })
    assert.deepEqual(profile.offerings.map(o => o.requestModel).sort(), ['private-fast', 'private-model'])
    await client.query("UPDATE users SET sub2api_api_key='shadow-fixture-value' WHERE id='owner-a'")
    const changed = await modelCatalog('member-a', 'company-a')
    assert.notEqual(changed.entitlementRevision, dto.entitlementRevision)
    assert.notEqual(changed.catalogRevision, dto.catalogRevision)
    assert(!JSON.stringify(changed).includes('shadow-fixture-value'))
    await client.query("UPDATE computers SET revoked_at=NOW() WHERE id='computer-a'")
    assert(!(await modelCatalog('member-a', 'company-a')).offerings.some(o => o.sourceKind === 'byoa'))
    await client.query("DELETE FROM company_members WHERE user_id='member-a'")
    await assert.rejects(modelCatalog('member-a', 'company-a'), /access denied/)
    connectMock.mock.restore()
  } finally {
    // Only the randomly named schema created by this test is removed.
    await client.query(`DROP SCHEMA ${schema} CASCADE`)
    client.release(); await pg.end()
  }
})
