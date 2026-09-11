import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function runnerMethods(dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile('daemon.ts', readFileSync(new URL('../agents/computer/daemon.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const runner = source.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'AgentRunner') as ts.ClassDeclaration
  const methods = runner.members.filter(m => ts.isMethodDeclaration(m) && ['admitSafety', 'emergencyCancel', 'ackSeen'].includes(m.name.getText(source)))
  const code = ts.transpileModule(`class Runner { ${methods.map(m => m.getText(source)).join('\n')} }; Runner.prototype`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  return runInNewContext(code, { AbortController, DOMException, ...dependencies }) as {
    emergencyCancel: (generation: string) => Promise<void>
    ackSeen: (token: string, seen: Map<string, string>) => Promise<void>
    admitSafety: (token: string, initial?: boolean) => Promise<boolean>
  }
}

test('BYOA stop aborts immediately, force-stops session and confirms only after the turn drains', async () => {
  const receipts: unknown[][] = []
  const methods = runnerMethods({ runtimeBest: async (...args: unknown[]) => { receipts.push(args) } })
  let drain!: () => void
  const controller = new AbortController()
  const stopCalls: unknown[] = []
  const fixture = {
    ...methods, cancellingSafety: false, stopped: false, turnCancelled: false, pendingRerun: true,
    teardown: controller, engineSession: { stop: async (options: unknown) => { stopCalls.push(options) } },
    activeTurn: new Promise<void>(resolve => { drain = resolve }), cfg: { serverUrl: 'test' }, token: 'test-token',
  }
  const stopping = methods.emergencyCancel.call(fixture, '2')
  assert.equal(controller.signal.aborted, true)
  assert.equal(fixture.pendingRerun, false)
  assert.equal(fixture.turnCancelled, true)
  assert.equal(JSON.stringify(stopCalls), '[{"force":true}]')
  await Promise.resolve()
  assert.equal(receipts.length, 0, 'signal delivery is not a completion receipt')
  await methods.ackSeen.call(fixture, 'test-token', new Map([['c', 'unfinished']]))
  assert.equal(receipts.length, 0, 'cancelled input must remain unread')
  drain()
  await stopping
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0][1], '/stop-confirmed')
  assert.equal(fixture.cancellingSafety, false)
  assert.equal(fixture.teardown.signal.aborted, false, 'future manually resumed turns must be possible')
})

test('BYOA admission is mandatory and a changed stop generation cannot renew an in-flight permit', async () => {
  let allowed = false
  let generation = '5'
  const methods = runnerMethods({ api: async () => ({ allowed, generation }) })
  const fixture = { cfg: { serverUrl: 'test' }, safetyGeneration: '0', turnCancelled: false }
  assert.equal(await methods.admitSafety.call(fixture, 'token', true), false)
  allowed = true
  assert.equal(await methods.admitSafety.call(fixture, 'token', true), true)
  generation = '6'
  assert.equal(await methods.admitSafety.call(fixture, 'token'), false)
  assert.equal(fixture.safetyGeneration, '5')
  assert.equal(fixture.turnCancelled, true, 'admission records cancellation even before the stop event arrives')
  // runTurn clears the previous cancellation only when starting a fresh turn.
  fixture.turnCancelled = false
  assert.equal(await methods.admitSafety.call(fixture, 'token', true), true)
  fixture.turnCancelled = true
  assert.equal(await methods.admitSafety.call(fixture, 'token'), false)
})

test('BYOA completed receipts carry the admitted generation', async () => {
  let recorded: unknown[] = []
  const methods = runnerMethods({ runtimeBest: async (...args: unknown[]) => { recorded = args } })
  const fixture = { cfg: { serverUrl: 'test' }, safetyGeneration: '8', turnCancelled: false, teardown: new AbortController() }
  await methods.ackSeen.call(fixture, 'token', new Map([['conversation', 'completed']]))
  assert.equal(recorded[1], '/conversation/mark-read')
  assert.equal(recorded[4], '8')
})

test('completion receipt rechecks stop after acquiring the company lock and rolls back on stale generation', async () => {
  const source = ts.createSourceFile('inproc.ts', readFileSync(new URL('../agents/runtime/inproc-client.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const runner = source.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'InProcRuntimeClient') as ts.ClassDeclaration
  const method = runner.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(source) === 'markConversationRead')!
  const queries: string[] = []
  let generation = '2'
  const client = { release() {}, async query(sql: string) {
    queries.push(sql)
    if (sql.includes('FOR SHARE OF c')) return { rows: [{ company_id: 'company' }] }
    if (sql.includes('company_turn_safety')) return { rows: [{ paused: false, generation }] }
    return { rows: [] }
  } }
  const code = ts.transpileModule(`class Runner { ${method.getText(source)} }; new Runner()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const runtime = runInNewContext(code, { pool: { connect: async () => client } }) as {
    markConversationRead: (args: Record<string, unknown>) => Promise<void>
  }
  const args = { agentId: 'a', conversationId: 'c', upToMessageId: 'm', safetyGeneration: '1' }
  await assert.rejects(runtime.markConversationRead(args), /retaining unfinished/)
  assert.equal(queries[0], 'BEGIN')
  assert.ok(queries[1].includes('FOR SHARE OF c'))
  assert.ok(queries[2].includes('company_turn_safety'))
  assert.equal(queries.at(-1), 'ROLLBACK')
  assert.ok(!queries.some(q => q.includes('INSERT INTO agent_message_consumptions')))
  generation = '1'
  queries.length = 0
  await runtime.markConversationRead(args)
  assert.equal(queries.at(-1), 'COMMIT')
  assert.ok(queries.some(q => q.includes('INSERT INTO agent_message_consumptions')))
})

test('stop-all persists the pause before delivery and continues when one runtime is disconnected', async () => {
  const sequence: string[] = []
  const database = { release() {}, async query(sql: string, values?: unknown[]) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) sequence.push(sql)
    if (sql.includes('FOR UPDATE')) sequence.push('company-lock')
    if (sql.includes('RETURNING generation')) return { rows: [{ generation: '3' }] }
    if (sql.includes('FROM participants')) {
      assert.equal(values?.[0], 'company-a')
      return { rows: [{ id: 'managed', name: 'Managed' }, { id: 'byoa', name: 'BYOA' }] }
    }
    return { rows: [] }
  } }
  const exports: Record<string, unknown> = {}
  const code = ts.transpileModule(readFileSync(new URL('../turn-safety.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const dependencies: Record<string, unknown> = {
    'node:crypto': { randomUUID: () => 'id' }, './db/pool.js': { pool: { ...database, connect: async () => database } },
    './turn-safety-policy.js': {}, './agents/runtime/wake-bus.js': { deliver: async (agent: string, payload: { kind: string; generation: string }) => {
      assert.ok(sequence.includes('COMMIT'))
      assert.equal(payload.kind, 'stop')
      assert.equal(payload.generation, '3')
      sequence.push(agent)
      if (agent === 'managed') throw new Error('disconnected')
      return 1
    } },
  }
  runInNewContext(code, { exports, require: (name: string) => {
    assert.ok(name in dependencies, name)
    return dependencies[name]
  } })
  const stop = exports.emergencyStop as (company: string, actor: string) => Promise<{ agents: { id: string; status: string }[] }>
  const result = await stop('company-a', 'user-a')
  assert.equal(result.agents.find(a => a.id === 'managed')?.status, 'pending')
  assert.equal(result.agents.find(a => a.id === 'byoa')?.status, 'sent')
  assert.deepEqual(sequence.slice(0, 3), ['BEGIN', 'company-lock', 'COMMIT'])
})
