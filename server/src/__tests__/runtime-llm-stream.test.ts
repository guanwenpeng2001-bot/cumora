import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, type TestContext } from 'node:test'
import express from 'express'
import type { Request, Response as ExpressResponse } from 'express'
import ts from 'typescript'
import { streamRuntimeLlm } from '../agents/runtime/llm-http.js'
import { parseRuntimeStreamRequest, serveRuntimeStream } from '../agents/runtime/llm-stream.js'
import { DEFAULT_COMPACTION_POLICY } from '../agents/turn-compaction.js'
import { compile, fixture, read } from './llm-stream-fixture.js'

const context = { agentId: 'a', companyId: 'company-a', purpose: 'agent-turn' }
const body = { purpose: 'agent-turn', instructions: 'help', input: [], tools: [] }
const completed = (model = 'actual') => ({ type: 'response.completed', response: {
  id: 'response-1', model, status: 'completed', usage: { input_tokens: 5, output_tokens: 2 }, output: [],
} })

async function serverFixture(t: TestContext, behavior: Parameters<typeof fixture>[0], protocol = 'responses') {
  const f = fixture(behavior, protocol, 500)
  const adapter = compile(read('../agents/runtime/llm-stream-execution.ts'), {
    '../../llm-resolver.js': f.resolver,
    '../../settings.js': { automationNumber: () => 1000, getTurnBudgetPolicy: () => DEFAULT_COMPACTION_POLICY },
    '../personas.js': { getPersona: async () => ({ companyId: context.companyId, model: 'same' }) },
    '../turn.js': f.turn,
    '../model-policy.js': { realTaskModel: (m: string) => m, enforceModelPolicy: (m: string) => m },
  })
  const app = express()
  app.use(express.json())
  app.post('/llm/stream', (req, res) => void serveRuntimeStream(context, req, res, {
    timeoutMs: 1500, authorize: async () => true, execute: adapter.executeRuntimeStream,
  }))
  const server = createServer(app).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = (request: unknown = body, onEvent = async (_kind: string, _data: unknown) => {}, signal?: AbortSignal) =>
    streamRuntimeLlm<any>('stream', request, { baseUrl, token: 'test-runtime-token', onEvent, signal, timeoutMs: 2000 })
  return { ...f, call, baseUrl }
}

test('stream schema rejects scope, route, credential and option injection', () => {
  for (const request of [null, [], { ...body, companyId: 'other' }, { ...body, agentId: 'other' },
    { ...body, plan: {} }, { ...body, apiKey: 'secret' }, { ...body, options: {} },
    { ...body, purpose: 'embedding' }, { ...body, runId: {} }, { ...body, outputTokens: 1 },
    { ...body, tools: null }, { purpose: 'compaction', instructions: '', input: [], outputTokens: 0 },
  ]) assert.throws(() => parseRuntimeStreamRequest(request))
  assert.equal(parseRuntimeStreamRequest(body).purpose, 'agent-turn')
})

test('real HTTP delivers deltas before completion and preserves state, usage and tool calls', async t => {
  let release!: () => void
  const receivedDelta = new Promise<void>(resolve => { release = resolve })
  const f = await serverFixture(t, async function* () {
    yield { type: 'response.output_text.delta', item_id: 'text-1', output_index: 0, content_index: 0, delta: '你好' }
    await receivedDelta
    yield { type: 'response.output_item.added', output_index: 1, item: { id: 'item-1', type: 'function_call', call_id: 'call-1', name: 'bash', arguments: '' } }
    yield { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"command":"pwd"}' }
    yield completed()
  })
  const events: Array<{ kind: string; data: any }> = []
  const result = await f.call(body, async (kind, data) => {
    events.push({ kind, data })
    if (kind === 'delta') release()
  })
  assert.equal(result.state.completed, true)
  assert.equal(result.state.actualModel, 'actual')
  assert.equal(result.state.responseStatus, 'completed')
  assert.equal(result.state.pendingTools['item-1'].arguments, '{"command":"pwd"}')
  assert.deepEqual(result.state.responseTextByPart, [['text-1:0', '你好']])
  assert.equal(events[0].kind, 'request')
  assert.equal(events.filter(e => e.kind === 'attempt').length, 1)
  assert.deepEqual(events.find(e => e.kind === 'attempt')!.data.usage, f.records[0].usage)
  assert.equal(f.records.length, 1)
})

test('failed usage, same-provider retry and eventual success cross HTTP without duplicate records', async t => {
  let sends = 0
  const f = await serverFixture(t, async function* () {
    if (++sends === 1) {
      yield { type: 'response.created', response: { model: 'failed-model', usage: { input_tokens: 3, output_tokens: 1 } } }
      throw Object.assign(new Error('secret-provider-key at https://secret.invalid'), { code: 'ECONNRESET' })
    }
    yield completed('backup-actual')
  })
  const events: Array<{ kind: string; data: any }> = []
  await f.call(body, async (kind, data) => { events.push({ kind, data }) })
  const attempts = events.filter(e => e.kind === 'attempt').map(e => e.data)
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts.map(a => a.extras.attempt), [1, 2])
  assert.equal(attempts[0].extras.logicalCallId, attempts[1].extras.logicalCallId)
  assert.equal(attempts[0].usage.inputTokens, 3)
  assert.equal(attempts[1].usage.inputTokens, 5)
  assert.equal(attempts[0].status, 'failed')
  assert.equal(attempts[1].status, 'ok')
  assert.equal(events.find(e => e.kind === 'retry')!.data.kind, 'model.retry_provider_connection')
  assert.equal(f.records.length, 2)
  assert.doesNotMatch(JSON.stringify(events), /secret-provider-key|secret\.invalid/)
})

test('auxiliary parse failure records measured failure and cannot produce a successful terminal frame', async t => {
  const f = await serverFixture(t, async function* () {
    yield { type: 'response.output_text.delta', delta: 'not a verdict' }
    yield completed()
  })
  const events: string[] = []
  await assert.rejects(f.call({ purpose: 'completion-verify', instructions: '', input: [], outputTokens: 500 },
    async kind => { events.push(kind) }), /execution failed/)
  assert.ok(events.includes('delta'))
  assert.deepEqual(events.filter(kind => kind === 'attempt'), ['attempt'])
  assert.equal(f.records.length, 1)
  assert.equal(f.records[0].status, 'failed')
  assert.equal(f.records[0].usage.inputTokens, 5)
  assert.equal(f.records[0].extras.stopReason, 'non-fallbackable-error')
})

test('auxiliary Chat streams retain raw usage and parse before result', async t => {
  const f = await serverFixture(t, async function* () {
    yield { model: 'chat-actual', choices: [{ delta: { content: ' private summary ' }, finish_reason: null }] }
    yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3 } }
  }, 'chat')
  const attempts: any[] = []
  const result = await f.call({ purpose: 'compaction', instructions: '', input: [], outputTokens: 500 }, async (kind, data) => {
    if (kind === 'attempt') attempts.push(data)
  })
  assert.equal(result, ' private summary ')
  assert.equal(attempts[0].extras.usageProtocol, 'chat')
  assert.equal(attempts[0].extras.rawUsage.prompt_tokens, 8)
  assert.equal(f.records[0].status, 'ok')
})

test('client cancellation aborts the provider and records its failed attempt exactly once', async t => {
  const controller = new AbortController()
  const f = await serverFixture(t, async function* (_request, signal) {
    yield { type: 'response.output_text.delta', delta: 'pending' }
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }))
    signal!.throwIfAborted()
  })
  await assert.rejects(f.call(body, async kind => {
    if (kind === 'delta') controller.abort(new DOMException('User cancelled', 'AbortError'))
  }, controller.signal), /User cancelled/)
  for (let n = 0; n < 100 && !f.records.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].signal.aborted, true)
  assert.equal(f.records.length, 1)
  assert.equal(f.records[0].extras.stopReason, 'cancelled')
})

test('truncated, timed-out and malformed streams are not replayed', async () => {
  let requests = 0
  for (const payload of ['', 'data: {"version":99,"kind":"delta"}\n\n', 'data: invalid\n\n']) {
    await assert.rejects(streamRuntimeLlm('stream', body, { baseUrl: 'http://runtime.invalid', token: 'fake', onEvent: async () => {},
      fetchImpl: async () => { requests++; return new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } }) },
    }))
  }
  assert.equal(requests, 3)
  const signal = AbortSignal.timeout(10)
  await assert.rejects(streamRuntimeLlm('stream', body, { baseUrl: 'http://runtime.invalid', token: 'fake', signal,
    onEvent: async () => {}, fetchImpl: async (_url, init) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true }) },
    }), { headers: { 'Content-Type': 'text/event-stream' } }),
  }), { name: 'TimeoutError' })
})

test('Pod hop dispatches before resolver and delivers attempt observation without a ledger writer', async () => {
  const ast = ts.createSourceFile('turn.ts', read('../agents/turn.ts'), ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'executeAgentTurnHop')!
  const attempts: unknown[] = []
  const pod = compile(fn.getText(ast), { './runtime/llm-http.js': {
    streamRuntimeLlm: async (_path: string, request: Record<string, unknown>, options: { onEvent: (kind: string, data: unknown) => Promise<void> }) => {
      assert.equal(request.purpose, 'agent-turn')
      assert.equal('plan' in request, false)
      await options.onEvent('attempt', { model: 'failed', usage: { inputTokens: 3 } })
      return { input: [], state: { completed: true, responseTextByPart: [['0:0', 'done']] } }
    },
  } }, { process: { env: { CUMORA_RUNTIME_CLIENT: 'http' } } })
  const result = await pod.executeAgentTurnHop({ context, input: [], tools: [], instructions: '',
    onAttempt: async (attempt: unknown) => { attempts.push(attempt) },
    record: async () => { assert.fail('Pod must not write the server ledger') },
  })
  assert.equal(attempts.length, 1)
  assert.equal(result.state.responseTextByPart.get('0:0'), 'done')
})

test('authorization and slow SSE writers are bounded by the deadline and release listeners', async () => {
  for (const stuck of ['authorization', 'writer']) {
    const req = Object.assign(new EventEmitter(), { body })
    const frames: string[] = []
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false, destroyed: false, headersSent: false, statusCode: 200,
      setHeader() {}, flushHeaders() { this.headersSent = true },
      write(frame: string) { frames.push(frame); return false },
      end(frame = '') { frames.push(frame); this.writableEnded = true },
      status(code: number) { this.statusCode = code; return this },
      json(value: unknown) { this.end(JSON.stringify(value)) },
    })
    let calls = 0
    await serveRuntimeStream(context, req as unknown as Request, res as unknown as ExpressResponse, {
      timeoutMs: 15,
      authorize: async () => stuck === 'authorization' ? new Promise<boolean>(() => {}) : true,
      execute: async (_body, _context, _signal, emit) => { calls++; await emit('delta', { text: 'pending' }); return 'unexpected' },
    })
    assert.equal(res.writableEnded, true)
    assert.equal(calls, stuck === 'authorization' ? 0 : 1)
    if (stuck === 'authorization') assert.equal(res.statusCode, 504)
    else assert.match(frames.at(-1)!, /"kind":"error".*"timeout":true/)
    assert.equal(req.listenerCount('aborted'), 0)
    assert.equal(res.listenerCount('close'), 0)
    assert.equal(res.listenerCount('drain'), 0)
  }
})

test('UTF-8 byte splits survive SSE decoding and a stalled observer cannot outlive the deadline', async () => {
  const frames = 'data: ' + JSON.stringify({ version: 1, kind: 'delta', data: '中文🙂' }) + '\n\n'
    + 'data: ' + JSON.stringify({ version: 1, kind: 'result', data: '完成' }) + '\n\n'
  const fetchImpl = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const byte of new TextEncoder().encode(frames)) controller.enqueue(new Uint8Array([byte])); controller.close() },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
  const deltas: unknown[] = []
  assert.equal(await streamRuntimeLlm('stream', body, { baseUrl: 'http://runtime.invalid', token: 'fake', fetchImpl,
    onEvent: async (_kind, data) => { deltas.push(data) },
  }), '完成')
  assert.deepEqual(deltas, ['中文🙂'])
  await assert.rejects(streamRuntimeLlm('stream', body, { baseUrl: 'http://runtime.invalid', token: 'fake', fetchImpl,
    timeoutMs: 10, onEvent: async () => new Promise<void>(() => {}),
  }), { name: 'TimeoutError' })
})

test('mounted stream endpoint checks run, conversation and current placement before execution', async () => {
  const source = read('../agents/runtime/server.ts')
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
  const route = ast.statements.find(node => ts.isExpressionStatement(node)
    && node.getText(ast).startsWith("runtimeRouter.post('/llm/stream'"))!
  const code = ts.transpileModule(route.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  for (const denied of ['run', 'conversation', 'placement', null]) {
    let handler!: (c: unknown, req: unknown, res: unknown) => Promise<void>
    let executions = 0
    const checked: string[] = []
    const dependencies = {
      runtimeRouter: { post: (_path: string, fn: typeof handler) => { handler = fn } },
      withAgent: (fn: unknown) => fn, automationNumber: () => 1000,
      withServerSettingsSnapshot: (fn: () => unknown) => fn(),
      executeRuntimeStream: async () => { executions++ },
      serveRuntimeStream: async (identity: unknown, _req: unknown, _res: unknown, deps: any) => {
        assert.deepEqual(identity, { agentId: 'a', companyId: 'company-a' })
        const ctx = { ...context, runId: 'run-a', conversationId: 'conversation-a' }
        if (await deps.authorize(ctx)) await deps.execute(body, ctx, new AbortController().signal, async () => {})
      },
      withRuntimeAgentRunAuthorization: async (args: any) => {
        checked.push('run'); assert.deepEqual(args.runIds, ['run-a']); return { authorized: denied !== 'run' }
      },
      withRuntimeConversationAuthorization: async (args: any) => {
        checked.push('conversation'); assert.deepEqual(args.conversationIds, ['conversation-a']); return { authorized: denied !== 'conversation' }
      },
      isRuntimeAgentAuthorized: async () => { checked.push('placement'); return denied !== 'placement' },
    }
    new Function(...Object.keys(dependencies), code)(...Object.values(dependencies))
    await handler({ sub: 'a', companyId: 'company-a' }, {}, {})
    assert.equal(executions, denied ? 0 : 1)
    assert.deepEqual(checked, denied === 'run' ? ['run'] : denied === 'conversation' ? ['run', 'conversation'] : ['run', 'conversation', 'placement'])
  }
})
