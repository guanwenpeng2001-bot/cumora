/**
 * Settings-page "Connectors" tab — the company MCP connector registry.
 * List / create / edit / delete / enable toggle. stdio = command+args+env,
 * http = url+headers. Phase 5 wires these into BYOA engines via the daemon;
 * managed agents get MCP in phase 6 (noted in the UI).
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type ApiMcpConnector } from '@/api/client'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface FormState {
  id: string | null
  name: string
  type: 'stdio' | 'http'
  command: string
  args: string
  env: string
  url: string
  headers: string
  enabled: boolean
}

const EMPTY_FORM: FormState = {
  id: null, name: '', type: 'stdio', command: '', args: '', env: '', url: '', headers: '', enabled: true,
}

/** KEY=VALUE per line → record. Blank/garbage lines are skipped. */
function parseKvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
function kvLines(rec: Record<string, string>): string {
  return Object.entries(rec).map(([k, v]) => `${k}=${v}`).join('\n')
}

const inputCls = 'h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono'
const inputStyle = { border: '1px solid var(--ink-100)' }

export function ConnectorsTab() {
  const t = useT()
  const [items, setItems] = useState<ApiMcpConnector[] | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void api.getMcpConnectors().then((r) => setItems(r.items)).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(load, [load])

  const openEdit = (c: ApiMcpConnector) => setForm({
    id: c.id, name: c.name, type: c.type,
    command: c.command ?? '', args: c.args.join('\n'), env: kvLines(c.env),
    url: c.url ?? '', headers: kvLines(c.headers), enabled: c.enabled,
  })

  const save = () => {
    if (!form) return
    setBusy('save')
    setError(null)
    const payload = {
      name: form.name.trim(), type: form.type,
      command: form.type === 'stdio' ? form.command.trim() : null,
      args: form.type === 'stdio' ? form.args.split('\n').map((s) => s.trim()).filter(Boolean) : [],
      env: form.type === 'stdio' ? parseKvLines(form.env) : {},
      url: form.type === 'http' ? form.url.trim() : null,
      headers: form.type === 'http' ? parseKvLines(form.headers) : {},
      enabled: form.enabled,
    }
    void (form.id ? api.updateMcpConnector(form.id, payload) : api.createMcpConnector(payload))
      .then(() => { setForm(null); load() })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }

  return (
    <div className="space-y-6">
      <div className="text-[11.5px] text-ink-500 italic max-w-2xl">{t('me.mcp.intro')}</div>
      {error && <div className="text-[11.5px] text-coral-deep">{error}</div>}

      <div className="bg-cloud rounded-[14px] divide-y divide-ink-100" style={{ border: '1px solid var(--ink-100)' }}>
        {items === null && <div className="p-4 text-[12px] text-ink-400 italic">{t('common.loading')}</div>}
        {items?.length === 0 && <div className="p-4 text-[12px] text-ink-400 italic">{t('me.mcp.empty')}</div>}
        {items?.map((c) => (
          <div key={c.id} className="flex items-center gap-3 p-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[13px] text-ink-900 truncate">{c.name}</span>
                <span className="text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky2-50 text-skype-deep shrink-0">{c.type}</span>
              </div>
              <div className="font-mono text-[11px] text-ink-500 mt-0.5 truncate">
                {c.type === 'stdio' ? [c.command, ...c.args].join(' ') : c.url}
              </div>
            </div>
            <button type="button" onClick={() => {
              setBusy(`toggle-${c.id}`)
              void api.updateMcpConnector(c.id, { ...c, enabled: !c.enabled })
                .then(load).catch((e) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(null))
            }}
              className={cn('w-9 h-5 rounded-full relative shrink-0 transition-colors', c.enabled ? 'bg-skype' : 'bg-ink-200')}
              title={c.enabled ? t('me.mcp.disable') : t('me.mcp.enable')}>
              <span className={cn('absolute w-4 h-4 bg-white rounded-full top-0.5 transition-all', c.enabled ? 'left-[18px]' : 'left-0.5')}
                style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
            </button>
            <button type="button" onClick={() => openEdit(c)}
              className="h-6 px-2.5 rounded-[6px] text-[11px] font-semibold text-ink-500 hover:bg-sky2-50 hover:text-skype-deep transition shrink-0">
              {t('me.mcp.edit')}
            </button>
            <button type="button" disabled={busy === `del-${c.id}`}
              onClick={() => {
                setBusy(`del-${c.id}`)
                void api.deleteMcpConnector(c.id).then(load)
                  .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(null))
              }}
              className="w-6 h-6 rounded-md grid place-items-center text-ink-400 hover:bg-coral-soft hover:text-coral-deep transition shrink-0"
              aria-label={t('me.mcp.delete')}>×</button>
          </div>
        ))}
      </div>

      {form === null ? (
        <button type="button" onClick={() => setForm(EMPTY_FORM)}
          className="h-8 px-4 rounded-full text-[12.5px] font-semibold text-white"
          style={{ background: 'var(--skype)', boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)' }}>
          {t('me.mcp.add')}
        </button>
      ) : (
        <div className="bg-cloud rounded-[14px] p-4 space-y-3" style={{ border: '1px solid var(--ink-100)' }}>
          <div className="font-semibold text-[13px] text-ink-900">
            {form.id ? t('me.mcp.editTitle') : t('me.mcp.addTitle')}
          </div>
          <div className="grid grid-cols-[96px_1fr] items-center gap-x-3 gap-y-2.5">
            <label className="text-[11.5px] font-semibold text-ink-500">{t('me.mcp.name')}</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputCls} style={inputStyle} placeholder="my-connector" spellCheck={false} />
            <label className="text-[11.5px] font-semibold text-ink-500">{t('me.mcp.type')}</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'stdio' | 'http' })}
              className="h-8 px-2 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30" style={inputStyle}>
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
            {form.type === 'stdio' ? (
              <>
                <label className="text-[11.5px] font-semibold text-ink-500">{t('me.mcp.command')}</label>
                <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })}
                  className={inputCls} style={inputStyle} placeholder="npx" spellCheck={false} />
                <label className="text-[11.5px] font-semibold text-ink-500 self-start pt-1">{t('me.mcp.args')}</label>
                <textarea value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })}
                  rows={2} className="p-2.5 rounded-[8px] text-[12px] font-mono text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30"
                  style={inputStyle} spellCheck={false} placeholder={'-y\n@mcp/server-fs'} />
                <label className="text-[11.5px] font-semibold text-ink-500 self-start pt-1">{t('me.mcp.env')}</label>
                <textarea value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })}
                  rows={2} className="p-2.5 rounded-[8px] text-[12px] font-mono text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30"
                  style={inputStyle} spellCheck={false} placeholder="KEY=VALUE" />
              </>
            ) : (
              <>
                <label className="text-[11.5px] font-semibold text-ink-500">{t('me.mcp.url')}</label>
                <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })}
                  className={inputCls} style={inputStyle} placeholder="https://mcp.example.com/sse" spellCheck={false} />
                <label className="text-[11.5px] font-semibold text-ink-500 self-start pt-1">{t('me.mcp.headers')}</label>
                <textarea value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })}
                  rows={2} className="p-2.5 rounded-[8px] text-[12px] font-mono text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30"
                  style={inputStyle} spellCheck={false} placeholder="Authorization=Bearer …" />
              </>
            )}
          </div>
          <div className="flex items-center gap-2.5 pt-1">
            <button type="button" onClick={save} disabled={busy === 'save' || !form.name.trim()}
              className="h-8 px-4 rounded-full text-[12.5px] font-semibold text-white disabled:cursor-not-allowed"
              style={{ background: form.name.trim() ? 'var(--skype)' : 'var(--ink-200)' }}>
              {busy === 'save' ? t('me.mcp.saving') : t('me.mcp.save')}
            </button>
            <button type="button" onClick={() => setForm(null)}
              className="h-8 px-3 rounded-full text-[12px] font-semibold text-ink-500 hover:bg-sky2-50 transition">
              {t('me.mcp.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
