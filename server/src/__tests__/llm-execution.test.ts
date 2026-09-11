import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import type { ImageFetchOptions } from '../agents/image-fetcher.js'

// Compile the real module graph; only external state is replaced. Unknown imports fail closed.
const nativeRequire = createRequire(import.meta.url)
let clientFactory: ((options: any) => any) | null = null
const RealOpenAI = nativeRequire('openai')
const FixtureOpenAI = new Proxy(RealOpenAI, {
  construct(target, args) { return clientFactory ? clientFactory(args[0]) : Reflect.construct(target, args) },
})
function setSdkClientFactory(factory: ((options: any) => any) | null) { clientFactory = factory }
const allowed = new Set([
  'llm-execution.ts', 'llm.ts', 'llm-resolver.ts', 'settings.ts', 'env.ts',
  'managed-pod-settings.ts', 'tenant-llm-context.ts', 'sub2api.ts', 'novita.ts',
  'model-pricing.ts', 'agents/llm-ledger.ts', 'agents/cost.ts', 'agents/token-usage.ts',
  'agents/agenda.ts', 'agents/inbox-triage.ts', 'agents/reasoning.ts', 'agents/triage-core.ts',
  'agents/fallback.ts', 'agents/model-config.ts', 'agents/embeddings.ts',
])
const root = new URL('../', import.meta.url)
const pool = {
  query: async (_sql: string, _values?: any[]): Promise<any> => { throw new Error('Unexpected SQL') },
  connect: async () => { throw new Error('Tests prohibit database connections') },
}
const isolatedProcess = { env: {
  NODE_ENV: 'test', OPENAI_API_KEY: 'fake-test-key', OPENAI_BASE_URL: 'https://llm.invalid/v1',
  OPENAI_MODEL: 'same', OPENAI_MODEL_SUPPORT: 'same', OPENAI_COMPACTION_MODEL: 'same',
  OPENAI_AUDIO_MODEL: 'fake-audio',
}, exit: () => { throw new Error('Unexpected process exit') } }
const compiled = new Map<string, string>()
let modules = new Map<string, any>()
let imageDownloads: { url: string; options: ImageFetchOptions }[] = []
function load(relative: string): any {
  // Execution tests replace durable storage with the existing captured SQL recorder.
  // The real start/final/replay transactions are exercised in ledger-v2 integration tests.
  if (relative === 'models/ledger.ts') return { recordRejectedDecision: async () => {},
    startAttempt: async (record: any) => ({ attempt_id: record.extras.attemptId }),
    finishAttempt: async (_identity: any, record: any) => load('agents/llm-ledger.ts').recordLlmCall(record),
  }
  if (relative === 'models/trace.ts') return { withCallTrace: async (_trace: any, send: any) => send(), tracedFetch: undefined }
  if (relative === 'redis.ts') return { redis: {} }
  if (relative === 'agents/runtime/inproc-client.ts') return { inprocClient: { peekWorklog: async () => [], humanRecentlyActive: async () => false } }
  if (relative === 'agents/observability.ts') return { recordTriage: async () => {} }
  if (relative === 'db/pool.ts') return { pool }
  if (relative === 'agents/image-fetcher.ts') return { fetchImageBytes: async (url: string, options: ImageFetchOptions) => {
    imageDownloads.push({ url, options })
    return { ok: true, buffer: Buffer.from('image-bytes') }
  } }
  assert.ok(allowed.has(relative), `Unexpected module: ${relative}`)
  if (modules.has(relative)) return modules.get(relative)
  const exports = {}
  modules.set(relative, exports)
  let output = compiled.get(relative)
  if (!output) {
    output = ts.transpileModule(readFileSync(new URL(relative, root), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText
    compiled.set(relative, output)
  }
  new Function('exports', 'require', 'process', output)(exports, (name: string) => {
    if (name === 'dotenv/config') return {}
    if (name === 'openai') return { __esModule: true, default: FixtureOpenAI }
    if (name === 'node:crypto' || name === 'node:async_hooks') return nativeRequire(name)
    assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`)
    const url = new URL(name.replace(/\.js$/, '.ts'), new URL(relative, root))
    return load(url.href.slice(root.href.length))
  }, isolatedProcess)
  return exports
}
let executeLlmPlan: any, getTrackedLlmClient: any, getLlmLedgerHealth: any, readStreamUsage: any
let getLlmClient: any, fallbackReason: any, isFallbackableError: any
let measuredUsage: any, refreshServerSettings: any
const originalFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = async () => { throw new Error('Tests prohibit network calls') }
  modules = new Map()
  imageDownloads = []
  ;({ executeLlmPlan } = load('llm-execution.ts'))
  ;({ getTrackedLlmClient, getLlmLedgerHealth, readStreamUsage } = load('agents/llm-ledger.ts'))
  ;({ getLlmClient } = load('llm.ts'))
  ;({ fallbackReason, isFallbackableError } = load('agents/fallback.ts'))
  ;({ measuredUsage } = load('agents/cost.ts'))
  ;({ refreshServerSettings } = load('settings.ts'))
})
afterEach(() => { globalThis.fetch = originalFetch })
let inserts: any[], sent: any[], settings: Record<string, string>, create: any, logs: any[]
const ctx = { companyId: null, purpose: 'palette' }
const httpError = (status: number) => Object.assign(new Error(`upstream ${status}`), { status })
const success = (model = 'actual') => ({ model, output_text: 'ok', usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } } })
const extras = (row: any[]) => JSON.parse(row[19])
const plan = (models = ['a','b','c']) => ({ companyId: null, domain: 'server', role: 'support', purpose: 'palette', revision: '42', routable: false, provisionable: false, diagnostics: [], candidates: models.map(model => ({ model, requestModel: model, route: { id: 'direct:text', kind: 'direct', env: 'text', endpointSource: 'test', credentialSource: 'test' }, protocol: 'responses', available: true, source: 'test', parameterSources: {}, parameters: {}, capabilities: {} })) })
const execute = (fn: (candidate: any, state: any) => any, other: Record<string, any> = {}) => executeLlmPlan({ plan: plan(), context: ctx, sdkMaxRetries: 0, log: (event: any) => logs.push(event), prepare: async (candidate: any, state: any) => async () => { sent.push(candidate.model); return fn(candidate, state) }, ...other })
beforeEach(async () => {
  inserts = []; sent = []; logs = []
  settings = { brain_model: 'same', support_model: 'same', compaction_model: 'same', brain_fallback_models: 'brain-backup', support_fallback_models: 'support-backup', compaction_fallback_models: 'compaction-backup' }
  pool.query = async (sql, values) => {
    if (sql === 'SELECT * FROM model_pricing') return { rows: [] }
    if (sql === 'SELECT key, value FROM server_settings') return { rows: Object.entries(settings).map(([key,value]) => ({key,value})) }
    assert.match(sql, /^INSERT INTO llm_calls/)
    inserts.push(values)
    return { rows: [] }
  }
  await refreshServerSettings(true)
  create = async () => success()
  setSdkClientFactory(() => ({ responses: { create: async (args: any, opts: any) => { sent.push({ api:'responses', args, opts }); return create(args,opts) } }, chat: { completions: { create: async (args: any,opts: any) => { sent.push({api:'chat',args,opts}); return create(args,opts) } } }, images: {generate: async () => ({data:[]})} }))
})
for (const status of [401,403,429]) test(`${status} -> success: two outbound calls and two SQL ledger rows`, async () => {
  create = async (args: any) => { if (args.model === 'same') throw httpError(status); return success() }
  const warnings: any[][] = []; const old = console.warn; console.warn = (...a) => warnings.push(a)
  try {
    const client = await getTrackedLlmClient(ctx)
    assert.equal((await client.responses.create({model:'same',input:'hello'}, {maxRetries:0})).model,'actual')
  } finally { console.warn = old }
  assert.deepEqual(sent.map(x=>x.args.model), ['same','support-backup'])
  assert.equal(inserts.length,2)
  assert.equal(inserts[0][15],false)
  assert.equal(inserts[1][15],true)
  assert.equal(inserts[1][7],'actual')
  const [a,b] = inserts.map(extras)
  assert.equal(a.logicalCallId,b.logicalCallId)
  assert.deepEqual([a.attempt,b.attempt],[1,2])
  assert.equal(a.nextCandidateReason,`upstream-http-${status}`)
  assert.equal(a.httpStatus,status)
  assert.equal(a.nextCandidate,'support-backup')
  const log = JSON.parse(warnings[0][1])
  assert.equal(log.logicalCallId,a.logicalCallId)
  assert.equal(log.nextCandidateReason,a.nextCandidateReason)
  assert.equal(a.sdkMaxRetries,0)
  assert.equal(a.sdkRetriesIndividuallyObservable,false)
})
test('three actual attempts create three rows, including last successful actual model', async () => {
  await execute(async (c,s) => { if(c.model !== 'c') throw httpError(502); s.actualModel='served'; s.usage=measuredUsage(success().usage,'responses'); return 'ok' })
  assert.equal(inserts.length,3)
  assert.deepEqual(sent,['a','b','c'])
  assert.equal(inserts[2][7],'served')
})
test('401 -> 403 exhaustion has exactly two rows and rethrows the final error', async () => {
  const final = httpError(403)
  await assert.rejects(execute(c => { throw c.model === 'a' ? httpError(401) : final }, {plan:plan(['a','b'])}), e=>e===final)
  assert.equal(inserts.length,2)
  assert.equal(extras(inserts[1]).stopReason,'exhausted')
  assert.equal(extras(inserts[1]).nextCandidate,null)
})
test('empty and entirely unavailable plans make no requests or rows', async () => {
  await assert.rejects(execute(()=>{}, {plan:plan([])}),/empty/)
  const unavailable = plan()
  unavailable.candidates.forEach(c => { c.available = false })
  await assert.rejects(execute(()=>{}, {plan:unavailable}), /no available/)
  assert.equal(inserts.length,0); assert.equal(sent.length,0)
})
test('unavailable first and middle candidates are skipped; nextCandidate is executable', async () => {
  const selected = plan(['skip-first', 'a', 'skip-middle', 'b'])
  selected.candidates[0].available = false
  selected.candidates[2].available = false
  assert.equal(await execute(c => { if (c.model === 'a') throw httpError(404); return 'ok' }, {plan:selected}), 'ok')
  assert.deepEqual(sent, ['a', 'b'])
  assert.equal(inserts.length, 2)
  assert.equal(extras(inserts[0]).nextCandidate, 'b')
})
test('prepare failures are recorded and advance without sending the failed candidate', async () => {
  assert.equal(await execute(()=>{}, {prepare:async (c: any) => {
    if (c.model !== 'c') throw new Error('candidate lacks tools or context budget')
    return async () => { sent.push(c.model); return 'ok' }
  }}), 'ok')
  assert.deepEqual(sent, ['c'])
  assert.equal(inserts.length, 3)
  assert.deepEqual(inserts.map(row => extras(row).attempt), [0, 0, 3])
  assert.equal(extras(inserts[0]).recordKind, 'decision')
  assert.equal(extras(inserts[0]).failureStage, 'prepare')
  assert.equal(extras(inserts[0]).failureReason, 'prepare-failed')
})
test('programming, local request and arbitrary no-status errors do not advance', async () => {
  for(const err of [new TypeError('bug'),new Error('oops'),new SyntaxError('JSON'),Object.assign(new Error('cancel'),{name:'APIUserAbortError'})]) {
    const count=inserts.length
    await assert.rejects(execute(()=>{throw err}),e=>e===err)
    assert.equal(inserts.length,count+1)
    assert.equal(extras(inserts.at(-1)).nextCandidate,null)
  }
})
test('a gateway 400 advances only the cloud cerebellum (support), other roles still stop', async () => {
  // Support role: candidate-specific 400 (model not schedulable in its group)
  // must degrade to the next candidate and record the reason.
  const count=inserts.length
  await assert.rejects(execute(()=>{throw httpError(400)}),e=>(e as {status?:number}).status===400)
  // Every candidate 400s here: the chain walks all three attempts instead of
  // stopping at the first.
  assert.equal(inserts.length,count+3)
  assert.equal(extras(inserts[count]).failureReason,'upstream-http-400')
  assert.equal(extras(inserts[count]).nextCandidate,'b')
  assert.equal(extras(inserts.at(-1)).nextCandidate,null)
  // Any other role keeps the non-fallbackable contract for 400.
  const before=inserts.length
  await assert.rejects(executeLlmPlan({ plan: { ...plan(), role: 'brain' }, context: ctx, sdkMaxRetries: 0, log: () => {}, prepare: async (candidate: any) => async () => { sent.push(candidate.model); throw httpError(400) } }))
  assert.equal(inserts.length,before+1)
  assert.equal(extras(inserts.at(-1)).nextCandidate,null)
})

test('recognized transport failures advance; unknown and cancelled failures do not', () => {
  for(const err of [new Error('ECONNRESET'),Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED'}}),Object.assign(new Error('connection'),{name:'APIConnectionError'})]) assert.ok(fallbackReason(err))
  for(const err of [undefined,null,{},new Error('network?'),new TypeError('oops'),new DOMException('aborted','AbortError'),httpError(600)]) assert.equal(isFallbackableError(err),false)
})
test('pre-aborted signal creates zero rows; abort during failed send prevents next request', async () => {
  const abort=new AbortController(); abort.abort()
  await assert.rejects(execute(()=>{}, {signal:abort.signal}))
  assert.equal(inserts.length,0)
  const during=new AbortController()
  await assert.rejects(execute(()=>{during.abort();throw httpError(429)}, {signal:during.signal}))
  assert.equal(inserts.length,1); assert.equal(sent.length,1)
  assert.equal(extras(inserts[0]).stopReason,'cancelled')
})
test('cancel while preparing next candidate records cancellation without sending', async () => {
  const abort=new AbortController()
  await assert.rejects(execute(()=>{}, {signal:abort.signal, prepare:async (c: any)=> {if(c.model==='b')abort.abort();return async()=>{sent.push(c.model);throw httpError(429)}}}))
  assert.deepEqual(sent,['a']); assert.equal(inserts.length,2)
  assert.equal(extras(inserts[1]).stopReason, 'cancelled')
})
test('consumption failure before output can advance; committed output cannot replay and retains partial usage', async () => {
  let consumed=0
  const result=await execute(async()=> 'stream', {consume:async (value: any,state: any)=>{if(++consumed===1)throw httpError(502);state.usage=measuredUsage(success().usage,'responses');return value}})
  assert.equal(result,'stream'); assert.equal(inserts.length,2)
  inserts=[];sent=[]
  await assert.rejects(execute(async()=> 'stream', {consume:async (_value: any,state: any)=>{state.committed=true;state.usage=measuredUsage(success().usage,'responses');throw httpError(502)}}))
  assert.equal(inserts.length,1);assert.equal(sent.length,1)
  assert.equal(inserts[0][15],true); assert.equal(extras(inserts[0]).stopReason,'output-committed')
})
test('same primary name uses purpose-specific brain/support/compaction chains', async () => {
  create = async (args: any) => {if(args.model==='same')throw httpError(401);return success()}
  for(const purpose of ['agent-turn','palette','compaction']) {
    const client=await getTrackedLlmClient({...ctx,purpose})
    await client.responses.create({model:'same',input:'hi'}, {maxRetries:0})
  }
  assert.deepEqual(sent.map(x=>x.args.model),['same','brain-backup','same','support-backup','same','compaction-backup'])
  assert.deepEqual(inserts.filter((_,i)=>i%2===0).map(x=>extras(x).role),['brain','support','compaction'])
})
test('explicit role is authoritative and candidates apply their individual token and effort limits', async () => {
  settings.llm_config=JSON.stringify({version:1,models:[{model:'same',maxOutputTokens:70,effort:'low'},{model:'support-backup',maxOutputTokens:30,effort:'none'}],roles:[],routes:[]})
  await refreshServerSettings(true)
  create=async (args: any)=>{if(args.model==='same')throw httpError(429);return success()}
  const client=await getTrackedLlmClient({...ctx,role:'support'})
  await client.responses.create({model:'ignored-legacy-model',input:'hi',max_output_tokens:100,reasoning:{effort:'high'}},{maxRetries:0})
  assert.deepEqual(sent.map(x=>x.args.max_output_tokens),[70,30])
  assert.deepEqual(sent[0].args.reasoning,{effort:'low'})
  assert.equal(sent[1].args.reasoning,undefined)
})
test('Responses usage missing and explicit measured zero remain distinct in SQL and extras', async () => {
  const client=await getTrackedLlmClient(ctx)
  create=async()=>({output_text:'ok'})
  await client.responses.create({model:'same',input:'hi'})
  create=async()=>({usage:{input_tokens:0,output_tokens:0}})
  await client.responses.create({model:'same',input:'hi'})
  assert.deepEqual(inserts.map(x=>x[15]),[false,true])
  assert.equal(extras(inserts[0]).usage,null)
  assert.equal(extras(inserts[1]).measurement,'measured')
  assert.deepEqual(extras(inserts[1]).usage,{inputTokens:0,cachedInputTokens:0,cacheCreationTokens:0,outputTokens:0})
})
test('Chat usage reads prompt/completion and cached/reasoning counts', async()=>{
  create=async()=>({model:'chat-actual',usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:60},completion_tokens_details:{reasoning_tokens:5}}})
  const client=await getTrackedLlmClient(ctx)
  await client.chat.completions.create({model:'same',messages:[{role:'user',content:'hi'}]})
  assert.equal(inserts[0][8],40);assert.equal(inserts[0][9],60);assert.equal(inserts[0][11],20);assert.equal(inserts[0][12],5)
})
test('Responses facade adapts a Chat candidate and records Chat usage',async()=>{
  settings.llm_config=JSON.stringify({version:1,roles:[],routes:[],models:[{model:'same',protocol:'chat'}]})
  await refreshServerSettings(true)
  create=async()=>({model:'chat-actual',choices:[{message:{content:'hello'}}],usage:{prompt_tokens:12,completion_tokens:3}})
  const client=await getTrackedLlmClient(ctx)
  const result=await client.responses.create({model:'same',input:'hi'})
  assert.equal(sent[0].api,'chat');assert.deepEqual(sent[0].args.messages,[{role:'user',content:'hi'}])
  assert.equal(result.output_text,'hello');assert.equal(inserts[0][8],12)
})
test('usage mapper rejects absent, incomplete, wrong-protocol, invalid and impossible counts',()=>{
  for(const raw of [undefined,null,{}, {input_tokens:1},{input_tokens:NaN,output_tokens:0},{input_tokens:-1,output_tokens:0},{input_tokens:1,output_tokens:0,input_tokens_details:{cached_tokens:2}},{prompt_tokens:10,completion_tokens:3}]) assert.equal(measuredUsage(raw,'responses'),null)
  assert.equal(readStreamUsage({type:'response.completed',response:{usage:{}}}),null)
})
test('legacy stream pass-through owns no ledger record and raw client has no application chain',async()=>{
  const stream={async *[Symbol.asyncIterator](){yield {type:'response.created'}}}
  create=async()=>stream
  const client=await getTrackedLlmClient(ctx)
  assert.equal(await client.responses.create({model:'same',stream:true}),stream)
  assert.equal(inserts.length,0)
  create=async()=>{throw httpError(401)}
  const raw=await getLlmClient(null)
  await assert.rejects(raw.responses.create({model:'same'}))
  assert.equal(sent.length,2)
})
test('ledger insert failure preserves success and increments the health counter without extra attempts',async()=>{
  const before=getLlmLedgerHealth().droppedCalls
  pool.query=async()=>{throw new Error('fake insert failure')}
  await execute(async()=> 'ok', {plan:plan(['a'])})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(getLlmLedgerHealth().droppedCalls,before+1)
  assert.ok(getLlmLedgerHealth().lastDropAt)
  assert.equal(sent.length,1)
})
test('Responses-to-Chat rejects unportable state before sending and translates JSON schema',async()=>{
  settings.llm_config=JSON.stringify({version:1,models:[{model:'same',protocol:'chat'}],roles:[{role:'support',models:['same']}]})
  await refreshServerSettings(true)
  const client=await getTrackedLlmClient(ctx)
  await assert.rejects(client.responses.create({model:'same',input:'hi',previous_response_id:'old'}),/Stateful/)
  assert.equal(sent.length,0);assert.equal(inserts.length,1)
  assert.equal(extras(inserts[0]).failureStage, 'prepare')
  inserts = []
  create=async()=>({choices:[{message:{tool_calls:[{id:'c',function:{name:'tool',arguments:'{}'}}]}}]})
  const result=await client.responses.create({model:'same',input:'hi',text:{format:{type:'json_schema',name:'answer',schema:{type:'object'},strict:true}}})
  assert.equal(sent[0].args.response_format.json_schema.name,'answer')
  assert.equal(result.output[0].call_id,'c')
  assert.equal(inserts[0][15],false)
})
test('purpose configuration overrides the legacy default model and invalid token budgets make zero calls',async()=>{
  settings.llm_config=JSON.stringify({version:1,roles:[{role:'support',purpose:'palette',models:['palette-main','palette-backup']}]})
  await refreshServerSettings(true)
  const client=await getTrackedLlmClient(ctx)
  await assert.rejects(client.responses.create({model:'same',input:'hi',max_output_tokens:-1}),/budget/)
  assert.equal(sent.length,0);assert.equal(inserts.length,2)
  assert.ok(inserts.every(row => extras(row).failureStage === 'prepare'))
  await client.responses.create({model:'same',input:'hi'})
  assert.equal(sent[0].args.model,'palette-main')
})
for(const status of [401,403,404,429,503]) test(`real SDK with in-memory fetch: ${status} -> success records exactly two requests`,async()=>{
  setSdkClientFactory(null)
  const oldFetch=globalThis.fetch
  const requests: any[]=[]
  globalThis.fetch=async (_url,options)=>{
    const body=JSON.parse(options!.body as string);requests.push(body)
    const ok=body.model!=='same'
    return new Response(JSON.stringify(ok ? success('sdk-actual') : {error:{message:`upstream ${status}`}}), {status:ok?200:status,headers:{'content-type':'application/json'}})
  }
  try {
    const client=await getTrackedLlmClient(ctx)
    const result=await client.responses.create({model:'same',input:'hi'},{maxRetries:0})
    assert.equal(result.model,'sdk-actual')
    assert.deepEqual(requests.map(x=>x.model),['same','support-backup'])
    assert.equal(inserts.length,2)
    assert.equal(extras(inserts[0]).nextCandidateReason,`upstream-http-${status}`)
  } finally {globalThis.fetch=oldFetch}
})
test('real raw SDK factory has no hidden application model chain',async()=>{
  setSdkClientFactory(null)
  const oldFetch=globalThis.fetch
  let requests=0
  globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({error:{message:'unauthorized'}}),{status:401,headers:{'content-type':'application/json'}})}
  try {
    const client=await getLlmClient(null)
    await assert.rejects(client.responses.create({model:'same',input:'hi'},{maxRetries:0}))
    assert.equal(requests,1);assert.equal(inserts.length,0)
  } finally {globalThis.fetch=oldFetch}
})

const embeddingResponse = (usage: unknown = { prompt_tokens: 12, total_tokens: 12 }) => ({
  model: 'embedding-actual', data: [{ embedding: Array(1536).fill(0.25) }], usage,
})
function embeddingClient() {
  setSdkClientFactory(() => ({
    embeddings: { create: async (args: any, opts: any) => {
      sent.push({ args, opts })
      return create(args, opts)
    } },
  }))
}
function embeddingStore() {
  const writes: string[] = []
  pool.connect = async () => ({
    query: async (sql: string) => {
      if (sql === 'SELECT key, value FROM server_settings') return {
        rows: Object.entries(settings).map(([key, value]) => ({ key, value })),
      }
      writes.push(sql)
      return { rows: [] }
    },
    release() {},
  }) as never
  return writes
}
test('embedding write, retrieval and backfill each create one measured ledger row', async () => {
  embeddingClient()
  create = async () => embeddingResponse()
  const writes = embeddingStore()
  const api = load('agents/embeddings.ts')
  assert.equal(await api.embedAndStore('write', { agentId: 'a', purpose: 'memory.write' },
    async (client: any) => client.query('STORE')), true)
  assert.ok(await api.embedText('retrieve', { agentId: 'a', purpose: 'memory.retrieve' }))
  const query = pool.query
  pool.query = async (sql, values) => {
    if (sql.includes('FROM pg_extension')) return { rows: [{ exists: true }] }
    if (sql.includes('FROM agent_workspace')) return {
      rows: [{ agent_id: 'a', company_id: null, path: 'memory/a', body: 'backfill' }],
    }
    return query(sql, values)
  }
  await api.backfillMemoryEmbeddings({ batchSize: 2, delayMs: 0 })
  assert.equal(sent.length, 3)
  assert.equal(inserts.length, 3)
  assert.deepEqual(inserts.map(row => extras(row).embeddingPurpose),
    ['memory.write', 'memory.retrieve', 'memory.backfill'])
  for (const row of inserts) {
    assert.equal(row[5], 'embedding')
    assert.equal(row[2], 'a')
    assert.equal(row[15], true)
    assert.equal(row[8], 12)
    assert.equal(row[11], 0)
    assert.equal(extras(row).actualModel, 'embedding-actual')
    assert.deepEqual(extras(row).rawUsage, { prompt_tokens: 12, total_tokens: 12 })
    assert.equal(extras(row).nextCandidate, null)
    assert.equal(extras(row).attempt, 1)
  }
  assert.ok(writes.some(sql => sql.includes('UPDATE agent_workspace')))
  assert.ok(sent.every(request => request.opts.maxRetries === 0 && request.opts.timeout === 10_000))
})
for (const status of [401, 403, 429, 503]) test('embedding failure ' + status + ' records once and never falls back', async () => {
  embeddingClient()
  create = async () => { throw httpError(status) }
  const api = load('agents/embeddings.ts')
  for (const purpose of ['memory.write', 'memory.retrieve', 'memory.backfill']) {
    assert.equal(await api.embedText('hello', { purpose }), null)
  }
  assert.equal(sent.length, 3)
  assert.equal(inserts.length, 3)
  for (const row of inserts) {
    assert.notEqual(row[17], 'ok')
    assert.equal(row[15], false)
    assert.equal(extras(row).actualModel, null)
    assert.equal(extras(row).nextCandidate, null)
    assert.equal(extras(row).sdkMaxRetries, 0)
  }
})
test('embedding missing or invalid usage stays unknown; measured zero stays measured', async () => {
  embeddingClient()
  const api = load('agents/embeddings.ts')
  for (const usage of [null, {}, { total_tokens: 12 }, { prompt_tokens: -1 },
    { prompt_tokens: 1.5 }, { prompt_tokens: 0, total_tokens: 0 }]) {
    create = async () => embeddingResponse(usage)
    assert.ok(await api.embedText('hello'))
  }
  assert.deepEqual(inserts.map(row => row[15]), [false, false, false, false, false, true])
  assert.ok(inserts.every(row => row[17] === 'ok'))
})
test('invalid embedding vector records failed attempt with usage and prevents storage', async () => {
  embeddingClient()
  create = async () => ({ ...embeddingResponse(), data: [{ embedding: [1] }] })
  const api = load('agents/embeddings.ts')
  let stored = false
  assert.equal(await api.embedAndStore('hello', {}, async () => { stored = true }), false)
  assert.equal(stored, false)
  assert.equal(sent.length, 1)
  assert.equal(inserts.length, 1)
  assert.equal(inserts[0][17], 'failed')
  assert.equal(inserts[0][15], true)
})
test('embedding space change discards stale vector while keeping its request ledger row', async () => {
  embeddingClient()
  const writes = embeddingStore()
  create = async () => { settings.embed_model = 'new-space'; return embeddingResponse() }
  const api = load('agents/embeddings.ts')
  let stored = false
  assert.equal(await api.embedAndStore('hello', {}, async () => { stored = true }), false)
  assert.equal(stored, false)
  assert.ok(writes.includes('ROLLBACK'))
  assert.equal(sent.length, 1)
  assert.equal(inserts.length, 1)
})

test('real embedding SDK receives 429 once with no hidden retry or second model', async () => {
  setSdkClientFactory(null)
  let requests = 0
  globalThis.fetch = async (_url, options) => {
    requests++
    const body = JSON.parse(options!.body as string)
    assert.equal(body.model, 'text-embedding-3-small')
    assert.equal(body.dimensions, 1536)
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429, headers: { 'content-type': 'application/json' },
    })
  }
  const api = load('agents/embeddings.ts')
  assert.equal(await api.embedText('hello', { purpose: 'memory.retrieve' }), null)
  assert.equal(requests, 1)
  assert.equal(inserts.length, 1)
  assert.equal(inserts[0][17], 'rate_limited')
  assert.equal(extras(inserts[0]).nextCandidate, null)
})

async function warmGatewayCatalog() {
  const tenant = load('tenant-llm-context.ts')
  await tenant.tenantModelSnapshot(await tenant.resolveTenantLlmContext('company-a'))
}

for (const failure of ['missing', 'query', 'version'] as const) test('A2: configured direct route cannot bypass tenant identity failure: ' + failure, async () => {
  gatewayFixture()
  settings.llm_config = JSON.stringify({ version: 1, routes: [{ id: 'env', kind: 'direct', env: 'text' }],
    models: [{ model: 'same', route: 'env' }], roles: [] })
  await refreshServerSettings(true)
  const query = pool.query
  pool.query = async (sql: any, values?: any[]) => {
    if (typeof sql === 'object' && sql.text.includes('owner_user_id')) {
      if (failure === 'missing') return { rows: [] }
      if (failure === 'query') throw new Error('identity database unavailable')
      load('tenant-llm-context.ts').invalidateTenantModelSnapshot('company-a')
    }
    return query(sql, values)
  }
  await assert.rejects(load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'support', 'palette'),
    /not found|identity database|authorization changed/)
  assert.equal(sent.length, 0)
})

test('A2: authorization rotation between gateway failure and env fallback rejects the whole execution', async () => {
  const gateway = gatewayFixture()
  settings.llm_config = JSON.stringify({ version: 1, routes: [{ id: 'env', kind: 'direct', env: 'text' }], models: [], roles: [
    { role: 'support', models: ['same'], fallbackPolicy: 'env_after_chain', directTargets: [{ model: 'env-model', route: 'env' }] },
  ] })
  await refreshServerSettings(true)
  const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.equal(plan.candidates.at(-1).route.kind, 'direct')
  await assert.rejects(execute(async () => {
    gateway.rotate()
    load('tenant-llm-context.ts').invalidateTenantModelSnapshot('company-a')
    throw httpError(503)
  }, { plan, context: { companyId: 'company-a', purpose: 'palette' } }), /authorization changed/)
  assert.deepEqual(sent, ['same'])
})

test('A2: explicit gateway route works with suspended discovery and remains before env fallback', async () => {
  const gateway = gatewayFixture()
  gateway.sub.listKeyModelsWithStatus = () => new Promise(() => {})
  settings.llm_config = JSON.stringify({ version: 1,
    routes: [{ id: 'gw', kind: 'gateway', platform: 'openai' }, { id: 'env', kind: 'direct', env: 'text' }],
    models: [{ model: 'same', route: 'gw' }], roles: [
      { role: 'support', models: ['same'], fallbackPolicy: 'env_after_chain', directTargets: [{ model: 'env-model', route: 'env' }] },
    ] })
  await refreshServerSettings(true)
  const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.deepEqual(plan.candidates.map((c: any) => [c.route.kind, c.available]), [['gateway', true], ['direct', true]])
  assert.equal(await execute(async c => { if (c.route.kind === 'gateway') throw httpError(503); return 'env-ok' },
    { plan, context: { companyId: 'company-a', purpose: 'palette' } }), 'env-ok')
  assert.deepEqual(sent, ['same', 'env-model'])
})

function gatewayFixture(models: string[] = []) {
  const originalQuery = pool.query
  let ownerReads = 0, version = 'v1'
  pool.query = async (sql: any, values?: any[]) => {
    if (typeof sql === 'object' && sql.text.includes('owner_user_id')) {
      ownerReads++
      return { rows: [{ owner_user_id: 'owner-a', authorization_version: version,
        sub2api_api_key: JSON.stringify({ openai: 'gateway-key', grok: 'grok-key' }) }] }
    }
    return originalQuery(sql, values)
  }
  const sub = load('sub2api.ts')
  sub.sub2apiRoutingConfigured = () => true
  sub.sub2apiOpenAIBaseURL = () => 'https://gateway.invalid/v1'
  sub.listKeyModelsWithStatus = async () => ({ models: new Set(models), ok: true, status: 'success' })
  return { sub, reads: () => ownerReads, rotate: () => { version = 'v2' } }
}

test('F04/F10: explicit DashScope direct route stays direct with gateway keys and records measured image usage', async t => {
  const env = isolatedProcess.env as Record<string, string>
  Object.assign(env, { OPENAI_IMAGE_PROVIDER: 'dashscope', OPENAI_IMAGE_API_KEY: 'dashscope-key', OPENAI_IMAGE_NATIVE_BASE_URL: 'https://dashscope.invalid/api/v1' })
  t.after(() => { delete env.OPENAI_IMAGE_PROVIDER; delete env.OPENAI_IMAGE_API_KEY; delete env.OPENAI_IMAGE_NATIVE_BASE_URL })
  gatewayFixture(['qwen-image-plus', 'wanx-v1'])
  const calls: { url: string; body: any }[] = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body ?? '{}')) })
    assert.ok(String(url).startsWith('https://dashscope.invalid/api/v1/'), 'shim must only call provider APIs, never download images')
    const output = String(url).includes('/tasks/') ? { task_status: 'SUCCEEDED', results: [{ url: 'https://image.invalid/generated.png' }] }
      : String(url).includes('image-synthesis') ? { task_id: 'isolated-task' }
      : { choices: [{ message: { content: [{ image: 'https://image.invalid/generated.png' }] } }] }
    return new Response(JSON.stringify({ output, usage: { input_tokens: 20, output_tokens: 100 } }))
  }
  setSdkClientFactory(options => ({ apiKey: options.apiKey, baseURL: options.baseURL }))
  for (const model of ['qwen-image-plus', 'wanx-v1']) {
    settings.image_model = model
    settings.llm_config = JSON.stringify({ version: 1, routes: [{ id: 'native-image', kind: 'direct', env: 'image', protocol: 'dashscope-image' }], models: [{ model, route: 'native-image' }], roles: [] })
    await refreshServerSettings(true)
    const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'image', 'agent-image')
    assert.equal(plan.candidates[0].route.kind, 'direct')
    assert.equal(plan.candidates[0].protocol, 'dashscope-image')
    assert.equal(plan.candidates[0].available, true)
    assert.equal(await load('llm.ts').executeImage({ companyId: 'company-a', purpose: 'agent-image' },
      { prompt: 'isolated image', size: '1024x1024' }, async (bytes: Buffer) => bytes.toString()), 'image-bytes')
    const row = inserts.at(-1)
    assert.equal(row[8], 20); assert.equal(row[11], 100); assert.equal(row[15], true)
    assert.deepEqual(extras(row).rawUsage, { input_tokens: 20, output_tokens: 100 })
    assert.equal(extras(row).unpriced, model === 'qwen-image-plus' ? undefined : 'no-price')
    assert.deepEqual(extras(row).units, { unit: 'image', quantity: 1 })
    assert.equal(row[13], model === 'qwen-image-plus' ? 0.028671 : 0)
  }
  assert.equal(calls.length, 3)
  assert.equal(imageDownloads.length, 2, 'sync and async results each use the unified downloader exactly once')
  assert.ok(imageDownloads.every(call => call.url === 'https://image.invalid/generated.png'
    && call.options.networkPolicy === 'dashscope-result'
    && call.options.maxBytes === 20 * 1024 * 1024 && call.options.timeoutMs === 30_000))
  assert.ok(calls.every(call => call.url.startsWith('https://dashscope.invalid/api/v1/')))
  assert.match(calls[0].url, /multimodal-generation/)
  assert.match(calls[1].url, /image-synthesis/)
})

test('F04: visible but unsupported explicit gateway image candidates are unavailable', async () => {
  gatewayFixture(['qwen-image-plus', 'wanx-v1', 'random-image', 'gpt-image-2', 'grok-imagine-image'])
  for (const model of ['qwen-image-plus', 'wanx-v1', 'random-image', 'gpt-image-2', 'grok-imagine-image']) {
    settings.llm_config = JSON.stringify({ version: 1, routes: [{ id: 'gw', kind: 'gateway', platform: 'openai', protocol: 'images' }],
      models: [{ model, route: 'gw' }], roles: [{ role: 'image', models: [model] }] })
    await refreshServerSettings(true)
    const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'image', 'agent-image')
    const supported = model !== 'random-image'
    assert.equal(plan.candidates[0].available, supported)
    if (!supported) assert.equal(plan.candidates[0].diagnostic, 'gateway-image-model-unsupported')
  }
})

test('gateway image hop is unavailable when the group catalog has no image models', async () => {
  gatewayFixture(['gpt-4.1', 'kimi-k2'])
  settings.image_model = 'gpt-image-2'
  settings.image_fallback_models = ''
  await refreshServerSettings(true)
  await warmGatewayCatalog()
  const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'image', 'agent-image')
  assert.equal(plan.candidates[0].model, 'gpt-image-2')
  assert.equal(plan.candidates[0].route.kind, 'gateway')
  assert.equal(plan.candidates[0].available, false)
  assert.equal(plan.candidates[0].diagnostic, 'gateway-image-group-unavailable')
})

test('slow cold discovery does not block a gateway image hop', async () => {
  const gateway = gatewayFixture(['gpt-4.1'])
  gateway.sub.listKeyModelsWithStatus = async () => { await new Promise(resolve => setTimeout(resolve, 300)); return { models: new Set(['gpt-image-2']), ok: true, status: 'success' } }
  settings.image_model = 'gpt-image-2'
  settings.image_fallback_models = ''
  await refreshServerSettings(true)
  const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'image', 'agent-image')
  assert.ok(plan.diagnostics.includes('discovery:pending'))
  assert.equal(plan.candidates[0].available, true)
  assert.equal(plan.candidates[0].diagnostic, undefined)
})

test('DashScope default image_model is qwen-image-max and stays direct', async t => {
  const env = isolatedProcess.env as Record<string, string>
  Object.assign(env, { OPENAI_IMAGE_PROVIDER: 'dashscope', OPENAI_IMAGE_API_KEY: 'dashscope-key', OPENAI_IMAGE_NATIVE_BASE_URL: 'https://dashscope.invalid/api/v1' })
  t.after(() => { delete env.OPENAI_IMAGE_PROVIDER; delete env.OPENAI_IMAGE_API_KEY; delete env.OPENAI_IMAGE_NATIVE_BASE_URL })
  gatewayFixture(['gpt-4.1'])
  delete settings.image_model
  delete settings.image_fallback_models
  await refreshServerSettings(true)
  const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'image', 'agent-image')
  assert.equal(plan.candidates[0].requestModel, 'qwen-image-max')
  assert.equal(plan.candidates[0].route.kind, 'direct')
  assert.equal(plan.candidates[0].available, true)
  assert.equal(plan.candidates.length, 1)
})

test('executeImage hops past a catalog-blocked gateway image hop onto DashScope', async t => {
  const env = isolatedProcess.env as Record<string, string>
  Object.assign(env, { OPENAI_IMAGE_PROVIDER: 'dashscope', OPENAI_IMAGE_API_KEY: 'dashscope-key', OPENAI_IMAGE_NATIVE_BASE_URL: 'https://dashscope.invalid/api/v1' })
  t.after(() => { delete env.OPENAI_IMAGE_PROVIDER; delete env.OPENAI_IMAGE_API_KEY; delete env.OPENAI_IMAGE_NATIVE_BASE_URL })
  gatewayFixture(['gpt-4.1'])
  settings.image_model = 'gpt-image-2'
  settings.image_fallback_models = 'qwen-image-max'
  await refreshServerSettings(true)
  await warmGatewayCatalog()
  setSdkClientFactory(options => ({ apiKey: options.apiKey, baseURL: options.baseURL }))
  const urls: string[] = []
  globalThis.fetch = async (url) => {
    if (String(url).includes('image.invalid/generated.png')) return new Response('image-bytes')
    urls.push(String(url))
    assert.match(String(url), /dashscope\.invalid/)
    return new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: 'https://image.invalid/generated.png' }] } }] }, usage: { input_tokens: 1, output_tokens: 1 } }))
  }
  const bytes = await load('llm.ts').executeImage({ companyId: 'company-a', purpose: 'agent-image' },
    { prompt: 'portrait', size: '1024x1024' }, async (buffer: Buffer) => buffer.toString())
  assert.equal(bytes, 'image-bytes')
  assert.equal(urls.length, 1)
  assert.match(urls[0], /multimodal-generation/)
})

test('gateway No available compatible accounts maps to a 4xx image business error', async () => {
  settings.image_model = 'gpt-image-2'
  settings.image_fallback_models = ''
  await refreshServerSettings(true)
  setSdkClientFactory(() => ({ images: { generate: async () => {
    throw Object.assign(new Error('No available compatible accounts'), { status: 503 })
  } } }))
  const err = await load('llm.ts').executeImage({ companyId: null, purpose: 'agent-image' },
    { prompt: 'portrait', size: '1024x1024' }, async () => { assert.fail('stored') }).then(() => null, (e: unknown) => e)
  assert.equal(err.name, 'ImageGenerationError')
  assert.equal(err.status, 409)
  assert.match(err.message, /gateway group has no available accounts/)
  assert.doesNotMatch(err.message, /image generation failed/)
})

test('no available image candidates map to the same gateway-account business error', async () => {
  gatewayFixture(['gpt-4.1'])
  settings.image_model = 'gpt-image-2'
  settings.image_fallback_models = ''
  await refreshServerSettings(true)
  await warmGatewayCatalog()
  let gatewayCalls = 0
  setSdkClientFactory(() => ({ images: { generate: async () => { gatewayCalls++; throw new Error('must not generate') } } }))
  const err = await load('llm.ts').executeImage({ companyId: 'company-a', purpose: 'agent-image' },
    { prompt: 'portrait', size: '1024x1024' }, async () => { assert.fail('stored') }).then(() => null, (e: unknown) => e)
  assert.equal(err.name, 'ImageGenerationError')
  assert.equal(err.status, 409)
  assert.equal(gatewayCalls, 0)
})

test('default image model prefers qwen-image-max when DashScope is configured', () => {
  const { defaultOpenAIImageModel } = load('env.ts')
  assert.equal(defaultOpenAIImageModel({}), 'gpt-image-2')
  assert.equal(defaultOpenAIImageModel({ OPENAI_IMAGE_PROVIDER: 'dashscope' }), 'qwen-image-max')
  assert.equal(defaultOpenAIImageModel({ OPENAI_IMAGE_PROVIDER: 'dashscope', OPENAI_IMAGE_MODEL: 'gpt-image-2' }), 'gpt-image-2')
})

test('F10: Images usage survives storage failure; missing usage remains unknown', async () => {
  settings.image_model = 'gpt-image-2'
  await refreshServerSettings(true)
  const rawUsage = { input_tokens: 20, output_tokens: 100, input_tokens_details: { cached_tokens: 5, image_tokens: 10 } }
  let usage: unknown = rawUsage
  setSdkClientFactory(() => ({ images: { generate: async () => ({ data: [{ b64_json: Buffer.from('image').toString('base64') }], usage }) } }))
  const image = () => load('llm.ts').executeImage({ companyId: null, purpose: 'agent-image' },
    { prompt: 'image', size: '1024x1024' }, async () => { throw new Error('storage failed') })
  await assert.rejects(image(), /storage failed/)
  assert.equal(inserts[0][8], 15); assert.equal(inserts[0][9], 5); assert.equal(inserts[0][11], 100)
  assert.equal(inserts[0][15], true)
  assert.deepEqual(extras(inserts[0]).rawUsage, rawUsage)
  assert.equal(extras(inserts[0]).unpriced, 'media-tier-pricing-unavailable')
  usage = undefined
  await assert.rejects(image(), /storage failed/)
  assert.equal(inserts[1][15], true, 'returned image count is measured without tokens')
  assert.deepEqual(extras(inserts[1]).units, { unit: 'image', quantity: 1 })
  assert.equal(extras(inserts[1]).rawUsage, null)
})

test('F17: slow cold discovery runs in background and candidate clients share the authorization context', async () => {
  const gateway = gatewayFixture()
  gateway.sub.listKeyModelsWithStatus = async () => { await new Promise(resolve => setTimeout(resolve, 300)); return { models: new Set(['same']), ok: true, status: 'success' } }
  const start = performance.now()
  const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.ok(performance.now() - start < 1_500, 'discovery must leave most of the 8s classification budget')
  assert.ok(plan.diagnostics.includes('discovery:pending'))
  const llm = load('llm.ts')
  const first = await llm.getLlmCandidateClient(plan, plan.candidates[0])
  assert.equal(await llm.getLlmCandidateClient(plan, plan.candidates[0]), first)
  assert.equal(gateway.reads(), 1)
  gateway.rotate()
  load('tenant-llm-context.ts').invalidateTenantModelSnapshot('company-a')
  await assert.rejects(llm.getLlmCandidateClient(plan, plan.candidates[0]), /authorization changed/)
  const next = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.notEqual(await llm.getLlmCandidateClient(next, next.candidates[0]), first)
})

test('F17: stale same-version routing returns immediately while discovery refresh is suspended', async () => {
  const gateway = gatewayFixture(['same'])
  const tenant = load('tenant-llm-context.ts')
  const context = await tenant.resolveTenantLlmContext('company-a')
  const first = await tenant.tenantModelSnapshot(context)
  first.at = Date.now() - 31_000
  let requests = 0
  gateway.sub.listKeyModelsWithStatus = () => { requests++; return new Promise(() => {}) }
  const start = performance.now()
  const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.ok(performance.now() - start < 150, 'warm routing must not wait for directory I/O')
  assert.equal(plan.authorizationVersion, context.authorizationVersion)
  assert.equal(requests, 2)
  assert.equal(gateway.reads(), 1)
  assert.equal(await tenant.tenantRoutingSnapshot(context), first)
  assert.equal(requests, 2, 'refresh is deduplicated')
})

test('F17: warm catalog resolve does not start another discovery round-trip', async () => {
  const gateway = gatewayFixture(['same'])
  const tenant = load('tenant-llm-context.ts')
  const context = await tenant.resolveTenantLlmContext('company-a')
  await tenant.tenantModelSnapshot(context)
  let requests = 0
  gateway.sub.listKeyModelsWithStatus = () => { requests++; return new Promise(() => {}) }
  const start = performance.now()
  const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.ok(performance.now() - start < 150)
  assert.equal(plan.authorizationVersion, context.authorizationVersion)
  assert.equal(requests, 0, 'warm snapshot must not hit /models')
  assert.equal(gateway.reads(), 1)
})

test('F17: 401 fallback reuses bound tenant context without another owner lookup', async () => {
  const gateway = gatewayFixture(['same'])
  const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.equal(gateway.reads(), 1)
  const llm = load('llm.ts')
  await llm.getLlmCandidateClient(plan, plan.candidates[0])
  await llm.getLlmCandidateClient(plan, plan.candidates[1])
  assert.equal(gateway.reads(), 1, 'candidate clients must reuse the plan-bound owner keys')
})

test('F17: cold owner lookup has its own small budget and never authorizes direct fallback on failure', async () => {
  gatewayFixture()
  pool.query = async () => new Promise(() => {})
  const start = performance.now()
  await assert.rejects(load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'support', 'palette'), /resolution timed out/)
  assert.ok(performance.now() - start < 1_500)
  assert.equal(sent.length, 0)
})

test('F13/F17: cancelling during cold discovery returns promptly without sending a model request', async () => {
  const gateway = gatewayFixture()
  let started!: () => void
  const discoveryStarted = new Promise<void>(resolve => { started = resolve })
  gateway.sub.listKeyModelsWithStatus = () => { started(); return new Promise(() => {}) }
  const controller = new AbortController()
  const result = load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'audio', 'audio-transcription', undefined, undefined, controller.signal)
  const rejected = assert.rejects(result, (error: Error) => error.name === 'AbortError')
  await discoveryStarted
  const start = performance.now()
  controller.abort()
  await rejected
  assert.ok(performance.now() - start < 150)
  assert.equal(sent.length, 0)
})

test('F17: an obsolete directory refresh cannot replace the next authorization version', async () => {
  const gateway = gatewayFixture()
  const tenant = load('tenant-llm-context.ts')
  const oldContext = await tenant.resolveTenantLlmContext('company-a')
  const complete: ((value: unknown) => void)[] = []
  gateway.sub.listKeyModelsWithStatus = () => new Promise(resolve => complete.push(resolve))
  const oldRefresh = tenant.tenantModelSnapshot(oldContext)
  const rejected = assert.rejects(oldRefresh, /authorization changed/)
  gateway.rotate()
  tenant.invalidateTenantModelSnapshot('company-a')
  const nextContext = await tenant.resolveTenantLlmContext('company-a')
  gateway.sub.listKeyModelsWithStatus = async () => ({ models: new Set(['new-model']), ok: true, status: 'success' })
  const nextSnapshot = await tenant.tenantModelSnapshot(nextContext)
  complete.forEach(resolve => { resolve({ models: new Set(['old-model']), ok: true, status: 'success' }) })
  await rejected
  assert.equal(await tenant.tenantRoutingSnapshot(nextContext), nextSnapshot)
  assert.equal(nextSnapshot.platforms.openai.models.has('old-model'), false)
})

for (const discovery of ['cold', 'empty', 'reseller-only'] as const) test('fix-i: support DeepSeek first hop honors native membership and reseller fallback with ' + discovery + ' discovery', async () => {
  const gateway = gatewayFixture()
  const query = pool.query
  pool.query = async (sql: any, values?: any[]) => {
    const result = await query(sql, values)
    if (typeof sql === 'object' && sql.text.includes('owner_user_id')) {
      result.rows[0].sub2api_api_key = JSON.stringify({ openai: 'gateway-key', deepseek: 'deepseek-key' })
    }
    return result
  }
  settings.support_model = 'deepseek-v4-flash'
  settings.support_fallback_models = ''
  await refreshServerSettings(true)
  gateway.sub.listKeyModelsWithStatus = async (_base: string, key: string) => {
    if (discovery === 'cold') await new Promise(resolve => setTimeout(resolve, 300))
    return { models: new Set(discovery === 'reseller-only' ? key === 'gateway-key' ? ['deepseek-v4-flash'] : [] : key === 'deepseek-key' ? ['deepseek-v4-flash'] : []), ok: true, status: 'success' }
  }
  if (discovery !== 'cold') await warmGatewayCatalog()
  const resolver = load('llm-resolver.ts')
  const plan = await resolver.resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.equal(plan.candidates.length, 1)
  assert.equal(plan.candidates[0].route.platform, discovery === 'reseller-only' ? 'openai' : 'deepseek')
  assert.equal(plan.candidates[0].available, true)
  let credential: string | undefined
  setSdkClientFactory(options => { credential = options.apiKey; return {} })
  await load('llm.ts').getLlmCandidateClient(plan, plan.candidates[0])
  assert.equal(credential, discovery === 'reseller-only' ? 'gateway-key' : 'deepseek-key')
  settings.llm_config = JSON.stringify({ version: 1, routes: [{ id: 'reseller', kind: 'gateway', platform: 'openai' }], models: [{ model: 'deepseek-v4-flash', route: 'reseller' }], roles: [] })
  await refreshServerSettings(true)
  const explicit = await resolver.resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.equal(explicit.candidates[0].route.platform, 'openai', 'explicit operator routes remain authoritative')
})

for (const status of [500, 502, 503, 504, 599]) test('5xx is failed even with quota/overload wording: ' + status, () => {
  const classify = load('agents/llm-ledger.ts').classifyLlmCallError
  assert.equal(classify(Object.assign(new Error('rate limit quota overload timeout'), { status })), 'failed')
  assert.equal(classify(httpError(429)), 'rate_limited')
})
test('settlement is awaited before fallback and recorder errors cannot silently disappear', async () => {
  const records: any[] = []
  const record = async (row: any) => { records.push(row); throw new Error('durable recorder unavailable') }
  await assert.rejects(execute(c => { if (c.model === 'a') throw httpError(503); return 'ok' }, {record}), /durable recorder unavailable/)
  assert.deepEqual(sent, ['a'])
  assert.equal(records.length, 1)
})
test('pgvector transient failure retries and then caches the successful probe', async () => {
  let probes = 0
  pool.query = async () => { if (++probes === 1) throw new Error('starting'); return { rows: [{ exists: true }] } }
  const api = load('agents/embeddings.ts')
  assert.equal(await api.hasPgVector(), false)
  assert.equal(await api.hasPgVector(), true)
  assert.equal(await api.hasPgVector(), true)
  assert.equal(probes, 2)
})
test('image SDK receives caller signal; cancellation prevents storage and fallback', async () => {
  settings.image_model = 'gpt-image-2'
  settings.image_fallback_models = 'gpt-image-1'
  await refreshServerSettings(true)
  const controller = new AbortController()
  let calls = 0, stores = 0
  setSdkClientFactory(() => ({ images: { generate: async (_args: any, options: any) => {
    calls++
    assert.equal(options.signal, controller.signal)
    controller.abort()
    options.signal.throwIfAborted()
  } } }))
  await assert.rejects(load('llm.ts').executeImage({ companyId: null, purpose: 'agent-image' },
    { prompt: 'image', size: '1024x1024' }, async () => { stores++ }, {signal: controller.signal}), {name:'AbortError'})
  assert.equal(calls, 1); assert.equal(stores, 0)
  assert.equal(extras(inserts[0]).stopReason, 'cancelled')
})
for (const model of ['qwen-image-plus', 'wanx-v1']) test('DashScope image cancellation reaches fetch: ' + model, async t => {
  const env = isolatedProcess.env as Record<string, string>
  Object.assign(env, { OPENAI_IMAGE_PROVIDER: 'dashscope', OPENAI_IMAGE_API_KEY: 'key', OPENAI_IMAGE_NATIVE_BASE_URL: 'https://dashscope.invalid/api/v1' })
  t.after(() => { delete env.OPENAI_IMAGE_PROVIDER; delete env.OPENAI_IMAGE_API_KEY; delete env.OPENAI_IMAGE_NATIVE_BASE_URL })
  settings.image_model = model
  await refreshServerSettings(true)
  const controller = new AbortController()
  let requests = 0
  globalThis.fetch = async (_url, options) => {
    requests++
    controller.abort()
    assert.equal(options!.signal!.aborted, true)
    throw options!.signal!.reason
  }
  setSdkClientFactory(options => ({apiKey:options.apiKey,baseURL:options.baseURL}))
  await assert.rejects(load('llm.ts').executeImage({companyId:null,purpose:'agent-image'},
    {prompt:'image',size:'1024x1024'}, async () => { assert.fail('cancelled image stored') }, {signal:controller.signal}), {name:'AbortError'})
  assert.equal(requests, 1)
})

test('DashScope cancellation during polling delay sends no poll and stores no image', async t => {
  const env = isolatedProcess.env as Record<string, string>
  Object.assign(env, { OPENAI_IMAGE_PROVIDER: 'dashscope', OPENAI_IMAGE_API_KEY: 'key', OPENAI_IMAGE_NATIVE_BASE_URL: 'https://dashscope.invalid/api/v1' })
  t.after(() => { delete env.OPENAI_IMAGE_PROVIDER; delete env.OPENAI_IMAGE_API_KEY; delete env.OPENAI_IMAGE_NATIVE_BASE_URL })
  settings.image_model = 'wanx-v1'
  await refreshServerSettings(true)
  const controller = new AbortController()
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    setImmediate(() => controller.abort())
    return new Response(JSON.stringify({output:{task_id:'cancelled-task'}}))
  }
  setSdkClientFactory(options => ({apiKey:options.apiKey,baseURL:options.baseURL}))
  const start = performance.now()
  await assert.rejects(load('llm.ts').executeImage({companyId:null,purpose:'agent-image'},
    {prompt:'image',size:'1024x1024'}, async () => { assert.fail('cancelled image stored') }, {signal:controller.signal}), {name:'AbortError'})
  assert.ok(performance.now() - start < 1_000)
  assert.equal(requests, 1)
  assert.equal(extras(inserts[0]).taskId, 'cancelled-task')
  assert.equal(extras(inserts[0]).stopReason, 'cancelled')
})
test('pre-aborted image makes no model requests or ledger attempts', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(load('llm.ts').executeImage({companyId:null,purpose:'agent-image'},
    {prompt:'image',size:'1024x1024'}, async () => { assert.fail('cancelled image stored') }, {signal:controller.signal}), {name:'AbortError'})
  assert.equal(sent.length, 0)
  assert.equal(inserts.length, 0)
})

for (const [model, platform] of [['k3','kimi'], ['kimi-for-coding','kimi'], ['grok-4','grok'], ['glm-4.6','zhipu'], ['claude-sonnet-4-6','anthropic']] as const)
  test('cold resolver uses the native credential for ' + model, async () => {
    const gateway = gatewayFixture()
    const query = pool.query
    pool.query = async (sql: any, values?: any[]) => {
      const result = await query(sql, values)
      if (typeof sql === 'object' && sql.text.includes('owner_user_id')) {
        result.rows[0].sub2api_api_key = JSON.stringify({openai:'gateway-key',[platform]:'native-key'})
      }
      return result
    }
    settings.support_model = model
    settings.support_fallback_models = ''
    await refreshServerSettings(true)
    gateway.sub.listKeyModelsWithStatus = async (_base: string, key: string) => { await new Promise(resolve => setTimeout(resolve, 300)); return { models: new Set(key === 'native-key' ? [model] : []), ok: true, status: 'success' } }
    const plan = await load('llm-resolver.ts').resolveRoleCall('company-a','managed','support','palette')
    assert.equal(plan.candidates[0].route.platform, platform)
    assert.equal(plan.candidates[0].protocol, platform === 'zhipu' ? 'chat' : 'responses')
    let credential: string | undefined
    setSdkClientFactory(options => { credential = options.apiKey; return {} })
    await load('llm.ts').getLlmCandidateClient(plan,plan.candidates[0])
    assert.equal(credential,'native-key')
  })

for (const disconnected of [false, true]) test('avatar HTTP cancellation reaches generation; already disconnected: ' + disconnected, async () => {
  const source = readFileSync(new URL('api/router.ts', root), 'utf8')
  const start = source.indexOf("api.post('/agents/:id/avatar/generate'")
  const block = source.slice(start, source.indexOf('\n})', start) + 3)
  assert.ok(start > 0)
  const output = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  let handler: any
  let signal: AbortSignal | undefined
  let calls = 0
  const { EventEmitter } = nativeRequire('node:events')
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false, destroyed: disconnected,
    json: () => assert.fail('disconnected response written'),
    status: () => assert.fail('disconnected response status written'),
  })
  const generate = async (args: { signal: AbortSignal }) => {
    calls++
    signal = args.signal
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      response.destroyed = true
      response.emit('close')
    })
  }
  new Function('api', 'requireCompanyRole', 'generateAndPersistAvatar', 'HttpError', 'ImageGenerationError', output)(
    { post: (_path: string, fn: any) => { handler = fn } }, async () => ({ companyId: 'company-a' }), generate, Error, class ImageGenerationError extends Error {},
  )
  await handler({ params: { id: 'agent-a' } }, response)
  assert.equal(calls, disconnected ? 0 : 1)
  if (!disconnected) assert.equal(signal?.aborted, true)
  assert.equal(response.listenerCount('close'), 0)
})

test('avatar maps gateway image account errors to a 4xx business response', async () => {
  const source = readFileSync(new URL('api/router.ts', root), 'utf8')
  const start = source.indexOf("api.post('/agents/:id/avatar/generate'")
  const block = source.slice(start, source.indexOf('\n})', start) + 3)
  const output = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const { ImageGenerationError, GATEWAY_IMAGE_NO_ACCOUNTS_MESSAGE } = load('llm.ts')
  let handler: any
  let status: number | undefined
  let body: { error?: string } | undefined
  const { EventEmitter } = nativeRequire('node:events')
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false, destroyed: false,
    json(payload: any) { body = payload },
    status(code: number) { status = code; return this },
  })
  new Function('api', 'requireCompanyRole', 'generateAndPersistAvatar', 'HttpError', 'ImageGenerationError', output)(
    { post: (_path: string, fn: any) => { handler = fn } }, async () => ({ companyId: 'company-a' }),
    async () => { throw new ImageGenerationError() }, Error, ImageGenerationError,
  )
  await handler({ params: { id: 'agent-a' } }, response)
  assert.equal(status, 409)
  assert.equal(body?.error, GATEWAY_IMAGE_NO_ACCOUNTS_MESSAGE)
  assert.doesNotMatch(body?.error ?? '', /image generation failed/)
})


test('deep-1: same model falls back between keyed platforms and retains one logical call', async () => {
  const gateway = gatewayFixture(['deepseek-v4-flash'])
  const query = pool.query
  pool.query = async (sql: any, values?: any[]) => {
    const result = await query(sql, values)
    if (typeof sql === 'object' && sql.text.includes('owner_user_id')) result.rows[0].sub2api_api_key = JSON.stringify({ deepseek: 'native', openai: 'reseller', composite: 'composite' })
    return result
  }
  settings.support_model = 'deepseek-v4-flash'
  settings.support_fallback_models = ''
  await refreshServerSettings(true)
  await warmGatewayCatalog()
  const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.deepEqual(plan.candidates.map((c: any) => c.route.platform), ['deepseek', 'openai', 'composite'])
  const calls: string[] = [], rows: any[] = []
  const result = await executeLlmPlan({ plan, context: { ...ctx, companyId: 'company-a', purpose: 'palette' }, sdkMaxRetries: 0, record: async (r: any) => rows.push(r), log: () => {},
    prepare: async (c: any) => async () => { calls.push(c.route.platform); if (calls.length === 1) throw httpError(503); return 'reseller-ok' } })
  assert.equal(result, 'reseller-ok')
  assert.deepEqual(calls, ['deepseek', 'openai'])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].extras.logicalCallId, rows[1].extras.logicalCallId)
  assert.equal(gateway.reads(), 1)
})

test('A2: cold or timed-out directory skips only the unknown gateway hop and executes env fallback', async () => {
  const gateway = gatewayFixture()
  const query = pool.query
  pool.query = async (sql: any, values?: any[]) => {
    const result = await query(sql, values)
    if (typeof sql === 'object' && sql.text.includes('owner_user_id')) result.rows[0].sub2api_api_key = JSON.stringify({ antigravity: 'authorized' })
    return result
  }
  settings.llm_config = JSON.stringify({ version: 1, routes: [{ id: 'env', kind: 'direct', env: 'text' }], models: [], roles: [
    { role: 'support', models: ['claude-sonnet-4-6'], fallbackPolicy: 'env_after_chain', directTargets: [{ model: 'env-model', route: 'env' }] },
  ] })
  await refreshServerSettings(true)
  gateway.sub.listKeyModelsWithStatus = () => new Promise(() => {})
  const resolver = load('llm-resolver.ts')
  const start = performance.now()
  const plan = await resolver.resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.ok(performance.now() - start < 500)
  assert.equal(plan.candidates[0].available, false)
  assert.equal(plan.candidates[0].diagnostic, 'gateway-discovery-pending')
  assert.equal(plan.candidates[1].route.kind, 'direct')
  assert.equal(await execute(async () => 'env-ok', { plan, context: { companyId: 'company-a', purpose: 'palette' } }), 'env-ok')
  assert.deepEqual(sent, ['env-model'])
  load('tenant-llm-context.ts').invalidateTenantModelSnapshot('company-a')
  gateway.sub.listKeyModelsWithStatus = async () => ({ models: new Set(), ok: false, status: 'timeout' })
  await warmGatewayCatalog()
  const timedOut = await resolver.resolveRoleCall('company-a', 'managed', 'support', 'palette')
  assert.ok(timedOut.diagnostics.includes('discovery:antigravity:timeout'))
  assert.equal(timedOut.candidates[0].diagnostic, 'gateway-discovery-pending')
  assert.equal(await execute(async () => 'env-ok', { plan: timedOut, context: { companyId: 'company-a', purpose: 'palette' } }), 'env-ok')
  assert.deepEqual(sent, ['env-model', 'env-model'])
})

for (const status of ['empty', 'unauthorized', 'timeout', 'unavailable']) test('deep-1: discovery retention policy for ' + status, async () => {
  const gateway = gatewayFixture(['same'])
  const tenant = load('tenant-llm-context.ts')
  const context = await tenant.resolveTenantLlmContext('company-a')
  const first = await tenant.tenantModelSnapshot(context)
  gateway.sub.listKeyModelsWithStatus = async () => ({ models: new Set(), ok: status === 'empty', status })
  const refreshed = await tenant.tenantModelSnapshot(context, true)
  const transient = status === 'timeout' || status === 'unavailable'
  assert.equal(refreshed.platforms.openai.models.has('same'), transient)
  assert.equal(refreshed.platforms.openai.stale, transient)
  if (transient) {
    assert.equal(refreshed.platforms.openai.lastSuccessAt, first.platforms.openai.lastSuccessAt)
    for (const p of Object.values(refreshed.platforms) as any[]) p.lastSuccessAt = Date.now() - 121_000
    const expired = await tenant.tenantRoutingSnapshot(context)
    assert.equal(expired, null, 'expired membership is not reused')
    const next = await tenant.tenantModelSnapshot(context)
    assert.equal(next.platforms.openai.models.size, 0)
    assert.equal(next.platforms.openai.stale, false)
  }
})

test('deep-1: Responses parallel tools survive real Chat executor replay', async () => {
  settings.llm_config = JSON.stringify({ version: 1, routes: [{ id: 'chat', kind: 'direct', env: 'text', protocol: 'chat' }], models: [{ model: 'same', route: 'chat' }], roles: [] })
  await refreshServerSettings(true)
  const input = [
    { type: 'function_call', call_id: 'A', name: 'lookup', arguments: '{"id":1}' },
    { type: 'function_call', call_id: 'B', name: 'lookup', arguments: '{"id":2}' },
    { type: 'function_call_output', call_id: 'A', output: 'one' },
    { type: 'function_call_output', call_id: 'B', output: 'two' },
  ]
  let outbound: any
  setSdkClientFactory(() => ({ chat: { completions: { create: async (body: any) => { outbound = body; return { choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } } } } } }))
  const result = await load('llm-execution.ts').executeTrackedText({ ...ctx, role: 'support' }, 'responses', { input })
  assert.equal(result.output_text, 'done')
  assert.deepEqual(outbound.messages.map((m: any) => m.role), ['assistant', 'tool', 'tool'])
  assert.deepEqual(outbound.messages[0].tool_calls.map((t: any) => t.id), ['A', 'B'])
  assert.deepEqual(outbound.messages.slice(1).map((m: any) => m.tool_call_id), ['A', 'B'])
})

for (const model of ['qwen-image-plus', 'wanx-v1']) test('deep-1: discovered DashScope Images uses gateway and records usage: ' + model, async () => {
  const gateway = gatewayFixture([model])
  gateway.sub.listKeyModelsWithStatus = async (_base: string, key: string) => ({ models: new Set(key === 'gateway-key' ? [model] : []), ok: true, status: 'success' })
  settings.image_model = model
  settings.image_fallback_models = ''
  await refreshServerSettings(true)
  await warmGatewayCatalog()
  let body: any, credential: string | undefined
  setSdkClientFactory(options => { return { images: { generate: async (args: any) => { credential = options.apiKey; body = args; return { data: [{ b64_json: Buffer.from('gateway-image').toString('base64') }], usage: { input_tokens: 8, output_tokens: 9 } } } } } })
  const plan = await load('llm-resolver.ts').resolveRoleCall('company-a', 'managed', 'image', 'agent-image')
  assert.equal(plan.candidates[0].route.kind, 'gateway')
  assert.equal(plan.candidates[0].protocol, 'images')
  assert.equal(await load('llm.ts').executeImage({ companyId: 'company-a', purpose: 'agent-image' }, { prompt: 'test' }, async (bytes: Buffer) => bytes.toString()), 'gateway-image')
  assert.equal(credential, 'gateway-key')
  assert.equal(body.model, model)
  assert.equal(inserts.at(-1)[15], true)
})


test('deep-1: usage DTO consumes prepare and execution failures from the actual executor', async () => {
  const rows: any[] = []
  await assert.rejects(executeLlmPlan({ plan: plan(['a', 'b']), context: ctx, sdkMaxRetries: 0, record: async (row: any) => rows.push(row), log: () => {},
    prepare: async (c: any) => { if (c.model === 'a') throw new Error('invalid local parameters'); return async () => { throw httpError(403) } } }))
  assert.deepEqual(rows.map(r => r.extras.failureStage), ['prepare', 'execution'])
  const source = readFileSync(new URL('usage.ts', root), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const dto: any = {}
  new Function('exports', 'require', output)(dto, (name: string) => {
    if (name === './agents/llm-rollup.js') return { isLlmRollupPaused: () => false }
    if (name === './settings.js') return { automationNumber: () => 1 }
    assert.equal(name, './db/pool.js')
    return { pool: { query: async (sql: string) => sql.includes('COUNT(*)') ? { rows: [{ total: '2' }] } : { rows: rows.map((r, id) => ({ id: String(id), created_at: new Date(0), model: r.model, status: r.status,
      failure_stage: r.extras.failureStage, failure_reason: r.extras.failureReason, http_status: String(r.extras.httpStatus ?? '') })) } } }
  })
  const logs = await dto.usageLogs('tenant', { from: new Date(0), to: new Date(1) }, { page: 1, pageSize: 50 })
  assert.deepEqual(logs.items.map((r: any) => r.failureStage), ['prepare', 'execution'])
  assert.equal(logs.items[1].httpStatus, 403)
})


test('deep-1: tracked text cancellation interrupts cold discovery before any provider call', async () => {
  const gateway = gatewayFixture()
  const controller = new AbortController()
  gateway.sub.listKeyModelsWithStatus = () => { controller.abort(new DOMException('Cancelled', 'AbortError')); return new Promise(() => {}) }
  await assert.rejects(load('llm-execution.ts').executeTrackedText({ ...ctx, companyId: 'company-a', role: 'support' }, 'responses', { input: 'hello' }, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(sent.length, 0)
  assert.equal(inserts.length, 0)
})


for (const model of ['qwen-image-plus', 'wanx-v1']) test('deep-1: gateway DashScope cancellation and completed-image storage failure never replay: ' + model, async () => {
  const gateway = gatewayFixture([model, 'gpt-image-2'])
  gateway.sub.listKeyModelsWithStatus = async (_base: string, key: string) => ({ models: new Set(key === 'gateway-key' ? [model, 'gpt-image-2'] : []), ok: true, status: 'success' })
  settings.image_model = model
  settings.image_fallback_models = 'gpt-image-2'
  await refreshServerSettings(true)
  await warmGatewayCatalog()
  let sends = 0, stores = 0, cancel = true
  const controller = new AbortController()
  setSdkClientFactory(() => ({ images: { generate: async (_body: any, options: any) => {
    sends++
    if (cancel) return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      queueMicrotask(() => controller.abort(new DOMException('Cancelled', 'AbortError')))
    })
    return { data: [{ b64_json: Buffer.from('image').toString('base64') }], usage: { input_tokens: 5, output_tokens: 8 } }
  } } }))
  const executeImage = load('llm.ts').executeImage
  const store = async () => { stores++; throw new Error('storage failed') }
  await assert.rejects(executeImage({ companyId: 'company-a', purpose: 'agent-image' }, { prompt: 'test', size: '1024x1024' }, store, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(sends, 1)
  assert.equal(stores, 0)
  assert.equal(extras(inserts.at(-1)).stopReason, 'cancelled')
  cancel = false
  await assert.rejects(executeImage({ companyId: 'company-a', purpose: 'agent-image' }, { prompt: 'test', size: '1024x1024' }, store), /storage failed/)
  assert.equal(sends, 2)
  assert.equal(stores, 1)
  const row = extras(inserts.at(-1))
  assert.equal(row.generationCompleted, true)
  assert.equal(row.failureStage, 'storage')
  assert.deepEqual(row.rawUsage, { input_tokens: 5, output_tokens: 8 })
  assert.equal(row.nextCandidate, null)
})

for (const domain of ['managed', 'byoa'] as const) {
  test(`cerebellum priority: agent > computer > role > env (${domain})`, async () => {
    const resolver = load('llm-resolver.ts')
    const snapshot = load('settings.ts').getServerSettingsSnapshot()
    const resolve = (agent: any, captured = snapshot) => resolver.resolveRoleCall(null, domain, 'support', 'agenda', agent, captured)
    const agent = { model: 'local-main', modelConfig: { cerebellumModel: ' cloud-small ', effort: 'high', fallbackModels: ['brain-only'] }, computerSupportModel: 'computer-small' }
    const explicit = await resolve(agent)
    assert.equal(explicit.candidates[0].model, 'cloud-small')
    assert.equal(explicit.candidates[0].source, 'agent')
    assert.ok(!explicit.candidates.some((c: any) => c.model === 'brain-only'))
    const computer = await resolve({ computerSupportModel: 'computer-small' })
    assert.equal(computer.candidates[0].model, 'computer-small')
    assert.equal(computer.candidates[0].source, 'computer')
    assert.equal((await resolve({})).candidates[0].model, 'same')
    const configured = { ...snapshot, settings: { ...snapshot.settings, llm_config: JSON.stringify({ version: 1, roles: [{ role: 'support', models: ['global-small'] }] }) } }
    assert.equal((await resolve({}, configured)).candidates[0].model, 'global-small')
    assert.equal((await resolve(agent, configured)).candidates[0].model, 'cloud-small')
    assert.equal((await resolve({ computerSupportModel: 'computer-small' }, configured)).candidates[0].model, 'computer-small')
    const brain = await resolver.resolveRoleCall(null, domain, 'brain', 'agent-turn', agent, snapshot)
    if (domain === 'byoa') assert.equal(brain.candidates.length, 0)
    else assert.equal(brain.candidates[0].model, 'local-main')
    settings = {}
    await refreshServerSettings(true)
    const envPlan = await resolve({}, load('settings.ts').getServerSettingsSnapshot())
    assert.equal(envPlan.candidates[0].model, 'same')
    assert.match(envPlan.candidates[0].source, /env/)
  })
}

for (const purpose of ['inbox-triage', 'agenda', 'synthetic-wake-gate', 'palette', 'gender']) {
  test(`${purpose} executes the tenant-scoped agent cerebellum model`, async () => {
    const originalQuery = pool.query
    let pin = 'agent-small'
    pool.query = async (sql, values) => {
      if (sql.includes('SELECT p.model_config')) {
        assert.deepEqual(values, ['agent-a', 'company-a'])
        assert.match(sql, /p.company_id = \$2/)
        return { rows: [{ model_config: { cerebellumModel: pin }, computer_support_model: 'computer-small' }] }
      }
      return originalQuery(sql, values)
    }
    const client = await getTrackedLlmClient({ role: 'support', purpose, companyId: 'company-a', agentId: 'agent-a' })
    await client.responses.create({ model: 'same', input: 'classify', max_output_tokens: 100 })
    assert.equal(sent[0].args.model, 'agent-small')
    pin = ''
    await client.responses.create({ model: 'same', input: 'classify', max_output_tokens: 100 })
    assert.equal(sent[1].args.model, 'computer-small')
  })
}

for (const classifier of ['inbox', 'agenda', 'synthetic']) {
  test(`real ${classifier} classifier uses the agent cloud model through the executor`, async () => {
    const originalQuery = pool.query
    pool.query = async (sql, values) => sql.includes('SELECT p.model_config')
      ? { rows: [{ model_config: { cerebellumModel: 'classifier-small' }, computer_support_model: null }] }
      : originalQuery(sql, values)
    create = async () => ({ ...success('classifier-small'), output_text: JSON.stringify({ actionable: false, act: false, focus: '', reason: 'quiet', note: '', promptNote: '' }) })
    const persona = { id: 'agent-a', name: 'Atlas', role: 'Ops', style: '', model: null, companyId: 'company-a' }
    if (classifier === 'agenda') {
      await load('agents/agenda.ts').classifyAgendaActionable({ agentId: persona.id, companyId: persona.companyId, persona,
        agenda: { cards: [{ id: 'card-a', board_id: 'b', board_title: 'Ops', column_id: 'todo', column_title: 'Todo', title: 'Review', description: null, assignee_id: persona.id, mentions: [], updated_at: '2026-09-11T00:00:00Z' }], events: [], stalls: [] } })
    } else if (classifier === 'synthetic') {
      await load('agents/inbox-triage.ts').gateSyntheticWake({ agentId: persona.id, companyId: persona.companyId, personaName: persona.name, kind: 'idle', brief: 'review', signals: 'due' })
    } else {
      const row = { id: 'message-a', conversation_id: 'group-a', company_id: persona.companyId, conversation_title: 'Team', conversation_kind: 'group', author_id: 'agent-b', author_kind: 'agent', author_name: 'Bob', body: 'team, please each weigh in', kind: 'text', sequence: 1, created_at: '2026-09-11T00:00:00Z' }
      await load('agents/inbox-triage.ts').classifyInboxTriage({ agentId: persona.id, companyId: persona.companyId, persona, inbox: [row], context: [{ ...row, is_unread: true, is_self: false, reactions: [] }] })
    }
    assert.equal(sent.length, 1, 'classifier must reach the real executor')
    assert.equal(sent[0].args.model, 'classifier-small')
  })
}
