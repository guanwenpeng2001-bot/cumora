import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { MODEL_HUB_SQL, modelHubChecksum } from '../db/migrations/0019-model-hub.js'
import { SCHEMA_MIGRATIONS, MAX_SUPPORTED_SCHEMA_VERSION } from '../db/migrations/manifest.js'
import { buildModelImport, persistModelImport } from '../models/import.js'
import { modelHubFixture } from './model-hub-fixture.js'

test('migration 19 is append-only, registered and checksummed', () => {
  assert.ok(MAX_SUPPORTED_SCHEMA_VERSION >= 19)
  assert.equal(SCHEMA_MIGRATIONS[18].checksum, modelHubChecksum())
  assert.equal(SCHEMA_MIGRATIONS[17].checksum, '37f7dc9cf2989d0b54218aa8ea6f30d5e47387a5e33ace1447c2ab3950c9bdb4')
  assert.doesNotMatch(MODEL_HUB_SQL, /ALTER TABLE|llm_calls|rollup|tier_policies|quota_windows/)
})

test('migration SQL and importer are atomic and idempotent in isolated PostgreSQL; constraints preserve scoped identity', async t => {
  const url = process.env.DATABASE_URL
  if (!url || !new URL(url).pathname.endsWith('/cumora_test')) return t.skip('Requires explicitly isolated cumora_test DATABASE_URL')
  const pg = new Pool({ connectionString: url, max: 1 })
  const client = await pg.connect(), schema = `model_hub_${randomUUID().replaceAll('-', '')}`
  try {
    await client.query('BEGIN')
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query(`SET LOCAL search_path TO ${schema}`)
    await client.query(MODEL_HUB_SQL)
    const data = buildModelImport(modelHubFixture())
    await persistModelImport(client, data)
    const dump = async () => {
      const all = []
      for (const table of ['model_sources', 'model_definitions', 'model_offerings', 'model_aliases', 'model_bindings', 'model_credentials']) {
        all.push((await client.query(`SELECT to_jsonb(t) AS row, xmin::text FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows)
      }
      return all
    }
    const first = await dump()
    await persistModelImport(client, buildModelImport(modelHubFixture()))
    assert.deepEqual(await dump(), first)
    assert.deepEqual((await client.query("SELECT targets->'fallbacks' AS chain FROM model_bindings WHERE scope_type='server' AND slot='brain'")).rows[0].chain, [])
    await client.query('SAVEPOINT bad_source')
    await assert.rejects(client.query("INSERT INTO model_sources(id,kind,revision) VALUES ('bad','fourth-source','1')"), /check constraint/)
    await client.query('ROLLBACK TO SAVEPOINT bad_source')
    await client.query('SAVEPOINT duplicate_credential')
    await assert.rejects(client.query("INSERT INTO model_credentials SELECT 'duplicate',owner_user_id,source_id,platform,remote_user_id,key_id,secret_ref,status,revision,integration_owner FROM model_credentials LIMIT 1"), /unique constraint/)
    await client.query('ROLLBACK TO SAVEPOINT duplicate_credential')
    const a = data.offerings.find(o => o.sourceKind === 'byoa')!
    await client.query('SAVEPOINT bad_alias')
    await assert.rejects(client.query("INSERT INTO model_aliases VALUES ('sub2api','','openai','bad-alias','responses',$1)", [a.id]), /foreign key constraint/)
    await client.query('ROLLBACK TO SAVEPOINT bad_alias')
  } finally { await client.query('ROLLBACK'); client.release(); await pg.end() }
})
