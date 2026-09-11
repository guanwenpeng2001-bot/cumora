import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import * as jsx from 'react/jsx-runtime'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { flattenExtensions, getSchema } from '@tiptap/core'
import { formatWeekRange } from '../src/lib/calendarLabels'
import { en } from '../src/locales/en'
import { zhCN } from '../src/locales/zh-CN'

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

// Like the other UI tests, transpile the real component with small hook/DOM
// doubles. Native layout and keyboard traversal are also checked in a browser.
function load(path: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const js = ts.transpileModule(source(path), {
    fileName: path, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', 'require', ...Object.keys(globals), js)(
    exports, (name: string) => name === 'react/jsx-runtime' ? jsx : modules[name] ?? {}, ...Object.values(globals),
  )
  return exports
}

test('D1: summary participates in both dialog focus cycles; closed details descendants do not', () => {
  class Details {
    open = false
    parentElement: unknown = null
    summary: any
    querySelector() { return this.summary }
  }
  const listeners = new Map<string, (event: any) => void>()
  const doc = { activeElement: null as any, addEventListener: (key: string, fn: any) => listeners.set(key, fn), removeEventListener: (key: string) => listeners.delete(key) }
  const node = (name: string, extra = {}) => ({
    name, tabIndex: 0, parentElement: null as any, visibility: 'visible',
    closest: () => null, getClientRects: () => [{}], contains(other: unknown) { return other === this },
    focus() { doc.activeElement = this }, ...extra,
  })
  const close = node('close'), cancel = node('cancel'), save = node('save')
  const details = new Details()
  const summary = node('summary', { parentElement: details })
  details.summary = summary
  const inside = node('resource control', { parentElement: details })
  // A second closed details at the end catches invisible controls being
  // mistaken for the last Tab stop even when the browser reports rects.
  const nested = new Details()
  nested.open = true
  nested.parentElement = details
  const hiddenTail = node('nested closed resource', { parentElement: nested })
  const cssHidden = node('css hidden', { visibility: 'hidden' })
  const nodes = [close, summary, inside, cancel, save, hiddenTail, cssHidden]
  const el = {
    querySelector: () => null, hasAttribute: () => true,
    querySelectorAll: (selector: string) => nodes.filter(n => n !== summary || selector.split(', ').includes('summary')),
    contains: (n: any) => nodes.includes(n),
  }
  const effects: Array<() => (() => void)> = []
  let refIndex = 0
  const { Dialog } = load('components/Dialog.tsx', {
    react: { useId: () => 'title', useRef: (v: unknown) => ({ current: refIndex++ === 0 ? el : v }), useLayoutEffect: (fn: any) => effects.push(fn) },
  }, { document: doc, HTMLDetailsElement: Details, getComputedStyle: (n: any) => ({ visibility: n.visibility }) })
  Dialog({ onClose() {} })
  const cleanup = effects[0]()
  const pressTab = (shiftKey: boolean, nativeOrder: any[]) => {
    const event = { key: 'Tab', shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    listeners.get('keydown')!(event)
    if (!event.defaultPrevented) nativeOrder[nativeOrder.indexOf(doc.activeElement) + (shiftKey ? -1 : 1)]?.focus()
    return doc.activeElement.name
  }
  for (const open of [false, true]) {
    details.open = open
    const order = open ? [close, summary, inside, cancel, save, hiddenTail] : [close, summary, cancel, save]
    close.focus()
    assert.deepEqual(order.map(() => pressTab(false, order)), [...order.slice(1), close].map(n => n.name))
    assert.deepEqual(order.map(() => pressTab(true, order)), [...order.slice(1).reverse(), close].map(n => n.name))
  }
  cleanup()
  assert.equal(listeners.size, 0)
})

test('D2: root and child menus portal to body and clamp all four viewport corners before paint', () => {
  for (const child of [false, true]) for (const [x, y] of [[-5, -5], [1439, -5], [-5, 899], [1439, 899]]) {
    const el = { offsetWidth: 220, offsetHeight: 320, style: { left: '', top: '' } }
    const body = {}
    const layout: Array<() => void> = []
    let refIndex = 0
    const { ContextMenu } = load('components/ContextMenu.tsx', {
      react: {
        useRef: (v: unknown) => ({ current: refIndex++ === 0 ? el : v }),
        useState: (v: unknown) => [v, () => {}], useEffect() {}, useLayoutEffect: (fn: any) => layout.push(fn),
      },
      'react-dom': { createPortal: (content: unknown, target: unknown) => ({ content, target }) },
      '@/lib/utils': { cn: (...v: unknown[]) => v.filter(Boolean).join(' ') },
    }, { document: { body, activeElement: null }, window: { innerWidth: 1440, innerHeight: 900 } })
    const result = ContextMenu({ x, y, items: [{ label: 'last item' }], onClose() {}, _isChild: child })
    assert.equal(result.target, body)
    assert.equal(layout.length, 1)
    layout[0]()
    assert.equal(el.style.left, `${x < 0 ? 8 : 1212}px`)
    assert.equal(el.style.top, `${y < 0 ? 8 : 572}px`)
    const menu = result.content.props.children[0]
    assert.equal(menu.props.style.width, 'max-content')
    assert.equal(menu.props.style.maxHeight, 'calc(100vh - 16px)')
    assert.equal(menu.props.style.overflowY, 'auto')
  }
})

test('D3: Chinese week titles cover same month, month boundary and year boundary', () => {
  const date = (s: string) => new Date(`${s}T12:00:00`)
  assert.equal(formatWeekRange(date('2026-09-06'), date('2026-09-12'), 'zh-CN'), '2026年9月6日—12日')
  assert.equal(formatWeekRange(date('2026-09-27'), date('2026-10-03'), 'zh-CN'), '2026年9月27日—10月3日')
  assert.equal(formatWeekRange(date('2026-12-27'), date('2027-01-02'), 'zh-CN'), '2026年12月27日—2027年1月2日')
  assert.match(formatWeekRange(date('2026-09-06'), date('2026-09-12'), 'en'), /Sep 6\s*–\s*12, 2026/)
  assert.match(formatWeekRange(date('2026-09-27'), date('2026-10-03'), 'en'), /Sep 27\s*–\s*Oct 3, 2026/)
  assert.match(formatWeekRange(date('2026-12-27'), date('2027-01-02'), 'en'), /Dec 27, 2026\s*–\s*Jan 2, 2027/)
  assert.match(source('desktop/CalendarView.tsx'), /formatWeekRange\(ws, we, locale\)/)
})

test('D4: mobile library, weekdays and status summaries are wired to complete English/Chinese copy', () => {
  const library = source('mobile/MobileLibrary.tsx')
  for (const key of ['title', 'subtitle', 'emptyDocuments', 'emptyBoards', 'newDocument', 'newBoard', 'newEvent']) {
    const full = `moblib.${key}` as keyof typeof en
    assert.ok(en[full])
    assert.match(zhCN[full]!, /[\u4e00-\u9fff]/)
    assert.ok(library.includes(`'${full}'`))
  }
  assert.match(library, /\{t\('moblib\.title'\)\}/)
  assert.match(library, /\{t\('moblib\.subtitle'\)\}/)
  assert.match(library, /\{t\('moblib\.emptyDocuments'\)\}/)
  assert.match(library, /\{t\('moblib\.emptyBoards'\)\}/)
  const calendar = source('mobile/MobileCalendar.tsx')
  const keys = [...calendar.matchAll(/'mcal\.(sun|mon|tue|wed|thu|fri|sat)'/g)].map(m => `mcal.${m[1]}` as keyof typeof en)
  assert.deepEqual(keys.map(k => en[k]), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
  assert.deepEqual(keys.map(k => zhCN[k]), ['周日', '周一', '周二', '周三', '周四', '周五', '周六'])
  assert.match(calendar, /WEEK\.map\([\s\S]*?\{t\(d\)\}/)
  const agents = source('mobile/MobileAgents.tsx')
  assert.match(agents, /\['avail', agents\.filter/)
  assert.match(agents, /\{tLabel\(statusLabelsKey\[lbl as string\], statusLabels\[lbl as string\]\)\}/)
  for (const key of ['magents.statusWorking', 'magents.statusThinking', 'magents.statusAvail', 'magents.statusResting'] as const) {
    assert.ok(en[key])
    assert.match(zhCN[key], /[\u4e00-\u9fff]/)
  }
})

test('D5: document StarterKit and explicit Link resolve to one configured link extension', () => {
  const editor = source('components/DocumentEditor.tsx')
  const starterOptions = editor.match(/StarterKit\.configure\((\{[^}]+\})\)/)![1]
  const linkOptions = editor.match(/Link\.configure\((\{[^}]+\})\)/)![1]
  const extensions = [StarterKit.configure(new Function(`return (${starterOptions})`)()), Link.configure(new Function(`return (${linkOptions})`)())]
  const flattened = flattenExtensions(extensions)
  assert.equal(flattened.filter(e => e.name === 'link').length, 1)
  assert.equal(flattened.some(e => e.name === 'undoRedo'), false)
  const link = flattened.find(e => e.name === 'link')!
  assert.equal(link.options.openOnClick, false)
  assert.equal(link.options.autolink, true)
  const schema = getSchema(extensions)
  const mark = schema.marks.link.create({ href: 'https://example.com' })
  assert.equal(schema.text('link', [mark]).toJSON().marks?.[0].attrs?.href, 'https://example.com')
  assert.match(editor, /Collaboration\.configure\(\{ document: session\.doc \}\)/)
})

test('D6: Escape closes mobile admin navigation, restores burger focus, and removes its listener', () => {
  for (const open of [false, true]) {
    let closed = false, focused = false, prevented = false
    const listeners = new Map<string, (event: any) => void>()
    const effects: Array<{ fn: () => (() => void) | undefined; deps: unknown[] }> = []
    const { AdminApp } = load('admin/AdminApp.tsx', {
      react: {
        useRef: () => ({ current: { focus() { focused = true } } }),
        useState: (v: unknown) => [v === false ? open : v === 'checking' ? 'admin' : typeof v === 'function' ? v() : v, (next: unknown) => { if (v === false && next === false) closed = true }],
        useEffect: (fn: any, deps: unknown[]) => effects.push({ fn, deps }),
      },
      '@/lib/i18n': { useT: () => (key: string) => key },
      '@/stores/auth': { useAuth: (select: any) => select({ user: { id: 'admin' }, clear() {} }) },
      '@/components/Avatar': { CloudLogo: 'span' },
      './UsersPage': { UsersPage: 'section' },
    }, { location: { pathname: '/admin/users' }, window: {
      addEventListener: (key: string, fn: any) => listeners.set(key, fn), removeEventListener: (key: string) => listeners.delete(key),
    } })
    const tree = AdminApp()
    const burger = tree.props.children[0].props.children[0]
    assert.equal(burger.props['aria-expanded'], open)
    const cleanup = effects.find(e => e.deps.length === 1 && e.deps[0] === open)!.fn()
    if (!open) { assert.equal(listeners.size, 0); continue }
    const onKey = listeners.get('keydown')!
    onKey({ key: 'Enter' })
    onKey({ key: 'Escape', defaultPrevented: true })
    assert.equal(closed, false)
    onKey({ key: 'Escape', defaultPrevented: false, preventDefault() { prevented = true } })
    assert.equal(closed, true)
    assert.equal(focused, true)
    assert.equal(prevented, true)
    cleanup!()
    assert.equal(listeners.size, 0)
  }
})
