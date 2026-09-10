/**
 * Unit tests for the usage dashboard's pure helpers: provider labeling and
 * range parsing/clamping. No DB.
 *
 * Run: node --import tsx --test server/src/__tests__/usage.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function loadUsage(query: (sql: string, params: unknown[]) => Promise<unknown> = async () => { throw new Error('unexpected DB call') }, settings: Record<string, number> = {}) {
  const source = readFileSync(new URL('../usage.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', 'require', js)(exports, (name: string) => {
    if (name === './agents/llm-rollup.js') return { isLlmRollupPaused: () => settings.llm_rollup_interval_ms === 0 }
    if (name.endsWith('/settings.js')) return { automationNumber: (key: string) => settings[key] ?? ({ llm_rollup_interval_ms: 120_000, db_gc_llm_calls_days: 90, llm_rollup_retention_hours: 2280 }[key]), createOperationsWorker: () => ({ start() {}, stop() {} }) }
    assert.equal(name, './db/pool.js')
    return { pool: { query } }
  })
  return exports
}
const { providerForModel, parseUsageRange, parseUsagePagination, UsageInputError } = loadUsage()

test('providerForModel: prefix relays win over family names', () => {
  assert.equal(providerForModel('novita/deepseek-v4-flash'), 'Novita')
  assert.equal(providerForModel('orcarouter/deepseek-v4-flash'), 'OrcaRouter')
})

test('providerForModel: family labels', () => {
  assert.equal(providerForModel('k3'), 'Kimi')
  assert.equal(providerForModel('kimi-for-coding'), 'Kimi')
  assert.equal(providerForModel('deepseek-v4-pro'), 'DeepSeek')
  assert.equal(providerForModel('qwen-image-max'), 'DashScope')
  assert.equal(providerForModel('gpt-5.5'), 'OpenAI')
  assert.equal(providerForModel('claude-sonnet-4-6'), 'Anthropic')
  assert.equal(providerForModel('gemini-3.1-pro-high'), 'Google')
  assert.equal(providerForModel('grok-4'), 'xAI')
  assert.equal(providerForModel('chatgpt-web/medium'), 'ChatGPT Web')
  assert.equal(providerForModel('text-embedding-v4'), 'other')
  assert.equal(providerForModel(null), 'unknown')
  assert.equal(providerForModel(''), 'unknown')
})

test('parseUsageRange: defaults to today, clamps future end, caps 92 days back', () => {
  const r = parseUsageRange({})
  assert.equal(r.from.getUTCHours() + r.from.getUTCMinutes() + r.from.getUTCSeconds(), 0)
  const ninetyTwoDays = 92 * 86_400_000
  const long = parseUsageRange({ from: new Date(Date.now() - 200 * 86_400_000).toISOString() })
  assert.ok(long.to.getTime() - long.from.getTime() <= ninetyTwoDays + 86_400_000)
  const future = parseUsageRange({ to: new Date(Date.now() + 10 * 86_400_000).toISOString() })
  assert.ok(future.to.getTime() <= Date.now() + 86_400_000)
})

test('parseUsageRange: explicit ISO range passes through; garbage is rejected', () => {
  const from = '2026-09-01T00:00:00Z'
  const to = '2026-09-02T00:00:00Z'
  const r = parseUsageRange({ from, to })
  assert.equal(r.from.toISOString(), new Date(from).toISOString())
  assert.equal(r.to.toISOString(), new Date(to).toISOString())
  assert.throws(() => parseUsageRange({ from: 'not-a-date', to: 'also-not' }), UsageInputError)
})

test('providerForModel: similar IDs never inherit a provider by substring', () => {
  for (const model of ['not-deepseek-v4-pro', 'my-moonshot', 'gpt-5.5-impostor', 'k30', 'claudeish', 'qwenish', 'unknown/gpt-5.5']) {
    assert.equal(providerForModel(model), 'other', model)
  }
})

test('range uses UTC, accepts offsets, rejects ambiguous and reversed windows, caps duration at 92 days', () => {
  const date = new Date(Math.floor(Date.now() / 86400000) * 86400000 - 86400000).toISOString().slice(0, 10)
  const r = parseUsageRange({ from: date, to: `${date}T23:59:59Z` })
  assert.equal(r.from.toISOString(), `${date}T00:00:00.000Z`)
  assert.equal(parseUsageRange({ from: `${date}T08:00:00+08:00`, to: `${date}T23:59:59Z` }).from.getTime(), r.from.getTime())
  for (const q of [{ from: `${date}T10:17:00` }, { from: '2026-02-30' }, { from: date, to: date }, { from: [], to: date }]) {
    assert.throws(() => parseUsageRange(q), UsageInputError)
  }
  const capped = parseUsageRange({ from: new Date(Date.now() - 100 * 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString() })
  assert.ok(capped.to.getTime() - capped.from.getTime() <= 92 * 86400000)
})

test('pagination rejects malformed or unsafe SQL parameters before any query', async () => {
  const usage = loadUsage()
  for (const value of [Infinity, NaN, -1, 0, 1.5, 'Infinity', 'NaN', '-1', '0', '1.5', '', ' ', [], {}, '1e2', '9007199254740992']) {
    assert.throws(() => parseUsagePagination({ page: value }), UsageInputError)
    assert.throws(() => parseUsagePagination({ pageSize: value }), UsageInputError)
    await assert.rejects(usage.usageLogs('tenant', { from: new Date(0), to: new Date(1) }, { page: value, pageSize: 50 }))
  }
  assert.throws(() => parseUsagePagination({ pageSize: 201 }), UsageInputError)
  assert.throws(() => parseUsagePagination({ page: Number.MAX_SAFE_INTEGER, pageSize: 200 }), UsageInputError)
  assert.deepEqual(parseUsagePagination({}), { page: 1, pageSize: 50 })
  assert.deepEqual(parseUsagePagination({ page: '2', pageSize: '200' }), { page: 2, pageSize: 200 })
})

test('non-hour-aligned trend retains returned values and fills UTC bucket boundaries', async () => {
  const usage = loadUsage(async (sql, values) => {
    assert.match(sql, /date_trunc\(\$4, bucket_hour, 'UTC'\)/)
    assert.deepEqual(values.slice(1, 3), ['2026-09-01T10:17:00.000Z', '2026-09-01T12:43:00.000Z'])
    return { rows: [{ bucket: new Date('2026-09-01T11:00:00Z'), cost_usd: '2', input_tokens: '30', output_tokens: '10', cache_read: '3' }] }
  })
  const rows = await usage.usageTrend('tenant', { from: new Date('2026-09-01T10:17:00Z'), to: new Date('2026-09-01T12:43:00Z') }, 'hour')
  assert.deepEqual(rows.map((r: any) => r.bucket), ['2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', '2026-09-01T12:00:00.000Z'])
  assert.deepEqual(rows.map((r: any) => r.costUsd), [0, 2, 0])
  const day = await loadUsage(async () => ({ rows: [{ bucket: new Date('2026-09-01T00:00:00Z'), cost_usd: '7' }] }))
    .usageTrend('tenant', { from: new Date('2026-09-01T23:17:00+08:00'), to: new Date('2026-09-02T01:43:00+08:00') }, 'day')
  assert.equal(day.length, 1)
  assert.equal(day[0].costUsd, 7)
})

test('models keep the same model separated by recorded route and source', async () => {
  const usage = loadUsage(async (sql) => {
    assert.match(sql, /GROUP BY model, route, platform, source/)
    return { rows: ['sub2api:openai', 'env:openai'].map(route => ({ model: 'gpt-5.5', route, platform: 'openai', source: 'server', requests: '1', input_tokens: '4', output_tokens: '2', cost_usd: '0.2', cost_estimated: true, unknown_calls: '1', unpriced_calls: '1', quality_unknown_calls: '0' })) }
  })
  const rows = await usage.usageByModel('tenant', { from: new Date(0), to: new Date(1) })
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].route, rows[1].route)
  assert.equal(rows[0].source, 'server')
  assert.equal(rows[0].unknownRequests, 1)
  assert.equal(rows[0].unpricedRequests, 1)
})

test('agent source comes from the ledger, independently of current computer assignment', async () => {
  const usage = loadUsage(async (sql) => {
    assert.doesNotMatch(sql, /JOIN computers/)
    return { rows: [{ agent_id: 'a', name: 'A', source: 'server', requests: '1', ok: '1' }] }
  })
  assert.equal((await usage.usageByAgent('t', { from: new Date(0), to: new Date(1) }))[0].actualSource, 'server')
})

test('metadata distinguishes retained raw logs from a 92-day summary and reports worker state', async () => {
  const retained = new Date(Date.now() - 90 * 86400000)
  for (const status of ['paused', 'failed', 'pending', 'ready']) {
    const usage = loadUsage(async () => ({ rows: [{ raw_retention_from: retained, earliest_raw_at: retained,
      aggregated_at: null, completed_through: null, coverage_from: null, status, stale: false }] }))
    const meta = await usage.usageMetadata('tenant', { from: new Date(Date.now() - 92 * 86400000), to: new Date() })
    assert.equal(meta.logsComplete, false)
    assert.equal(meta.boundaryComplete, false)
    assert.equal(meta.aggregationStatus, status)
    assert.equal(meta.aggregatedAt, null)
    assert.equal(meta.rawRetentionFrom, retained.toISOString())
  }
})

test('all usage endpoints map input errors to HTTP 400 without changing other error handling', async () => {
  const router = readFileSync(new URL('../api/router.ts', import.meta.url), 'utf8')
  const helper = router.slice(router.indexOf('function safeUsage('), router.indexOf('/** Usage dashboard —'))
  const js = ts.transpileModule(helper + '\nexports.safeUsage = safeUsage', { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }
  const exports: Record<string, any> = {}
  new Function('exports', 'safe', 'UsageInputError', 'HttpError', js)(exports, (handler: unknown) => handler, UsageInputError, HttpError)
  for (const endpoint of ['summary', 'trend', 'by-agent', 'by-model', 'by-provider', 'logs']) {
    assert.ok(router.includes(`api.get('/usage/${endpoint}', safeUsage(`))
  }
  await assert.rejects(exports.safeUsage(() => { parseUsagePagination({ page: 'Infinity' }) })({}, {}),
    (e: any) => e instanceof HttpError && e.status === 400)
  const failure = new Error('database unavailable')
  await assert.rejects(exports.safeUsage(() => { throw failure })({}, {}), (e: any) => e === failure)
})

test('summary separates unknown measurement, unpriced calls and unavailable legacy quality', async () => {
  const usage = loadUsage(async () => ({ rows: [{ requests: '6', input_tokens: '0', output_tokens: '0', cache_read: '0', cache_write: '0', reasoning: '0', cost_usd: '0', cost_estimated: true, ok: '4', unknown_calls: '2', unpriced_calls: '1', quality_unknown_calls: '3', sources: ['cloud', 'byoa-codex'] }] }))
  const result = await usage.usageSummary('tenant', { from: new Date(0), to: new Date(1) })
  assert.equal(result.unknownRequests, 2)
  assert.equal(result.unpricedRequests, 1)
  assert.equal(result.qualityUnknownRequests, 3)
  assert.equal(result.costEstimated, true)
  assert.deepEqual(result.sources, ['cloud', 'byoa-codex'])
  assert.equal(result.cacheHitRate, 0)
})


test('metadata uses settings for pause, stale interval and raw-retention boundary', async () => {
  const settings = { llm_rollup_interval_ms: 0, db_gc_llm_calls_days: 0 }
  const parameters: unknown[][] = []
  const usage = loadUsage(async (_sql, params) => {
    parameters.push(params)
    return { rows: [{ status: 'ready', stale: false, raw_retention_from: null }] }
  }, settings)
  const range = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z') }
  const paused = await usage.usageMetadata('tenant', range)
  assert.equal(paused.aggregationStatus, 'paused', 'settings override persisted ready status')
  assert.equal(paused.rawRetentionFrom, null)
  assert.equal(paused.logsComplete, true)
  assert.deepEqual(parameters[0], ['tenant', 300_000, 0])
  Object.assign(settings, { llm_rollup_interval_ms: 600_000, db_gc_llm_calls_days: 120 })
  assert.equal((await usage.usageMetadata('tenant', range)).aggregationStatus, 'ready')
  assert.deepEqual(parameters[1], ['tenant', 1_800_000, 120])
  assert.ok(!readFileSync(new URL('../usage.ts', import.meta.url), 'utf8').includes('process.env'))
})

test('usage log DTO preserves unknown actual models and retains requested and historical models separately', async () => {
  const cases = [
    { model: 'requested', requested_model: 'requested', actual_model: null, status: 'failed', http_status: '401' },
    { model: 'requested', requested_model: 'requested', actual_model: null, status: 'failed', failure_reason: 'connection-error' },
    { model: 'legacy', requested_model: null, actual_model: null, status: 'ok' },
    { model: 'requested', requested_model: 'requested', actual_model: '', status: 'failed' },
    { model: 'requested', requested_model: 'requested', actual_model: 'provider-reported', status: 'ok' },
  ]
  const usage = loadUsage(async (sql) => {
    if (sql.includes('COUNT(*)')) return { rows: [{ total: String(cases.length) }] }
    assert.match(sql, /NULLIF\(l.extras->>'actualModel', ''\) AS actual_model/)
    return { rows: cases.map((row, id) => ({ id: String(id), created_at: new Date(0), ...row })) }
  })
  const result = JSON.parse(JSON.stringify(await usage.usageLogs('tenant', { from: new Date(0), to: new Date(1) }, { page: 1, pageSize: 50 })))
  assert.deepEqual(result.items.map((row: any) => row.actualModel), [null, null, null, null, 'provider-reported'])
  assert.deepEqual(result.items.map((row: any) => row.requestedModel), ['requested', 'requested', 'legacy', 'requested', 'requested'])
  assert.equal(result.items[0].httpStatus, 401)
})

test('dashboard renders unknown actual model in both log cell and details while retaining requested model', async () => {
  const source = readFileSync(new URL('../../../src/desktop/UsageDashboard.tsx', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('UsageDashboard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let cell: ts.JsxElement | undefined
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'td' && node.getText(ast).includes('r.actualModel')) cell = node
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(cell, 'render the real actual-model cell including its details')
  const js = ts.transpileModule(`exports.render = (r) => (${cell.getText(ast)})`, {
    fileName: 'cell.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText
  const jsx = await import('react/jsx-runtime')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const labels: Record<string, string> = { 'settings.actualModel': '实际模型', 'settings.requestedModel': '请求模型' }
  const exports: Record<string, any> = {}
  new Function('exports', 'require', 'unknown', 'translate', 't', 'locale', 'cn', 'td', js)(
    exports, () => jsx, '未知', (_locale: string, key: string) => labels[key] ?? key,
    (key: string) => key, 'zh', (...args: string[]) => args.join(' '), '',
  )
  for (const actualModel of [null, undefined, '']) {
    const html = renderToStaticMarkup(exports.render({ actualModel, requestedModel: 'requested-only', model: 'legacy-only' }))
    assert.match(html, /^<td[^>]*>未知<details/)
    assert.match(html, /实际模型: 未知/)
    assert.match(html, /请求模型: requested-only/)
    assert.doesNotMatch(html, /legacy-only/)
  }
  const html = renderToStaticMarkup(exports.render({ actualModel: 'provider-reported', requestedModel: 'requested-only' }))
  assert.match(html, /^<td[^>]*>provider-reported<details/)
  assert.match(html, /实际模型: provider-reported/)
})
