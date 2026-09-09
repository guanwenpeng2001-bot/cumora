/**
 * Settings-page "Models" tab — global per-role model configuration backed by
 * server_settings (DB → env fallback, no restart). Each role card edits a
 * primary model (datalist from the catalog API, free input allowed), an
 * ordered fallback chain, and for text roles the reasoning knobs.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type ApiModelCatalog } from '@/api/client'
import { useT, type MessageKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface RoleDef {
  key: string
  labelKey: MessageKey
  subKey: MessageKey
  modelKey: string
  fallbackKey?: string
  bucket: keyof Pick<ApiModelCatalog, 'text' | 'image' | 'audio' | 'embedding'>
  effortKey?: string
  tokensKey?: string
  headroomKey?: string
  embedNote?: boolean
}

const ROLES: RoleDef[] = [
  { key: 'brain', labelKey: 'me.models.brain', subKey: 'me.models.brainSub', modelKey: 'brain_model', fallbackKey: 'brain_fallback_models', bucket: 'text', effortKey: 'agent_reasoning_effort', tokensKey: 'agent_max_output_tokens' },
  { key: 'support', labelKey: 'me.models.support', subKey: 'me.models.supportSub', modelKey: 'support_model', fallbackKey: 'support_fallback_models', bucket: 'text', effortKey: 'support_reasoning_effort', headroomKey: 'support_reasoning_headroom' },
  { key: 'compaction', labelKey: 'me.models.compaction', subKey: 'me.models.compactionSub', modelKey: 'compaction_model', fallbackKey: 'compaction_fallback_models', bucket: 'text' },
  { key: 'image', labelKey: 'me.models.image', subKey: 'me.models.imageSub', modelKey: 'image_model', fallbackKey: 'image_fallback_models', bucket: 'image' },
  { key: 'audio', labelKey: 'me.models.audio', subKey: 'me.models.audioSub', modelKey: 'audio_model', fallbackKey: 'audio_fallback_models', bucket: 'audio' },
  { key: 'embed', labelKey: 'me.models.embed', subKey: 'me.models.embedSub', modelKey: 'embed_model', bucket: 'embedding', embedNote: true },
]

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'max'] as const

function splitList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Model input with catalog suggestions but free text allowed. */
function ModelInput({ value, onChange, options, listId }: {
  value: string
  onChange: (v: string) => void
  options: string[]
  listId: string
}) {
  return (
    <>
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
        style={{ border: '1px solid var(--ink-100)' }}
        spellCheck={false}
      />
      <datalist id={listId}>
        {options.map((m) => <option key={m} value={m} />)}
      </datalist>
    </>
  )
}

/** Ordered fallback chain editor: rows with up/down/remove + an add input. */
function FallbackChainEditor({ value, onChange, options, listId, t }: {
  value: string[]
  onChange: (v: string[]) => void
  options: string[]
  listId: string
  t: (k: MessageKey) => string
}) {
  const [adding, setAdding] = useState('')
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= value.length) return
    const next = [...value]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    onChange(next)
  }
  return (
    <div className="space-y-1.5">
      {value.map((m, i) => (
        <div key={`${m}-${i}`} className="flex items-center gap-1.5">
          <span className="text-[10px] text-ink-300 w-4 text-right tabular-nums">{i + 1}.</span>
          <span className="flex-1 min-w-0 font-mono text-[12px] text-ink-700 truncate">{m}</span>
          <button type="button" title={t('me.models.moveUp')} disabled={i === 0}
            className="w-5 h-5 grid place-items-center rounded text-ink-400 hover:bg-sky2-50 disabled:opacity-30"
            onClick={() => move(i, -1)}>↑</button>
          <button type="button" title={t('me.models.moveDown')} disabled={i === value.length - 1}
            className="w-5 h-5 grid place-items-center rounded text-ink-400 hover:bg-sky2-50 disabled:opacity-30"
            onClick={() => move(i, 1)}>↓</button>
          <button type="button" title={t('me.models.remove')}
            className="w-5 h-5 grid place-items-center rounded text-ink-400 hover:bg-coral-soft hover:text-coral-deep"
            onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <input
          list={listId}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder={t('me.models.addFallback')}
          className="flex-1 h-7 px-2 rounded-[7px] text-[12px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
          style={{ border: '1px solid var(--ink-100)' }}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && adding.trim()) {
              onChange([...value, adding.trim()])
              setAdding('')
            }
          }}
        />
        <button type="button"
          className="h-7 px-2.5 rounded-[7px] text-[11.5px] font-semibold text-skype-deep hover:bg-sky2-50 transition"
          disabled={!adding.trim()}
          onClick={() => { onChange([...value, adding.trim()]); setAdding('') }}>
          {t('me.models.add')}
        </button>
      </div>
    </div>
  )
}

export function ModelsTab() {
  const t = useT()
  const [catalog, setCatalog] = useState<ApiModelCatalog | null>(null)
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [initial, setInitial] = useState<Record<string, string> | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedTick, setSavedTick] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([api.getModelSettings(), api.getAvailableModels()])
      .then(([s, c]) => {
        if (cancelled) return
        setDraft(s.settings)
        setInitial(s.settings)
        setCatalog(c)
      })
      .catch((e) => {
        if (cancelled) return
        const status = (e as { status?: number })?.status
        if (status === 403) setForbidden(true)
        else setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [])

  const refreshCatalog = () => {
    void api.getAvailableModels(true).then(setCatalog).catch(() => { /* keep old */ })
  }

  const dirty = useMemo(() => draft !== null && initial !== null && JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial])
  if (forbidden) {
    return <div className="text-[12.5px] text-ink-500 italic">{t('me.models.adminOnly')}</div>
  }
  if (loadError) {
    return <div className="text-[12.5px] text-coral-deep">{t('me.models.loadFailed')}: {loadError}</div>
  }
  if (!draft || !catalog) {
    return <div className="text-[12.5px] text-ink-500 italic">{t('me.models.loading')}</div>
  }

  const set = (k: string, v: string) => setDraft({ ...draft, [k]: v })

  const save = async () => {
    setSaving(true)
    try {
      await api.putModelSettings(draft)
      setInitial(draft)
      setSavedTick(true)
      window.setTimeout(() => setSavedTick(false), 3200)
      refreshCatalog()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {!catalog.gateway && (
        <div className="text-[12px] py-2 px-3 rounded-[10px] text-gold-deep"
          style={{ background: 'var(--gold-soft, rgba(212,160,32,0.10))', border: '1px solid rgba(212,160,32,0.25)' }}>
          {t('me.models.gatewayDown')}
        </div>
      )}
      {ROLES.map((role) => {
        const listId = `models-catalog-${role.key}`
        const options = catalog[role.bucket]
        return (
          <div key={role.key} className="bg-cloud rounded-[14px] p-4 space-y-3"
            style={{ border: '1px solid var(--ink-100)' }}>
            <div>
              <div className="font-semibold text-[13px] text-ink-900">{t(role.labelKey)}</div>
              <div className="font-display italic font-normal text-[11.5px] text-ink-500 mt-0.5">{t(role.subKey)}</div>
            </div>
            <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5">
              <label className="text-[11.5px] font-semibold text-ink-500">{t('me.models.primary')}</label>
              <ModelInput value={draft[role.modelKey] ?? ''} onChange={(v) => set(role.modelKey, v)} options={options} listId={listId} />
              {role.effortKey && (
                <>
                  <label className="text-[11.5px] font-semibold text-ink-500">{t('me.models.effort')}</label>
                  <select
                    value={draft[role.effortKey] ?? 'low'}
                    onChange={(e) => set(role.effortKey!, e.target.value)}
                    className="h-8 px-2 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30"
                    style={{ border: '1px solid var(--ink-100)' }}>
                    {EFFORT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </>
              )}
              {role.tokensKey && (
                <>
                  <label className="text-[11.5px] font-semibold text-ink-500">{t('me.models.maxTokens')}</label>
                  <input
                    type="number" min={1}
                    value={draft[role.tokensKey] ?? ''}
                    onChange={(e) => set(role.tokensKey!, e.target.value)}
                    className="h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
                    style={{ border: '1px solid var(--ink-100)' }} />
                </>
              )}
              {role.headroomKey && (
                <>
                  <label className="text-[11.5px] font-semibold text-ink-500">{t('me.models.headroom')}</label>
                  <input
                    type="number" min={0}
                    value={draft[role.headroomKey] ?? ''}
                    onChange={(e) => set(role.headroomKey!, e.target.value)}
                    className="h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
                    style={{ border: '1px solid var(--ink-100)' }} />
                </>
              )}
              {role.fallbackKey && (
                <>
                  <label className="text-[11.5px] font-semibold text-ink-500 self-start pt-1">{t('me.models.fallbacks')}</label>
                  <FallbackChainEditor
                    value={splitList(draft[role.fallbackKey] ?? '')}
                    onChange={(v) => set(role.fallbackKey!, v.join(','))}
                    options={options}
                    listId={listId}
                    t={t} />
                </>
              )}
              {role.embedNote && (
                <div className="col-span-2 text-[11px] text-gold-deep italic">{t('me.models.embedWarn')}</div>
              )}
            </div>
          </div>
        )
      })}
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={!dirty || saving}
          className={cn('h-8 px-4 rounded-full text-[12.5px] font-semibold text-white transition disabled:cursor-not-allowed')}
          style={{ background: saving ? 'var(--ink-200)' : 'var(--skype)', boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)' }}>
          {saving ? t('me.models.saving') : t('me.models.save')}
        </button>
        {savedTick && <span className="text-[12px] text-skype-deep font-medium">{t('me.models.saved')}</span>}
        <button type="button" onClick={refreshCatalog}
          className="ml-auto text-[11.5px] text-ink-400 hover:text-skype-deep transition">
          {t('me.models.refreshCatalog')}
        </button>
      </div>
    </div>
  )
}
