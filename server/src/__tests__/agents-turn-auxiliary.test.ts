import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { TurnSafetyGrace, TURN_SAFETY_PROBE, boundedSafetyProbe } from '../turn-safety-policy.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { compactHistoryWithSummary } from '../agents/turn-compaction.js'
import * as compaction from '../agents/turn-compaction.js'

import { batch, compile, failure, fixture, invoke, read } from './llm-stream-fixture.js'

for (const purpose of ['completion-verify', 'compaction', 'steer-summary']) {
  test(`${purpose}: first iteration failure switches its own chain and records each attempt`, async () => {
    const text = purpose === 'completion-verify' ? '{"complete":false,"reason":"missing","next_step":"deliver"}' : 'fresh summary'
    const { turn, records, requests } = fixture(async function* (request) {
      if (request.model === 'same') { yield { type: 'response.created', response: { model: 'actual-primary' } }; yield { type: 'response.output_text.delta', delta: 'discarded partial' }; throw failure() }
      yield { type: 'response.output_text.done', text }
      yield { type: 'response.completed', response: { model: 'actual-backup', usage: { input_tokens: 4, output_tokens: 2 } } }
    })
    const result = await invoke(turn, purpose)
    assert.deepEqual(requests.map(r => r.model), ['same', `${purpose}-backup`])
    assert.equal(records.length, 2)
    assert.equal(records[0].usage, null)
    assert.equal(records[1].model, 'actual-backup')
    assert.deepEqual(records.map(r => r.extras.attempt), [1, 2])
    assert.ok(records.every(r => r.extras.role === 'compaction' && r.extras.purpose === purpose))
    assert.equal(records[0].extras.logicalCallId, records[1].extras.logicalCallId)
    if (purpose === 'completion-verify') assert.equal(result.nextStep, 'deliver')
    else { assert.match(result, /fresh summary/); assert.doesNotMatch(result, /discarded partial/) }
  })
}

test('steer exhaustion preserves truncated original with conversation and draft', async () => {
  const { turn, records } = fixture(/** biome-ignore lint/correctness/useYield: stream that fails before its first event */ async function* () { throw failure() })
  const result = await invoke(turn, 'steer-summary')
  assert.equal(records.length, 2)
  assert.equal(result, turn.renderSteerBatchTruncated(batch, 'draft'))
  assert.match(result, /c-one/)
  assert.match(result, /plus 3 more messages elided/)
  assert.ok(result.length < batch.reduce((sum, item) => sum + item.body.length, 0))
})

test('invalid verifier JSON stops without trying another model', async () => {
  const { turn, records } = fixture(async function* () { yield { type: 'response.output_text.done', text: 'invalid' }; yield { type: 'response.completed', response: {} } })
  await assert.rejects(invoke(turn, 'completion-verify'), /invalid JSON/)
  assert.equal(records.length, 1)
})

test('chat fallback consumes usage and translates the private prompt', async () => {
  const { turn, records, requests } = fixture(async function* (request) {
    if (request.model === 'same') throw failure()
    yield { choices: [{ delta: { content: 'chat summary' }, finish_reason: 'stop' }], model: 'chat-actual', usage: { prompt_tokens: 7, completion_tokens: 3 } }
  }, 'chat')
  assert.equal(await invoke(turn, 'compaction'), 'chat summary')
  assert.equal(requests[1].messages[0].role, 'system')
  assert.equal(records[1].extras.usageProtocol, 'chat')
  assert.equal(records[1].model, 'chat-actual')
  assert.ok(records[1].usage)
})

test('cancellation in the consumer never advances', async () => {
  const ctrl = new AbortController()
  const { turn, records, requests } = fixture(async function* (_request, signal) {
    assert.equal(signal?.aborted, false)
    ctrl.abort(new Error('cancelled'))
    yield { type: 'response.output_text.delta', delta: 'partial' }
  })
  await assert.rejects(turn.executeAuxiliaryStream({ purpose: 'compaction', companyId: null, agentId: 'a', instructions: '', input: [], outputTokens: 10, signal: ctrl.signal, parse: (s: string) => s }), /cancelled/)
  assert.equal(requests.length, 1)
  assert.equal(records[0].extras.stopReason, 'cancelled')
})

test('summary chain exhaustion still drops history and inserts its marker', async () => {
  const { turn, records } = fixture(/** biome-ignore lint/correctness/useYield: stream that fails before its first event */ async function* () { throw failure() })
  const history: any[] = [{ type: 'message', role: 'user', content: 'original request' }]
  for (let i = 0; i < 12; i++) history.push(
    { type: 'function_call', call_id: String(i), name: 'bash', arguments: '{}' },
    { type: 'function_call_output', call_id: String(i), output: 'earlier work' },
  )
  const result = await compactHistoryWithSummary(history, () => true,
    items => turn.summarizeHistoryItems(items, { name: 'Agent', model: 'same' }, null, 'a'))
  assert.equal(records.length, 2)
  assert.equal(records[1].extras.stopReason, 'exhausted')
  assert.equal(result.usedLlmSummary, false)
  assert.ok(result.droppedPairCount > 0)
  assert.match(JSON.stringify(result.newHistory), /auto-compaction/)
  assert.match(JSON.stringify(result.newHistory), /original request/)
  const calls = result.newHistory.filter((x: any) => x.type === 'function_call').map((x: any) => x.call_id)
  const outputs = result.newHistory.filter((x: any) => x.type === 'function_call_output').map((x: any) => x.call_id)
  assert.deepEqual(outputs, calls)
  assert.deepEqual(calls, ['10', '11'])
})

for (const status of [401, 403, 429]) test(`stream creation HTTP ${status} is accounted before fallback`, async () => {
  const { turn, records, requests } = fixture((request) => {
    if (request.model === 'same') throw Object.assign(new Error('upstream failed'), { status })
    return (async function* () { yield { type: 'response.output_text.done', text: 'recovered' }; yield { type: 'response.completed', response: {} } })()
  })
  assert.equal(await invoke(turn, 'compaction'), 'recovered')
  assert.equal(requests.length, 2)
  assert.equal(records.length, 2)
  assert.equal(records[0].extras.failureReason, `upstream-http-${status}`)
})


async function budgetPlan(f: ReturnType<typeof fixture>, windows: number[]) {
  const plan = await f.resolver.resolveRoleCall(null, 'server', 'brain', 'agent-turn')
  return { ...plan, candidates: plan.candidates.slice(0, windows.length).map((candidate: any, i: number) => ({
    ...candidate, parameters: { ...candidate.parameters, contextWindow: windows[i], maxOutputTokens: 100 },
  })) }
}
const hopContext = { companyId: null, role: 'brain', purpose: 'agent-turn', extras: { hop: 1 } }

test('turn budget: smaller fallback rejects irreducible input before sending and records preparation failure', async () => {
  const f = fixture(/** biome-ignore lint/correctness/useYield: fake upstream rejection */ async function* () {
    throw Object.assign(new Error('primary unavailable'), { status: 503 })
  })
  const plan = await budgetPlan(f, [10_000, 500])
  await assert.rejects(f.turn.executeAgentTurnHop({ plan, context: hopContext,
    input: [{ role: 'user', content: '中文'.repeat(500) }], instructions: '', tools: [],
    compactionPolicy: { ...compaction.DEFAULT_COMPACTION_POLICY, autoEnabled: false },
  }), /input exceeds context budget/)
  assert.equal(f.requests.length, 1)
  assert.equal(f.records.length, 2)
  assert.equal(f.records[1].extras.failureStage, 'prepare')
  assert.equal(f.records[1].status, 'failed')
  assert.equal(f.records[1].usage, null)
})

test('turn budget: Chinese tool history fits a smaller fallback with automatic summaries disabled', async () => {
  const f = fixture(async function* (request) {
    if (request.model === 'same') throw Object.assign(new Error('primary unavailable'), { status: 503 })
    yield { type: 'response.completed', response: { model: 'brain-backup', output: [], usage: { input_tokens: 500, output_tokens: 10 } } }
  })
  const plan = await budgetPlan(f, [100_000, 1500])
  const input: any[] = [{ role: 'user', content: '继续处理中文任务' }]
  for (let i = 0; i < 30; i++) input.push(
    { type: 'function_call', call_id: String(i), name: 'bash', arguments: '{}' },
    { type: 'function_call_output', call_id: String(i), output: '中文😀'.repeat(100) },
  )
  const result = await f.turn.executeAgentTurnHop({ plan, context: hopContext, input, instructions: 'continue', tools: [],
    compactionPolicy: { ...compaction.DEFAULT_COMPACTION_POLICY, autoEnabled: false, outputBytes: 300, keepRecentPairs: 3 },
  })
  assert.equal(f.requests.length, 2)
  assert.equal(result.state.actualModel, 'brain-backup')
  assert.ok(compaction.estimateHistoryTokens(result.input) <= Math.floor(1500 * 0.95))
  assert.ok(result.input.length < input.length)
  const calls = new Set(result.input.filter((x: any) => x.type === 'function_call').map((x: any) => x.call_id))
  for (const item of result.input) if (item.type === 'function_call_output') {
    assert.ok(calls.has(item.call_id))
    assert.equal(Buffer.from(item.output).toString('utf8'), item.output)
  }
  for (const id of ['27', '28', '29']) assert.ok(calls.has(id))
  assert.deepEqual(f.records.map(r => r.extras.attempt), [1, 2])
  assert.ok(f.records.every(r => r.extras.hop === 1), 'fallback attempts stay within the same hop')
})

test('context window: catalog value wins; unknown models log and mark fallback', async () => {
  const f = fixture(async function* () { yield { type: 'response.completed', response: { output: [] } } })
  assert.equal(f.turn.contextWindowFor('gpt-5.4-mini'), 128_000)
  assert.equal(f.turn.contextWindowFor('gpt-5.5'), 200_000)
  assert.deepEqual(f.turn.resolveContextWindow('kimi-for-coding', 256_000), { tokens: 256_000, source: 'catalog' })
  assert.deepEqual(f.turn.resolveContextWindow('gpt-5.4-mini'), { tokens: 128_000, source: 'family' })
  const warnings: string[] = []
  const old = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    assert.deepEqual(f.turn.resolveContextWindow('kimi-for-coding'), { tokens: 200_000, source: 'unknown-fallback' })
    const plan = await f.resolver.resolveRoleCall(null, 'server', 'brain', 'agent-turn')
    const unknown = { ...plan, candidates: [{
      ...plan.candidates[0], model: 'kimi-for-coding', requestModel: 'kimi-for-coding',
      parameters: { maxOutputTokens: 100 }, available: true, protocol: 'responses',
      route: plan.candidates[0].route, capabilities: {},
    }] }
    await f.turn.executeAgentTurnHop({ plan: unknown, context: hopContext,
      input: [{ role: 'user', content: 'hi' }], instructions: '', tools: [] })
  } finally { console.warn = old }
  assert.ok(warnings.some(text => /unknown context window for model kimi-for-coding/.test(text)))
  assert.equal(f.records[0].extras.contextWindowSource, 'unknown-fallback')
  assert.equal(f.records[0].extras.contextWindow, 200_000)
})

test('turn budget: configured hard ratio rejects input even when the physical window could fit it', async () => {
  const f = fixture(async function* () { yield { type: 'response.completed', response: { output: [] } } })
  const plan = await budgetPlan(f, [1000])
  await assert.rejects(f.turn.executeAgentTurnHop({ plan, context: hopContext,
    input: [{ role: 'user', content: '中'.repeat(600) }], instructions: '', tools: [],
    compactionPolicy: { ...compaction.DEFAULT_COMPACTION_POLICY, softRatio: 0.4, hardRatio: 0.5 },
  }), /input exceeds context budget/)
  assert.equal(f.requests.length, 0)
  assert.equal(f.records.length, 1)
  assert.equal(f.records[0].extras.failureStage, 'prepare')
  assert.equal(f.records[0].extras.stopReason, 'exhausted')
})


test('managed turn deadline freezes policy once, propagates cancellation and clears its timer', async () => {
  const source = read('../agents/turn.ts')
  const ast = ts.createSourceFile('turn.ts', source, ts.ScriptTarget.Latest, true)
  const wrapper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runAgentTurn')!
  let reads = 0, scheduled = 0, cleared = 0
  let timeout: (() => void) | undefined
  const policy = Object.freeze({ maxHops: 7, timeoutMs: 25 })
  const timer = { unref() {} }
  const turn = compile(wrapper.getText(ast), {}, {
    TurnSafetyGrace, TURN_SAFETY_PROBE, boundedSafetyProbe,
    withServerSettingsSnapshot: (work: () => unknown) => work(),
    runtime: { admitTurn: async () => ({ allowed: true }) },
    getTurnBudgetPolicy: () => { reads++; return policy },
    setTimeout(fn: () => void, ms: number) { scheduled++; assert.equal(ms, 25); timeout = fn; return timer },
    clearTimeout(value: unknown) { assert.equal(value, timer); cleared++ },
    runAgentTurnWithBudget: async (_id: string, options: any, captured: unknown) => {
      assert.equal(captured, policy)
      assert.equal(options.signal.aborted, false)
      timeout!()
      options.signal.throwIfAborted()
    },
  })
  await assert.rejects(turn.runAgentTurn('a'), /Managed turn deadline exceeded/)
  assert.equal(reads, 1)
  assert.equal(scheduled, 1)
  assert.equal(cleared, 1)
})

test('managed turn deadline zero schedules no timer and preserves caller cancellation', async () => {
  const source = read('../agents/turn.ts')
  const ast = ts.createSourceFile('turn.ts', source, ts.ScriptTarget.Latest, true)
  const wrapper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runAgentTurn')!
  const caller = new AbortController()
  const turn = compile(wrapper.getText(ast), {}, {
    TurnSafetyGrace, TURN_SAFETY_PROBE, boundedSafetyProbe,
    withServerSettingsSnapshot: (work: () => unknown) => work(),
    runtime: { admitTurn: async () => ({ allowed: true }) },
    getTurnBudgetPolicy: () => ({ timeoutMs: 0, maxHops: 200 }),
    setTimeout() { assert.fail('timeout=0 must not create a timer') },
    clearTimeout() { assert.fail('no timer to clear') },
    runAgentTurnWithBudget: async (_id: string, options: any) => {
      caller.abort(new Error('caller cancelled'))
      options.signal.throwIfAborted()
    },
  })
  await assert.rejects(turn.runAgentTurn('a', { signal: caller.signal }), /caller cancelled/)
})


test('turn output byte head and summarizer input keep complete Unicode code points', () => {
  const f = fixture(async function* () { yield { type: 'response.completed', response: { output: [] } } })
  assert.equal(f.turn.utf8Head('a中😀尾', 7), 'a中')
  assert.equal(f.turn.utf8Head('a中😀尾', 8), 'a中😀')
  const text = f.turn.formatItemsForSummary([{ type: 'function_call_output', call_id: 'c', output: '中'.repeat(1199) + '😀尾' }])
  assert.ok(text.endsWith('😀'))
  assert.equal(Buffer.from(text).toString('utf8'), text)
})

for (const protocol of ['responses', 'chat']) test(`${protocol}: premature EOF preserves usage and advances without publishing partial summary`, async () => {
  const f = fixture(async function* (request) {
    const text = request.model === 'same' ? 'partial-summary' : 'complete-summary'
    if (protocol === 'chat') {
      yield { choices: [{ delta: { content: text } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }
      if (request.model !== 'same') yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
    } else {
      yield { type: 'response.output_text.delta', delta: text }
      yield { type: 'response.created', response: { usage: { input_tokens: 7, output_tokens: 3 } } }
      if (request.model !== 'same') yield { type: 'response.completed', response: {} }
    }
  }, protocol)
  assert.equal(await invoke(f.turn, 'compaction'), 'complete-summary')
  assert.deepEqual(f.requests.map(r => r.model), ['same', 'compaction-backup'])
  assert.equal(f.records[0].extras.stopReason, 'advance')
  assert.equal(f.records[0].extras.measurement, 'measured')
  assert.ok(f.records[0].usage)
  assert.equal(f.records[1].extras.stopReason, 'completed')
})

test('premature EOF exhaustion uses the existing truncated steer fallback', async () => {
  const f = fixture(async function* () { yield { type: 'response.output_text.delta', delta: 'partial' } })
  assert.equal(await invoke(f.turn, 'steer-summary'), f.turn.renderSteerBatchTruncated(batch, 'draft'))
  assert.equal(f.records.length, 2)
  assert.equal(f.records[1].extras.stopReason, 'exhausted')
})

test('compaction consumes a stalled stream within its own configured deadline with turn timeout zero', async () => {
  let aborted = false
  const f = fixture((request, signal) => {
    if (request.model !== 'same') return (async function* () {
      yield { type: 'response.output_text.done', text: 'bounded recovery' }
      yield { type: 'response.completed', response: {} }
    })()
    signal?.addEventListener('abort', () => { aborted = true }, { once: true })
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
  }, 'responses', 15)
  assert.equal(await invoke(f.turn, 'compaction'), 'bounded recovery')
  assert.equal(aborted, true)
  assert.equal(f.records[0].extras.failureReason, 'transport:ETIMEDOUT')
  assert.equal(f.records.length, 2)
})

for (const finish of ['length', 'content_filter', 'tool_calls']) test(`chat ${finish} cannot commit a truncated summary`, async () => {
  const f = fixture(async function* () { yield { choices: [{ delta: { content: 'partial' }, finish_reason: finish }] } }, 'chat')
  await assert.rejects(invoke(f.turn, 'compaction'), /Auxiliary chat ended/)
  assert.ok(f.records.every(r => r.status !== 'ok'))
})

for (const boundary of ['text', 'tool']) test(`private ${boundary} followed by failure allows fallback and discards the failed buffer`, async () => {
  const f = fixture(async function* (request) {
    if (request.model === 'same') {
      if (boundary === 'tool') yield { type: 'response.output_item.added', item: { id: 't', type: 'function_call', call_id: 'discard', name: 'bash', arguments: '' } }
      else yield { type: 'response.output_text.delta', item_id: 't', content_index: 0, delta: 'private draft' }
      throw Object.assign(new Error('upstream failed'), { status: 503 })
    }
    yield { type: 'response.completed', response: { output: [] } }
  })
  const result = await f.turn.executeAgentTurnHop({ plan: await budgetPlan(f, [10_000, 10_000]), context: hopContext, input: [], instructions: '', tools: [] })
  assert.deepEqual(f.requests.map(r => r.model), ['same', 'brain-backup'])
  assert.equal(f.records[0].extras.stopReason, 'advance')
  assert.deepEqual(result.state.pendingTools, {})
  assert.equal(result.state.responseTextByPart.size, 0)
})

test('real tool dispatch failure returns a tool result without replaying the completed model hop', async () => {
  const f = fixture(async function* () {
    yield { type: 'response.completed', response: { output: [{ type: 'function_call', id: 't', call_id: 'call', name: 'bash', arguments: '{}' }] } }
  })
  const result = await f.turn.executeAgentTurnHop({ plan: await budgetPlan(f, [10_000, 10_000]), context: hopContext, input: [], instructions: '', tools: [] })
  const source = read('../agents/turn.ts')
  const ast = ts.createSourceFile('turn.ts', source, ts.ScriptTarget.Latest, true)
  let initializer: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'toolResults') initializer = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(initializer)
  let executions = 0
  const dispatch = compile(`export async function dispatch() { return ${initializer.getText(ast)} }`, {}, {
    toolCalls: Object.values(result.state.pendingTools), parseToolArgs: JSON.parse,
    runId: 'run', agentId: 'a', runCompanyId: null, hop: 0, namespace: {},
    runtime: { recordEvent: async () => {} }, splitPrefixedToolName: () => null,
    batchAbortController: new AbortController(), errorText: String, options: {}, clearActiveToolBatch: () => {},
    executePodTool: async () => { executions++; throw failure() },
  })
  const results = await dispatch.dispatch()
  assert.equal(executions, 1)
  assert.equal(results[0].result.ok, false)
  assert.equal(results[0].result.display.status, 'crashed')
  assert.equal(f.requests.length, 1, 'tool failure must not reopen the model fallback chain')
})

test('managed turn shares a complete snapshot across hops and auxiliary reads; next turn refreshes', async () => {
  const f = fixture(async function* () {
    yield { type: 'response.output_text.done', text: 'summary' }
    yield { type: 'response.completed', response: { output: [] } }
  })
  const source = read('../agents/turn.ts')
  const ast = ts.createSourceFile('turn.ts', source, ts.ScriptTarget.Latest, true)
  const wrapper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runAgentTurn')!
  const settingsSource = read('../settings.ts')
  const settingsAst = ts.createSourceFile('settings.ts', settingsSource, ts.ScriptTarget.Latest, true)
  const capture = settingsAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'withServerSettingsSnapshot')!
  const realCapture = compile(capture.getText(settingsAst), { 'node:async_hooks': { AsyncLocalStorage } }, {
    getServerSettingsSnapshot: f.settings.getServerSettingsSnapshot, settingsContext: f.snapshots,
  }).withServerSettingsSnapshot
  const revisions: string[] = []
  const turn = compile(wrapper.getText(ast), {}, {
    withServerSettingsSnapshot: realCapture,
    TurnSafetyGrace, TURN_SAFETY_PROBE, boundedSafetyProbe,
    runtime: { admitTurn: async () => ({ allowed: true }) },
    getTurnBudgetPolicy: () => ({ timeoutMs: 0, revision: f.settings.getServerSettingsSnapshot().revision }),
    runAgentTurnWithBudget: async (_id: string, _options: unknown, policy: { revision: string }) => {
      revisions.push(policy.revision)
      const first = await f.resolver.resolveRoleCall(null, 'server', 'brain', 'agent-turn')
      f.refresh()
      await new Promise(resolve => setImmediate(resolve))
      const second = await f.resolver.resolveRoleCall(null, 'server', 'brain', 'agent-turn')
      assert.equal(first.revision, policy.revision)
      assert.equal(second.revision, policy.revision)
      assert.deepEqual(second.candidates, first.candidates)
      await realCapture(async () => {
        assert.equal(f.settings.getServerSettingsSnapshot().revision, policy.revision)
        await invoke(f.turn, 'compaction')
      })
      assert.equal(f.records.at(-1).extras.revision, policy.revision)
    },
  })
  await turn.runAgentTurn('a')
  await turn.runAgentTurn('a')
  assert.deepEqual(revisions, ['17', '18'])
  assert.deepEqual(f.requests.map(r => r.model), ['same', 'new-same'])
})

test('existing integration hop retry scenarios execute with isolated transport and ledger', async t => {
  const f = fixture(async function* () { yield { type: 'response.completed', response: {} } })
  const source = read('../__integration__/agent-error-paths.test.ts')
  const ast = ts.createSourceFile('integration.ts', source, ts.ScriptTarget.Latest, true)
  const block = ast.statements.find(node => ts.isExpressionStatement(node)
    && node.getText(ast).startsWith("test('[integration] turn hop retries each candidate")) as ts.ExpressionStatement
  assert.ok(block)
  const compiled = compile(`export const result = ${block.expression.getText(ast)}`, { '../llm-resolver.js': f.resolver }, {
    test: (name: string, fn: (context: import('node:test').TestContext) => Promise<void>) => t.test(name, fn),
    assert, executeAgentTurnHop: f.turn.executeAgentTurnHop, __setLlmClientOverrideForTesting: f.setClient,
  })
  await compiled.result
})

test('turn defer reports exact unread message boundary and retryAt before returning without acknowledgement', async () => {
  const source = read('../agents/turn.ts')
  const start = source.indexOf('    const reason = verdict.reason.trim()', source.indexOf('const shouldRunInboxTriage'))
  const end = source.indexOf('    triageNote = [', start)
  assert.ok(start > 0 && end > start)
  const deferred: any[] = []
  const f = compile(`export async function report(options, verdict, inbox) {
    const convoIds = ['c']
    ${source.slice(start, end)}
  }`, {}, {
    agentId: 'a',
    runtime: { markConversationRead: () => { assert.fail('defer must not acknowledge messages') } },
  })
  await f.report({ onInboxDeferred: (value: any) => deferred.push(value) },
    { outcome: 'defer', reason: 'rate limited', retryAt: 1_120_000, source: 'rate-limited' },
    [{ id: 'one', conversation_id: 'c' }, { id: 'two', conversation_id: 'c' }])
  assert.deepEqual(deferred, [{ messageIds: ['one', 'two'], retryAt: 1_120_000 }])
})

test('turn budget: a larger fallback recovers from preparation failure without sending the small model', async () => {
  const f = fixture(async function* () {
    yield {type:'response.completed',response:{model:'brain-backup',output:[],usage:{input_tokens:1000,output_tokens:1}}}
  })
  const plan = await budgetPlan(f, [500, 10_000])
  const result = await f.turn.executeAgentTurnHop({plan,context:hopContext,
    input:[{role:'user',content:'中文'.repeat(500)}],instructions:'',tools:[],
    compactionPolicy:{...compaction.DEFAULT_COMPACTION_POLICY,autoEnabled:false},
  })
  assert.equal(result.state.actualModel, 'brain-backup')
  assert.deepEqual(f.requests.map(r => r.model), ['brain-backup'])
  assert.deepEqual(f.records.map(r => r.status), ['failed', 'ok'])
  assert.equal(f.records[0].extras.failureStage, 'prepare')
  assert.equal(f.records[0].extras.nextCandidate, 'brain-backup')
})


for (const usage of [{}, { prompt_tokens: 5 }, { completion_tokens: 3 }, { prompt_tokens: 5, completion_tokens: 3 }]) test('deep-1: main Chat hop records raw usage and honest measurement ' + JSON.stringify(usage), async () => {
  const f = fixture(async function* () {
    yield { model: 'glm-4.6', choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }
    yield { choices: [], usage }
  }, 'chat')
  const result = await f.turn.executeAgentTurnHop({ plan: await budgetPlan(f, [10_000]), context: hopContext, input: [{ role: 'user', content: 'hello' }], instructions: '', tools: [] })
  assert.equal(result.state.completed, true)
  assert.equal(f.records.length, 1)
  assert.deepEqual(f.records[0].extras.rawUsage, usage)
  assert.equal(f.records[0].extras.usageProtocol, 'chat')
  assert.equal(f.records[0].extras.measurement, 'prompt_tokens' in usage && 'completion_tokens' in usage ? 'measured' : 'unknown')
})

for (const finish of ['length', 'content_filter', 'tool_calls']) test('deep-1: main Chat rejects incomplete tools and retains usage: ' + finish, async () => {
  const f = fixture(async function* () {
    yield { model: 'glm-4.6', choices: [{ delta: { tool_calls: [{ index: 0, id: 'A', function: { name: 'bash', arguments: '{' } }] }, finish_reason: finish }] }
    yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }
  }, 'chat')
  await assert.rejects(f.turn.executeAgentTurnHop({ plan: await budgetPlan(f, [10_000]), context: hopContext, input: [], instructions: '', tools: [] }), /incomplete/)
  assert.equal(f.requests.length, 1)
  assert.equal(f.records[0].status, 'failed')
  assert.equal(f.records[0].extras.failureStage, 'execution')
  assert.deepEqual(f.records[0].extras.rawUsage, { prompt_tokens: 5, completion_tokens: 3 })
  assert.equal(f.records[0].usage.outputTokens, 3)
})

test('deep-1: main Chat replays parallel tool calls together then accepts complete tools', async () => {
  const f = fixture(async function* () {
    yield { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'C', function: { name: 'lookup', arguments: '{"id":3}' } },
      { index: 1, id: 'D', function: { name: 'lookup', arguments: '{"id":4}' } },
    ] }, finish_reason: 'tool_calls' }] }
  }, 'chat')
  const result = await f.turn.executeAgentTurnHop({ plan: await budgetPlan(f, [10_000]), context: hopContext, instructions: '', tools: [], input: [
    { type: 'function_call', call_id: 'A', name: 'lookup', arguments: '{}' },
    { type: 'function_call', call_id: 'B', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'A', output: 'one' },
    { type: 'function_call_output', call_id: 'B', output: 'two' },
  ] })
  assert.deepEqual(f.requests[0].messages.map((m: any) => m.role), ['assistant', 'tool', 'tool'])
  assert.deepEqual(f.requests[0].messages[0].tool_calls.map((c: any) => c.id), ['A', 'B'])
  assert.deepEqual(Object.values(result.state.pendingTools).map((c: any) => c.call_id), ['C', 'D'])
  assert.equal(f.records[0].status, 'ok')
})
