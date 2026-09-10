import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import ts from 'typescript'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
function compile(source: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', 'require', ...Object.keys(globals), output)(exports, (name: string) => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`)
    return dependencies[name]
  }, ...Object.values(globals))
  return exports
}
function fixture(statuses: (number | Error)[] = [], gateway = false, content: unknown = '  你好，这是中文转写。  ') {
  const records: any[] = [], requests: any[] = [], logs: any[] = [], tenants: string[] = []
  const settings = { getServerSettingsSnapshot: () => ({ revision: '20', settings: { audio_model: 'asr-primary', audio_fallback_models: 'asr-backup', llm_config: '' }, sources: {} }),
    parseLlmConfig: () => ({ roles: [], models: [], routes: [] }), LLM_ROLES: ['audio'],
    readLlmModelTarget: (model) => ({ requestModel: model, route: undefined, protocol: undefined, metadata: undefined }) }
  const resolver = compile(read('../llm-resolver.ts'), {
    './settings.js': settings, './env.js': { resolveDirectLlmEnv: () => ({ configured: !gateway, protocol: 'chat' }) },
    './tenant-llm-context.js': { resolveTenantLlmContext: async (company: string) => { tenants.push(company); return { keys: { openai: 'owner-key' }, baseURL: 'https://gateway.invalid', authorizationVersion: 'owner-v1' } },
      tenantModelSnapshot: async () => ({ authorizationVersion: 'owner-v1', platforms: { openai: { ok: true, models: ['asr-primary', 'asr-backup'] } } }) },
    './sub2api.js': { sub2apiRoutingConfigured: () => gateway, sub2apiConfigured: () => gateway, SUB2API_PLATFORMS: ['openai'], pickPlatformForModel: () => 'openai' },
    './agents/model-config.js': { REASONING_EFFORTS: new Set(['none']) },
  })
  const fallback = compile(read('../agents/fallback.ts'), { '../settings.js': {} })
  const cost = compile(read('../agents/cost.ts'), { './token-usage.js': compile(read('../agents/token-usage.ts'), {}), '../model-pricing.js': { captureDbPricing: () => () => null, refreshModelPricing: async () => {} }, 'node:crypto': { createHash } })
  const getLlmCandidateClient = async (plan: any, candidate: any) => ({ post: async (path: string, options: any) => {
    requests.push({ path, options, company: plan.companyId, route: candidate.route })
    const status = statuses[requests.length - 1]
    if (status instanceof Error) throw status
    if (status) throw Object.assign(new Error('SECRET_AUDIO_AND_TRANSCRIPT'), { status })
    return { model: 'actual-asr', choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 8, secret: 'SECRET_AUDIO_AND_TRANSCRIPT' } }
  } })
  const execution = compile(read('../llm-execution.ts'), {
    'node:crypto': { randomUUID }, './llm-resolver.js': resolver, './llm.js': { getLlmCandidateClient },
    './agents/fallback.js': fallback, './agents/cost.js': cost, './settings.js': settings,
    './agents/llm-ledger.js': { recordLlmCall: async (r: any) => records.push(r), classifyLlmCallError: (e: any) => e?.status === 429 ? 'rate_limited' : 'failed' },
  }, { console: { warn: (...args: any[]) => logs.push(args) } })
  const source = read('../llm.ts')
  const audio = compile(source.slice(source.indexOf('export const MAX_AUDIO_BYTES')), {
    './llm-resolver.js': resolver, './llm-execution.js': execution, './agents/cost.js': cost,
  }, { getLlmCandidateClient, fallbackReason: fallback.fallbackReason, isLlmCancellation: fallback.isLlmCancellation })
  return { audio, records, requests, logs, tenants }
}
function wav(size = 48) {
  const bytes = Buffer.alloc(size)
  bytes.write('RIFF'); bytes.writeUInt32LE(size - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(size - 44, 40)
  return bytes.toString('base64')
}

test('invalid JSON audio is rejected before resolver, upstream or ledger', async () => {
  const { audio, records, requests, tenants } = fixture([], true)
  const invalid: [unknown, unknown, number][] = [
    ['', 'wav', 400], [null, 'wav', 400], [12, 'wav', 400], [{}, 'wav', 400],
    ['!!!!', 'wav', 400], ['YQ==\n', 'wav', 400], ['YR==', 'wav', 400], ['YQ', 'wav', 400],
    ['data:audio/wav;base64,' + wav(), 'wav', 400], [wav(), 'exe', 400], [wav(), {}, 400],
    [wav(), 'webm', 400], [Buffer.from('not audio').toString('base64'), 'wav', 400],
    [wav(10 * 1024 * 1024 + 1), 'wav', 413], [wav(10 * 1024 * 1024 + 3), 'wav', 413],
  ]
  for (const [data, format, status] of invalid) await assert.rejects(audio.transcribeAudio(data, format, 'company-a'), (e: any) => e.status === status)
  assert.equal(requests.length, 0); assert.equal(records.length, 0); assert.equal(tenants.length, 0)
  assert.equal(audio.validateAudioInput(wav(10 * 1024 * 1024), 'wav').mime, 'audio/wav')
})
for (const gateway of [false, true]) {
  test(`Chinese transcription uses ${gateway ? 'gateway owner' : 'legacy audio env'} route and company ledger`, async () => {
    const f = fixture([], gateway)
    assert.equal(await f.audio.transcribeAudio(wav(), 'wav', 'company-a'), '你好，这是中文转写。')
    assert.equal(f.requests.length, 1); assert.equal(f.records.length, 1)
    assert.equal(f.requests[0].route.kind, gateway ? 'gateway' : 'direct')
    if (!gateway) assert.equal(f.requests[0].route.env, 'audio')
    assert.equal(f.requests[0].options.maxRetries, 0)
    assert.match(f.requests[0].options.body.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/)
    assert.equal(f.records[0].companyId, 'company-a'); assert.equal(f.records[0].purpose, 'audio-transcription')
    assert.equal(f.records[0].extras.role, 'audio'); assert.equal(f.records[0].model, 'actual-asr')
    assert.equal(f.records[0].usage.inputTokens, 12)
    assert.doesNotMatch(JSON.stringify(f.records), /你好|SECRET_AUDIO_AND_TRANSCRIPT|data:audio/)
  })
}
for (const status of [401, 403, 402, 429, 500, 503]) {
  test(`${status} falls back with exactly one ledger row per actual hop`, async () => {
    const f = fixture([status], true)
    await f.audio.transcribeAudio(wav(), 'wav', 'company-a')
    assert.equal(f.requests.length, 2); assert.equal(f.records.length, 2)
    assert.deepEqual(f.records.map(r => r.extras.attempt), [1, 2])
    assert.equal(f.records[0].extras.httpStatus, status); assert.equal(f.records[1].status, 'ok')
    assert.equal(f.records[0].extras.logicalCallId, f.records[1].extras.logicalCallId)
    assert.equal(f.records[0].usage, null)
    assert.doesNotMatch(JSON.stringify([f.records, f.logs]), /SECRET_AUDIO_AND_TRANSCRIPT|你好|data:audio/)
  })
}
test('exhaustion records two failures; 400 does not advance', async () => {
  for (const statuses of [[401, 403], [400]]) {
    const f = fixture(statuses)
    await assert.rejects(f.audio.transcribeAudio(wav(), 'wav'), /ASR request failed/)
    assert.equal(f.requests.length, statuses.length); assert.equal(f.records.length, statuses.length)
  }
})
for (const content of [null, {}, ['你好'], 42, '', '  ']) {
  test(`non-string or empty response stops without replay: ${JSON.stringify(content)}`, async () => {
    const f = fixture([], false, content)
    await assert.rejects(f.audio.transcribeAudio(wav(), 'wav'), /ASR request failed/)
    assert.equal(f.records.length, 1); assert.equal(f.requests.length, 1)
  })
}
test('API authorizes company before touching body, maps input errors and carries company', async () => {
  const source = read('../api/router.ts')
  const start = source.indexOf("api.post('/audio/transcription'")
  const block = source.slice(start, source.indexOf('\n}))', start) + 4)
  for (const denied of [401, 403, 0]) {
    let handler: any, calls = 0
    const f = fixture()
    class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
    compile(block, {}, { api: { post: (...args: any[]) => { handler = args.at(-1) } }, requireAuthBeforeLargeBody: () => {}, audioJsonParser: () => {}, safe: (fn: any) => fn,
      requireCompany: async () => { if (denied) throw new HttpError(denied, 'denied'); return { companyId: 'company-b' } }, HttpError, AudioInputError: f.audio.AudioInputError,
      transcribeAudio: async (...args: any[]) => { calls++; assert.equal(args[2], 'company-b'); return f.audio.transcribeAudio(...args) } })
    const req = denied ? { get body() { throw new Error('body read before authorization') } } : { body: { audio: 'bad!', format: 'wav' } }
    await assert.rejects(handler(req, { json: () => {} }), (e: any) => e instanceof HttpError && e.status === (denied || 400))
    assert.equal(calls, denied ? 0 : 1); assert.equal(f.requests.length, 0); assert.equal(f.records.length, 0)
  }
})

test('transport failures advance but cancellation and programming errors do not', async () => {
  for (const [error, expected] of [
    [Object.assign(new Error('private'), { cause: { code: 'ECONNRESET' } }), 2],
    [Object.assign(new Error('private'), { name: 'APIConnectionTimeoutError' }), 2],
    [Object.assign(new Error('private'), { name: 'AbortError' }), 1],
    [new TypeError('private'), 1],
  ] as const) {
    const f = fixture([error])
    if (expected === 2) await f.audio.transcribeAudio(wav(), 'wav')
    else await assert.rejects(f.audio.transcribeAudio(wav(), 'wav'))
    assert.equal(f.requests.length, expected); assert.equal(f.records.length, expected)
    assert.doesNotMatch(JSON.stringify([f.records, f.logs]), /private/)
  }
})
test('browser recording containers use canonical MIME and reject mismatches', () => {
  const { audio } = fixture()
  const webm = Buffer.alloc(64); webm.writeUInt32BE(0x1a45dfa3); webm.write('webm', 12)
  const ogg = Buffer.alloc(64); ogg.write('OggS')
  const mp4 = Buffer.alloc(64); mp4.writeUInt32BE(24); mp4.write('ftypM4A ', 4)
  for (const [bytes, format, mime] of [[webm, 'webm', 'audio/webm'], [ogg, 'ogg', 'audio/ogg'], [mp4, 'mp4', 'audio/mp4']] as const) {
    assert.equal(audio.validateAudioInput(bytes.toString('base64'), format).mime, mime)
    assert.throws(() => audio.validateAudioInput(bytes.toString('base64'), 'wav'))
  }
  assert.equal(audio.validateAudioInput(webm.toString('base64')).mime, 'audio/webm')
  assert.throws(() => audio.validateAudioInput(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString('base64'), 'webm'))
})
