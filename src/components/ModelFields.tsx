/**
 * Shared model-field editors used by the global Models tab
 * (src/desktop/ModelsTab.tsx) and the agent editor's advanced block
 * (src/components/AgentEditor.tsx): a free-input model field with catalog
 * suggestions, and an ordered fallback-chain editor.
 */
import { useState } from 'react'
import type { MessageKey, useT } from '@/lib/i18n'

type T = ReturnType<typeof useT>

/** Model input with catalog suggestions but free text allowed. */
export function ModelInput({ value, onChange, options, listId, placeholder }: {
  value: string
  onChange: (v: string) => void
  options: string[]
  listId: string
  placeholder?: string
}) {
  return (
    <>
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
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
export function FallbackChainEditor({ value, onChange, options, listId, t }: {
  value: string[]
  onChange: (v: string[]) => void
  options: string[]
  listId: string
  t: T
}) {
  const [adding, setAdding] = useState('')
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= value.length) return
    const next = [...value]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    onChange(next)
  }
  const add = () => {
    const v = adding.trim()
    if (!v) return
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
        <input
          list={listId}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder={t('me.models.addFallback' as MessageKey)}
          className="flex-1 h-7 px-2 rounded-[7px] text-[12px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
          style={{ border: '1px solid var(--ink-100)' }}
          spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
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
