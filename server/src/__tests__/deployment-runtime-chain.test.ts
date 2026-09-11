import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'

const read = (path: string) => readFileSync(new URL('../../../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const { load, loadAll } = createRequire(import.meta.url)('js-yaml')
const compile = (source: string, args: string[], values: unknown[]) => new Function(...args, ts.transpile(source, { target: ts.ScriptTarget.ES2022 }))(...values)

test('pairing uses explicit/dev origin first, then HTTP(S) page; detects remote-unreachable loopback', () => {
  assert.match(read('src/desktop/MeView.tsx'), /isPairingServerLoopback\(origin\)[^\n]+\n[^\n]+\{pairCommand\}/)
  const source = read('src/api/client.ts')
  const block = source.slice(source.indexOf('export function getPairingServerOrigin'), source.indexOf('/** Persist a new server origin')).replace(/export /g, '')
  for (const [server, dev, location, expected] of [
    ['', undefined, { protocol: 'https:', origin: 'https://self.example' }, 'https://self.example'],
    ['https://custom.example', 'http://dev:5181', { protocol: 'https:', origin: 'https://page.example' }, 'https://custom.example'],
    ['', 'http://dev:5181', { protocol: 'http:', origin: 'http://localhost:5180' }, 'http://dev:5181'],
    ['', undefined, { protocol: 'app:', origin: 'app://cumora' }, ''],
    ['', undefined, undefined, ''],
  ]) {
    const api = compile(block + ';return { getPairingServerOrigin, isPairingServerLoopback }', ['SERVER_ORIGIN', 'DEV_API_TARGET', 'location'], [server, dev, location])
    assert.equal(api.getPairingServerOrigin(), expected)
    for (const origin of ['http://localhost:8080', 'http://127.0.0.2', 'http://[::1]', 'http://foo.localhost']) assert.equal(api.isPairingServerLoopback(origin), true)
    assert.equal(api.isPairingServerLoopback('https://self.example'), false)
  }
})

test('runtime GET rejects HTML instead of silently treating it as no work', async () => {
  const source = read('server/src/agents/computer/daemon.ts')
  const start = source.indexOf('async function runtimeGet<T>')
  const block = source.slice(start, source.indexOf('\n}', start) + 2)
  const get = (fetch: unknown) => compile(block + ';return runtimeGet', ['fetch', 'HTTP_TIMEOUT_MS'], [fetch, 1000])
  await assert.rejects(get(async () => new Response('<html>SPA</html>'))('https://self.example', '/bootstrap', 'secret'), /invalid JSON.*reverse proxy/)
  assert.deepEqual(await get(async () => Response.json({ tasks: [] }))('', '/tasks', 'secret'), { tasks: [] })
  assert.equal(await get(async () => new Response('', { status: 503 }))('', '/tasks', 'secret'), null)
  assert.equal(await get(async () => { throw new Error('offline') })('', '/tasks', 'secret'), null)
})

test('PVC apply failure stops preparation before Pod submission; opt-out skips PVC', async () => {
  const source = read('server/src/agents/runtime/orchestrator.ts')
  const start = source.indexOf('  if (CHROME_PROFILE_ON_PVC) {', source.indexOf('// Apply the per-agent chrome-profile PVC BEFORE'))
  const block = source.slice(start, source.indexOf('  const resolvedTriage', start))
  for (const [enabled, code, expectedSubmissions] of [[true, 1, 0], [true, 0, 1], [false, 1, 1]] as const) {
    let submitted = 0
    let pvcCalls = 0
    const run = compile('return async function () {' + block + ';submitPod();return { ok: true }}', ['CHROME_PROFILE_ON_PVC', 'chromeProfilePvcManifest', 'agentId', 'kubectlWithRetry', 'signal', 'console', 'submitPod'], [enabled, () => 'pvc', 'agent', async () => { pvcCalls++; return { code, err: 'Forbidden', out: '' } }, undefined, { warn() {} }, () => { submitted++ }])
    const result = await run()
    assert.equal(submitted, expectedSubmissions)
    assert.equal(pvcCalls, enabled ? 1 : 0)
    if (enabled && code) { assert.equal(result.ok, false); assert.match(result.reason, /preparation failed.*PVC.*Forbidden/) }
  }
})

test('Compose uploads target matches image and storage; OrbStack PVC verbs match GKE', () => {
  const compose = load(read('docker-compose.yml'))
  assert.ok(compose.services.server.volumes.includes('cumora-uploads:/app/server/uploads'))
  assert.equal(compose.volumes['cumora-uploads'].name, 'cumora-uploads')
  assert.match(read('server/docker/cumora-server.Dockerfile'), /WORKDIR \/app/)
  assert.match(read('server/src/storage.ts'), /resolve\(process.cwd\(\), 'server\/uploads'\)/)
  const pvcRule = (path: string) => loadAll(read(path)).find((d: any) => d?.kind === 'Role').rules.find((r: any) => r.resources.includes('persistentvolumeclaims'))
  assert.deepEqual(pvcRule('server/k8s/cumora-server.orbstack.yaml'), pvcRule('server/k8s/cumora-server.gke.yaml'))
  assert.ok(pvcRule('server/k8s/cumora-server.orbstack.yaml'))
})

test('nginx runtime preserves URI and forwards streaming responses without buffering', () => {
  const runtime = read('deploy/nginx.conf').match(/location \/runtime\/ \{([\s\S]*?)\n    \}/)?.[1]
  assert.ok(runtime)
  for (const directive of ['proxy_pass $upstream;', 'proxy_http_version 1.1;', 'proxy_buffering off;', 'proxy_cache off;', 'proxy_read_timeout 3600s;', 'proxy_send_timeout 3600s;']) assert.ok(runtime.includes(directive), directive)
})

test('rollback precheck rejects old gates, accepts compatible ranges and rejects missing evidence', async () => {
  // Pure script helpers never import the database or execute migrations.
  const { schemaRange, checkRollback } = await import(new URL('../../../scripts/rollback-precheck.mjs', import.meta.url).href)
  const candidate = schemaRange(read('server/src/db/migrations/manifest.ts'))
  assert.equal(checkRollback(candidate, { min: 13, max: 14 }).compatible, false)
  assert.equal(checkRollback(candidate, candidate).compatible, true)
  assert.equal(checkRollback(candidate, { min: candidate.max + 1, max: candidate.max + 2 }).compatible, false)
  assert.throws(() => schemaRange(''), /Cannot read/)
})
