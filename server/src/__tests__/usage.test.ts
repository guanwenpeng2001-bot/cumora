/**
 * Unit tests for the usage dashboard's pure helpers: provider labeling and
 * range parsing/clamping. No DB.
 *
 * Run: node --import tsx --test server/src/__tests__/usage.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerForModel, parseUsageRange } from '../usage.js'

test('providerForModel: prefix relays win over family names', () => {
  assert.equal(providerForModel('novita/deepseek-v4-flash'), 'Novita')
  assert.equal(providerForModel('orcarouter/deepseek-v4-flash'), 'OrcaRouter')
})

test('providerForModel: family labels', () => {
  assert.equal(providerForModel('k3'), 'Kimi')
  assert.equal(providerForModel('kimi-for-coding'), 'Kimi')
  assert.equal(providerForModel('deepseek-v4-pro'), 'DeepSeek')
  assert.equal(providerForModel('qwen-image-max'), 'DashScope')
  assert.equal(providerForModel('gpt-5.5'), 'OpenAI')
  assert.equal(providerForModel('claude-sonnet-4-6'), 'Anthropic')
  assert.equal(providerForModel('gemini-3.1-pro-high'), 'Google')
  assert.equal(providerForModel('grok-4'), 'xAI')
  assert.equal(providerForModel('chatgpt-web/medium'), 'ChatGPT Web')
  assert.equal(providerForModel('text-embedding-v4'), 'other')
  assert.equal(providerForModel(null), 'unknown')
  assert.equal(providerForModel(''), 'unknown')
})

test('parseUsageRange: defaults to today, clamps future end, caps 92 days back', () => {
  const r = parseUsageRange({})
  assert.equal(r.from.getHours() + r.from.getMinutes() + r.from.getSeconds(), 0)
  const ninetyTwoDays = 92 * 86_400_000
  const long = parseUsageRange({ from: new Date(Date.now() - 200 * 86_400_000).toISOString() })
  assert.ok(long.to.getTime() - long.from.getTime() <= ninetyTwoDays + 86_400_000)
  const future = parseUsageRange({ to: new Date(Date.now() + 10 * 86_400_000).toISOString() })
  assert.ok(future.to.getTime() <= Date.now() + 86_400_000)
})

test('parseUsageRange: explicit ISO range passes through; garbage falls back', () => {
  const from = '2026-09-01T00:00:00Z'
  const to = '2026-09-02T00:00:00Z'
  const r = parseUsageRange({ from, to })
  assert.equal(r.from.toISOString(), new Date(from).toISOString())
  assert.equal(r.to.toISOString(), new Date(to).toISOString())
  const bad = parseUsageRange({ from: 'not-a-date', to: 'also-not' })
  assert.ok(Number.isFinite(bad.from.getTime()))
})

test('providerForModel: similar IDs never inherit a provider by substring', () => {
  for (const model of ['not-deepseek-v4-pro', 'my-moonshot', 'gpt-5.5-impostor', 'k30', 'claudeish', 'qwenish', 'unknown/gpt-5.5']) {
    assert.equal(providerForModel(model), 'other', model)
  }
})
