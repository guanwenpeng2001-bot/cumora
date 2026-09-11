import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import type { LlmCallRecord } from '../agents/llm-ledger.js'
import type { LlmCallContext } from '../agents/llm-ledger.js'
import { DurableOutbox } from './durable-outbox.js'
import { priceUsage, fixed, type PriceVersion } from './pricing.js'
import { endpointProvider } from './sources/env.js'
import { resolveDirectLlmEnv, type DirectLlmSlot } from '../env.js'

export interface AttemptIdentity {
  attempt_id: string; logical_call_id: string; trace_id: string; attempt_no: number
  source_kind: 'sub2api' | 'env' | 'byoa'; source_id: string; provider_id: string | null
  publisher_id: string | null
  requested_model: string; request_model: string; route_id: string | null; platform: string | null
  offering_id: string | null; canonical_model_id: string | null; catalog_revision: string | null
  billing_subject_id: string | null; occurred_at: string; price_snapshot: PriceVersion | null
  computer_id?: string | null; engine_session_id?: string | null; event_id?: string | null
}
type FinalEvent = { identity: AttemptIdentity; record: LlmCallRecord }
const outbox = new DurableOutbox<FinalEvent>(process.env.CUMORA_SETTLEMENT_OUTBOX_DIR || resolve('server/uploads/.llm-settlement'))
const instanceId = randomUUID()

/** Callers supply routing evidence, never guessed model-family identities. Missing catalog rows
 * stay unresolved and unpriced. A missing directory entry cannot veto an env fallback. */
export async function identifyAttempt(rec: LlmCallRecord, client: PoolClient): Promise<AttemptIdentity> {
  const e = rec.extras ?? {}
  const byoa = rec.source?.startsWith('byoa-') === true
  const kind = byoa ? 'byoa' : e.routeKind === 'gateway' ? 'sub2api' : 'env'
  const route = typeof e.route === 'string' ? e.route : null
  const slot = (typeof e.envSlot === 'string' ? e.envSlot : route?.startsWith('direct:') ? route.slice(7) : rec.purpose === 'embedding' ? 'embed' : 'text') as DirectLlmSlot
  const source = byoa ? `byoa:${String(e.computerId)}` : kind === 'sub2api' ? 'sub2api' : `env:${slot}`
  const request = typeof e.requestModel === 'string' ? e.requestModel : rec.model
  const platform = typeof e.platform === 'string' ? e.platform : kind === 'env' ? endpointProvider(resolveDirectLlmEnv(slot).baseURL) : null
  const occurred = typeof e.occurredAt === 'string' ? e.occurredAt : new Date().toISOString()
  let offering: {id:string;model_id:string;revision:string;provider_id:string;publisher_id:string|null}|null=null
  let price:PriceVersion|null=null
  // Catalog metadata is enrichment, never an authorization prerequisite for env.
  // A short savepoint isolates a missing/slow directory from the required ledger write.
  await client.query('SAVEPOINT ledger_catalog')
  try {
    await client.query("SET LOCAL statement_timeout='500ms'")
    const { rows } = await client.query(`SELECT o.id,o.model_id,o.revision,d.provider_id,d.publisher_id FROM model_offerings o
    JOIN model_definitions d ON d.id=o.model_id WHERE o.source_id=$1 AND o.request_model=$2
    AND ($3::text IS NULL OR o.platform=$3) AND ($4::text IS NULL OR o.protocol=$4)
    AND (o.engine IS NOT DISTINCT FROM $5::text) AND (o.profile IS NOT DISTINCT FROM $6::text) LIMIT 2`,
  [source, request, platform, byoa ? 'engine' : e.protocol ?? null, byoa ? rec.source!.slice(5) : null, e.profileRef ?? null])
    offering = rows.length === 1 ? rows[0] : null
    const prices = offering ? await client.query<PriceVersion>(`SELECT * FROM model_pricing_versions WHERE offering_id=$1
    AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2) ORDER BY effective_from DESC LIMIT 1`, [offering.id, occurred]) : null
    price=prices?.rows[0] ?? null
  } catch {
    // Any directory/price-metadata failure is non-authoritative. If the database
    // itself is unavailable, restoring this savepoint/the required INSERT fails closed.
    offering=null;price=null
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT ledger_catalog')
    await client.query('RELEASE SAVEPOINT ledger_catalog')
  }
  const owner = rec.companyId ? (await client.query('SELECT owner_user_id FROM companies WHERE id=$1', [rec.companyId])).rows[0]?.owner_user_id ?? null : null
  return { attempt_id: typeof e.attemptId === 'string' ? e.attemptId : randomUUID(), logical_call_id: String(e.logicalCallId ?? e.callId ?? randomUUID()),
    trace_id: String(e.traceId ?? randomUUID()), attempt_no: Number(e.attempt ?? 1), source_kind: kind, source_id: source,
    provider_id: offering?.provider_id ?? (kind === 'env' ? platform : null), publisher_id:offering?.publisher_id ?? null,
    requested_model: String(e.requestedModel ?? rec.model), request_model: request,
    route_id: route, platform, offering_id: offering?.id ?? null, canonical_model_id: offering?.model_id ?? null, catalog_revision: offering?.revision ?? null,
    billing_subject_id: owner, occurred_at: occurred, price_snapshot: price,
    computer_id: byoa ? String(e.computerId) : null, engine_session_id: byoa ? String(e.engineSessionId ?? rec.runId ?? 'legacy') : null,
    event_id: typeof e.eventId === 'string' ? e.eventId : null }
}
function columns(identity: AttemptIdentity, rec: LlmCallRecord, started: boolean): Record<string, unknown> {
  const e = rec.extras ?? {}, byoa = identity.source_kind === 'byoa'
  const valid = rec.usage && [rec.usage.inputTokens, rec.usage.cachedInputTokens, rec.usage.cacheCreationTokens, rec.usage.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647)
  const cost = priceUsage(identity.price_snapshot, rec.usage, rec.units, byoa)
  const actual = typeof e.actualModel === 'string' && e.actualModel ? e.actualModel : null
  const status = started ? 'started' : e.failureReason === 'cancelled' ? 'cancelled' : rec.status === 'ok' ? 'succeeded' : e.outputCommitted ? 'partial' : 'failed'
  return { id: `llm-${identity.attempt_id}`, company_id: rec.companyId, agent_id: rec.agentId ?? null, run_id: rec.runId ?? null,
    conversation_id: rec.conversationId ?? null, purpose: rec.purpose, source: rec.source ?? 'cloud', model: actual ?? identity.request_model,
    input_tokens: valid ? rec.usage!.inputTokens : 0, cached_input_tokens: valid ? rec.usage!.cachedInputTokens : 0,
    cache_creation_tokens: valid ? rec.usage!.cacheCreationTokens : 0, output_tokens: valid ? rec.usage!.outputTokens : 0,
    reasoning_tokens: Number.isSafeInteger(rec.reasoningTokens) && rec.reasoningTokens! >= 0 ? rec.reasoningTokens : 0,
    cost_usd: cost.amount ?? '0', cost_estimated: true, measured: Boolean(valid || rec.units), latency_ms: rec.latencyMs,
    status, error: rec.error?.slice(0, 500) ?? null, extras: JSON.stringify({ ...e, ledgerInstance: instanceId, rawUsage: undefined, usage: valid ? rec.usage : null,
      pricing: identity.price_snapshot, units: rec.units ?? null, unpriced: cost.reason, measurement: valid ? 'measured' : 'unknown' }),
    daemon_version: rec.daemonVersion ?? null, ...identity, price_snapshot: identity.price_snapshot ? JSON.stringify(identity.price_snapshot) : null,
    schema_version: 2, actual_model: actual, actual_model_state: actual ? 'reported' : 'not_reported',
    attempt_no: e.recordKind === 'decision' ? 0 : identity.attempt_no,
    gateway_request_id: identity.source_kind === 'sub2api' ? e.gatewayRequestId ?? null : null,
    upstream_request_id: identity.source_kind === 'env' ? e.upstreamRequestId ?? e.gatewayRequestId ?? null : e.upstreamRequestId ?? null,
    record_kind: e.recordKind === 'decision' ? 'decision' : 'attempt', observation_granularity: byoa && e.observationGranularity !== 'provider_request' ? 'engine_turn' : 'provider_request',
    capability: rec.purpose === 'embedding' ? 'embed' : rec.purpose === 'audio-transcription' ? 'audio' : rec.purpose.includes('image') ? 'image' : 'text',
    role: rec.role ?? e.role ?? null, execution_location: byoa ? 'computer' : 'server', engine: byoa ? rec.source!.slice(5) : null,
    profile_ref: e.profileRef ?? null, actor_user_id: e.actorUserId ?? null,
    // Legacy routing still executes in P2. Its revision is not a binding/tier revision.
    mapping_revision: e.revision ?? null, binding_revision: null, entitlement_revision: null,
    failure_stage: e.failureStage ?? null, error_origin: byoa ? 'daemon_reported' : e.failureStage === 'prepare' ? 'cumora' : 'upstream',
    reason_code: e.failureReason ?? null, http_status: Number.isInteger(e.httpStatus) && Number(e.httpStatus)>=100 && Number(e.httpStatus)<=599 ? e.httpStatus : null,
    dispatched_at: e.recordKind === 'decision' || byoa ? null : identity.occurred_at,
    finished_at: started ? null : byoa ? identity.occurred_at : new Date().toISOString(),
    output_committed: e.outputCommitted === true, units: rec.units ? JSON.stringify(rec.units) : null,
    usage_state: started ? 'unknown' : valid ? 'reported' : rec.units ? 'partial' : 'unknown',
    usage_provenance: byoa ? 'daemon_reported' : 'provider_reported',
    // Persist only normalized metering, never an arbitrary upstream response body.
    raw_usage: valid ? JSON.stringify(rec.usage) : null,
    reference_cost_usd: started ? null : cost.amount, upstream_cost_usd: null, quota_debit: byoa ? '0' : null,
    price_version_id: identity.price_snapshot?.id ?? null, currency: identity.price_snapshot?.currency ?? 'USD',
    pricing_state: byoa ? 'external' : cost.amount === null ? 'unpriced' : 'priced',
    unpriced_reason: !identity.offering_id && !byoa && cost.reason === 'no_price' ? 'unknown_alias' : cost.reason,
    settlement_state: started ? 'pending' : byoa ? 'external' : 'pending' }
}
async function write(client: PoolClient, identity: AttemptIdentity, rec: LlmCallRecord, started: boolean): Promise<void> {
  const row = columns(identity, rec, started), keys = Object.keys(row)
  if (started || identity.event_id) {
    // One cumora→gateway HTTP request is one main attempt. Gateway account retries
    // are child evidence; never call this INSERT for gateway receipts.
    await client.query(`INSERT INTO llm_calls(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`, Object.values(row))
  } else {
    const mutable = keys.filter(k => !['id', 'attempt_id', 'occurred_at', 'company_id'].includes(k))
    const receiptField: Record<string,string> = { model:'actualModel',actual_model:'actualModel',actual_model_state:'actualModel',provider_id:'providerId',upstream_cost_usd:'upstreamCostUsd',settlement_state:'upstreamCostUsd',
      input_tokens:'usage',cached_input_tokens:'usage',cache_creation_tokens:'usage',output_tokens:'usage',usage_state:'usage',usage_provenance:'usage',reference_cost_usd:'usage',pricing_state:'usage',unpriced_reason:'usage' }
    const result=await client.query(`UPDATE llm_calls SET ${mutable.map((k, i) => `${k}=${receiptField[k] ? `CASE WHEN EXISTS(SELECT 1 FROM llm_gateway_receipts r WHERE r.attempt_id=llm_calls.attempt_id AND r.evidence ? '${receiptField[k]}') THEN ${k} ELSE $${i + 1} END` : `$${i + 1}`}`).join(',')}
      WHERE attempt_id=$${mutable.length + 1} AND schema_version=2 AND status IN ('started','indeterminate')`, [...mutable.map(k => row[k]), identity.attempt_id])
    if(result.rowCount===0 && !(await client.query('SELECT id FROM llm_calls WHERE attempt_id=$1 AND schema_version=2',[identity.attempt_id])).rows.length) throw new Error('started attempt missing; final event retained for reconciliation')
  }
}
export async function startAttempt(rec: LlmCallRecord): Promise<AttemptIdentity> {
  outbox.ready()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO llm_ledger_instances(id) VALUES($1) ON CONFLICT(id) DO NOTHING', [instanceId])
    const identity = await identifyAttempt(rec, client)
    await write(client, identity, rec, true)
    await client.query('COMMIT')
    return identity
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}
export async function recordRejectedDecision(context:LlmCallContext,reason:string,requestedModel:string|null,logicalCallId:string=randomUUID()):Promise<void> {
  const id=randomUUID()
  await pool.query(`INSERT INTO llm_calls(id,company_id,agent_id,run_id,purpose,model,measured,status,schema_version,
    attempt_id,logical_call_id,trace_id,attempt_no,record_kind,requested_model,usage_state,pricing_state,unpriced_reason,
    failure_stage,reason_code,settlement_state,finished_at,role)
    VALUES($1,$2,$3,$4,$5,$6,FALSE,'rejected',2,$7,$8,$8,0,'decision',$6,'unknown','unpriced','usage_unavailable','prepare',$9,'not_applicable',NOW(),$10)`,
  [`llm-${id}`,context.companyId,context.agentId ?? null,context.runId ?? null,context.purpose,requestedModel ?? '<unselected>',id,logicalCallId,reason,context.role ?? null])
}
export async function applyFinal(event: FinalEvent, connection?: PoolClient): Promise<void> {
  const client = connection ?? await pool.connect()
  try {
    if (!connection) await client.query('BEGIN')
    await write(client, event.identity, event.record, false)
    await client.query('DELETE FROM llm_settlement_outbox WHERE attempt_id=$1', [event.identity.attempt_id])
    if (!connection) await client.query('COMMIT')
  } catch (e) { if (!connection) await client.query('ROLLBACK'); throw e } finally { if (!connection) client.release() }
}
export async function finishAttempt(identity: AttemptIdentity, record: LlmCallRecord): Promise<{pendingSettlement:boolean}> {
  // Journal BEFORE final SQL; DB outage and process termination during SQL are both replayable.
  const allowed=['logicalCallId','attemptId','traceId','attempt','role','purpose','requestedModel','requestModel','actualModel','route','routeKind','envSlot','platform','protocol','plannedProtocol','usageProtocol',
    'revision','authorizationVersion','contextWindow','contextWindowSource','failureStage','httpStatus','failureReason','nextCandidate','nextCandidateReason','stopReason',
    'sdkMaxRetries','sdkRetryPolicy','sdkRetriesIndividuallyObservable','outputCommitted','recordKind','gatewayRequestId','upstreamRequestId','actorUserId']
  const extras=Object.fromEntries(allowed.filter(key=>record.extras?.[key]!==undefined).map(key=>[key,record.extras![key]]))
  const event = { identity, record: { ...record, error: record.error ? String(extras.failureReason ?? record.status) : null, extras } }, id = outbox.put(event)
  try {
    await pool.query('INSERT INTO llm_settlement_outbox(attempt_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING',[identity.attempt_id,JSON.stringify(event)])
    await applyFinal(event); outbox.ack(id)
    return {pendingSettlement:false}
  } catch {
    console.warn('[llm-ledger] pendingSettlement; durable final event queued', identity.attempt_id)
    return {pendingSettlement:true}
  }
}
export async function recordByoaEvent(record: LlmCallRecord, client: PoolClient): Promise<void> {
  const identity = await identifyAttempt(record, client)
  await write(client, identity, record, false)
}
let replaying = false
export async function replaySettlements(): Promise<number> {
  if (replaying) return 0
  replaying = true
  let count = 0
  try {
    for (const event of outbox.entries()) { await applyFinal(event.payload); outbox.ack(event.id); count++ }
    const events=await pool.query<{payload:FinalEvent}>('SELECT payload FROM llm_settlement_outbox ORDER BY created_at LIMIT 100')
    for(const {payload} of events.rows) {await applyFinal(payload);count++}
    return count
  } finally { replaying = false }
}
export function startSettlementWorker(): void {
  const tick = () => { void (async () => {
    await pool.query('INSERT INTO llm_ledger_instances(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET last_seen_at=NOW()', [instanceId])
    await replaySettlements()
    await reconcileIndeterminate()
  })().catch(() => console.warn('[llm-ledger] settlement recovery pending')) }
  tick()
  setInterval(tick, 10_000).unref()
}
export async function reconcileIndeterminate(): Promise<number> {
  const result = await pool.query(`UPDATE llm_calls l SET status='indeterminate',settlement_state='pending',
    usage_state='unknown',reference_cost_usd=NULL,upstream_cost_usd=NULL,quota_debit=NULL
    FROM llm_ledger_instances i WHERE l.status='started' AND l.extras->>'ledgerInstance'=i.id
    AND i.last_seen_at < NOW()-INTERVAL '2 minutes'`)
  return result.rowCount ?? 0
}

/** Trusted gateway adapter only (P4 supplies its authenticated transport/cursor).
 * A receipt enriches the existing HTTP attempt; internal account retries are child evidence.
 * Never accept this function's inputs from a BYOA runtime or public usage endpoint. */
export async function applyGatewayReceipt(receipt: { attemptId:string; gatewayRequestId:string; eventVersion:number;
  actualModel?:string; providerId?:string; upstreamCostUsd?:string; usage?:LlmCallRecord['usage'] }): Promise<boolean> {
  if(!Number.isSafeInteger(receipt.eventVersion) || receipt.eventVersion<1) throw new Error('invalid receipt version')
  if(receipt.upstreamCostUsd!==undefined) fixed(receipt.upstreamCostUsd)
  if(receipt.usage && !Object.values(receipt.usage).every(n=>Number.isSafeInteger(n) && n>=0 && n<=2147483647)) throw new Error('invalid receipt usage')
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    const {rows}=await client.query("SELECT * FROM llm_calls WHERE attempt_id=$1 AND source_kind='sub2api' FOR UPDATE",[receipt.attemptId])
    const attempt=rows[0]
    if(!attempt || attempt.gateway_request_id && attempt.gateway_request_id!==receipt.gatewayRequestId) throw new Error('receipt attempt mismatch')
    const latest=await client.query('SELECT MAX(event_version)::text AS version FROM llm_gateway_receipts WHERE gateway_request_id=$1',[receipt.gatewayRequestId])
    if(Number(latest.rows[0]?.version ?? 0)>=receipt.eventVersion) {await client.query('COMMIT');return false}
    await client.query('INSERT INTO llm_gateway_receipts(attempt_id,gateway_request_id,event_version,evidence) VALUES($1,$2,$3,$4)',[receipt.attemptId,receipt.gatewayRequestId,receipt.eventVersion,JSON.stringify(receipt)])
    const cost=receipt.usage ? priceUsage(attempt.price_snapshot,receipt.usage) : null
    await client.query(`UPDATE llm_calls SET gateway_request_id=$2,actual_model=COALESCE($3,actual_model),model=COALESCE($3,model),
      actual_model_state=CASE WHEN $3::text IS NOT NULL THEN 'reported' ELSE actual_model_state END,
      provider_id=COALESCE($4,provider_id),upstream_cost_usd=COALESCE($5::numeric,upstream_cost_usd),
      input_tokens=COALESCE($6::int,input_tokens),cached_input_tokens=COALESCE($7::int,cached_input_tokens),
      cache_creation_tokens=COALESCE($8::int,cache_creation_tokens),output_tokens=COALESCE($9::int,output_tokens),
      usage_state=CASE WHEN $6::int IS NOT NULL THEN 'reported' ELSE usage_state END,
      usage_provenance='gateway_reported',reference_cost_usd=CASE WHEN $6::int IS NOT NULL THEN $10::numeric ELSE reference_cost_usd END,
      cost_usd=CASE WHEN $10::numeric IS NOT NULL THEN $10::numeric ELSE cost_usd END,measured=CASE WHEN $6::int IS NOT NULL THEN TRUE ELSE measured END,
      pricing_state=CASE WHEN $6::int IS NULL THEN pricing_state WHEN $10::numeric IS NULL THEN 'unpriced' ELSE 'priced' END,
      unpriced_reason=CASE WHEN $6::int IS NOT NULL THEN $11 ELSE unpriced_reason END,
      settlement_state=CASE WHEN $5::numeric IS NOT NULL THEN 'reconciled' ELSE settlement_state END
      WHERE attempt_id=$1`,[receipt.attemptId,receipt.gatewayRequestId,receipt.actualModel ?? null,receipt.providerId ?? null,receipt.upstreamCostUsd ?? null,
      receipt.usage?.inputTokens ?? null,receipt.usage?.cachedInputTokens ?? null,receipt.usage?.cacheCreationTokens ?? null,receipt.usage?.outputTokens ?? null,cost?.amount ?? null,cost?.reason ?? null])
    await client.query('COMMIT');return true
  } catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
