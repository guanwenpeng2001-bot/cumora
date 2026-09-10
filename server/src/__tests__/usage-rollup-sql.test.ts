import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { pathToFileURL } from 'node:url'
import { RUNTIME_CALL_ID_INDEX_SQL } from '../db/migrations/0014-runtime-call-id-index.js'
import { USAGE_ROLLUP_V2_SQL } from '../db/migrations/0013-usage-rollup-v2.js'

function compile(path: string, pool: unknown) {
  const js = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', 'require', js)(exports, (name: string) => {
    if (name === './agents/llm-rollup.js') return { isLlmRollupPaused: () => false }
    if (name.endsWith('/settings.js')) return { automationNumber: (key: string) => ({ llm_rollup_interval_ms: 120_000, db_gc_llm_calls_days: 90, llm_rollup_retention_hours: 2280 }[key]), createOperationsWorker: () => ({ start() {}, stop() {} }) }
    assert.ok(['./db/pool.js', '../db/pool.js'].includes(name))
    return { pool }
  })
  return exports
}

// Explicit test database only. All objects are connection-local temporary
// tables, so this suite cannot overwrite application tables or require cleanup.
const url = process.env.T34_TEST_DATABASE_URL ?? process.env.INTEGRATION_DATABASE_URL
const pgliteModule = process.env.FIX_C_PGLITE_MODULE

test('PostgreSQL: exact windows, versioned rollup convergence, routes, quality and retention', { skip: !url && !pgliteModule }, async () => {
  const client = await (async () => {
    if (pgliteModule) {
      const { PGlite } = await import(pathToFileURL(pgliteModule).href)
      const db = new PGlite()
      return {
        query: async (sql: string, values?: unknown[]) => {
          // Advisory locks are covered by the connection/lock unit fixture.
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] }
          if (sql.includes('pg_advisory_unlock')) return { rows: [] }
          return values ? db.query(sql, values) : (await db.exec(sql)).at(-1)
        },
        end: () => db.close(),
      }
    }
    const database = decodeURIComponent(new URL(url!).pathname.slice(1))
    assert.match(database, /(?:^|_)(?:test|tests)(?:_|$)/i, 'use a dedicated test database')
    const { Client } = await import('pg')
    const pg = new Client({ connectionString: url })
    await pg.connect()
    return pg
  })()
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
    await client.query('CREATE TEMP TABLE participants(id text, company_id text, name text, avatar_url text, PRIMARY KEY(id, company_id))')
    await client.query(USAGE_ROLLUP_V2_SQL.replaceAll('CREATE TABLE ', 'CREATE TEMP TABLE '))
    let failPrune = false
    const query = (sql: string, values: unknown[]) => {
      if (failPrune && sql.startsWith('DELETE FROM llm_calls_rollup_v2')) throw new Error('injected prune failure')
      return client.query(sql, values)
    }
    const pool = { query, connect: async () => ({ query, release() {} }) }
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
    await client.query("INSERT INTO participants(id, company_id, name) VALUES ('a', 'tenant', 'Tenant A'), ('a', 'other', 'Other A')")
    const expected = async (window = range) => (await client.query(`SELECT COUNT(*)::int AS requests, SUM(cost_usd)::float AS cost
      FROM llm_calls WHERE company_id = 'tenant' AND created_at >= $1 AND created_at < $2`, [window.from, window.to])).rows[0]
    const check = async (window = range) => {
      const raw = await expected(window), summary = await usage.usageSummary('tenant', window)
      assert.equal(summary.requests, raw.requests)
      assert.equal(summary.costUsd, raw.cost ?? 0)
      const trend = await usage.usageTrend('tenant', window, 'hour')
      assert.equal(trend.reduce((sum: number, row: any) => sum + row.costUsd, 0), raw.cost ?? 0)
    }
    await check() // pending: all whole hours must fall back to raw
    await check({ from: new Date(base), to: new Date(base + 3 * 3600000) })
    await rollup.runLlmRollupTick()
    await check()
    await client.query('UPDATE llm_rollup_state SET completed_through = $1', [new Date(base + 3600000)])
    await insert('stale-new', base + 3600000 + 4000, 'gateway')
    await check() // stale v1/v2 must not hide a new raw call
    await client.query("DELETE FROM llm_calls WHERE id = 'stale-new'")
    await rollup.runLlmRollupTick()
    await check({ from, to: new Date(base + 40 * 60000) })
    await check({ from: new Date(base + 3600000), to: new Date(base + 2 * 3600000) })
    await check({ from: new Date(base + 2 * 3600000 + 40000), to })
    assert.equal((await usage.usageSummary('tenant', range)).unknownRequests, 1)
    assert.equal((await usage.usageSummary('tenant', range)).unpricedRequests, 1)
    const models = await usage.usageByModel('tenant', range)
    assert.equal(models.length, 1)
    assert.equal(models[0].requests, 4)
    assert.equal(models[0].route, null)
    assert.equal((await usage.usageLogs('tenant', range, { page: 1, pageSize: 50 })).total, 4)
    const agents = await usage.usageByAgent('tenant', range)
    assert.equal(agents.length, 1)
    assert.equal(agents[0].actualSource, 'server')
    assert.equal(agents[0].name, 'Tenant A')
    assert.equal(agents[0].requests, 4)
    assert.equal(agents[0].costUsd, 2)
    const logs = await usage.usageLogs('tenant', range, { page: 1, pageSize: 50 })
    assert.equal(logs.items.length, 4)
    assert.equal(new Set(logs.items.map((r: any) => r.id)).size, 4)
    assert.ok(logs.items.every((r: any) => r.agentName === 'Tenant A'))
    // Legacy NULL platform and modern explicit platform must merge.
    await client.query("UPDATE llm_calls SET model = 'gpt-5.5'")
    await client.query('TRUNCATE llm_calls_rollup, llm_calls_rollup_v2')
    await rollup.refreshLlmRollup(95 * 24)
    await client.query('UPDATE llm_rollup_state SET coverage_from = $1', [new Date(base + 2 * 3600000)])
    const mixed = { from: new Date(base), to: new Date(base + 3 * 3600000) }
    await check(mixed)
    const mixedModels = await usage.usageByModel('tenant', mixed)
    assert.equal(mixedModels.length, 1)
    assert.equal(mixedModels[0].requests, 6)
    assert.equal(mixedModels[0].qualityUnknownRequests, 4)
    const providers = await usage.usageByProvider('tenant', mixed)
    assert.deepEqual(providers, [{ provider: 'OpenAI', requests: 6, inputTokens: 60, outputTokens: 12, costUsd: 3 }])
    // Restore fixture dimensions and clear rebuilt buckets before convergence checks.
    await client.query("UPDATE llm_calls SET model = 'same-model'")
    await client.query('TRUNCATE llm_calls_rollup, llm_calls_rollup_v2')
    await client.query('UPDATE llm_rollup_state SET coverage_from = NULL, completed_through = NULL')
    await rollup.runLlmRollupTick()
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
    const expired = new Date(base - 100 * 86400000)
    for (const table of ['llm_calls_rollup', 'llm_calls_rollup_v2']) {
      await client.query(`INSERT INTO ${table}(bucket_hour, company_id, purpose, model, source, calls, cost_usd)
        VALUES ($1, 'tenant', 'chat', 'expired', 'server', 1, 99)`, [expired])
    }
    const before = (await client.query('SELECT coverage_from, completed_through, aggregated_at FROM llm_rollup_state')).rows
    const counts = async () => Promise.all(['llm_calls_rollup', 'llm_calls_rollup_v2'].map(async table =>
      (await client.query(`SELECT COUNT(*)::int AS n, SUM(calls)::int AS calls FROM ${table}`)).rows))
    const beforeCounts = await counts()
    await insert('rollback-new', base + 2 * 3600000 + 5000, 'env')
    failPrune = true
    await assert.rejects(rollup.refreshLlmRollup(95 * 24), /injected prune failure/)
    assert.deepEqual(await counts(), beforeCounts, 'both upserts and the first deletion roll back')
    assert.deepEqual((await client.query('SELECT coverage_from, completed_through, aggregated_at FROM llm_rollup_state')).rows, before)
    assert.equal((await client.query('SELECT status FROM llm_rollup_state')).rows[0].status, 'failed')
    failPrune = false
    await rollup.refreshLlmRollup(95 * 24)
    for (const table of ['llm_calls_rollup', 'llm_calls_rollup_v2']) {
      assert.equal((await client.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE model = 'expired'`)).rows[0].n, 0)
    }
    await check()
  } finally {
    await client.end()
  }
})

// Optional standalone PostgreSQL WASM engine, installed outside the repository.
// No service connection, database files or changes to the project dependencies.

test('PostgreSQL in memory: callId migration replays on empty and existing histories and supports the runtime lookup', { skip: !pgliteModule }, async () => {
  const { PGlite } = await import(pathToFileURL(pgliteModule!).href)
  for (const populated of [false, true]) {
    const db = new PGlite()
    try {
      const baseline = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8')
      const start = baseline.indexOf('CREATE TABLE IF NOT EXISTS llm_calls (')
      const end = baseline.indexOf('\n);', start) + 3
      assert.ok(start > 0 && end > start)
      await db.exec(baseline.slice(start, end))
      await db.exec('CREATE TABLE participants(id text, company_id text, name text, PRIMARY KEY(id, company_id))')
      const insert = (id: string, extras: unknown, company = 'tenant', agent = 'agent', source = 'byoa-codex', status = 'failed') => db.query(
        `INSERT INTO llm_calls(id, company_id, agent_id, source, purpose, model, extras, status)
         VALUES ($1, $2, $3, $4, 'inbox-triage', 'requested', $5, $6)`,
        [id, company, agent, source, JSON.stringify(extras), status],
      )
      if (populated) {
        await insert('old-1', { callId: 'same' })
        await insert('old-duplicate', { callId: 'same' })
        await insert('old-no-id', {})
        await insert('old-null-id', { callId: null })
      }
      await db.exec(RUNTIME_CALL_ID_INDEX_SQL)
      await db.exec(RUNTIME_CALL_ID_INDEX_SQL)
      assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM llm_calls')).rows[0].n, populated ? 4 : 0)
      await insert('identified', { callId: 'probe', requestedModel: 'requested', actualModel: null, httpStatus: 401 })
      await insert('other-tenant', { callId: 'probe' }, 'other')
      await insert('other-agent', { callId: 'probe' }, 'tenant', 'other')
      await insert('other-source', { callId: 'probe' }, 'tenant', 'agent', 'byoa-claude')
      await insert('known', { callId: 'known', actualModel: 'provider-reported', requestedModel: 'requested' }, 'tenant', 'agent', 'byoa-codex', 'ok')
      await insert('blank', { actualModel: '', requestedModel: 'requested' })
      await insert('legacy', null, 'tenant', 'agent', 'byoa-codex', 'ok')
      await insert('no-call-id-1', {})
      await insert('no-call-id-2', {})
      const server = readFileSync(new URL('../agents/runtime/server.ts', import.meta.url), 'utf8')
      const lookup = server.match(/`(SELECT extras->>'callId' AS call_id FROM llm_calls[^`]+)`/)![1]
      const params = ['tenant', 'agent', 'byoa-codex', ['probe']]
      assert.deepEqual((await db.query(lookup, params)).rows, [{ call_id: 'probe' }])
      await db.exec('SET enable_seqscan = off; SET plan_cache_mode = force_generic_plan')
      await db.exec(`PREPARE runtime_lookup(text, text, text, text[]) AS ${lookup}`)
      const plan = await db.query("EXPLAIN (FORMAT JSON) EXECUTE runtime_lookup('tenant', 'agent', 'byoa-codex', ARRAY['probe'])")
      assert.match(JSON.stringify(plan.rows), /idx_llm_calls_runtime_call_id/)
      const usage = compile('../usage.ts', { query: (sql: string, values: unknown[]) => db.query(sql, values) })
      const logs = await usage.usageLogs('tenant', { from: new Date(0), to: new Date(Date.now() + 60000) }, { page: 1, pageSize: 50 })
      for (const id of ['identified', 'legacy', 'blank', 'no-call-id-1']) {
        const row = logs.items.find((r: any) => r.id === id)
        assert.equal(row.actualModel, null, id)
        assert.equal(row.requestedModel, 'requested', id)
      }
      assert.equal(logs.items.find((r: any) => r.id === 'known').actualModel, 'provider-reported')
      assert.equal(logs.items.find((r: any) => r.id === 'identified').httpStatus, 401)
    } finally { await db.close() }
  }
})
