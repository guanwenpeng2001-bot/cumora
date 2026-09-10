import { useEffect, useRef, useState } from 'react'
import { api, type ApiComputer, type ApiModelGroup, type ApiModelRole, type ApiModelRoutePreview, type ApiModelSettings, type ApiSettingDefinition } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { useLocaleStore } from '@/lib/i18n'

const controlClass = 'w-full rounded-lg border border-ink-100 bg-paper px-3 py-2 text-[12px] text-ink-900'
const buttonClass = 'rounded-lg border border-ink-100 px-3 py-1.5 text-[12px] disabled:opacity-40'
const roles: ApiModelRole[] = ['brain', 'support', 'compaction', 'image', 'audio', 'embed']

export function settingEffect(def: ApiSettingDefinition | undefined, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    immediate: ['立即更新快照', 'Immediate snapshot'], 'next-turn': ['下一 turn', 'Next turn'],
    'next-gate': ['下一次 gate；BYOA 等待在途 spawn 完成', 'Next gate; BYOA waits for active spawns'],
    'next-tick': ['下一次调度 tick；不重入在途任务', 'Next scheduler tick; no in-flight re-entry'],
    'next-admission': ['下一次准入；不取消现有 Pod', 'Next admission; existing Pods continue'],
    'next-create': ['下次创建', 'Next creation'], restart: ['待重启', 'Restart required'],
    'restart-next-create': ['待重启后下次创建', 'Next creation after restart'], fixed: ['固定底线', 'Fixed safety floor'],
    'pending-T41': ['服务端尚未支持应用', 'Application not supported by this server'],
  }
  return labels[def?.effect ?? '']?.[zh ? 0 : 1] ?? (zh ? '下一次调用读取快照；不改变在途调用' : 'Snapshot read on next call; in-flight calls unchanged')
}

export function SettingInfo({ snapshot, settingKey, zh }: { snapshot: ApiModelSettings; settingKey: string; zh: boolean }) {
  const def = snapshot.definitions?.find(d => d.key === settingKey)
  const source = snapshot.sources?.[settingKey] ?? snapshot.metadata?.[settingKey]?.source
  const label = source === 'db' ? 'DB' : source === 'env' ? 'ENV' : source === 'default' ? (zh ? '默认' : 'Default') : (zh ? '未知（旧服务端）' : 'Unknown (older server)')
  return <div className="text-[11px] text-ink-500 break-words">
    {zh ? '来源' : 'Source'}: {label} · {zh ? '范围' : 'Scope'}: {def?.scope ?? 'managed / server'} · {settingEffect(def, zh)}
    {def?.unit && <> · {def.unit}</>}
    {def?.readOnly && <> · {zh ? '只读' : 'Read only'}</>}
    {def?.sensitive && <> · {zh ? '敏感值已隐藏' : 'Sensitive value hidden'}</>}
  </div>
}

export function runtimeDomain(def: ApiSettingDefinition): string {
  if (def.scope === 'byoa') return 'byoa'
  if (/^(auto_compaction|compaction_|agent_max_hops|agent_turn_timeout)/.test(def.key)) return 'turn'
  if (/^(synthetic_|inbox_|triage_|cloud_inbox_|support_.*_output_tokens|low_priority_|agent_turn_rate)/.test(def.key)) return 'triage'
  if (/^(idle_|agenda_|scanner_|steer_)/.test(def.key)) return 'automation'
  if (/^(email_|db_gc|workspace_|poll_|llm_rollup)/.test(def.key)) return 'operations'
  return 'pod'
}

export function newerSettings(current: ApiModelSettings | null, next: ApiModelSettings): ApiModelSettings {
  if (current?.revision && next.revision && /^\d+$/.test(current.revision) && /^\d+$/.test(next.revision)
    && BigInt(next.revision) < BigInt(current.revision)) return current
  return next
}

export function settingsPatch(snapshot: ApiModelSettings, draft: Record<string, string | null>, definitions: readonly ApiSettingDefinition[]) {
  return Object.fromEntries(definitions.filter(d => !d.readOnly && !d.envOnly && !d.sensitive && d.key in draft
    && (draft[d.key] === null || draft[d.key] !== snapshot.settings[d.key])).map(d => [d.key, draft[d.key]]))
}

function SettingFields({ snapshot, definitions, onSaved }: { snapshot: ApiModelSettings; definitions: readonly ApiSettingDefinition[]; onSaved: (snapshot: ApiModelSettings) => void }) {
  const zh = useLocaleStore(s => s.locale) === 'zh-CN'
  const isAdmin = useAuth(s => s.user?.isAdmin === true)
  const [draft, setDraft] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const controller = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  const context = useRef(useAuth.getState())
  const current = () => !controller.current?.signal.aborted && useAuth.getState().contextEpoch === context.current.contextEpoch
    && useAuth.getState().token === context.current.token && useAuth.getState().activeCompanyId === context.current.activeCompanyId
  useEffect(() => { controller.current = new AbortController(); return () => controller.current?.abort() }, [])
  const patch = settingsPatch(snapshot, draft, definitions)
  async function save() {
    if (!isAdmin || useAuth.getState().user?.isAdmin !== true || submitting.current || !current()) return
    submitting.current = true
    setBusy(true)
    setMessage('')
    try {
      const result = await api.putModelSettings(patch, controller.current?.signal)
      const next = result.settings ? result as ApiModelSettings : await api.getModelSettings(controller.current?.signal)
      if (!current()) return
      onSaved(next)
      setDraft({})
      setMessage(zh ? '已保存快照；实际应用遵循各项生效边界。' : 'Snapshot saved; runtime application follows each setting’s boundary.')
    } catch (e) { if (current()) setMessage(e instanceof Error ? e.message : String(e)) }
    finally { submitting.current = false; if (current()) setBusy(false) }
  }
  return <div className="space-y-3">
    <fieldset disabled={busy} className="space-y-3">
      {definitions.map(def => {
        const writable = isAdmin && !def.readOnly && !def.envOnly && !def.sensitive
        const value = draft[def.key] === null ? snapshot.settings[def.key] : draft[def.key] ?? snapshot.settings[def.key] ?? ''
        const options = def.allowedValues ?? (def.type === 'boolean' ? ['true', 'false'] : undefined)
        const highRisk = /(?:pod_|compaction_|gc|cleanup|retention|timeout|concurrency|budget|rate|enabled|llm_config|group_config)/.test(def.key)
        const change = (value: string) => { setDraft(old => ({ ...old, [def.key]: value })); setMessage('') }
        return <div key={def.key} className="rounded-xl border border-ink-100 bg-cloud p-4 space-y-2">
          <label htmlFor={`setting-${def.key}`} className="block text-[12px] font-semibold break-all">{def.key}</label>
          {highRisk && <div className="text-[11px] font-semibold text-coral-deep">{zh ? '高风险：影响执行、资源、费用或数据保留' : 'High risk: affects execution, resources, costs or retention'}</div>}
          <SettingInfo snapshot={snapshot} settingKey={def.key} zh={zh} />
          <div className="text-[11px] text-ink-500 break-words">{zh ? '当前值' : 'Current'}: {def.sensitive ? '••••' : snapshot.settings[def.key] || '∅'}</div>
          {def.description && <p className="text-[11px] text-ink-500">{def.description}</p>}
          {(def.min !== undefined || def.max !== undefined) && <div className="text-[11px] text-ink-500">{zh ? '允许范围' : 'Allowed range'}: {def.min ?? '—'} … {def.max ?? '—'}</div>}
          {writable && <>
            {options ? <select id={`setting-${def.key}`} className={controlClass} value={value} onChange={e => change(e.target.value)}>
              {!options.includes(value) && <option value={value} disabled>{value} — {zh ? '不支持' : 'Unsupported'}</option>}
              {options.map(option => <option key={option} value={option}>{option}</option>)}
            </select> : def.type === 'json' ? <textarea id={`setting-${def.key}`} className={`${controlClass} font-mono`} rows={7} value={value} onChange={e => change(e.target.value)} />
              : <input id={`setting-${def.key}`} className={controlClass} type={['integer', 'number'].includes(def.type) ? 'number' : 'text'} min={def.min} max={def.max} step={def.type === 'number' ? 'any' : 1} value={value} onChange={e => change(e.target.value)} />}
            <button type="button" className={buttonClass} onClick={() => { setDraft(old => ({ ...old, [def.key]: null })); setMessage('') }}>{zh ? '恢复继承' : 'Restore inheritance'}</button>
            {draft[def.key] === null && <span className="ml-2 text-[11px] text-gold-deep">{zh ? '待保存：移除 DB 覆盖，重新解析 ENV／默认' : 'Pending save: remove DB override and resolve ENV/default'}</span>}
          </>}
        </div>
      })}
    </fieldset>
    {isAdmin && definitions.some(d => !d.readOnly && !d.envOnly && !d.sensitive) && <div className="flex gap-2">
      <button type="button" className={`${buttonClass} bg-skype text-white`} disabled={busy || !Object.keys(patch).length} onClick={() => void save()}>{zh ? '保存此配置域' : 'Save this domain'}</button>
      <button type="button" className={buttonClass} disabled={busy || !Object.keys(draft).length} onClick={() => { setDraft({}); setMessage('') }}>{zh ? '放弃修改' : 'Discard changes'}</button>
    </div>}
    {message && <p role="status" className="text-[12px] break-words">{message}</p>}
  </div>
}

export function ByoaPolicyStatus() {
  const zh = useLocaleStore(s => s.locale) === 'zh-CN'
  const [computers, setComputers] = useState<ApiComputer[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const context = useAuth.getState()
    let inFlight = false
    const current = () => !controller.signal.aborted && useAuth.getState().contextEpoch === context.contextEpoch
      && useAuth.getState().token === context.token && useAuth.getState().activeCompanyId === context.activeCompanyId
    const load = async () => {
      if (inFlight || !current()) return
      inFlight = true
      try { const result = await api.getComputers(controller.signal); if (current()) { setComputers(result.filter(c => c.kind !== 'cloud')); setError('') } }
      catch (e) { if (current()) setError(e instanceof Error ? e.message : String(e)) }
      finally { inFlight = false; if (current()) setLoading(false) }
    }
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [refresh])
  const labels = { unknown: ['未知／未上报', 'Unknown / not reported'], unsupported: ['旧 daemon 不支持', 'Unsupported by older daemon'], pending: ['待接收', 'Pending receipt'], received: ['已接收，等待安全应用边界', 'Received; awaiting safe boundary'], applied: ['已应用', 'Applied'] }
  return <section className="space-y-3">
    <h3 className="font-semibold">{zh ? 'BYOA 策略与 daemon 应用版本' : 'BYOA policy and daemon application versions'}</h3>
    <p className="text-[12px] text-ink-500">{zh ? '策略约 30 秒心跳发现，资源约 60 秒同步；实际应用等待安全边界。本机模型、凭据和 endpoint 保持自治。' : 'Policy discovery uses ~30s heartbeats; resources sync ~60s. Application waits for a safe boundary. Local models, credentials and endpoints remain autonomous.'}</p>
    <button type="button" className={buttonClass} onClick={() => setRefresh(x => x + 1)}>{zh ? '刷新应用状态' : 'Refresh application status'}</button>
    {error && <p role="alert" className="text-coral-deep text-[12px]">{zh ? '刷新失败；以下可能是旧状态：' : 'Refresh failed; displayed state may be stale: '}{error}</p>}
    {loading && <p>{zh ? '正在加载…' : 'Loading…'}</p>}
    {!loading && !computers.length && !error && <p className="text-[12px]">{zh ? '当前公司没有 BYOA 电脑' : 'No BYOA computers in this company'}</p>}
    {computers.map(c => <div key={c.id} className="rounded-xl bg-cloud border border-ink-100 p-4 text-[12px] space-y-1 break-all">
      <div className="font-semibold">{c.name} · daemon {c.daemon_version ?? (zh ? '版本未知' : 'version unknown')} · {c.status}</div>
      <div>{labels[c.runtimePolicy?.status ?? 'unknown']?.[zh ? 0 : 1] ?? (zh ? '未知状态' : 'Unknown state')}</div>
      <div>{zh ? '目标版本' : 'Desired'}: {c.runtimePolicy?.desired ?? '—'}</div>
      <div>{zh ? '已接收版本' : 'Received'}: {c.runtimePolicy?.received ?? '—'}</div>
      <div>{zh ? '已应用版本' : 'Applied'}: {c.runtimePolicy?.applied ?? '—'}</div>
      <div>{zh ? '最近上报' : 'Last report'}: {c.runtimePolicy?.reportedAt ?? '—'}</div>
    </div>)}
  </section>
}

export function RuntimeSettingsPanel() {
  const epoch = useAuth(s => s.contextEpoch)
  const company = useAuth(s => s.activeCompanyId)
  return <RuntimeSettingsContent key={`${epoch}:${company}`} />
}

function RuntimeSettingsContent() {
  const zh = useLocaleStore(s => s.locale) === 'zh-CN'
  const isAdmin = useAuth(s => s.user?.isAdmin === true)
  const [snapshot, setSnapshot] = useState<ApiModelSettings | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!isAdmin) return
    const controller = new AbortController()
    void api.getModelSettings(controller.signal).then(result => { if (!controller.signal.aborted) setSnapshot(result) })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) })
    return () => controller.abort()
  }, [isAdmin])
  const domains = [ ['automation', '自动化／唤醒', 'Automation / wake'], ['triage', '小脑／分流', 'Cerebellum / triage'], ['pod', 'Pod／安全', 'Pod / safety'], ['turn', '压缩／turn', 'Compaction / turn'], ['operations', '运维／保留期', 'Operations / retention'], ['byoa', 'BYOA 运行策略', 'BYOA runtime policy'] ]
  return <div className="space-y-6">
    <p className="text-[12px] text-ink-500">{zh ? '全局配置仅站点管理员可写。保存后立即安装服务端快照，健康进程约 30 秒刷新；每项配置按标注边界应用，不中断在途工作。' : 'Only site admins can write global settings. Saving installs the server snapshot; healthy processes refresh in ~30s. Each setting applies at its stated boundary without interrupting in-flight work.'}</p>
    {!isAdmin && <p>{zh ? '全局配置需要站点管理员权限。' : 'Global settings require site admin access.'}</p>}
    {error && <p role="alert" className="text-coral-deep">{error}</p>}
    {isAdmin && !snapshot && !error && <p>{zh ? '正在加载…' : 'Loading…'}</p>}
    {snapshot && <>
      <p className="text-[12px]">{zh ? '已保存快照版本' : 'Saved snapshot revision'}: {snapshot.revision ?? '—'}</p>
      {!snapshot.definitions && <p>{zh ? '旧服务端缺少配置定义，无法安全编辑。' : 'Older server lacks setting definitions; editing is unavailable.'}</p>}
      {snapshot.diagnostics?.map(d => <p key={d} role="alert" className="text-[12px] text-coral-deep">{d}</p>)}
      {domains.map(([domain, cn, en]) => <details key={domain} open className="space-y-3">
        <summary className="font-semibold cursor-pointer">{zh ? cn : en}</summary>
        <SettingFields snapshot={snapshot} definitions={snapshot.definitions?.filter(d => d.scope && runtimeDomain(d) === domain) ?? []} onSaved={next => setSnapshot(current => newerSettings(current, next))} />
      </details>)}
    </>}
    <ByoaPolicyStatus />
  </div>
}

export function ModelRoutingPanel({ snapshot, onSaved }: { snapshot: ApiModelSettings; onSaved: (snapshot: ApiModelSettings) => void }) {
  const zh = useLocaleStore(s => s.locale) === 'zh-CN'
  const [role, setRole] = useState<ApiModelRole>('brain')
  const [purpose, setPurpose] = useState('preview')
  const [refresh, setRefresh] = useState(0)
  const [preview, setPreview] = useState<ApiModelRoutePreview | null>(null)
  const [groups, setGroups] = useState<ApiModelGroup[] | null>(null)
  const [error, setError] = useState('')
  const [groupError, setGroupError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setPreview(null)
    setError('')
    void api.getModelRoutePreview(role, purpose || 'preview', controller.signal).then(result => { if (!controller.signal.aborted) setPreview(result) })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) })
    return () => controller.abort()
  }, [role, purpose, refresh, snapshot.revision])
  useEffect(() => {
    const controller = new AbortController()
    setGroups(null)
    setGroupError('')
    void api.getModelGroups(controller.signal).then(result => { if (!controller.signal.aborted) setGroups(result.groups) })
      .catch(e => { if (!controller.signal.aborted) setGroupError(e instanceof Error ? e.message : String(e)) })
    return () => controller.abort()
  }, [refresh, snapshot.revision])
  let selection: Array<{ tier: string; platform: string; id: number }> = []
  let invalidGroups = false
  try {
    const parsed = JSON.parse(snapshot.settings.sub2api_group_config || '{}')
    selection = Object.entries(parsed).flatMap(([tier, value]) => Object.entries(value as Record<string, number>).map(([platform, id]) => ({ tier, platform, id })))
  } catch { invalidGroups = true }
  const backups = preview?.candidates.filter(c => c.source === 'llm_config:env_after_chain') ?? []
  return <section className="space-y-3">
    <h3 className="font-semibold">{zh ? 'Managed 路由预览／ENV 后备' : 'Managed route preview / ENV backup'}</h3>
    <p className="text-[12px] text-ink-500">{zh ? '预览仅解析已保存配置，不发起模型调用；可用表示凭据与协议已配置，不代表上游实测成功。BYOA 使用本机引擎配置。' : 'Preview resolves saved settings without calling a model. Available means credentials and protocol are configured, not that an upstream call succeeded. BYOA uses local engine settings.'}</p>
    <div className="flex flex-wrap gap-2">
      <select aria-label={zh ? '角色' : 'Role'} className={buttonClass} value={role} onChange={e => setRole(e.target.value as ApiModelRole)}>{roles.map(r => <option key={r}>{r}</option>)}</select>
      <input aria-label={zh ? '用途' : 'Purpose'} className={buttonClass} value={purpose} onChange={e => setPurpose(e.target.value)} />
      <button type="button" className={buttonClass} onClick={() => setRefresh(x => x + 1)}>{zh ? '刷新预览与组校验' : 'Refresh preview and group validation'}</button>
    </div>
    {error && <p role="alert" className="text-coral-deep text-[12px]">{error}</p>}
    {preview && <div className="space-y-2 text-[12px]">
      <p>{preview.domain} · revision {preview.revision} · {zh ? '网关路由配置' : 'Gateway routing'}: {String(preview.routable)} · {zh ? '开通配置' : 'Provisioning configured'}: {String(preview.provisionable)}</p>
      <p>{role === 'embed' ? (zh ? 'Embedding 不使用后备链' : 'Embedding has no fallback chain') : backups.length ? (zh ? `显式 ENV 后备：${backups.length} 个候选；已配置可用 ${backups.filter(c => c.available).length} 个` : `Explicit ENV backup: ${backups.length} candidates; ${backups.filter(c => c.available).length} configured`) : (zh ? '本角色／用途未追加显式 ENV 后备；主路由仍可能是纯 ENV 直连' : 'No explicit ENV backup appended for this role/purpose; the primary may still use direct ENV routing')}</p>
      <ol className="list-decimal pl-5 space-y-2">{preview.candidates.map((c, i) => <li key={i} className="rounded-lg bg-cloud p-3 break-words">
        <div className="font-semibold">{c.model} → {c.requestModel}</div>
        <div>{c.route.kind} / {c.route.id} / {c.protocol} · {c.available ? (zh ? '已配置' : 'Configured') : (zh ? '不可用' : 'Unavailable')}</div>
        <div>{zh ? '来源' : 'Source'}: {c.source} · endpoint: {c.route.endpointSource} · {zh ? '凭据来源' : 'Credential source'}: {c.route.credentialSource}</div>
        {c.diagnostic && <div className="text-coral-deep">{c.diagnostic}</div>}
      </li>)}</ol>
      {preview.diagnostics.map(d => <p key={d} className="text-coral-deep">{d}</p>)}
    </div>}
    <h3 className="font-semibold">{zh ? '平台组校验（已保存配置）' : 'Platform group validation (saved settings)'}</h3>
    {groupError && <p role="alert" className="text-coral-deep text-[12px]">{zh ? '无法校验：' : 'Unable to validate: '}{groupError}</p>}
    {invalidGroups && <p role="alert">{zh ? '组配置格式无效' : 'Invalid group configuration'}</p>}
    {!invalidGroups && !selection.length && <p className="text-[12px]">{zh ? '无显式组覆盖；继承部署组配置，不能据此确认组有效。' : 'No explicit group overrides; deployment group settings are inherited and not validated here.'}</p>}
    {selection.map(g => <p key={`${g.tier}:${g.platform}`} className="text-[12px]">{g.tier} / {g.platform} / {g.id}: {groups === null ? (zh ? '尚未验证' : 'Not verified') : groups.some(c => c.id === g.id && c.platform === g.platform) ? (zh ? '有效' : 'Valid') : (zh ? '不可用或平台不匹配' : 'Unavailable or platform mismatch')}</p>)}
    {groups && <details><summary className="text-[12px] cursor-pointer">{zh ? '可选组' : 'Available groups'} ({groups.length})</summary>{groups.map(g => <p key={`${g.platform}:${g.id}`} className="text-[12px]">{g.platform} / {g.id} / {g.name}</p>)}</details>}
    <details className="space-y-3"><summary className="font-semibold cursor-pointer">{zh ? '高级路由／平台组配置' : 'Advanced route / platform group settings'}</summary>
      <p className="text-[12px] text-ink-500">{zh ? '显式 llm_config 角色配置优先于上方模型字段，请以预览为准。JSON 仅接受路由与模型元信息，不包含密钥或地址。保存时服务端校验 schema、组归属和向量空间。' : 'Explicit llm_config roles override the model fields above; check the preview. JSON accepts route/model metadata without keys or addresses. The server validates schema, group ownership and embedding space on save.'}</p>
      <SettingFields snapshot={snapshot} definitions={snapshot.definitions?.filter(d => ['llm_config', 'sub2api_group_config'].includes(d.key)) ?? []} onSaved={onSaved} />
    </details>
  </section>
}
