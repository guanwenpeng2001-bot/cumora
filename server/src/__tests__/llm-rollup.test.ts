import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { USAGE_ROLLUP_V2_SQL, usageRollupV2Checksum } from '../db/migrations/0013-usage-rollup-v2.js'
import { SCHEMA_MIGRATIONS } from '../db/migrations/manifest.js'

function fixture(failV2 = false, locked = true, gap: number | null = null, settings: Record<string, number> = {}, failDelete = '') {
  const calls: { sql: string; params: unknown[] }[] = []
  let released = 0
  const since = new Date('2026-09-01T00:00:00Z'), until = new Date('2026-09-02T12:43:00Z')
  const client = { release: () => { released++ }, query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: locked }] }
    if (sql.includes('AS gap_hours')) return { rows: [{ gap_hours: gap }] }
    if (sql.includes('AS retained_from')) return { rows: [{ since, until, retained_from: since }] }
    if (failDelete && sql.startsWith(`DELETE FROM ${failDelete} WHERE`)) throw new Error('injected delete failure')
    if (failV2 && sql.includes('INSERT INTO llm_calls_rollup_v2')) throw new Error('injected write failure')
    return { rows: [], rowCount: 2 }
  } }
  const output = ts.transpileModule(readFileSync(new URL('../agents/llm-rollup.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', 'require', output)(exports, (name: string) => {
    if (name.endsWith('/settings.js')) return { automationNumber: (key: string) => settings[key] ?? ({ llm_rollup_interval_ms: 120_000, db_gc_llm_calls_days: 90, llm_rollup_retention_hours: 2280 }[key]), createOperationsWorker: () => ({ start() {}, stop() {} }) }
    assert.equal(name, '../db/pool.js')
    return { pool: { connect: async () => client, query: async () => { throw new Error('must use locked connection') } } }
  })
  return { exports, calls, released: () => released }
}

test('migration 13 checksum matches and preserves legacy table and indexed v2 dimensions', () => {
  assert.equal(SCHEMA_MIGRATIONS.find(m => m.version === 13)?.checksum, usageRollupV2Checksum())
  assert.match(USAGE_ROLLUP_V2_SQL, /NULLS NOT DISTINCT/)
  assert.match(USAGE_ROLLUP_V2_SQL, /company_id, bucket_hour/)
  assert.doesNotMatch(USAGE_ROLLUP_V2_SQL, /DROP|ALTER TABLE llm_calls_rollup\s/)
})

test('rollup holds one connection for lock, transaction, both versions and watermark', async () => {
  const f = fixture()
  assert.deepEqual(await f.exports.runLlmRollupTick(), { buckets: 2, sinceHours: 95 * 24 })
  const sql = f.calls.map(c => c.sql)
  const begin = sql.indexOf('BEGIN'), commit = sql.indexOf('COMMIT')
  assert.ok(begin > 0 && commit > begin)
  assert.equal(sql.slice(begin, commit).filter(s => s.includes('INSERT INTO llm_calls_rollup')).length, 2)
  assert.ok(sql.slice(begin, commit).some(s => s.includes("status = 'ready'")))
  assert.equal(sql.slice(begin, commit).filter(s => s.startsWith('DELETE FROM llm_calls_rollup')).length, 2)
  const v2 = f.calls.find(c => c.sql.includes('INSERT INTO llm_calls_rollup_v2'))!
  assert.match(v2.sql, /extras->>'route', extras->>'platform'/)
  assert.match(v2.sql, /measured IS NOT TRUE/)
  assert.match(v2.sql, /extras->>'unpriced'/)
  assert.match(v2.sql, /created_at >= \$1::timestamptz AND created_at < \$2::timestamptz/)
  assert.match(v2.sql, /DO UPDATE SET/)
  assert.equal(f.released(), 1)
})

test('rollup failure rolls back both tables, keeps watermark and persists failure before unlocking', async () => {
  const f = fixture(true)
  await assert.rejects(f.exports.runLlmRollupTick(), /injected write failure/)
  const sql = f.calls.map(c => c.sql)
  assert.ok(sql.includes('ROLLBACK'))
  assert.ok(!sql.includes('COMMIT'))
  assert.ok(!sql.some(s => s.includes("status = 'ready'")))
  assert.ok(sql.findIndex(s => s.includes("status = 'failed'")) > sql.indexOf('ROLLBACK'))
  assert.match(sql.at(-1)!, /pg_advisory_unlock/)
  assert.equal(f.released(), 1)
})

test('lock contention skips all writes; outage catch-up uses persisted watermark', async () => {
  const blocked = fixture(false, false)
  assert.deepEqual(await blocked.exports.runLlmRollupTick(), { skipped: true })
  assert.equal(blocked.calls.length, 1)
  const resumed = fixture(false, true, 24)
  assert.equal((await resumed.exports.runLlmRollupTick()).sinceHours, 25)
  assert.match(resumed.calls[1].sql, /completed_through/)
})


test('rollup retention zero disables pruning; configured raw retention bounds catch-up', async () => {
  const settings = { db_gc_llm_calls_days: 0, llm_rollup_retention_hours: 0 }
  const f = fixture(false, true, 24, settings)
  await f.exports.runLlmRollupTick()
  assert.ok(!f.calls.some(c => c.sql.startsWith('DELETE FROM llm_calls_rollup')))
  assert.equal(f.calls.find(c => c.sql.includes('AS retained_from'))!.params[1], 95)
  f.calls.length = 0
  Object.assign(settings, { db_gc_llm_calls_days: 30, llm_rollup_retention_hours: 3000 })
  await f.exports.runLlmRollupTick()
  assert.equal(f.calls.find(c => c.sql.includes('AS retained_from'))!.params[1], 30)
  const deletes = f.calls.filter(c => c.sql.startsWith('DELETE FROM llm_calls_rollup'))
  assert.equal(deletes.length, 2)
  for (const call of deletes) assert.deepEqual(call.params, [3000])
})


test('explicit rollup stop is visible even after an in-flight writer could have published ready', () => {
  const settings = { llm_rollup_interval_ms: 120_000 }
  const f = fixture(false, true, null, settings)
  assert.equal(f.exports.isLlmRollupPaused(), false)
  f.exports.stopLlmRollupRefresher()
  assert.equal(f.exports.isLlmRollupPaused(), true)
  f.exports.startLlmRollupRefresher()
  assert.equal(f.exports.isLlmRollupPaused(), false)
  settings.llm_rollup_interval_ms = 0
  assert.equal(f.exports.isLlmRollupPaused(), true)
  assert.deepEqual(f.calls, [], 'pause visibility never overwrites a peer replica watermark')
})

test('either retention deletion failure rolls back the entire tick before publishing ready', async () => {
  for (const table of ['llm_calls_rollup', 'llm_calls_rollup_v2']) {
    const f = fixture(false, true, 24, {}, table)
    await assert.rejects(f.exports.runLlmRollupTick(), /injected delete failure/)
    const sql = f.calls.map(c => c.sql)
    assert.ok(sql.includes('ROLLBACK'))
    assert.ok(!sql.includes('COMMIT'))
    assert.ok(!sql.some(s => s.includes("status = 'ready'")))
    assert.ok(sql.findIndex(s => s.includes("status = 'failed'")) > sql.indexOf('ROLLBACK'))
    assert.match(sql.at(-1)!, /pg_advisory_unlock/)
    assert.equal(f.released(), 1)
  }
})
