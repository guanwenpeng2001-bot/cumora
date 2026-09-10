import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('usage query retains data across dim switches and logs/trend are bounded', () => {
  const usage = readFileSync(new URL('../src/desktop/UsageDashboard.tsx', import.meta.url), 'utf8')
  assert.match(usage, /stale/)
  assert.match(usage, /cache\.current/)
  assert.match(usage, /downsampleTrend/)
  assert.match(usage, /TableVirtuoso/)
  assert.match(usage, /LogAttemptDetails/)
})

test('computers refresh is single-flight and MeView does not refresh on every settings tab', () => {
  const computers = readFileSync(new URL('../src/stores/computers.ts', import.meta.url), 'utf8')
  assert.match(computers, /if \(inflight\) return inflight/)
  assert.match(computers, /computersEqual/)
  const me = readFileSync(new URL('../src/desktop/MeView.tsx', import.meta.url), 'utf8')
  const view = me.slice(me.indexOf('export function MeView'))
  assert.doesNotMatch(view, /useComputers\.getState\(\)\.refresh/)
  assert.match(me, /4_000/)
  const runtime = readFileSync(new URL('../src/desktop/RuntimeSettingsPanel.tsx', import.meta.url), 'utf8')
  assert.match(runtime, /useComputers/)
  assert.doesNotMatch(runtime, /api\.getComputers/)
})
