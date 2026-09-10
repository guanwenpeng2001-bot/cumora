import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  buildKimiMcpServers, ENGINE_IDS, getAdapter, KimiSession, kimiPrintArgs,
  resolveKimiCommand, runnableEngineIds, spawnKimiPrint,
} from '../agents/computer/engine.js'
import { ENGINE_VERSION_SPECS, parseCliVersion } from '../agents/computer/cli-version.js'
import { normalizeByoaSource } from '../agents/runtime/byoa-source.js'
import { RUNNABLE_ENGINES, ENGINE_LABEL, ENGINE_BIN } from '../../../src/lib/engines.js'

const roots: string[] = []
const sessions: KimiSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(s => s.stop({ force: true })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const fixtureSource = String.raw`
const fs = require('node:fs')
const readline = require('node:readline')
const scenario = process.env.KIMI_FIXTURE_SCENARIO || 'ok'
const out = msg => process.stdout.write(JSON.stringify(msg) + '\n')
const log = msg => fs.appendFileSync(process.env.KIMI_FIXTURE_LOG, JSON.stringify(msg) + '\n')
if (process.argv.includes('acp')) {
  let sid = 'session-new', model = 'provider/default', turns = 0, permissionPrompt = null
  const update = text => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const req = JSON.parse(line); log(req)
    const reply = result => out({ jsonrpc: '2.0', id: req.id, result })
    if (req.method === 'initialize') return reply({ agentInfo: { version: '0.42.0' } })
    if (req.method === 'session/new' || req.method === 'session/load') {
      if (scenario === 'bad-session') return out({ jsonrpc: '2.0', id: req.id, error: { message: 'session not found' } })
      sid = req.params.sessionId || sid
      return reply({ sessionId: sid, models: { currentModelId: model } })
    }
    if (req.method === 'session/set_mode') {
      if (scenario === 'bad-mode') return out({ jsonrpc: '2.0', id: req.id, error: { message: 'mode denied' } })
      return reply({})
    }
    if (req.method === 'session/set_model') {
      model = req.params.modelId
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'config_option_update', configOptions: [{ category: 'model', currentValue: model }] } } })
      return reply({})
    }
    if (req.method === 'session/prompt') {
      turns++
      if (scenario === 'hang') { update('started'); return }
      if (scenario === 'crash') return process.exit(0)
      if (scenario === 'permission') {
        permissionPrompt = req.id
        out({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { options: [{ kind: 'allow_once', optionId: 'allow' }] } })
        return
      }
      update('你好🙂:' + turns + ':' + req.params.prompt[0].text)
      return reply({ stopReason: scenario === 'cancelled' ? 'cancelled' : 'end_turn' })
    }
    if (req.id === 900) { log({ permissionResponse: req.result }); out({ jsonrpc: '2.0', id: permissionPrompt, result: { stopReason: 'end_turn' } }); return }
  })
} else {
  log({ argv: process.argv.slice(2), cwd: process.cwd() })
  if (scenario === 'hang') { setInterval(() => {}, 10000); out({ role: 'assistant', content: 'started' }) }
  else if (scenario === 'auth') { console.error('Authentication required: run kimi login'); process.exitCode = 1 }
  else {
    const body = Buffer.from(JSON.stringify({ role: 'assistant', content: '你好🙂' + 'x'.repeat(70000) }) + '\n')
    process.stdout.write(body.subarray(0, 34)); process.stdout.write(body.subarray(34))
    if (scenario === 'untrusted') console.error('Warning: this folder is not trusted; skipped 1 project-level MCP server: test')
    if (scenario === 'event-error') out({ role: 'error', content: 'provider failed' })
    if (scenario !== 'eof') process.stdout.write(JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'session-printed' }))
  }
}
`

async function fixture(scenario = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'cumora-kimi-test-')); roots.push(root)
  const script = join(root, 'fixture.cjs'), log = join(root, 'calls.jsonl')
  await writeFile(script, fixtureSource)
  const env: NodeJS.ProcessEnv = { ...process.env, CUMORA_BYOA_ALLOW_UNSANDBOXED: '1', KIMI_FIXTURE_SCENARIO: scenario, KIMI_FIXTURE_LOG: log }
  return { root, script, log, env }
}
async function calls(log: string): Promise<Array<Record<string, any>>> {
  return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}
const noop = () => {}

function start(f: Awaited<ReturnType<typeof fixture>>, extra = {}) {
  const session = new KimiSession(process.execPath, [f.script, 'acp'], { home: f.root, env: f.env, onLog: noop, ...extra })
  sessions.push(session)
  return session
}

test('kimi registry, renderer, source attribution and installed version agree', () => {
  assert.ok(ENGINE_IDS.includes('kimi'))
  assert.ok(RUNNABLE_ENGINES.includes('kimi'))
  assert.equal(ENGINE_LABEL.kimi, 'Kimi Code')
  assert.equal(ENGINE_BIN.kimi, 'kimi')
  assert.equal(getAdapter('kimi').bin, 'kimi')
  assert.equal(normalizeByoaSource('byoa-kimi'), 'byoa-kimi')
  assert.deepEqual(ENGINE_VERSION_SPECS.kimi.versionArgs, ['--version'])
  assert.equal(parseCliVersion('0.42.0'), '0.42.0')
})

test('kimi is blocked by default and allowed only through the existing host-execution opt-in', async () => {
  assert.deepEqual(runnableEngineIds(['kimi'], {}), [])
  assert.deepEqual(runnableEngineIds(['kimi'], { CUMORA_BYOA_ALLOW_UNSANDBOXED: '1' }), ['kimi'])
  const f = await fixture()
  await writeFile(join(f.root, process.platform === 'win32' ? 'kimi.exe' : 'kimi'), '')
  const result = await getAdapter('kimi').run({ home: f.root, prompt: 'x', env: { PATH: f.root }, onLog: noop, signal: new AbortController().signal })
  assert.match(result.error!, /CUMORA_BYOA_ALLOW_UNSANDBOXED=1/)
})

test('missing kimi reports the exact dependency, installation site and login step', async () => {
  assert.throws(() => resolveKimiCommand({ PATH: '' }), /missing-dependency.*kimi-code.*https:.*kimi login/)
  const result = await getAdapter('kimi').run({ home: tmpdir(), prompt: 'x', env: { PATH: '' }, onLog: noop, signal: new AbortController().signal })
  assert.equal(result.exitCode, 1)
  assert.match(result.error!, /missing-dependency/)
})

test('print arguments preserve model, resume ID and multiline shell metacharacters without incompatible permission flags', () => {
  const prompt = '你好\n"quoted" & $(no-command) `literal` %PATH%'
  const argv = kimiPrintArgs({ prompt, model: 'provider/custom', resumeSessionId: 'session-old' })
  assert.deepEqual(argv, ['--output-format', 'stream-json', '--model', 'provider/custom', '--session', 'session-old', '--prompt', prompt])
  assert.ok(!argv.includes('--auto') && !argv.includes('--yolo'))
})

test('print transport parses native role JSONL, split UTF-8 and final unterminated line without inventing model/usage', async () => {
  const f = await fixture()
  const result = await spawnKimiPrint(process.execPath, [f.script, ...kimiPrintArgs({ prompt: '你好\n"x" & %PATH%' })], {
    home: f.root, prompt: 'x', env: f.env, onLog: noop, signal: new AbortController().signal,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.sessionId, 'session-printed')
  assert.equal(result.text, '你好🙂' + 'x'.repeat(70000))
  assert.equal(result.model, null)
  assert.equal(result.usage, undefined)
  assert.equal((await calls(f.log))[0].argv.at(-1), '你好\n"x" & %PATH%')
})

for (const scenario of ['eof', 'auth', 'event-error', 'untrusted']) test(`print ${scenario} cannot report success`, async () => {
  const f = await fixture(scenario)
  const result = await spawnKimiPrint(process.execPath, [f.script], { home: f.root, prompt: 'x', env: f.env, onLog: noop, signal: new AbortController().signal })
  assert.notEqual(result.exitCode, 0)
  assert.ok(result.error)
})

test('print cancellation terminates an active child and an already-aborted run never starts', async () => {
  const f = await fixture('hang'), controller = new AbortController()
  const result = await spawnKimiPrint(process.execPath, [f.script], {
    home: f.root, prompt: 'x', env: f.env, signal: controller.signal, onLog: () => controller.abort(),
  })
  assert.notEqual(result.exitCode, 0)
  assert.match(result.error!, /cancelled/)
  const before = await readFile(f.log, 'utf8')
  await spawnKimiPrint(process.execPath, [f.script], { home: f.root, prompt: 'x', env: f.env, signal: controller.signal, onLog: noop })
  assert.equal(await readFile(f.log, 'utf8'), before)
})

test('ACP keeps one session over multiple turns, pins a model and transmits prompts only through stdin', async () => {
  const f = await fixture(), s = start(f, { model: 'provider/pinned' })
  const a = await s.send('first\n"🙂"'), b = await s.send('second')
  assert.equal(a.exitCode, 0); assert.equal(b.exitCode, 0)
  assert.equal(a.sessionId, b.sessionId)
  assert.equal(b.model, 'provider/pinned')
  assert.equal(s.text, '你好🙂:2:second')
  assert.equal(s.carriesStandingPrompt, false)
  const log = await calls(f.log)
  assert.equal(log.filter(c => c.method === 'initialize').length, 1)
  assert.equal(log.find(c => c.method === 'session/set_mode')!.params.modeId, 'auto')
  assert.equal(log.find(c => c.method === 'session/prompt')!.params.prompt[0].text, 'first\n"🙂"')
})

test('ACP resume uses the exact stored ID and injects both HTTP/stdio connectors and the Cumora bridge', async () => {
  const f = await fixture()
  f.env.CUMORA_MCP_CONNECTORS_JSON = JSON.stringify([{ name: 'http', type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'test' } }, { name: 'stdio', type: 'stdio', command: 'node', args: ['fixture.js'], env: { TEST: 'yes' } }])
  f.env.CUMORA_AGENT_MCP_SHIM = 'bridge.js'
  f.env.CUMORA_AGENT_IPC_DIR = 'ipc'
  const s = start(f, { resumeSessionId: 'session-existing' })
  assert.equal((await s.send('x')).sessionId, 'session-existing')
  const log = await calls(f.log), load = log.find(c => c.method === 'session/load')!
  assert.ok(!log.some(c => c.method === 'session/new'))
  assert.equal(load.params.mcpServers.length, 3)
  assert.deepEqual(load.params.mcpServers[0].headers, [{ name: 'Authorization', value: 'test' }])
  assert.equal(load.params.mcpServers[2].name, 'cumora')
})

for (const scenario of ['bad-session', 'bad-mode', 'crash', 'cancelled']) test(`ACP ${scenario} settles as failure`, async () => {
  const f = await fixture(scenario), s = start(f)
  const result = await s.send('x')
  assert.notEqual(result.exitCode, 0)
  assert.ok(result.error)
  if (scenario === 'bad-mode') assert.ok(!(await calls(f.log)).some(c => c.method === 'session/prompt'))
})

test('ACP cancellation settles an in-flight prompt and closes the child', async () => {
  const f = await fixture('hang')
  let began!: () => void
  const begun = new Promise<void>(resolve => { began = resolve })
  const s = start(f, { onLog: began })
  const pending = s.send('x')
  await begun
  assert.match((await s.send('another')).error!, /busy/)
  await s.stop()
  assert.notEqual((await pending).exitCode, 0)
  assert.equal(s.alive, false)
})

test('ACP residual permission requests are cancelled rather than auto-approved', async () => {
  const f = await fixture('permission'), s = start(f)
  const pending = s.send('x')
  // Wait for the fixture to persist the response without assuming pipe timing.
  for (let i = 0; i < 100; i++) {
    const log = await calls(f.log).catch(() => [])
    if (log.some(c => c.permissionResponse)) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const response = (await calls(f.log)).find(c => c.permissionResponse)!
  assert.deepEqual(response.permissionResponse, { outcome: { outcome: 'cancelled' } })
  assert.match((await pending).error!, /permission request cancelled/)
})

test('Kimi resources materialize full skill files and reconcile only managed MCP entries', async () => {
  const f = await fixture(), adapter = getAdapter('kimi')
  const persona = { id: 'a', name: 'A', role: null, systemPrompt: null, skills: [{ name: 'review', description: 'review', files: [{ path: 'SKILL.md', body: '# Review' }, { path: 'references/check.txt', body: 'reference' }] }], mcpConnectors: [{ name: 'remote', type: 'http' as const, url: 'https://example.test/mcp' }] }
  await adapter.seedHome(f.root, persona)
  assert.equal(await readFile(join(f.root, '.kimi-code/skills/review/references/check.txt'), 'utf8'), 'reference')
  assert.match(await readFile(join(f.root, 'AGENTS.md'), 'utf8'), /\.kimi-code\/skills/)
  const path = join(f.root, '.kimi-code/mcp.json')
  const config = JSON.parse(await readFile(path, 'utf8'))
  config.mcpServers.user = { command: 'user-command' }
  await writeFile(path, JSON.stringify(config))
  await adapter.seedHome(f.root, { ...persona, skills: [], mcpConnectors: [] })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).mcpServers, { user: { command: 'user-command' } })
  await assert.rejects(readFile(join(f.root, '.kimi-code/skills/review/SKILL.md')))
})

test('Kimi MCP rejects reserved/duplicate names and preserves a user-modified managed entry', async () => {
  assert.throws(() => buildKimiMcpServers([{ name: 'cumora', type: 'http', url: 'https://example.test' }]), /conflict/)
  const connector = { name: 'remote', type: 'http' as const, url: 'https://example.test/mcp' }
  assert.throws(() => buildKimiMcpServers([connector, connector]), /conflict/)
  const f = await fixture(), adapter = getAdapter('kimi')
  const persona = { id: 'a', name: 'A', role: null, systemPrompt: null, mcpConnectors: [connector] }
  await adapter.seedHome(f.root, persona)
  const path = join(f.root, '.kimi-code/mcp.json')
  const changed = JSON.stringify({ mcpServers: { remote: { url: 'https://user.test/mcp' } } })
  await writeFile(path, changed)
  await assert.rejects(adapter.seedHome(f.root, persona), /user-owned/)
  assert.equal(await readFile(path, 'utf8'), changed)
})
