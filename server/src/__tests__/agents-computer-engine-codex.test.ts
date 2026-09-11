import { AgentRunner } from '../agents/computer/daemon.js'
import { effectiveCostUsd, priceFor, usageFromClaude } from '../agents/cost.js'
/**
 * Contract tests for BYOA Codex usage reporting.
 *
 * Codex is not required in CI. Each test puts a fake `codex` first on PATH
 * and replays the JSONL that `codex exec --json` actually emits — the
 * envelope is the documented ThreadEvent stream (`thread.started`,
 * `turn.completed.usage`, …), not Claude's `{type:'result'}`. Parsing that
 * stdout is load-bearing: the daemon must never read ~/.codex sqlite to
 * fill llm_calls.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine-codex.test.ts
 */
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { getAdapter, type EngineHopReport, type EngineRunResult } from '../agents/computer/engine.js'
import { EngineSessionStore } from '../agents/computer/session-store.js'

const IS_WIN = process.platform === 'win32'
const ORIGINAL_PATH = process.env.PATH
const ORIGINAL_UNSANDBOXED = process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED
// Exercise the real daemon assembly without starting a daemon or sending HTTP.
function assembleHop(report: EngineHopReport, resolvedModel = 'gpt-5.5') {
  const rows: Array<{ model: string; usage: ReturnType<typeof usageFromClaude>; extras?: Record<string, unknown> }> = []
  const runner = {
    adapter: { id: 'codex' }, currentRunId: null, lastWakeConvo: null,
    engineModel: () => resolvedModel,
    hopUsageOf: (usage: EngineHopReport['usage']) => usageFromClaude(usage as unknown as Record<string, unknown>),
    reporter: { push: (row: typeof rows[number]) => rows.push(row) },
  } as unknown as AgentRunner
  AgentRunner.prototype['onEngineHop'].call(runner, report, 'agent-turn')
  assert.equal(rows.length, 1)
  return rows[0]
}

const tempDirs: string[] = []
const liveSessions: Array<{ stop(): void | Promise<void> }> = []

afterEach(async () => {
  for (const s of liveSessions.splice(0)) { try { await s.stop() } catch { /* already gone */ } }
  delete process.env.FAKE_CODEX_SCENARIO
  delete process.env.FAKE_CODEX_MODEL
  delete process.env.FAKE_CODEX_LOG
  delete process.env.CUMORA_CODEX_ARGS
  delete process.env.CUMORA_CODEX_NO_APP_SERVER
  if (ORIGINAL_PATH === undefined) delete process.env.PATH
  else process.env.PATH = ORIGINAL_PATH
  if (ORIGINAL_UNSANDBOXED === undefined) delete process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED
  else process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = ORIGINAL_UNSANDBOXED
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FAKE_CODEX_EXEC = `'use strict'
const fs = require('node:fs')
const argv = process.argv.slice(2)
const scenario = process.env.FAKE_CODEX_SCENARIO || 'ok'
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_LOG) {
    fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv, stdin, cwd: process.cwd() }) + '\\n')
  }
  const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
  const started = { type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }
  if (process.env.FAKE_CODEX_MODEL) started.model = process.env.FAKE_CODEX_MODEL
  out(started)
  out({ type: 'turn.started' })
  if (scenario === 'auth-error') {
    process.stderr.write('not signed in\\n')
    out({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } })
    process.exitCode = 1
    return
  }
  if (scenario === 'failed') {
    out({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'ls' } })
    out({
      type: 'turn.failed',
      error: { message: 'quota exhausted' },
      usage: { input_tokens: 80, cached_input_tokens: 20, output_tokens: 4 },
    })
    return
  }
  if (scenario === 'reconnect') {
    out({ type: 'error', message: 'Reconnecting... 1/5' })
  }
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls', status: 'in_progress' } })
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls', status: 'completed' } })
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'echo:' + stdin } })
  out({
    type: 'turn.completed',
    usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      cache_write_input_tokens: 5,
      output_tokens: 10,
      reasoning_output_tokens: 2,
    },
  })
})
`

const FAKE_CODEX_APP_SERVER = `'use strict'
let buf = ''
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdin.on('data', (d) => {
  buf += d.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
      const thread = { id: 'thr-usage-1' }
      if (process.env.FAKE_CODEX_MODEL) thread.model = process.env.FAKE_CODEX_MODEL
      send({ jsonrpc: '2.0', id: msg.id, result: { thread } })
    } else if (msg.method === 'turn/start') {
      send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-1' } } })
      send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: {
        tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, reasoningOutputTokens: 2, cacheWriteInputTokens: 5 } },
      } })
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } })
    }
  }
})
setInterval(() => {}, 1 << 30)
`

async function writeFakeCli(binDir: string, name: string, source: string): Promise<void> {
  const scriptName = `${name}-fixture.js`
  await writeFile(join(binDir, scriptName), source, 'utf8')
  if (IS_WIN) {
    await writeFile(join(binDir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${scriptName}" %*\r\n`, 'utf8')
    const packageBin = join(binDir, 'node_modules', '@openai', 'codex', 'bin')
    await mkdir(packageBin, { recursive: true })
    await writeFile(join(packageBin, 'codex.js'), source, 'utf8')
    return
  }
  const launcher = join(binDir, name)
  await writeFile(launcher, `#!/bin/sh\nexec node "$(dirname "$0")/${scriptName}" "$@"\n`, 'utf8')
  await chmod(launcher, 0o755)
}

interface Fixture {
  root: string
  home: string
  log: string
  env: NodeJS.ProcessEnv
}

async function fixture(source: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-codex-usage-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  const log = join(root, 'fake.log')
  await mkdir(binDir)
  await mkdir(home)
  await writeFakeCli(binDir, 'codex', source)
  const path = `${binDir}${delimiter}${ORIGINAL_PATH ?? ''}`
  process.env.PATH = path
  Object.assign(process.env, extraEnv)
  return {
    root,
    home,
    log,
    env: {
      ...process.env,
      ...extraEnv,
      PATH: path,
      FAKE_CODEX_LOG: log,
      CUMORA_AGENT_IPC_DIR: join(root, 'private-ipc'),
      CUMORA_AGENT_MCP_SHIM: join(root, 'trusted', 'cumora-mcp'),
    },
  }
}

async function fakeLog(f: Fixture): Promise<Array<{ argv: string[]; stdin: string }>> {
  if (!existsSync(f.log)) return []
  return (await readFile(f.log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

const noop = { onLog: () => {}, signal: new AbortController().signal }

test('Codex one-shot logs match argv and disk state never promises an unperformed resume', async t => {
  const f = await fixture(FAKE_CODEX_EXEC)
  process.env.CUMORA_CODEX_NO_APP_SERVER = '1'
  const adapter = getAdapter('codex')
  const store = new EngineSessionStore(join(f.root, 'sessions'), 'test-agent', 'codex')
  await store.save('original-saved-thread')
  const lines: string[] = []
  t.mock.method(console, 'log', (...args: unknown[]) => { lines.push(args.join(' ')) })
  const runner = { agent: { id: 'test-agent' }, engine: 'codex', adapter, sessionStore: store, sessionId: null } as unknown as AgentRunner
  await AgentRunner.prototype['loadSessionId'].call(runner)
  assert.equal(AgentRunner.prototype['resumeSessionId'].call(runner), null)
  assert.match(lines.join('\n'), /loaded last codex execution.*one-shot codex exec; not resumed/)
  assert.doesNotMatch(lines.join('\n'), /will --resume|continuity across restart/)
  assert.equal(adapter.startSession?.({ home: f.home, env: f.env, standingPrompt: '', ...noop }), null)
  // Even a direct adapter caller supplying a saved id receives an honest log.
  const result = await adapter.run({ home: f.home, env: f.env, prompt: 'hello', resumeSessionId: 'original-saved-thread', ...noop,
    onLog: line => lines.push(line),
  })
  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.sessionId, '0199a213-81c0-7800-8aa1-bbab2a035a53')
  const [call] = await fakeLog(f)
  assert.ok(call.argv.includes('exec'))
  assert.ok(!call.argv.some(arg => ['resume', '--resume', 'original-saved-thread'].includes(arg)))
  assert.match(lines.join('\n'), /one-shot codex exec; starting fresh, session not resumed/)
  AgentRunner.prototype['setSessionId'].call(runner, result.sessionId ?? null)
  await store.flush()
  assert.match(lines.join('\n'), /saved codex session.*last execution only; not a resume target/)
  assert.equal(await store.load(), result.sessionId)
  assert.equal(AgentRunner.prototype['resumeSessionId'].call(runner), null)
})

test('Windows Codex reports one-shot mode even without an app-server opt-out', { skip: !IS_WIN }, () => {
  delete process.env.CUMORA_CODEX_NO_APP_SERVER
  delete process.env.CUMORA_CODEX_ARGS
  assert.equal(getAdapter('codex').sessionResumeUnavailableReason?.(), 'Windows one-shot codex exec')
})

test('codex exec --json reports turn.completed usage as one hop without reading a local DB', async () => {
  const f = await fixture(FAKE_CODEX_EXEC)
  const hops: EngineHopReport[] = []
  const res = await getAdapter('codex').run({
    home: f.home, prompt: 'hello there', env: f.env, model: null, ...noop,
    onHopUsage: (hop) => hops.push(hop),
  })

  assert.equal(res.exitCode, 0, res.error)
  assert.equal(res.sessionId, '0199a213-81c0-7800-8aa1-bbab2a035a53')
  assert.equal(res.model, null, 'actualModel is CLI-reported; exec JSONL has no model field here')
  assert.deepEqual(res.usage, {
    input_tokens: 60,
    output_tokens: 12,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 5,
  })
  assert.equal(hops.length, 1, 'codex exec publishes one hop per turn, like gemini')
  assert.equal(hops[0].model, null, 'no CLI model → daemon supplies its resolved engine model')
  const row = assembleHop(hops[0])
  assert.equal(row.model, 'gpt-5.5')
  assert.equal(row.extras?.route, 'byoa:codex')
  assert.equal(row.extras?.platform, undefined)
  assert.equal(row.extras?.callId, undefined)
  const price = priceFor(row.model, String(row.extras?.route))
  assert.notEqual(price.match, 'fallback')
  const cost = effectiveCostUsd(row.model, row.usage, price)
  assert.ok(cost.usd > 0)
  assert.equal(cost.estimated, true)
  assert.equal(assembleHop(hops[0], 'gpt-6-astra').model, 'gpt-6-astra')
  const unknown = assembleHop(hops[0], 'unlisted-local-model')
  assert.equal(priceFor(unknown.model, String(unknown.extras?.route)).unpriced, 'no-price')
  assert.deepEqual(hops[0].usage, res.usage)
  assert.equal(hops[0].hopIndex, 1)
  assert.equal(hops[0].toolUses, 1)

  const [call] = await fakeLog(f)
  assert.equal(call.stdin, 'hello there')
  assert.ok(call.argv.includes('exec'))
  assert.ok(call.argv.includes('--json'))
  assert.ok(!call.argv.includes('hello there'), 'the prompt must travel on stdin, not argv')
})

test('codex exec takes actualModel from CLI output when present', async () => {
  const f = await fixture(FAKE_CODEX_EXEC, { FAKE_CODEX_MODEL: 'gpt-5.4' })
  const hops: EngineHopReport[] = []
  const res = await getAdapter('codex').run({
    home: f.home, prompt: 'x', env: f.env, model: 'requested-pin', ...noop,
    onHopUsage: (hop) => hops.push(hop),
  })

  assert.equal(res.model, 'gpt-5.4', 'the pin is not actualModel')
  assert.equal(hops[0].model, 'gpt-5.4')
  assert.equal(assembleHop(hops[0]).model, 'gpt-5.5', 'request selection is retained independently')
  assert.equal(assembleHop(hops[0]).extras?.actualModel, 'gpt-5.4')
})

test('a zero-usage Codex exec failure does not invent a hop', async () => {
  const f = await fixture(FAKE_CODEX_EXEC, { FAKE_CODEX_SCENARIO: 'auth-error' })
  const hops: EngineHopReport[] = []
  const res = await getAdapter('codex').run({
    home: f.home, prompt: 'x', env: f.env, ...noop,
    onHopUsage: (hop) => hops.push(hop),
  })

  assert.notEqual(res.exitCode, 0)
  assert.equal(res.usage, undefined)
  assert.equal(hops.length, 0)
})

test('a failed Codex exec still reports spent usage', async () => {
  const f = await fixture(FAKE_CODEX_EXEC, { FAKE_CODEX_SCENARIO: 'failed' })
  const hops: EngineHopReport[] = []
  const res = await getAdapter('codex').run({
    home: f.home, prompt: 'x', env: f.env, ...noop,
    onHopUsage: (hop) => hops.push(hop),
  })

  assert.equal(res.exitCode, 1)
  assert.match(res.error ?? '', /quota exhausted/)
  assert.deepEqual(res.usage, { input_tokens: 60, output_tokens: 4, cache_read_input_tokens: 20 })
  assert.equal(hops.length, 1)
  assert.deepEqual(hops[0].usage, res.usage)
})

test('a reconnect error event does not fail a completed Codex exec turn', async () => {
  const f = await fixture(FAKE_CODEX_EXEC, { FAKE_CODEX_SCENARIO: 'reconnect' })
  const res = await getAdapter('codex').run({
    home: f.home, prompt: 'x', env: f.env, ...noop,
  })
  assert.equal(res.exitCode, 0, res.error)
  assert.equal(res.usage?.output_tokens, 12)
})

test('an opaque CUMORA_CODEX_ARGS override does not assume exec JSONL', async () => {
  process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'
  process.env.CUMORA_CODEX_ARGS = '--skip-git-repo-check'
  const f = await fixture(FAKE_CODEX_EXEC)
  const hops: EngineHopReport[] = []
  const res = await getAdapter('codex').run({
    home: f.home, prompt: 'x', env: f.env, ...noop,
    onHopUsage: (hop) => hops.push(hop),
  })
  assert.equal(res.exitCode, 0, res.error)
  const [call] = await fakeLog(f)
  assert.equal(call.argv.includes('--json'), false)
  assert.equal(hops.length, 0, 'opaque argv is not the documented JSONL contract')
})

async function startUsageSession(opts: { model?: string | null } = {}) {
  process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'
  const f = await fixture(FAKE_CODEX_APP_SERVER, opts.model ? { FAKE_CODEX_MODEL: opts.model } : {})
  const hops: EngineHopReport[] = []
  const session = getAdapter('codex').startSession?.({
    home: f.home,
    env: f.env,
    model: null,
    onLog: () => {},
    onHopUsage: (hop) => hops.push(hop),
  })
  assert.ok(session, 'codex adapter must start a persistent session on this platform')
  liveSessions.push(session!)
  const result = await Promise.race([
    session!.send('go'),
    delay(15_000).then(() => 'TIMEOUT' as const),
  ])
  assert.notEqual(result, 'TIMEOUT', 'the app-server turn never settled')
  return { result: result as EngineRunResult, hops, session: session! }
}

test('a Codex app-server turn reports usage with no model pin', { skip: IS_WIN }, async () => {
  const { result, hops } = await startUsageSession()
  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.model, null, 'actualModel stays null when the CLI never named one')
  assert.deepEqual(result.usage, {
    input_tokens: 60,
    output_tokens: 12,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 5,
  })
  assert.equal(hops.length, 1)
  assert.equal(hops[0].model, null)
  assert.equal(assembleHop(hops[0]).model, 'gpt-5.5')
  assert.deepEqual(hops[0].usage, result.usage)
})

test('a Codex app-server turn uses the CLI-reported model as actualModel', { skip: IS_WIN }, async () => {
  const { result, hops } = await startUsageSession({ model: 'gpt-5.4' })
  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.model, 'gpt-5.4')
  assert.equal(hops[0].model, 'gpt-5.4')
  assert.equal(assembleHop(hops[0]).model, 'gpt-5.5', 'request selection is retained independently')
  assert.equal(assembleHop(hops[0]).extras?.actualModel, 'gpt-5.4')
})
