import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { SANDBOXED_ENGINE_IDS, ENGINE_IDS } from '../agents/computer/engine.js'
import { agentCliCommand } from '../../../src/lib/agentCliRelease.js'
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

test('an unavailable explicit engine never falls back to another installed engine', () => {
  assert.equal(resolveAvailableEngine('kimi', ['claude', 'codex']), null)
  assert.equal(resolveAvailableEngine('kimi', ['kimi', 'codex']), 'kimi')
  assert.equal(resolveAvailableEngine(null, ['codex']), 'codex')
  assert.equal(resolveAvailableEngine(undefined, []), null)
})

test('both pairing UIs opt in every unsandboxed engine on POSIX and PowerShell', () => {
  for (const [file, output] of [['Onboarding', 'cmd'], ['MeView', 'pairCommand']]) {
    const source = readFileSync(new URL(`../../../src/desktop/${file}.tsx`, import.meta.url), 'utf8')
    const ast = ts.createSourceFile('ui.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const names = new Set(['SANDBOXED_ENGINE_IDS', 'optIn', 'engineFlag', output])
    const statements: string[] = []
    const visit = (node: ts.Node) => {
      if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.has(d.name.getText(ast)))) statements.push(node.getText(ast))
      ts.forEachChild(node, visit)
    }
    visit(ast)
    const code = ts.transpile(statements.join(';') + `;return { command: ${output}, sandboxed: SANDBOXED_ENGINE_IDS }`, { target: ts.ScriptTarget.ES2022 })
    const generate = new Function('engine', 'isWindows', 'code', 'origin', 'serverFlag', 'serviceFlag', 'asService', 'agentCliCommand', code)
    for (const engine of ENGINE_IDS) for (const windows of [false, true]) {
      const result = generate(engine, windows, 'pair-token', '', '', ' --install-service', true, agentCliCommand)
      assert.deepEqual(result.sandboxed, SANDBOXED_ENGINE_IDS)
      assert.match(result.command, /--pair pair-token/)
      assert.match(result.command, /--install-service/)
      if (SANDBOXED_ENGINE_IDS.includes(engine)) assert.doesNotMatch(result.command, /CUMORA_BYOA_ALLOW_UNSANDBOXED/)
      else {
        assert.ok(result.command.startsWith(windows ? "$env:CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'" : 'export CUMORA_BYOA_ALLOW_UNSANDBOXED=1'))
        assert.ok(result.command.includes(`--engine ${engine}`))
      }
    }
  }
})
