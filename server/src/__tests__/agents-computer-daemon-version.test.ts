import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { test } from 'node:test'
import { resolveCurrentVersion } from '../agents/computer/daemon.js'

test('bundled version wins in packaged CLI builds', () => {
  assert.equal(resolveCurrentVersion('1.2.3', '9.9.9'), '1.2.3')
})

test('source-mode daemon accepts the version supplied by its launcher', () => {
  assert.equal(resolveCurrentVersion(undefined, ' 1.2.3 '), '1.2.3')
})

test('missing or blank version retains the development fallback', () => {
  assert.equal(resolveCurrentVersion(undefined, undefined), '0.0.0')
  assert.equal(resolveCurrentVersion(undefined, '   '), '0.0.0')
})

test('registry release refresh never blocks reads and retains stale values on timeout', async () => {
  const source = readFileSync(new URL('../agents/computer/registry.ts', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('function versionGt('), source.indexOf('const AGENT_TOKEN_TTL_SECONDS'))
  let now = 1, calls = 0, timeout = 0
  let finish!: (value: unknown) => void
  let fail!: (reason: Error) => void
  const fetch = (url: string) => { assert.equal(url, 'https://api.github.com/repos/custom-owner/custom-repo/releases?per_page=30'); calls++; return new Promise((resolve, reject) => { finish = resolve; fail = reject }) }
  const js = ts.transpile(block + ';return { getLatestDaemonRelease, pending: () => latestRefresh }', { target: ts.ScriptTarget.ES2022 })
  const registry = new Function('fetch', 'AbortSignal', 'Date', 'process', js)(fetch, { timeout(ms: number) { timeout = ms; return {} } }, { now: () => now }, { env: { CUMORA_GITHUB_OWNER: 'custom-owner', CUMORA_GITHUB_REPO: 'custom-repo' } })
  assert.equal(await registry.getLatestDaemonRelease(), null)
  assert.equal(await registry.getLatestDaemonRelease(), null)
  assert.equal(calls, 1)
  assert.equal(timeout, 5000)
  finish({ ok: true, json: async () => [{ tag_name: 'agent-cli-v1.2.3-fork.4', assets: [{ name: 'cli.tgz', browser_download_url: 'https://example.com/cli.tgz' }] }] })
  await registry.pending()
  const cached = await registry.getLatestDaemonRelease()
  assert.equal(cached.version, '1.2.3-fork.4')
  now += 3_600_001
  assert.deepEqual(await registry.getLatestDaemonRelease(), cached)
  assert.equal(calls, 2)
  fail(new Error('timeout'))
  await registry.pending()
  assert.deepEqual(await registry.getLatestDaemonRelease(), cached)
  assert.equal(calls, 2)
})

test('all daemon version write limits preserve a full fork SHA', () => {
  const version = '1.2.3-fork.4+' + 'a'.repeat(40)
  const registry = readFileSync(new URL('../agents/computer/registry.ts', import.meta.url), 'utf8')
  const runtime = readFileSync(new URL('../agents/runtime/server.ts', import.meta.url), 'utf8')
  const limits = [...registry.matchAll(/(?:args\.)?version\.slice\(0, (\d+)\)/g),
    ...runtime.matchAll(/body\.daemonVersion\.trim\(\)\.slice\(0, (\d+)\)/g)]
  assert.equal(limits.length, 3)
  for (const match of limits) {
    assert.ok(Number(match[1]) >= 64)
    assert.equal(version.slice(0, Number(match[1])), version)
  }
})
