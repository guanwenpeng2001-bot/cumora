/**
 * Usage dashboard aggregation — pure reads over the llm_calls rollup,
 * scoped to the tenant. Powers the settings-page usage dashboard
 * (totals cards, trend chart, per-agent/model/provider breakdowns,
 * paginated request log). Never writes.
 */
import type { UsageFilter, SettlementAmounts } from '../../shared/llm-usage-contract.js'
import { pool } from './db/pool.js'
import { automationNumber } from './settings.js'
import { isLlmRollupPaused } from './agents/llm-rollup.js'

export interface UsageRange { from: Date; to: Date; filters?: UsageFilter }

const DAY_MS = 86_400_000
const MAX_LOG_ROWS = 10_000

export class UsageInputError extends Error {}

/** ISO instants use an explicit offset; date-only inputs mean UTC midnight. */
export function parseUsageRange(q: { from?: unknown; to?: unknown; [key: string]: unknown }): UsageRange {
  const now = Date.now()
  const parse = (value: unknown, fallback: number): number => {
    if (value === undefined) return fallback
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
      throw new UsageInputError('from/to must be ISO dates or timestamps with a timezone')
    }
    const time = Date.parse(value)
    if (!Number.isFinite(time) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)) {
      throw new UsageInputError('invalid from/to date')
    }
    return time
  }
  const to = Math.min(parse(q.to, now), now + DAY_MS)
  const from = Math.max(parse(q.from, Math.floor(now / DAY_MS) * DAY_MS), now - 92 * DAY_MS, to - 92 * DAY_MS)
  if (from >= to) throw new UsageInputError('from must be before to')
  return { from: new Date(from), to: new Date(to), ...(Object.keys(parseUsageFilter(q)).length ? { filters: parseUsageFilter(q) } : {}) }
}

export function parseUsageFilter(q: Record<string, unknown>): UsageFilter {
  const result: Record<string,string> = {}
  for (const key of ['source','platform','provider','capability','role','purpose','agentId','runId']) {
    if (q[key] === undefined || q[key] === '') continue
    if (typeof q[key] !== 'string' || q[key].length > 256) throw new UsageInputError('invalid usage filter')
    if (key === 'source' && !['sub2api','env','byoa'].includes(q[key])) {
      // One compatibility cycle for cloud/byoa-engine callers.
      if (q[key] === 'cloud' || q[key].startsWith('byoa-')) continue
      throw new UsageInputError('invalid source')
    }
    result[key] = q[key]
  }
  return result as UsageFilter
}

export function parseUsagePagination(q: { page?: unknown; pageSize?: unknown }): { page: number; pageSize: number } {
  const integer = (value: unknown, fallback: number): number => {
    if (value === undefined) return fallback
    if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !/^\d+$/.test(value))) {
      throw new UsageInputError('page and pageSize must be positive integers')
    }
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < 1) throw new UsageInputError('page and pageSize must be positive integers')
    return n
  }
  const page = integer(q.page, 1)
  const pageSize = integer(q.pageSize, 50)
  if (pageSize > 200 || !Number.isSafeInteger((page - 1) * pageSize) || page * pageSize > MAX_LOG_ROWS) throw new UsageInputError('pagination exceeds supported bounds')
  return { page, pageSize }
}

// Watermarks certify v2, including empty hours. Legacy coverage is evidenced
// only by surviving v1 buckets. Missing legacy hours always allow raw fallback.
// $4 is the endpoint filter/granularity or metadata stale interval.
const COVERAGE_SQL = `WITH bounds AS (
  SELECT $2::timestamptz AS start_at, $3::timestamptz AS end_at, $4::text AS option,
         CASE WHEN $6::double precision > 0 THEN NOW() - ($6 * INTERVAL '1 day') END AS raw_retention_from
), coverage AS (
  SELECT st.*,
         CASE WHEN st.coverage_from IS NOT NULL THEN GREATEST(st.coverage_from,
           CASE WHEN $5::int > 0 THEN
             date_trunc('hour', st.aggregated_at - ($5::int * INTERVAL '1 hour'), 'UTC') +
               CASE WHEN st.aggregated_at = date_trunc('hour', st.aggregated_at, 'UTC')
                    THEN INTERVAL '0 hours' ELSE INTERVAL '1 hour' END END) END AS retained_from
    FROM (SELECT TRUE AS id) singleton LEFT JOIN llm_rollup_state st USING (id)
), legacy_hours AS (
  SELECT DISTINCT r.bucket_hour FROM llm_calls_rollup r CROSS JOIN bounds b CROSS JOIN coverage c
   WHERE r.company_id = $1 AND r.bucket_hour >= b.start_at
     AND r.bucket_hour + INTERVAL '1 hour' <= b.end_at
     AND r.bucket_hour < c.retained_from AND r.bucket_hour < c.completed_through
), ownership AS (
  SELECT h.bucket_hour,
         GREATEST(h.bucket_hour, b.start_at) AS from_at,
         LEAST(h.bucket_hour + INTERVAL '1 hour', b.end_at) AS to_at,
         CASE WHEN h.bucket_hour >= b.start_at AND h.bucket_hour + INTERVAL '1 hour' <= b.end_at
                   AND v.status='ready' AND NOT v.dirty THEN 'v3'
              WHEN v.dirty THEN 'raw'
              WHEN h.bucket_hour >= b.start_at AND h.bucket_hour + INTERVAL '1 hour' <= b.end_at
                   AND h.bucket_hour >= c.retained_from AND h.bucket_hour < c.completed_through THEN 'v2'
              WHEN l.bucket_hour IS NOT NULL THEN 'v1' ELSE 'raw' END AS owner
    FROM bounds b CROSS JOIN coverage c
    CROSS JOIN LATERAL generate_series(date_trunc('hour', b.start_at, 'UTC'),
      date_trunc('hour', b.end_at - INTERVAL '1 microsecond', 'UTC'), INTERVAL '1 hour') h(bucket_hour)
    LEFT JOIN legacy_hours l ON l.bucket_hour = h.bucket_hour
    LEFT JOIN llm_rollup_state_v3 v ON v.bucket_hour = h.bucket_hour
) `

// A bucket has exactly one owner. v3 retains logical IDs so distinct logical calls
// are computed across groups, never SUM(distinct-per-model). Partial hours read raw.
const WINDOW_SQL = `${COVERAGE_SQL}, unfiltered_usage AS (
  SELECT r.bucket_hour,r.company_id,r.agent_id,r.purpose,r.model,r.source,r.daemon_version,r.calls,r.ok_calls,r.failed_calls,r.rate_limited_calls,r.input_tokens,r.cached_input_tokens,r.cache_creation_tokens,r.output_tokens,r.reasoning_tokens,r.cost_usd::numeric,r.cost_estimated,r.route,r.platform,r.unknown_calls,r.unpriced_calls,r.calls AS quality_unknown_calls,
    NULL::text AS source_kind,NULL::text AS source_id,NULL::text AS provider_id,NULL::text AS offering_id,
    NULL::text AS capability,NULL::text AS role,NULL::text AS run_id,NULL::text AS logical_call_id,
    NULL::numeric AS reference_cost_usd,NULL::numeric AS upstream_cost_usd,NULL::numeric AS quota_debit,0::bigint AS pending_calls,
    NULL::text AS actual_model,r.model AS request_model,'not_reported'::text AS actual_model_state
    FROM llm_calls_rollup_v2 r JOIN ownership o ON o.bucket_hour=r.bucket_hour AND o.owner='v2' WHERE r.company_id=$1
  UNION ALL
  SELECT r.bucket_hour,r.company_id,r.agent_id,r.purpose,r.model,r.source,r.daemon_version,r.calls,r.ok_calls,r.failed_calls,r.rate_limited_calls,r.input_tokens,r.cached_input_tokens,r.cache_creation_tokens,r.output_tokens,r.reasoning_tokens,r.cost_usd::numeric,r.cost_estimated,NULL::text,NULL::text,0::bigint,0::bigint,r.calls,
    NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
    NULL::numeric,NULL::numeric,NULL::numeric,0::bigint,NULL::text,r.model,'not_reported'::text
    FROM llm_calls_rollup r JOIN ownership o ON o.bucket_hour=r.bucket_hour AND o.owner='v1' WHERE r.company_id=$1
  UNION ALL
  SELECT r.bucket_hour,r.company_id,r.agent_id,r.purpose,r.model,r.source,r.daemon_version,
    r.calls,r.ok_calls,r.failed_calls,r.rate_limited_calls,r.input_tokens,r.cached_input_tokens,r.cache_creation_tokens,r.output_tokens,r.reasoning_tokens,
    r.cost_usd,r.cost_estimated,r.route,r.platform,r.unknown_calls,r.unpriced_calls,r.quality_unknown_calls,
    r.source_kind,r.source_id,r.provider_id,r.offering_id,r.capability,r.role,r.run_id,r.logical_call_id,
    r.reference_cost_usd,r.upstream_cost_usd,r.quota_debit,r.pending_calls,r.actual_model,r.request_model,r.actual_model_state
    FROM llm_calls_rollup_v3 r JOIN ownership o ON o.bucket_hour=r.bucket_hour AND o.owner='v3' WHERE r.company_id=$1
  UNION ALL
  SELECT date_trunc('hour',l.occurred_at,'UTC'),l.company_id,l.agent_id,l.purpose,COALESCE(l.actual_model,l.request_model,l.model),l.source,l.daemon_version,
    1::bigint,(l.status IN ('ok','succeeded'))::int,(l.status NOT IN ('ok','succeeded'))::int,(l.http_status=429 OR l.status='rate_limited')::int,
    l.input_tokens,l.cached_input_tokens,l.cache_creation_tokens,l.output_tokens,l.reasoning_tokens,
    l.reference_cost_usd,l.cost_estimated,l.route_id,l.platform,(l.usage_state='unknown')::int,(l.pricing_state='unpriced')::int,(l.schema_version<2)::int,
    l.source_kind,l.source_id,l.provider_id,l.offering_id,l.capability,l.role,l.run_id,l.logical_call_id,
    l.reference_cost_usd,l.upstream_cost_usd,l.quota_debit,(l.settlement_state='pending')::int,l.actual_model,l.request_model,l.actual_model_state
    FROM ownership o JOIN llm_calls l ON l.company_id=$1 AND l.occurred_at >= o.from_at AND l.occurred_at < o.to_at
    WHERE o.owner='raw' AND l.record_kind='attempt'
      AND l.occurred_at >= $2::timestamptz AND l.occurred_at < $3::timestamptz
), usage_window AS (SELECT * FROM unfiltered_usage WHERE
  ($7::jsonb->>'source' IS NULL OR source_kind=$7::jsonb->>'source')
  AND ($7::jsonb->>'platform' IS NULL OR platform=$7::jsonb->>'platform')
  AND ($7::jsonb->>'provider' IS NULL OR provider_id=$7::jsonb->>'provider')
  AND ($7::jsonb->>'capability' IS NULL OR capability=$7::jsonb->>'capability')
  AND ($7::jsonb->>'role' IS NULL OR role=$7::jsonb->>'role')
  AND ($7::jsonb->>'purpose' IS NULL OR purpose=$7::jsonb->>'purpose')
  AND ($7::jsonb->>'agentId' IS NULL OR agent_id=$7::jsonb->>'agentId')
  AND ($7::jsonb->>'runId' IS NULL OR run_id=$7::jsonb->>'runId')
) `

function windowParams(tenant: string, range: UsageRange, option: string | number | null = null): unknown[] {
  return [tenant, range.from.toISOString(), range.to.toISOString(), option,
    automationNumber('llm_rollup_retention_hours'), automationNumber('db_gc_llm_calls_days'), JSON.stringify(range.filters ?? {})]
}

export interface UsageCoverageInterval { from: string; to: string }

/** Merge adjacent hours without filling holes between surviving legacy buckets. */
function mergeCoverage(intervals: UsageCoverageInterval[]): UsageCoverageInterval[] {
  const result: UsageCoverageInterval[] = []
  for (const interval of intervals.map(r => ({ from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString() }))
    .sort((a, b) => a.from.localeCompare(b.from))) {
    const previous = result.at(-1)
    if (previous && interval.from <= previous.to) previous.to = previous.to > interval.to ? previous.to : interval.to
    else result.push(interval)
  }
  return result
}

export interface UsageMetadata {
  timezone: 'UTC'
  aggregatedAt: string | null
  completedThrough: string | null
  aggregationStatus: 'pending' | 'ready' | 'failed' | 'paused' | 'stale'
  rawRetentionFrom: string | null
  earliestRawAt: string | null
  /** Retention completeness only; delivery loss is not observable by this reader. */
  logsComplete: boolean
  /** False for any uncovered interval, including whole hours lost to retention. */
  boundaryComplete: boolean
  aggregationVersion: 3
  legacyBefore: string | null
  rollupCoverageFrom: string | null
  retainedRollupFrom: string | null
  legacyCoverage: UsageCoverageInterval[]
  v3Coverage: UsageCoverageInterval[]
  dirtyBuckets: number
  /** No certified rollup and raw may have expired; residual raw is still read. */
  coverageGaps: UsageCoverageInterval[]
  /** The ledger does not persist tenant-scoped delivery acknowledgements. */
  deliveryComplete: null
}

export async function usageMetadata(tenant: string, range: UsageRange): Promise<UsageMetadata> {
  const intervalMs = automationNumber('llm_rollup_interval_ms')
  const paused = isLlmRollupPaused()
  const { rows } = await pool.query<{
    coverage_from: Date | null; retained_from: Date | null; aggregated_at: Date | null
    completed_through: Date | null; status: UsageMetadata['aggregationStatus']
    raw_retention_from: Date | null; earliest_raw_at: Date | null; stale: boolean
    coverage_gaps: UsageCoverageInterval[]; legacy_coverage: UsageCoverageInterval[]; v3_coverage: UsageCoverageInterval[]; dirty_buckets: number
  }>(`${COVERAGE_SQL}SELECT c.*,
             b.raw_retention_from,
             (SELECT created_at FROM llm_calls WHERE company_id = $1 ORDER BY created_at LIMIT 1) AS earliest_raw_at,
             c.aggregated_at < NOW() - ($4::double precision * INTERVAL '1 millisecond') AS stale,
             (SELECT jsonb_agg(jsonb_build_object('from', o.from_at, 'to', LEAST(o.to_at, b.raw_retention_from)))
                FROM ownership o WHERE o.owner = 'raw' AND o.from_at < b.raw_retention_from) AS coverage_gaps,
             (SELECT jsonb_agg(jsonb_build_object('from', o.from_at, 'to', o.to_at))
                FROM ownership o WHERE o.owner = 'v1') AS legacy_coverage,
             (SELECT jsonb_agg(jsonb_build_object('from',o.from_at,'to',o.to_at)) FROM ownership o WHERE o.owner='v3') AS v3_coverage,
             (SELECT COUNT(*)::int FROM ownership o JOIN llm_rollup_state_v3 v USING(bucket_hour) WHERE v.dirty) AS dirty_buckets
        FROM coverage c CROSS JOIN bounds b`,
  windowParams(tenant, range, Math.max(300_000, intervalMs * 3)).slice(0,6))
  const r = rows[0]!
  const retained = r.raw_retention_from ? new Date(r.raw_retention_from).getTime() : -Infinity
  const coverageGaps = mergeCoverage(r.coverage_gaps ?? [])
  const legacyCoverage = mergeCoverage(r.legacy_coverage ?? [])
  const retainedRollupFrom = r.retained_from ? new Date(r.retained_from).toISOString() : null
  return {
    timezone: 'UTC', aggregatedAt: r.aggregated_at ? new Date(r.aggregated_at).toISOString() : null,
    completedThrough: r.completed_through ? new Date(r.completed_through).toISOString() : null,
    aggregationStatus: paused ? 'paused'
      : r.status === 'ready' && r.stale ? 'stale' : r.status ?? 'pending',
    rawRetentionFrom: Number.isFinite(retained) ? new Date(retained).toISOString() : null,
    earliestRawAt: r.earliest_raw_at ? new Date(r.earliest_raw_at).toISOString() : null,
    logsComplete: range.from.getTime() >= retained,
    boundaryComplete: coverageGaps.length === 0,
    aggregationVersion: 3,
    legacyBefore: legacyCoverage.length ? retainedRollupFrom : null,
    rollupCoverageFrom: r.coverage_from ? new Date(r.coverage_from).toISOString() : null,
    retainedRollupFrom, legacyCoverage, v3Coverage:mergeCoverage(r.v3_coverage ?? []),dirtyBuckets:r.dirty_buckets ?? 0, coverageGaps, deliveryComplete: null,
  }
}

const USAGE_PLATFORM_LABELS: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', gemini: 'Gemini',
  xai: 'xAI', grok: 'Grok', kimi: 'Kimi', deepseek: 'DeepSeek', dashscope: 'DashScope',
  novita: 'Novita', orcarouter: 'OrcaRouter', 'chatgpt-web': 'ChatGPT Web',
  mixed: 'mixed', antigravity: 'Antigravity', zhipu: 'Zhipu', minimax: 'MiniMax', composite: 'Composite',
}

/** Family heuristic for unlabeled ledger rows. Prefixes, not an exact-id whitelist. */
export function providerForModel(model: string | null | undefined): string {
  const m = (model ?? '').toLowerCase().trim()
  if (!m) return 'unknown'
  if (m.startsWith('novita/') && m.length > 7) return 'Novita'
  if (m.startsWith('orcarouter/') && m.length > 11) return 'OrcaRouter'
  if (m.startsWith('chatgpt-web/') && m.length > 12) return 'ChatGPT Web'
  if (m === 'k3' || m.startsWith('kimi-') || m.startsWith('moonshot')) return 'Kimi'
  if (m.startsWith('deepseek')) return 'DeepSeek'
  if (m.startsWith('qwen-') || /^qwen\d/.test(m) || m === 'fun-asr' || m.startsWith('fun-asr-') || m.startsWith('z-image')) return 'DashScope'
  if (m.startsWith('gpt-') || m === 'o3' || m.startsWith('o3-') || m === 'o4' || m.startsWith('o4-')) return 'OpenAI'
  if (m.startsWith('claude-') || m === 'haiku' || m === 'sonnet' || m === 'opus') return 'Anthropic'
  if (m.startsWith('gemini-')) return 'Google'
  if (m.startsWith('grok-') || m === 'grok') return 'xAI'
  if (m.startsWith('glm-')) return 'Zhipu'
  if (m.startsWith('minimax-') || m.startsWith('abab')) return 'MiniMax'
  return 'other'
}

/** Explicit platform, then recorded direct route, then the model family. */
export function usageProvider(model: string, platform: string | null | undefined, route?: string | null): string {
  const direct = /^direct:([^:]+)$/i.exec(route?.trim() ?? '')?.[1]?.trim().toLowerCase()
  const trimmed = platform?.trim() || (direct && Object.hasOwn(USAGE_PLATFORM_LABELS, direct) ? direct : '')
  const key = trimmed.toLowerCase()
  if (key) return USAGE_PLATFORM_LABELS[key] ?? trimmed
  return providerForModel(model)
}

export interface UsageSummary extends Partial<SettlementAmounts> {
  logicalCalls?: number
  pendingSettlement?: number
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUsd: number
  /** true when any contributing row was priced from a non-operator rate. */
  costEstimated: boolean
  /** cache-read / (fresh input + cache-read); 0 when no input at all. */
  unknownRequests?: number
  unpricedRequests?: number
  qualityUnknownRequests?: number
  sources?: string[]
  cacheHitRate: number
  successRate: number
}

interface SummaryRow {
  reference_cost_usd: string | null; upstream_cost_usd: string | null; quota_debit: string | null; logical_calls: string; pending_calls: string
  requests: string; input_tokens: string; output_tokens: string
  cache_read: string; cache_write: string; reasoning: string
  cost_usd: string; cost_estimated: boolean; ok: string
  unknown_calls: string; unpriced_calls: string; quality_unknown_calls: string; sources: string[]
}

export async function usageSummary(tenant: string, range: UsageRange, source?: string): Promise<UsageSummary> {
  const { rows } = await pool.query<SummaryRow>(
    `${WINDOW_SQL}SELECT SUM(reference_cost_usd)::text AS reference_cost_usd,SUM(upstream_cost_usd)::text AS upstream_cost_usd,
            CASE WHEN SUM(pending_calls)>0 OR COUNT(quota_debit)<COUNT(*) THEN NULL ELSE SUM(quota_debit)::text END AS quota_debit,
            COUNT(DISTINCT logical_call_id)::text AS logical_calls,SUM(pending_calls)::text AS pending_calls,
            COALESCE(SUM(calls), 0)::text AS requests,
            COALESCE(SUM(input_tokens), 0)::text           AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text          AS output_tokens,
            COALESCE(SUM(cached_input_tokens), 0)::text    AS cache_read,
            COALESCE(SUM(cache_creation_tokens), 0)::text  AS cache_write,
            COALESCE(SUM(reasoning_tokens), 0)::text       AS reasoning,
            COALESCE(SUM(cost_usd), 0)::text               AS cost_usd,
            COALESCE(BOOL_OR(cost_estimated), false)      AS cost_estimated,
            COALESCE(SUM(ok_calls), 0)::text AS ok,
            COALESCE(SUM(unknown_calls), 0)::text AS unknown_calls,
            COALESCE(SUM(unpriced_calls), 0)::text AS unpriced_calls,
            COALESCE(SUM(quality_unknown_calls), 0)::text AS quality_unknown_calls,
            ARRAY_AGG(DISTINCT COALESCE(source_kind,source)) FILTER (WHERE source IS NOT NULL) AS sources
       FROM usage_window
      WHERE company_id = $1
        AND ($4::text IS NULL OR source = $4 OR source_kind = $4)`,
    windowParams(tenant, range, source ?? null),
  )
  const r = rows[0]
  if (!r) return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, costEstimated: false, cacheHitRate: 0, successRate: 0 }
  const requests = Number(r.requests)
  const inputTokens = Number(r.input_tokens)
  const cacheReadTokens = Number(r.cache_read)
  return {
    referenceCostUsd: r.reference_cost_usd ?? null, upstreamCostUsd: r.upstream_cost_usd ?? null, quotaDebit: r.quota_debit ?? null,
    logicalCalls: Number(r.logical_calls ?? 0), pendingSettlement: Number(r.pending_calls ?? 0),
    requests,
    inputTokens,
    outputTokens: Number(r.output_tokens),
    cacheReadTokens,
    cacheWriteTokens: Number(r.cache_write),
    reasoningTokens: Number(r.reasoning),
    costUsd: Number(r.cost_usd),
    costEstimated: r.cost_estimated,
    unknownRequests: Number(r.unknown_calls ?? 0),
    unpricedRequests: Number(r.unpriced_calls ?? 0),
    qualityUnknownRequests: Number(r.quality_unknown_calls ?? 0),
    sources: r.sources ?? [],
    cacheHitRate: inputTokens + cacheReadTokens > 0 ? cacheReadTokens / (inputTokens + cacheReadTokens) : 0,
    successRate: requests > 0 ? Number(r.ok) / requests : 0,
  }
}

export interface TrendPoint {
  bucket: string
  costUsd: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export async function usageTrend(tenant: string, range: UsageRange, granularity: 'hour' | 'day'): Promise<TrendPoint[]> {
  const { rows } = await pool.query<{ bucket: Date; cost_usd: string | null; input_tokens: string; output_tokens: string; cache_read: string; cache_write: string }>(
    `${WINDOW_SQL}SELECT date_trunc($4, bucket_hour, 'UTC') AS bucket,
            SUM(reference_cost_usd)::text             AS cost_usd,
            COALESCE(SUM(input_tokens), 0)::text        AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text       AS output_tokens,
            COALESCE(SUM(cached_input_tokens), 0)::text AS cache_read,
            COALESCE(SUM(cache_creation_tokens), 0)::text AS cache_write
       FROM usage_window
      WHERE company_id = $1
      GROUP BY 1 ORDER BY 1`,
    windowParams(tenant, range, granularity),
  )
  const byBucket = new Map(rows.map((r) => [new Date(r.bucket).toISOString(), r]))
  // Gap-fill so the chart axis is continuous.
  const stepMs = granularity === 'hour' ? 3_600_000 : 86_400_000
  const out: TrendPoint[] = []
  for (let t = Math.floor(range.from.getTime() / stepMs) * stepMs; t < range.to.getTime(); t += stepMs) {
    const key = new Date(t).toISOString()
    const r = byBucket.get(key)
    out.push({
      bucket: key,
      costUsd: r ? r.cost_usd === null ? null : Number(r.cost_usd) : 0,
      inputTokens: Number(r?.input_tokens ?? 0),
      outputTokens: Number(r?.output_tokens ?? 0),
      cacheReadTokens: Number(r?.cache_read ?? 0),
      cacheWriteTokens: Number(r?.cache_write ?? 0),
    })
  }
  return out
}

export interface AgentUsageRow extends Partial<SettlementAmounts> {
  agentId: string
  name: string
  avatarUrl: string | null
  source: 'managed' | 'byoa'
  actualSource?: string
  requests: number
  /** All input tokens: fresh + cache read + cache write. */
  inputTokens: number
  outputTokens: number
  costUsd: number
  successRate: number
}

export async function usageByAgent(tenant: string, range: UsageRange): Promise<AgentUsageRow[]> {
  const { rows } = await pool.query<{
    agent_id: string; name: string | null; avatar_url: string | null; source: string
    requests: string; input_tokens: string; output_tokens: string; cost_usd: string; ok: string; reference_cost_usd: string | null; upstream_cost_usd: string | null; quota_debit: string | null
  }>(
    `${WINDOW_SQL}SELECT l.agent_id,SUM(l.reference_cost_usd)::text AS reference_cost_usd,SUM(l.upstream_cost_usd)::text AS upstream_cost_usd,SUM(l.quota_debit)::text AS quota_debit,
            p.name, p.avatar_url, COALESCE(l.source_kind,l.source) AS source
            ,
            COALESCE(SUM(l.calls), 0)::text          AS requests,
            COALESCE(SUM(l.input_tokens + l.cached_input_tokens + l.cache_creation_tokens), 0)::text  AS input_tokens,
            COALESCE(SUM(l.output_tokens), 0)::text  AS output_tokens,
            COALESCE(SUM(l.cost_usd), 0)::text       AS cost_usd,
            COALESCE(SUM(l.ok_calls), 0)::text       AS ok
       FROM usage_window l
       LEFT JOIN participants p ON p.id = l.agent_id AND p.company_id = l.company_id
      WHERE l.company_id = $1
      GROUP BY l.agent_id, p.name, p.avatar_url, l.source_kind, l.source
      ORDER BY SUM(l.cost_usd) DESC NULLS LAST`,
    windowParams(tenant, range),
  )
  return rows.map((r) => ({
    referenceCostUsd:r.reference_cost_usd ?? null,upstreamCostUsd:r.upstream_cost_usd ?? null,quotaDebit:r.quota_debit ?? null,
    agentId: r.agent_id,
    name: r.name ?? r.agent_id ?? '—',
    avatarUrl: r.avatar_url,
    source: r.source.startsWith('byoa') ? 'byoa' : 'managed',
    actualSource: r.source,
    requests: Number(r.requests),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costUsd: Number(r.cost_usd),
    successRate: Number(r.requests) > 0 ? Number(r.ok) / Number(r.requests) : 0,
  }))
}

export interface ModelUsageRow extends Partial<SettlementAmounts> {
  actualModel?: string | null
  requestModel?: string | null
  actualModelState?: string
  offeringId?: string | null
  sourceId?: string | null
  sourceKind?: string | null
  model: string
  provider: string
  requests: number
  /** All input tokens: fresh + cache read + cache write. */
  inputTokens: number
  outputTokens: number
  costUsd: number
  costEstimated: boolean
  route?: string | null
  platform?: string | null
  platforms?: string[]
  source?: string
  unknownRequests?: number
  unpricedRequests?: number
  qualityUnknownRequests?: number
}

interface ModelRollupRow {
  actual_model?: string | null
  request_model?: string | null
  actual_model_state?: string
  model: string
  provider_id?: string | null
  offering_id?: string | null
  source_kind?: string | null
  source_id?: string | null
  reference_cost_usd?: string | null; upstream_cost_usd?: string | null; quota_debit?: string | null
  route: string | null
  platform: string | null
  platforms: string[] | null
  source: string
  unknown_calls: string
  unpriced_calls: string
  quality_unknown_calls: string
  requests: string
  input_tokens: string
  output_tokens: string
  cost_usd: string
  cost_estimated: boolean
}

const DIRECT_PLATFORM_PATTERN = `^direct:(${Object.keys(USAGE_PLATFORM_LABELS).filter(key => key !== 'mixed').join('|')})$`
const EFFECTIVE_PLATFORM_SQL = `COALESCE(NULLIF(LOWER(BTRIM(platform)), ''),
  CASE WHEN BTRIM(route) ~* '${DIRECT_PLATFORM_PATTERN}' THEN NULLIF(LOWER(BTRIM(SUBSTRING(BTRIM(route) FROM 8))), '') END)`

async function queryUsageByModelRows(tenant: string, range: UsageRange, _byPlatform = false): Promise<ModelRollupRow[]> {
  const { rows } = await pool.query<ModelRollupRow>(
    `${WINDOW_SQL}SELECT model, actual_model,request_model,actual_model_state,provider_id, offering_id,source_kind,source_id,
            SUM(reference_cost_usd)::text AS reference_cost_usd,SUM(upstream_cost_usd)::text AS upstream_cost_usd,SUM(quota_debit)::text AS quota_debit,
            CASE WHEN COUNT(route) = COUNT(*) AND COUNT(DISTINCT route) = 1 THEN MIN(route) END AS route,
            CASE WHEN COUNT(DISTINCT effective_platform) = 1 AND COUNT(effective_platform) = COUNT(*) THEN MIN(effective_platform)
                 WHEN COUNT(effective_platform) > 0 THEN 'mixed' END AS platform,
            ARRAY_AGG(DISTINCT effective_platform) FILTER (WHERE effective_platform IS NOT NULL) AS platforms,
            CASE WHEN COUNT(DISTINCT source) = 1 THEN MIN(source) ELSE 'mixed' END AS source,
            COALESCE(SUM(calls), 0)::text AS requests,
            COALESCE(SUM(input_tokens + cached_input_tokens + cache_creation_tokens), 0)::text AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
            COALESCE(SUM(cost_usd), 0)::text AS cost_usd,
            COALESCE(BOOL_OR(cost_estimated), false) AS cost_estimated,
            COALESCE(SUM(unknown_calls), 0)::text AS unknown_calls,
            COALESCE(SUM(unpriced_calls), 0)::text AS unpriced_calls,
            COALESCE(SUM(quality_unknown_calls), 0)::text AS quality_unknown_calls
       FROM (SELECT *, ${EFFECTIVE_PLATFORM_SQL} AS effective_platform FROM usage_window) labeled
      WHERE company_id = $1
      GROUP BY model, source_kind, source_id, source, provider_id, offering_id, effective_platform,actual_model,request_model,actual_model_state
      ORDER BY SUM(cost_usd) DESC NULLS LAST`,
    windowParams(tenant, range),
  )
  return rows
}

export async function usageByModel(tenant: string, range: UsageRange): Promise<ModelUsageRow[]> {
  const rows = await queryUsageByModelRows(tenant, range)
  return rows.map((r) => ({
    offeringId:r.offering_id,sourceId:r.source_id,sourceKind:r.source_kind,
    actualModel:r.actual_model ?? null,requestModel:r.request_model ?? r.model,actualModelState:r.actual_model_state ?? 'not_reported',
    referenceCostUsd:r.reference_cost_usd ?? null,upstreamCostUsd:r.upstream_cost_usd ?? null,quotaDebit:r.quota_debit ?? null,
    model: r.model,
    provider: r.provider_id ?? 'unknown',
    route: r.route, platform: r.platform, platforms: (r.platforms ?? []).sort(), source: r.source,
    unknownRequests: Number(r.unknown_calls ?? 0), unpricedRequests: Number(r.unpriced_calls ?? 0),
    qualityUnknownRequests: Number(r.quality_unknown_calls ?? 0),
    requests: Number(r.requests),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costUsd: Number(r.cost_usd),
    costEstimated: r.cost_estimated,
  }))
}

export interface ProviderUsageRow extends Partial<SettlementAmounts> {
  provider: string
  requests: number
  /** All input tokens: fresh + cache read + cache write. */
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export async function usageByProvider(tenant: string, range: UsageRange): Promise<ProviderUsageRow[]> {
  const models = await queryUsageByModelRows(tenant, range, true)
  const acc = new Map<string, ProviderUsageRow>()
  const money = new Map<string,bigint>()
  for (const model of models) {
    // Legacy platform/model strings are not evidence of the serving provider.
    const provider = model.provider_id ?? 'unknown'
    const row = acc.get(provider) ?? { provider, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    row.requests += Number(model.requests)
    row.inputTokens += Number(model.input_tokens)
    row.outputTokens += Number(model.output_tokens)
    const [whole,fraction=''] = String(model.cost_usd ?? '0').split('.')
    const total = (money.get(provider) ?? 0n) + BigInt(whole)*1000000000000n + BigInt(fraction.padEnd(12,'0').slice(0,12))
    money.set(provider,total)
    row.costUsd = Number(total) / 1e12
    for(const [field,column] of [['referenceCostUsd','reference_cost_usd'],['upstreamCostUsd','upstream_cost_usd'],['quotaDebit','quota_debit']] as const) {
      const amount=model[column]
      if(amount==null) continue
      const units=(value:string) => {const [w,f='']=value.split('.');return BigInt(w)*1000000000000n+BigInt(f.padEnd(12,'0').slice(0,12))}
      const sum=units(row[field] ?? '0')+units(amount)
      row[field]=`${sum/1000000000000n}.${(sum%1000000000000n).toString().padStart(12,'0')}`
    }
    acc.set(provider, row)
  }
  return [...acc.values()].sort((a, b) => b.costUsd - a.costUsd)
}

// Expose only known failure categories; upstream messages may contain credentials or endpoints.
function usageLogFailureReason(status: string, reason: string | null, httpStatus: string | null): string | null {
  if (status === 'ok' || status === 'succeeded') return null
  if (reason && /^(?:cancelled|non-fallbackable-error|upstream-http-[45]\d{2}|transport:(?:APIConnectionError|APIConnectionTimeoutError|TimeoutError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET))$/.test(reason)) return reason
  if (httpStatus && /^[45]\d{2}$/.test(httpStatus)) return 'upstream-http-' + httpStatus
  if (status === 'rate_limited') return 'rate_limited'
  if (status === 'timeout') return 'timeout'
  return 'failed'
}

export interface UsageLogRow extends Partial<SettlementAmounts> {
  traceId?: string | null
  gatewayRequestId?: string | null
  priceVersionId?: string | null
  observationGranularity?: string
  usageProvenance?: string | null
  sourceKind?: string | null
  sourceId?: string | null
  offeringId?: string | null
  requestModel?: string | null
  actualModelState?: string
  pricingState?: string
  unpricedReason?: string | null
  settlementState?: string
  attempts?: UsageLogRow[]

  tokenMeasured?: boolean
  units?: { unit: 'second' | 'image'; quantity: number } | null
  unitPricing?: { unit?: string; usdPerUnit?: number; sourceUrl?: string | null; pricedAt?: string | null; note?: string | null } | null
  id: string
  createdAt: string
  agentId: string | null
  agentName: string | null
  model: string
  provider: string
  purpose: string
  source: string
  /** All input tokens: fresh + cache read + cache write. */
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number | null
  status: string
  measured?: boolean
  costEstimated?: boolean
  unpriced?: boolean
  route?: string | null
  platform?: string | null
  requestedModel?: string
  actualModel: string | null
  failureReason?: string | null
  failureStage?: string | null
  httpStatus?: number | null
  callId?: string | null
  attempt?: number | null
}

export interface UsageLogPage {
  items: UsageLogRow[]
  total: number
  page: number
  pageSize: number
  accessibleTotal: number
  maxPage: number
  truncated: boolean
}

export async function usageLogs(
  tenant: string,
  range: UsageRange,
  args: { page: number; pageSize: number; source?: string },
): Promise<UsageLogPage> {
  const { page, pageSize } = parseUsagePagination(args)
  const params: unknown[] = [tenant, range.from.toISOString(), range.to.toISOString(), args.source ?? null]
  const filter = range.filters ?? {}
  const filterClauses = Object.entries({ source: 'source_kind', platform: 'platform', provider: 'provider_id', capability: 'capability', role: 'role', purpose: 'purpose', agentId: 'agent_id', runId: 'run_id' })
    .filter(([key]) => filter[key as keyof UsageFilter] !== undefined).map(([key,column]) => {
      params.push(filter[key as keyof UsageFilter]); return ` AND l.${column}=$${params.length}`
    }).join('')
  const where = `l.company_id = $1 AND l.occurred_at >= $2 AND l.occurred_at < $3 AND ($4::text IS NULL OR l.source = $4 OR l.source_kind=$4)${filterClauses}`
  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT COUNT(DISTINCT COALESCE(l.logical_call_id,l.id))::text AS total FROM llm_calls l WHERE ${where}`, params,
  )
  const { rows } = await pool.query<{
    trace_id: string | null; gateway_request_id: string | null; price_version_id: string | null; observation_granularity: string; usage_provenance: string | null
    source_kind: string | null; source_id: string | null; offering_id: string | null; provider_id: string | null
    request_model: string | null; actual_model_state: string; pricing_state: string; unpriced_reason: string | null; settlement_state: string
    reference_cost_usd: string | null; upstream_cost_usd: string | null; quota_debit: string | null
    id: string; created_at: Date; agent_id: string | null; agent_name: string | null
    model: string; purpose: string; source: string
    input_tokens: number | null; output_tokens: number | null; cost_usd: string | null
    latency_ms: number | null; status: string
    measured: boolean; cost_estimated: boolean; unpriced: boolean; route: string | null; platform: string | null
    requested_model: string | null; actual_model: string | null
    failure_reason: string | null; failure_stage: string | null; http_status: string | null
    token_measured?: boolean
    units?: UsageLogRow['units']; unit_pricing?: UsageLogRow['unitPricing']
    call_id: string | null; attempt: string | null
  }>(
    `SELECT l.trace_id,l.gateway_request_id,l.price_version_id,l.observation_granularity,l.usage_provenance,
            l.source_kind,l.source_id,l.offering_id,l.provider_id,l.request_model,l.actual_model_state,l.pricing_state,l.unpriced_reason,l.settlement_state,
            l.reference_cost_usd::text,l.upstream_cost_usd::text,l.quota_debit::text,
            l.id, l.occurred_at AS created_at, l.agent_id, p.name AS agent_name,
            l.model, l.purpose, l.source,
            COALESCE(l.input_tokens, 0) + COALESCE(l.cached_input_tokens, 0) + COALESCE(l.cache_creation_tokens, 0) AS input_tokens,
            l.output_tokens, l.cost_usd::text, l.latency_ms, l.status, l.measured, l.cost_estimated,
            (COALESCE(l.extras->>'unpriced', '') NOT IN ('', 'false')) AS unpriced,
            COALESCE(l.route_id,l.extras->>'route') AS route, COALESCE(l.platform,l.extras->>'platform') AS platform,
            COALESCE(l.requested_model,NULLIF(l.extras->>'requestedModel', ''), l.model) AS requested_model,
            l.actual_model AS actual_model,
            COALESCE(l.reason_code,l.extras->>'failureReason') AS failure_reason, COALESCE(l.failure_stage,l.extras->>'failureStage') AS failure_stage,
            COALESCE(l.http_status::text,l.extras->>'httpStatus') AS http_status,
            COALESCE(l.logical_call_id,NULLIF(l.extras->>'logicalCallId', ''), NULLIF(l.extras->>'callId', '')) AS call_id,
            CASE WHEN l.extras->'units' IS NOT NULL AND l.extras->'units' <> 'null'::jsonb
              THEN COALESCE(l.extras->'usage' <> 'null'::jsonb, FALSE) ELSE l.measured END AS token_measured,
            l.extras->'units' AS units, l.extras->'pricing' AS unit_pricing,
            COALESCE(l.attempt_no::text,l.extras->>'attempt') AS attempt
       FROM llm_calls l
       LEFT JOIN participants p ON p.id = l.agent_id AND p.company_id = l.company_id
      WHERE l.company_id=$1 AND COALESCE(l.logical_call_id,l.id) IN (
        SELECT COALESCE(l.logical_call_id,l.id) FROM llm_calls l WHERE ${where}
        GROUP BY 1 ORDER BY MAX(l.occurred_at) DESC,1 DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2})
      ORDER BY l.occurred_at DESC,l.attempt_no,l.id DESC`,
    [...params, pageSize, (page - 1) * pageSize],
  )
  const total = Number(countRows[0]?.total ?? 0)
  // A non-divisor page size cannot access the remainder beyond its last legal page.
  const accessibleTotal = Math.min(total, Math.floor(MAX_LOG_ROWS / pageSize) * pageSize)
  return {
    items: rows.map((r) => ({
      traceId:r.trace_id,gatewayRequestId:r.gateway_request_id,priceVersionId:r.price_version_id,observationGranularity:r.observation_granularity,usageProvenance:r.usage_provenance,
      sourceKind: r.source_kind, sourceId: r.source_id, offeringId: r.offering_id, requestModel: r.request_model,
      actualModelState: r.actual_model_state, pricingState: r.pricing_state, unpricedReason: r.unpriced_reason, settlementState: r.settlement_state,
      referenceCostUsd: r.reference_cost_usd ?? null, upstreamCostUsd: r.upstream_cost_usd ?? null, quotaDebit: r.quota_debit ?? null,
      tokenMeasured: r.token_measured ?? r.measured,
      units: r.units ?? null, unitPricing: r.unit_pricing ?? null,
      id: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      agentId: r.agent_id,
      agentName: r.agent_name,
      model: r.model,
      provider: r.provider_id ?? 'unknown',
      purpose: r.purpose,
      source: r.source,
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      costUsd: Number(r.cost_usd ?? 0),
      latencyMs: r.latency_ms,
      status: r.status, measured: r.measured, costEstimated: r.cost_estimated,
      unpriced: r.unpriced, route: r.route, platform: r.platform,
      requestedModel: r.requested_model || r.model,
      actualModel: r.actual_model || null,
      failureReason: usageLogFailureReason(r.status, r.failure_reason, r.http_status),
      failureStage: !['ok','succeeded'].includes(r.status) && ['prepare', 'execution', 'generation', 'poll', 'download', 'storage'].includes(r.failure_stage ?? '') ? r.failure_stage : null,
      httpStatus: r.http_status && /^[1-5]\d{2}$/.test(r.http_status) ? Number(r.http_status) : null,
      callId: r.call_id || null,
      attempt: r.attempt && /^[1-9]\d*$/.test(r.attempt) && Number.isSafeInteger(Number(r.attempt)) ? Number(r.attempt) : null,
    })),
    total, accessibleTotal, maxPage: Math.ceil(accessibleTotal / pageSize), truncated: accessibleTotal < total,
    page,
    pageSize,
  }
}

export async function usageBySource(tenant: string, range: UsageRange) {
  const { rows } = await pool.query(`${WINDOW_SQL}SELECT source_kind AS source,
    SUM(calls)::int AS requests, SUM(input_tokens+cached_input_tokens+cache_creation_tokens)::text AS input_tokens,
    SUM(output_tokens)::text AS output_tokens,SUM(reference_cost_usd)::text AS reference_cost_usd,
    SUM(upstream_cost_usd)::text AS upstream_cost_usd,SUM(quota_debit)::text AS quota_debit,
    SUM(unknown_calls)::int AS unknown_requests,SUM(unpriced_calls)::int AS unpriced_requests,
    SUM(quality_unknown_calls)::int AS quality_unknown_requests FROM usage_window GROUP BY source_kind ORDER BY source_kind`,windowParams(tenant,range))
  return rows.map(r => ({ source: r.source,requests:r.requests,inputTokens:Number(r.input_tokens),outputTokens:Number(r.output_tokens),
    referenceCostUsd:r.reference_cost_usd,upstreamCostUsd:r.upstream_cost_usd,quotaDebit:r.quota_debit,
    unknownRequests:r.unknown_requests,unpricedRequests:r.unpriced_requests,qualityUnknownRequests:r.quality_unknown_requests }))
}
