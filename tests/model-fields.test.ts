import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the real TSX with a small hook host; no DOM, network or database required.
function harness(initialSlots: unknown[] = [], mocks: Record<string, unknown> = {}) {
  const body = {}
  const slots: unknown[] = [...initialSlots]
  let cursor = 0
  const react = {
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (next: unknown) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
      }]
    },
    useRef: (current: unknown) => ({ current }),
    useId: () => 'model-picker',
    useMemo: (compute: () => unknown) => compute(),
    useEffect: () => {},
    useLayoutEffect: () => {},
  }
  const require = createRequire(import.meta.url)
  const cache = new Map<string, Record<string, any>>()
  const load = (file: string): Record<string, any> => {
    if (cache.has(file)) return cache.get(file)!
    const module = { exports: {} }
    cache.set(file, module.exports)
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
    } }).outputText
    vm.runInNewContext(code, {
      module, exports: module.exports, queueMicrotask: () => {}, document: { body },
      require: (id: string) => {
        if (id in mocks) return mocks[id]
        if (id === 'react') return react
        if (id === 'react-dom') return { createPortal: (child: unknown) => child }
        if (id === '@/lib/i18n') return { useT: () => (key: string) => key,
          translate: (_locale: string, key: string) => key,
          useLocaleStore: (select: (s: unknown) => unknown) => select({ locale: 'en' }) }
        if (id === '@/lib/utils') return { cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }
        if (id === '@/api/client' || id === '@/stores/auth') return {}
        if (id.startsWith('@/')) return load(`src/${id.slice(2)}${id.includes('components/') ? '.tsx' : '.ts'}`)
        return require(id)
      },
    })
    return module.exports
  }
  return { body, load, render: (component: (props: any) => any, props: any) => {
    cursor = 0
    return component(props)
  } }
}
function elements(node: any): any[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(elements)
  return [node, ...elements(node.props?.children)]
}
const catalog = {
  text: ['kimi-k3', 'deepseek-chat', 'gpt-5', 'grok-4', 'local-only'],
  image: ['gpt-image'], audio: ['whisper'], embedding: ['embed'],
  platforms: Object.fromEntries([
    ['kimi', ['kimi-k3']], ['deepseek', ['deepseek-chat']],
    ['openai', ['gpt-5', 'gpt-image', 'whisper', 'embed']], ['grok', ['grok-4']],
  ].map(([platform, models]) => [platform, { status: 'success', models }])),
  byoa: [{ models: ['local-only'] }],
}

test('primary and fallback offer the same full managed catalog, current and history', () => {
  const h = harness()
  const { ModelInput, FallbackChainEditor, modelSuggestions } = h.load('src/components/ModelFields.tsx')
  const options = modelSuggestions(catalog, ['retired-primary', 'retired-fallback'])
  const primary = h.render(ModelInput, { value: 'kimi-k3', options, catalog, listId: 'brain' })
  const fallbackTree = h.render(FallbackChainEditor, {
    value: ['retired-fallback'], options, catalog, primary: 'kimi-k3', listId: 'fallback', t: (k: string) => k,
  })
  const fallbackInput = elements(fallbackTree).find((e) => e.type === ModelInput)
  const fallback = h.render(ModelInput, fallbackInput.props)
  assert.deepEqual(primary.props.options, fallback.props.options)
  assert.equal(primary.props.allowCustom, true)
  const ids = Array.from(primary.props.options, (o: any) => o.value)
  for (const id of ['kimi-k3', 'deepseek-chat', 'gpt-5', 'grok-4', 'gpt-image', 'whisper', 'embed', 'retired-primary', 'retired-fallback']) {
    assert.ok(ids.includes(id), id)
  }
  assert.ok(!ids.includes('local-only'))
  assert.match(primary.props.options.find((o: any) => o.value === 'gpt-5').hint, /openai/)
})

test('opening with a current value shows all platforms; only typing filters; reopening resets', () => {
  const h = harness()
  const { Combobox } = h.load('src/components/Combobox.tsx')
  const props = { value: 'kimi-k3', options: ['kimi-k3', 'deepseek-chat', 'gpt-5', 'grok-4'].map(value => ({ value, label: value })) }
  const render = () => h.render(Combobox, props)
  const input = (tree: any) => elements(tree).find((e) => e.props?.role === 'combobox')
  const options = (tree: any) => elements(tree).filter((e) => e.props?.role === 'option')
  input(render()).props.onFocus()
  assert.equal(options(render()).length, 4)
  input(render()).props.onChange({ target: { value: 'deepseek' } })
  assert.equal(options(render()).length, 1)
  input(render()).props.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault() {}, stopPropagation() {} })
  input(render()).props.onFocus()
  assert.equal(options(render()).length, 4)
})

test('empty or failed catalog allows committing an arbitrary model and shows platform status', () => {
  const h = harness()
  const { ModelInput, CatalogStatus } = h.load('src/components/ModelFields.tsx')
  let selected = ''
  const picker = h.render(ModelInput, { value: '', options: [], catalog: null, listId: 'audio', onChange: (v: string) => { selected = v } })
  const render = () => h.render(picker.type, picker.props)
  let tree = render()
  elements(tree).find((e) => e.props?.role === 'combobox').props.onFocus()
  tree = render()
  elements(tree).find((e) => e.props?.role === 'combobox').props.onChange({ target: { value: 'custom-model' } })
  tree = render()
  elements(tree).find((e) => e.props?.role === 'option').props.onClick()
  assert.equal(selected, 'custom-model')
  const status = h.render(CatalogStatus, { catalog: { platforms: { grok: { status: 'timeout', stale: true } } }, error: 'offline', loading: false, refresh() {} })
  const text = JSON.stringify(status)
  assert.match(text, /grok/)
  assert.match(text, /catalogTimeout/)
  assert.match(text, /offline/)
})

test('ModelsTab wires all six roles to the full catalog and keeps embedding without fallback', () => {
  const settings = {
    brain_model: 'kimi-k3', brain_fallback_models: 'old-brain',
    support_model: 'deepseek-chat', support_fallback_models: 'old-support',
    compaction_model: 'gpt-5', compaction_fallback_models: 'old-compaction',
    image_model: 'gpt-image', image_fallback_models: 'old-image',
    audio_model: 'whisper', audio_fallback_models: 'old-audio', embed_model: 'embed',
  }
  const authState = { user: { isAdmin: true }, contextEpoch: 1, activeCompanyId: 'company' }
  const useAuth = Object.assign((select: (s: unknown) => unknown) => select(authState), { getState: () => authState })
  const h = harness([settings, settings], {
    '@/stores/auth': { useAuth },
    './RuntimeSettingsPanel': {},
  })
  const store = h.load('src/stores/modelCatalog.ts')
  store.useModelCatalog = () => ({ catalog, error: null, loading: false, refresh() {} })
  const { ModelsTab } = h.load('src/desktop/ModelsTab.tsx')
  const page = h.render(ModelsTab, {})
  const tree = h.render(page.type, page.props)
  const { ModelInput, FallbackChainEditor } = h.load('src/components/ModelFields.tsx')
  const primaries = elements(tree).filter((e) => e.type === ModelInput)
  const fallbacks = elements(tree).filter((e) => e.type === FallbackChainEditor)
  assert.equal(primaries.length, 6)
  assert.equal(fallbacks.length, 5)
  for (const primary of primaries) {
    for (const id of ['kimi-k3', 'deepseek-chat', 'gpt-5', 'grok-4', 'gpt-image', 'whisper', 'embed']) {
      assert.ok(primary.props.options.includes(id), `${primary.props.listId}: ${id}`)
    }
    const fallback = fallbacks.find((e) => e.props.listId === primary.props.listId)
    if (primary.props.listId === 'models-catalog-embed') assert.equal(fallback, undefined)
    else {
      assert.ok(fallback)
      assert.deepEqual(primary.props.options, fallback.props.options)
      assert.ok(primary.props.options.includes(fallback.props.value[0]))
    }
  }
})

// Execute selected handlers/effects from the real component in isolated API hosts.
function sourceFunction(file: string, name: string, scope: Record<string, unknown>) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression: string | undefined
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) expression = node.initializer.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(expression, name)
  const code = ts.transpileModule(`result = (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const context = { ...scope, result: undefined }
  vm.runInNewContext(code, context)
  return context.result as unknown as (...args: any[]) => any
}

test('portal menu targets body and consumes only an open-menu Escape; Tab dismisses', () => {
  let portalTarget: unknown
  const h = harness([], { 'react-dom': { createPortal: (child: unknown, container: unknown) => { portalTarget = container; return child } } })
  const { Combobox } = h.load('src/components/Combobox.tsx')
  const render = () => h.render(Combobox, { value: 'one', options: [{ value: 'one', label: 'One' }], onValueChange() {} })
  const input = () => elements(render()).find(e => e.props?.role === 'combobox')
  let prevented = 0
  let stopped = 0
  const event = { key: 'Escape', nativeEvent: {}, preventDefault() { prevented++ }, stopPropagation() { stopped++ } }
  input().props.onFocus()
  assert.equal(input().props['aria-expanded'], true)
  assert.equal(portalTarget, h.body)
  input().props.onKeyDown(event)
  assert.equal(input().props['aria-expanded'], false)
  assert.equal(prevented, 1)
  assert.equal(stopped, 1)
  input().props.onKeyDown(event)
  assert.equal(prevented, 1)
  input().props.onFocus()
  input().props.onKeyDown({ ...event, key: 'Tab' })
  assert.equal(input().props['aria-expanded'], false)
})

test('desktop and mobile editor close refresh a partially created agent, even if close unmounts synchronously', () => {
  for (const file of ['src/desktop/AgentsView.tsx', 'src/mobile/MobileAgents.tsx']) {
    assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /<AgentEditor\s/)
    let mounted = true
    const calls: string[] = []
    const close = sourceFunction('src/components/AgentEditor.tsx', 'close', {
      save: { current: { agentId: 'created-before-bindings-failed' } }, savedAgentId: null,
      isCurrent: () => mounted,
      onClose: () => { calls.push('close'); mounted = false },
      onSaved: file.includes('desktop') ? () => calls.push('roster') : undefined,
      useParticipants: { getState: () => ({ refresh: () => calls.push('participants') }) },
      useConversations: { getState: () => ({ reload: () => calls.push('conversations') }) },
    })
    let expanded = true
    const onKey = sourceFunction('src/components/AgentEditor.tsx', 'onKey', {
      close, document: { querySelector: () => expanded ? {} : null, querySelectorAll: () => [] },
    })
    onKey({ key: 'Escape', defaultPrevented: true })
    onKey({ key: 'Escape', defaultPrevented: false })
    assert.deepEqual(calls, [])
    expanded = false
    onKey({ key: 'Escape', defaultPrevented: false })
    assert.deepEqual(calls, file.includes('desktop') ? ['close', 'participants', 'conversations', 'roster'] : ['close', 'participants', 'conversations'])
  }
})

test('portrait waits for all staged writes; failed save never generates; retry skips committed stages', async () => {
  const { AgentEditorSave } = await import('../src/components/agentEditorSave')
  const calls: string[] = []
  let fail = true
  const attempt = new AgentEditorSave({ agentId: 'a', profile: { name: 'New', systemPrompt: 'Prompt', model: 'new-model' },
    create: { name: 'New', systemPrompt: 'Prompt' }, skills: ['skill'], mcp: ['connector'], engineError: '' })
  const client = {
    updateAgent: async (_id: string, profile: any) => { assert.equal(profile.model, 'new-model'); calls.push('profile') },
    setAgentSkills: async () => { calls.push('skills'); if (fail) throw new Error('binding failed') },
    setAgentMcpConnectors: async () => { calls.push('mcp') },
  }
  const generate = () => sourceFunction('src/components/AgentEditor.tsx', 'generateAvatar', {
    canWrite: true, editing: true, agent: { id: 'a' }, isCurrent: () => true,
    submitting: { current: false }, save: { current: null }, generatingAvatar: false,
    setAvatarErr() {}, setGeneratingAvatar() {}, setAvatarUrl() {},
    submit: async () => { try { return await attempt.run(client as any, () => true, () => {}) ? attempt.agentId : undefined } catch { return undefined } },
    api: { generateAgentAvatar: async () => { calls.push('portrait'); return { url: 'portrait.png' } } },
    useParticipants: { getState: () => ({ refresh() {} }) },
  })()
  await generate()
  assert.deepEqual(calls, ['profile', 'skills'])
  fail = false
  await generate()
  assert.deepEqual(calls, ['profile', 'skills', 'skills', 'mcp', 'portrait'])
})

test('resource poll stops at applied, backs off failed, and ignores an aborted response', async () => {
  for (const [status, expectedDelay] of [['pending', 5000], ['failed', 30000], ['applied', undefined]] as const) {
    const controller = new AbortController()
    const delays: number[] = []
    const load = sourceFunction('src/components/AgentEditor.tsx', 'load', {
      controller, epoch: 1, agentId: 'a', timer: undefined,
      useAuth: { getState: () => ({ contextEpoch: 1 }) },
      http: async () => ({ saved: true, version: 'v', appliedVersion: status === 'applied' ? 'v' : null, status }),
      setState() {}, setError() {}, setTimeout: (_fn: unknown, delay: number) => delays.push(delay),
    })
    await load()
    assert.deepEqual(delays, expectedDelay ? [expectedDelay] : [])
    controller.abort()
    await load()
    assert.equal(delays.length, expectedDelay ? 1 : 0)
  }
})

test('portal positioning stays inside desktop and mobile viewport and flips above a low input', () => {
  for (const width of [390, 1440]) {
    for (const y of [80, 700]) {
      let style: any
      const position = sourceFunction('src/components/Combobox.tsx', 'position', {
        inputRef: { current: { matches: () => false, getBoundingClientRect: () => ({ left: 40, top: y, bottom: y + 44, width: 300 }) } },
        window: { innerWidth: width, innerHeight: 800 },
        setMenuStyle: (next: unknown) => { style = next }, setOpen() {},
      })
      position()
      assert.equal(style.position, 'fixed')
      assert.ok(style.left >= 8 && style.left + style.width <= width - 8)
      assert.ok(style.maxHeight > 0 && style.maxHeight <= 288)
      if (y === 700) assert.equal(style.bottom, 108)
      else assert.equal(style.top, 132)
    }
  }
})

test('usage requests summary, trend, logs and only the selected breakdown on initial load and refresh', async () => {
  const source = readFileSync(new URL('../src/desktop/UsageDashboard.tsx', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('UsageDashboard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const queries: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(ast) === 'useUsageQuery') queries.push(node.initializer.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(queries.length, 6)
  const js = ts.transpileModule(queries.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  for (const dim of ['agent', 'model', 'provider', 'agent']) {
    for (const refresh of [0, 1]) {
      const calls: string[] = []
      const pending: Promise<unknown>[] = []
      const api = Object.fromEntries(['Summary', 'Trend', 'Logs', 'ByAgent', 'ByModel', 'ByProvider'].map(name => [
        `getUsage${name}`, async () => { calls.push(name) },
      ]))
      vm.runInNewContext(js, {
        api, dim, refresh, from: 'from', to: 'to', granularity: 'hour', page: 1, range: {}, enabled: true, epoch: 1,
        useCallback: (callback: unknown) => callback,
        useUsageQuery: (request: (signal: AbortSignal) => Promise<unknown>, enabled: boolean) => {
          if (enabled) pending.push(request(new AbortController().signal))
        },
      })
      await Promise.all(pending)
      assert.deepEqual(calls.sort(), ['Summary', 'Trend', 'Logs', `By${dim[0].toUpperCase()}${dim.slice(1)}`].sort())
    }
  }
})
