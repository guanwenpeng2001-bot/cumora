import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { priceUsage, fixed, decimal, type PriceVersion } from '../models/pricing.js'
import { DurableOutbox } from '../models/durable-outbox.js'
import { withCallTrace, tracedFetch } from '../models/trace.js'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const usage = { inputTokens: 1000000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 }
const price: PriceVersion = { id: 'p1',currency:'USD',unit_schema:{unit:'token'},rates:{input:'0.1',output:'2',cache_read:'0.01',cache_write:'0.2'} }
test('versioned pricing preserves unknown rather than zero and all unpriced categories', () => {
  assert.deepEqual(priceUsage(price,null),{amount:null,reason:'usage_unavailable'})
  assert.equal(priceUsage(null,usage).reason,'no_price')
  assert.equal(priceUsage(price,{...usage,inputTokens:-1}).reason,'invalid_usage')
  assert.equal(priceUsage(price,{...usage,inputTokens:2147483648}).reason,'invalid_usage')
  assert.equal(priceUsage({...price,unit_schema:{unit:'second'}},usage).reason,'unit_quantity_unavailable')
  assert.equal(priceUsage({...price,unit_schema:{unit:'unsupported'}},usage).reason,'unsupported_billing_unit')
  assert.equal(priceUsage({...price,rates:{}},usage).reason,'price_version_missing')
  assert.equal(priceUsage(price,usage,null,true).reason,'external_subscription')
  assert.equal(priceUsage(price,usage).amount,'0.100000000000')
  assert.equal(priceUsage(price,{...usage,inputTokens:0}).amount,'0.000000000000')
  assert.equal(decimal(fixed('0.1')+fixed('0.2')),'0.300000000000')
})
test('context tiers and media quantities use the version snapshot and actual units', () => {
  assert.equal(priceUsage({...price,unit_schema:{unit:'token',tiers:[{upTo:100,rates:{input:'1'}},{upTo:null,rates:{input:'3'}}]}},usage).amount,'3.000000000000')
  assert.equal(priceUsage({...price,unit_schema:{unit:'second'},rates:{unit:'0.002'}},null,{unit:'second',quantity:1.5}).amount,'0.003000000000')
  assert.equal(priceUsage({...price,unit_schema:{unit:'second'},rates:{unit:'1'}},null,{unit:'second',quantity:1/44100}).amount,'0.000022675737')
  assert.equal(priceUsage({...price,unit_schema:{unit:'image'},rates:{unit:'1'}},null,{unit:'image',quantity:0.5}).reason,'invalid_usage')
})
test('BYOA durable event survives restart and repeated delivery until an explicit ACK', () => {
  const dir=mkdtempSync(join(tmpdir(),'cumora-event-test-'))
  try {
    const first=new DurableOutbox<{event:string}>(dir)
    const id=first.put({event:'stable'})
    const restarted=new DurableOutbox<{event:string}>(dir)
    assert.deepEqual(restarted.entries(),[{id,payload:{event:'stable'}}])
    assert.equal(restarted.entries().length,1)
    restarted.ack(id); restarted.ack(id)
    assert.equal(restarted.entries().length,0)
    assert.equal(readdirSync(dir).length,0)
    assert.throws(()=>new DurableOutbox(dir,1).put({event:'too large'}),/outbox full/)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
test('trace headers follow one HTTP attempt and capture gateway receipt IDs',async()=>{
  const trace={traceId:randomUUID(),attemptId:randomUUID(),gatewayRequestId:undefined as string|undefined}
  const server=createServer((req,res)=>{
    assert.equal(req.headers['x-cumora-attempt-id'],trace.attemptId)
    assert.match(String(req.headers.traceparent),/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/)
    res.setHeader('x-request-id','gateway-evidence');res.end('ok')
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    const address=server.address() as {port:number}
    const response=await withCallTrace(trace,()=>tracedFetch(`http://127.0.0.1:${address.port}/`))
    await response.text();assert.equal(trace.gatewayRequestId,'gateway-evidence')
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()))}
})
test('directory failures remain enrichment failures and cannot veto an explicitly configured env identity',async()=>{
  const {identifyAttempt}=await import('../models/ledger.js')
  const statements:string[]=[]
  const client={query:async(sql:string)=>{
    statements.push(sql)
    if(sql.includes('FROM model_offerings')) throw new Error('directory unavailable')
    return {rows:[]}
  }} as unknown as import('pg').PoolClient
  const identity=await identifyAttempt({companyId:null,purpose:'agent-turn',model:'selected',status:'ok',latencyMs:0,
    extras:{routeKind:'direct',route:'custom-route',envSlot:'text',requestModel:'actual-request'}},client)
  assert.equal(identity.source_kind,'env');assert.equal(identity.source_id,'env:text');assert.equal(identity.offering_id,null)
  assert.ok(statements.includes('ROLLBACK TO SAVEPOINT ledger_catalog'))
})
