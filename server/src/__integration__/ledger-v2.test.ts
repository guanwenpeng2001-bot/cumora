import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce } from './_helpers.js'
import type { LlmCallRecord } from '../agents/llm-ledger.js'

const dir=mkdtempSync(join(tmpdir(),'cumora-ledger-v2-'))
process.env.CUMORA_SETTLEMENT_OUTBOX_DIR=dir
const ledger=await import('../models/ledger.js')
const { refreshLlmRollupV3 }=await import('../models/rollup.js')
const { usageSummary,usageBySource,usageByModel,usageLogs }=await import('../usage.js')
const company=`wave-b-${randomUUID()}`
const hour=new Date();hour.setUTCHours(hour.getUTCHours()-5,0,0,0)
const range={from:hour,to:new Date(hour.getTime()+3600000)}
const record=(extra:Record<string,unknown>={}):LlmCallRecord=>({companyId:company,purpose:'agent-turn',model:'request-name',status:'ok',latencyMs:10,
  usage:{inputTokens:10,cachedInputTokens:0,cacheCreationTokens:0,outputTokens:2},
  extras:{routeKind:'direct',route:'direct:text',protocol:'responses',requestedModel:'selection-name',requestModel:'request-name',occurredAt:new Date(hour.getTime()+1000).toISOString(),...extra}})
before(async()=>{await ensureSchemaOnce()})
after(async()=>{await pool.query('DELETE FROM llm_calls WHERE company_id=$1',[company]);await pool.query('DELETE FROM llm_calls_rollup_v3 WHERE company_id=$1',[company]);await pool.end();rmSync(dir,{recursive:true,force:true})})

test('started commits before dispatch; model three states and final settlement replay are idempotent',async()=>{
  const rec=record(),identity=await ledger.startAttempt(rec)
  let row=(await pool.query('SELECT * FROM llm_calls WHERE attempt_id=$1',[identity.attempt_id])).rows[0]
  assert.equal(row.status,'started');assert.equal(row.reference_cost_usd,null)
  await ledger.finishAttempt(identity,rec);await ledger.finishAttempt(identity,rec)
  row=(await pool.query('SELECT * FROM llm_calls WHERE attempt_id=$1',[identity.attempt_id])).rows[0]
  assert.equal(row.status,'succeeded');assert.equal(row.requested_model,'selection-name');assert.equal(row.request_model,'request-name')
  assert.equal(row.actual_model,null);assert.equal(row.actual_model_state,'not_reported');assert.equal(row.reference_cost_usd,null)
  assert.equal(row.unpriced_reason,'unknown_alias');assert.equal(row.quota_debit,null);assert.equal(row.upstream_cost_usd,null)
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM llm_calls WHERE attempt_id=$1',[identity.attempt_id])).rows[0].n,1)
})
test('final DB outage persists outbox and recovery writes exactly once',async()=>{
  const rec=record({actualModel:'reported-name'}),identity=await ledger.startAttempt(rec)
  const query=pool.query
  pool.query=(async()=>{throw new Error('injected database outage')}) as typeof pool.query
  try {await ledger.finishAttempt(identity,rec)} finally {pool.query=query}
  assert.equal((await pool.query('SELECT status FROM llm_calls WHERE attempt_id=$1',[identity.attempt_id])).rows[0].status,'started')
  assert.equal(await ledger.replaySettlements(),1);assert.equal(await ledger.replaySettlements(),0)
  const row=(await pool.query('SELECT actual_model,actual_model_state FROM llm_calls WHERE attempt_id=$1',[identity.attempt_id])).rows[0]
  assert.equal(row.actual_model,'reported-name');assert.equal(row.actual_model_state,'reported')
})
test('expired producer lease leaves crashed started attempt indeterminate with unknown money',async()=>{
  const identity=await ledger.startAttempt(record())
  await pool.query("UPDATE llm_ledger_instances SET last_seen_at=NOW()-INTERVAL '3 minutes' WHERE id=(SELECT extras->>'ledgerInstance' FROM llm_calls WHERE attempt_id=$1)",[identity.attempt_id])
  assert.ok(await ledger.reconcileIndeterminate()>=1)
  const row=(await pool.query('SELECT status,reference_cost_usd,quota_debit FROM llm_calls WHERE attempt_id=$1',[identity.attempt_id])).rows[0]
  assert.deepEqual(row,{status:'indeterminate',reference_cost_usd:null,quota_debit:null})
})
test('gateway account retries are child evidence and receipt-before-final is not overwritten or counted twice',async()=>{
  const rec=record({routeKind:'gateway',route:'gateway:openai',platform:'openai'}),identity=await ledger.startAttempt(rec)
  const receipt={attemptId:identity.attempt_id,gatewayRequestId:randomUUID(),eventVersion:1,actualModel:'gateway-reported',providerId:'dashscope',upstreamCostUsd:'0.123456789012',usage:rec.usage}
  assert.equal(await ledger.applyGatewayReceipt(receipt),true)
  assert.equal(await ledger.applyGatewayReceipt(receipt),false)
  await ledger.finishAttempt(identity,rec)
  const rows=(await pool.query('SELECT * FROM llm_calls WHERE attempt_id=$1',[identity.attempt_id])).rows
  assert.equal(rows.length,1);assert.equal(rows[0].actual_model,'gateway-reported');assert.equal(rows[0].provider_id,'dashscope')
  assert.equal(rows[0].upstream_cost_usd,'0.123456789012');assert.equal(rows[0].quota_debit,null)
  assert.equal(await ledger.applyGatewayReceipt({...receipt,eventVersion:2,actualModel:'corrected'}),true)
  assert.equal(await ledger.applyGatewayReceipt(receipt),false)
})
test('no candidate is a decision, excluded from upstream attempt and cost counts',async()=>{
  const before=await usageSummary(company,{from:new Date(Date.now()-86400000),to:new Date(Date.now()+1000)})
  await ledger.recordRejectedDecision({companyId:company,purpose:'agent-turn'},'no_candidates',null)
  const after=await usageSummary(company,{from:new Date(Date.now()-86400000),to:new Date(Date.now()+1000)})
  assert.equal(after.requests,before.requests)
})
test('a locked model directory cannot block env ledger persistence beyond its bounded enrichment budget',async()=>{
  const client=await pool.connect()
  try {
    await client.query('BEGIN');await client.query('LOCK TABLE model_offerings IN ACCESS EXCLUSIVE MODE')
    const started=Date.now(),identity=await ledger.startAttempt(record({route:'custom-route',envSlot:'text'}))
    assert.ok(Date.now()-started<2000)
    assert.equal(identity.source_kind,'env');assert.equal(identity.source_id,'env:text');assert.equal(identity.offering_id,null)
    await client.query('ROLLBACK')
    await ledger.finishAttempt(identity,record())
  } finally {await client.query('ROLLBACK');client.release()}
})
test('BYOA event replay deduplicates and engine-turn usage is daemon reported, never an upstream bill',async()=>{
  const rec={...record({eventId:randomUUID(),computerId:'computer-test',engineSessionId:'engine-session',observationGranularity:'engine_turn'}),source:'byoa-codex' as const}
  const client=await pool.connect()
  try {await client.query('BEGIN');await ledger.recordByoaEvent(rec,client);await ledger.recordByoaEvent(rec,client);await client.query('COMMIT')}finally{client.release()}
  const rows=(await pool.query('SELECT * FROM llm_calls WHERE company_id=$1 AND event_id=$2',[company,rec.extras!.eventId])).rows
  assert.equal(rows.length,1);assert.equal(rows[0].usage_provenance,'daemon_reported');assert.equal(rows[0].observation_granularity,'engine_turn')
  assert.equal(rows[0].quota_debit,'0.000000000000');assert.equal(rows[0].upstream_cost_usd,null);assert.equal(rows[0].unpriced_reason,'external_subscription')
})
test('offering price publication closes intervals, freezes old snapshots and does not reuse bare-name prices',async()=>{
  const {publishPriceVersion,validatePricePublication}=await import('../models/pricing.js')
  const {endpointProvider}=await import('../models/sources/env.js'),{resolveDirectLlmEnv}=await import('../env.js')
  const provider=endpointProvider(resolveDirectLlmEnv('text').baseURL),id=randomUUID(),model=`priced-${id}`
  await pool.query("INSERT INTO model_sources(id,kind,revision) VALUES('env:text','env','test') ON CONFLICT DO NOTHING")
  await pool.query("INSERT INTO model_definitions(id,provider_id,canonical_name,display_name) VALUES($1,$2,$3,$3)",[id,provider,model])
  await pool.query(`INSERT INTO model_offerings(id,source_id,model_id,platform,request_model,protocol,scope_key,metadata_origin,revision)
    VALUES($1,'env:text',$1,$2,$3,'responses','','test','test')`,[id,provider,model])
  const first=await publishPriceVersion(id,validatePricePublication({effectiveFrom:new Date(Date.now()-86400000).toISOString(),unitSchema:{unit:'token'},rates:{input:'0.1',output:'0.2'}}))
  const rec={...record({envSlot:'text',route:'custom-direct-route',requestModel:model}),model,usage:{inputTokens:1000000,cachedInputTokens:0,cacheCreationTokens:0,outputTokens:0}}
  const identity=await ledger.startAttempt(rec);await ledger.finishAttempt(identity,rec)
  assert.equal(identity.source_id,'env:text');assert.equal(identity.offering_id,id)
  const before=(await pool.query('SELECT reference_cost_usd,price_snapshot FROM llm_calls WHERE attempt_id=$1',[identity.attempt_id])).rows[0]
  assert.equal(before.reference_cost_usd,'0.100000000000');assert.equal(before.price_snapshot.id,first)
  await publishPriceVersion(id,validatePricePublication({effectiveFrom:new Date().toISOString(),unitSchema:{unit:'token'},rates:{input:'0.2',output:'0.4'}}))
  const after=(await pool.query('SELECT reference_cost_usd,price_snapshot FROM llm_calls WHERE attempt_id=$1',[identity.attempt_id])).rows[0]
  assert.deepEqual(after,before)
  await assert.rejects(pool.query("UPDATE model_pricing_versions SET rates='{}' WHERE id=$1",[first]),/immutable/)
})
test('dirty rollup replaces vanished groups, uses occurred_at, and never adds raw to v3 or per-model distinct counts',async()=>{
  const logical=randomUUID()
  for(const model of ['old-a','old-b']) {const rec=record({actualModel:model,logicalCallId:logical});const identity=await ledger.startAttempt(rec);await ledger.finishAttempt(identity,rec)}
  const before=await usageSummary(company,range)
  // Process any preexisting dirty buckets as well, without assuming this test owns the queue.
  for(let i=0;i<100;i++){await refreshLlmRollupV3();if(!(await pool.query('SELECT dirty FROM llm_rollup_state_v3 WHERE bucket_hour=$1',[hour])).rows[0]?.dirty)break}
  assert.deepEqual(await usageSummary(company,range),before)
  await pool.query("UPDATE llm_calls SET actual_model='corrected',provider_id='receipt-provider' WHERE company_id=$1 AND logical_call_id=$2",[company,logical])
  assert.equal((await pool.query('SELECT dirty FROM llm_rollup_state_v3 WHERE bucket_hour=$1',[hour])).rows[0].dirty,true)
  const dirty=await usageSummary(company,range)
  await refreshLlmRollupV3()
  assert.deepEqual(await usageSummary(company,range),dirty)
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM llm_calls_rollup_v3 WHERE company_id=$1 AND model IN ('old-a','old-b')",[company])).rows[0].n,0)
  assert.ok(dirty.logicalCalls!<dirty.requests)
  const sources=await usageBySource(company,range)
  assert.equal(dirty.quotaDebit,null,'known BYOA zero must not turn pending cloud quota into an aggregate zero')
  assert.equal(sources.reduce((n,r)=>n+r.requests,0),dirty.requests)
  assert.equal((await usageSummary(company,{...range,filters:{source:'byoa'}})).requests,1)
  const logs=await usageLogs(company,range,{page:1,pageSize:100})
  assert.equal(logs.items.filter(r=>r.callId===logical).length,2)
})
test('v3 does not merge a reported model with an identical request name lacking upstream evidence',async()=>{
  const model=`evidence-${randomUUID()}`
  for(const actualModel of [null,model]) {
    const rec={...record({requestModel:model,actualModel}),model},identity=await ledger.startAttempt(record({requestModel:model,actualModel}))
    await ledger.finishAttempt(identity,rec)
  }
  await refreshLlmRollupV3()
  const groups=(await usageByModel(company,range)).filter(row=>row.model===model)
  assert.equal(groups.length,2)
  assert.deepEqual(groups.map(row=>row.actualModelState).sort(),['not_reported','reported'])
  assert.equal(groups.filter(row=>row.actualModel===null).length,1)
})
