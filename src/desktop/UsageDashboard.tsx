/**
 * Usage dashboard (settings → usage tab, below the quota cards).
 * cc-switch-style: totals cards, a self-drawn SVG multi-line trend,
 * dimension tabs (agent / model / provider), and a paginated request log.
 * All data from GET /api/usage/* (pure ledger reads).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api, resolveAssetUrl,
  type ApiUsageAgentRow, type ApiUsageLogPage, type ApiUsageModelRow,
  type ApiUsageProviderRow, type ApiUsageSummary, type ApiUsageTrendPoint,
} from '@/api/client'
import { useT } from '@/lib/i18n'

type T = ReturnType<typeof useT>
import { cn } from '@/lib/utils'

type RangePreset = 'today' | 'week' | 'custom'

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
    from: customFrom ? new Date(customFrom).toISOString() : new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    to: customTo ? new Date(new Date(customTo).getTime() + 86_399_000).toISOString() : to.toISOString(),
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}
function fmtUsd(n: number): string {
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

export function UsageDashboard() {
  const t = useT()
  const [preset, setPreset] = useState<RangePreset>('today')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [granularity, setGranularity] = useState<'hour' | 'day'>('hour')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [dim, setDim] = useState<Dim>('agent')
  const [page, setPage] = useState(1)
  const [summary, setSummary] = useState<ApiUsageSummary | null>(null)
  const [trend, setTrend] = useState<ApiUsageTrendPoint[]>([])
  const [byAgent, setByAgent] = useState<ApiUsageAgentRow[]>([])
  const [byModel, setByModel] = useState<ApiUsageModelRow[]>([])
  const [byProvider, setByProvider] = useState<ApiUsageProviderRow[]>([])
  const [logs, setLogs] = useState<ApiUsageLogPage | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const timerRef = useRef<number | null>(null)

  const range = useMemo(() => rangeOf(preset, customFrom, customTo), [preset, customFrom, customTo])

  const load = useCallback(() => {
    const { from, to } = range
    void Promise.all([
      api.getUsageSummary(from, to),
      api.getUsageTrend(from, to, granularity),
      api.getUsageByAgent(from, to),
      api.getUsageByModel(from, to),
      api.getUsageByProvider(from, to),
      api.getUsageLogs(from, to, page, 50),
    ]).then(([s, tr, a, m, p, l]) => {
      setSummary(s); setTrend(tr.points); setByAgent(a.items); setByModel(m.items); setByProvider(p.items); setLogs(l)
      setLoadError(null)
    }).catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }, [range, granularity, page])

  useEffect(load, [load])
  useEffect(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    timerRef.current = null
    if (autoRefresh) timerRef.current = window.setInterval(load, 5000)
    return () => { if (timerRef.current !== null) window.clearInterval(timerRef.current) }
  }, [autoRefresh, load])

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
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
              className="h-7 px-2 rounded-[7px] text-[12px] text-ink-700 bg-cloud outline-none" style={{ border: '1px solid var(--ink-100)' }} />
            <span className="text-ink-300 text-[12px]">→</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
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
      {loadError && <div className="text-[11.5px] text-coral-deep">{t('me.usage.loadFailed')}: {loadError}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label={t('me.usage.totalTokens')} value={summary ? fmtTokens(summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens + summary.outputTokens) : '…'}
          sub={summary ? `${t('me.usage.inShort')} ${fmtTokens(summary.inputTokens + summary.cacheReadTokens)} · ${t('me.usage.outShort')} ${fmtTokens(summary.outputTokens)}` : undefined} />
        <Card label={t('me.usage.requests')} value={summary ? String(summary.requests) : '…'}
          sub={summary ? `${t('me.usage.successRate')} ${fmtPct(summary.successRate)}` : undefined} />
        <Card label={t('me.usage.cost')} value={summary ? fmtUsd(summary.costUsd) : '…'}
          sub={summary?.costEstimated ? t('me.usage.costEstimated') : undefined} />
        <Card label={t('me.usage.cacheHit')} value={summary ? fmtPct(summary.cacheHitRate) : '…'}
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
        <div className="overflow-x-auto">
          {dim === 'agent' && (
            <table className="w-full border-collapse">
              <thead><tr>
                <th className={th}>{t('me.usage.colAgent')}</th><th className={th}>{t('me.usage.colTokens')}</th>
                <th className={th}>{t('me.usage.colCost')}</th><th className={th}>{t('me.usage.colRequests')}</th>
                <th className={th}>{t('me.usage.colSuccess')}</th>
              </tr></thead>
              <tbody>
                {byAgent.map((r) => (
                  <tr key={r.agentId ?? `none-${r.name}`} className="border-t border-ink-100">
                    <td className={td}>
                      <span className="inline-flex items-center gap-2 min-w-0">
                        {r.avatarUrl
                          ? <img src={resolveAssetUrl(r.avatarUrl)} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
                          : <span className="w-5 h-5 rounded-full bg-ink-100 grid place-items-center text-[9px] font-bold text-ink-500 shrink-0">{(r.name || '?').charAt(0).toUpperCase()}</span>}
                        <span className="font-semibold text-ink-900 truncate">{r.name}</span>
                        <span className="text-[9.5px] text-ink-300 shrink-0">{r.source === 'managed' ? t('me.usage.managed') : 'BYOA'}</span>
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
                <th className={th}>{t('me.usage.colTokens')}</th><th className={th}>{t('me.usage.colCost')}</th>
                <th className={th}>{t('me.usage.colRequests')}</th>
              </tr></thead>
              <tbody>
                {byModel.map((r) => (
                  <tr key={r.model} className="border-t border-ink-100">
                    <td className={cn(td, 'font-mono')}>{r.model}</td>
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
                <th className={th}>{t('me.usage.colCost')}</th><th className={th}>{t('me.usage.colRequests')}</th>
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
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr>
              <th className={th}>{t('me.usage.colTime')}</th><th className={th}>{t('me.usage.colAgent')}</th>
              <th className={th}>{t('me.usage.colModel')}</th><th className={th}>{t('me.usage.colIn')}</th>
              <th className={th}>{t('me.usage.colOut')}</th><th className={th}>{t('me.usage.colCost')}</th>
              <th className={th}>{t('me.usage.colStatus')}</th>
            </tr></thead>
            <tbody>
              {(logs?.items ?? []).map((r) => (
                <tr key={r.id} className="border-t border-ink-100">
                  <td className={cn(td, 'whitespace-nowrap')}>{new Date(r.createdAt).toLocaleTimeString()}</td>
                  <td className={td}>{r.agentName ?? '—'}</td>
                  <td className={cn(td, 'font-mono')}>{r.model}</td>
                  <td className={td}>{fmtTokens(r.inputTokens)}</td>
                  <td className={td}>{fmtTokens(r.outputTokens)}</td>
                  <td className={td}>{fmtUsd(r.costUsd)}</td>
                  <td className={td}>
                    <span className={cn('text-[10.5px] font-semibold px-1.5 py-0.5 rounded', r.status === 'ok' ? 'text-skype-deep bg-sky2-50' : 'text-coral-deep bg-coral-soft')}>
                      {r.status}
                    </span>
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
