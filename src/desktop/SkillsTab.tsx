/**
 * Settings-page "Skills" tab — the company skill library. List with
 * name/description/source/status, install paths (SkillHub search when
 * configured, local hub import, paste a SKILL.md), delete.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { type ApiLocalHubEntry, type ApiSkill, api } from '@/api/client'
import { translate, useLocaleStore, useT } from '@/lib/i18n'
import { useAuth } from '@/stores/auth'

type T = ReturnType<typeof useT>
type LocalHubEntry = ApiLocalHubEntry & { directory?: string; skillName?: string }

function SourceChip({ source, t }: { source: ApiSkill['source']; t: T }) {
  const label = source === 'skillhub' ? t('me.skills.sourceHub') : source === 'local' ? t('me.skills.sourceLocal') : t('me.skills.sourcePaste')
  return (
    <span className="text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky2-50 text-skype-deep shrink-0">
      {label}
    </span>
  )
}

export function SkillsTab() {
  const t = useT()
  const locale = useLocaleStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  const isSiteAdmin = useAuth((s) => s.user?.isAdmin === true)
  const canWrite = useAuth((s) => ['owner', 'admin'].includes(s.companies.find((c) => c.id === s.activeCompanyId)?.role ?? ''))
  const epoch = useAuth((s) => s.contextEpoch)
  const [skills, setSkills] = useState<ApiSkill[] | null>(null)
  const [hubConfigured, setHubConfigured] = useState(false)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [localPathDraft, setLocalPathDraft] = useState('')
  const [localPathSaving, setLocalPathSaving] = useState(false)
  const [localPathSaved, setLocalPathSaved] = useState(false)
  const [localHub, setLocalHub] = useState<LocalHubEntry[]>([])
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteBody, setPasteBody] = useState('')
  const [hubQuery, setHubQuery] = useState('')
  const [hubHits, setHubHits] = useState<Array<{ id: string; name?: string; description?: string }> | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const active = useRef(new Set<string>())
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [localLoading, setLocalLoading] = useState(false)
  const librarySequence = useRef(0)
  const localSequence = useRef(0)
  const current = () => useAuth.getState().contextEpoch === epoch
  const fail = (source: string, e: unknown) => {
    if (current()) setErrors((prev) => ({ ...prev, [source]: e instanceof Error ? e.message : String(e) }))
  }
  const loadLocal = useCallback(async () => {
    if (!isSiteAdmin) return
    const sequence = ++localSequence.current
    setLocalLoading(true)
    setErrors((prev) => ({ ...prev, local: null }))
    try {
      const r = await api.getLocalHubSkills()
      if (useAuth.getState().contextEpoch !== epoch || sequence !== localSequence.current) return
      setLocalHub(r.items)
      setLocalPath(r.path)
    } catch (e) { if (sequence === localSequence.current) fail('local', e) }
    finally { if (current() && sequence === localSequence.current) setLocalLoading(false) }
  }, [epoch, isSiteAdmin])
  const load = useCallback(async () => {
    const sequence = ++librarySequence.current
    setErrors((prev) => ({ ...prev, library: null }))
    try {
      const r = await api.getSkills()
      if (useAuth.getState().contextEpoch !== epoch || sequence !== librarySequence.current) return
      setSkills(r.items)
      setHubConfigured(r.hubConfigured)
    } catch (e) { if (sequence === librarySequence.current) fail('library', e) }
  }, [epoch])

  useEffect(() => {
    setSkills(null)
    setLocalHub([])
    setLocalPath(null)
    setHubHits(null)
    setPasteOpen(false)
    setPasteBody('')
    setLocalPathDraft('')
    setLocalPathSaving(false)
    setLocalPathSaved(false)
    setHubConfigured(false)
    setHubQuery('')
    setErrors({})
    setNotice(null)
    setBusy(new Set())
    active.current.clear()
    void load()
    if (isSiteAdmin) void loadLocal()
    if (isSiteAdmin) void api.getModelSettings().then((r) => {
      if (current()) setLocalPathDraft(r.settings.local_skillhub_path ?? '')
    }).catch((e) => fail('path', e))
  }, [load, loadLocal, canWrite, isSiteAdmin])

  const run = async (key: string, source: string, fn: () => Promise<unknown>) => {
    if (!canWrite || !current() || active.current.has(key)) return
    active.current.add(key)
    setBusy((prev) => new Set(prev).add(key))
    setErrors((prev) => ({ ...prev, [source]: null }))
    try {
      await fn()
      if (!current()) return
      if (key !== 'hub-search') {
        setNotice(translate(zh ? 'zh-CN' : 'en', 'settings.libraryUpdatedManageBindingsAndCheckResourceApplicationStatus'))
        await load()
        void loadLocal()
      }
    } catch (e) { fail(source, e) }
    finally {
      if (current()) {
        active.current.delete(key)
        setBusy((prev) => { const next = new Set(prev); next.delete(key); return next })
      }
    }
  }

  const saveLocalPath = async () => {
    if (!isSiteAdmin || !current() || localPathSaving) return
    setLocalPathSaving(true)
    setLocalPathSaved(false)
    setErrors((prev) => ({ ...prev, path: null }))
    try {
      const value = localPathDraft.trim()
      await api.putModelSettings({ local_skillhub_path: value })
      if (!current()) return
      setLocalPath(value || null)
      setLocalPathDraft(value)
      setLocalPathSaved(true)
      if (canWrite) await loadLocal()
    } catch (e) { fail('path', e) }
    finally { if (current()) setLocalPathSaving(false) }
  }

  const doSearch = () => run('hub-search', 'hub', async () => {
    if (!hubConfigured || !hubQuery.trim()) return
    const r = await api.searchSkillHub(hubQuery)
    if (current()) setHubHits(r.items)
  })

  const doPaste = () => run('paste', 'paste', async () => {
    if (!pasteBody.trim()) return
    await api.createSkillFromPaste(pasteBody)
    if (current()) { setPasteBody(''); setPasteOpen(false) }
  })

  return (
    <div className="space-y-6">
      {notice && <div role="status" className="text-[11.5px] text-skype-deep">{notice}</div>}
      {!canWrite && <div className="text-[11.5px] text-ink-500">{translate(zh ? 'zh-CN' : 'en', 'settings.readOnlyLibraryInstallingAndDeletingRequireCompanyOwner')}</div>}

      {/* install paths */}
      {(canWrite || isSiteAdmin) && <div className="bg-cloud rounded-[14px] p-4 space-y-3" style={{ border: '1px solid var(--ink-100)' }}>
        <div className="font-semibold text-[13px] text-ink-900">{t('me.skills.installTitle')}</div>

        {/* local hub path */}
        {isSiteAdmin && <div className="space-y-2 border-b border-ink-100 pb-3">
          <div className="font-semibold text-[12px] text-ink-700">{t('me.skills.localPathLabel')}</div>
          <div className="flex gap-2">
            <input
              value={localPathDraft}
              onChange={(e) => { setLocalPathDraft(e.target.value); setLocalPathSaved(false) }}
              placeholder={t('me.skills.localPathPlaceholder')}
              className="flex-1 h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30"
              style={{ border: '1px solid var(--ink-100)' }}
            />
            <button type="button" disabled={localPathSaving}
              onClick={() => void saveLocalPath()}
              className="h-8 px-3.5 rounded-[8px] text-[12px] font-semibold text-white transition disabled:cursor-not-allowed"
              style={{ background: localPathSaving ? 'var(--ink-200)' : 'var(--skype)' }}>
              {localPathSaving ? t('me.skills.localPathSaving') : t('me.skills.localPathSave')}
            </button>
          </div>
          <div className="text-[11px] text-ink-400 italic">{translate(zh ? 'zh-CN' : 'en', 'settings.serverReadablePathTheSkillRootReadByThe')}</div>
          {localPathSaved && <div className="text-[11px] text-skype-deep">{t('me.skills.localPathSaved')}</div>}
          {errors.path && <div role="alert" className="text-[11px] text-coral-deep">{errors.path}</div>}
        </div>}

        {canWrite && <>
        {/* SkillHub */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={hubQuery}
              onChange={(e) => setHubQuery(e.target.value)}
              placeholder={t('me.skills.hubSearchPh')}
              disabled={!hubConfigured}
              className="flex-1 h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 disabled:opacity-50"
              style={{ border: '1px solid var(--ink-100)' }}
              onKeyDown={(e) => { if (e.key === 'Enter' && hubQuery.trim()) void doSearch() }}
            />
            <button type="button" disabled={!hubConfigured || !hubQuery.trim() || busy.has('hub-search')}
              onClick={() => void doSearch()}
              className="h-8 px-3.5 rounded-[8px] text-[12px] font-semibold text-white transition disabled:cursor-not-allowed"
              style={{ background: hubConfigured ? 'var(--skype)' : 'var(--ink-200)' }}>
              {t('me.skills.hubSearch')}
            </button>
          </div>
          {!hubConfigured && (
            <div className="text-[11px] text-ink-400 italic">{t('me.skills.hubNotConfigured')}</div>
          )}
          {errors.hub && <div role="alert" className="text-[11px] text-coral-deep">{t('me.skills.hubErrorPrefix')}{errors.hub}</div>}
          {!errors.hub && hubHits && hubHits.length === 0 && (
            <div className="text-[11px] text-ink-400 italic">{t('me.skills.hubNoHits')}</div>
          )}
          {(hubHits ?? []).map((h) => (
            <div key={h.id} className="flex items-center gap-2.5 text-[12px]">
              <span className="font-mono text-ink-700 truncate flex-1">{h.name ?? h.id}</span>
              <span className="text-ink-400 truncate flex-[2]">{h.description ?? ''}</span>
              <button type="button" disabled={busy.has(`hub-${h.id}`)}
                onClick={() => void run(`hub-${h.id}`, 'hub', () => api.installSkillFromHub(h.id))}
                className="h-6 px-2.5 rounded-[6px] text-[11px] font-semibold text-skype-deep hover:bg-sky2-50 shrink-0">
                {t('me.skills.install')}
              </button>
            </div>
          ))}
        </div>

        {/* local hub */}
        {isSiteAdmin && (localPath || errors.local || localLoading) && (
          <div className="space-y-2 border-t border-ink-100 pt-3">
            <div className="text-[11.5px] font-semibold text-ink-500">
              {t('me.skills.localHub')} <span className="font-mono font-normal text-ink-400">{localPath}</span>
            </div>
            {localLoading && <div role="status">{t('common.loading')}</div>}
            {errors.local && <div role="alert" className="text-[11px] text-coral-deep">{t('me.skills.localHub')}: {errors.local}</div>}
            {!localLoading && !errors.local && localHub.length === 0 && <div className="text-[11px] text-ink-400 italic">{t('me.skills.localEmpty')}</div>}
            {!errors.local && localHub.map((h) => (
              <div key={(h.directory ?? h.name)} className="flex items-center gap-2.5 text-[12px]">
                <span className="font-mono text-ink-700 truncate w-44 shrink-0">{(h.directory ?? h.name)}</span>
                <span className="text-ink-400 truncate flex-1">{h.description}</span>
                {h.imported
                  ? <span className="text-[10.5px] text-ink-300 shrink-0">{t('me.skills.imported')}</span>
                  : (
                    <button type="button" disabled={busy.has(`local-${(h.directory ?? h.name)}`)}
                      onClick={() => void run(`local-${(h.directory ?? h.name)}`, 'local', () => api.importLocalSkill(h.directory ?? h.name))}
                      className="h-6 px-2.5 rounded-[6px] text-[11px] font-semibold text-skype-deep hover:bg-sky2-50 shrink-0">
                      {t('me.skills.install')}
                    </button>
                  )}
              </div>
            ))}
          </div>
        )}

        {/* paste */}
        {errors.paste && <div role="alert" className="text-[11px] text-coral-deep">{t('me.skills.sourcePaste')}: {errors.paste}</div>}
        <div className="border-t border-ink-100 pt-3">
          <button type="button" onClick={() => setPasteOpen((v) => !v)}
            className="text-[12px] font-semibold text-skype-deep hover:underline">
            {pasteOpen ? t('me.skills.pasteClose') : t('me.skills.pasteOpen')}
          </button>
          {pasteOpen && (
            <div className="mt-2 space-y-2">
              <textarea
                value={pasteBody}
                onChange={(e) => setPasteBody(e.target.value)}
                rows={8}
                placeholder={'---\nname: my-skill\ndescription: …\n---\n\n# …'}
                className="w-full p-2.5 rounded-[8px] text-[12px] font-mono text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30"
                style={{ border: '1px solid var(--ink-100)' }}
                spellCheck={false}
              />
              <button type="button" disabled={!pasteBody.trim() || busy.has('paste')}
                onClick={() => void doPaste()}
                className="h-8 px-3.5 rounded-[8px] text-[12px] font-semibold text-white disabled:cursor-not-allowed"
                style={{ background: pasteBody.trim() ? 'var(--skype)' : 'var(--ink-200)' }}>
                {busy.has('paste') ? t('me.skills.creating') : t('me.skills.pasteCreate')}
              </button>
            </div>
          )}
        </div>
        </>}
      </div>}

      {/* library list */}
      <div className="bg-cloud rounded-[14px] divide-y divide-ink-100" style={{ border: '1px solid var(--ink-100)' }}>
        {errors.library && <div role="alert" className="p-4 text-[12px] text-coral-deep">{translate(zh ? 'zh-CN' : 'en', 'settings.library')}: {errors.library} <button type="button" className="underline" onClick={() => void load()}>{translate(zh ? 'zh-CN' : 'en', 'ship.retry')}</button></div>}
        {skills === null && !errors.library && <div className="p-4 text-[12px] text-ink-400 italic">{t('common.loading')}</div>}
        {!errors.library && skills?.length === 0 && (
          <div className="p-4 text-[12px] text-ink-400 italic">{t('me.skills.empty')}</div>
        )}
        {skills?.map((s) => (
          <div key={s.id} className="flex items-center gap-3 p-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[13px] text-ink-900 truncate">{s.name}</span>
                <SourceChip source={s.source} t={t} />
              </div>
              <div className="font-display italic font-normal text-[11.5px] text-ink-500 mt-0.5 truncate">{s.description}</div>
            </div>
            <span className="text-[10.5px] text-ink-300 shrink-0 tabular-nums">{s.files.length} {t('me.skills.files')}</span>
            {canWrite && <button type="button" disabled={busy.has(`del-${s.id}`)}
              onClick={() => void run(`del-${s.id}`, 'library', () => api.deleteSkill(s.id))}
              className="w-6 h-6 rounded-md grid place-items-center text-ink-400 hover:bg-coral-soft hover:text-coral-deep transition shrink-0"
              aria-label={t('me.skills.delete')}>
              ×
            </button>}
          </div>
        ))}
      </div>
    </div>
  )
}
