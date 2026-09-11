import type { PoolClient } from 'pg'
import type { LlmCallRecord, LlmCallSource } from '../llm-ledger.js'
import { recordByoaEvent } from '../../models/ledger.js'
export class UsageEventRejection extends Error {
  constructor(readonly reason:string) {super(reason)}
}

export interface RuntimeUsageEvent {
  schemaVersion: 2; producerEventId: string; engineSessionId: string; occurredAt: string; daemonVersion?: string
  engine:string; profileRef:string|null
  attempts: Array<{ purpose: LlmCallRecord['purpose']; runId?: string | null; conversationId?: string | null; model: string;
    usage: LlmCallRecord['usage']; latencyMs: number; status: LlmCallRecord['status']; extras?: Record<string, unknown> }>
}
export function validateUsageEvent(value: unknown): value is RuntimeUsageEvent {
  if (!value || typeof value !== 'object') return false
  const v = value as RuntimeUsageEvent
  if (v.schemaVersion !== 2 || typeof v.producerEventId !== 'string' || !/^[a-f0-9-]{36}$/.test(v.producerEventId)
    || typeof v.engine!=='string' || !v.engine || v.engine.length>128
    || v.profileRef!==null && (typeof v.profileRef!=='string' || v.profileRef.length>256)
    || typeof v.engineSessionId !== 'string' || !v.engineSessionId || v.engineSessionId.length > 256
    || typeof v.occurredAt !== 'string' || !Number.isFinite(Date.parse(v.occurredAt)) || Date.parse(v.occurredAt) > Date.now() + 300_000
    || !Array.isArray(v.attempts) || v.attempts.length !== 1) return false
  const a = v.attempts[0]
  return !!a && typeof a.model === 'string' && a.model.length <= 256
    && ['agent-turn','inbox-triage','compaction','completion-verify','steer-summary','agenda','synthetic-wake-gate'].includes(a.purpose)
    && [a.runId, a.conversationId].every(s => s == null || typeof s === 'string' && s.length <= 256)
    && Number.isSafeInteger(a.latencyMs) && a.latencyMs >= 0 && a.latencyMs <= 2147483647
    && ['ok','failed','timeout','rate_limited'].includes(a.status)
    && (a.extras === undefined || a.extras !== null && typeof a.extras === 'object' && !Array.isArray(a.extras))
    && (a.usage == null || [a.usage.inputTokens,a.usage.cachedInputTokens,a.usage.cacheCreationTokens,a.usage.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647))
}
export async function ingestUsageEvent(event: RuntimeUsageEvent, claims: { sub: string; companyId: string; computerId?: string | null }, client: PoolClient): Promise<void> {
  const { rows } = await client.query(`SELECT p.engine,p.provider_profile FROM participants p JOIN computers c ON c.id=p.computer_id
    WHERE p.id=$1 AND p.company_id=$2 AND p.computer_id=$3 AND c.kind <> 'cloud' AND c.revoked_at IS NULL`, [claims.sub,claims.companyId,claims.computerId])
  if (!rows.length) throw new UsageEventRejection('producer_not_authorized')
  const committed=await client.query(`SELECT id FROM llm_calls WHERE schema_version=2 AND company_id=$1 AND computer_id=$2
    AND agent_id=$3 AND engine_session_id=$4 AND event_id=$5`,[claims.companyId,claims.computerId,claims.sub,event.engineSessionId,event.producerEventId])
  if(committed.rows.length) return // A lost ACK stays replayable after a same-principal rebind.
  // Replay must not relabel an old event with today's engine/profile after a rebind.
  // The producer snapshot is only a match condition; authority remains the DB assignment.
  if(event.engine!==rows[0].engine || event.profileRef!==(rows[0].provider_profile ?? null)) throw new UsageEventRejection('producer_binding_changed')
  const hop = event.attempts[0], e = hop.extras ?? {}
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([claims.sub,hop.runId,event.engineSessionId,hop.purpose])])
  const granularity = e.observationGranularity === 'provider_request' ? 'provider_request' : 'engine_turn'
  const mixed = await client.query(`SELECT id FROM llm_calls WHERE company_id=$1 AND agent_id=$2
    AND engine_session_id=$3 AND run_id IS NOT DISTINCT FROM $4::text AND purpose=$5
    AND schema_version=2 AND observation_granularity<>$6 LIMIT 1`, [claims.companyId,claims.sub,event.engineSessionId,hop.runId ?? null,hop.purpose,granularity])
  if (mixed.rows.length) throw new UsageEventRejection('mixed_granularity')
  if (hop.conversationId && !(await client.query('SELECT id FROM conversations WHERE id=$1 AND company_id=$2', [hop.conversationId,claims.companyId])).rows.length) throw new UsageEventRejection('conversation_not_found')
  // The authenticated assignment owns source, computer, engine and profile. Daemon costs
  // are never accepted as an upstream bill. One event is one metering observation.
  await recordByoaEvent({ ...hop, companyId: claims.companyId, agentId: claims.sub, source: `byoa-${rows[0].engine}` as LlmCallSource,
    daemonVersion: typeof event.daemonVersion === 'string' ? event.daemonVersion.slice(0,128) : null,
    extras: { eventId: event.producerEventId, engineSessionId: event.engineSessionId, computerId: claims.computerId,
      profileRef: rows[0].provider_profile, occurredAt: event.occurredAt, route: `byoa:${rows[0].engine}`,
      requestedModel: typeof e.requestedModel === 'string' ? e.requestedModel.slice(0,256) : hop.model,
      requestModel: hop.model, actualModel: typeof e.actualModel === 'string' ? e.actualModel.slice(0,256) : null,
      logicalCallId: `${claims.sub}:${hop.runId ?? event.engineSessionId}:${hop.purpose}`,
      observationGranularity: e.observationGranularity === 'provider_request' ? 'provider_request' : 'engine_turn' } }, client)
}
