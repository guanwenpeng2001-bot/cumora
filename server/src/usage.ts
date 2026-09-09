/**
 * Usage dashboard aggregation — pure reads over the llm_calls rollup,
 * scoped to the tenant. Powers the settings-page usage dashboard
 * (totals cards, trend chart, per-agent/model/provider breakdowns,
 * paginated request log). Never writes.
 */
import { pool } from './db/pool.js'

export interface UsageRange { from: Date; to: Date }

/** Parse ?from=&to= ISO params; clamp to sane bounds (max 92 days back). */
export function parseUsageRange(q: { from?: unknown; to?: unknown }): UsageRange {
  const now = Date.now()
  const parse = (v: unknown): number | null => {
    if (typeof v !== 'string' || !v) return null
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  const to = parse(q.to) ?? now
  const from = parse(q.from) ?? new Date(now).setHours(0, 0, 0, 0)
  const minFrom = now - 92 * 86_400_000
  return { from: new Date(Math.max(from, minFrom)), to: new Date(Math.min(to, now + 86_400_000)) }
}

/** Provider label from a model id. Prefix routes win (they name the
 *  relay); otherwise family substring. Heuristic by design — the ledger
 *  doesn't record the upstream account. */
export function providerForModel(model: string | null | undefined): string {
  const m = (model ?? '').toLowerCase()
  if (!m) return 'unknown'
  if (m.startsWith('novita/')) return 'Novita'
  if (m.startsWith('orcarouter/')) return 'OrcaRouter'
  if (/^k3|^kimi|moonshot/.test(m)) return 'Kimi'
  if (m.includes('deepseek')) return 'DeepSeek'
  if (/^qwen|^wan\d|^z-image|^fun-asr/.test(m)) return 'DashScope'
  if (m.startsWith('gpt') || m.startsWith('o3') || m.startsWith('o4')) return 'OpenAI'
  if (m.startsWith('claude')) return 'Anthropic'
  if (m.startsWith('gemini')) return 'Google'
  if (m.startsWith('grok')) return 'xAI'
  if (m.startsWith('antigravity')) return 'Antigravity'
  if (m.startsWith('chatgpt-web/')) return 'ChatGPT Web'
  return 'other'
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
  cacheHitRate: number
  successRate: number
}

interface SummaryRow {
  requests: string; input_tokens: string; output_tokens: string
  cache_read: string; cache_write: string; reasoning: string
  cost_usd: string; cost_estimated: boolean; ok: string
}

export async function usageSummary(tenant: string, range: UsageRange, source?: string): Promise<UsageSummary> {
  const { rows } = await pool.query<SummaryRow>(
    `SELECT COALESCE(SUM(calls), 0)::text AS requests,
            COALESCE(SUM(input_tokens), 0)::text           AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text          AS output_tokens,
            COALESCE(SUM(cached_input_tokens), 0)::text    AS cache_read,
            COALESCE(SUM(cache_creation_tokens), 0)::text  AS cache_write,
            COALESCE(SUM(reasoning_tokens), 0)::text       AS reasoning,
            COALESCE(SUM(cost_usd), 0)::text               AS cost_usd,
            COALESCE(BOOL_OR(cost_estimated), false)      AS cost_estimated,
            COALESCE(SUM(ok_calls), 0)::text            AS ok
       FROM llm_calls_rollup
      WHERE company_id = $1 AND bucket_hour >= $2 AND bucket_hour < $3
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
    `SELECT date_trunc($4, bucket_hour) AS bucket,
            COALESCE(SUM(cost_usd), 0)::text            AS cost_usd,
            COALESCE(SUM(input_tokens), 0)::text        AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text       AS output_tokens,
            COALESCE(SUM(cached_input_tokens), 0)::text AS cache_read
       FROM llm_calls_rollup
      WHERE company_id = $1 AND bucket_hour >= $2 AND bucket_hour < $3
      GROUP BY 1 ORDER BY 1`,
    [tenant, range.from.toISOString(), range.to.toISOString(), granularity],
  )
  const byBucket = new Map(rows.map((r) => [new Date(r.bucket).toISOString(), r]))
  // Gap-fill so the chart axis is continuous.
  const stepMs = granularity === 'hour' ? 3_600_000 : 86_400_000
  const out: TrendPoint[] = []
  for (let t = range.from.getTime(); t < range.to.getTime(); t += stepMs) {
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
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  successRate: number
}

export async function usageByAgent(tenant: string, range: UsageRange): Promise<AgentUsageRow[]> {
  const { rows } = await pool.query<{
    agent_id: string; name: string | null; avatar_url: string | null; kind: string | null
    requests: string; input_tokens: string; output_tokens: string; cost_usd: string; ok: string
  }>(
    `SELECT l.agent_id,
            p.name, p.avatar_url, c.kind
            ,
            COALESCE(SUM(l.calls), 0)::text          AS requests,
            COALESCE(SUM(l.input_tokens + l.cached_input_tokens), 0)::text  AS input_tokens,
            COALESCE(SUM(l.output_tokens), 0)::text  AS output_tokens,
            COALESCE(SUM(l.cost_usd), 0)::text       AS cost_usd,
            COALESCE(SUM(l.ok_calls), 0)::text       AS ok
       FROM llm_calls_rollup l
       LEFT JOIN participants p ON p.id = l.agent_id
       LEFT JOIN computers c ON c.id = p.computer_id
      WHERE l.company_id = $1 AND l.bucket_hour >= $2 AND l.bucket_hour < $3
      GROUP BY l.agent_id, p.name, p.avatar_url, c.kind
      ORDER BY SUM(l.cost_usd) DESC NULLS LAST`,
    [tenant, range.from.toISOString(), range.to.toISOString()],
  )
  return rows.map((r) => ({
    agentId: r.agent_id,
    name: r.name ?? r.agent_id ?? '—',
    avatarUrl: r.avatar_url,
    source: r.kind === 'cloud' ? 'managed' : 'byoa',
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
}

interface ModelRollupRow {
  model: string
  requests: string
  input_tokens: string
  output_tokens: string
  cost_usd: string
  cost_estimated: boolean
}

async function queryUsageByModelRows(tenant: string, range: UsageRange): Promise<ModelRollupRow[]> {
  const { rows } = await pool.query<ModelRollupRow>(
    `SELECT model,
            COALESCE(SUM(calls), 0)::text AS requests,
            COALESCE(SUM(input_tokens + cached_input_tokens), 0)::text AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
            COALESCE(SUM(cost_usd), 0)::text AS cost_usd,
            COALESCE(BOOL_OR(cost_estimated), false) AS cost_estimated
       FROM llm_calls_rollup
      WHERE company_id = $1 AND bucket_hour >= $2 AND bucket_hour < $3
      GROUP BY model
      ORDER BY SUM(cost_usd) DESC NULLS LAST`,
    [tenant, range.from.toISOString(), range.to.toISOString()],
  )
  return rows
}

export async function usageByModel(tenant: string, range: UsageRange): Promise<ModelUsageRow[]> {
  const rows = await queryUsageByModelRows(tenant, range)
  return rows.map((r) => ({
    model: r.model,
    provider: providerForModel(r.model),
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
  const models = await queryUsageByModelRows(tenant, range)
  const acc = new Map<string, ProviderUsageRow>()
  for (const model of models) {
    const provider = providerForModel(model.model)
    const row = acc.get(provider) ?? { provider, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    row.requests += Number(model.requests)
    row.inputTokens += Number(model.input_tokens)
    row.outputTokens += Number(model.output_tokens)
    row.costUsd += Number(model.cost_usd)
    acc.set(provider, row)
  }
  return [...acc.values()].sort((a, b) => b.costUsd - a.costUsd)
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
  const page = Math.max(1, args.page)
  const pageSize = Math.min(200, Math.max(1, args.pageSize))
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
  }>(
    `SELECT l.id, l.created_at, l.agent_id, p.name AS agent_name,
            l.model, l.purpose, l.source,
            l.input_tokens + COALESCE(l.cached_input_tokens, 0) AS input_tokens,
            l.output_tokens, l.cost_usd::text, l.latency_ms, l.status
       FROM llm_calls l
       LEFT JOIN participants p ON p.id = l.agent_id
      WHERE ${where}
      ORDER BY l.created_at DESC
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
      provider: providerForModel(r.model),
      purpose: r.purpose,
      source: r.source,
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      costUsd: Number(r.cost_usd ?? 0),
      latencyMs: r.latency_ms,
      status: r.status,
    })),
    total: Number(countRows[0]?.total ?? 0),
    page,
    pageSize,
  }
}
