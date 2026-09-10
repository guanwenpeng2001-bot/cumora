/**
 * Shared model-field editors used by the global Models tab
 * (src/desktop/ModelsTab.tsx) and the agent editor's advanced block
 * (src/components/AgentEditor.tsx): a free-input model field with catalog
 * suggestions, and an ordered fallback-chain editor.
 */
import { useRef, useState } from 'react'
import { Combobox } from '@/components/Combobox'
import { translate, useLocaleStore } from '@/lib/i18n'
import { catalogOptions, catalogPlatforms, catalogSource, type Catalog } from '@/stores/modelCatalog'
import { useT, type MessageKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'

type T = ReturnType<typeof useT>

/** All managed platforms and capabilities; both primary and fallback pickers use this set. */
export function modelSuggestions(catalog: Catalog | null, ...values: string[][]): string[] {
  return [...new Set([
    ...catalogPlatforms(catalog).flatMap((platform) => platform.models ?? []),
    ...(['text', 'image', 'audio', 'embedding'] as const).flatMap((bucket) => catalogOptions(catalog, bucket)),
    ...values.flat(),
  ].filter(Boolean))]
}

/** Model input with catalog suggestions but free text allowed. */
export function ModelInput({ value, onChange, options, placeholder, catalog }: {
  value: string
  onChange: (v: string) => void
  options: string[]
  listId: string
  placeholder?: string
  catalog?: Catalog | null
}) {
  const t = useT()
  return <Combobox
    value={value}
    onValueChange={onChange}
    options={modelSuggestions(catalog ?? null, options, [value]).map((model) => ({
      value: model, label: model, hint: catalogSource(catalog ?? null, model),
    }))}
    ariaLabel={placeholder ?? t('me.models.primary')}
    placeholder={placeholder}
    allowCustom
    className="min-w-0 w-full"
  />
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
  const historical = useRef([...value, ...history])
  const suggestions = modelSuggestions(catalog ?? null, options, [primary ?? ''], historical.current, history, value)
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
        <ModelInput
          value={adding}
          onChange={setAdding}
          options={suggestions}
          listId={listId}
          catalog={catalog}
          placeholder={t('me.models.addFallback' as MessageKey)}
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

/** The same controlled model overrides for creating and editing an agent. */
export function AgentModelFields({
  isByoa, mcEffort, setMcEffort, mcContextWindow, setMcContextWindow,
  mcMaxTokens, setMcMaxTokens, mcThinking, setMcThinking, mcFallbacks,
  setMcFallbacks, catalogText, model, history, catalog,
}: {
  isByoa: boolean
  mcEffort: string
  setMcEffort: (value: string) => void
  mcContextWindow: string
  setMcContextWindow: (value: string) => void
  mcMaxTokens: string
  setMcMaxTokens: (value: string) => void
  mcThinking: boolean | undefined
  setMcThinking: (value: boolean | undefined) => void
  mcFallbacks: string[]
  setMcFallbacks: (value: string[]) => void
  catalogText: string[]
  model: string
  history?: string[]
  catalog: Catalog | null
}) {
  const t = useT()
  const locale = useLocaleStore((s) => s.locale)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const effortOptions = EFFORT_OPTIONS
  return (
    <div className="rounded-[10px] border border-ink-100 bg-paper/60">
      <button
        type="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left"
        aria-expanded={advancedOpen}
      >
        <span className={cn('text-[10px] text-ink-400 transition-transform inline-block', advancedOpen && 'rotate-90')}>▶</span>
        <span className="text-[12.5px] font-semibold text-ink-700">{t('agent.advancedModelSettings')}</span>
        {isByoa && (
          <span className="ml-auto text-[10.5px] text-ink-400 italic">{t('agent.engineManagedTag')}</span>
        )}
      </button>
      {advancedOpen && (
        <div className="px-3.5 pb-3.5 pt-1 space-y-3 border-t border-ink-100">
          {isByoa ? (
            <div className="text-[11.5px] text-ink-500 italic">{t('agent.engineManagedNote')}</div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
                <label className="text-[11.5px] font-semibold text-ink-500">{t('agent.mcEffort')}</label>
                <select
                  value={mcEffort}
                  onChange={(e) => setMcEffort(e.target.value)}
                  className="min-w-0 w-full h-8 px-2 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30"
                  style={{ border: '1px solid var(--ink-100)' }}
                >
                  <option value="">{t('agent.mcFollowGlobal')}</option>
                  {mcEffort && !effortOptions.includes(mcEffort) && <option value={mcEffort} disabled>{mcEffort} — {translate(locale, 'settings.unsupportedChooseAnotherValue')}</option>}
                  {effortOptions.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <label className="text-[11.5px] font-semibold text-ink-500">{t('agent.mcContextWindow')}</label>
                <input
                  type="text" inputMode="numeric"
                  value={mcContextWindow}
                  onChange={(e) => setMcContextWindow(e.target.value)}
                  placeholder={t('agent.mcContextWindowPh')}
                  className="min-w-0 w-full h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
                  style={{ border: '1px solid var(--ink-100)' }}
                />
                <label className="text-[11.5px] font-semibold text-ink-500">{t('agent.mcMaxTokens')}</label>
                <input
                  type="text" inputMode="numeric"
                  value={mcMaxTokens}
                  onChange={(e) => setMcMaxTokens(e.target.value)}
                  placeholder={t('agent.mcMaxTokensPh')}
                  className="min-w-0 w-full h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
                  style={{ border: '1px solid var(--ink-100)' }}
                />
                <label className="text-[11.5px] font-semibold text-ink-500">{t('agent.mcThinking')}</label>
                <select value={mcThinking === undefined ? '' : String(mcThinking)}
                  onChange={(e) => setMcThinking(e.target.value === '' ? undefined : e.target.value === 'true')}
                  className="min-w-0 w-full h-8 px-2 rounded-[8px] text-[12.5px] bg-paper">
                  <option value="">{t('agent.mcFollowGlobal')}</option>
                  <option value="true">{translate(locale, 'settings.enabledSubjectToModelConfiguration')}</option>
                  <option value="false">{translate(locale, 'settings.disabled')}</option>
                </select>
              </div>
              <div>
                <div className="text-[11.5px] font-semibold text-ink-500 mb-1.5">{t('agent.mcFallbacks')}</div>
                <div className="text-[10.5px] text-ink-400 mb-1.5 italic">{t('agent.mcFallbacksHint')}</div>
                <FallbackChainEditor
                  value={mcFallbacks}
                  onChange={setMcFallbacks}
                  options={catalogText}
                  primary={model}
                  history={history}
                  catalog={catalog}
                  listId="agent-mc-fallbacks"
                  t={t}
                />
              </div>
            </>
          )}
        </div>
      )}
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
