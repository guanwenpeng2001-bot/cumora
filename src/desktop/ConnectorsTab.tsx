/**
 * Settings-page "Connectors" tab — the company MCP connector registry.
 * List / create / edit / delete / enable toggle. stdio = command+args+env,
 * http = url+headers. Bound agents apply changes at the next safe turn boundary.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type ApiMcpConnector } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { translate, useT, useLocaleStore } from '@/lib/i18n'
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

function parseKvLines(text: string, kind: 'env' | 'headers') {
  const values: Record<string, string> = Object.create(null)
  const errors: Array<{ line: number; reason: 'format' | 'key' | 'duplicate' | 'value' }> = []
  const seen = new Set<string>()
  text.split('\n').forEach((raw, index) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.trim()) return
    const i = line.indexOf('=')
    if (i <= 0) { errors.push({ line: index + 1, reason: 'format' }); return }
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1)
    const validKey = kind === 'env' ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)
    const identity = kind === 'headers' ? key.toLowerCase() : key
    if (!validKey) errors.push({ line: index + 1, reason: 'key' })
    else if (seen.has(identity)) errors.push({ line: index + 1, reason: 'duplicate' })
    else if ((kind === 'headers' ? /[\x00-\x08\x0a-\x1f\x7f]/ : /[\x00\r]/).test(value)) errors.push({ line: index + 1, reason: 'value' })
    else values[key] = value
    seen.add(identity)
  })
  return { values, errors }
}
function validConnectorForm(form: FormState): boolean {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(form.name.trim()) || form.name.includes('__')) return false
  if (form.type === 'stdio') return !!form.command.trim() && !form.command.includes('\x00') && !form.args.includes('\x00')
  try { const url = new URL(form.url.trim()); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname }
  catch { return false }
}
function kvLines(rec: Record<string, string>): string {
  return Object.entries(rec).map(([k, v]) => `${k}=${v}`).join('\n')
}

const inputCls = 'h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono'
const inputStyle = { border: '1px solid var(--ink-100)' }

export function ConnectorsTab() {
  const t = useT()
  const zh = useLocaleStore((s) => s.locale === 'zh-CN')
  const canWrite = useAuth((s) => ['owner', 'admin'].includes(s.companies.find((c) => c.id === s.activeCompanyId)?.role ?? ''))
  const epoch = useAuth((s) => s.contextEpoch)
  const [items, setItems] = useState<ApiMcpConnector[] | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const active = useRef(new Set<string>())
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const loadSequence = useRef(0)
  const current = () => useAuth.getState().contextEpoch === epoch
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setLoadError(null)
    try {
      const r = await api.getMcpConnectors()
      if (useAuth.getState().contextEpoch === epoch && sequence === loadSequence.current) setItems(r.items)
    } catch (e) {
      if (current() && sequence === loadSequence.current) setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [epoch])
  useEffect(() => {
    setItems(null); setForm(null); setError(null); setNotice(null); setBusy(new Set()); active.current.clear()
    void load()
  }, [load, canWrite])

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (!canWrite || !current() || active.current.has(key)) return
    active.current.add(key)
    setBusy((prev) => new Set(prev).add(key))
    setError(null)
    try {
      await action()
      if (!current()) return
      setNotice(translate(zh ? 'zh-CN' : 'en', 'settings.savedBoundAgentsApplyChangesAtTheNextSafe'))
      await load()
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : String(e)) }
    finally {
      if (current()) {
        active.current.delete(key)
        setBusy((prev) => { const next = new Set(prev); next.delete(key); return next })
      }
    }
  }
  const openEdit = (c: ApiMcpConnector) => {
    if (!canWrite || active.current.has(c.id)) return
    setForm({ id: c.id, name: c.name, type: c.type,
      command: c.command ?? '', args: c.args.join('\n'), env: kvLines(c.env),
      url: c.url ?? '', headers: kvLines(c.headers), enabled: c.enabled })
  }
  const kv = parseKvLines(form?.type === 'http' ? form.headers : form?.env ?? '', form?.type === 'http' ? 'headers' : 'env')
  const valid = !!form && validConnectorForm(form) && kv.errors.length === 0
  const save = () => {
    if (!form || !valid || !canWrite) return
    const draft = form
    void run(draft.id ?? 'save', async () => {
      const payload = {
        name: draft.name.trim(), type: draft.type,
        command: draft.type === 'stdio' ? draft.command.trim() : null,
        args: draft.type === 'stdio' ? draft.args.split('\n').map((s) => s.trim()).filter(Boolean) : [],
        env: draft.type === 'stdio' ? kv.values : {},
        url: draft.type === 'http' ? draft.url.trim() : null,
        headers: draft.type === 'http' ? kv.values : {}, enabled: draft.enabled,
      }
      await (draft.id ? api.updateMcpConnector(draft.id, payload) : api.createMcpConnector(payload))
      if (current()) setForm(null)
    })
  }
  const formBusy = !!form && busy.has(form.id ?? 'save')

  return (
    <div className="space-y-6">
      <div className="text-[11.5px] text-ink-500 italic max-w-2xl">{translate(zh ? 'zh-CN' : 'en', 'settings.companyMcpConnectorsDisablingGloballyAffectsAllBoundAgents')}</div>
      {!canWrite && <div className="text-[11.5px] text-ink-500">{translate(zh ? 'zh-CN' : 'en', 'settings.readOnlySummaryChangesRequireCompanyOwnerAdminPermission')}</div>}
      {notice && <div role="status" className="text-[11.5px] text-skype-deep">{notice}</div>}
      {error && <div className="text-[11.5px] text-coral-deep">{error}</div>}

      <div className="bg-cloud rounded-[14px] divide-y divide-ink-100" style={{ border: '1px solid var(--ink-100)' }}>
        {loadError && <div role="alert" className="p-4 text-[12px] text-coral-deep">{loadError} <button type="button" className="underline" onClick={() => void load()}>{translate(zh ? 'zh-CN' : 'en', 'ship.retry')}</button></div>}
        {!loadError && items === null && <div className="p-4 text-[12px] text-ink-400 italic">{t('common.loading')}</div>}
        {!loadError && items?.length === 0 && <div className="p-4 text-[12px] text-ink-400 italic">{t('me.mcp.empty')}</div>}
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
            <span className="text-[11px] text-ink-500">{c.enabled ? (translate(zh ? 'zh-CN' : 'en', 'settings.globallyEnabled')) : (translate(zh ? 'zh-CN' : 'en', 'settings.globallyDisabled'))}</span>
            {canWrite && <><button type="button" disabled={busy.has(c.id) || form?.id === c.id} aria-busy={busy.has(c.id)}
              aria-label={c.enabled ? (translate(zh ? 'zh-CN' : 'en', 'settings.disableGlobally')) : (translate(zh ? 'zh-CN' : 'en', 'settings.enableGlobally'))}
              onClick={() => void run(c.id, () => api.updateMcpConnector(c.id, { ...c, enabled: !c.enabled }))}
              className={cn('w-9 h-5 rounded-full relative shrink-0 transition-colors', c.enabled ? 'bg-skype' : 'bg-ink-200')}
              title={c.enabled ? (translate(zh ? 'zh-CN' : 'en', 'settings.disableGlobally')) : (translate(zh ? 'zh-CN' : 'en', 'settings.enableGlobally'))}>
              <span className={cn('absolute w-4 h-4 bg-white rounded-full top-0.5 transition-all', c.enabled ? 'left-[18px]' : 'left-0.5')}
                style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
            </button>
            <button type="button" disabled={formBusy || busy.has(c.id)} onClick={() => openEdit(c)}
              className="h-6 px-2.5 rounded-[6px] text-[11px] font-semibold text-ink-500 hover:bg-sky2-50 hover:text-skype-deep transition shrink-0">
              {t('me.mcp.edit')}
            </button>
            <button type="button" disabled={busy.has(c.id) || form?.id === c.id}
              onClick={() => void run(c.id, () => api.deleteMcpConnector(c.id))}
              className="w-6 h-6 rounded-md grid place-items-center text-ink-400 hover:bg-coral-soft hover:text-coral-deep transition shrink-0"
              aria-label={t('me.mcp.delete')}>×</button></>}
          </div>
        ))}
      </div>

      {canWrite && (form === null ? (
        <button type="button" onClick={() => setForm(EMPTY_FORM)}
          className="h-8 px-4 rounded-full text-[12.5px] font-semibold text-white"
          style={{ background: 'var(--skype)', boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)' }}>
          {t('me.mcp.add')}
        </button>
      ) : (
        <fieldset disabled={formBusy} className="bg-cloud rounded-[14px] p-4 space-y-3" style={{ border: '1px solid var(--ink-100)' }}>
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
          {kv.errors.map((e) => <div key={e.line} role="alert" className="text-[11px] text-coral-deep">
            {form.type === 'stdio' ? 'env' : 'header'} {translate(zh ? 'zh-CN' : 'en', 'settings.line')}{e.line}{translate(zh ? 'zh-CN' : 'en', 'settings.label')}
            {({ format: translate(zh ? 'zh-CN' : 'en', 'settings.useKeyValue'), key: translate(zh ? 'zh-CN' : 'en', 'settings.invalidKey'), duplicate: translate(zh ? 'zh-CN' : 'en', 'settings.duplicateKey'), value: translate(zh ? 'zh-CN' : 'en', 'settings.invalidControlCharacterInValue') })[e.reason]}
          </div>)}
          {!validConnectorForm(form) && <div role="alert" className="text-[11px] text-coral-deep">{translate(zh ? 'zh-CN' : 'en', 'settings.name164LowercaseLettersDigitsOrStartingWith')}</div>}
          <div className="flex items-center gap-2.5 pt-1">
            <button type="button" onClick={save} disabled={formBusy || !valid}
              className="h-8 px-4 rounded-full text-[12.5px] font-semibold text-white disabled:cursor-not-allowed"
              style={{ background: form.name.trim() ? 'var(--skype)' : 'var(--ink-200)' }}>
              {formBusy ? t('me.mcp.saving') : t('me.mcp.save')}
            </button>
            <button type="button" onClick={() => setForm(null)}
              className="h-8 px-3 rounded-full text-[12px] font-semibold text-ink-500 hover:bg-sky2-50 transition">
              {t('me.mcp.cancel')}
            </button>
          </div>
        </fieldset>
      ))}
    </div>
  )
}
