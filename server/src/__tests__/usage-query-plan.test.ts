import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

async function summarySql() {
  let query = ''
  const source = readFileSync(new URL('../usage.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const api: Record<string, any> = {}
  new Function('exports', 'require', js)(api, (name: string) => {
    if (name === './db/pool.js') return { pool: { query: async (sql: string) => { query = sql; return { rows: [] } } } }
    if (name === './settings.js') return { automationNumber: () => 0 }
    return { isLlmRollupPaused: () => false }
  })
  await api.usageSummary('tenant', { from: new Date(), to: new Date() })
  return query
}

test('usage raw ledger has independently pushable half-open time bounds', async () => {
  const sql = await summarySql()
  assert.match(sql, /l\.occurred_at >= \$2::timestamptz AND l\.occurred_at < \$3::timestamptz/)
  assert.match(sql, /l\.occurred_at >= o\.from_at AND l\.occurred_at < o\.to_at/)
  assert.doesNotMatch(sql, /enable_material/)
})

test('PostgreSQL: usage bounds raw scans to the selected day and writes zero temporary blocks',
  { skip: !process.env.PERF_TEST_PG_CONTAINER }, async () => {
    const query = await summarySql()
    // Shadow application tables with connection-local fixtures. ROLLBACK drops
    // every fixture, including when psql exits early after an assertion error.
    const sql = `BEGIN;
      CREATE TEMP TABLE llm_calls (LIKE public.llm_calls INCLUDING DEFAULTS);
      CREATE TEMP TABLE llm_calls_rollup (LIKE public.llm_calls_rollup INCLUDING DEFAULTS);
      CREATE TEMP TABLE llm_calls_rollup_v2 (LIKE public.llm_calls_rollup_v2 INCLUDING DEFAULTS);
      CREATE TEMP TABLE llm_rollup_state (LIKE public.llm_rollup_state INCLUDING DEFAULTS);
      CREATE INDEX ON llm_calls(company_id, created_at);
      INSERT INTO llm_calls(id, company_id, purpose, model, source, status, created_at, extras)
      SELECT 'fixture-' || n, 'tenant', 'chat', 'fixture', 'server', 'ok',
        CASE WHEN n <= 3000 THEN '2026-09-10 12:00:00+00'::timestamptz ELSE '2026-09-11 12:30:00+00'::timestamptz END,
        jsonb_build_object('payload', repeat(md5(n::text), 256), 'route', 'direct:openai')
        FROM generate_series(1, 3100) n;
      ANALYZE llm_calls;
      PREPARE fixture_summary(text,timestamptz,timestamptz,text,int,double precision) AS ${query};
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE fixture_summary('tenant','2026-09-11 00:00:00+00','2026-09-12 00:00:00+00',NULL,2280,90);
      ROLLBACK;`
    const result = execFileSync(process.env.PERF_DOCKER_BIN ?? 'docker',
      ['exec', '-i', process.env.PERF_TEST_PG_CONTAINER!, 'psql', '-U', 'postgres', '-d', 'cumora', '-XqAt', '-v', 'ON_ERROR_STOP=1'],
      { input: sql, encoding: 'utf8', windowsHide: true })
    const plan = JSON.parse(result)[0]
    assert.equal(plan.Plan['Temp Written Blocks'], 0)
    let rawRows = 0
    const visit = (node: any) => {
      // EXPLAIN rounds the per-loop average (100 / 24 is reported as 4).
      if (node['Relation Name'] === 'llm_calls') rawRows += (node['Actual Rows'] + 0.5) * node['Actual Loops']
      for (const child of node.Plans ?? []) visit(child)
    }
    visit(plan.Plan)
    assert.ok(rawRows > 0 && rawRows <= 124, `raw scan upper bound ${rawRows}; outside-day rows must not be scanned`)
  })
