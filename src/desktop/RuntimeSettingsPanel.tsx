import { TurnSafetyPanel } from './TurnSafetyPanel'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ApiModelGroup, type ApiModelRole, type ApiModelRoutePreview, type ApiModelSettings, type ApiSettingDefinition } from '@/api/client'
import { modelPlatformLabel } from '@/lib/modelPlatforms'
import { useAuth } from '@/stores/auth'
import { useComputers } from '@/stores/computers'
import { translate, useLocaleStore } from '@/lib/i18n'

const controlClass = 'w-full rounded-lg border border-ink-100 bg-paper px-3 py-2 text-[12px] text-ink-900'
const buttonClass = 'rounded-lg border border-ink-100 px-3 py-1.5 text-[12px] disabled:opacity-40'
const roles: ApiModelRole[] = ['brain', 'support', 'compaction', 'image', 'audio', 'embed']

export function settingEffect(def: ApiSettingDefinition | undefined, zh: boolean): string {
  const labels: Record<string, string> = {
    immediate: translate(zh ? 'zh-CN' : 'en', 'settings.immediateSnapshot'), 'next-turn': translate(zh ? 'zh-CN' : 'en', 'settings.nextTurn'),
    'next-gate': translate(zh ? 'zh-CN' : 'en', 'settings.nextGateByoaWaitsForActiveSpawns'),
    'next-tick': translate(zh ? 'zh-CN' : 'en', 'settings.nextSchedulerTickNoInFlightReEntry'),
    'next-admission': translate(zh ? 'zh-CN' : 'en', 'settings.nextAdmissionExistingPodsContinue'),
    'next-create': translate(zh ? 'zh-CN' : 'en', 'settings.nextCreation'), restart: translate(zh ? 'zh-CN' : 'en', 'settings.restartRequired'),
    'restart-next-create': translate(zh ? 'zh-CN' : 'en', 'settings.nextCreationAfterRestart'), fixed: translate(zh ? 'zh-CN' : 'en', 'settings.fixedSafetyFloor'),
    'pending-T41': translate(zh ? 'zh-CN' : 'en', 'settings.applicationNotSupportedByThisServer'),
  }
  return labels[def?.effect ?? ''] ?? (translate(zh ? 'zh-CN' : 'en', 'settings.snapshotReadOnNextCallInFlightCallsUnchanged'))
}

export function SettingInfo({ snapshot, settingKey, zh }: { snapshot: ApiModelSettings; settingKey: string; zh: boolean }) {
  const def = snapshot.definitions?.find(d => d.key === settingKey)
  const source = snapshot.sources?.[settingKey] ?? snapshot.metadata?.[settingKey]?.source
  const label = source === 'db' ? 'DB' : source === 'env' ? 'ENV' : source === 'default' ? (translate(zh ? 'zh-CN' : 'en', 'me.agentsIsDefault')) : (translate(zh ? 'zh-CN' : 'en', 'settings.unknownOlderServer'))
  return <div className="text-[11px] text-ink-500 break-words">
    {translate(zh ? 'zh-CN' : 'en', 'adminobs.sourceAria')}: {label} · {translate(zh ? 'zh-CN' : 'en', 'settings.scope')}: {def?.scope ?? 'managed / server'} · {settingEffect(def, zh)}
    {def?.unit && <> · {def.unit}</>}
    {def?.readOnly && <> · {translate(zh ? 'zh-CN' : 'en', 'settings.readOnly')}</>}
    {def?.sensitive && <> · {translate(zh ? 'zh-CN' : 'en', 'settings.sensitiveValueHidden')}</>}
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
      setMessage(translate(zh ? 'zh-CN' : 'en', 'settings.snapshotSavedRuntimeApplicationFollowsEachSettingSBoundary'))
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
          {highRisk && <div className="text-[11px] font-semibold text-coral-deep">{translate(zh ? 'zh-CN' : 'en', 'settings.highRiskAffectsExecutionResourcesCostsOrRetention')}</div>}
          <SettingInfo snapshot={snapshot} settingKey={def.key} zh={zh} />
          <div className="text-[11px] text-ink-500 break-words">{translate(zh ? 'zh-CN' : 'en', 'settings.current')}: {def.sensitive ? '••••' : snapshot.settings[def.key] || '∅'}</div>
          {def.description && <p className="text-[11px] text-ink-500">{def.description}</p>}
          {(def.min !== undefined || def.max !== undefined) && <div className="text-[11px] text-ink-500">{translate(zh ? 'zh-CN' : 'en', 'settings.allowedRange')}: {def.min ?? '—'} … {def.max ?? '—'}</div>}
          {writable && <>
            {options ? <select id={`setting-${def.key}`} className={controlClass} value={value} onChange={e => change(e.target.value)}>
              {!options.includes(value) && <option value={value} disabled>{value} — {translate(zh ? 'zh-CN' : 'en', 'settings.unsupported')}</option>}
              {options.map(option => <option key={option} value={option}>{option}</option>)}
            </select> : def.type === 'json' ? <textarea id={`setting-${def.key}`} className={`${controlClass} font-mono`} rows={7} value={value} onChange={e => change(e.target.value)} />
              : <input id={`setting-${def.key}`} className={controlClass} type={['integer', 'number'].includes(def.type) ? 'number' : 'text'} min={def.min} max={def.max} step={def.type === 'number' ? 'any' : 1} value={value} onChange={e => change(e.target.value)} />}
            <button type="button" className={buttonClass} onClick={() => { setDraft(old => ({ ...old, [def.key]: null })); setMessage('') }}>{translate(zh ? 'zh-CN' : 'en', 'settings.restoreInheritance')}</button>
            {draft[def.key] === null && <span className="ml-2 text-[11px] text-gold-deep">{translate(zh ? 'zh-CN' : 'en', 'settings.pendingSaveRemoveDbOverrideAndResolveEnvDefault')}</span>}
          </>}
        </div>
      })}
    </fieldset>
    {isAdmin && definitions.some(d => !d.readOnly && !d.envOnly && !d.sensitive) && <div className="flex gap-2">
      <button type="button" className={`${buttonClass} bg-skype text-white`} disabled={busy || !Object.keys(patch).length} onClick={() => void save()}>{translate(zh ? 'zh-CN' : 'en', 'settings.saveThisDomain')}</button>
      <button type="button" className={buttonClass} disabled={busy || !Object.keys(draft).length} onClick={() => { setDraft({}); setMessage('') }}>{translate(zh ? 'zh-CN' : 'en', 'settings.discardChanges')}</button>
    </div>}
    {message && <p role="status" className="text-[12px] break-words">{message}</p>}
  </div>
}

export function ByoaPolicyStatus() {
  const zh = useLocaleStore(s => s.locale) === 'zh-CN'
  const byId = useComputers(s => s.byId)
  const loaded = useComputers(s => s.loaded)
  const computers = useMemo(() => Object.values(byId).filter(c => c.kind !== 'cloud'), [byId])
  useEffect(() => {
    void useComputers.getState().refresh()
    const timer = window.setInterval(() => { void useComputers.getState().refresh() }, 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const labels = { unknown: translate(zh ? 'zh-CN' : 'en', 'settings.unknownNotReported'), unsupported: translate(zh ? 'zh-CN' : 'en', 'settings.unsupportedByOlderDaemon'), pending: translate(zh ? 'zh-CN' : 'en', 'settings.pendingReceipt'), received: translate(zh ? 'zh-CN' : 'en', 'settings.receivedAwaitingSafeBoundary'), applied: translate(zh ? 'zh-CN' : 'en', 'settings.applied') }
  return <section className="space-y-3">
    <h3 className="font-semibold">{translate(zh ? 'zh-CN' : 'en', 'settings.byoaPolicyAndDaemonApplicationVersions')}</h3>
    <p className="text-[12px] text-ink-500">{translate(zh ? 'zh-CN' : 'en', 'settings.policyDiscoveryUses30sHeartbeatsResourcesSync60sApplication')}</p>
    <button type="button" className={buttonClass} onClick={() => { void useComputers.getState().refresh() }}>{translate(zh ? 'zh-CN' : 'en', 'settings.refreshApplicationStatus')}</button>
    {!loaded && <p>{translate(zh ? 'zh-CN' : 'en', 'settings.loading')}</p>}
    {loaded && !computers.length && <p className="text-[12px]">{translate(zh ? 'zh-CN' : 'en', 'settings.noByoaComputersInThisCompany')}</p>}
    {computers.map(c => <div key={c.id} className="rounded-xl bg-cloud border border-ink-100 p-4 text-[12px] space-y-1 break-all">
      <div className="font-semibold">{c.name} · daemon {c.daemonVersion ?? (translate(zh ? 'zh-CN' : 'en', 'me.agentsCliUnknown'))} · {c.status}</div>
      <div>{labels[c.runtimePolicy?.status ?? 'unknown'] ?? (translate(zh ? 'zh-CN' : 'en', 'settings.unknownState'))}</div>
      <div>{translate(zh ? 'zh-CN' : 'en', 'settings.desired')}: {c.runtimePolicy?.desired ?? '—'}</div>
      <div>{translate(zh ? 'zh-CN' : 'en', 'settings.received')}: {c.runtimePolicy?.received ?? '—'}</div>
      <div>{translate(zh ? 'zh-CN' : 'en', 'settings.applied2')}: {c.runtimePolicy?.applied ?? '—'}</div>
      <div>{translate(zh ? 'zh-CN' : 'en', 'settings.lastReport')}: {c.runtimePolicy?.reportedAt ?? '—'}</div>
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
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [visited, setVisited] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!isAdmin) return
    const controller = new AbortController()
    void api.getModelSettings(controller.signal).then(result => { if (!controller.signal.aborted) setSnapshot(result) })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) })
    return () => controller.abort()
  }, [isAdmin])
  const onSaved = useCallback((next: ApiModelSettings) => {
    setSnapshot(current => newerSettings(current, next))
  }, [])
  const definitionsByDomain = useMemo(() => {
    const grouped: Record<string, ApiSettingDefinition[]> = {
      automation: [], triage: [], pod: [], turn: [], operations: [], byoa: [],
    }
    for (const d of snapshot?.definitions ?? []) {
      if (!d.scope) continue
      const domain = runtimeDomain(d)
      ;(grouped[domain] ?? grouped.pod).push(d)
    }
    return grouped
  }, [snapshot])
  const domains = [ ['automation', 'settings.automationWake'], ['triage', 'settings.cerebellumTriage'], ['pod', 'settings.podSafety'], ['turn', 'settings.compactionTurn'], ['operations', 'settings.operationsRetention'], ['byoa', 'settings.byoaRuntimePolicy'] ] as const
  return <div className="space-y-6">
    <TurnSafetyPanel budgets />
    <p className="text-[12px] text-ink-500">{translate(zh ? 'zh-CN' : 'en', 'settings.onlySiteAdminsCanWriteGlobalSettingsSavingInstalls')}</p>
    {!isAdmin && <p>{translate(zh ? 'zh-CN' : 'en', 'settings.globalSettingsRequireSiteAdminAccess')}</p>}
    {error && <p role="alert" className="text-coral-deep">{error}</p>}
    {isAdmin && !snapshot && !error && <p>{translate(zh ? 'zh-CN' : 'en', 'settings.loading')}</p>}
    {snapshot && <>
      <p className="text-[12px]">{translate(zh ? 'zh-CN' : 'en', 'settings.savedSnapshotRevision')}: {snapshot.revision ?? '—'}</p>
      {!snapshot.definitions && <p>{translate(zh ? 'zh-CN' : 'en', 'settings.olderServerLacksSettingDefinitionsEditingIsUnavailable')}</p>}
      {snapshot.diagnostics?.map(d => <p key={d} role="alert" className="text-[12px] text-coral-deep">{d}</p>)}
      {domains.map(([domain, label]) => <details key={domain} className="space-y-3" onToggle={(e) => {
        const open = (e.currentTarget as HTMLDetailsElement).open
        if (open) setVisited(s => s[domain] ? s : { ...s, [domain]: true })
        setOpened(s => (s[domain] === open ? s : { ...s, [domain]: open }))
      }}>
        <summary className="font-semibold cursor-pointer">{translate(zh ? 'zh-CN' : 'en', label)}</summary>
        {(opened[domain] || visited[domain]) && <SettingFields snapshot={snapshot} definitions={definitionsByDomain[domain] ?? []} onSaved={onSaved} />}
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
    <h3 className="font-semibold">{translate(zh ? 'zh-CN' : 'en', 'settings.managedRoutePreviewEnvBackup')}</h3>
    <p className="text-[12px] text-ink-500">{translate(zh ? 'zh-CN' : 'en', 'settings.previewResolvesSavedSettingsWithoutCallingAModelAvailable')}</p>
    <div className="flex flex-wrap gap-2">
      <select aria-label={translate(zh ? 'zh-CN' : 'en', 'agent.roleLabel')} className={buttonClass} value={role} onChange={e => setRole(e.target.value as ApiModelRole)}>{roles.map(r => <option key={r}>{r}</option>)}</select>
      <input aria-label={translate(zh ? 'zh-CN' : 'en', 'adminobs.colPurpose')} className={buttonClass} value={purpose} onChange={e => setPurpose(e.target.value)} />
      <button type="button" className={buttonClass} onClick={() => setRefresh(x => x + 1)}>{translate(zh ? 'zh-CN' : 'en', 'settings.refreshPreviewAndGroupValidation')}</button>
    </div>
    {error && <p role="alert" className="text-coral-deep text-[12px]">{error}</p>}
    {preview && <div className="space-y-2 text-[12px]">
      <p>{preview.domain} · {translate(zh ? 'zh-CN' : 'en', 'settings.revision')} {preview.revision} · {translate(zh ? 'zh-CN' : 'en', 'settings.gatewayRouting')}: {String(preview.routable)} · {translate(zh ? 'zh-CN' : 'en', 'settings.provisioningConfigured')}: {String(preview.provisionable)}</p>
      <p>{role === 'embed' ? (translate(zh ? 'zh-CN' : 'en', 'settings.embeddingHasNoFallbackChain')) : backups.length ? (translate(zh ? 'zh-CN' : 'en', 'settings.explicitEnvBackupValue1CandidatesValue2Configured', { value1: backups.length, value2: backups.filter(c => c.available).length })) : (translate(zh ? 'zh-CN' : 'en', 'settings.noExplicitEnvBackupAppendedForThisRolePurpose'))}</p>
      <ol className="list-decimal pl-5 space-y-2">{preview.candidates.map((c, i) => <li key={i} className="rounded-lg bg-cloud p-3 break-words">
        <div className="font-semibold">{c.model} → {c.requestModel}</div>
        <div>{c.route.kind} / {c.route.id} / {c.protocol} · {c.available ? (translate(zh ? 'zh-CN' : 'en', 'settings.configured')) : (translate(zh ? 'zh-CN' : 'en', 'settings.unavailable'))}</div>
        <div>{translate(zh ? 'zh-CN' : 'en', 'adminobs.sourceAria')}: {c.source} · {translate(zh ? 'zh-CN' : 'en', 'settings.endpoint')}: {c.route.endpointSource} · {translate(zh ? 'zh-CN' : 'en', 'settings.credentialSource')}: {c.route.credentialSource}</div>
        {c.diagnostic && <div className="text-coral-deep">{c.diagnostic}</div>}
      </li>)}</ol>
      {preview.diagnostics.map(d => <p key={d} className="text-coral-deep">{d}</p>)}
    </div>}
    <h3 className="font-semibold">{translate(zh ? 'zh-CN' : 'en', 'settings.platformGroupValidationSavedSettings')}</h3>
    {groupError && <p role="alert" className="text-coral-deep text-[12px]">{translate(zh ? 'zh-CN' : 'en', 'settings.unableToValidate')}{groupError}</p>}
    {invalidGroups && <p role="alert">{translate(zh ? 'zh-CN' : 'en', 'settings.invalidGroupConfiguration')}</p>}
    {!invalidGroups && !selection.length && <p className="text-[12px]">{translate(zh ? 'zh-CN' : 'en', 'settings.noExplicitGroupOverridesDeploymentGroupSettingsAreInherited')}</p>}
    {selection.map(g => <p key={`${g.tier}:${g.platform}`} className="text-[12px]">{g.tier} / {modelPlatformLabel(g.platform)} / {g.id}: {groups === null ? (translate(zh ? 'zh-CN' : 'en', 'settings.notVerified')) : groups.some(c => c.id === g.id && c.platform === g.platform) ? (translate(zh ? 'zh-CN' : 'en', 'settings.valid')) : (translate(zh ? 'zh-CN' : 'en', 'settings.unavailableOrPlatformMismatch'))}</p>)}
    {groups && <details><summary className="text-[12px] cursor-pointer">{translate(zh ? 'zh-CN' : 'en', 'settings.availableGroups')} ({groups.length})</summary>{groups.map(g => <p key={`${g.platform}:${g.id}`} className="text-[12px]">{modelPlatformLabel(g.platform)} / {g.id} / {g.name}</p>)}</details>}
    <details className="space-y-3"><summary className="font-semibold cursor-pointer">{translate(zh ? 'zh-CN' : 'en', 'settings.advancedRoutePlatformGroupSettings')}</summary>
      <p className="text-[12px] text-ink-500">{translate(zh ? 'zh-CN' : 'en', 'settings.explicitLlmConfigRolesOverrideTheModelFieldsAbove')}</p>
      <SettingFields snapshot={snapshot} definitions={snapshot.definitions?.filter(d => ['llm_config', 'sub2api_group_config'].includes(d.key)) ?? []} onSaved={onSaved} />
    </details>
  </section>
}
