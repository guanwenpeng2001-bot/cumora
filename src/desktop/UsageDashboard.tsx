/**
 * Usage dashboard (settings → usage tab, below the quota cards).
 * cc-switch-style: totals cards, a self-drawn SVG multi-line trend,
 * dimension tabs (agent / model / provider), and a paginated request log.
 * All data from GET /api/usage/* (pure ledger reads).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api, ApiError, resolveAssetUrl,
  type ApiUsageTrendPoint, type ApiUsageMetadata,
} from '@/api/client'
import { translate, useLocale, useT } from '@/lib/i18n'
import { useAuth } from '@/stores/auth'

type T = ReturnType<typeof useT>
import { cn } from '@/lib/utils'

type RangePreset = 'today' | 'week' | 'custom'

function localDateToIso(value: string, endExclusive = false): string {
  const [year, month, day] = value.split('-').map(Number)
  const date = endExclusive
    ? new Date(year, month - 1, day + 1)
    : new Date(year, month - 1, day)
  return date.toISOString()
}

function rangeOf(preset: RangePreset, customFrom: string, customTo: string): { from: string; to: string } {
  const now = new Date()
  const to = new Date(now.getTime() + 60_000)
  if (preset === 'today') {
    return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), to: to.toISOString() }
  }
  if (preset === 'week') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // Monday
    return { from: d.toISOString(), to: to.toISOString() }
  }
  return {
    from: customFrom ? localDateToIso(customFrom) : new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    to: customTo ? localDateToIso(customTo, true) : to.toISOString(),
  }
}

function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}
function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
}
function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}
function fmtTime(iso: string, granularity: 'hour' | 'day'): string {
  const d = new Date(iso)
  return granularity === 'hour'
    ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`
    : `${d.getMonth() + 1}/${d.getDate()}`
}

/** Self-drawn multi-line SVG chart — one polyline per metric, each
 *  normalized to its own max (absolute scales differ wildly across cost
 *  vs tokens). No chart lib; the repo stays dependency-free. */
function TrendChart({ points, granularity, t }: {
  points: ApiUsageTrendPoint[]
  granularity: 'hour' | 'day'
  t: T
}) {
  const W = 720
  const H = 180
  const PAD = { l: 8, r: 8, t: 10, b: 22 }
  const series = [
    { key: 'costUsd' as const, color: 'var(--coral-deep)', label: t('me.usage.chartCost') },
    { key: 'inputTokens' as const, color: 'var(--skype)', label: t('me.usage.chartInput') },
    { key: 'outputTokens' as const, color: 'var(--gold-deep)', label: t('me.usage.chartOutput') },
    { key: 'cacheReadTokens' as const, color: 'var(--ink-300)', label: t('me.usage.chartCacheRead') },
  ]
  const n = points.length
  if (n === 0) return null
  const x = (i: number) => PAD.l + (i / Math.max(1, n - 1)) * (W - PAD.l - PAD.r)
  const lines = series.map((s) => {
    const max = Math.max(...points.map((p) => p[s.key]), 1e-9)
    const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b)
    return { ...s, max, d: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(' ') }
  })
  const labelEvery = Math.max(1, Math.ceil(n / 8))
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img">
        {lines.map((l) => (
          <path key={l.key} d={l.d} fill="none" stroke={l.color} strokeWidth={1.8} strokeLinejoin="round" opacity={0.9} />
        ))}
        {points.map((p, i) => i % labelEvery === 0 && (
          <text key={p.bucket} x={x(i)} y={H - 6} fontSize={9} fill="var(--ink-300)" textAnchor="middle">
            {fmtTime(p.bucket, granularity)}
          </text>
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 px-1">
        {lines.map((l) => (
          <span key={l.key} className="inline-flex items-center gap-1.5 text-[10.5px] text-ink-500">
            <span className="w-2.5 h-[2px] rounded" style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function UsageMetadata({ metadata }: { metadata?: ApiUsageMetadata }) {
  const locale = useLocale()
  const unknown = translate(locale, 'push.permUnknown')
  const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : unknown
  const states = {
    pending: translate(locale, 'settings.pending'), ready: translate(locale, 'ship.statusReady'),
    failed: translate(locale, 'settings.failed'), paused: translate(locale, 'settings.paused'), stale: translate(locale, 'settings.stale'),
  }
  return <div role="status" className="text-[11px] text-ink-500 space-y-1 my-2 break-words">
    <div>{translate(locale, 'settings.rollupStatus')}: {metadata ? states[metadata.aggregationStatus] ?? unknown : unknown}
      {' · '}{translate(locale, 'settings.completedThrough')}: {date(metadata?.completedThrough)}
      {' · '}{translate(locale, 'settings.aggregatedAt')}: {date(metadata?.aggregatedAt)}</div>
    {metadata && <>
      <div>{translate(locale, 'settings.rawRetentionStarts')}: {date(metadata.rawRetentionFrom)}
        {' · '}{translate(locale, 'settings.timezone')}: {metadata.timezone}</div>
      {(!metadata.logsComplete || !metadata.boundaryComplete) && <div className="text-coral-deep">
        {translate(locale, 'settings.windowIncompleteRetainedLogsOrBoundaryDataAreUnavailable')}
      </div>}
    </>}
  </div>
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-cloud rounded-[14px] p-4 min-w-0" style={{ border: '1px solid var(--ink-100)' }}>
      <div className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-300 truncate">{label}</div>
      <div className="font-display tabular-nums text-[20px] tracking-tight text-ink-900 mt-1 truncate" style={{ letterSpacing: '-0.02em' }}>{value}</div>
      {sub && <div className="font-display italic text-[11px] text-ink-500 mt-0.5 truncate">{sub}</div>}
    </div>
  )
}

type Dim = 'agent' | 'model' | 'provider'

type QueryState<D> = { loading: boolean; error: unknown; data: D | null }

function useUsageQuery<D>(request: (signal: AbortSignal) => Promise<D>, enabled: boolean, epoch: number): QueryState<D> {
  const sequence = useRef(0)
  const [result, setResult] = useState<{ request: typeof request; epoch: number; state: QueryState<D> } | null>(null)
  useEffect(() => {
    const id = ++sequence.current
    const controller = new AbortController()
    if (enabled) {
      const commit = (state: QueryState<D>) => {
        if (!controller.signal.aborted && sequence.current === id && useAuth.getState().contextEpoch === epoch) {
          setResult({ request, epoch, state })
        }
      }
      commit({ loading: true, error: null, data: null })
      void Promise.resolve().then(() => {
        if (controller.signal.aborted) return
        return request(controller.signal).then(
          (data) => commit({ loading: false, error: null, data }),
          (error: unknown) => commit({ loading: false, error, data: null }),
        )
      }).catch((error: unknown) => commit({ loading: false, error, data: null }))
    }
    return () => { controller.abort(); sequence.current++ }
  }, [request, enabled, epoch])
  return enabled && result?.request === request && result.epoch === epoch
    ? result.state
    : { loading: enabled, error: null, data: null }
}

export function UsageDashboard() {
  const epoch = useAuth((s) => s.contextEpoch)
  return <UsageDashboardContent key={epoch} />
}

function UsageDashboardContent() {
  const t = useT()
  const [preset, setPreset] = useState<RangePreset>('today')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [granularity, setGranularity] = useState<'hour' | 'day'>('hour')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [dim, setDim] = useState<Dim>('agent')
  const [page, setPage] = useState(1)
  const epoch = useAuth((s) => s.contextEpoch)
  const ready = useAuth((s) => s.ready)
  const token = useAuth((s) => s.token)
  const companyId = useAuth((s) => s.activeCompanyId)
  const locale = useLocale()
  const [refresh, setRefresh] = useState(0)
  const range = useMemo(() => {
    try { return rangeOf(preset, customFrom, customTo) } catch { return null }
  }, [preset, customFrom, customTo, refresh])
  const invalidRange = !range || Date.parse(range.from) >= Date.parse(range.to)
  const blocked = !ready ? translate(locale, 'settings.loadingCompanyContext')
    : !token ? translate(locale, 'settings.signInToViewUsage')
    : !companyId ? translate(locale, 'settings.selectACompanyToViewUsage')
    : invalidRange ? translate(locale, 'settings.startTimeMustBeBeforeEndTime') : null
  const enabled = blocked === null
  const from = range?.from ?? ''
  const to = range?.to ?? ''
  const summaryQuery = useUsageQuery(useCallback((signal: AbortSignal) => api.getUsageSummary(from, to, undefined, signal), [range, refresh]), enabled, epoch)
  const trendQuery = useUsageQuery(useCallback((signal: AbortSignal) => api.getUsageTrend(from, to, granularity, signal), [range, refresh, granularity]), enabled, epoch)
  const agentQuery = useUsageQuery(useCallback((signal: AbortSignal) => api.getUsageByAgent(from, to, signal), [range, refresh]), enabled, epoch)
  const modelQuery = useUsageQuery(useCallback((signal: AbortSignal) => api.getUsageByModel(from, to, signal), [range, refresh]), enabled, epoch)
  const providerQuery = useUsageQuery(useCallback((signal: AbortSignal) => api.getUsageByProvider(from, to, signal), [range, refresh]), enabled, epoch)
  const logsQuery = useUsageQuery(useCallback((signal: AbortSignal) => api.getUsageLogs(from, to, page, 50, undefined, signal), [range, refresh, page]), enabled, epoch)
  const summary = summaryQuery.data
  const trend = trendQuery.data?.points ?? []
  const byAgent = agentQuery.data?.items ?? []
  const byModel = modelQuery.data?.items ?? []
  const byProvider = providerQuery.data?.items ?? []
  const logs = logsQuery.data
  const unknown = translate(locale, 'push.permUnknown')
  const partial = !summary || summary.unknownRequests == null || summary.unpricedRequests == null || summary.qualityUnknownRequests == null
    || summary.unknownRequests > 0 || summary.unpricedRequests > 0 || summary.qualityUnknownRequests > 0
    || summary.metadata?.boundaryComplete !== true
  const tokensUnknown = summary && summary.requests > 0 && (summary.unknownRequests == null || summary.unknownRequests >= summary.requests)
  const load = useCallback(() => setRefresh((value) => value + 1), [])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(load, 60_000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, load])

  const status = (query: QueryState<unknown>, empty: boolean) => {
    let message = blocked
    if (!message && query.loading) message = translate(locale, 'common.loading')
    if (!message && query.error) {
      const code = query.error instanceof ApiError ? query.error.status : null
      message = code === 401 ? translate(locale, 'settings.sessionExpiredSignInAgain')
        : code === 403 ? translate(locale, 'settings.youDoNotHavePermissionToViewThisUsage')
        : code === 404 ? translate(locale, 'settings.thisUsageEndpointIsUnavailableOnTheCurrentServer')
        : translate(locale, 'settings.loadingFailedClickRefreshToRetry')
    }
    if (!message && empty) message = translate(locale, 'settings.noDataInTheSelectedTimeRange')
    return message ? <div role={query.error || invalidRange ? 'alert' : 'status'} className={cn('text-[11.5px] py-2', query.error || invalidRange ? 'text-coral-deep' : 'text-ink-500')}>{message}</div> : null
  }

  const th = 'text-left text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-300 py-2 pr-3'
  const td = 'py-2 pr-3 text-[12px] text-ink-700 tabular-nums truncate'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {(['today', 'week', 'custom'] as const).map((p) => (
          <button key={p} type="button" onClick={() => { setPreset(p); setPage(1) }}
            className={cn('h-7 px-3 rounded-full text-[12px] font-semibold transition',
              preset === p ? 'bg-skype text-white' : 'bg-cloud text-ink-500 hover:text-skype-deep')}
            style={preset === p ? {} : { border: '1px solid var(--ink-100)' }}>
            {t(`me.usage.range.${p}`)}
          </button>
        ))}
        {preset === 'custom' && (
          <>
            <input type="date" value={customFrom} onChange={(e) => { setCustomFrom(e.target.value); setPage(1) }}
              className="h-7 px-2 rounded-[7px] text-[12px] text-ink-700 bg-cloud outline-none" style={{ border: '1px solid var(--ink-100)' }} />
            <span className="text-ink-300 text-[12px]">→</span>
            <input type="date" value={customTo} onChange={(e) => { setCustomTo(e.target.value); setPage(1) }}
              className="h-7 px-2 rounded-[7px] text-[12px] text-ink-700 bg-cloud outline-none" style={{ border: '1px solid var(--ink-100)' }} />
          </>
        )}
        <div className="ml-auto flex items-center gap-3">
          <label className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-500 cursor-pointer select-none">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="accent-skype" />
            {t('me.usage.autoRefresh')}
          </label>
          <button type="button" onClick={load}
            className="h-7 px-3 rounded-[8px] text-[11.5px] font-semibold text-skype-deep bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}>
            {t('me.refresh')}
          </button>
        </div>
      </div>
      {status(summaryQuery, summary?.requests === 0)}
      {summary && <>
        <UsageMetadata metadata={summary.metadata} />
        <div className="text-[11.5px] text-ink-500 break-words">
          {translate(locale, 'settings.unmeasuredRequests')}: {summary.unknownRequests ?? unknown}
          {' · '}{translate(locale, 'settings.unpricedRequests')}: {summary.unpricedRequests ?? unknown}
          {' · '}{translate(locale, 'settings.requestsWithUnknownQuality')}: {summary.qualityUnknownRequests ?? unknown}
          {' · '}{t('adminobs.colSource')}: {summary.sources?.join(', ') || unknown}
          <div>{translate(locale, 'settings.amountsAreKnownCumoraReferenceCostsSeparateFromSub2api')}</div>
          {partial && <div className="text-coral-deep">{translate(locale, 'settings.theStatisticsBelowIncludeKnownPortionsOnlyNotComplete')}</div>}
        </div>
      </>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label={t('me.usage.totalTokens')} value={summary ? tokensUnknown ? unknown : `${fmtTokens(summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens + summary.outputTokens)}${partial ? ' *' : ''}` : '—'}
          sub={tokensUnknown ? translate(locale, 'settings.completeMeasurementUnavailable') : summary ? `${t('me.usage.inShort')} ${fmtTokens(summary.inputTokens + summary.cacheReadTokens)} · ${t('me.usage.outShort')} ${fmtTokens(summary.outputTokens)}` : undefined} />
        <Card label={t('me.usage.requests')} value={summary ? String(summary.requests) : '—'}
          sub={summary ? `${t('me.usage.successRate')} ${fmtPct(summary.successRate)}` : undefined} />
        <Card label={translate(locale, 'settings.cumoraReferenceCost')} value={summary ? partial && summary.costUsd === 0 ? unknown : `${fmtUsd(summary.costUsd)}${partial ? ' *' : ''}` : '—'}
          sub={partial ? translate(locale, 'settings.knownPortionOnlyUnknownIsNotZero') : summary?.costEstimated ? t('me.usage.costEstimated') : undefined} />
        <Card label={t('me.usage.cacheHit')} value={summary ? tokensUnknown ? unknown : fmtPct(summary.cacheHitRate) : '—'}
          sub={summary ? `${t('me.usage.chartCacheRead')} ${fmtTokens(summary.cacheReadTokens)} · ${t('me.usage.chartCacheWrite')} ${fmtTokens(summary.cacheWriteTokens)}` : undefined} />
      </div>

      <div className="bg-cloud rounded-[14px] p-4" style={{ border: '1px solid var(--ink-100)' }}>
        <div className="flex items-center mb-2">
          <div className="text-[12px] font-semibold text-ink-700">{t('me.usage.trend')}</div>
          <div className="ml-auto flex gap-1">
            {(['hour', 'day'] as const).map((g) => (
              <button key={g} type="button" onClick={() => setGranularity(g)}
                className={cn('h-6 px-2 rounded-[6px] text-[10.5px] font-semibold transition',
                  granularity === g ? 'bg-sky2-100 text-skype-deep' : 'text-ink-400 hover:text-ink-700')}>
                {t(`me.usage.granularity.${g}`)}
              </button>
            ))}
          </div>
        </div>
        {status(trendQuery, trend.length === 0)}
        {trendQuery.data && <UsageMetadata metadata={trendQuery.data.metadata} />}
        <div className="text-[11px] text-ink-500">{translate(locale, 'settings.trendAndGroupAmountsShowKnownReferenceCostsMissing')}</div>
        <TrendChart points={trend} granularity={granularity} t={t} />
      </div>

      <div className="bg-cloud rounded-[14px] p-4" style={{ border: '1px solid var(--ink-100)' }}>
        <div className="flex gap-1 mb-3 border-b border-ink-100">
          {(['agent', 'model', 'provider'] as const).map((d) => (
            <button key={d} type="button" onClick={() => setDim(d)}
              className={cn('py-2 px-4 text-[12px] font-semibold border-b-2 transition -mb-px',
                dim === d ? 'border-skype text-skype-deep' : 'border-transparent text-ink-500 hover:text-ink-700')}>
              {t(`me.usage.dim.${d}`)}
            </button>
          ))}
        </div>
        {dim === 'agent' && status(agentQuery, byAgent.length === 0)}
        {dim === 'model' && status(modelQuery, byModel.length === 0)}
        {dim === 'provider' && status(providerQuery, byProvider.length === 0)}
        {dim === 'agent' && agentQuery.data && <UsageMetadata metadata={agentQuery.data.metadata} />}
        {dim === 'model' && modelQuery.data && <UsageMetadata metadata={modelQuery.data.metadata} />}
        {dim === 'provider' && providerQuery.data && <UsageMetadata metadata={providerQuery.data.metadata} />}
        <div className="overflow-x-auto">
          {dim === 'agent' && (
            <table className="w-full border-collapse">
              <thead><tr>
                <th className={th}>{t('me.usage.colAgent')}</th><th className={th}>{t('me.usage.colTokens')}</th>
                <th className={th}>{translate(locale, 'settings.referenceCostKnown')}</th><th className={th}>{t('me.usage.colRequests')}</th>
                <th className={th}>{t('me.usage.colSuccess')}</th>
              </tr></thead>
              <tbody>
                {byAgent.map((r) => (
                  <tr key={JSON.stringify([r.agentId, r.actualSource, r.source])} className="border-t border-ink-100">
                    <td className={td}>
                      <span className="inline-flex items-center gap-2 min-w-0">
                        {r.avatarUrl
                          ? <img src={resolveAssetUrl(r.avatarUrl)} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
                          : <span className="w-5 h-5 rounded-full bg-ink-100 grid place-items-center text-[9px] font-bold text-ink-500 shrink-0">{(r.name || '?').charAt(0).toUpperCase()}</span>}
                        <span className="font-semibold text-ink-900 truncate">{r.name}</span>
                        <span className="text-[9.5px] text-ink-300 shrink-0">{r.actualSource || unknown}</span>
                      </span>
                    </td>
                    <td className={td}>{fmtTokens(r.inputTokens + r.outputTokens)}</td>
                    <td className={td}>{fmtUsd(r.costUsd)}</td>
                    <td className={td}>{r.requests}</td>
                    <td className={td}>{fmtPct(r.successRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {dim === 'model' && (
            <table className="w-full border-collapse">
              <thead><tr>
                <th className={th}>{t('me.usage.colModel')}</th><th className={th}>{t('me.usage.colProvider')}</th>
                <th className={th}>{t('me.usage.colTokens')}</th><th className={th}>{translate(locale, 'settings.referenceCostKnown')}</th>
                <th className={th}>{t('me.usage.colRequests')}</th>
              </tr></thead>
              <tbody>
                {byModel.map((r) => (
                  <tr key={JSON.stringify([r.model, r.route, r.platform, r.source])} className="border-t border-ink-100">
                    <td className={cn(td, 'font-mono')}>
                      {r.model}
                      <div className="text-[10px] whitespace-normal">{t('settings.route')}: {r.route ?? unknown} · {t('settings.platform')}: {r.platform ?? unknown} · {t('adminobs.colSource')}: {r.source ?? unknown}</div>
                      <div className="text-[10px] whitespace-normal">{translate(locale, 'settings.unmeasuredUnpricedUnknownQuality')}: {r.unknownRequests ?? unknown} / {r.unpricedRequests ?? unknown} / {r.qualityUnknownRequests ?? unknown}</div>
                    </td>
                    <td className={td}>{r.provider}</td>
                    <td className={td}>{fmtTokens(r.inputTokens + r.outputTokens)}</td>
                    <td className={td}>{fmtUsd(r.costUsd)}{r.costEstimated && <span className="text-ink-300 text-[10px]"> {t('me.usage.estimated')}</span>}</td>
                    <td className={td}>{r.requests}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {dim === 'provider' && (
            <table className="w-full border-collapse">
              <thead><tr>
                <th className={th}>{t('me.usage.colProvider')}</th><th className={th}>{t('me.usage.colTokens')}</th>
                <th className={th}>{translate(locale, 'settings.referenceCostKnown')}</th><th className={th}>{t('me.usage.colRequests')}</th>
              </tr></thead>
              <tbody>
                {byProvider.map((r) => (
                  <tr key={r.provider} className="border-t border-ink-100">
                    <td className={cn(td, 'font-semibold text-ink-900')}>{r.provider}</td>
                    <td className={td}>{fmtTokens(r.inputTokens + r.outputTokens)}</td>
                    <td className={td}>{fmtUsd(r.costUsd)}</td>
                    <td className={td}>{r.requests}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="bg-cloud rounded-[14px] p-4" style={{ border: '1px solid var(--ink-100)' }}>
        <div className="text-[12px] font-semibold text-ink-700 mb-2">{t('me.usage.logs')}</div>
        {status(logsQuery, logs?.items.length === 0)}
        {logs && <UsageMetadata metadata={logs.metadata} />}
        <div className="text-[11px] text-ink-500">{translate(locale, 'settings.eachRowIsAnApplicationAttemptUseCallidTo')}</div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr>
              <th className={th}>{t('me.usage.colTime')}</th><th className={th}>{t('me.usage.colAgent')}</th>
              <th className={th}>{t('me.usage.colModel')}</th><th className={th}>{t('me.usage.colIn')}</th>
              <th className={th}>{t('me.usage.colOut')}</th><th className={th}>{translate(locale, 'settings.referenceCostKnown')}</th>
              <th className={th}>{t('me.usage.colStatus')}</th>
            </tr></thead>
            <tbody>
              {(logs?.items ?? []).map((r) => (
                <tr key={r.id} className="border-t border-ink-100">
                  <td className={cn(td, 'whitespace-nowrap')}>{new Date(r.createdAt).toLocaleString()}</td>
                  <td className={td}>{r.agentName ?? '—'}</td>
                  <td className={cn(td, 'font-mono')}>
                    {r.actualModel || unknown}
                    <details className="text-[11px] whitespace-normal min-w-[220px] max-w-[360px] break-words">
                      <summary className="cursor-pointer">{translate(locale, 'settings.attemptDetails')} · #{r.attempt ?? unknown}</summary>
                      <div>{translate(locale, 'settings.requestedModel')}: {r.requestedModel || r.model || unknown}</div>
                      <div>{translate(locale, 'settings.actualModel')}: {r.actualModel || unknown}</div>
                      <div>{t('settings.route')}: {r.route ?? unknown} · {t('settings.platform')}: {r.platform ?? unknown}</div>
                      <div>{t('adminobs.colSource')}: {r.source || unknown} · {t('settings.provider')}: {r.provider || unknown}</div>
                      <div>{t('settings.purpose')}: {r.purpose || unknown}</div>
                      <div>{t('settings.callId')}: {r.callId ?? unknown} · {t('settings.attempt')}: {r.attempt ?? unknown}</div>
                      <div>{translate(locale, 'settings.ledgerId')}: {r.id}</div>
                      <div>{t('settings.agentId')}: {r.agentId ?? unknown}</div>
                      <div>{translate(locale, 'settings.sanitizedReason')}: {r.failureReason ?? unknown}</div>
                      <div>{translate(locale, 'settings.failureStage')}: {r.failureStage ?? unknown} · HTTP: {r.httpStatus ?? unknown}</div>
                      <div>{translate(locale, 'settings.latency')}: {r.latencyMs == null ? unknown : `${r.latencyMs} ms`}</div>
                    </details>
                  </td>
                  <td className={td}>{r.measured === true ? fmtTokens(r.inputTokens) : unknown}</td>
                  <td className={td}>{r.measured === true ? fmtTokens(r.outputTokens) : unknown}</td>
                  <td className={td}>{r.unpriced === true ? translate(locale, 'settings.unpriced') : r.measured !== true || r.unpriced !== false ? unknown : fmtUsd(r.costUsd)}
                    {r.costEstimated && <div>{t('me.usage.estimated')}</div>}
                  </td>
                  <td className={td}>
                    <span className={cn('text-[10.5px] font-semibold px-1.5 py-0.5 rounded', r.status === 'ok' ? 'text-skype-deep bg-sky2-50' : 'text-coral-deep bg-coral-soft')}>
                      {r.status}
                    </span>
                    <div className="text-[10px] whitespace-normal">{t('settings.measuredLabel')}: {r.measured === true ? translate(locale, 'settings.measured') : r.measured === false ? translate(locale, 'settings.unmeasured') : unknown}</div>
                    <div className="text-[10px] whitespace-normal">{t('settings.unpricedLabel')}: {r.unpriced === true ? translate(locale, 'settings.unpriced') : r.unpriced === false ? translate(locale, 'settings.priced') : unknown}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {logs && logs.total > logs.pageSize && (
          <div className="flex items-center gap-3 mt-3 justify-end">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}
              className="h-6 px-2.5 rounded-[6px] text-[11px] font-semibold text-ink-500 hover:bg-sky2-50 disabled:opacity-40">←</button>
            <span className="text-[11px] text-ink-400 tabular-nums">{page} / {Math.ceil(logs.total / logs.pageSize)}</span>
            <button type="button" disabled={page >= Math.ceil(logs.total / logs.pageSize)} onClick={() => setPage(page + 1)}
              className="h-6 px-2.5 rounded-[6px] text-[11px] font-semibold text-ink-500 hover:bg-sky2-50 disabled:opacity-40">→</button>
          </div>
        )}
      </div>
    </div>
  )
}
