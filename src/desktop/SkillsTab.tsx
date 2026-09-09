/**
 * Settings-page "Skills" tab — the company skill library. List with
 * name/description/source/status, install paths (SkillHub search when
 * configured, local hub import, paste a SKILL.md), delete.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type ApiSkill, type ApiLocalHubEntry } from '@/api/client'
import { useT } from '@/lib/i18n'

type T = ReturnType<typeof useT>
import { cn } from '@/lib/utils'

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
  const [skills, setSkills] = useState<ApiSkill[] | null>(null)
  const [hubConfigured, setHubConfigured] = useState(false)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [localPathDraft, setLocalPathDraft] = useState('')
  const [localPathSaving, setLocalPathSaving] = useState(false)
  const [localPathSaved, setLocalPathSaved] = useState(false)
  const [localHub, setLocalHub] = useState<ApiLocalHubEntry[]>([])
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteBody, setPasteBody] = useState('')
  const [hubQuery, setHubQuery] = useState('')
  const [hubHits, setHubHits] = useState<Array<{ id: string; name?: string; description?: string }> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void api.getSkills().then((r) => {
      setSkills(r.items)
      setHubConfigured(r.hubConfigured)
      setLocalPath(r.localHubPath)
      setLocalPathDraft((current) => current || r.localHubPath || '')
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
    void api.getLocalHubSkills().then((r) => setLocalHub(r.items)).catch(() => {})
    void api.getModelSettings().then((r) => setLocalPathDraft(r.settings.local_skillhub_path ?? '')).catch(() => {})
  }, [])

  useEffect(load, [load])

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const saveLocalPath = async () => {
    setLocalPathSaving(true)
    setError(null)
    try {
      const value = localPathDraft.trim()
      await api.putModelSettings({ local_skillhub_path: value })
      setLocalPath(value || null)
      setLocalPathDraft(value)
      setLocalPathSaved(true)
      window.setTimeout(() => setLocalPathSaved(false), 3200)
      await api.getLocalHubSkills().then((r) => setLocalHub(r.items)).catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLocalPathSaving(false)
    }
  }

  const doSearch = () => run('hub-search', async () => {
    setHubHits((await api.searchSkillHub(hubQuery)).items)
  })

  const doPaste = () => run('paste', async () => {
    await api.createSkillFromPaste(pasteBody)
    setPasteBody('')
    setPasteOpen(false)
  })

  return (
    <div className="space-y-6">
      {error && <div className="text-[11.5px] text-coral-deep">{error}</div>}

      {/* install paths */}
      <div className="bg-cloud rounded-[14px] p-4 space-y-3" style={{ border: '1px solid var(--ink-100)' }}>
        <div className="font-semibold text-[13px] text-ink-900">{t('me.skills.installTitle')}</div>

        {/* local hub path */}
        <div className="space-y-2 border-b border-ink-100 pb-3">
          <div className="font-semibold text-[12px] text-ink-700">{t('me.skills.localPathLabel')}</div>
          <div className="flex gap-2">
            <input
              value={localPathDraft}
              onChange={(e) => setLocalPathDraft(e.target.value)}
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
          <div className="text-[11px] text-ink-400 italic">{t('me.skills.localPathHint')}</div>
          {localPathSaved && <div className="text-[11px] text-skype-deep">{t('me.skills.localPathSaved')}</div>}
        </div>

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
            <button type="button" disabled={!hubConfigured || !hubQuery.trim() || busy === 'hub-search'}
              onClick={() => void doSearch()}
              className="h-8 px-3.5 rounded-[8px] text-[12px] font-semibold text-white transition disabled:cursor-not-allowed"
              style={{ background: hubConfigured ? 'var(--skype)' : 'var(--ink-200)' }}>
              {t('me.skills.hubSearch')}
            </button>
          </div>
          {!hubConfigured && (
            <div className="text-[11px] text-ink-400 italic">{t('me.skills.hubNotConfigured')}</div>
          )}
          {hubHits && hubHits.length === 0 && (
            <div className="text-[11px] text-ink-400 italic">{t('me.skills.hubNoHits')}</div>
          )}
          {(hubHits ?? []).map((h) => (
            <div key={h.id} className="flex items-center gap-2.5 text-[12px]">
              <span className="font-mono text-ink-700 truncate flex-1">{h.name ?? h.id}</span>
              <span className="text-ink-400 truncate flex-[2]">{h.description ?? ''}</span>
              <button type="button" disabled={busy === `hub-${h.id}`}
                onClick={() => void run(`hub-${h.id}`, () => api.installSkillFromHub(h.id))}
                className="h-6 px-2.5 rounded-[6px] text-[11px] font-semibold text-skype-deep hover:bg-sky2-50 shrink-0">
                {t('me.skills.install')}
              </button>
            </div>
          ))}
        </div>

        {/* local hub */}
        {localPath && (
          <div className="space-y-2 border-t border-ink-100 pt-3">
            <div className="text-[11.5px] font-semibold text-ink-500">
              {t('me.skills.localHub')} <span className="font-mono font-normal text-ink-400">{localPath}</span>
            </div>
            {localHub.length === 0 && <div className="text-[11px] text-ink-400 italic">{t('me.skills.localEmpty')}</div>}
            {localHub.map((h) => (
              <div key={h.name} className="flex items-center gap-2.5 text-[12px]">
                <span className="font-mono text-ink-700 truncate w-44 shrink-0">{h.name}</span>
                <span className="text-ink-400 truncate flex-1">{h.description}</span>
                {h.imported
                  ? <span className="text-[10.5px] text-ink-300 shrink-0">{t('me.skills.imported')}</span>
                  : (
                    <button type="button" disabled={busy === `local-${h.name}`}
                      onClick={() => void run(`local-${h.name}`, () => api.importLocalSkill(h.name))}
                      className="h-6 px-2.5 rounded-[6px] text-[11px] font-semibold text-skype-deep hover:bg-sky2-50 shrink-0">
                      {t('me.skills.install')}
                    </button>
                  )}
              </div>
            ))}
          </div>
        )}

        {/* paste */}
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
              <button type="button" disabled={!pasteBody.trim() || busy === 'paste'}
                onClick={() => void doPaste()}
                className="h-8 px-3.5 rounded-[8px] text-[12px] font-semibold text-white disabled:cursor-not-allowed"
                style={{ background: pasteBody.trim() ? 'var(--skype)' : 'var(--ink-200)' }}>
                {busy === 'paste' ? t('me.skills.creating') : t('me.skills.pasteCreate')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* library list */}
      <div className="bg-cloud rounded-[14px] divide-y divide-ink-100" style={{ border: '1px solid var(--ink-100)' }}>
        {skills === null && <div className="p-4 text-[12px] text-ink-400 italic">{t('common.loading')}</div>}
        {skills?.length === 0 && (
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
            <button type="button" disabled={busy === `del-${s.id}`}
              onClick={() => void run(`del-${s.id}`, () => api.deleteSkill(s.id))}
              className="w-6 h-6 rounded-md grid place-items-center text-ink-400 hover:bg-coral-soft hover:text-coral-deep transition shrink-0"
              aria-label={t('me.skills.delete')}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
