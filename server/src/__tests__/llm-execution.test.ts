import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Compile the real module graph; only external state is replaced. Unknown imports fail closed.
const nativeRequire = createRequire(import.meta.url)
let clientFactory: (() => any) | null = null
const RealOpenAI = nativeRequire('openai')
const FixtureOpenAI = new Proxy(RealOpenAI, {
  construct(target, args) { return clientFactory ? clientFactory() : Reflect.construct(target, args) },
})
function setSdkClientFactory(factory: (() => any) | null) { clientFactory = factory }
const allowed = new Set([
  'llm-execution.ts', 'llm.ts', 'llm-resolver.ts', 'settings.ts', 'env.ts',
  'managed-pod-settings.ts', 'tenant-llm-context.ts', 'sub2api.ts', 'novita.ts',
  'model-pricing.ts', 'agents/llm-ledger.ts', 'agents/cost.ts', 'agents/token-usage.ts',
  'agents/fallback.ts', 'agents/model-config.ts',
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
function load(relative: string): any {
  if (relative === 'db/pool.ts') return { pool }
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
    if (name === 'node:crypto') return nativeRequire(name)
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
test('empty plan, validation and client preparation failures create no invented rows', async () => {
  await assert.rejects(execute(()=>{}, {plan:plan([])}),/empty/)
  await assert.rejects(execute(()=>{}, {prepare:async()=>{throw httpError(401)}}))
  const unavailable=plan(); unavailable.candidates[0].available=false
  await assert.rejects(execute(()=>{}, {plan:unavailable}),/unavailable/)
  assert.equal(inserts.length,0); assert.equal(sent.length,0)
})
test('programming, local request and arbitrary no-status errors do not advance', async () => {
  for(const err of [new TypeError('bug'),new Error('oops'),new SyntaxError('JSON'),httpError(400),httpError(404),Object.assign(new Error('cancel'),{name:'APIUserAbortError'})]) {
    const count=inserts.length
    await assert.rejects(execute(()=>{throw err}),e=>e===err)
    assert.equal(inserts.length,count+1)
    assert.equal(extras(inserts.at(-1)).nextCandidate,null)
  }
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
test('cancel while preparing next candidate issues no next request or row', async () => {
  const abort=new AbortController()
  await assert.rejects(execute(()=>{}, {signal:abort.signal, prepare:async (c: any)=> {if(c.model==='b')abort.abort();return async()=>{sent.push(c.model);throw httpError(429)}}}))
  assert.deepEqual(sent,['a']); assert.equal(inserts.length,1)
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
  assert.equal(getLlmLedgerHealth().droppedCalls,before+1)
  assert.ok(getLlmLedgerHealth().lastDropAt)
  assert.equal(sent.length,1)
})
test('Responses-to-Chat rejects unportable state before sending and translates JSON schema',async()=>{
  settings.llm_config=JSON.stringify({version:1,models:[{model:'same',protocol:'chat'}]})
  await refreshServerSettings(true)
  const client=await getTrackedLlmClient(ctx)
  await assert.rejects(client.responses.create({model:'same',input:'hi',previous_response_id:'old'}),/Stateful/)
  assert.equal(sent.length,0);assert.equal(inserts.length,0)
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
  assert.equal(sent.length,0);assert.equal(inserts.length,0)
  await client.responses.create({model:'same',input:'hi'})
  assert.equal(sent[0].args.model,'palette-main')
})
for(const status of [401,403,429]) test(`real SDK with in-memory fetch: ${status} -> success records exactly two requests`,async()=>{
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
