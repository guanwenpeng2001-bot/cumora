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
  const environment = { CUMORA_MODEL_PRICES_JSON: JSON.stringify(env) }
  let parses = 0
  const pricing: Record<string, any> = {}
  const cost = compile(read('../agents/cost.ts'), { './token-usage.js': compile(read('../agents/token-usage.ts'), {}), '../model-pricing.js': pricing, 'node:crypto': { createHash } },
    { process: { env: environment }, JSON: { stringify: JSON.stringify, parse: (value: string) => { parses++; return JSON.parse(value) } }, console: { warn: (...args: any[]) => warnings.push(args) } })
  Object.assign(pricing, compile(read('../model-pricing.ts'), { './db/pool.js': { pool }, './agents/cost.js': cost },
    { console: { warn: (...args: any[]) => warnings.push(args) } }))
  const ledgerSource = read('../agents/llm-ledger.ts')
  const recorder = compile(ledgerSource.slice(0, ledgerSource.indexOf('/** Classify a thrown')), {
    'node:crypto': { randomUUID }, '../db/pool.js': { pool }, '../llm.js': {}, '../llm-execution.js': {}, './cost.js': cost,
  })
  const fallback = compile(read('../agents/fallback.ts'), { '../settings.js': {} })
  const execution = compile(read('../llm-execution.ts'), {
    './tenant-llm-context.js': { validateRoleCallAuth: async (plan: any) => { assert.equal(plan.authorizationVersion, undefined) } },
    './db/pool.js': { pool: { query: async () => { throw new Error('Unexpected executor DB access') } } },
    'node:crypto': { randomUUID }, './llm-resolver.js': {},
    './llm.js': { getLlmCandidateClient: async () => ({}) }, './agents/cost.js': cost,
    './agents/llm-ledger.js': { ...recorder, classifyLlmCallError: () => 'failed' }, './agents/fallback.js': fallback, './settings.js': {},
  })
  const context = { companyId: 'company-a', purpose: 'agent-turn' }
  const candidate = (model: string) => ({ model, requestModel: model, available: true, protocol: 'responses', route: { id: 'gateway:openai', kind: 'gateway', platform: 'openai' } })
  const execute = (prepare: any, models = ['priced-model']) => execution.executeLlmPlan({
    plan: { ...context, role: 'brain', revision: '1', candidates: models.map(candidate) }, context, prepare, log: () => {},
  })
  return { environment, parses: () => parses, pricing, cost, recorder, rows, calls, ledger, warnings, execute, setSelect: (fn?: () => Promise<any>) => { select = fn } }
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

test('failed attempt and fallback share the frozen price for one logical call', async () => {
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
  assert.deepEqual(f.ledger.map(r => r[13]), [2, 2])
  assert.deepEqual(f.ledger.map(r => r[17]), ['failed', 'ok'])
  await f.execute(async (_candidate: any, state: any) => async () => { state.usage = usage; return 'ok' }, ['priced-model'])
  assert.equal(f.ledger[2][13], 8)
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
  assert.match(legacy.note, /官方刊例参考，按备注档位估算/)
})

test('first call freezes seed prices without waiting for DB; refresh applies to the next call', async () => {
  const f = fixture({ 'priced-model': priceInput('priced-model', 7) })
  f.rows.set('priced-model', { model: 'priced-model', input_per_1m: 23, cached_input_per_1m: 0,
    cache_write_per_1m: 0, output_per_1m: 0, note: '[cumora-pricing:v1:admin]', source_url: null,
    priced_at: null, updated_at: '2026-09-10T00:00:00Z' })
  let finish!: (value: any) => void
  f.setSelect(() => new Promise(resolve => { finish = resolve }))
  const started = Date.now()
  await f.execute(async (_candidate: any, state: any) => async () => { state.usage = usage; return 'ok' })
  assert.ok(Date.now() - started < 200, 'pricing SELECT must not block the candidate send')
  assert.equal(f.ledger[0][13], 7)
  assert.equal(JSON.parse(f.ledger[0][19]).pricing.source, 'env')
  finish({ rows: [...f.rows.values()].map(r => ({ ...r })) })
  f.setSelect(undefined)
  await f.pricing.refreshModelPricing(true)
  await f.execute(async (_candidate: any, state: any) => async () => { state.usage = usage; return 'ok' })
  assert.equal(f.ledger[1][13], 23)
  assert.equal(JSON.parse(f.ledger[1][19]).pricing.source, 'database')
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

test('unknown models remain measured but never bill compatibility fallback rates', async () => {
  const f = fixture()
  await f.pricing.refreshModelPricing(true)
  const base = { companyId: 'company-a', purpose: 'agent-turn', model: 'unknown-model', usage, latencyMs: 1, status: 'ok' }
  const frozen = f.cost.capturePricing()('unknown-model')
  assert.equal(frozen.unpriced, 'no-price')
  assert.equal(f.cost.effectiveCostUsd('unknown-model', usage).usd, 0)
  for (const pricing of [undefined, frozen, { ...frozen, inPer1M: 3, outPer1M: 15, unpriced: undefined }]) {
    await f.recorder.recordLlmCall({ ...base, pricing })
    const row = f.ledger.at(-1)
    assert.equal(row[13], 0)
    assert.equal(row[15], true)
    assert.equal(row[8], usage.inputTokens)
    assert.equal(JSON.parse(row[19]).unpriced, 'no-price')
  }
  await f.execute(async (_candidate: any, state: any) => async () => { state.usage = usage; return 'ok' }, ['unknown-model'])
  assert.equal(f.ledger.at(-1)[13], 0)
  assert.equal(JSON.parse(f.ledger.at(-1)[19]).unpriced, 'no-price')
})

test('env pricing parses once per change and captured calls retain the old immutable map', async () => {
  const f = fixture({ 'env-only': priceInput('env-only', 3) })
  await f.pricing.refreshModelPricing(true)
  const frozen = f.cost.capturePricing()
  const initial = f.parses()
  for (let i = 0; i < 100; i++) assert.equal(f.cost.priceFor('env-only').inPer1M, 3)
  assert.equal(f.parses(), initial)
  assert.ok(Object.isFrozen(f.cost.legacyEnvPrices()))
  assert.ok(Object.isFrozen(f.cost.legacyEnvPrices()['env-only']))
  f.environment.CUMORA_MODEL_PRICES_JSON = JSON.stringify({ 'env-only': priceInput('env-only', 9) })
  await f.pricing.refreshModelPricing(true)
  assert.equal(f.cost.priceFor('env-only').inPer1M, 9)
  assert.equal(frozen('env-only').inPer1M, 3)
  assert.equal(f.parses(), initial + 1)
  f.environment.CUMORA_MODEL_PRICES_JSON = '{broken'
  for (let i = 0; i < 10; i++) assert.equal(f.cost.priceFor('env-only').unpriced, 'no-price')
  assert.equal(f.parses(), initial + 2)
  assert.equal(f.warnings.length, 1)
  f.environment.CUMORA_MODEL_PRICES_JSON = '{}'
  assert.equal(f.cost.priceFor('env-only').unpriced, 'no-price')
  assert.equal(f.parses(), initial + 3)
})


test('BYOA resolved GPT model reaches ledger seed pricing as estimated cost', async () => {
  const f = fixture()
  await f.pricing.refreshModelPricing(true)
  for (const model of ['gpt-5.5', 'unlisted-local-model']) {
    await f.recorder.recordLlmCall({ companyId: 'company-a', purpose: 'agent-turn',
      source: 'byoa-codex', model, usage, latencyMs: 10, status: 'ok', extras: { route: 'byoa:codex' } })
    const row = f.ledger.at(-1)
    assert.equal(row[14], true, 'seed prices and missing prices are always estimates')
    assert.equal(row[15], true, 'CLI token counts remain measured')
    const extras = JSON.parse(row[19])
    assert.equal(extras.route, 'byoa:codex')
    assert.equal(extras.platform, undefined)
    if (model === 'gpt-5.5') {
      assert.equal(row[13], 5)
      assert.equal(extras.unpriced, undefined)
    } else {
      assert.equal(row[13], 0)
      assert.equal(extras.unpriced, 'no-price')
    }
  }
})


test('official seeds cover configured token families with dated provenance and correct cache tiers', async () => {
  const f = fixture()
  await f.pricing.refreshModelPricing(true)
  const expected: Array<[string, number, number, number, number]> = [
    ['gpt-6-astra', 10, 1, 12.5, 50], ['gpt-5.5', 5, 0.5, 5, 30],
    ['gpt-5.4-mini', 0.75, 0.075, 0.75, 4.5], ['deepseek-flash', 0.3, 0.006, 0.3, 1.2],
    ['deepseek-v4-flash', 0.3, 0.006, 0.3, 1.2], ['deepseek-v4-pro', 1.32, 0.044, 1.32, 3.96],
    ['gemini-3.8-flash', 0.75, 0.075, 0.75, 3.75], ['grok-4.6', 2, 0.5, 2, 6],
    ['MiniMax-M2.7', 0.3, 0.06, 0.375, 1.2], ['MiniMax-M2.7-highspeed', 0.6, 0.06, 0.375, 2.4],
    ['GLM-5.3', 1.4, 0.26, 0, 4.4], ['claude-sonnet-5', 2, 0.2, 2.5, 10],
    ['qwen-max', 0.345, 0.345, 0.345, 1.377], ['text-embedding-v4', 0.072, 0, 0, 0],
    ['text-embedding-3-small', 0.02, 0, 0, 0],
    ['qwen3-coder-plus', 0.574, 0.0574, 0.7175, 2.294],
    ['qwen3-coder-flash', 0.144, 0.0144, 0.18, 0.574],
  ]
  for (const [model, ...rates] of expected) {
    const p = f.cost.priceFor(model)
    assert.deepEqual([p.inPer1M, p.cachedInPer1M, p.cacheWritePer1M, p.outPer1M], rates, model)
    assert.equal(p.pricedAt, '2026-09-11', model)
    assert.match(p.sourceUrl, /^https:\/\//, model)
    assert.equal(p.verified, false, model)
    assert.equal(p.unpriced, undefined, model)
  }
  assert.equal(f.cost.effectiveCostUsd('deepseek-flash', usage).usd, 0.3)
  assert.equal(f.cost.effectiveCostUsd('deepseek-flash', { ...usage, inputTokens: 0, cachedInputTokens: 1_000_000 }).usd, 0.006)
  const free = f.cost.priceFor('glm-4.7-flash')
  assert.equal(free.inPer1M + free.outPer1M, 0)
  assert.equal(free.unpriced, undefined, 'officially free is distinct from missing pricing')
})

test('provider prefixes and explicit snapshots resolve without pricing unknown family variants', async () => {
  const f = fixture()
  await f.pricing.refreshModelPricing(true)
  for (const [model, canonical] of [
    ['orcarouter/deepseek-v4-flash', 'deepseek-v4-flash'],
    ['novita/deepseek-v4-flash-vision-exp', 'deepseek-v4-flash-vision-exp'],
    ['openai/gpt-6-astra', 'gpt-6-astra'], ['openai/gpt-5.5-2026-04-23', 'gpt-5.5'],
    ['anthropic/claude-opus-4-1-20250805', 'claude-opus-4-1'],
    ['claude-opus-4-6-thinking', 'claude-opus'],
    ['google/gemini-3.8-flash-high', 'gemini-3.8-flash'],
    ['zhipu/GLM-5.3', 'glm-5.3'], ['minimax/MiniMax-M2.7-highspeed', 'minimax-m2.7-highspeed'],
    ['dashscope/qwen3-asr-flash-2025-09-08', 'qwen3-asr-flash'],
    ['fun-asr-2025-11-07', 'fun-asr'], ['qwen/z-image-turbo', 'z-image-turbo'],
    ['qwen-image-2.0-pro-2026-04-22', 'qwen-image-2.0-pro'],
  ]) {
    const p = f.cost.priceFor(model)
    assert.equal(p.match, 'alias', model)
    assert.equal(p.matchedModel, canonical, model)
    assert.equal(p.verified, false, model)
    assert.equal(p.inPer1M, f.cost.priceFor(canonical).inPer1M, model)
    assert.equal(p.note, f.cost.priceFor(canonical).note, model)
  }
  for (const model of ['gpt-6-secret', 'gpt-6-astra-pro', 'qwen3-asr-flash-unknown', 'fun-asr-premium',
    'z-image-ultra', 'z-image-turbo-premium', 'glm-5.3-unpublished', 'MiniMax-M2.7-unknown',
    'gemini-3.8-flash-unknown', 'unknown/gpt-6-astra', 'x-gpt-6-astra', 'openai/toString',
    'k3', 'k3-256k', 'kimi-for-coding', 'codex', 'antigravity', 'chatgpt-web/extra-high']) {
    assert.equal(f.cost.priceFor(model).unpriced, 'no-price', model)
  }
  await f.pricing.upsertModelPricing(priceInput('openai/gpt-6-astra', 17))
  await f.pricing.upsertModelPricing(priceInput('direct:openai/openai/gpt-6-astra', 19))
  assert.equal(f.cost.priceFor('openai/gpt-6-astra').inPer1M, 17)
  assert.equal(f.cost.priceFor('openai/gpt-6-astra', 'direct:openai').inPer1M, 19)
})

test('native media prices survive seeding as notes, never as invented token rates', async () => {
  const f = fixture()
  await f.pricing.refreshModelPricing(true)
  const media = ['qwen3-asr-flash', 'qwen3-asr-flash-filetrans', 'qwen3-asr-flash-realtime',
    'fun-asr', 'fun-asr-mtl', 'fun-asr-realtime', 'whisper-1', 'z-image-turbo',
    'qwen-image', 'qwen-image-plus', 'qwen-image-max', 'qwen-image-2.0', 'qwen-image-2.0-pro',
    'wan2.6-image', 'wan2.7-image', 'wan2.7-image-pro', 'gpt-image-2']
  const cold = new Map(media.map(model => [model, f.cost.priceFor(model)]))
  await f.pricing.seedModelPricing()
  const table = await f.pricing.modelPricingTable()
  for (const model of media) {
    const p = f.cost.priceFor(model)
    assert.equal(p.unpriced, cold.get(model).unpriced, model)
    assert.equal(p.note, cold.get(model).note, model)
    assert.equal(p.inPer1M + p.outPer1M + p.cachedInPer1M + p.cacheWritePer1M, 0, model)
    assert.match(table.find((r: any) => r.model === model).note, /\[unit:/, model)
    assert.match(p.note, /USD/, model)
    assert.equal(p.pricedAt, '2026-09-11', model)
    await f.recorder.recordLlmCall({ companyId: 'company-a', purpose: 'agent-turn', model, usage,
      latencyMs: 10, status: 'ok' })
    const row = f.ledger.at(-1)
    assert.equal(row[13], 0, 'token counts cannot stand in for seconds or images')
    assert.ok(JSON.parse(row[19]).unpriced, model)
  }
  for (const seed of f.pricing.modelPricingSeeds()) {
    const stored = f.rows.get(seed.model)
    assert.equal(stored.source_url, seed.sourceUrl, seed.model)
    assert.equal(stored.priced_at, seed.pricedAt, seed.model)
    assert.equal(stored.input_per_1m, seed.inPer1M, seed.model)
    assert.equal(stored.output_per_1m, seed.outPer1M, seed.model)
  }
  const seeds = f.pricing.modelPricingSeeds()
  seeds[0].inPer1M = 999
  assert.equal(f.pricing.seedPriceFor('gpt-6-astra').inPer1M, 10)
})


test('media unit quantities price frozen official rates and preserve source per hop', async () => {
  const f = fixture()
  await f.pricing.seedModelPricing()
  for (const [model, purpose, unit, quantity, rate] of [
    ['qwen3-asr-flash', 'audio-transcription', 'second', 12.5, 0.000032],
    ['whisper-1', 'audio-transcription', 'second', 60, 0.0001],
    ['qwen-image-max', 'agent-image', 'image', 3, 0.071677],
  ] as const) {
    await f.recorder.recordLlmCall({ companyId: 'a', model, purpose, units: { unit, quantity }, status: 'ok', latencyMs: 1 })
    const row = f.ledger.at(-1), extras = JSON.parse(row[19])
    assert.equal(row[13], quantity * rate)
    assert.equal(row[14], true)
    assert.equal(row[15], true)
    assert.deepEqual(extras.units, { unit, quantity })
    assert.equal(extras.pricing.usdPerUnit, rate)
    assert.ok(extras.pricing.sourceUrl.startsWith('https://'))
    assert.equal(extras.pricing.pricedAt, '2026-09-11')
    assert.equal(extras.unpriced, undefined)
  }
})

test('media never substitutes requested counts, tokens, latency or invalid units for measurement', async () => {
  const f = fixture()
  for (const units of [undefined, { unit: 'image', quantity: -1 }, { unit: 'image', quantity: 1.5 },
    { unit: 'image', quantity: Infinity }, { unit: 'second', quantity: 3 }]) {
    await f.recorder.recordLlmCall({ companyId: 'a', model: 'qwen-image-max', purpose: 'agent-image',
      units, usage, extras: { n: 2 }, status: 'failed', latencyMs: 1000 })
    assert.equal(f.ledger.at(-1)[13], 0)
    assert.ok(JSON.parse(f.ledger.at(-1)[19]).unpriced)
  }
  for (const model of ['gpt-image-2', 'z-image-turbo', 'unknown-image']) {
    await f.recorder.recordLlmCall({ companyId: 'a', model, purpose: 'agent-image',
      units: { unit: 'image', quantity: 1 }, status: 'ok', latencyMs: 1 })
    assert.equal(f.ledger.at(-1)[13], 0)
    assert.ok(JSON.parse(f.ledger.at(-1)[19]).unpriced)
  }
  const pricing = f.cost.priceFor('qwen-image-max')
  await f.pricing.upsertModelPricing(priceInput('qwen-image-max', 99))
  await f.recorder.recordLlmCall({ companyId: 'a', model: 'qwen-image-max', pricing, purpose: 'agent-image',
    units: { unit: 'image', quantity: 2 }, status: 'failed', latencyMs: 1 })
  assert.equal(f.ledger.at(-1)[13], 2 * 0.071677, 'completed generation remains billable after delivery failure')
  await f.recorder.recordLlmCall({ companyId: 'a', model: 'qwen-image-max', purpose: 'agent-image',
    units: { unit: 'image', quantity: 2 }, status: 'ok', latencyMs: 1 })
  assert.ok(JSON.parse(f.ledger.at(-1)[19]).unpriced, 'admin token override is never reinterpreted as a unit price')
})
