export function TurnBudgetUsage({ rule, scopeName, zh, canEdit, busy, onEdit, onRemove }: {
  rule: { period: 'day' | 'month'; metric: 'tokens' | 'usd'; ceiling: number; tokens: number; usd: number; resets_at: string }
  scopeName: string
  zh: boolean
  canEdit: boolean
  busy: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  const used = rule[rule.metric]
  const button = 'rounded-lg border border-ink-100 px-3 py-2 text-[12px] font-semibold disabled:opacity-40'
  return <div className="rounded-lg border border-ink-100 p-3 space-y-2 text-[12px]">
    <strong>{scopeName} · {rule.period === 'day' ? (zh ? '每天' : 'Daily') : (zh ? '每月' : 'Monthly')} · {rule.metric}</strong>
    <p>{used.toLocaleString(undefined, { maximumFractionDigits: 6 })} / {rule.ceiling.toLocaleString()} — {used >= rule.ceiling ? (zh ? '已熔断' : 'Tripped') : (zh ? '可运行' : 'Available')}</p>
    <progress className="w-full" max={rule.ceiling} value={Math.max(0, Math.min(rule.ceiling, used))} aria-label={zh ? '预算用量' : 'Budget usage'} />
    <p>{zh ? '下次重置：' : 'Resets: '}{new Date(rule.resets_at).toISOString()}</p>
    {canEdit && <div className="flex gap-2">
      <button type="button" className={button} disabled={busy} onClick={onEdit}>{zh ? '编辑上限' : 'Edit limit'}</button>
      <button type="button" className={button} disabled={busy} onClick={onRemove}>{zh ? '移除上限／清除熔断' : 'Remove limit / clear fuse'}</button>
    </div>}
  </div>
}
