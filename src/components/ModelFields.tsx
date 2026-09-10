/**
 * Shared model-field editors used by the global Models tab
 * (src/desktop/ModelsTab.tsx) and the agent editor's advanced block
 * (src/components/AgentEditor.tsx): a free-input model field with catalog
 * suggestions, and an ordered fallback-chain editor.
 */
import { useId, useRef, useState } from 'react'
import { useLocaleStore } from '@/lib/i18n'
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
          m === primary ? (zh ? '当前主模型' : 'Current primary') : null,
          historical.current.includes(m) || history.includes(m) || value.includes(m) ? (zh ? '历史降级链' : 'Fallback history') : null,
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
    throw new Error(`${label}: ${min}–${max} (integer / 整数)`)
  }
  return number
}

export function CatalogStatus({ catalog, error, loading, refresh }: {
  catalog: Catalog | null; error: string | null; loading: boolean; refresh: () => void
}) {
  const zh = useLocaleStore((s) => s.locale) === 'zh-CN'
  const labels: Record<string, string> = zh ? {
    success: '成功', ready: '成功', empty: '成功（无模型）', 'no-key': '未配置密钥',
    unauthorized: '认证失败', timeout: '超时', unavailable: '不可用', failed: '失败',
    unconfigured: '未配置', unprovisioned: '未开通',
  } : {}
  return <div className="text-[11.5px] text-ink-500 space-y-1" role="status">
    {loading && <div>{zh ? '正在加载模型目录…' : 'Loading model catalog…'}</div>}
    {error && <div className="text-coral-deep">{zh ? '目录读取失败；仍可手填模型。保留的目录仅供参考：' : 'Catalog failed; manual entry remains available. Retained catalog is for reference: '}{error}</div>}
    {catalogPlatforms(catalog).map((p) => <div key={p.platform}>
      {p.platform}: {labels[p.status ?? ''] ?? p.status ?? (zh ? '状态未知' : 'Unknown status')}
      {p.stale && (zh ? ' · 旧快照 (stale)' : ' · stale snapshot')}
      {(p.diagnostic || p.errorCode) && ` · ${p.diagnostic || p.errorCode}`}
    </div>)}
    <button type="button" onClick={refresh} disabled={loading} className="underline disabled:opacity-40">{zh ? '刷新模型目录' : 'Refresh model catalog'}</button>
  </div>
}
