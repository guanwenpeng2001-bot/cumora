/**
 * Runtime engine selection must use the daemon's current PATH inventory, not
 * the snapshot captured when the process started.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createEngineSnapshotReporter,
  replaceEngineInventory,
  resolveAvailableEngine,
  shouldReportEngineSnapshot,
  type EngineInventory,
} from '../agents/computer/daemon.js'

test('a newly detected requested engine is selected without a daemon restart', () => {
  const inventory: EngineInventory = { current: ['claude'] }

  assert.equal(replaceEngineInventory(inventory, ['claude', 'cursor']), true)
  assert.equal(resolveAvailableEngine('cursor', inventory.current), 'cursor')
})

test('no installed engines leaves the agent without a runnable fallback', () => {
  const inventory: EngineInventory = { current: ['claude'] }

  assert.equal(replaceEngineInventory(inventory, []), true)
  assert.equal(resolveAvailableEngine('claude', inventory.current), null)
})

test('an unchanged scan does not replace the shared inventory', () => {
  const current = ['claude', 'codex'] as const
  const inventory: EngineInventory = { current: [...current] }
  const before = inventory.current

  assert.equal(replaceEngineInventory(inventory, current), false)
  assert.equal(inventory.current, before)
})

test('a requested refresh reports an unchanged engine snapshot', () => {
  const snapshot = JSON.stringify([{ id: 'codex', version: '1.2.3' }])

  assert.equal(shouldReportEngineSnapshot(snapshot, snapshot), false)
  assert.equal(shouldReportEngineSnapshot(snapshot, snapshot, true), true)
})

test('an unchanged snapshot retries after its first POST fails and deduplicates after success', async () => {
  const report = createEngineSnapshotReporter()
  let attempts = 0
  const post = async () => {
    attempts++
    if (attempts === 1) throw new Error('HTTP 503')
  }
  await assert.rejects(report('catalog-a', false, post), /HTTP 503/)
  await report('catalog-a', false, post)
  assert.equal(attempts, 2)
  await report('catalog-a', false, post)
  assert.equal(attempts, 2)
  await report('catalog-a', true, post)
  assert.equal(attempts, 3)
})

test('failed updates and forced reports retain the last successfully reported snapshot', async () => {
  const report = createEngineSnapshotReporter()
  let accepted = ''
  const accept = async (value: string) => { accepted = value }
  const fail = async () => { throw new Error('network unavailable') }
  const unexpected = async () => { assert.fail('last successful snapshot must still deduplicate') }
  await report('catalog-a', false, () => accept('catalog-a'))
  await assert.rejects(report('catalog-b', false, fail), /network unavailable/)
  assert.equal(accepted, 'catalog-a')
  await report('catalog-a', false, unexpected)
  await report('catalog-b', false, () => accept('catalog-b'))
  assert.equal(accepted, 'catalog-b')
  await assert.rejects(report('catalog-b', true, fail), /network unavailable/)
  await report('catalog-b', false, unexpected)
  await report('catalog-b', true, () => accept('catalog-b'))
})
