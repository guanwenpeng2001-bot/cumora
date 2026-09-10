/**
 * Usage dashboard aggregation — pure reads over the llm_calls rollup,
 * scoped to the tenant. Powers the settings-page usage dashboard
 * (totals cards, trend chart, per-agent/model/provider breakdowns,
 * paginated request log). Never writes.
 */
import { pool } from './db/pool.js'
import { automationNumber } from './settings.js'
import { isLlmRollupPaused } from './agents/llm-rollup.js'

export interface UsageRange { from: Date; to: Date }

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export class UsageInputError extends Error {}

/** ISO instants use an explicit offset; date-only inputs mean UTC midnight. */
export function parseUsageRange(q: { from?: unknown; to?: unknown }): UsageRange {
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
  return { from: new Date(from), to: new Date(to) }
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
  if (pageSize > 200 || !Number.isSafeInteger((page - 1) * pageSize) || page * pageSize > 10_000) throw new UsageInputError('pagination exceeds supported bounds')
  return { page, pageSize }
}

// Whole hours have one owner. Partial hours retain the exact [from,to) filter
// and use idx_llm_calls_company_created, including a window inside one hour.
const WINDOW_SQL = `WITH bounds AS (
  SELECT date_trunc('hour', $2::timestamptz, 'UTC') +
           CASE WHEN $2::timestamptz = date_trunc('hour', $2::timestamptz, 'UTC') THEN INTERVAL '0 hours' ELSE INTERVAL '1 hour' END AS lo,
         date_trunc('hour', $3::timestamptz, 'UTC') AS hi
), usage_window AS (
  SELECT r.*, 0::bigint AS quality_unknown_calls FROM llm_calls_rollup_v2 r CROSS JOIN bounds b
    JOIN llm_rollup_state st ON st.id
   WHERE r.company_id = $1 AND r.bucket_hour >= b.lo AND r.bucket_hour < b.hi
     AND r.bucket_hour >= st.coverage_from AND r.bucket_hour < st.completed_through
  UNION ALL
  SELECT r.*, NULL::text AS route, NULL::text AS platform,
         0::bigint AS unknown_calls, 0::bigint AS unpriced_calls, r.calls AS quality_unknown_calls
    FROM llm_calls_rollup r CROSS JOIN bounds b JOIN llm_rollup_state st ON st.id
   WHERE r.company_id = $1 AND r.bucket_hour >= b.lo AND r.bucket_hour < b.hi
     AND st.completed_through IS NOT NULL AND r.bucket_hour < st.completed_through
     AND r.bucket_hour < st.coverage_from
  UNION ALL
  SELECT date_trunc('hour', l.created_at, 'UTC'), l.company_id, l.agent_id, l.purpose, l.model, l.source, l.daemon_version,
         1::bigint, (l.status = 'ok')::int, (l.status <> 'ok')::int, (l.status = 'rate_limited')::int,
         COALESCE(l.input_tokens, 0), COALESCE(l.cached_input_tokens, 0), COALESCE(l.cache_creation_tokens, 0),
         COALESCE(l.output_tokens, 0), COALESCE(l.reasoning_tokens, 0), l.cost_usd, l.cost_estimated,
         l.extras->>'route', l.extras->>'platform', (l.measured IS NOT TRUE)::int,
         (COALESCE(l.extras->>'unpriced', '') NOT IN ('', 'false'))::int, 0::bigint
    FROM bounds b LEFT JOIN llm_rollup_state st ON st.id CROSS JOIN LATERAL (
      SELECT * FROM llm_calls
       WHERE company_id = $1 AND created_at >= $2::timestamptz
         AND created_at < LEAST(b.lo, $3::timestamptz)
      UNION ALL
      SELECT * FROM llm_calls
       WHERE company_id = $1 AND created_at >= GREATEST(b.lo, $2::timestamptz,
           CASE WHEN st.coverage_from IS NULL OR st.completed_through IS NULL THEN b.lo
                ELSE LEAST(b.hi, st.completed_through) END)
         AND created_at < $3::timestamptz
    ) l
) `

export interface UsageMetadata {
  timezone: 'UTC'
  aggregatedAt: string | null
  completedThrough: string | null
  aggregationStatus: 'pending' | 'ready' | 'failed' | 'paused' | 'stale'
  rawRetentionFrom: string | null
  earliestRawAt: string | null
  logsComplete: boolean
  boundaryComplete: boolean
  aggregationVersion: 2
  legacyBefore: string | null
}

export async function usageMetadata(tenant: string, range: UsageRange): Promise<UsageMetadata> {
  const intervalMs = automationNumber('llm_rollup_interval_ms')
  const retentionDays = automationNumber('db_gc_llm_calls_days')
  const paused = isLlmRollupPaused()
  const { rows } = await pool.query<{
    coverage_from: Date | null; aggregated_at: Date | null; completed_through: Date | null; status: UsageMetadata['aggregationStatus']
    raw_retention_from: Date | null; earliest_raw_at: Date | null; stale: boolean
  }>(`SELECT st.coverage_from, st.aggregated_at, st.completed_through, st.status,
             CASE WHEN $3::double precision > 0 THEN NOW() - ($3 * INTERVAL '1 day') END AS raw_retention_from,
             (SELECT created_at FROM llm_calls WHERE company_id = $1 ORDER BY created_at LIMIT 1) AS earliest_raw_at,
             st.aggregated_at < NOW() - ($2::double precision * INTERVAL '1 millisecond') AS stale
        FROM llm_rollup_state st WHERE st.id`,
  [tenant, Math.max(300_000, intervalMs * 3),
    retentionDays])
  const r = rows[0]!
  const retained = r.raw_retention_from ? new Date(r.raw_retention_from).getTime() : -Infinity
  const from = range.from.getTime(), to = range.to.getTime()
  return {
    timezone: 'UTC', aggregatedAt: r.aggregated_at ? new Date(r.aggregated_at).toISOString() : null,
    completedThrough: r.completed_through ? new Date(r.completed_through).toISOString() : null,
    aggregationStatus: paused ? 'paused'
      : r.status === 'ready' && r.stale ? 'stale' : r.status,
    rawRetentionFrom: Number.isFinite(retained) ? new Date(retained).toISOString() : null,
    earliestRawAt: r.earliest_raw_at ? new Date(r.earliest_raw_at).toISOString() : null,
    logsComplete: from >= retained,
    boundaryComplete: (from % HOUR_MS === 0 || from >= retained) && (to % HOUR_MS === 0 || Math.max(from, Math.floor(to / HOUR_MS) * HOUR_MS) >= retained),
    aggregationVersion: 2,
    legacyBefore: r.coverage_from ? new Date(r.coverage_from).toISOString() : null,
  }
}

const USAGE_PLATFORM_LABELS: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', gemini: 'Gemini',
  xai: 'xAI', grok: 'Grok', kimi: 'Kimi', deepseek: 'DeepSeek', dashscope: 'DashScope',
  novita: 'Novita', orcarouter: 'OrcaRouter', 'chatgpt-web': 'ChatGPT Web',
  antigravity: 'Antigravity', zhipu: 'Zhipu', minimax: 'MiniMax', composite: 'Composite',
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

/** Prefer the ledger platform string; family prefixes only fill a missing platform. */
export function usageProvider(model: string, platform: string | null | undefined): string {
  const trimmed = platform?.trim() ?? ''
  const key = trimmed.toLowerCase()
  if (key) return USAGE_PLATFORM_LABELS[key] ?? trimmed
  return providerForModel(model)
}

export interface UsageSummary {
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
  requests: string; input_tokens: string; output_tokens: string
  cache_read: string; cache_write: string; reasoning: string
  cost_usd: string; cost_estimated: boolean; ok: string
  unknown_calls: string; unpriced_calls: string; quality_unknown_calls: string; sources: string[]
}

export async function usageSummary(tenant: string, range: UsageRange, source?: string): Promise<UsageSummary> {
  const { rows } = await pool.query<SummaryRow>(
    `${WINDOW_SQL}SELECT COALESCE(SUM(calls), 0)::text AS requests,
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
            ARRAY_AGG(DISTINCT source) FILTER (WHERE source IS NOT NULL) AS sources
       FROM usage_window
      WHERE company_id = $1
        AND ($4::text IS NULL OR source = $4)`,
    [tenant, range.from.toISOString(), range.to.toISOString(), source ?? null],
  )
  const r = rows[0]
  if (!r) return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, costEstimated: false, cacheHitRate: 0, successRate: 0 }
  const requests = Number(r.requests)
  const inputTokens = Number(r.input_tokens)
  const cacheReadTokens = Number(r.cache_read)
  return {
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
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export async function usageTrend(tenant: string, range: UsageRange, granularity: 'hour' | 'day'): Promise<TrendPoint[]> {
  const { rows } = await pool.query<{ bucket: Date; cost_usd: string; input_tokens: string; output_tokens: string; cache_read: string }>(
    `${WINDOW_SQL}SELECT date_trunc($4, bucket_hour, 'UTC') AS bucket,
            COALESCE(SUM(cost_usd), 0)::text            AS cost_usd,
            COALESCE(SUM(input_tokens), 0)::text        AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text       AS output_tokens,
            COALESCE(SUM(cached_input_tokens), 0)::text AS cache_read
       FROM usage_window
      WHERE company_id = $1
      GROUP BY 1 ORDER BY 1`,
    [tenant, range.from.toISOString(), range.to.toISOString(), granularity],
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
      costUsd: Number(r?.cost_usd ?? 0),
      inputTokens: Number(r?.input_tokens ?? 0),
      outputTokens: Number(r?.output_tokens ?? 0),
      cacheReadTokens: Number(r?.cache_read ?? 0),
    })
  }
  return out
}

export interface AgentUsageRow {
  agentId: string
  name: string
  avatarUrl: string | null
  source: 'managed' | 'byoa'
  actualSource?: string
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  successRate: number
}

export async function usageByAgent(tenant: string, range: UsageRange): Promise<AgentUsageRow[]> {
  const { rows } = await pool.query<{
    agent_id: string; name: string | null; avatar_url: string | null; source: string
    requests: string; input_tokens: string; output_tokens: string; cost_usd: string; ok: string
  }>(
    `${WINDOW_SQL}SELECT l.agent_id,
            p.name, p.avatar_url, l.source
            ,
            COALESCE(SUM(l.calls), 0)::text          AS requests,
            COALESCE(SUM(l.input_tokens + l.cached_input_tokens), 0)::text  AS input_tokens,
            COALESCE(SUM(l.output_tokens), 0)::text  AS output_tokens,
            COALESCE(SUM(l.cost_usd), 0)::text       AS cost_usd,
            COALESCE(SUM(l.ok_calls), 0)::text       AS ok
       FROM usage_window l
       LEFT JOIN participants p ON p.id = l.agent_id AND p.company_id = l.company_id
      WHERE l.company_id = $1
      GROUP BY l.agent_id, p.name, p.avatar_url, l.source
      ORDER BY SUM(l.cost_usd) DESC NULLS LAST`,
    [tenant, range.from.toISOString(), range.to.toISOString()],
  )
  return rows.map((r) => ({
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

export interface ModelUsageRow {
  model: string
  provider: string
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  costEstimated: boolean
  route?: string | null
  platform?: string | null
  source?: string
  unknownRequests?: number
  unpricedRequests?: number
  qualityUnknownRequests?: number
}

interface ModelRollupRow {
  model: string
  route: string | null
  platform: string | null
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

async function queryUsageByModelRows(tenant: string, range: UsageRange, byPlatform = false): Promise<ModelRollupRow[]> {
  const { rows } = await pool.query<ModelRollupRow>(
    `${WINDOW_SQL}SELECT model,
            CASE WHEN COUNT(route) = COUNT(*) AND COUNT(DISTINCT route) = 1 THEN MIN(route) END AS route,
            CASE WHEN COUNT(DISTINCT LOWER(platform)) = 1 THEN MIN(LOWER(platform)) END AS platform,
            CASE WHEN COUNT(DISTINCT source) = 1 THEN MIN(source) ELSE 'mixed' END AS source,
            COALESCE(SUM(calls), 0)::text AS requests,
            COALESCE(SUM(input_tokens + cached_input_tokens), 0)::text AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
            COALESCE(SUM(cost_usd), 0)::text AS cost_usd,
            COALESCE(BOOL_OR(cost_estimated), false) AS cost_estimated,
            COALESCE(SUM(unknown_calls), 0)::text AS unknown_calls,
            COALESCE(SUM(unpriced_calls), 0)::text AS unpriced_calls,
            COALESCE(SUM(quality_unknown_calls), 0)::text AS quality_unknown_calls
       FROM usage_window
      WHERE company_id = $1
      GROUP BY model${byPlatform ? ', LOWER(platform)' : ''}
      ORDER BY SUM(cost_usd) DESC NULLS LAST`,
    [tenant, range.from.toISOString(), range.to.toISOString()],
  )
  return rows
}

export async function usageByModel(tenant: string, range: UsageRange): Promise<ModelUsageRow[]> {
  const rows = await queryUsageByModelRows(tenant, range)
  return rows.map((r) => ({
    model: r.model,
    provider: usageProvider(r.model, r.platform),
    route: r.route, platform: r.platform, source: r.source,
    unknownRequests: Number(r.unknown_calls ?? 0), unpricedRequests: Number(r.unpriced_calls ?? 0),
    qualityUnknownRequests: Number(r.quality_unknown_calls ?? 0),
    requests: Number(r.requests),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costUsd: Number(r.cost_usd),
    costEstimated: r.cost_estimated,
  }))
}

export interface ProviderUsageRow {
  provider: string
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export async function usageByProvider(tenant: string, range: UsageRange): Promise<ProviderUsageRow[]> {
  const models = await queryUsageByModelRows(tenant, range, true)
  const acc = new Map<string, ProviderUsageRow>()
  for (const model of models) {
    const provider = usageProvider(model.model, model.platform)
    const row = acc.get(provider) ?? { provider, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    row.requests += Number(model.requests)
    row.inputTokens += Number(model.input_tokens)
    row.outputTokens += Number(model.output_tokens)
    row.costUsd += Number(model.cost_usd)
    acc.set(provider, row)
  }
  return [...acc.values()].sort((a, b) => b.costUsd - a.costUsd)
}

// Expose only known failure categories; upstream messages may contain credentials or endpoints.
function usageLogFailureReason(status: string, reason: string | null, httpStatus: string | null): string | null {
  if (status === 'ok') return null
  if (reason && /^(?:cancelled|non-fallbackable-error|upstream-http-[45]\d{2}|transport:(?:APIConnectionError|APIConnectionTimeoutError|TimeoutError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET))$/.test(reason)) return reason
  if (httpStatus && /^[45]\d{2}$/.test(httpStatus)) return 'upstream-http-' + httpStatus
  if (status === 'rate_limited') return 'rate_limited'
  if (status === 'timeout') return 'timeout'
  return 'failed'
}

export interface UsageLogRow {
  id: string
  createdAt: string
  agentId: string | null
  agentName: string | null
  model: string
  provider: string
  purpose: string
  source: string
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
}

export async function usageLogs(
  tenant: string,
  range: UsageRange,
  args: { page: number; pageSize: number; source?: string },
): Promise<UsageLogPage> {
  const { page, pageSize } = parseUsagePagination(args)
  const params: unknown[] = [tenant, range.from.toISOString(), range.to.toISOString(), args.source ?? null]
  const where = `l.company_id = $1 AND l.created_at >= $2 AND l.created_at < $3 AND ($4::text IS NULL OR l.source = $4)`
  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM llm_calls l WHERE ${where}`, params,
  )
  const { rows } = await pool.query<{
    id: string; created_at: Date; agent_id: string | null; agent_name: string | null
    model: string; purpose: string; source: string
    input_tokens: number | null; output_tokens: number | null; cost_usd: string | null
    latency_ms: number | null; status: string
    measured: boolean; cost_estimated: boolean; unpriced: boolean; route: string | null; platform: string | null
    requested_model: string | null; actual_model: string | null
    failure_reason: string | null; failure_stage: string | null; http_status: string | null
    call_id: string | null; attempt: string | null
  }>(
    `SELECT l.id, l.created_at, l.agent_id, p.name AS agent_name,
            l.model, l.purpose, l.source,
            l.input_tokens + COALESCE(l.cached_input_tokens, 0) AS input_tokens,
            l.output_tokens, l.cost_usd::text, l.latency_ms, l.status, l.measured, l.cost_estimated,
            (COALESCE(l.extras->>'unpriced', '') NOT IN ('', 'false')) AS unpriced,
            l.extras->>'route' AS route, l.extras->>'platform' AS platform,
            COALESCE(NULLIF(l.extras->>'requestedModel', ''), l.model) AS requested_model,
            NULLIF(l.extras->>'actualModel', '') AS actual_model,
            l.extras->>'failureReason' AS failure_reason, l.extras->>'failureStage' AS failure_stage,
            l.extras->>'httpStatus' AS http_status,
            COALESCE(NULLIF(l.extras->>'logicalCallId', ''), NULLIF(l.extras->>'callId', '')) AS call_id,
            l.extras->>'attempt' AS attempt
       FROM llm_calls l
       LEFT JOIN participants p ON p.id = l.agent_id AND p.company_id = l.company_id
      WHERE ${where}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $5 OFFSET $6`,
    [...params, pageSize, (page - 1) * pageSize],
  )
  return {
    items: rows.map((r) => ({
      id: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      agentId: r.agent_id,
      agentName: r.agent_name,
      model: r.model,
      provider: usageProvider(r.model, r.platform),
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
      failureStage: r.status !== 'ok' && ['generation', 'poll', 'download', 'storage'].includes(r.failure_stage ?? '') ? r.failure_stage : null,
      httpStatus: r.http_status && /^[1-5]\d{2}$/.test(r.http_status) ? Number(r.http_status) : null,
      callId: r.call_id || null,
      attempt: r.attempt && /^[1-9]\d*$/.test(r.attempt) && Number.isSafeInteger(Number(r.attempt)) ? Number(r.attempt) : null,
    })),
    total: Number(countRows[0]?.total ?? 0),
    page,
    pageSize,
  }
}
