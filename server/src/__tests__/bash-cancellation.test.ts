import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { ToolResult } from '../agents/tools-shared.js'

const require = createRequire(import.meta.url)
function fixture() {
  const source = ts.createSourceFile('tools-shared.ts', readFileSync(new URL('../agents/tools-shared.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const functions = source.statements.filter(n => ts.isFunctionDeclaration(n) && ['tBash', 'shellSingleQuote'].includes(n.name?.text ?? ''))
  const code = ts.transpileModule(functions.map(n => n.getText(source)).join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { destroy() {} }),
    stderr: Object.assign(new EventEmitter(), { destroy() {} }),
    pid: 123, killed: false, exitCode: null as number | null, signalCode: null as string | null,
    kill(signal: string) { child.killed = true; kills.push(signal); return true },
  })
  const kills: string[] = []
  let spawned!: () => void
  const ready = new Promise<void>(resolve => { spawned = resolve })
  let escalate: (() => void) | undefined
  const exports: { tBash?: (args: unknown, id: string, ns: null, signal?: AbortSignal) => Promise<ToolResult> } = {}
  runInNewContext(code, {
    exports, process, Buffer, Date,
    require(name: string) { return name === 'node:child_process' ? { spawn: () => { spawned(); return child } } : require(name) },
    setTimeout(callback: () => void) { escalate = callback; return 1 },
    clearTimeout() { escalate = undefined },
    parseCliSideEffectsWriteFailureMarker: () => [],
  })
  return { run: (signal?: AbortSignal) => exports.tBash!({ command: 'test-command' }, 'agent', null, signal), ready, child, kills, escalate: () => escalate?.(), hasTimer: () => !!escalate }
}

for (const [code, signal, ok] of [[0, null, true], [7, null, false], [null, 'SIGTERM', false], [null, 'SIGKILL', false]] as const) {
  test(`bash exit ${code}/${signal} reports success=${ok}`, async () => {
    const f = fixture()
    const result = f.run()
    await f.ready
    f.child.emit('close', code, signal)
    const r = await result
    assert.equal(r.ok, ok)
    assert.equal((r.output as { exitCode: number | null }).exitCode, code)
    if (!ok) assert.ok(r.error)
  })
}

test('bash cancellation escalates even though SIGTERM set child.killed, then removes timers and listener', async () => {
  const f = fixture()
  const controller = new AbortController()
  const result = f.run(controller.signal)
  await f.ready
  controller.abort()
  assert.deepEqual(f.kills, ['SIGTERM'])
  assert.equal(f.child.killed, true)
  f.escalate()
  assert.deepEqual(f.kills, ['SIGTERM', 'SIGKILL'])
  f.child.emit('close', null, 'SIGKILL')
  const r = await result
  assert.equal(r.ok, false)
  assert.equal(r.aborted, true)
  assert.equal(f.hasTimer(), false)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('bash normal completion removes abort listener; a later cancellation cannot kill an old PID', async () => {
  const f = fixture()
  const controller = new AbortController()
  const result = f.run(controller.signal)
  await f.ready
  f.child.emit('close', 0, null)
  await result
  controller.abort()
  assert.deepEqual(f.kills, [])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('already cancelled bash does not spawn', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  assert.equal((await f.run(controller.signal)).aborted, true)
  assert.deepEqual(f.kills, [])
})


function toolBatchFixture() {
  const source = readFileSync(new URL('../agents/turn.ts', import.meta.url), 'utf8')
  const start = source.indexOf('    const batchAbortController = new AbortController()')
  const end = source.indexOf('    const anyAborted =', start)
  assert.ok(start >= 0 && end > start)
  const code = ts.transpileModule(`async function run(options) { ${source.slice(start, end)} return toolResults }; run`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const signals: AbortSignal[] = []
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  let cleared = false
  function pending(signal: AbortSignal) {
    signals.push(signal)
    if (signals.length === 2) ready()
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new Error('cancelled'))
      else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  }
  const run = runInNewContext(code, {
    AbortController, Date, Promise, agentId: 'test', runId: 'test', runCompanyId: 'test', hop: 0, namespace: null,
    toolCalls: [{ name: 'bash', arguments: '{}', call_id: '1' }, { name: 'mcp__test__wait', arguments: '{}', call_id: '2' }],
    parseToolArgs: JSON.parse, runtime: { recordEvent: async () => {} },
    registerActiveToolBatch() {}, clearActiveToolBatch() { cleared = true },
    splitPrefixedToolName: (name: string) => name.startsWith('mcp__') ? { connector: 'test' } : null,
    executePodTool: ({ signal }: { signal: AbortSignal }) => pending(signal),
    mcpClients: [{ connector: 'test', callTool: (_name: string, _args: unknown, signal: AbortSignal) => pending(signal) }],
    errorText: String,
  }) as (options: { signal: AbortSignal }) => Promise<Array<{ result: ToolResult }>>
  return { run, started, signals, cleared: () => cleared }
}

for (const preAborted of [false, true]) test(`turn cancellation reaches Bash and MCP batch (already aborted=${preAborted})`, async () => {
  const f = toolBatchFixture()
  const controller = new AbortController()
  if (preAborted) controller.abort()
  const running = f.run({ signal: controller.signal })
  await f.started
  controller.abort()
  const results = await running
  assert.equal(results.length, 2)
  assert.ok(results.every(r => !r.result.ok))
  assert.ok(f.signals.every(s => s.aborted))
  assert.equal(f.cleared(), true)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
