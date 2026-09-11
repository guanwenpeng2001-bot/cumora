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
    useCallback: (callback: unknown) => callback,
    useEffect: () => {},
    useLayoutEffect: () => {},
    memo: (component: unknown) => component,
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
        if (id === 'react-virtuoso') return {
          Virtuoso: ({ data = [], itemContent }: { data?: unknown[]; itemContent: (i: number, item: unknown) => unknown }) =>
            data.map((item, i) => itemContent(i, item)),
          TableVirtuoso: ({ data = [], itemContent, fixedHeaderContent }: {
            data?: unknown[]
            itemContent: (i: number, item: unknown) => unknown
            fixedHeaderContent?: () => unknown
          }) => [fixedHeaderContent?.(), data.map((item, i) => itemContent(i, item))],
        }
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
  const fromVirtuoso = typeof node.props?.itemContent === 'function' && Array.isArray(node.props?.data)
    ? node.props.data.map((row: unknown, i: number) => node.props.itemContent(i, row))
    : []
  return [node, ...elements(node.props?.children), ...elements(fromVirtuoso)]
}
const catalog = {
  text: ['kimi-k3', 'deepseek-chat', 'gpt-5', 'grok-4', 'claude-sonnet-4-6', 'glm-4.6', 'local-only'],
  image: ['gpt-image'], audio: ['whisper'], embedding: ['embed'],
  platforms: Object.fromEntries([
    ['kimi', ['kimi-k3']], ['deepseek', ['deepseek-chat']],
    ['openai', ['gpt-5', 'gpt-image', 'whisper', 'embed']], ['grok', ['grok-4']],
    ['anthropic', ['claude-sonnet-4-6']], ['zhipu', ['glm-4.6']],
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
  for (const id of ['kimi-k3', 'deepseek-chat', 'gpt-5', 'grok-4', 'claude-sonnet-4-6', 'glm-4.6', 'gpt-image', 'whisper', 'embed', 'retired-primary', 'retired-fallback']) {
    assert.ok(ids.includes(id), id)
  }
  assert.ok(!ids.includes('local-only'))
  assert.match(primary.props.options.find((o: any) => o.value === 'gpt-5').hint, /OpenAI/)
  assert.match(primary.props.options.find((o: any) => o.value === 'claude-sonnet-4-6').hint, /Anthropic/)
  assert.match(primary.props.options.find((o: any) => o.value === 'glm-4.6').hint, /Zhipu/)
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
  const status = h.render(CatalogStatus, { catalog: { platforms: {
    grok: { status: 'timeout', stale: true },
    anthropic: { status: 'ready' },
    zhipu: { status: 'success' },
    minimax: { status: 'no-key' },
  } }, error: 'offline', loading: false, refresh() {} })
  const text = JSON.stringify(status)
  assert.match(text, /Grok/)
  assert.match(text, /Anthropic/)
  assert.match(text, /Zhipu/)
  assert.match(text, /MiniMax/)
  assert.match(text, /catalogTimeout/)
  assert.match(text, /offline/)
  const arrayStatus = h.render(CatalogStatus, { catalog: { platforms: [
    { platform: 'composite', status: 'ready' },
    { platform: 'gemini', status: 'empty' },
  ] }, error: null, loading: false, refresh() {} })
  const arrayText = JSON.stringify(arrayStatus)
  assert.match(arrayText, /Composite/)
  assert.match(arrayText, /Gemini/)
})

test('catalog status renders a responsive card grid with success color, gray failures, and diagnostics', () => {
  const h = harness()
  const { CatalogStatus } = h.load('src/components/ModelFields.tsx')
  const entries: Array<[string, { status: string; stale?: boolean; models?: string[]; diagnostic?: string }]> = [
    ['openai', { status: 'success', models: ['gpt-5', 'gpt-image'] }],
    ['kimi', { status: 'timeout', diagnostic: 'gateway-timeout' }],
    ['deepseek', { status: 'success', models: ['deepseek-chat'] }],
    ['grok', { status: 'unavailable', stale: true, diagnostic: 'network-error' }],
    ['anthropic', { status: 'ready', models: ['claude-sonnet-4-6'] }],
    ['gemini', { status: 'empty' }],
    ['zhipu', { status: 'success', models: ['glm-4.6'] }],
    ['minimax', { status: 'no-key' }],
    ['dashscope', { status: 'unauthorized', diagnostic: 'http-error' }],
    ['novita', { status: 'failed', diagnostic: 'upstream' }],
  ]
  const props = {
    catalog: { platforms: Object.fromEntries(entries) },
    error: null,
    loading: false,
    refresh() {},
  }
  const render = () => h.render(CatalogStatus, props)
  const cardsOf = (tree: any) => elements(tree).filter((e) => e.type === 'button' && e.props?.['aria-expanded'] !== undefined)
  const dotOf = (card: any) => elements(card).find((e) => String(e.props?.className ?? '').includes('rounded-full'))
  let tree = render()
  const grid = elements(tree).find((e) => String(e.props?.className ?? '').includes('grid-cols-2'))
  assert.ok(grid)
  assert.match(String(grid.props.className), /md:grid-cols-4/)
  assert.match(String(grid.props.className), /xl:grid-cols-5/)
  assert.match(String(grid.props.style?.gridTemplateColumns ?? ''), /minmax/)
  assert.equal(grid.props['aria-label'], 'settings.catalogPlatforms')

  const cards = cardsOf(tree)
  assert.equal(cards.length, 10)
  assert.deepEqual(cards.map((c) => c.key), entries.map(([id]) => id))
  for (const [platform, entry] of entries) {
    const card = cards.find((c) => c.key === platform)
    assert.ok(card, platform)
    const ok = entry.status === 'success' || entry.status === 'ready'
    assert.match(String(card.props.className), ok ? /bg-paper/ : /bg-cloud/)
    assert.match(String(dotOf(card)?.props?.className ?? ''), ok ? /bg-avail/ : /bg-ink-300/)
    assert.match(String(card.props.title), /catalogModelCount/)
    if (entry.diagnostic) assert.match(String(card.props.title), new RegExp(entry.diagnostic))
  }

  const grok = cards.find((c) => String(c.props['aria-label']).includes('Grok'))
  assert.ok(grok)
  assert.equal(grok.props['aria-expanded'], false)
  grok.props.onClick()
  tree = render()
  const grokOpen = cardsOf(tree).find((c) => String(c.props['aria-label']).includes('Grok'))
  assert.equal(grokOpen?.props['aria-expanded'], true)
  const panel = JSON.stringify(tree)
  assert.match(panel, /Grok/)
  assert.match(panel, /catalogUnavailable/)
  assert.match(panel, /catalogModelCount/)
  assert.match(panel, /catalogStale/)
  assert.match(panel, /network-error/)
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
  const { ModelsTab, ModelsRoleCard } = h.load('src/desktop/ModelsTab.tsx')
  const page = h.render(ModelsTab, {})
  const tree = h.render(page.type, page.props)
  const { ModelInput, FallbackChainEditor } = h.load('src/components/ModelFields.tsx')
  const expanded = elements(tree).filter((e) => e.type === ModelsRoleCard).flatMap((card) => elements(h.render(card.type, card.props)))
  const primaries = expanded.filter((e) => e.type === ModelInput)
  const fallbacks = expanded.filter((e) => e.type === FallbackChainEditor)
  assert.equal(primaries.length, 6)
  assert.equal(fallbacks.length, 5)
  for (const primary of primaries) {
    for (const id of ['kimi-k3', 'deepseek-chat', 'gpt-5', 'grok-4', 'claude-sonnet-4-6', 'glm-4.6', 'gpt-image', 'whisper', 'embed']) {
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
  const context = { ...scope, result: undefined, Error }
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

test('portrait error maps gateway no-accounts copy without HTTP wrapping', () => {
  const format = sourceFunction('src/components/AgentEditor.tsx', 'formatAvatarError', {}) as (
    error: unknown, t: (key: string) => string,
  ) => string
  const t = (key: string) => key === 'agent.avatarGatewayNoAccounts' ? 'mapped-copy' : key
  assert.equal(format(new Error('No available compatible accounts (503)'), t), 'mapped-copy')
  assert.equal(format(new Error("The current image model's gateway group has no available accounts. Change the image model in settings or configure a direct connection. (409)"), t), 'mapped-copy')
  assert.equal(format(new Error('当前图像模型所在网关组没有可用账号,请在模型设置更换图像模型或配置直连 (409)'), t), 'mapped-copy')
  assert.equal(format(new Error('storage failed (502)'), t), 'storage failed (502)')
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
  assert.equal(queries.length, 7)
  const js = ts.transpileModule(queries.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  for (const dim of ['agent', 'model', 'provider', 'source', 'agent']) {
    for (const refresh of [0, 1]) {
      const calls: string[] = []
      const pending: Promise<unknown>[] = []
      const api = Object.fromEntries(['Summary', 'Trend', 'Logs', 'ByAgent', 'ByModel', 'ByProvider', 'BySource'].map(name => [
        `getUsage${name}`, async () => { calls.push(name) },
      ]))
      vm.runInNewContext(js, {
        api, dim, refresh, filters: {}, from: 'from', to: 'to', granularity: 'hour', page: 1, range: {}, enabled: true, epoch: 1,
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

test('catalog options are grouped by platform when the menu opens', () => {
  const h = harness()
  const { ModelInput } = h.load('src/components/ModelFields.tsx')
  const picker = h.render(ModelInput, { value: 'kimi-k3', options: [], catalog, listId: 'brain', onChange() {} })
  const render = () => h.render(picker.type, picker.props)
  elements(render()).find((e) => e.props?.role === 'combobox').props.onFocus()
  const groups = elements(render()).filter((e) => e.props?.['data-combobox-group'])
  const names = groups.map((e) => e.props['data-combobox-group'])
  for (const name of ['Kimi', 'DeepSeek', 'OpenAI', 'Grok', 'Anthropic', 'Zhipu']) {
    assert.ok(names.includes(name), name)
  }
})

test('catalogIndex is cached on catalog identity and catalogSource uses the index', () => {
  const h = harness()
  const { catalogIndex, catalogSource } = h.load('src/stores/modelCatalog.ts')
  const first = catalogIndex(catalog)
  const second = catalogIndex(catalog)
  assert.equal(first, second)
  assert.match(catalogSource(catalog, 'gpt-5'), /OpenAI/)
  assert.equal(catalogSource(catalog, 'retired-x'), 'configured / history')
})

test('ModelsTab only loads the catalog for admins', () => {
  const source = readFileSync(new URL('../src/desktop/ModelsTab.tsx', import.meta.url), 'utf8')
  assert.match(source, /useModelCatalog\(isAdmin\)/)
  const skills = readFileSync(new URL('../src/desktop/SkillsTab.tsx', import.meta.url), 'utf8')
  assert.equal(skills.includes('getModelSettings()'), false)
  const runtime = readFileSync(new URL('../src/desktop/RuntimeSettingsPanel.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(runtime, /<details key=\{domain\} open/)
  assert.match(runtime, /opened\[domain\]/)
})

test('model catalog store coalesces in-flight fetches', async () => {
  let calls = 0
  const authState = { user: { id: 'u', isAdmin: true }, contextEpoch: 1, activeCompanyId: 'company', token: 't' }
  const useAuth = Object.assign((select: (s: unknown) => unknown) => select(authState), { getState: () => authState })
  const h = harness([], {
    '@/stores/auth': { useAuth },
    '@/api/client': {
      api: {
        getAvailableModels: async () => {
          calls++
          await new Promise((r) => setTimeout(r, 20))
          return catalog
        },
      },
    },
  })
  const store = h.load('src/stores/modelCatalog.ts')
  await Promise.all([
    store.useModelCatalogStore.getState().ensure('["1","u","company"]'),
    store.useModelCatalogStore.getState().ensure('["1","u","company"]'),
  ])
  assert.equal(calls, 1)
  assert.ok(store.useModelCatalogStore.getState().catalog)
})

test('downsampleTrend keeps endpoints and stays within the width budget', () => {
  const h = harness()
  const { downsampleTrend } = h.load('src/desktop/UsageDashboard.tsx')
  const points = Array.from({ length: 2208 }, (_, i) => ({ i }))
  const sampled = downsampleTrend(points, 240)
  assert.ok(sampled.length <= 240)
  assert.equal(sampled[0]?.i, 0)
  assert.equal(sampled.at(-1)?.i, 2207)
  assert.deepEqual(downsampleTrend(points.slice(0, 10), 240), points.slice(0, 10))
})

test('computers refresh coalesces in-flight and keeps byId when unchanged', async () => {
  let calls = 0
  const list = [{
    id: 'c1', name: 'box', kind: 'local', status: 'online', available_engines: [],
    company_id: 'co', owner_user_id: null, last_seen_at: null, paired_at: null,
  }]
  const authState = { contextEpoch: 1, token: 't', activeCompanyId: 'co' }
  const h = harness([], {
    '@/stores/auth': {
      useAuth: Object.assign((select: (s: unknown) => unknown) => select(authState), { getState: () => authState }),
      commitIfContextCurrent: async (request: () => Promise<unknown>, commit: (v: unknown) => void) => {
        commit(await request())
        return true
      },
    },
    '@/api/client': {
      api: { getComputers: async () => { calls++; return list } },
      ws: { connect() {}, on() {} },
    },
  })
  const { useComputers } = h.load('src/stores/computers.ts')
  await Promise.all([useComputers.getState().refresh(), useComputers.getState().refresh()])
  assert.equal(calls, 1)
  const byId = useComputers.getState().byId
  await useComputers.getState().refresh()
  assert.equal(calls, 2)
  assert.equal(useComputers.getState().byId, byId)
})

test('staged agent save preserves provider id through a failed host assignment retry', async () => {
  const { AgentEditorSave } = await import('../src/components/agentEditorSave')
  let profiles = 0, attempts = 0
  const seen: unknown[][] = []
  const save = new AgentEditorSave({
    agentId: 'a', profile: { name: 'Agent', systemPrompt: 'Prompt' },
    create: { requestId: 'create-profile', name: 'Agent', systemPrompt: 'Prompt', providerProfile: 'work' },
    assignment: { computerId: 'local', engine: 'claude', inherit: false, model: 'work/pin', fastModel: null, providerProfile: 'work' },
    skills: null, mcp: null, expectedEngine: 'claude', engineError: 'wrong engine',
  })
  const client = {
    updateAgent: async () => { profiles++ },
    assignAgentComputer: async (...args: unknown[]) => {
      seen.push(args)
      if (++attempts === 1) throw new Error('offline')
      return { ok: true, kind: 'local', engine: 'claude' }
    },
  }
  await assert.rejects(save.run(client as any, () => true, () => {}), /offline/)
  assert.equal(await save.run(client as any, () => true, () => {}), true)
  assert.equal(profiles, 1)
  assert.deepEqual(seen, Array(2).fill(['a', 'local', 'claude', false, 'work/pin', null, 'work']))
})
