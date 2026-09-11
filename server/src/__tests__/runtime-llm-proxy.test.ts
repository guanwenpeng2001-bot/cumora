import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { Request, Response } from 'express'
import { parseRuntimeTextRequest, serveRuntimeText, type RuntimeTextDependencies } from '../agents/runtime/llm-proxy.js'
import { callRuntimeLlm, RuntimeLlmError } from '../agents/runtime/llm-http.js'

const request = () => ({ api: 'responses', purpose: 'compaction', args: { input: 'summarize', model: 'configured-model' } })

function fixture(body: unknown = request()) {
  const req = Object.assign(new EventEmitter(), { body })
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(value: unknown) { this.body = value; this.writableEnded = true; return this },
  })
  const serve = (deps: Partial<RuntimeTextDependencies> = {}) => serveRuntimeText(
    { agentId: 'agent-a', companyId: 'company-a' }, req as unknown as Request, res as unknown as Response,
    { authorize: async () => true, execute: async () => ({ output_text: 'done' }), timeoutMs: 1000, ...deps },
  )
  return { req, res, serve }
}

test('runtime text rejects identity, transport, stream and malformed scope injection', () => {
  for (const invalid of [null, [], { ...request(), companyId: 'other' }, { ...request(), agentId: 'other' },
    { ...request(), options: { headers: { Authorization: 'secret' } } }, { ...request(), runId: {} },
    { ...request(), purpose: 'embedding' }, { ...request(), args: { input: 1 } },
    { ...request(), api: ['responses'] }, { ...request(), purpose: ['compaction'] },
    { ...request(), options: { maxRetries: -1 } }, { ...request(), options: { timeout: 0 } },
    ...['apiKey', 'baseURL', 'headers', 'signal', 'fetch', 'timeout', 'maxRetries'].map(key => ({ ...request(), args: { input: 'x', [key]: 'bad' } })),
    { ...request(), args: { input: 'x', stream: true } },
  ]) assert.throws(() => parseRuntimeTextRequest(invalid))
  assert.deepEqual(parseRuntimeTextRequest(request()), request())
  assert.equal(parseRuntimeTextRequest({ api: 'chat', purpose: 'agenda', args: { messages: [] } }).api, 'chat')
})

test('server pins tenant, agent, domain and role before authorization and execution', async () => {
  const f = fixture({ ...request(), runId: 'run-a', conversationId: 'conversation-a' })
  let authorized = false
  await f.serve({ authorize: async context => {
    assert.deepEqual(context, { companyId: 'company-a', agentId: 'agent-a', domain: 'managed', role: 'compaction',
      purpose: 'compaction', runId: 'run-a', conversationId: 'conversation-a' })
    authorized = true
    return true
  }, execute: async (context, api, args, options) => {
    assert.ok(authorized)
    assert.equal(context.companyId, 'company-a')
    assert.equal(api, 'responses')
    assert.equal(args.input, 'summarize')
    assert.equal(options.signal.aborted, false)
    return { output_text: 'done', usage: { input_tokens: 4 } }
  } })
  assert.equal(f.res.statusCode, 200)
  assert.deepEqual(f.res.body, { output_text: 'done', usage: { input_tokens: 4 } })
  assert.equal(f.req.listenerCount('aborted'), 0)
  assert.equal(f.res.listenerCount('close'), 0)
})

test('invalid or unauthorized runtime text never executes a provider call', async () => {
  for (const [body, status] of [[null, 400], [request(), 403]] as const) {
    const f = fixture(body)
    await f.serve({ authorize: async () => false, execute: async () => { assert.fail('provider called') } })
    assert.equal(f.res.statusCode, status)
  }
})

test('provider status survives but secrets and upstream error bodies never cross the boundary', async () => {
  for (const status of [401, 403, 429, 503, undefined, 200, NaN]) {
    const f = fixture()
    await f.serve({ execute: async () => { throw Object.assign(new Error('secret-key upstream.example'), { status }) } })
    assert.equal(f.res.statusCode, status && status >= 400 ? status : 502)
    assert.deepEqual(f.res.body, { error: 'runtime LLM execution failed' })
  }
})

test('disconnect and deadline abort the actual executor signal and clean up listeners', async () => {
  for (const disconnected of [true, false]) {
    const f = fixture()
    let aborted = false
    await f.serve({ timeoutMs: 10, execute: async (_context, _api, _args, { signal }) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true })
        if (disconnected) { f.res.destroyed = true; f.res.emit('close') }
      })
    } })
    assert.ok(aborted)
    assert.equal(f.res.statusCode, disconnected ? 200 : 504)
    assert.equal(f.res.listenerCount('close'), 0)
  }
})

const clientOptions = { baseUrl: 'https://runtime.invalid/runtime/', token: 'runtime-token' }
test('runtime client sends only to runtime and never retries failed or malformed responses', async () => {
  for (const status of [401, 403, 429, 502, 200]) {
    let attempts = 0
    await assert.rejects(callRuntimeLlm('text', request(), { ...clientOptions, fetchImpl: async (url, init) => {
      attempts++
      assert.equal(url, 'https://runtime.invalid/runtime/llm/text')
      assert.equal(init?.redirect, 'error')
      assert.equal((init?.headers as Record<string, string> | undefined)?.Authorization, 'Bearer runtime-token')
      return new Response('secret-key or malformed JSON', { status })
    } }), (error: unknown) => error instanceof RuntimeLlmError && !error.message.includes('secret-key')
      && error.status === (status === 200 ? undefined : status))
    assert.equal(attempts, 1)
  }
})

test('runtime client preserves cancellation and bounds network and response-body waits', async () => {
  const controller = new AbortController()
  const reason = new DOMException('cancelled', 'AbortError')
  controller.abort(reason)
  await assert.rejects(callRuntimeLlm('text', request(), { ...clientOptions, signal: controller.signal,
    fetchImpl: async () => { assert.fail('fetch after cancellation') } }), error => error === reason)
  await assert.rejects(callRuntimeLlm('text', request(), { ...clientOptions, timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    }),
  }), (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError')
  await assert.rejects(callRuntimeLlm('text', request(), { ...clientOptions,
    fetchImpl: async () => { throw new Error('network secret') },
  }), /Runtime LLM unavailable/)
})

test('HTTP tracked text delegates before resolving credentials, pricing or ledger locally', async () => {
  const source = readFileSync(new URL('../llm-execution.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('llm-execution.ts', source, ts.ScriptTarget.Latest, true)
  const entry = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'executeTrackedText')!
  const compiled = ts.transpileModule(entry.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports: Record<string, any> = {}
  const calls: unknown[][] = []
  const result = { output_text: 'proxied' }
  new Function('exports', 'require', 'process', compiled)(exports, (name: string) => {
    assert.equal(name, './agents/runtime/llm-http.js')
    return { callRuntimeLlm: async (...args: unknown[]) => { calls.push(args); return result } }
  }, { env: { CUMORA_RUNTIME_CLIENT: 'http' } })
  const signal = new AbortController().signal
  assert.equal(await exports.executeTrackedText({ companyId: 'company-a', agentId: 'agent-a',
    purpose: 'compaction', runId: 'run-a', conversationId: 'conversation-a' }, 'responses',
  { input: 'summarize', signal }, { signal, maxRetries: 2, timeout: 1000 }), result)
  assert.deepEqual(calls, [['text', { api: 'responses', purpose: 'compaction', args: { input: 'summarize' },
    runId: 'run-a', conversationId: 'conversation-a', options: { maxRetries: 2, timeout: 1000 },
  }, { signal }]])
})

test('mounted text endpoint gates run and conversation ownership before execution', async () => {
  const source = readFileSync(new URL('../agents/runtime/server.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
  const route = ast.statements.find(node => ts.isExpressionStatement(node)
    && node.getText(ast).startsWith("runtimeRouter.post('/llm/text'"))!
  const compiled = ts.transpileModule(route.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const denied of ['run', 'conversation', 'assignment', null]) {
    let handler: ((claims: unknown, req: unknown, res: unknown) => Promise<void>) | undefined
    const checked: string[] = []
    let calls = 0
    const deps = {
      runtimeRouter: { post: (path: string, fn: typeof handler) => { assert.equal(path, '/llm/text'); handler = fn } },
      withAgent: (fn: unknown) => fn, serveRuntimeText, automationNumber: () => 1000,
      executeTrackedText: async () => { calls++; return { output_text: 'done' } },
      withRuntimeAgentRunAuthorization: async (args: { agentId: string; companyId: string; runIds: string[] }) => {
        checked.push('run')
        assert.equal(args.agentId, 'agent-a'); assert.equal(args.companyId, 'company-a')
        assert.deepEqual(args.runIds, ['run-a'])
        return { authorized: denied !== 'run' }
      },
      withRuntimeConversationAuthorization: async (args: { agentId: string; companyId: string; conversationIds: string[] }) => {
        checked.push('conversation')
        assert.equal(args.agentId, 'agent-a'); assert.equal(args.companyId, 'company-a')
        assert.deepEqual(args.conversationIds, ['conversation-a'])
        return { authorized: denied !== 'conversation' }
      },
      isRuntimeAgentAuthorized: async () => { checked.push('assignment'); return denied !== 'assignment' },
    }
    new Function(...Object.keys(deps), compiled)(...Object.values(deps))
    const f = fixture({ ...request(), runId: 'run-a', conversationId: 'conversation-a' })
    await handler!({ sub: 'agent-a', companyId: 'company-a' }, f.req, f.res)
    assert.equal(calls, denied ? 0 : 1)
    assert.equal(f.res.statusCode, denied ? 403 : 200)
    assert.deepEqual(checked, denied === 'run' ? ['run'] : denied === 'conversation' ? ['run', 'conversation'] : ['run', 'conversation', 'assignment'])
  }
})
