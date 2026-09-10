import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the real TSX with a small hook host; no DOM, network or database required.
function harness(initialSlots: unknown[] = [], mocks: Record<string, unknown> = {}) {
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
      module, exports: module.exports, queueMicrotask: () => {},
      require: (id: string) => {
        if (id in mocks) return mocks[id]
        if (id === 'react') return react
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
  return { load, render: (component: (props: any) => any, props: any) => {
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
  input(render()).props.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault() {} })
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
