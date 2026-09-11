import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TurnBudgetUsage } from '../src/desktop/TurnBudgetUsage.js'

const rule = { period: 'day' as const, metric: 'tokens' as const, ceiling: 100, tokens: 150, usd: 0.25, resets_at: '2026-10-01T00:00:00Z' }
const base = { rule, scopeName: 'Alice', zh: true, canEdit: true, busy: false, onEdit() {}, onRemove() {} }

test('budget UI renders actual usage above limit, clamped progress, UTC reset and recovery control', () => {
  const html = renderToStaticMarkup(createElement(TurnBudgetUsage, base))
  for (const expected of ['Alice', '每天', '150 / 100', '已熔断', '2026-10-01T00:00:00.000Z', '移除上限／清除熔断']) assert.ok(html.includes(expected), expected)
  assert.match(html, /max="100" value="100"/)
})

test('cost rules use USD usage rather than token usage and members have read-only controls', () => {
  const html = renderToStaticMarkup(createElement(TurnBudgetUsage, { ...base, zh: false, canEdit: false,
    rule: { ...rule, period: 'month', metric: 'usd', ceiling: 1 } }))
  for (const expected of ['Monthly', 'usd', '0.25 / 1', 'Available']) assert.ok(html.includes(expected), expected)
  assert.doesNotMatch(html, /<button/)
})

test('configuration controls stay disabled while a mutation is pending', () => {
  const html = renderToStaticMarkup(createElement(TurnBudgetUsage, { ...base, busy: true }))
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2)
})
