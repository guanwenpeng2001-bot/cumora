import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { USAGE_ROLLUP_V2_SQL } from '../db/migrations/0013-usage-rollup-v2.js'

function compile(path: string, pool: unknown) {
  const js = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', 'require', js)(exports, (name: string) => {
    assert.ok(['./db/pool.js', '../db/pool.js'].includes(name))
    return { pool }
  })
  return exports
}

// Explicit test database only. All objects are connection-local temporary
// tables, so this suite cannot overwrite application tables or require cleanup.
const url = process.env.T34_TEST_DATABASE_URL ?? process.env.INTEGRATION_DATABASE_URL

test('PostgreSQL: exact windows, versioned rollup convergence, routes, quality and retention', { skip: !url }, async () => {
  const database = decodeURIComponent(new URL(url!).pathname.slice(1))
  assert.match(database, /(?:^|_)(?:test|tests)(?:_|$)/i, 'use a dedicated test database')
  const { Client } = await import('pg')
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query("SET timezone = 'Asia/Shanghai'")
    const baseline = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8')
    for (const table of ['llm_calls', 'llm_calls_rollup']) {
      const start = baseline.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`)
      const end = baseline.indexOf('\n);', start) + 3
      assert.ok(start > 0 && end > start)
      await client.query(baseline.slice(start, end).replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'))
    }
    await client.query('ALTER TABLE llm_calls ADD COLUMN daemon_version text')
    await client.query(`CREATE UNIQUE INDEX test_legacy_key ON llm_calls_rollup
      (bucket_hour, company_id, agent_id, purpose, model, source, daemon_version) NULLS NOT DISTINCT`)
    await client.query('CREATE INDEX test_raw_company_created ON llm_calls(company_id, created_at)')
    await client.query('CREATE TEMP TABLE participants(id text PRIMARY KEY, name text, avatar_url text)')
    await client.query(USAGE_ROLLUP_V2_SQL.replaceAll('CREATE TABLE ', 'CREATE TEMP TABLE '))
    const pool = { query: (sql: string, values: unknown[]) => client.query(sql, values),
      connect: async () => ({ query: (sql: string, values: unknown[]) => client.query(sql, values), release() {} }) }
    const usage = compile('../usage.ts', pool), rollup = compile('../agents/llm-rollup.ts', pool)
    const base = Math.floor(Date.now() / 3600000) * 3600000 - 4 * 3600000
    const from = new Date(base + 17 * 60000), to = new Date(base + 2 * 3600000 + 43 * 60000)
    const range = { from, to }
    const insert = async (id: string, time: number, route: string, measured = true, unpriced = false, tenant = 'tenant') => {
      await client.query(`INSERT INTO llm_calls(id, company_id, agent_id, purpose, model, source, created_at,
        input_tokens, output_tokens, cost_usd, cost_estimated, measured, status, extras)
        VALUES ($1, $2, 'a', 'chat', 'same-model', 'server', $3, 10, 2, 0.5, TRUE, $4, 'ok', $5)`,
      [id, tenant, new Date(time), measured, JSON.stringify({ route, platform: 'openai', ...(unpriced ? { unpriced: 'missing-price' } : {}) })])
    }
    await insert('outside-before', from.getTime() - 1, 'gateway')
    await insert('left', from.getTime(), 'gateway')
    await insert('middle', base + 3600000 + 1000, 'gateway', false)
    await insert('middle-env', base + 3600000 + 2000, 'env', true, true)
    await insert('right', to.getTime() - 1, 'env')
    await insert('outside-after', to.getTime(), 'env')
    await insert('other-tenant', from.getTime(), 'gateway', true, false, 'other')
    await rollup.runLlmRollupTick()
    const expected = async (window = range) => (await client.query(`SELECT COUNT(*)::int AS requests, SUM(cost_usd)::float AS cost
      FROM llm_calls WHERE company_id = 'tenant' AND created_at >= $1 AND created_at < $2`, [window.from, window.to])).rows[0]
    const check = async (window = range) => {
      const raw = await expected(window), summary = await usage.usageSummary('tenant', window)
      assert.equal(summary.requests, raw.requests)
      assert.equal(summary.costUsd, raw.cost ?? 0)
      const trend = await usage.usageTrend('tenant', window, 'hour')
      assert.equal(trend.reduce((sum: number, row: any) => sum + row.costUsd, 0), raw.cost ?? 0)
    }
    await check()
    await check({ from, to: new Date(base + 40 * 60000) })
    await check({ from: new Date(base + 3600000), to: new Date(base + 2 * 3600000) })
    await check({ from: new Date(base + 2 * 3600000 + 40000), to })
    assert.equal((await usage.usageSummary('tenant', range)).unknownRequests, 1)
    assert.equal((await usage.usageSummary('tenant', range)).unpricedRequests, 1)
    const models = await usage.usageByModel('tenant', range)
    assert.equal(models.length, 2)
    assert.deepEqual(new Set(models.map((r: any) => r.route)), new Set(['gateway', 'env']))
    assert.equal((await usage.usageLogs('tenant', range, { page: 1, pageSize: 50 })).total, 4)
    assert.equal((await usage.usageByAgent('tenant', range))[0].actualSource, 'server')
    await insert('late', base + 3600000 + 3000, 'env')
    await rollup.runLlmRollupTick()
    await check()
    await rollup.runLlmRollupTick()
    await check()
    const old = new Date(base - 91 * 86400000)
    await client.query(`INSERT INTO llm_calls_rollup(bucket_hour, company_id, purpose, model, source, calls, cost_usd)
      VALUES ($1, 'tenant', 'chat', 'historical', 'server', 2, 4)`, [old])
    const historical = { from: old, to: new Date(old.getTime() + 3600000) }
    const legacy = await usage.usageSummary('tenant', historical)
    assert.equal(legacy.requests, 2)
    assert.equal(legacy.qualityUnknownRequests, 2)
    assert.equal(legacy.unknownRequests, 0)
    assert.equal((await usage.usageMetadata('tenant', historical)).logsComplete, false)
    assert.equal((await usage.usageLogs('tenant', historical, { page: 1, pageSize: 50 })).total, 0)
  } finally {
    await client.end()
  }
})
