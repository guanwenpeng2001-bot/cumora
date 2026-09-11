import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsx from 'react/jsx-runtime'

test('trust thresholds are disabled and the page offers enforced safety controls', () => {
  const source = readFileSync(new URL('../src/desktop/MeView.tsx', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('MeView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fn = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'TrustTab')!
  const js = ts.transpileModule(fn.getText(ast) + '\nexports.render = TrustTab', {
    fileName: 'trust.tsx', compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports: Record<string, any> = {}
  const prefs = { autonomy: { a: { threshold: 0.9 } } }
  const section = ({ children }: any) => createElement('section', null, children)
  new Function('exports', 'require', 'useT', 'useParticipants', 'usePrefs', 'Section', 'TurnSafetyPanel', 'Avatar', 'Stat', js)(
    exports, () => jsx, () => (key: string) => key === 'me.autonomyPending' ? '未生效（规划中）' : key,
    (select: any) => select({ byId: { a: { id: 'a', kind: 'agent', name: 'Alice' } } }),
    (select: any) => select(prefs), section, ({ budgets }: any) => createElement('div', null, budgets ? 'Enforced budgets' : 'Stop'), () => null, () => null,
  )
  const html = renderToStaticMarkup(exports.render())
  assert.match(html, /未生效（规划中）/)
  assert.match(html, /type="range" disabled=""/)
  assert.match(html, /value="0.9"/)
  assert.match(html, /Enforced budgets/)
  assert.doesNotMatch(fn.getText(ast), /setAutonomy/)
})
