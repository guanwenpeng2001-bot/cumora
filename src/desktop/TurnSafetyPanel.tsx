import { TurnBudgetUsage } from './TurnBudgetUsage'
import { useCallback, useEffect, useRef, useState } from 'react'
import { http } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { useLocaleStore } from '@/lib/i18n'

interface SafetySnapshot {
  state: { paused: boolean; generation: string }
  agents: { id: string; name: string }[]
  rules: { id: string; agent_id: string; period: 'day' | 'month'; metric: 'tokens' | 'usd'; ceiling: number; tokens: number; usd: number; resets_at: string }[]
  events: { agent_id: string | null; kind: string; detail: { status?: string; generation?: string }; created_at: string }[]
}

export function TurnSafetyPanel({ budgets = false }: { budgets?: boolean }) {
  const company = useAuth(s => s.activeCompanyId)
  const epoch = useAuth(s => s.contextEpoch)
  return <SafetyContent key={`${company}:${epoch}`} budgets={budgets} />
}

function SafetyContent({ budgets }: { budgets: boolean }) {
  const zh = useLocaleStore(s => s.locale) === 'zh-CN'
  const role = useAuth(s => s.companies.find(c => c.id === s.activeCompanyId)?.role)
  const canEdit = role === 'owner' || role === 'admin'
  const [snapshot, setSnapshot] = useState<SafetySnapshot | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'stop' | 'resume' | string | null>(null)
  const [agentId, setAgentId] = useState('')
  const [period, setPeriod] = useState<'day' | 'month'>('day')
  const [metric, setMetric] = useState<'tokens' | 'usd'>('tokens')
  const [ceiling, setCeiling] = useState('')
  const context = useRef(useAuth.getState())
  const controller = useRef<AbortController | null>(null)
  const pending = useRef(false)
  const current = useCallback(() => !controller.current?.signal.aborted
    && useAuth.getState().contextEpoch === context.current.contextEpoch
    && useAuth.getState().activeCompanyId === context.current.activeCompanyId
    && useAuth.getState().token === context.current.token, [])
  const refresh = useCallback(async () => {
    const result = await http<SafetySnapshot>('/company/turn-safety', { signal: controller.current?.signal })
    if (current()) setSnapshot(result)
  }, [current])
  useEffect(() => {
    controller.current = new AbortController()
    let reading = false
    const poll = async () => {
      if (reading || pending.current) return
      reading = true
      try { await refresh() } catch (e) { if (current()) setError(String(e)) }
      finally { reading = false }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 3000)
    return () => { controller.current?.abort(); clearInterval(timer) }
  }, [refresh, current])

  async function mutate(path: string, method = 'POST', body?: unknown) {
    if (pending.current || !current()) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await http(path, { method, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.current?.signal })
      if (!current()) return
      setConfirm(null)
      await refresh()
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : String(e)) }
    finally { pending.current = false; if (current()) setBusy(false) }
  }
  const button = 'rounded-lg border border-ink-100 px-3 py-2 text-[12px] font-semibold disabled:opacity-40'
  const input = 'rounded-lg border border-ink-100 bg-paper px-3 py-2 text-[12px] w-full'
  const name = (id: string | null) => snapshot?.agents.find(a => a.id === id)?.name ?? id
  const labels: Record<string, string> = zh ? {
    pending: '待连接／发送未确认', sent: '停止信号已发送', stop_confirmed: '客户端已确认停止',
    emergency_paused: '公司已暂停', budget_tripped: '预算熔断', emergency_resumed: '已恢复新 turn', budget_configured: '预算已配置', budget_removed: '预算已移除',
  } : { pending: 'Awaiting connection / delivery', sent: 'Stop signal sent', stop_confirmed: 'Runtime confirmed stopped',
    emergency_paused: 'Company paused', budget_tripped: 'Budget tripped', emergency_resumed: 'New turns resumed', budget_configured: 'Budget configured', budget_removed: 'Budget removed' }
  return <section aria-label={zh ? '运行安全' : 'Turn safety'} className="rounded-xl border border-ink-100 bg-cloud p-4 mb-5 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-semibold">{budgets ? (zh ? '预算保险丝' : 'Budget fuses') : (zh ? '紧急停止' : 'Emergency stop')}</h3>
      {!budgets && <button type="button" disabled={busy} className={`${button} bg-red-600 text-white`} onClick={() => setConfirm('stop')}>
        {zh ? '全部停止' : 'Stop all agents'}
      </button>}
    </div>
    <p className="text-[12px] text-ink-600">{snapshot?.state.paused
      ? (zh ? '当前公司已暂停全部新 turn。未完成输入保留未读；恢复后可重试。' : 'All new turns in this company are paused. Unfinished inputs stay unread and can retry after resuming.')
      : (zh ? '作用于当前公司的全部 agent，含托管 Pod 与 BYOA。' : 'Applies to all agents in this company, including managed Pods and BYOA.')}</p>
    {snapshot?.state.paused && <ul aria-label={zh ? '各 agent 停止状态' : 'Agent stop status'} className="text-[12px] space-y-1">
      {snapshot.agents.map(agent => {
        const events = snapshot.events.filter(e => e.agent_id === agent.id && e.detail.generation === snapshot.state.generation)
        const status = events.some(e => e.kind === 'stop_confirmed') ? 'stop_confirmed'
          : events.find(e => e.kind === 'emergency_stop')?.detail.status ?? 'pending'
        return <li key={agent.id}>{agent.name} · {labels[status]}</li>
      })}
    </ul>}
    {snapshot?.state.paused && <p className="text-[12px] text-ink-600">{zh
      ? '离线或旧版 runtime 可能无法即时确认停止；需更新并重新连接。服务端暂停会持续生效。'
      : 'Offline or older runtimes may not confirm immediately; update and reconnect them. The server pause remains active.'}</p>}
    {snapshot?.state.paused && canEdit && <button type="button" className={button} disabled={busy} onClick={() => setConfirm('resume')}>{zh ? '恢复新 turn' : 'Resume new turns'}</button>}
    {confirm !== null && <div role="alertdialog" aria-modal="false" aria-label={zh ? '确认操作' : 'Confirm action'} className="rounded-lg border border-red-300 p-3 space-y-2">
      <p>{confirm === 'stop'
        ? (zh ? '确认立即中止当前公司的所有在飞 turn，并暂停新 turn？需公司管理员手动恢复。' : 'Abort all in-flight turns and pause new turns in this company? A company admin must resume them.')
        : confirm === 'resume'
          ? (zh ? '确认恢复？保留的未完成输入可在下次唤醒或轮询时重试；预算上限仍生效。' : 'Resume? Unfinished inputs may retry on the next wake or poll. Budget limits still apply.')
          : (zh ? '确认移除此上限并清除对应熔断？历史用量不清零，其余上限仍生效。' : 'Remove this limit and clear its fuse? Historical usage and other limits remain.')}</p>
      <div className="flex gap-2">
        <button type="button" className={button} disabled={busy} onClick={() => { void mutate(confirm === 'stop' ? '/agents/stop-all' : confirm === 'resume' ? '/company/turn-safety/resume' : `/company/turn-safety/budgets/${encodeURIComponent(confirm)}`, confirm === 'stop' || confirm === 'resume' ? 'POST' : 'DELETE') }}>{busy ? (zh ? '处理中…' : 'Working…') : (zh ? '确认' : 'Confirm')}</button>
        <button type="button" className={button} disabled={busy} onClick={() => setConfirm(null)}>{zh ? '取消' : 'Cancel'}</button>
      </div>
    </div>}
    {budgets && <>
      <p className="text-[12px] text-ink-600">{zh
        ? '按 UTC 自然日／月累计 token（含缓存读取、缓存写入、输出）或账本成本（USD，可能为估算）。达到上限后拒绝新 turn；已开始的 turn 可完成。下一周期自动恢复；也可提高上限或移除上限清除熔断，历史用量不清零。公司与 agent 上限同时生效。只计已上报的账本用量；价格估算与回报延迟会影响成本对照。'
        : 'UTC calendar days/months count tokens (including cache reads, cache writes and output) or ledger cost (USD, possibly estimated). Reaching a limit blocks new turns; running turns may finish. Fuses reset next period, or raise/remove a limit to clear it without erasing usage. Company and agent limits both apply. Only reported ledger usage is counted; price estimates and reporting delays affect cost totals.'}</p>
      <form onSubmit={e => { e.preventDefault(); void mutate('/company/turn-safety/budgets', 'PUT', { agentId, period, metric, ceiling: Number(ceiling) }) }}>
        <fieldset disabled={!canEdit || busy} className="grid sm:grid-cols-2 gap-3">
          <label className="text-[12px]">{zh ? '范围' : 'Scope'}<select className={input} value={agentId} onChange={e => setAgentId(e.target.value)}><option value="">{zh ? '全公司' : 'Company'}</option>{snapshot?.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="text-[12px]">{zh ? '周期（UTC）' : 'Period (UTC)'}<select className={input} value={period} onChange={e => setPeriod(e.target.value as 'day' | 'month')}><option value="day">{zh ? '每天' : 'Daily'}</option><option value="month">{zh ? '每月' : 'Monthly'}</option></select></label>
          <label className="text-[12px]">{zh ? '计量' : 'Metric'}<select className={input} value={metric} onChange={e => setMetric(e.target.value as 'tokens' | 'usd')}><option value="tokens">Token</option><option value="usd">USD</option></select></label>
          <label className="text-[12px]">{zh ? '上限' : 'Limit'}<input type="number" required min={metric === 'tokens' ? 1 : 0.000001} step={metric === 'tokens' ? 1 : 'any'} className={input} value={ceiling} onChange={e => setCeiling(e.target.value)} /></label>
          <button type="submit" className={button}>{zh ? '保存／更新此范围的上限' : 'Save / update this limit'}</button>
        </fieldset>
      </form>
      {!canEdit && <p className="text-[12px]">{zh ? '公司 owner/admin 可配置预算或恢复。所有成员可紧急停止。' : 'Company owners/admins can configure budgets and resume. Any member can stop all agents.'}</p>}
      {snapshot?.rules.length === 0 && <p>{zh ? '尚未配置预算上限。' : 'No budget limits configured.'}</p>}
      {snapshot?.rules.map(rule => <TurnBudgetUsage key={rule.id} rule={rule} zh={zh} canEdit={canEdit} busy={busy}
        scopeName={rule.agent_id ? name(rule.agent_id) ?? rule.agent_id : (zh ? '全公司' : 'Company')}
        onEdit={() => { setAgentId(rule.agent_id); setPeriod(rule.period); setMetric(rule.metric); setCeiling(String(rule.ceiling)) }}
        onRemove={() => setConfirm(rule.id)} />)}
    </>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {!snapshot && !error && <p role="status">{zh ? '加载状态…' : 'Loading status…'}</p>}
    {!!snapshot?.events.length && <details open={snapshot.state.paused}>
      <summary className="text-[12px] cursor-pointer">{zh ? '停止状态与最近事件' : 'Stop status and recent events'}</summary>
      <ul className="text-[12px] space-y-1 max-h-64 overflow-y-auto">{snapshot.events.map((event, i) => <li key={`${event.created_at}:${i}`}>
        {new Date(event.created_at).toLocaleString()} · {name(event.agent_id) ?? (zh ? '全公司' : 'Company')} · {labels[event.kind === 'emergency_stop' ? event.detail.status ?? 'pending' : event.kind] ?? event.kind}
      </li>)}</ul>
    </details>}
  </section>
}
