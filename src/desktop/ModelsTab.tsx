/**
 * Settings-page "Models" tab — global per-role model configuration backed by
 * server_settings (DB → env fallback, no restart). Each role card edits a
 * primary model (searchable full catalog, free input allowed), an
 * ordered fallback chain, and for text roles the reasoning knobs.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ApiModelSettings } from '@/api/client'
import { translate, useT, useLocaleStore, type MessageKey } from '@/lib/i18n'
import { ModelInput, FallbackChainEditor, CatalogStatus, modelSuggestions, EFFORT_OPTIONS, modelInteger } from '@/components/ModelFields'
import { ModelRoutingPanel, SettingInfo, newerSettings } from './RuntimeSettingsPanel'
import { cn } from '@/lib/utils'
import { useAuth } from '@/stores/auth'
import { useModelCatalog } from '@/stores/modelCatalog'

interface RoleDef {
  key: string
  labelKey: MessageKey
  subKey: MessageKey
  modelKey: string
  fallbackKey?: string
  effortKey?: string
  tokensKey?: string
  headroomKey?: string
  embedNote?: boolean
}

const ROLES: RoleDef[] = [
  { key: 'brain', labelKey: 'me.models.brain', subKey: 'me.models.brainSub', modelKey: 'brain_model', fallbackKey: 'brain_fallback_models', effortKey: 'agent_reasoning_effort', tokensKey: 'agent_max_output_tokens' },
  { key: 'support', labelKey: 'me.models.support', subKey: 'me.models.supportSub', modelKey: 'support_model', fallbackKey: 'support_fallback_models', effortKey: 'support_reasoning_effort', headroomKey: 'support_reasoning_headroom' },
  { key: 'compaction', labelKey: 'me.models.compaction', subKey: 'me.models.compactionSub', modelKey: 'compaction_model', fallbackKey: 'compaction_fallback_models' },
  { key: 'image', labelKey: 'me.models.image', subKey: 'me.models.imageSub', modelKey: 'image_model', fallbackKey: 'image_fallback_models' },
  { key: 'audio', labelKey: 'me.models.audio', subKey: 'me.models.audioSub', modelKey: 'audio_model', fallbackKey: 'audio_fallback_models' },
  { key: 'embed', labelKey: 'me.models.embed', subKey: 'me.models.embedSub', modelKey: 'embed_model', embedNote: true },
]

const MODEL_KEYS = ROLES.flatMap((r) => [r.modelKey, r.fallbackKey, r.effortKey, r.tokensKey, r.headroomKey].filter((k): k is string => !!k))

export function dirtyModelSettings(draft: Record<string, string>, initial: Record<string, string>, inherited: ReadonlySet<string> = new Set()): Record<string, string | null> {
  return Object.fromEntries(MODEL_KEYS.filter((k) => inherited.has(k) || draft[k] !== initial[k]).map((k) => [k, inherited.has(k) ? null : draft[k]]))
}

function splitList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

export function ModelsTab() {
  const epoch = useAuth((s) => s.contextEpoch)
  const company = useAuth((s) => s.activeCompanyId)
  return <ModelsTabContent key={`${epoch}:${company}`} />
}

export const ModelsRoleCard = memo(function ModelsRoleCard({
  role, primary, fallback, effort, tokens, headroom,
  initialPrimary, initialFallback, catalog, snapshot, inherited, zh,
  onField, onInherited,
}: {
  role: RoleDef
  primary: string
  fallback: string
  effort: string
  tokens: string
  headroom: string
  initialPrimary: string
  initialFallback: string
  catalog: ReturnType<typeof useModelCatalog>['catalog']
  snapshot: ApiModelSettings | null
  inherited: ReadonlySet<string>
  zh: boolean
  onField: (key: string, value: string) => void
  onInherited: (key: string, next: boolean) => void
}) {
  const t = useT()
  const options = useMemo(
    () => modelSuggestions(catalog, [primary, initialPrimary], splitList(fallback), splitList(initialFallback)),
    [catalog, primary, initialPrimary, fallback, initialFallback],
  )
  const listId = `models-catalog-${role.key}`
  const allowedEfforts = snapshot?.definitions?.find(d => d.key === role.effortKey)?.allowedValues
    ?? (role.effortKey ? snapshot?.metadata?.[role.effortKey]?.allowedValues : undefined)
  const efforts = EFFORT_OPTIONS.filter(v => !allowedEfforts || allowedEfforts.includes(v))
  return (
    <div className="bg-cloud rounded-[14px] p-4 space-y-3" style={{ border: '1px solid var(--ink-100)' }}>
      <div>
        <div className="font-semibold text-[13px] text-ink-900">{t(role.labelKey)}</div>
        <div className="font-display italic font-normal text-[11.5px] text-ink-500 mt-0.5">{t(role.subKey)}</div>
      </div>
      <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5">
        <label className="text-[11.5px] font-semibold text-ink-500">{t('me.models.primary')}</label>
        <ModelInput value={primary} onChange={(v) => onField(role.modelKey, v)} options={options} listId={listId} catalog={catalog} />
      </div>
      {(role.effortKey || role.tokensKey || role.headroomKey) && <details>
        <summary className="text-[12px] font-semibold text-ink-500 cursor-pointer">{t('agent.advancedModelSettings')}</summary>
        <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5 mt-2">
        {role.effortKey && (
          <>
            <label className="text-[11.5px] font-semibold text-ink-500">{t('me.models.effort')}</label>
            <select
              value={inherited.has(role.effortKey) ? '' : effort}
              onChange={(e) => e.target.value ? onField(role.effortKey!, e.target.value) : onInherited(role.effortKey!, true)}
              className="h-8 px-2 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30"
              style={{ border: '1px solid var(--ink-100)' }}>
              <option value="">{translate(zh ? 'zh-CN' : 'en', 'settings.inherit')}</option>
              {effort && !efforts.includes(effort) && <option value={effort} disabled>{effort} — {translate(zh ? 'zh-CN' : 'en', 'settings.unsupported')}</option>}
              {efforts.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </>
        )}
        {role.tokensKey && (
          <>
            <label className="text-[11.5px] font-semibold text-ink-500">{t('me.models.maxTokens')}</label>
            <input
              type="text" inputMode="numeric"
              value={tokens}
              onChange={(e) => onField(role.tokensKey!, e.target.value)}
              className="h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
              style={{ border: '1px solid var(--ink-100)' }} />
          </>
        )}
        {role.headroomKey && (
          <>
            <label className="text-[11.5px] font-semibold text-ink-500">{t('me.models.headroom')}</label>
            <input
              type="text" inputMode="numeric"
              value={headroom}
              onChange={(e) => onField(role.headroomKey!, e.target.value)}
              className="h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
              style={{ border: '1px solid var(--ink-100)' }} />
          </>
        )}
        </div>
      </details>}
      <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5">
        {role.fallbackKey && (
          <>
            <label className="text-[11.5px] font-semibold text-ink-500 self-start pt-1">{t('me.models.fallbacks')}</label>
            <FallbackChainEditor
              value={splitList(fallback)}
              onChange={(v) => onField(role.fallbackKey!, v.join(','))}
              options={options}
              primary={primary}
              history={splitList(initialFallback)}
              catalog={catalog}
              listId={listId}
              t={t} />
          </>
        )}
        {role.embedNote && (
          <div className="col-span-2 text-[11px] text-gold-deep italic">{t('me.models.embedWarn')}</div>
        )}
      </div>
      {snapshot && <div className="space-y-2">{[role.modelKey, role.fallbackKey, role.effortKey, role.tokensKey, role.headroomKey].filter((k): k is string => !!k).map(key => <div key={key}>
        <div className="text-[11px] font-mono break-all">{key}</div>
        <SettingInfo snapshot={snapshot} settingKey={key} zh={zh} />
      </div>)}</div>}
      <details className="text-[11px] text-ink-500">
        <summary className="cursor-pointer">{translate(zh ? 'zh-CN' : 'en', 'settings.restoreInheritanceAppliesAtCallBoundaryAfterSave')}</summary>
        <div className="flex flex-wrap gap-3 mt-2">
        {[role.modelKey, role.fallbackKey, role.effortKey, role.tokensKey, role.headroomKey].filter((k): k is string => !!k).map((key) => <label key={key} className="flex items-center gap-1">
          <input type="checkbox" checked={inherited.has(key)} onChange={(e) => onInherited(key, e.target.checked)} />
          {t(key === role.modelKey ? 'me.models.primary' : key === role.fallbackKey ? 'me.models.fallbacks' : key === role.effortKey ? 'me.models.effort' : key === role.tokensKey ? 'me.models.maxTokens' : 'me.models.headroom')}
        </label>)}
        </div>
      </details>
    </div>
  )
})

function ModelsTabContent() {
  const t = useT()
  const zh = useLocaleStore((s) => s.locale) === 'zh-CN'
  const isAdmin = useAuth(s => s.user?.isAdmin === true)
  const catalogState = useModelCatalog(isAdmin)
  const catalog = catalogState.catalog
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [initial, setInitial] = useState<Record<string, string> | null>(null)
  const [snapshot, setSnapshot] = useState<ApiModelSettings | null>(null)
  const latestSnapshot = useRef<ApiModelSettings | null>(null)
  const [inherited, setInherited] = useState<Set<string>>(new Set())
  const [forbidden, setForbidden] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(false)
  const requests = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  const context = useRef(useAuth.getState())
  const current = () => !requests.current?.signal.aborted && useAuth.getState().contextEpoch === context.current.contextEpoch
    && useAuth.getState().token === context.current.token && useAuth.getState().activeCompanyId === context.current.activeCompanyId

  useEffect(() => {
    if (!isAdmin) return
    const controller = new AbortController()
    requests.current = controller
    void api.getModelSettings(controller.signal).then((s) => {
      if (!current()) return
      setDraft(s.settings)
      setInitial(s.settings)
      latestSnapshot.current = s
      setSnapshot(s)
    }).catch((e) => {
      if (!current()) return
      if ((e as { status?: number })?.status === 403) setForbidden(true)
      else setLoadError(e instanceof Error ? e.message : String(e))
    })
    return () => controller.abort()
  }, [isAdmin])

  const dirty = draft !== null && initial !== null && Object.keys(dirtyModelSettings(draft, initial, inherited)).length > 0
  const onField = useCallback((k: string, v: string) => {
    setDraft((old) => old ? { ...old, [k]: v } : old)
    setInherited((old) => { const next = new Set(old); next.delete(k); return next })
    setSavedTick(false)
  }, [])
  const onInherited = useCallback((key: string, next: boolean) => {
    setInherited((old) => {
      const copy = new Set(old)
      if (next) copy.add(key)
      else copy.delete(key)
      return copy
    })
  }, [])
  if (!isAdmin || forbidden) {
    return <div className="text-[12.5px] text-ink-500 italic">{t('me.models.adminOnly')}</div>
  }
  if (loadError) {
    return <div className="text-[12.5px] text-coral-deep">{t('me.models.loadFailed')}: {loadError}</div>
  }
  if (!draft || !initial) {
    return <div className="text-[12.5px] text-ink-500 italic">{t('me.models.loading')}</div>
  }

  const save = async () => {
    if (!isAdmin || submitting.current || !current()) return
    submitting.current = true
    setSaving(true)
    setSaveError(null)
    setSavedTick(false)
    try {
      const patch = dirtyModelSettings(draft, initial, inherited)
      for (const role of ROLES) {
        for (const [key, min] of [[role.tokensKey, 1], [role.headroomKey, 0]] as const) {
          if (key && typeof patch[key] === 'string' && modelInteger(patch[key], key, min) === undefined) throw new Error(`${key}: ${translate(zh ? 'zh-CN' : 'en', 'settings.enterAnIntegerOrRestoreInheritance')}`)
        }
        const effort = role.effortKey ? patch[role.effortKey] : undefined
        if (typeof effort === 'string' && !EFFORT_OPTIONS.includes(effort)) throw new Error('effort: ' + EFFORT_OPTIONS.join('/'))
        if (typeof patch[role.modelKey] === 'string' && !patch[role.modelKey]?.trim()) throw new Error(`${role.modelKey}: ${translate(zh ? 'zh-CN' : 'en', 'settings.primaryRequiredUseRestoreInheritance')}`)
      }
      const result = await api.putModelSettings(patch, requests.current?.signal)
      if (!current()) return
      // T3 returns the committed snapshot; older servers require a read after restore.
      const committed = result as typeof result & Partial<ApiModelSettings>
      const resultSnapshot = committed.settings ? committed as ApiModelSettings : await api.getModelSettings(requests.current?.signal)
      if (!current()) return
      const snapshot = newerSettings(latestSnapshot.current, resultSnapshot)
      latestSnapshot.current = snapshot
      setDraft(snapshot.settings!)
      setInitial(snapshot.settings!)
      setSnapshot(snapshot as ApiModelSettings)
      setInherited(new Set())
      setSavedTick(true)
      catalogState.refresh()
    } catch (e) {
      if (current()) setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      submitting.current = false
      if (current()) setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <CatalogStatus {...catalogState} />
      <p className="text-[12px] text-ink-500">{translate(zh ? 'zh-CN' : 'en', 'settings.managedGlobalModelsSavingInstallsASnapshotForSubsequent')}</p>
      <p className="text-[12px]">{translate(zh ? 'zh-CN' : 'en', 'settings.snapshotRevision')}: {snapshot?.revision ?? '—'}</p>
      {saveError && <div role="alert" className="text-[12px] text-coral-deep">{saveError}</div>}
      <fieldset disabled={saving} className="space-y-6">
      {ROLES.map((role) => (
        <ModelsRoleCard
          key={role.key}
          role={role}
          primary={draft[role.modelKey] ?? ''}
          fallback={role.fallbackKey ? draft[role.fallbackKey] ?? '' : ''}
          effort={role.effortKey ? draft[role.effortKey] ?? '' : ''}
          tokens={role.tokensKey ? draft[role.tokensKey] ?? '' : ''}
          headroom={role.headroomKey ? draft[role.headroomKey] ?? '' : ''}
          initialPrimary={initial[role.modelKey] ?? ''}
          initialFallback={role.fallbackKey ? initial[role.fallbackKey] ?? '' : ''}
          catalog={catalog}
          snapshot={snapshot}
          inherited={inherited}
          zh={zh}
          onField={onField}
          onInherited={onInherited}
        />
      ))}
      </fieldset>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={!dirty || saving}
          className={cn('h-8 px-4 rounded-full text-[12.5px] font-semibold text-white transition disabled:cursor-not-allowed')}
          style={{ background: saving ? 'var(--ink-200)' : 'var(--skype)', boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)' }}>
          {saving ? t('me.models.saving') : t('me.models.save')}
        </button>
        {savedTick && <span className="text-[12px] text-skype-deep font-medium">{translate(zh ? 'zh-CN' : 'en', 'settings.snapshotSavedCallsApplyItAtTheirBoundary')}</span>}

      </div>
      {snapshot && <ModelRoutingPanel snapshot={snapshot} onSaved={result => {
        const next = newerSettings(latestSnapshot.current, result)
        latestSnapshot.current = next
        setSnapshot(next)
        setInitial(next.settings)
        setDraft(old => ({ ...next.settings, ...Object.fromEntries(MODEL_KEYS.filter(key => old?.[key] !== initial[key]).map(key => [key, old![key]])) }))
        catalogState.refresh()
      }} />}
    </div>
  )
}
