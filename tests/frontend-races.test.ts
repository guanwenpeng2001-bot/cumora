import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { create } from 'zustand'

const require = createRequire(import.meta.url)
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
function evaluate(code: string, dependencies: Record<string, unknown> = {}, globals = {}) {
  const exports: Record<string, any> = {}
  runInNewContext(ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    exports, require: (id: string) => dependencies[id] ?? require(id),
    console: { warn() {}, info() {} }, setTimeout, clearTimeout, AbortController,
    window: { setTimeout, clearTimeout }, ...globals,
  })
  return exports
}
function deferred<T = any>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function context() {
  const useAuth = create(() => ({ contextEpoch: 1, token: 'A', activeCompanyId: 'A', user: { id: 'me' } }))
  const guard = evaluate(source('stores/auth.ts').slice(source('stores/auth.ts').indexOf('export async function commitIfContextCurrent')), {}, { useAuth })
  const useApp = create(() => ({ selectedConversationId: 'room', view: 'conversations',
    selectConversation: (id: string | null) => useApp.setState({ selectedConversationId: id as string }) }))
  const api: Record<string, any> = {}
  const listeners: Array<(event: any) => void> = []
  class ApiError extends Error { constructor(message: string, public status: number) { super(message) } }
  const dependencies = {
    '@/stores/auth': { useAuth, ...guard, getMeId: () => useAuth.getState().user.id },
    '@/stores/app': { useApp },
    '@/api/client': { api, ApiError, ws: { connect() {}, on: (fn: any) => listeners.push(fn) } },
    '@/lib/modelPlatforms': { modelPlatformLabel: (s: string) => s },
  }
  const load = (path: string, extra = {}, globals = {}) => evaluate(source(path), { ...dependencies, ...extra }, globals)
  const switchContext = () => useAuth.setState(s => ({ contextEpoch: s.contextEpoch + 1, token: 'B', activeCompanyId: 'B' }))
  return { useAuth, useApp, api, guard, load, switchContext, listeners }
}

test('context guard rejects stale success, errors and finally, including token-only changes', async () => {
  const c = context()
  for (const failure of [false, true]) {
    const request = deferred()
    let commits = 0
    const result = c.guard.commitIfContextCurrent(() => request.promise, () => commits++, () => commits++, () => commits++)
    c.useAuth.setState({ token: `${c.useAuth.getState().token}:changed` })
    if (failure) request.reject(new Error('old'))
    else request.resolve('old')
    assert.equal(await result, false)
    assert.equal(commits, 0)
  }
})

for (const operation of ['loadConversation', 'reloadConversation', 'loadOlder']) {
  for (const failure of [false, true]) {
    test(`messages ${operation}: late ${failure ? 'failure' : 'success'} cannot mutate a new epoch`, async () => {
      const c = context(), request = deferred()
      c.api.getMessages = () => request.promise
      const { useMessages, bootMessagesStream } = c.load('stores/messages.ts')
      if (operation === 'loadOlder') useMessages.setState({ loaded: new Set(['room']),
        hasMoreOlder: { room: true }, byConvo: { room: [{ id: 'tail', sequence: 10 }] } })
      const result = useMessages.getState()[operation]('room')
      c.switchContext(); bootMessagesStream()
      const before = JSON.stringify(useMessages.getState())
      if (failure) request.reject(new Error('404 not found'))
      else request.resolve([{ id: 'old', conversationId: 'room', authorId: 'other', sequence: 9, kind: 'text', body: 'old', at: '10:00' }])
      await result
      assert.equal(JSON.stringify(useMessages.getState()), before)
      assert.equal(c.useApp.getState().selectedConversationId, 'room')
      assert.equal(useMessages.getState().loadingOlder.size, 0)
    })
  }
}

test('send receipt and failure cannot restore optimistic rows after an identity switch', async () => {
  for (const failure of [false, true]) {
    const c = context(), request = deferred()
    c.api.sendMessage = () => request.promise
    const { useMessages, sendUserMessage, bootMessagesStream } = c.load('stores/messages.ts')
    const result = sendUserMessage('room', 'hello', null, null, 'client-1')
    assert.equal(useMessages.getState().byConvo.room.length, 1)
    c.switchContext(); bootMessagesStream()
    if (failure) request.reject(new Error('offline'))
    else request.resolve({ id: 'server-1', sequence: 12 })
    await result
    assert.equal(Object.keys(useMessages.getState().byConvo).length, 0)
  }
})

test('computers single flight is per context; post-write refresh starts a new authoritative GET', async () => {
  const c = context(), requests: ReturnType<typeof deferred>[] = []
  c.api.getComputers = () => { const d = deferred(); requests.push(d); return d.promise }
  const { useComputers } = c.load('stores/computers.ts')
  const old = useComputers.getState().load()
  const duplicate = useComputers.getState().refresh()
  assert.equal(requests.length, 1)
  c.switchContext()
  const next = useComputers.getState().load()
  assert.equal(requests.length, 2)
  requests[0].resolve([{ id: 'A' }]); await old; await duplicate
  assert.equal(useComputers.getState().loaded, false)
  const saved = useComputers.getState().refresh(true)
  assert.equal(requests.length, 3)
  requests[2].resolve([{ id: 'B', name: 'new' }]); await saved
  requests[1].resolve([{ id: 'B', name: 'old' }]); await next
  assert.equal(useComputers.getState().byId.B.name, 'new')
})

test('model catalog force refresh invalidates older normal success and failure', async () => {
  for (const failOld of [false, true]) {
    const c = context(), requests: ReturnType<typeof deferred>[] = []
    c.api.getAvailableModels = () => { const d = deferred(); requests.push(d); return d.promise }
    const { useModelCatalogStore: store } = c.load('stores/modelCatalog.ts')
    const old = store.getState().ensure('scope')
    const fresh = store.getState().ensure('scope', { refresh: true })
    requests[1].resolve({ text: ['new'] }); await fresh
    if (failOld) requests[0].reject(new Error('late failure'))
    else requests[0].resolve({ text: ['old'] })
    await old
    assert.equal(store.getState().catalog.text[0], 'new')
    assert.equal(store.getState().error, null)
  }
})

test('outbox repeats do not inflate unread; late older sequence cannot regress preview', async () => {
  const c = context()
  c.api.getConversations = async () => []
  const rowHelpers = evaluate(source('lib/conversationRow.ts'))
  const { useConversations: store } = c.load('stores/conversations.ts', {
    '@/lib/conversationRow': rowHelpers,
    '@/stores/messages': { useMessages: { getState: () => ({ loading: new Set(), loaded: new Set(), byConvo: {} }) } },
    '@/stores/participants': { useParticipants: { getState: () => ({ byId: {} }) } },
  }, { setTimeout: () => 1 })
  store.setState({ list: [{ id: 'room', lastMessageId: 'm1', lastSequence: 1, unread: 0 }] })
  const message = { id: 'm2', conversationId: 'room', authorId: 'other', kind: 'text', body: 'new', sequence: 2, at: '2026-09-11T10:00:00Z' }
  store.getState().applyIncomingMessage('room', message, { read: false, deliveryId: 'd2' })
  store.getState().applyIncomingMessage('room', message, { read: false, deliveryId: 'd2' })
  store.getState().applyIncomingMessage('room', { ...message, id: 'm1', sequence: 1 }, { read: false })
  assert.equal(store.getState().list[0].unread, 1)
  assert.equal(store.getState().list[0].lastMessageId, 'm2')
  assert.equal(store.getState().list[0].lastSequence, 2)
})

test('preferences serialize full writes, roll back failed fields and keep later edits', async () => {
  const c = context(), writes: Array<{ input: any; d: ReturnType<typeof deferred> }> = []
  c.api.getPreferences = async () => ({ stable: true })
  c.api.getAllAutonomy = async () => []
  c.api.putPreferences = (input: any) => { const d = deferred(); writes.push({ input, d }); return d.promise }
  const { usePrefs: store } = c.load('stores/preferences.ts')
  await store.getState().load()
  const first = store.getState().setPref('failed', 1)
  const second = store.getState().setPref('saved', 2)
  await tick(); assert.equal(writes.length, 1)
  writes[0].d.reject(new Error('offline')); await first; await tick()
  assert.equal(writes.length, 2)
  assert.equal(writes[1].input.failed, undefined)
  assert.equal(writes[1].input.saved, 2)
  writes[1].d.resolve({ ok: true }); await second
  assert.equal(store.getState().prefs.failed, undefined)
  assert.equal(store.getState().prefs.saved, 2)
})

test('autonomy commits server normalization and old preference writes cannot cross epochs', async () => {
  const c = context()
  c.api.putAutonomy = async () => ({ ok: true, threshold: 1 })
  const { usePrefs: store } = c.load('stores/preferences.ts')
  await store.getState().setAutonomy('agent', 2)
  assert.equal(store.getState().autonomy.agent.threshold, 1)
  c.api.getPreferences = async () => ({})
  const d = deferred(); c.api.putPreferences = () => d.promise
  const old = store.getState().setPref('old', true); await tick()
  c.switchContext(); d.resolve({ ok: true }); await old
  assert.equal(Object.keys(store.getState().prefs).length, 0)
  assert.equal(Object.keys(store.getState().autonomy).length, 0)
})

test('WS generation rejects old tickets and old socket messages, retaining the current single flight', async () => {
  const c = context(), requests: ReturnType<typeof deferred>[] = [], sockets: FakeSocket[] = []
  class FakeSocket {
    static OPEN = 1; static CONNECTING = 0
    readyState = 0
    onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void
    constructor(public url: string) { sockets.push(this) }
    close() { this.readyState = 3; this.onclose?.() }
  }
  const client = source('api/client.ts')
  const { WsClient } = evaluate(client.slice(client.indexOf('export class WsClient')), {}, {
    useAuth: c.useAuth, getAuthToken: () => c.useAuth.getState().token,
    API: '/api', wsOrigin: () => 'ws://test', WebSocket: FakeSocket,
    fetch: () => { const d = deferred(); requests.push(d); return d.promise },
  })
  const ws = new WsClient(), events: any[] = []
  ws.on((event: any) => events.push(event))
  const old = ws.connect(); c.switchContext(); ws.reconnect()
  const fresh = ws.connect()
  assert.equal(requests.length, 2)
  requests[0].resolve({ ok: true, json: async () => ({ ticket: 'A' }) }); await old
  assert.equal(ws.connect(), fresh)
  assert.equal(sockets.length, 0)
  requests[1].resolve({ ok: true, json: async () => ({ ticket: 'B' }) }); await fresh
  assert.match(sockets[0].url, /ticket|t=B/)
  sockets[0].readyState = 1; sockets[0].onopen?.(); await ws.connect()
  sockets[0].onmessage?.({ data: '{"type":"hello"}' }); assert.equal(events.length, 1)
  ws.reconnect(); sockets[0].onmessage?.({ data: '{"type":"hello"}' })
  assert.equal(events.length, 1)
  ws.close(); requests[2].resolve({ ok: true, json: async () => ({ ticket: 'closed' }) }); await tick()
  assert.equal(sockets.length, 1)
})

test('responsive navigation maps each library section in both directions without clearing selections', () => {
  const { useApp: store } = evaluate(source('stores/app.ts'), {
    './composerDrafts': { applyDraftUpdate() {} },
    './composerDraftsStorage': { loadComposerDrafts: () => ({}), saveComposerDrafts() {} },
  })
  for (const section of ['documents', 'boards', 'calendar']) {
    store.setState({ openDocumentId: 'doc', openBoardId: 'board', openBoardCardId: 'card',
      openCalendarEventId: 'event', selectedConversationId: 'room',
      calendarEditing: { mode: 'edit', event: { id: 'event' } } })
    store.getState().setView(section)
    store.getState().mapLayout(true)
    assert.equal(store.getState().view, 'library')
    assert.equal(store.getState().librarySection, section)
    store.getState().mapLayout(false)
    assert.equal(store.getState().view, section)
    assert.equal(store.getState().openDocumentId, 'doc')
    assert.equal(store.getState().openBoardId, 'board')
    assert.equal(store.getState().openBoardCardId, 'card')
    assert.equal(store.getState().openCalendarEventId, 'event')
    assert.equal(store.getState().calendarEditing.event.id, 'event')
    assert.equal(store.getState().selectedConversationId, 'room')
  }
  store.getState().setView('library')
  store.getState().setLibrarySection('boards')
  store.getState().mapLayout(false)
  assert.equal(store.getState().view, 'boards')
})

test('action and muted text tokens meet 4.5:1 contrast on light and dark surfaces', () => {
  const css = source('styles/globals.css')
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(offset => {
      const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  const ratio = (a: string, b: string) => {
    const first = luminance(a), second = luminance(b)
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
  }
  const tokens = (name: string) => [...css.matchAll(new RegExp(`--${name}: (#[0-9a-fA-F]{6})`, 'g'))].map(m => m[1])
  const backgrounds = tokens('action-bg'), foregrounds = tokens('action-fg'), muted = tokens('text-muted')
  assert.equal(backgrounds.length, 2)
  for (let i = 0; i < 2; i++) assert.ok(ratio(backgrounds[i], foregrounds[i]) >= 4.5)
  assert.ok(ratio(muted[0], '#FAFCFE') >= 4.5)
  assert.ok(ratio(muted[1], '#21252B') >= 4.5)
})
