import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { pathToFileURL } from 'node:url'
import { RUNTIME_CALL_ID_INDEX_SQL } from '../db/migrations/0014-runtime-call-id-index.js'
import { USAGE_ROLLUP_V2_SQL } from '../db/migrations/0013-usage-rollup-v2.js'
import { LLM_LEDGER_V2_SQL } from '../db/migrations/0020-llm-ledger-v2.js'
import { ROLLUP_MODEL_EVIDENCE_SQL } from '../db/migrations/0023-rollup-model-evidence.js'

function tableSql(sql: string, table: string): string {
  const statement = sql.match(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} \\([\\s\\S]*?\\n\\);`))?.[0]
  assert.ok(statement, `missing table DDL: ${table}`)
  return statement.replace(/CREATE TABLE (?:IF NOT EXISTS )?/, 'CREATE TEMP TABLE ')
}

const ledgerColumns = LLM_LEDGER_V2_SQL.slice(0, LLM_LEDGER_V2_SQL.indexOf(';') + 1)

function compile(path: string, pool: unknown, settings: Record<string, number> = {}) {
  const js = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', 'require', js)(exports, (name: string) => {
    if (name === './agents/llm-rollup.js') return { isLlmRollupPaused: () => false }
    // llm-rollup.ts now delegates the v3 refresh to models/rollup.ts; compile it
    // with the same fake pool instead of stubbing the behaviour under test.
    if (name === '../models/rollup.js') return compile('../models/rollup.ts', pool, settings)
    if (name.endsWith('/settings.js')) return { automationNumber: (key: string) => settings[key] ?? ({ llm_rollup_interval_ms: 120_000, db_gc_llm_calls_days: 90, llm_rollup_retention_hours: 2280 }[key]), createOperationsWorker: () => ({ start() {}, stop() {} }) }
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
      await client.query(tableSql(baseline, table))
    }
    await client.query('ALTER TABLE llm_calls ADD COLUMN daemon_version text')
    // The ledger columns (migration 20) live inside the same temp table the
    // queries read; apply just that ALTER so the fixture mirrors the schema
    // without materialising the migration's real tables.
    await client.query(ledgerColumns)
    await client.query(`CREATE UNIQUE INDEX test_legacy_key ON llm_calls_rollup
      (bucket_hour, company_id, agent_id, purpose, model, source, daemon_version) NULLS NOT DISTINCT`)
    await client.query('CREATE INDEX test_raw_company_created ON llm_calls(company_id, created_at)')
    await client.query('CREATE TEMP TABLE participants(id text, company_id text, name text, avatar_url text, PRIMARY KEY(id, company_id))')
    // Use migration DDL so an unmigrated CI database and PGlite work too.
    // Keep v3 uncertified during the v1/v2 scenarios; exercise it explicitly below.
    for (const table of ['llm_calls_rollup_v3', 'llm_rollup_state_v3']) {
      await client.query(tableSql(LLM_LEDGER_V2_SQL, table))
    }
    await client.query(ROLLUP_MODEL_EVIDENCE_SQL)
    await client.query(USAGE_ROLLUP_V2_SQL.replaceAll('CREATE TABLE ', 'CREATE TEMP TABLE '))
    let failPrune = false
    let publicationSql = ''
    const query = (sql: string, values: unknown[]) => {
      if (sql.includes('coverage_from = GREATEST')) publicationSql = sql
      if (failPrune && sql.startsWith('DELETE FROM llm_calls_rollup_v2')) throw new Error('injected prune failure')
      return client.query(sql, values)
    }
    const pool = { query, connect: async () => ({ query, release() {} }) }
    const settings = { llm_rollup_retention_hours: 2280, db_gc_llm_calls_days: 90 }
    const usage = compile('../usage.ts', pool, settings), rollup = compile('../agents/llm-rollup.ts', pool, settings)
    const base = Math.floor(Date.now() / 3600000) * 3600000 - 4 * 3600000
    const from = new Date(base + 17 * 60000), to = new Date(base + 2 * 3600000 + 43 * 60000)
    const range = { from, to }
    const insert = async (id: string, time: number, route: string, measured = true, unpriced = false, tenant = 'tenant') => {
      // Both writers read this fixture: v2 uses the compatibility columns,
      // raw/v3 use typed ledger fields. Unknown/unpriced costs remain NULL in
      // the ledger and contribute zero to the legacy numeric total.
      const priced = measured && !unpriced
      await client.query(`INSERT INTO llm_calls(id, company_id, agent_id, purpose, model, source, source_kind, created_at, occurred_at,
        input_tokens, output_tokens, cost_usd, cost_estimated, measured, status, extras,
        schema_version, reference_cost_usd, usage_state, pricing_state, route_id, platform, request_model)
        VALUES ($1, $2, 'a', 'chat', 'same-model', 'server', $6, $3, $3, 10, 2, COALESCE($7::numeric, 0), TRUE, $4, 'ok', $5,
          2, $7, $8, $9, $10, 'openai', 'same-model')`,
      [id, tenant, new Date(time), measured, JSON.stringify({ route, platform: 'openai', ...(!priced ? { unpriced: 'missing-price' } : {}) }),
        route === 'env' || route.startsWith('direct:') ? 'env' : route.startsWith('byoa') ? 'byoa' : 'sub2api',
        priced ? 0.5 : null, measured ? 'reported' : 'unknown', priced ? 'priced' : 'unpriced', route])
    }
    const seedWindow = async () => {
      await insert('outside-before', from.getTime() - 1, 'gateway')
      await insert('left', from.getTime(), 'gateway')
      await insert('middle', base + 3600000 + 1000, 'gateway', false)
      await insert('middle-env', base + 3600000 + 2000, 'env', true, true)
      await insert('right', to.getTime() - 1, 'env')
      await insert('outside-after', to.getTime(), 'env')
      await insert('other-tenant', from.getTime(), 'gateway', true, false, 'other')
    }
    await seedWindow()
    await client.query("INSERT INTO participants(id, company_id, name) VALUES ('a', 'tenant', 'Tenant A'), ('a', 'other', 'Other A')")
    const expected = async (window = range) => (await client.query(`SELECT COUNT(*)::int AS requests, SUM(cost_usd)::float AS cost,
      SUM(input_tokens)::int AS input, SUM(output_tokens)::int AS output,
      SUM(cached_input_tokens)::int AS cache_read, SUM(cache_creation_tokens)::int AS cache_write
      FROM llm_calls WHERE company_id = 'tenant' AND record_kind = 'attempt'
        AND occurred_at >= $1 AND occurred_at < $2`, [window.from, window.to])).rows[0]
    const check = async (window = range) => {
      const raw = await expected(window), summary = await usage.usageSummary('tenant', window)
      assert.equal(summary.requests, raw.requests, 'summary requests match raw')
      assert.equal(summary.costUsd, raw.cost ?? 0, 'summary cost matches raw')
      const trend = await usage.usageTrend('tenant', window, 'hour')
      // Trends expose nullable reference costs. v1/v2 preserve compatibility
      // cost totals but cannot certify reference costs; do not turn NULL into a price.
      assert.equal(trend.reduce((sum: number, row: any) => sum + (row.costUsd ?? 0), 0), Number(summary.referenceCostUsd ?? 0))
      for (const [field, column] of [['inputTokens', 'input'], ['outputTokens', 'output'], ['cacheReadTokens', 'cache_read'], ['cacheWriteTokens', 'cache_write']]) {
        assert.equal(trend.reduce((sum: number, row: any) => sum + row[field], 0), raw[column] ?? 0, `trend ${field} matches raw`)
      }
    }
    await check() // pending: all whole hours must fall back to raw
    assert.deepEqual((await usage.usageTrend('tenant', range, 'hour')).map((r: any) => r.costUsd), [0.5, null, 0.5])
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
    assert.equal((await usage.usageSummary('tenant', range)).unpricedRequests, 2)
    const models = await usage.usageByModel('tenant', range)
    // v2 has no source-kind evidence; typed raw boundary rows retain theirs.
    assert.deepEqual(models.map((r: any) => ({ source: r.sourceKind, route: r.route, requests: r.requests }))
      .sort((a: any, b: any) => String(a.source).localeCompare(String(b.source))), [
      { source: 'env', route: 'env', requests: 1 },
      { source: null, route: null, requests: 2 },
      { source: 'sub2api', route: 'gateway', requests: 1 },
    ])
    assert.ok(models.every((r: any) => r.model === 'same-model' && r.actualModel === null && r.requestModel === 'same-model'))
    assert.equal((await usage.usageLogs('tenant', range, { page: 1, pageSize: 50 })).total, 4)
    const agents = await usage.usageByAgent('tenant', range)
    assert.deepEqual(agents.map((r: any) => ({ source: r.actualSource, requests: r.requests, cost: r.costUsd }))
      .sort((a: any, b: any) => a.source.localeCompare(b.source)), [
      { source: 'env', requests: 1, cost: 0.5 },
      { source: 'server', requests: 2, cost: 0 },
      { source: 'sub2api', requests: 1, cost: 0.5 },
    ])
    assert.ok(agents.every((r: any) => r.agentId === 'a' && r.name === 'Tenant A'))
    const logs = await usage.usageLogs('tenant', range, { page: 1, pageSize: 50 })
    assert.equal(logs.items.length, 4)
    assert.equal(new Set(logs.items.map((r: any) => r.id)).size, 4)
    assert.ok(logs.items.every((r: any) => r.agentName === 'Tenant A'))
    // Legacy NULL platform and explicit v2 platform keep separate model evidence
    // but cannot certify a provider from the model name or platform alone.
    await client.query("UPDATE llm_calls SET model = 'gpt-5.5', request_model = 'gpt-5.5'")
    await client.query('TRUNCATE llm_calls_rollup, llm_calls_rollup_v2')
    await rollup.refreshLlmRollup(95 * 24)
    await client.query('UPDATE llm_rollup_state SET coverage_from = $1', [new Date(base + 2 * 3600000)])
    const mixed = { from: new Date(base), to: new Date(base + 3 * 3600000) }
    await check(mixed)
    assert.deepEqual((await usage.usageTrend('tenant', mixed, 'hour')).map((r: any) => r.costUsd), [null, null, null])
    const mixedModels = await usage.usageByModel('tenant', mixed)
    assert.deepEqual(mixedModels.map((r: any) => ({ platform: r.platform, requests: r.requests, quality: r.qualityUnknownRequests }))
      .sort((a: any, b: any) => String(a.platform).localeCompare(String(b.platform))), [
      { platform: null, requests: 4, quality: 4 },
      { platform: 'openai', requests: 2, quality: 2 },
    ])
    // Neither v1 nor v2 certifies the new ledger quality dimensions.
    assert.equal(mixedModels.reduce((sum: number, r: any) => sum + r.qualityUnknownRequests, 0), 6)
    const providers = await usage.usageByProvider('tenant', mixed)
    assert.deepEqual(providers, [{ provider: 'unknown', requests: 6, inputTokens: 60, outputTokens: 12, costUsd: 2 }])
    // Restore fixture dimensions and clear rebuilt buckets before convergence checks.
    await client.query("UPDATE llm_calls SET model = 'same-model', request_model = 'same-model'")
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

    // Shrink 95 days of rollups to 24 hours while 90 days of raw still exist.
    // All five aggregate endpoints must continue to match the exact raw window.
    const wide = { from: new Date(base - 7 * 86400000), to: new Date() }
    for (const [index, days] of [6, 4, 2].entries()) {
      await insert(`retention-${index}`, base - days * 86400000 + 17 * 60000, 'direct:novita')
      await client.query(`UPDATE llm_calls SET model = 'claude-retention-test', request_model = 'claude-retention-test', input_tokens = 100,
        cached_input_tokens = 200, cache_creation_tokens = 300, output_tokens = 50,
        platform = $3, provider_id = $4, extras = $2 WHERE id = $1`, [`retention-${index}`, JSON.stringify({ route: 'direct:novita',
        ...(index === 1 ? { platform: 'anthropic' } : {}), actualModel: 'claude-retention-test' }), index === 1 ? 'anthropic' : null,
        index === 1 ? 'Anthropic' : 'Novita'])
    }
    const checkAll = async (window = wide) => {
      await check(window)
      const raw = await expected(window)
      for (const method of ['usageByAgent', 'usageByModel', 'usageByProvider']) {
        const rows = await usage[method]('tenant', window)
        assert.equal(rows.reduce((sum: number, row: any) => sum + row.requests, 0), raw.requests, method)
        assert.equal(rows.reduce((sum: number, row: any) => sum + row.costUsd, 0), raw.cost ?? 0, method)
      }
    }
    await rollup.refreshLlmRollup(95 * 24)
    await checkAll()
    settings.llm_rollup_retention_hours = 24
    await rollup.refreshLlmRollup(3)
    const state = (await client.query('SELECT * FROM llm_rollup_state')).rows[0]
    const deletionFloor = Math.ceil((new Date(state.aggregated_at).getTime() - 24 * 3600000) / 3600000) * 3600000
    assert.equal(new Date(state.coverage_from).getTime(), deletionFloor)
    for (const table of ['llm_calls_rollup', 'llm_calls_rollup_v2']) {
      assert.equal((await client.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE bucket_hour < $1`, [new Date(deletionFloor)])).rows[0].n, 0)
    }
    await checkAll()
    await checkAll({ from: new Date(wide.from.getTime() + 17 * 60000), to: new Date(base - 86400000 + 43 * 60000) })
    const rawProviders = await usage.usageByProvider('tenant', wide)
    assert.equal(rawProviders.find((row: any) => row.provider === 'Novita').requests, 2)
    assert.equal(rawProviders.find((row: any) => row.provider === 'Anthropic').requests, 1)
    const complete = await usage.usageMetadata('tenant', wide)
    assert.equal(complete.logsComplete, true)
    assert.equal(complete.boundaryComplete, true)
    assert.deepEqual(complete.coverageGaps, [])
    assert.deepEqual(complete.legacyCoverage, [])
    assert.equal(complete.retainedRollupFrom, new Date(deletionFloor).toISOString())
    assert.equal(complete.deliveryComplete, null)
    // The reader also defends against a stale pre-fix watermark under the
    // currently configured retention, before the first fixed refresh runs.
    await client.query('UPDATE llm_rollup_state SET coverage_from = $1', [wide.from])
    await checkAll()
    await rollup.refreshLlmRollup(3)
    for (const hours of [2280, 0]) {
      settings.llm_rollup_retention_hours = hours
      await rollup.refreshLlmRollup(3)
      assert.equal(new Date((await client.query('SELECT coverage_from FROM llm_rollup_state')).rows[0].coverage_from).getTime(), deletionFloor,
        'increasing/disabling retention must not resurrect deleted coverage')
      await checkAll()
    }
    await rollup.refreshLlmRollup(95 * 24)
    assert.ok(new Date((await client.query('SELECT coverage_from FROM llm_rollup_state')).rows[0].coverage_from).getTime() < wide.from.getTime(),
      'an actual wide rebuild can restore coverage')
    await checkAll()
    const tokenSummary = await usage.usageSummary('tenant', wide)
    const totalTokens = tokenSummary.inputTokens + tokenSummary.cacheReadTokens + tokenSummary.cacheWriteTokens + tokenSummary.outputTokens
    for (const method of ['usageByAgent', 'usageByModel', 'usageByProvider']) {
      const rows = await usage[method]('tenant', wide)
      assert.equal(rows.reduce((sum: number, row: any) => sum + row.inputTokens + row.outputTokens, 0), totalTokens)
    }
    const tokenLogs = await usage.usageLogs('tenant', wide, { page: 1, pageSize: 200 })
    assert.equal(tokenLogs.items.reduce((sum: number, row: any) => sum + row.inputTokens + row.outputTokens, 0), totalTokens)
    assert.equal(tokenLogs.items.find((row: any) => row.id === 'retention-0').provider, 'Novita')
    const tokenModels = await usage.usageByModel('tenant', wide)
    const mixedPlatforms = tokenModels.filter((row: any) => row.model === 'claude-retention-test')
    assert.deepEqual(mixedPlatforms.map((row: any) => ({ platforms: row.platforms, requests: row.requests }))
      .sort((a: any, b: any) => a.platforms[0].localeCompare(b.platforms[0])), [
      { platforms: ['anthropic'], requests: 1 }, { platforms: ['novita'], requests: 2 },
    ])
    const tokenProviders = await usage.usageByProvider('tenant', wide)
    assert.equal(tokenProviders.length, 1)
    assert.equal(tokenProviders[0].provider, 'unknown', 'v2 cannot restore provider IDs from platform labels')
    assert.equal(tokenProviders[0].requests, (await expected(wide)).requests)

    // When both storage tiers have expired, exact whole-hour queries must also
    // disclose holes. Surviving v1 hours cannot certify neighboring empty hours.
    settings.llm_rollup_retention_hours = 24
    settings.db_gc_llm_calls_days = 1
    await rollup.refreshLlmRollup(3)
    await client.query("DELETE FROM llm_calls WHERE created_at < NOW() - INTERVAL '1 day'")
    const missing = { from: wide.from, to: new Date(base - 2 * 86400000) }
    const gap = await usage.usageMetadata('tenant', missing)
    assert.equal(gap.logsComplete, false)
    assert.equal(gap.boundaryComplete, false)
    assert.deepEqual(gap.coverageGaps, [{ from: missing.from.toISOString(), to: missing.to.toISOString() }])
    assert.equal((await usage.usageSummary('tenant', missing)).requests, 0)
    const legacyHour = new Date(missing.from.getTime() + 3600000)
    await client.query(`INSERT INTO llm_calls_rollup(bucket_hour, company_id, purpose, model, source, calls, cost_usd)
      VALUES ($1, 'tenant', 'chat', 'surviving-v1', 'server', 2, 4),
             ($2, 'other', 'chat', 'other-v1', 'server', 20, 40)`, [legacyHour, missing.from])
    // Residual raw under the old policy is still useful, but does not certify
    // that other calls were not pruned. A v1-owned hour must not double count it.
    await insert('residual-owned', legacyHour.getTime() + 1000, 'direct:novita')
    await insert('residual-uncovered', missing.from.getTime() + 1000, 'direct:novita')
    const partial = await usage.usageMetadata('tenant', missing)
    assert.equal(partial.boundaryComplete, false)
    assert.deepEqual(partial.legacyCoverage, [{ from: legacyHour.toISOString(), to: new Date(legacyHour.getTime() + 3600000).toISOString() }])
    assert.equal(partial.coverageGaps.length, 2)
    assert.equal(partial.coverageGaps[0].from, missing.from.toISOString())
    const historicalSummary = await usage.usageSummary('tenant', missing)
    assert.equal(historicalSummary.requests, 3)
    assert.equal(historicalSummary.qualityUnknownRequests, 2)
    assert.equal(historicalSummary.costUsd, 4.5)
    const legacyOnly = { from: legacyHour, to: new Date(legacyHour.getTime() + 3600000) }
    assert.equal((await usage.usageMetadata('tenant', legacyOnly)).boundaryComplete, true)
    const partialLegacy = { from: new Date(legacyHour.getTime() + 30 * 60000), to: legacyOnly.to }
    assert.equal((await usage.usageMetadata('tenant', partialLegacy)).boundaryComplete, false)
    assert.equal((await usage.usageSummary('tenant', partialLegacy)).requests, 0,
      'a partial hour cannot read the entire legacy bucket')

    // Execute the writer's actual publication SQL at both sides of an exact
    // hour. Empty certified v2 hours are valid zero usage even after raw expires.
    assert.ok(publicationSql)
    for (const timestamp of ['2026-09-02T12:00:00Z', '2026-09-02T12:00:00.001Z', '2026-09-02T12:43:00Z']) {
      const until = new Date(timestamp), since = new Date(until.getTime() - 3 * 3600000)
      await client.query(`UPDATE llm_rollup_state SET coverage_from = '2026-08-01T00:00:00Z',
        completed_through = $1`, [since])
      await client.query(publicationSql, [since, until, 24])
      const expectedFloor = Math.ceil((until.getTime() - 24 * 3600000) / 3600000) * 3600000
      const actualState = (await client.query('SELECT coverage_from FROM llm_rollup_state')).rows[0]
      assert.equal(new Date(actualState.coverage_from).getTime(), expectedFloor, timestamp)
      const emptyHour = { from: new Date(expectedFloor), to: new Date(expectedFloor + 3600000) }
      const emptyMeta = await usage.usageMetadata('empty-tenant', emptyHour)
      assert.equal(emptyMeta.retainedRollupFrom, emptyHour.from.toISOString())
      assert.equal(emptyMeta.boundaryComplete, true)
      assert.deepEqual(emptyMeta.coverageGaps, [])
      assert.equal((await usage.usageSummary('empty-tenant', emptyHour)).requests, 0)
    }
    await client.query('DELETE FROM llm_rollup_state')
    const absentState = await usage.usageMetadata('tenant', missing)
    assert.equal(absentState.aggregationStatus, 'pending')
    assert.equal(absentState.boundaryComplete, false)
    assert.equal((await usage.usageSummary('tenant', missing)).requests, 2, 'missing state uses every remaining raw row')

    // Start with v2 evidence, then install the migration's real dirty trigger in
    // pg_temp. This exercises the delegated v3 writer without touching public
    // functions/state or allowing v3 to mask the v1/v2 retention scenarios above.
    await client.query('TRUNCATE llm_calls, llm_calls_rollup, llm_calls_rollup_v2, llm_calls_rollup_v3, llm_rollup_state_v3')
    await client.query('INSERT INTO llm_rollup_state(id) VALUES (TRUE)')
    settings.llm_rollup_retention_hours = 2280
    settings.db_gc_llm_calls_days = 90
    await seedWindow()
    await rollup.refreshLlmRollup(95 * 24)
    const middleHour = { from: new Date(base + 3600000), to: new Date(base + 2 * 3600000) }
    assert.equal((await usage.usageSummary('tenant', middleHour)).qualityUnknownRequests, 2)
    assert.deepEqual((await usage.usageMetadata('tenant', range)).v3Coverage, [])
    const dirtySql = LLM_LEDGER_V2_SQL.slice(LLM_LEDGER_V2_SQL.indexOf('CREATE FUNCTION dirty_llm_bucket()'))
      .replaceAll('FUNCTION dirty_llm_bucket()', 'FUNCTION pg_temp.dirty_llm_bucket()')
    await client.query(dirtySql)
    assert.equal((await usage.usageMetadata('tenant', range)).dirtyBuckets, 3)
    await checkAll(range)
    assert.equal((await usage.usageSummary('tenant', range)).qualityUnknownRequests, 0, 'dirty v3 buckets bypass certified v2')
    await rollup.runLlmRollupTick()
    await checkAll(range)
    await checkAll(mixed)
    const v3Meta = await usage.usageMetadata('tenant', range)
    assert.equal(v3Meta.dirtyBuckets, 0)
    assert.deepEqual(v3Meta.v3Coverage, [{ from: middleHour.from.toISOString(), to: middleHour.to.toISOString() }])
    const v3Summary = await usage.usageSummary('tenant', range)
    assert.equal(v3Summary.requests, 4)
    assert.equal(v3Summary.costUsd, 1)
    assert.equal(Number(v3Summary.referenceCostUsd), 1)
    assert.equal(v3Summary.unknownRequests, 1)
    assert.equal(v3Summary.unpricedRequests, 2)
    assert.equal(v3Summary.qualityUnknownRequests, 0)
    assert.deepEqual((await usage.usageTrend('tenant', range, 'hour')).map((r: any) => r.costUsd), [0.5, null, 0.5])
    assert.deepEqual((await usage.usageByModel('tenant', range)).map((r: any) => ({ source: r.sourceKind, route: r.route, requests: r.requests }))
      .sort((a: any, b: any) => a.source.localeCompare(b.source)), [
      { source: 'env', route: 'env', requests: 2 }, { source: 'sub2api', route: 'gateway', requests: 2 },
    ])

    // The receipt trigger must make a late engine observation visible before
    // refresh. Decision records are never billable attempts in raw, v2 or v3.
    await insert('late-v3', base + 3600000 + 3000, 'byoa-codex')
    await client.query("UPDATE llm_calls SET observation_granularity = 'engine_turn' WHERE id = 'late-v3'")
    await insert('decision', base + 3600000 + 4000, 'gateway')
    await client.query("UPDATE llm_calls SET record_kind = 'decision', cost_usd = 99, reference_cost_usd = 99 WHERE id = 'decision'")
    assert.equal((await usage.usageMetadata('tenant', range)).dirtyBuckets, 1)
    await checkAll(range)
    assert.equal((await usage.usageSummary('tenant', range)).requests, 5)
    const v3Rows = async () => (await client.query('SELECT * FROM llm_calls_rollup_v3 ORDER BY bucket_hour, company_id, source_kind, model')).rows
    const staleV3 = await v3Rows()
    assert.equal(staleV3.filter((r: any) => r.company_id === 'tenant').reduce((sum: number, r: any) => sum + Number(r.calls), 0), 6)
    await rollup.runLlmRollupTick()
    await checkAll(range)
    const convergedV3 = await v3Rows()
    assert.equal(convergedV3.filter((r: any) => r.company_id === 'tenant').reduce((sum: number, r: any) => sum + Number(r.calls), 0), 7)
    assert.equal(convergedV3.find((r: any) => r.source_kind === 'byoa').observation_granularity, 'engine_turn')
    await rollup.runLlmRollupTick()
    assert.deepEqual(await v3Rows(), convergedV3, 'a repeated tick cannot duplicate v3 groups')
    await checkAll(range)

    // Move the only BYOA fact to a new model/route, then delete it entirely.
    // Rebuilding must remove vanished groups, not just upsert the replacement.
    await client.query(`UPDATE llm_calls SET model = 'moved-model', request_model = 'moved-model', actual_model = 'reported-model',
      actual_model_state = 'reported', route_id = 'byoa-new', extras = '{"route":"byoa-new","platform":"openai"}' WHERE id = 'late-v3'`)
    await checkAll(range)
    await rollup.runLlmRollupTick()
    const movedV3 = (await v3Rows()).filter((r: any) => r.source_kind === 'byoa')
    assert.equal(movedV3.length, 1)
    assert.equal(movedV3[0].model, 'reported-model')
    assert.equal(movedV3[0].request_model, 'moved-model')
    assert.equal(movedV3[0].actual_model_state, 'reported')
    assert.equal(movedV3[0].route, 'byoa-new')
    await checkAll(range)
    await client.query("DELETE FROM llm_calls WHERE id = 'late-v3'")
    await checkAll(range)
    await rollup.runLlmRollupTick()
    assert.equal((await v3Rows()).filter((r: any) => r.source_kind === 'byoa').length, 0)
    await checkAll(range)
    assert.equal((await usage.usageSummary('tenant', range)).requests, 4)

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
      // usageLogs now reads the migrated ledger; retain the historical inserts
      // above so the runtime-call-id migration is still tested on old histories.
      await db.exec(ledgerColumns)
      const backfill = LLM_LEDGER_V2_SQL.match(/UPDATE llm_calls SET[\s\S]*?;/)?.[0]
      assert.ok(backfill)
      await db.exec(backfill)
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
