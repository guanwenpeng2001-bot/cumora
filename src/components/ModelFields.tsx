/**
 * Shared model-field editors used by the global Models tab
 * (src/desktop/ModelsTab.tsx) and the agent editor's advanced block
 * (src/components/AgentEditor.tsx): a free-input model field with catalog
 * suggestions, and an ordered fallback-chain editor.
 */
import { useId, useRef, useState } from 'react'
import { translate, useLocaleStore } from '@/lib/i18n'
import { catalogPlatforms, catalogSource, type Catalog } from '@/stores/modelCatalog'
import type { MessageKey, useT } from '@/lib/i18n'

type T = ReturnType<typeof useT>

/** Model input with catalog suggestions but free text allowed. */
export function ModelInput({ value, onChange, options, listId, placeholder, catalog }: {
  value: string
  onChange: (v: string) => void
  options: string[]
  listId: string
  placeholder?: string
  catalog?: Catalog | null
}) {
  const id = `${listId}-${useId()}`
  return (
    <>
      <input
        list={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
        style={{ border: '1px solid var(--ink-100)' }}
        spellCheck={false}
      />
      <datalist id={id}>
        {[...new Set([...options, value].filter(Boolean))].map((m) => <option key={m} value={m} label={catalogSource(catalog ?? null, m)} />)}
      </datalist>
    </>
  )
}

/** Ordered fallback chain editor: rows with up/down/remove + an add input. */
export function FallbackChainEditor({ value, onChange, options, listId, t, primary, history = [], catalog }: {
  value: string[]
  onChange: (v: string[]) => void
  options: string[]
  listId: string
  t: T
  primary?: string
  history?: string[]
  catalog?: Catalog | null
}) {
  const [adding, setAdding] = useState('')
  const id = `${listId}-${useId()}`
  const historical = useRef([...value, ...history])
  const zh = useLocaleStore((s) => s.locale) === 'zh-CN'
  const suggestions = [...new Set([...options, primary ?? '', ...historical.current, ...history, ...value].filter(Boolean))]
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= value.length) return
    const next = [...value]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    onChange(next)
  }
  const add = () => {
    const v = adding.trim()
    if (!v || value.includes(v)) return
    onChange([...value, v])
    setAdding('')
  }
  return (
    <div className="space-y-1.5">
      <datalist id={id}>
        {suggestions.map((m) => <option key={m} value={m} label={[
          options.includes(m) ? catalogSource(catalog ?? null, m) : null,
          m === primary ? (translate(zh ? 'zh-CN' : 'en', 'settings.currentPrimary')) : null,
          historical.current.includes(m) || history.includes(m) || value.includes(m) ? (translate(zh ? 'zh-CN' : 'en', 'settings.fallbackHistory')) : null,
        ].filter(Boolean).join(' · ')} />)}
      </datalist>
      {value.map((m, i) => (
        <div key={`${m}-${i}`} className="flex items-center gap-1.5">
          <span className="text-[10px] text-ink-300 w-4 text-right tabular-nums">{i + 1}.</span>
          <span className="flex-1 min-w-0 font-mono text-[12px] text-ink-700 truncate">{m}</span>
          <button type="button" title={t('me.models.moveUp' as MessageKey)} disabled={i === 0}
            className="w-5 h-5 grid place-items-center rounded text-ink-400 hover:bg-sky2-50 disabled:opacity-30"
            onClick={() => move(i, -1)}>↑</button>
          <button type="button" title={t('me.models.moveDown' as MessageKey)} disabled={i === value.length - 1}
            className="w-5 h-5 grid place-items-center rounded text-ink-400 hover:bg-sky2-50 disabled:opacity-30"
            onClick={() => move(i, 1)}>↓</button>
          <button type="button" title={t('me.models.remove' as MessageKey)}
            className="w-5 h-5 grid place-items-center rounded text-ink-400 hover:bg-coral-soft hover:text-coral-deep"
            onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <input
          list={id}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder={t('me.models.addFallback' as MessageKey)}
          className="flex-1 h-7 px-2 rounded-[7px] text-[12px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
          style={{ border: '1px solid var(--ink-100)' }}
          spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
        />
        <button type="button"
          className="h-7 px-2.5 rounded-[7px] text-[11.5px] font-semibold text-skype-deep hover:bg-sky2-50 transition"
          disabled={!adding.trim()}
          onClick={add}>
          {t('me.models.add' as MessageKey)}
        </button>
      </div>
    </div>
  )
}

export const EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']

export function modelInteger(value: string, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (!value.trim()) return undefined
  const number = Number(value)
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(translate(useLocaleStore.getState().locale, 'settings.integerRange', { label, min, max }))
  }
  return number
}

export function CatalogStatus({ catalog, error, loading, refresh }: {
  catalog: Catalog | null; error: string | null; loading: boolean; refresh: () => void
}) {
  const zh = useLocaleStore((s) => s.locale) === 'zh-CN'
  const labels: Record<string, string> = {
    'success': translate(zh ? 'zh-CN' : 'en', 'settings.catalogSuccess'),
    'ready': translate(zh ? 'zh-CN' : 'en', 'settings.catalogSuccess'),
    'empty': translate(zh ? 'zh-CN' : 'en', 'settings.catalogEmpty'),
    'no-key': translate(zh ? 'zh-CN' : 'en', 'settings.catalogNoKey'),
    'unauthorized': translate(zh ? 'zh-CN' : 'en', 'settings.catalogUnauthorized'),
    'timeout': translate(zh ? 'zh-CN' : 'en', 'settings.catalogTimeout'),
    'unavailable': translate(zh ? 'zh-CN' : 'en', 'settings.catalogUnavailable'),
    'failed': translate(zh ? 'zh-CN' : 'en', 'settings.catalogFailed'),
    'unconfigured': translate(zh ? 'zh-CN' : 'en', 'settings.catalogUnconfigured'),
    'unprovisioned': translate(zh ? 'zh-CN' : 'en', 'settings.catalogUnprovisioned'),
  }
  return <div className="text-[11.5px] text-ink-500 space-y-1" role="status">
    {loading && <div>{translate(zh ? 'zh-CN' : 'en', 'settings.loadingModelCatalog')}</div>}
    {error && <div className="text-coral-deep">{translate(zh ? 'zh-CN' : 'en', 'settings.catalogFailedManualEntryRemainsAvailableRetainedCatalogIs')}{error}</div>}
    {catalogPlatforms(catalog).map((p) => <div key={p.platform}>
      {p.platform}: {labels[p.status ?? ''] ?? p.status ?? (translate(zh ? 'zh-CN' : 'en', 'settings.unknownStatus'))}
      {p.stale && (translate(zh ? 'zh-CN' : 'en', 'settings.staleSnapshot'))}
      {(p.diagnostic || p.errorCode) && ` · ${p.diagnostic || p.errorCode}`}
    </div>)}
    <button type="button" onClick={refresh} disabled={loading} className="underline disabled:opacity-40">{translate(zh ? 'zh-CN' : 'en', 'settings.refreshModelCatalog')}</button>
  </div>
}
