import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyEngineFailure, engineDiagnosticText, engineFailureOf } from '../agents/computer/engine.js'

test('engine failures are classified into stable machine-readable kinds', () => {
  assert.equal(classifyEngineFailure('No conversation found with session ID: abc', true), 'resume-not-found')
  assert.equal(classifyEngineFailure('maximum context window exceeded'), 'context-overflow')
  assert.equal(classifyEngineFailure('429 Too Many Requests: rate limit reached'), 'rate-limit')
  assert.equal(classifyEngineFailure('Not logged in · Please run /login'), 'authentication')
  assert.equal(classifyEngineFailure('read ECONNRESET: socket hang up'), 'transport')
  assert.equal(classifyEngineFailure('the engine disliked something novel'), 'unknown')
})

test('a missing-session phrase is stale only when resume was attempted', () => {
  assert.equal(classifyEngineFailure('session not found', false), 'unknown')
  assert.equal(classifyEngineFailure('session not found', true), 'resume-not-found')
})

test('diagnostic extraction keeps engine errors but drops successful model prose', () => {
  const diagnostic = engineDiagnosticText([
    '{"type":"assistant","session_id":"abc","message":{"content":"session not found"}}',
    '{"type":"result","is_error":false,"result":"No conversation found"}',
    '{"type":"result","is_error":true,"result":"No conversation found with session ID: abc"}',
    '{"type":"error","error":{"message":"transport closed"}}',
    'plain stderr detail',
  ].join('\n'))

  assert.match(diagnostic, /No conversation found with session ID/)
  assert.match(diagnostic, /transport closed/)
  assert.match(diagnostic, /plain stderr detail/)
  assert.doesNotMatch(diagnostic, /session_id/)
})

test('adapter classifications win and legacy error strings receive a fallback', () => {
  const explicit = { kind: 'authentication', message: 'sign in', diagnostic: 'raw sign in' } as const
  assert.equal(engineFailureOf({ exitCode: 1, error: 'other', failure: explicit }, true), explicit)
  assert.equal(engineFailureOf({ exitCode: 1, error: 'No conversation found with session ID: abc' }, true)?.kind, 'resume-not-found')
  assert.equal(engineFailureOf({ exitCode: 0 }, true), null)
})


test('resume requires an explicitly missing conversation, not a failed operation or missing credential', () => {
  for (const diagnostic of [
    'failed to resume: ECONNRESET', 'unable to resume: network unavailable',
    'thread/resume failed: authentication failed', 'Internal error',
    'no session token: authentication failed', 'no session auth available',
    'session resume request failed: endpoint not found', 'invalid session configuration',
    'unknown session option', 'malformed session ID',
  ]) assert.notEqual(classifyEngineFailure(diagnostic, true), 'resume-not-found', diagnostic)
  for (const diagnostic of [
    'No conversation found with session ID: abc', 'no such session',
    'session not found', 'thread id: abc-123 not found', 'session "abc" does not exist',
    'unknown session id: abc', 'session has expired', 'Session is not active',
    'session not found; authentication failed', 'session not found; ECONNRESET',
  ]) assert.equal(classifyEngineFailure(diagnostic, true), 'resume-not-found', diagnostic)
})

// Compile the existing module in memory so private persistent adapters can be
// exercised on Windows too. Only child_process is replaced: no CLI, process
// management, repository setup or filesystem writes occur in these tests.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import type { EngineAdapter, EngineId, EngineSession, EngineSessionArgs, EngineRunArgs, EngineRunResult } from '../agents/computer/engine.js'

type WireRequest = { id?: number | string; method?: string; type?: string; event?: string; params?: Record<string, unknown> }
class WireChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode = null
  pid = undefined
  requests: WireRequest[] = []
  decoder = new StringDecoder('utf8')
  buffer = ''
  stdin = new Writable({ write: (chunk, _encoding, callback) => {
    this.buffer += this.decoder.write(chunk)
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl); this.buffer = this.buffer.slice(nl + 1)
      try {
        const request = JSON.parse(line) as WireRequest
        this.requests.push(request)
        queueMicrotask(() => this.respond(request))
      } catch { /* one-shot text */ }
    }
    callback()
  } })
  constructor(readonly respond: (request: WireRequest) => void = () => {}) { super() }
  frame(message: unknown): void { this.stdout.write(JSON.stringify(message) + '\n') }
  close(code = 0): void { this.exitCode = code; this.emit('close', code, null) }
  kill(): boolean { this.close(130); return true }
}

const engineUrl = new URL('../agents/computer/engine.ts', import.meta.url)
const compiledEngine = transpileModule(readFileSync(engineUrl, 'utf8') + `
export const contractInternals = { ClaudeSession, CodexSession, GrokSession, ZcodeSession, PiSession, AntigravitySession, KimiSession, spawnEngine, spawnCodexExec }
`, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true } }).outputText
const engineRequire = createRequire(engineUrl)
function loadWireEngine(child: WireChild) {
  let spawns = 0
  const module = { exports: {} as Record<string, unknown> }
  const require = (name: string): unknown => name === 'node:child_process'
    ? { spawn: () => { spawns++; return child }, execFile: () => { throw new Error('unexpected execFile') }, execFileSync: () => { throw new Error('unexpected execFileSync') } }
    : engineRequire(name)
  new Function('require', 'module', 'exports', compiledEngine)(require, module, module.exports)
  type Constructor = new (...args: unknown[]) => EngineSession
  const internals = module.exports.contractInternals as Record<string, Constructor> & {
    spawnEngine: (bin: string, argv: string[], args: EngineRunArgs, options: object) => Promise<EngineRunResult>
    spawnCodexExec: (bin: string, argv: string[], args: EngineRunArgs, options: object) => Promise<EngineRunResult>
  }
  const opts: EngineSessionArgs = { home: tmpdir(), env: { PATH: '', CUMORA_ZCODE_ACP_BIN: 'fake.cjs' }, onLog: () => {} }
  function session(name: string, extra: Partial<EngineSessionArgs> = {}): EngineSession {
    const o = { ...opts, ...extra }
    const C = internals[name + 'Session']
    if (name === 'Claude') return new C('fake', [], o, false)
    if (name === 'Codex' || name === 'Grok') return new C('fake', [], o.home, o.env, o)
    if (name === 'Zcode') return new C(o.home, o.env, o)
    if (name === 'Pi') return new C('fake', [], o, 'saved', false)
    if (name === 'Antigravity') return new C('fake', [], false, o, null)
    return new C('fake', [], o)
  }
  return { internals, opts, session, adapter: module.exports.getAdapter as (id: EngineId) => EngineAdapter, spawns: () => spawns }
}

async function ticks(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve() }
function controlReply(child: WireChild, request: WireRequest): void {
  if (!request.id) return
  if (request.type === 'get_state') { child.frame({ type: 'response', id: request.id, data: { sessionId: 'saved' } }); return }
  child.frame({ id: request.id, result: { sessionId: 'saved', thread: { id: 'saved' } } })
}

for (const name of ['Claude', 'Codex', 'Grok', 'Zcode', 'Pi', 'Antigravity', 'Kimi']) {
  test(`${name} lifetime signal rejects pre-aborted startup without spawning`, () => {
    const wire = loadWireEngine(new WireChild())
    assert.throws(() => wire.session(name, { signal: AbortSignal.abort() }), /abort/i)
    assert.equal(wire.spawns(), 0)
  })

  test(`${name} signal abort settles a submitted turn without permitting replay`, async () => {
    const child = new WireChild((request) => {
      if (request.method === 'session/prompt' || request.method === 'turn/start' || request.type === 'prompt' || request.type === 'user' || request.event === 'user') return
      controlReply(child, request)
    })
    const wire = loadWireEngine(child)
    const controller = new AbortController()
    const session = wire.session(name, { signal: controller.signal })
    const pending = session.send('perform work')
    await ticks()
    controller.abort()
    const result = await pending
    assert.ok(result.error)
    assert.equal(result.executionPhase, 'prompt-submitted')
    assert.equal(session.alive, false)
    await session.stop({ force: true })
  })
}

for (const name of ['Codex', 'Grok', 'Zcode', 'Kimi']) {
  test(`${name} abort during handshake is explicitly not-started`, async () => {
    const child = new WireChild()
    const wire = loadWireEngine(child)
    const controller = new AbortController()
    const session = wire.session(name, { signal: controller.signal, resumeSessionId: 'saved' })
    const pending = session.send('queued')
    controller.abort()
    const result = await pending
    assert.equal(result.executionPhase, 'not-started')
    assert.ok(result.error)
    assert.equal(result.sessionId, 'saved')
    assert.ok(!child.requests.some(r => r.method === 'session/prompt' || r.method === 'turn/start'))
    await session.stop({ force: true })
  })
}

for (const name of ['Codex', 'Grok', 'Zcode']) {
  for (const diagnostic of ['Internal error', 'failed to resume: ECONNRESET', 'authentication failed', 'session not found']) {
    test(`${name} resume recovery classifies ${diagnostic}`, async () => {
      const child = new WireChild(request => {
        if (request.method === 'thread/resume' || request.method === 'session/load') {
          child.frame({ id: request.id, error: { message: diagnostic } })
        } else if (request.method === 'session/prompt') {
          child.frame({ id: request.id, result: { stopReason: 'end_turn' } })
        } else if (request.method === 'turn/start') {
          child.frame({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
        } else controlReply(child, request)
      })
      const wire = loadWireEngine(child)
      const session = wire.session(name, { resumeSessionId: 'saved' })
      const result = await session.send('resume')
      if (diagnostic === 'session not found') {
        assert.equal(result.executionPhase, 'completed')
        assert.equal(result.error, undefined)
        assert.ok(child.requests.some(r => r.method === 'thread/start' || r.method === 'session/new'))
      } else {
        assert.equal(result.executionPhase, 'not-started')
        assert.equal(result.sessionId, 'saved')
        assert.match(result.error!, new RegExp(diagnostic))
        assert.equal(result.failure?.kind, classifyEngineFailure(diagnostic, true))
        assert.ok(!child.requests.some(r => ['thread/start', 'session/new', 'turn/start', 'session/prompt'].includes(r.method ?? '')))
      }
      await session.stop({ force: true })
    })
  }
}

for (const name of ['Grok', 'Zcode']) {
  for (const stopReason of ['end_turn', 'cancelled', 'max_tokens', 'refusal', 'future_reason', undefined]) {
    test(`${name} ACP terminal reason ${String(stopReason)}`, async () => {
      const child = new WireChild(request => {
        if (request.method !== 'session/prompt') { controlReply(child, request); return }
        child.frame({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'side effect' } } })
        child.frame({ id: request.id, result: { stopReason, usage: { input_tokens: 2, output_tokens: 1 } } })
      })
      const session = loadWireEngine(child).session(name)
      const result = await session.send('work')
      assert.equal(result.exitCode, stopReason === 'end_turn' ? 0 : 1)
      assert.equal(result.executionPhase, stopReason === 'end_turn' ? 'completed' : 'effects-possible')
      assert.equal(!!result.error, stopReason !== 'end_turn')
      assert.equal(result.usage?.input_tokens, 2)
      await session.stop({ force: true })
    })
  }
  test(`${name} tool activity followed by process death retains effects-possible without usage`, async () => {
    const child = new WireChild(request => {
      if (request.method !== 'session/prompt') { controlReply(child, request); return }
      child.frame({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'side effect' } } })
      child.close(3)
    })
    const result = await loadWireEngine(child).session(name).send('work')
    assert.equal(result.executionPhase, 'effects-possible')
    assert.equal(result.usage, undefined)
    assert.ok(result.error)
  })
}

test('Claude-shaped one-shot terminals preserve protocol failures, incomplete streams, and process diagnostics', async () => {
  for (const scenario of ['ok', 'result-error', 'missing', 'stderr-error']) {
    const child = new WireChild()
    const wire = loadWireEngine(child)
    const pending = wire.internals.spawnEngine('fake', [], { ...wire.opts, prompt: 'work', signal: new AbortController().signal }, { requireResult: true })
    if (scenario === 'ok') child.stdout.write('{"type":"result","is_error":false}') // EOF without newline
    if (scenario === 'result-error') child.frame({ type: 'result', is_error: true, result: 'authentication failed', usage: { input_tokens: 2 } })
    if (scenario === 'stderr-error') child.stderr.write('session not found\nusage limit reached\n')
    child.close(scenario === 'stderr-error' ? 1 : 0)
    const result = await pending
    assert.equal(result.exitCode, scenario === 'ok' ? 0 : 1)
    if (scenario === 'result-error') {
      assert.match(result.error!, /authentication failed/)
      assert.equal(result.usage?.input_tokens, 2)
    }
    if (scenario === 'missing') assert.match(result.error!, /without terminal result/)
    if (scenario === 'stderr-error') {
      assert.match(result.error!, /session not found/)
      assert.match(result.error!, /usage limit reached/)
      assert.equal(classifyEngineFailure(result.error!, true), 'resume-not-found')
    }
  }
})

test('Codex exec requires turn.completed even after tool output and exit zero', async () => {
  const child = new WireChild()
  const wire = loadWireEngine(child)
  const pending = wire.internals.spawnCodexExec('fake', [], { ...wire.opts, prompt: 'work', signal: new AbortController().signal }, {})
  child.frame({ type: 'thread.started', thread_id: 'saved' })
  child.frame({ type: 'item.completed', item: { type: 'command_execution' } })
  child.close(0)
  const result = await pending
  assert.equal(result.exitCode, 1)
  assert.match(result.error!, /without turn.completed/)
  assert.equal(result.sessionId, 'saved')
  assert.equal(result.executionPhase, 'effects-possible')
})


test('one-shot terminal failure is authoritative and remains sticky through a later success event', async () => {
  const child = new WireChild()
  const wire = loadWireEngine(child)
  const pending = wire.internals.spawnEngine('fake', [], { ...wire.opts, prompt: 'work', signal: new AbortController().signal }, { requireResult: true })
  child.frame({ type: 'result', is_error: true, result: 'permission denied' })
  child.frame({ type: 'result', is_error: false })
  child.stderr.write('usage limit reached\n')
  child.close(2)
  const result = await pending
  assert.match(result.error!, /^permission denied/)
  assert.match(result.error!, /usage limit reached/)
  assert.equal(result.exitCode, 2)
})

for (const status of ['completed', 'failed', 'interrupted', undefined]) {
  test(`Codex app-server validates terminal status ${String(status)}`, async () => {
    const child = new WireChild(request => {
      if (request.method === 'turn/start') child.frame({ method: 'turn/completed', params: { turn: { status } } })
      else controlReply(child, request)
    })
    const session = loadWireEngine(child).session('Codex')
    const result = await session.send('work')
    assert.equal(result.exitCode, status === 'completed' ? 0 : 1)
    assert.equal(result.executionPhase, status === 'completed' ? 'completed' : 'prompt-submitted')
    await session.stop({ force: true })
  })
}

test('Codex stderr cannot supply the required stdout completion event', async () => {
  const child = new WireChild()
  const wire = loadWireEngine(child)
  const pending = wire.internals.spawnCodexExec('fake', [], { ...wire.opts, prompt: 'work', signal: new AbortController().signal }, {})
  child.stderr.write('{"type":"turn.completed"}\n')
  child.close(0)
  const result = await pending
  assert.equal(result.exitCode, 1)
  assert.match(result.error!, /without turn.completed/)
})


test('Grok default streaming-messages-json run requires a terminal result', async () => {
  for (const completed of [false, true]) {
    const child = new WireChild()
    const wire = loadWireEngine(child)
    const pending = wire.adapter('grok').run({ ...wire.opts, prompt: 'work', signal: new AbortController().signal })
    child.frame({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } })
    if (completed) child.frame({ type: 'result', is_error: false })
    child.close(0)
    const result = await pending
    assert.equal(result.exitCode, completed ? 0 : 1)
    if (!completed) assert.match(result.error!, /without terminal result/)
  }
})
