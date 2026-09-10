/**
 * Shared model-field editors used by the global Models tab
 * (src/desktop/ModelsTab.tsx) and the agent editor's advanced block
 * (src/components/AgentEditor.tsx): a free-input model field with catalog
 * suggestions, and an ordered fallback-chain editor.
 */
import { memo, useMemo, useRef, useState } from 'react'
import { Combobox, type ComboboxOption } from '@/components/Combobox'
import { translate, useLocaleStore } from '@/lib/i18n'
import { modelPlatformLabel } from '@/lib/modelPlatforms'
import { catalogIndex, catalogPlatforms, catalogSource, type Catalog } from '@/stores/modelCatalog'
import { useT, type MessageKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'

type T = ReturnType<typeof useT>

const optionCache = new WeakMap<object, ComboboxOption[]>

/** All managed platforms and capabilities; both primary and fallback pickers use this set. */
export function modelSuggestions(catalog: Catalog | null, ...values: string[][]): string[] {
  const ids = catalogIndex(catalog).ids
  const extras = values.flat().filter(Boolean)
  if (extras.length === 0) return ids
  return [...new Set([...ids, ...extras])]
}

/** Stable Combobox options for a catalog, with extras appended. Cached on catalog identity. */
export function modelComboboxOptions(catalog: Catalog | null, ...values: string[][]): ComboboxOption[] {
  const index = catalogIndex(catalog)
  let base: ComboboxOption[] = []
  if (catalog) {
    const cached = optionCache.get(catalog)
    if (cached) base = cached
    else {
      base = index.ids.map((id) => ({
        value: id,
        label: id,
        hint: index.hintById.get(id) ?? catalogSource(catalog, id),
        group: index.groupById.get(id),
      }))
      optionCache.set(catalog, base)
    }
  }
  const extras = values.flat().filter((id): id is string => !!id && !index.idSet.has(id))
  if (extras.length === 0) return base
  const seen = new Set<string>()
  const extraOptions: ComboboxOption[] = []
  for (const id of extras) {
    if (seen.has(id)) continue
    seen.add(id)
    extraOptions.push({ value: id, label: id, hint: catalogSource(catalog, id) })
  }
  return extraOptions.length ? [...base, ...extraOptions] : base
}

/** Model input with catalog suggestions but free text allowed. */
export const ModelInput = memo(function ModelInput({ value, onChange, options, placeholder, catalog }: {
  value: string
  onChange: (v: string) => void
  options: string[]
  listId: string
  placeholder?: string
  catalog?: Catalog | null
}) {
  const t = useT()
  const comboboxOptions = useMemo(
    () => modelComboboxOptions(catalog ?? null, options, [value]),
    [catalog, options, value],
  )
  return <Combobox
    value={value}
    onValueChange={onChange}
    options={comboboxOptions}
    ariaLabel={placeholder ?? t('me.models.primary')}
    placeholder={placeholder}
    allowCustom
    className="min-w-0 w-full"
  />
})

/** Ordered fallback chain editor: rows with up/down/remove + an add input. */
export const FallbackChainEditor = memo(function FallbackChainEditor({ value, onChange, options, listId, t, primary, history = [], catalog }: {
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
  const suggestions = useMemo(
    () => modelSuggestions(catalog ?? null, options, [primary ?? ''], historical.current, history, value),
    [catalog, options, primary, history, value],
  )
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
})

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

/** Accent for a live/success card. Unknown platforms use the theme sky. */
const PLATFORM_ACCENT: Record<string, string> = {
  openai: '#10a37f',
  'chatgpt-web': '#10a37f',
  kimi: '#1783ff',
  deepseek: '#4d6bfe',
  grok: 'var(--skype)',
  xai: 'var(--skype)',
  anthropic: '#d97757',
  gemini: '#4285f4',
  google: '#4285f4',
  antigravity: '#7c5cfc',
  zhipu: '#0f62fe',
  minimax: '#f15a24',
  composite: 'var(--skype)',
  dashscope: '#ff6a00',
  novita: '#7c3aed',
  orcarouter: 'var(--skype)',
}

function platformAccent(platform: string): string {
  return PLATFORM_ACCENT[platform.trim().toLowerCase()] ?? 'var(--skype)'
}

function catalogStatusOk(status?: string): boolean {
  return status === 'success' || status === 'ready'
}

function catalogStatusLabels(t: T): Record<string, string> {
  return {
    success: t('settings.catalogSuccess'),
    ready: t('settings.catalogSuccess'),
    empty: t('settings.catalogEmpty'),
    'no-key': t('settings.catalogNoKey'),
    unauthorized: t('settings.catalogUnauthorized'),
    timeout: t('settings.catalogTimeout'),
    unavailable: t('settings.catalogUnavailable'),
    failed: t('settings.catalogFailed'),
    unconfigured: t('settings.catalogUnconfigured'),
    unprovisioned: t('settings.catalogUnprovisioned'),
  }
}

function catalogPlatformHint(p: ReturnType<typeof catalogPlatforms>[number], t: T, labels: Record<string, string>): string {
  const status = labels[p.status ?? ''] ?? p.status ?? t('settings.unknownStatus')
  const parts = [status, t('settings.catalogModelCount', { count: p.models?.length ?? 0 })]
  if (p.stale) parts.push(t('settings.catalogStale'))
  const detail = p.diagnostic || p.errorCode
  if (detail) parts.push(String(detail))
  return parts.join(' · ')
}

export function CatalogStatus({ catalog, error, loading, refresh }: {
  catalog: Catalog | null; error: string | null; loading: boolean; refresh: () => void
}) {
  const t = useT()
  const [openId, setOpenId] = useState<string | null>(null)
  const labels = catalogStatusLabels(t)
  const platforms = catalogPlatforms(catalog)
  const opened = platforms.find((p) => p.platform === openId)
  return (
    <div className="space-y-2 text-[11.5px] text-ink-500" role="status">
      {loading && <div>{t('settings.loadingModelCatalog')}</div>}
      {error && <div className="text-coral-deep">{t('settings.catalogFailedManualEntryRemainsAvailableRetainedCatalogIs')}{error}</div>}
      {platforms.length > 0 && (
        <div
          role="group"
          className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(max(8.5rem, calc((100% - 2rem) / 5)), 1fr))' }}
          aria-label={t('settings.catalogPlatforms')}
        >
          {platforms.map((p) => {
            const ok = catalogStatusOk(p.status)
            const label = modelPlatformLabel(p.platform)
            const accent = platformAccent(p.platform)
            const hint = catalogPlatformHint(p, t, labels)
            const open = openId === p.platform
            const initial = (label.trim() || p.platform).charAt(0).toUpperCase() || '?'
            return (
              <button
                key={p.platform}
                type="button"
                title={hint}
                aria-label={`${label}: ${hint}`}
                aria-expanded={open}
                onClick={() => setOpenId((cur) => cur === p.platform ? null : p.platform)}
                className={cn(
                  'relative flex min-w-0 items-center gap-2 rounded-[10px] px-2.5 py-2 text-left transition outline-none focus:ring-2 focus:ring-skype/30',
                  ok ? 'bg-paper hover:bg-sky2-50' : 'bg-cloud text-ink-400 hover:bg-ink-100',
                )}
                style={ok
                  ? { border: `1px solid ${accent}`, color: accent }
                  : { border: '1px solid var(--ink-100)' }}
              >
                <span
                  className={cn('absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full', ok ? 'bg-avail' : 'bg-ink-300')}
                  aria-hidden={true}
                />
                <span
                  className={cn(
                    'grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-[11px] font-bold',
                    ok ? 'text-white' : 'bg-ink-100 text-ink-400',
                  )}
                  style={ok ? { background: accent } : undefined}
                  aria-hidden={true}
                >
                  {initial}
                </span>
                <span className="min-w-0 truncate text-[12px] font-semibold">{label}</span>
              </button>
            )
          })}
        </div>
      )}
      {opened && (
        <div className="rounded-[8px] border border-ink-100 bg-cloud px-2.5 py-2 text-[11px] text-ink-600" role="tooltip">
          <div className="font-semibold text-ink-800">{modelPlatformLabel(opened.platform)}</div>
          <div>{labels[opened.status ?? ''] ?? opened.status ?? t('settings.unknownStatus')}</div>
          <div>{t('settings.catalogModelCount', { count: opened.models?.length ?? 0 })}</div>
          {opened.stale && <div>{t('settings.catalogStale')}</div>}
          {(opened.diagnostic || opened.errorCode) && (
            <div className="text-coral-deep">{opened.diagnostic || opened.errorCode}</div>
          )}
        </div>
      )}
      <button type="button" onClick={refresh} disabled={loading} className="underline disabled:opacity-40">{t('settings.refreshModelCatalog')}</button>
    </div>
  )
}
