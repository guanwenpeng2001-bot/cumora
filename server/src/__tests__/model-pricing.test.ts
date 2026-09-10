import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import ts from 'typescript'

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
function compile(source: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', 'require', ...Object.keys(globals), output)(exports, (name: string) => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`)
    return dependencies[name]
  }, ...Object.values(globals))
  return exports
}
const priceInput = (model = 'priced-model', rate = 2) => ({ model, inPer1M: rate, cachedInPer1M: rate / 10,
  cacheWritePer1M: rate, outPer1M: rate * 2, note: null, sourceUrl: 'https://provider.invalid/pricing', pricedAt: '2026-09-10' })
const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 }
function fixture(env: Record<string, unknown> = {}) {
  const rows = new Map<string, any>(), calls: any[] = [], ledger: any[] = [], warnings: any[] = []
  let clock = 0
  let select: (() => Promise<any>) | undefined
  const pool = { query: async (sql: string, values: any[] = []) => {
    calls.push({ sql, values })
    if (sql.includes('INSERT INTO llm_calls')) { ledger.push(structuredClone(values)); return { rows: [] } }
    if (sql.startsWith('SELECT')) return select ? select() : { rows: [...rows.values()].map(r => ({ ...r })) }
    assert.match(sql, /INSERT INTO model_pricing/)
    const [model, input, cached, write, output, note, url, date] = values
    const old = rows.get(model)
    const admin = sql.includes('RETURNING *')
    if (old && !admin && (sql.includes('DO NOTHING') || old.note?.startsWith('[cumora-pricing:v1:'))) return { rows: [] }
    const row = { model, input_per_1m: input, cached_input_per_1m: cached, cache_write_per_1m: write,
      output_per_1m: output, note: !admin && old ? note + (old.note ?? '') : note,
      source_url: url ?? null, priced_at: date ?? null, updated_at: new Date(1_700_000_000_000 + ++clock).toISOString() }
    rows.set(model, row)
    return { rows: [row] }
  } }
  const pricing: Record<string, any> = {}
  const cost = compile(read('../agents/cost.ts'), { './token-usage.js': compile(read('../agents/token-usage.ts'), {}), '../model-pricing.js': pricing, 'node:crypto': { createHash } },
    { process: { env: { CUMORA_MODEL_PRICES_JSON: JSON.stringify(env) } }, console: { warn: (...args: any[]) => warnings.push(args) } })
  Object.assign(pricing, compile(read('../model-pricing.ts'), { './db/pool.js': { pool }, './agents/cost.js': cost },
    { console: { warn: (...args: any[]) => warnings.push(args) } }))
  const ledgerSource = read('../agents/llm-ledger.ts')
  const recorder = compile(ledgerSource.slice(0, ledgerSource.indexOf('/** Classify a thrown')), {
    'node:crypto': { randomUUID }, '../db/pool.js': { pool }, '../llm.js': {}, '../llm-execution.js': {}, './cost.js': cost,
  })
  const fallback = compile(read('../agents/fallback.ts'), { '../settings.js': {} })
  const execution = compile(read('../llm-execution.ts'), {
    'node:crypto': { randomUUID }, './llm-resolver.js': {}, './llm.js': {}, './agents/cost.js': cost,
    './agents/llm-ledger.js': { ...recorder, classifyLlmCallError: () => 'failed' }, './agents/fallback.js': fallback, './settings.js': {},
  })
  const context = { companyId: 'company-a', purpose: 'agent-turn' }
  const candidate = (model: string) => ({ model, requestModel: model, available: true, protocol: 'responses', route: { id: 'gateway:openai', kind: 'gateway', platform: 'openai' } })
  const execute = (prepare: any, models = ['priced-model']) => execution.executeLlmPlan({
    plan: { ...context, role: 'brain', revision: '1', candidates: models.map(candidate) }, context, prepare, log: () => {},
  })
  return { pricing, cost, recorder, rows, calls, ledger, warnings, execute, setSelect: (fn?: () => Promise<any>) => { select = fn } }
}

test('exact route/model, explicit aliases and compatibility estimates never substring-match', async () => {
  const f = fixture({ 'priced-model': priceInput('priced-model', 7), broken: { inPer1M: -1 } })
  await f.pricing.refreshModelPricing(true)
  assert.equal(f.cost.priceFor('priced-model').inPer1M, 7)
  for (const id of ['priced', 'priced-model-plus', 'x-priced-model', 'gpt-5.5-mini', 'claude-haiku-new', 'haik', 'toString']) {
    const price = f.cost.priceFor(id)
    assert.equal(price.match, 'fallback', id)
    assert.equal(price.verified, false)
  }
  assert.equal(f.cost.priceFor('haiku').match, 'alias')
  assert.equal(f.cost.priceFor('haiku').inPer1M, 1)
  await f.pricing.upsertModelPricing(priceInput('priced-model', 11))
  await f.pricing.upsertModelPricing(priceInput('gateway:openai/priced-model', 13))
  assert.equal(f.cost.priceFor('priced-model').inPer1M, 11)
  assert.equal(f.cost.priceFor('priced-model', 'gateway:openai').inPer1M, 13)
  assert.equal(f.cost.priceFor('priced-model', 'direct:openai').inPer1M, 11)
})

test('legacy env imports once, preserves existing DB prices and survives restart after admin edit', async () => {
  const f = fixture({ 'priced-model': priceInput('priced-model', 7) })
  f.rows.set('priced-model', { model: 'priced-model', input_per_1m: 1, cached_input_per_1m: 0, cache_write_per_1m: 0,
    output_per_1m: 1, note: 'original note', source_url: null, priced_at: null, updated_at: '2026-09-09T00:00:00Z' })
  f.rows.set('gpt-5.5', { ...f.rows.get('priced-model'), model: 'gpt-5.5', input_per_1m: 123 })
  await f.pricing.seedModelPricing()
  assert.equal(f.cost.priceFor('priced-model').inPer1M, 7)
  assert.equal(f.cost.priceFor('priced-model').source, 'env')
  assert.equal(f.cost.priceFor('gpt-5.5').inPer1M, 123)
  assert.equal((await f.pricing.modelPricingTable()).find((r: any) => r.model === 'priced-model').note, 'original note')
  await f.pricing.upsertModelPricing(priceInput('priced-model', 19))
  await f.pricing.seedModelPricing()
  assert.equal(f.cost.priceFor('priced-model').inPer1M, 19)
  assert.equal(f.cost.priceFor('priced-model').source, 'database')
  const restart = fixture({ 'priced-model': priceInput('priced-model', 7) })
  for (const [key, row] of f.rows) restart.rows.set(key, structuredClone(row))
  await restart.pricing.seedModelPricing()
  assert.equal(restart.cost.priceFor('priced-model').inPer1M, 19)
  assert.equal(restart.cost.priceFor('priced-model').version, f.cost.priceFor('priced-model').version)
})

test('in-flight edit affects the next call only, including returned model and route pricing', async () => {
  const f = fixture()
  await f.pricing.refreshModelPricing(true)
  await f.pricing.upsertModelPricing(priceInput('gateway:openai/actual-model', 2))
  await f.execute(async (_candidate: any, state: any) => async () => {
    await f.pricing.upsertModelPricing(priceInput('gateway:openai/actual-model', 9))
    state.actualModel = 'actual-model'; state.usage = usage
    return 'ok'
  })
  assert.equal(f.ledger.length, 1)
  assert.equal(f.ledger[0][13], 2)
  const first = structuredClone(f.ledger[0])
  const meta = JSON.parse(first[19])
  assert.equal(meta.pricing.source, 'database')
  assert.equal(meta.pricing.sourceUrl, 'https://provider.invalid/pricing')
  assert.equal(meta.pricing.pricedAt, '2026-09-10')
  assert.equal(meta.pricing.inPer1M, 2)
  assert.equal(meta.pricing.match, 'route')
  assert.ok(meta.pricing.version)
  await f.execute(async (_candidate: any, state: any) => async () => { state.actualModel = 'actual-model'; state.usage = usage; return 'ok' })
  assert.equal(f.ledger[1][13], 9)
  assert.notEqual(JSON.parse(f.ledger[1][19]).pricing.version, meta.pricing.version)
  assert.deepEqual(f.ledger[0], first)
  assert.ok(f.calls.every(c => !/UPDATE llm_calls|DELETE/i.test(c.sql)))
})

test('failed attempt freezes its price; fallback is a new attempt with the edited price', async () => {
  const f = fixture()
  await f.pricing.upsertModelPricing(priceInput())
  let sends = 0
  await f.execute(async (_candidate: any, state: any) => async () => {
    state.usage = usage
    if (++sends === 1) {
      await f.pricing.upsertModelPricing(priceInput('priced-model', 8))
      throw Object.assign(new Error('retry'), { status: 401 })
    }
    return 'ok'
  }, ['priced-model', 'priced-model'])
  assert.deepEqual(f.ledger.map(r => r[13]), [2, 8])
  assert.deepEqual(f.ledger.map(r => r[17]), ['failed', 'ok'])
})

test('unknown/invalid usage and media are unpriced; measured zero remains distinguishable', async () => {
  const f = fixture({ 'priced-model': priceInput('priced-model', 2) })
  await f.pricing.refreshModelPricing(true)
  const base = { companyId: 'company-a', purpose: 'agent-turn', model: 'priced-model', latencyMs: 1, status: 'ok' }
  for (const extra of [
    { usage: null }, { usage: { ...usage, outputTokens: NaN } },
  ]) {
    await f.recorder.recordLlmCall({ ...base, ...extra })
    const row = f.ledger.at(-1)
    assert.equal(row[13], 0); assert.equal(row[14], true); assert.equal(row[15], false)
    assert.ok(JSON.parse(row[19]).unpriced)
  }
  // Unpriced media/unknown-unit calls with VALID usage: usage is measured
  // (measured=true), cost stays 0 and flagged estimated+unpriced.
  for (const extra of [
    { usage, purpose: 'agent-image' }, { usage, purpose: 'avatar-image' },
    { usage, purpose: 'audio-transcription' }, { usage, extras: { unpriced: 'provider-unit-unknown' } },
  ]) {
    await f.recorder.recordLlmCall({ ...base, ...extra })
    const row = f.ledger.at(-1)
    assert.equal(row[13], 0); assert.equal(row[14], true); assert.equal(row[15], true)
    assert.ok(JSON.parse(row[19]).unpriced)
  }
  await f.recorder.recordLlmCall({ ...base, usage: { ...usage, inputTokens: 0 } })
  const zero = f.ledger.at(-1)
  assert.equal(zero[13], 0); assert.equal(zero[14], false); assert.equal(zero[15], true)
  assert.equal(JSON.parse(zero[19]).unpriced, undefined)
})

test('old refresh cannot overwrite a successful edit; failures retain the installed snapshot', async () => {
  const f = fixture()
  await f.pricing.upsertModelPricing(priceInput())
  const oldRows = [...f.rows.values()].map(r => ({ ...r }))
  let finish!: (value: any) => void
  f.setSelect(() => new Promise(resolve => { finish = resolve }))
  const refresh = f.pricing.refreshModelPricing(true)
  await f.pricing.upsertModelPricing(priceInput('priced-model', 15))
  finish({ rows: oldRows }); await refresh
  assert.equal(f.cost.priceFor('priced-model').inPer1M, 15)
  f.setSelect(async () => { throw new Error('fake DB failure') })
  await f.pricing.refreshModelPricing(true)
  assert.equal(f.cost.priceFor('priced-model').inPer1M, 15)
  assert.ok(f.warnings.length)
})

test('PUT /usage/pricing rejects invalid URL, calendar date and numbers with 400 before DB access', async () => {
  const f = fixture()
  const source = read('../api/router.ts')
  const start = source.indexOf("api.put('/usage/pricing'")
  const end = source.indexOf('\n}))', start) + 4
  let handler: any
  class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }
  compile(source.slice(start, end), {}, {
    api: { put: (_path: string, fn: any) => { handler = fn } }, safe: (fn: any) => fn,
    requireSiteAdmin: async (req: any) => { if (!req.admin) throw new HttpError(403, 'admin required') }, HttpError,
    validateModelPricing: f.pricing.validateModelPricing, upsertModelPricing: f.pricing.upsertModelPricing,
  })
  for (const invalid of [
    { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: 'file:///secret' }, { sourceUrl: 'ftp://provider.invalid' },
    { sourceUrl: '/relative' }, { sourceUrl: 123 }, { pricedAt: '2026-02-30' }, { pricedAt: '2025-02-29' },
    { pricedAt: 'invalid' }, { pricedAt: '2026-9-1' }, { pricedAt: '2026-09-10T00:00:00Z' },
    { inPer1M: -1 }, { inPer1M: Infinity }, { inPer1M: NaN }, { inPer1M: true }, { inPer1M: '2' }, { inPer1M: null },
  ]) {
    await assert.rejects(handler({ admin: true, body: { ...priceInput(), ...invalid } }, {}), (e: any) => e.status === 400)
    assert.equal(f.calls.length, 0)
  }
  await assert.rejects(handler({ body: priceInput() }, {}), (e: any) => e.status === 403)
  assert.equal(f.calls.length, 0)
  let response: any
  await handler({ admin: true, body: { ...priceInput(), sourceUrl: 'http://provider.invalid/pricing', pricedAt: '2024-02-29' } }, { json: (value: any) => { response = value } })
  assert.deepEqual(response, { ok: true })
  assert.equal(f.rows.get('priced-model').priced_at, '2024-02-29')
})

test('legacy sparse numeric env rates stay effective; invalid numbers are ignored', async () => {
  const f = fixture({ sparse: { inPer1M: '6', outPer1M: 3 }, invalid: { inPer1M: -1 }, boolean: { inPer1M: true } })
  await f.pricing.seedModelPricing()
  assert.equal(f.cost.priceFor('sparse').inPer1M, 6)
  assert.equal(f.cost.priceFor('sparse').cachedInPer1M, 0)
  assert.equal(f.cost.priceFor('invalid').match, 'fallback')
  assert.equal(f.cost.priceFor('boolean').match, 'fallback')
})

test('pricing menu exposes the same effective source, version and rates as accounting', async () => {
  const f = fixture({ 'priced-model': priceInput('priced-model', 7) })
  await f.pricing.seedModelPricing()
  await f.pricing.upsertModelPricing({ ...priceInput('priced-model', 11), note: 'contract reference' })
  const menu = await f.pricing.modelPricingTable()
  const row = menu.find((r: any) => r.model === 'priced-model')
  assert.equal(row.inPer1M, 11)
  assert.equal(row.source, 'database')
  assert.equal(row.version, f.cost.priceFor('priced-model').version)
  assert.equal(row.note, 'contract reference')
  assert.doesNotMatch(JSON.stringify(menu), /cumora-pricing:v1/)
  const legacy = menu.find((r: any) => r.model === 'gpt-5.5')
  assert.equal(legacy.source, 'legacy')
  assert.equal(legacy.verified, false)
  assert.match(legacy.note, /兼容估算/)
})

test('first call waits for DB prices rather than freezing the cold env fallback', async () => {
  const f = fixture({ 'priced-model': priceInput('priced-model', 7) })
  f.rows.set('priced-model', { model: 'priced-model', input_per_1m: 23, cached_input_per_1m: 0,
    cache_write_per_1m: 0, output_per_1m: 0, note: '[cumora-pricing:v1:admin]', source_url: null,
    priced_at: null, updated_at: '2026-09-10T00:00:00Z' })
  await f.execute(async (_candidate: any, state: any) => async () => { state.usage = usage; return 'ok' })
  assert.equal(f.ledger[0][13], 23)
  assert.equal(JSON.parse(f.ledger[0][19]).pricing.source, 'database')
})

test('cold upsert and concurrent refresh retain successful admin prices', async () => {
  const f = fixture()
  let finish!: (value: any) => void
  f.setSelect(() => new Promise(resolve => { finish = resolve }))
  const refresh = f.pricing.refreshModelPricing()
  assert.equal(f.pricing.captureDbPricing()('missing'), null)
  await f.pricing.upsertModelPricing(priceInput('cold-edit', 12))
  assert.equal(f.pricing.captureDbPricing()('cold-edit').inPer1M, 12)
  finish({rows:[]})
  await refresh
  assert.equal(f.pricing.captureDbPricing()('cold-edit').inPer1M, 12)
})
test('refresh failures are throttled even without a snapshot; forced refresh can recover', async () => {
  const f = fixture()
  let selects = 0
  f.setSelect(async () => { selects++; throw new Error('starting') })
  await f.pricing.refreshModelPricing()
  for (let i = 0; i < 3; i++) {
    await f.pricing.refreshModelPricing()
    assert.equal(f.pricing.captureDbPricing()('missing'), null)
  }
  assert.equal(selects, 1)
  f.setSelect(undefined)
  await f.pricing.upsertModelPricing(priceInput())
  await f.pricing.refreshModelPricing(true)
  assert.equal(f.pricing.captureDbPricing()('priced-model').inPer1M, 2)
})
