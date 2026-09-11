/**
 * Users — paginated, searchable, with inline detail expand + tier /
 * admin toggles per row.
 */
import { useCallback, useEffect, useState } from 'react'
import { adminApi, type AdminUser, type AdminUserDetail, type AdminStats, type Tier } from './api'
import { resolveAssetUrl } from '@/api/client'
import { Pager } from './Pager'
import { useAuth } from '@/stores/auth'
import { useT, useLocale } from '@/lib/i18n'

type UserSync = {
  sub2apiSync?: {
    targetTier: Tier
    version: string
    expectedConfigVersion?: string
    appliedConfigVersion?: string | null
    status: 'pending' | 'processing' | 'failed' | 'succeeded'
    attempts: number
    nextAttemptAt: string | null
    lastError: string | null
  } | null
}

function TierSync({ user }: { user: AdminUser & UserSync }) {
  const locale = useLocale()
  const text = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const sync = user.sub2apiSync
  const labels = {
    pending: text('等待同步；尚未完成', 'Pending; not complete'),
    processing: text('同步处理中；尚未完成', 'Processing; not complete'),
    failed: text('同步失败；尚未完成', 'Failed; not complete'),
    succeeded: text('同步已确认', 'Sync confirmed'),
  }
  return <div style={{ fontSize: 11, overflowWrap: 'anywhere' }} role="status">
    <div>{text('有效套餐', 'Effective tier')}: {user.tier}</div>
    <div>{text('目标套餐', 'Target tier')}: {sync?.targetTier ?? text('未知', 'Unknown')}</div>
    <div>{sync ? labels[sync.status] ?? text('同步状态未知', 'Sync status unknown') : sync === null ? text('无同步记录', 'No sync record') : text('同步状态未知；展开或刷新读取', 'Sync unknown; expand or refresh to load')}</div>
    {sync && <div>{text('同步版本 / 尝试次数', 'Sync version / attempts')}: {sync.version} / {sync.attempts}</div>}
    {sync?.expectedConfigVersion && <div>{text('组配置期望 / 已应用', 'Group config expected / applied')}: {sync.expectedConfigVersion} / {sync.appliedConfigVersion ?? text('待应用', 'Pending')}</div>}
    {sync?.nextAttemptAt && <div>{text('下次重试', 'Next retry')}: {fmtDateTime(sync.nextAttemptAt)}</div>}
    {sync?.status === 'failed' && <div className="admin-banner-err">{text('网关对账失败，有效套餐保持原值。服务端将按重试计划继续同步。', 'Gateway reconciliation failed; the effective tier is unchanged. The server will retry as scheduled.')}</div>}
  </div>
}

const PAGE = 50

export function UsersPage({ stats }: { stats: AdminStats | null }) {
  const t = useT()
  const meId = useAuth((s) => s.user?.id ?? null)
  const [q, setQ] = useState('')
  const [tier, setTier] = useState<Tier | ''>('')
  const [items, setItems] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async (nextOffset: number) => {
    setLoading(true); setErr(null)
    try {
      const r = await adminApi.listUsers({ q, tier, limit: PAGE, offset: nextOffset })
      setItems(r.items); setTotal(r.total); setOffset(r.offset)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [q, tier])

  // Reload on search/filter change with a light debounce so each keystroke
  // doesn't spam the API.
  useEffect(() => {
    const t = setTimeout(() => { void load(0) }, q ? 250 : 0)
    return () => clearTimeout(t)
  }, [q, tier, load])

  const onTierChange = async (u: AdminUser, next: Tier) => {
    try {
      const updated = await adminApi.patchUser(u.id, { tier: next })
      setItems((rows) => rows.map((r) => (r.id === u.id ? updated : r)))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert(t('users.tierUpdateFailed', { error: msg }))
    }
  }

  const onAdminToggle = async (u: AdminUser) => {
    if (u.id === meId && u.isAdmin) {
      alert(t('users.cantRemoveOwnAdmin'))
      return
    }
    try {
      const updated = await adminApi.patchUser(u.id, { isAdmin: !u.isAdmin })
      setItems((rows) => rows.map((r) => (r.id === u.id ? updated : r)))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert(t('users.adminToggleFailed', { error: msg }))
    }
  }

  /** Suspend / unsuspend. The server enforces "can't suspend self" too —
   *  this client-side guard just spares the operator the round-trip + alert. */
  const onSuspendToggle = async (u: AdminUser): Promise<AdminUser | null> => {
    if (u.id === meId && !u.suspended) {
      alert(t('users.cantSuspendSelf'))
      return null
    }
    try {
      if (u.suspended) {
        const updated = await adminApi.unsuspendUser(u.id)
        setItems((rows) => rows.map((r) => (r.id === u.id ? updated : r)))
        return updated
      }
      // Prompt for a reason — surfaced to the user verbatim on the
      // suspended screen so it helps to be specific. Cancelling the
      // prompt aborts the action entirely. Empty string OK (means
      // "no reason given").
      const reason = window.prompt(t('users.suspendPrompt', { name: u.name, email: u.email }), '')
      if (reason === null) return null
      const trimmed = reason.trim()
      const updated = await adminApi.suspendUser(u.id, trimmed || null)
      setItems((rows) => rows.map((r) => (r.id === u.id ? updated : r)))
      return updated
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert(t('users.suspendFailed', { error: msg }))
      return null
    }
  }

  return (
    <div className="admin-page">
      <header className="admin-page-head">
        <div>
          <h1 className="admin-h1">{t('users.title')}</h1>
          <div className="admin-sub">
            {stats
              ? t('users.statsSummary', { total: stats.users.total, admins: stats.users.admins, free: stats.users.tiers.free, pro: stats.users.tiers.pro, max: stats.users.tiers.max })
              : <>&nbsp;</>}
          </div>
        </div>
        <div className="admin-filters">
          <input
            type="search" placeholder={t('users.searchPh')} className="admin-input"
            value={q} onChange={(e) => setQ(e.target.value)}
          />
          <select className="admin-select" value={tier} onChange={(e) => setTier(e.target.value as Tier | '')}>
            <option value="">{t('users.allTiers')}</option>
            <option value="free">{t('users.tierFree')}</option>
            <option value="pro">{t('users.tierPro')}</option>
            <option value="max">{t('users.tierMax')}</option>
          </select>
        </div>
      </header>

      {err && <div className="admin-banner-err">{err}</div>}

      <div className="admin-table">
        <div className="admin-thead">
          <div>{t('users.colUser')}</div>
          <div>{t('users.colTier')}</div>
          <div>{t('users.colAdmin')}</div>
          <div>{t('users.colCompanies')}</div>
          <div>{t('users.colJoined')}</div>
          <div>{t('users.colLastLogin')}</div>
        </div>
        {loading && items.length === 0 && <div className="admin-row admin-empty">{t('users.loadingDetails')}</div>}
        {!loading && items.length === 0 && <div className="admin-row admin-empty">{t('users.noUsers')}</div>}
        {items.map((u) => (
          <UserRow
            key={u.id} u={u} expanded={expandedId === u.id}
            onToggleExpand={() => setExpandedId((cur) => (cur === u.id ? null : u.id))}
            onTierChange={(t) => onTierChange(u, t)}
            onAdminToggle={() => onAdminToggle(u)}
            onSuspendToggle={() => onSuspendToggle(u)}
            isMe={u.id === meId}
          />
        ))}
      </div>

      <Pager total={total} pageSize={PAGE} offset={offset} loading={loading} onPage={(o) => void load(o)} />
    </div>
  )
}

function UserRow({ u, expanded, onToggleExpand, onTierChange, onAdminToggle, onSuspendToggle, isMe }: {
  u: AdminUser
  expanded: boolean
  onToggleExpand: () => void
  onTierChange: (t: Tier) => Promise<void>
  onAdminToggle: () => void
  onSuspendToggle: () => Promise<AdminUser | null>
  isMe: boolean
}) {
  const [detailResult, setDetailResult] = useState<{ user: AdminUser; detail: AdminUserDetail & UserSync } | null>(null)
  const detail = detailResult?.user === u ? detailResult.detail : null
  const setDetail = (value: AdminUserDetail & UserSync) => setDetailResult({ user: u, detail: value })
  const [refresh, setRefresh] = useState(0)
  const [tierBusy, setTierBusy] = useState(false)
  const [detailError, setDetailError] = useState(false)
  const locale = useLocale()
  const text = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const currentUser: AdminUser & UserSync = detailError ? { ...u, sub2apiSync: undefined } : detail ?? u
  const [loadingDetail, setLoadingDetail] = useState(false)
  const t = useT()

  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    setLoadingDetail(true)
    setDetailError(false)
    adminApi.getUser(u.id)
      .then((value) => { if (!cancelled) setDetail(value) })
      .catch(() => { if (!cancelled) { setDetailResult(null); setDetailError(true) } })
      .finally(() => { if (!cancelled) setLoadingDetail(false) })
    return () => { cancelled = true }
  }, [expanded, u, refresh])

  const changeTier = async (next: Tier) => {
    if (tierBusy) return
    setTierBusy(true)
    try { await onTierChange(next) } finally { setTierBusy(false) }
  }

  // Detail drawer's suspend action — keep the AdminUserDetail snapshot in
  // sync with the freshly-patched row from the parent, so the reason
  // / actor / timestamp re-render without re-fetching.
  const handleSuspendClick = async () => {
    const updated = await onSuspendToggle()
    if (updated && detail) {
      setDetail({ ...detail, ...updated })
    }
  }

  return (
    <>
      <div className={`admin-row ${u.suspended ? 'admin-row-suspended' : ''}`} onClick={onToggleExpand} role="button">
        <div className="admin-cell-user">
          <img className="admin-avatar" src={resolveAssetUrl(u.avatarUrl)} alt="" loading="lazy" />
          <div className="admin-cell-user-text">
            <div className="admin-cell-user-name">
              {u.name}
              {isMe && <span className="admin-pill admin-pill-soft" style={{ marginLeft: 8 }}>{t('users.youBadge')}</span>}
              {u.suspended && <span className="admin-pill admin-pill-warn" style={{ marginLeft: 8 }}>{t('users.suspendedBadge')}</span>}
            </div>
            <div className="admin-cell-user-email">{u.email}</div>
          </div>
        </div>
        <div onClick={(e) => e.stopPropagation()} data-label={t('users.colTier')}>
          <TierSync user={currentUser} />
          <label style={{ fontSize: 11 }}>{text('设置目标套餐', 'Set target tier')}
          <select className="admin-select admin-select-sm" disabled={tierBusy || loadingDetail}
            value={currentUser.sub2apiSync?.targetTier ?? currentUser.tier} onChange={(e) => void changeTier(e.target.value as Tier)}>
            <option value="free">{t('users.tierFree')}</option>
            <option value="pro">{t('users.tierPro')}</option>
            <option value="max">{t('users.tierMax')}</option>
          </select>
          </label>
        </div>
        <div onClick={(e) => e.stopPropagation()} data-label={t('users.colAdmin')}>
          <button
            type="button"
            className={`admin-toggle ${u.isAdmin ? 'is-on' : ''}`}
            onClick={onAdminToggle}
            disabled={isMe && u.isAdmin}
            title={isMe && u.isAdmin ? t('users.cantRemoveOwnAdminTitle') : ''}
          >
            {u.isAdmin ? t('users.adminBadge') : '—'}
          </button>
        </div>
        <div data-label={t('users.colCompanies')}>{u.companyCount}</div>
        <div className="admin-cell-mono" data-label={t('users.colJoined')}>{fmtDate(u.createdAt)}</div>
        <div className="admin-cell-mono" data-label={t('users.colLastLogin')}>{u.lastLoginAt ? fmtDate(u.lastLoginAt) : '—'}</div>
      </div>
      {expanded && (
        <div className="admin-row-detail">
          <button type="button" className="btn-ghost" disabled={loadingDetail || tierBusy} onClick={() => { setDetailResult(null); setRefresh((value) => value + 1) }}>{text('刷新套餐同步状态', 'Refresh tier sync status')}</button>
          {detailError && <div className="admin-banner-err">{text('同步状态读取失败，当前状态未知。请刷新重试。', 'Could not load sync status; current status unknown. Refresh to retry.')}</div>}
          {loadingDetail && <div className="admin-empty">{t('users.loadingDetails')}</div>}
          {detail && (
            <div className="admin-detail-grid">
              <DetailField label={t('users.userId')} value={detail.id} mono />
              <DetailField label={t('users.sub2apiId')} value={detail.sub2apiUserId ? String(detail.sub2apiUserId) : '—'} mono />
              <DetailField label={t('users.created')}   value={fmtDateTime(detail.createdAt)} mono />
              <DetailField label={t('users.colLastLogin')} value={detail.lastLoginAt ? fmtDateTime(detail.lastLoginAt) : '—'} mono />
              {/* Suspension card — only shown when the row IS suspended. We
                  surface the reason, who suspended them, and when, so the
                  operator has all the context before deciding to unsuspend. */}
              {detail.suspended && (
                <div className="admin-detail-suspended">
                  <div className="admin-detail-label">{t('users.suspendedLabel')}</div>
                  <div className="admin-detail-suspended-meta">
                    {detail.suspendedAt ? fmtDateTime(detail.suspendedAt) : '—'}
                    {detail.suspendedBy ? <> · {t('users.suspendedBy')} <span className="admin-cell-mono">{detail.suspendedBy}</span></> : null}
                  </div>
                  {detail.suspensionReason && (
                    <div className="admin-detail-suspended-reason">{detail.suspensionReason}</div>
                  )}
                </div>
              )}
              <div className="admin-detail-actions">
                <button
                  type="button"
                  className={`btn-ghost ${detail.suspended ? '' : 'admin-btn-danger'}`}
                  onClick={handleSuspendClick}
                  disabled={isMe && !detail.suspended}
                  title={isMe && !detail.suspended ? t('users.cantSuspendSelfTitle') : ''}
                >
                  {detail.suspended ? t('users.unsuspend') : t('users.suspendAccount')}
                </button>
              </div>
              <div className="admin-detail-companies">
                <div className="admin-detail-label">{t('users.companiesCount', { count: detail.companies.length })}</div>
                {detail.companies.length === 0 && <div className="admin-empty">{t('users.noCompanies')}</div>}
                {detail.companies.map((c) => (
                  <div key={c.id} className="admin-detail-company">
                    <div>
                      <div style={{ fontWeight: 600 }}>{c.name}</div>
                      <div className="admin-cell-user-email">{t('users.companySlugRole', { slug: c.slug, role: c.role })}</div>
                    </div>
                    <div className="admin-cell-mono">{t('users.agentCount', { count: c.agentCount })}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="admin-detail-field">
      <div className="admin-detail-label">{label}</div>
      <div className={mono ? 'admin-cell-mono' : ''}>{value}</div>
    </div>
  )
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' })
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { year: '2-digit', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
