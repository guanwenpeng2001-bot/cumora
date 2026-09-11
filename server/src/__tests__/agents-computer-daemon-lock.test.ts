import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { acquireDaemonLock } from '../agents/computer/daemon-lock.js'

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-daemon-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

test('daemon lock admits exactly one of 12 concurrent contenders', async t => {
  const root = await fixture(t)
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => acquireDaemonLock(root)))
  const winners = results.filter(r => r.status === 'fulfilled')
  try {
    assert.equal(winners.length, 1)
    const rejected = results.filter(r => r.status === 'rejected')
    assert.equal(rejected.length, 11)
    for (const r of rejected) assert.match(String(r.reason), /another daemon owns.*lock.*state directory:.*lock:/)
  } finally {
    await Promise.all(winners.map(r => r.value.release()))
  }
  const next = await acquireDaemonLock(root)
  await next.release()
})

test('daemon lock resolves directory aliases before deciding ownership', async t => {
  const root = await fixture(t)
  const target = join(root, 'state')
  const alias = join(root, 'alias')
  await mkdir(target)
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const lock = await acquireDaemonLock(target)
  try { await assert.rejects(acquireDaemonLock(alias), /another daemon owns/) }
  finally { await lock.release() }
})

test('second daemon process exits 73 before engine scans or hosting', { timeout: 20_000 }, async t => {
  const root = await fixture(t)
  const state = join(root, '.cumora')
  const lock = await acquireDaemonLock(state)
  try {
    const entry = join(root, 'start.mjs')
    const module = new URL('../agents/computer/daemon.ts', import.meta.url).href
    await writeFile(entry, `import { runComputerDaemon } from ${JSON.stringify(module)}; await runComputerDaemon(['--server','http://127.0.0.1:1']);`)
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      windowsHide: true, env: { ...process.env, HOME: root, USERPROFILE: root }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    t.after(() => stop(child))
    let output = ''
    child.stdout.on('data', b => { output += b })
    child.stderr.on('data', b => { output += b })
    const [code] = await once(child, 'close')
    assert.equal(code, 73, output)
    assert.match(output, /daemon startup refused: another daemon owns the single-instance lock/)
    assert.ok(output.includes(lock.location), output)
    assert.doesNotMatch(output, /· starting|hosting agent|engine\(s\) disabled/)
  } finally { await lock.release() }
})

test('kernel releases daemon lock after a killed owner without stale-file recovery', { timeout: 20_000 }, async t => {
  const root = await fixture(t)
  const entry = join(root, 'owner.mjs')
  const module = new URL('../agents/computer/daemon-lock.ts', import.meta.url).href
  await writeFile(entry, `import { acquireDaemonLock } from ${JSON.stringify(module)}; await acquireDaemonLock(${JSON.stringify(root)}); console.log('LOCKED'); setInterval(() => {}, 1000);`)
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => stop(child))
  const [data] = await once(child.stdout!, 'data')
  assert.match(String(data), /LOCKED/)
  await assert.rejects(acquireDaemonLock(root), /another daemon owns/)
  await stop(child)
  const next = await acquireDaemonLock(root)
  await next.release()
})

test('startup refuses a live pre-lock daemon recorded in running.json', { timeout: 20_000 }, async t => {
  const root = await fixture(t)
  const state = join(root, '.cumora')
  await mkdir(state)
  // A passive process with the old daemon command-line shape; never connects
  // to Cumora and never runs an engine. Only its PID/command are inspected.
  const legacy = spawn(process.execPath, ['-e', "console.log('READY'); setInterval(() => {}, 1000)", '--', 'agent', 'computer'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => stop(legacy))
  await once(legacy.stdout!, 'data')
  await writeFile(join(state, 'running.json'), JSON.stringify({ pid: legacy.pid, version: 'pre-lock' }))
  const entry = join(root, 'start.mjs')
  const module = new URL('../agents/computer/daemon.ts', import.meta.url).href
  await writeFile(entry, `import { runComputerDaemon } from ${JSON.stringify(module)}; await runComputerDaemon(['--server','http://127.0.0.1:1']);`)
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    windowsHide: true, env: { ...process.env, HOME: root, USERPROFILE: root }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => stop(child))
  let output = ''
  child.stdout.on('data', b => { output += b })
  child.stderr.on('data', b => { output += b })
  const [code] = await once(child, 'close')
  assert.equal(code, 73, output)
  assert.ok(output.includes(`legacy daemon PID ${legacy.pid} is still running`), output)
  assert.match(output, /running.json, verified by live PID and command line/)
  assert.doesNotMatch(output, /· starting|hosting agent/)
  assert.equal(legacy.exitCode, null, 'refusing startup must not kill the old daemon')
  const lock = await acquireDaemonLock(state)
  await lock.release()
})
