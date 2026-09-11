import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseManagedPodSettings } from '../managed-pod-settings.js'

test('v1 bootstrap is projected to v2 without retaining credentials; malformed revisions fail closed', () => {
  const legacy = { version: 1, agentId: 'a', gateway: { companyId: 'c', keys: { openai: 'secret' }, baseURL: 'https://provider.invalid' },
    direct: { text: { apiKey: 'secret2' } }, policy: { revision: '1', settings: { brain_model: 'm' }, sources: { brain_model: 'db' } },
    defaults: { brain_model: 'm' }, source: 'bootstrap' }
  const result = parseManagedPodSettings(legacy)
  assert.equal(result.version, 2)
  assert.equal(result.companyId, 'c')
  assert.doesNotMatch(JSON.stringify(result), /secret|gateway|direct|provider/)
  for (const revision of ['-1', 'NaN', '', '1.1']) assert.throws(() => parseManagedPodSettings({ ...legacy, policy: { ...legacy.policy, revision } }))
  assert.throws(() => parseManagedPodSettings({ ...legacy, version: 3 }))
})

test('credential-free production Pod imports, refreshes policy and boots on an isolated HTTP stack without hidden connections', { timeout: 25_000 }, async t => {
  const paths: string[] = []
  let wake!: () => void
  const wakeConnected = new Promise<void>(resolve => { wake = resolve })
  const server = createServer((req, res) => {
    paths.push(req.url!)
    assert.equal(req.headers.authorization, 'Bearer isolated-runtime-token')
    if (req.url === '/runtime/wake-stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      wake()
    } else if (req.url === '/runtime/llm/settings') {
      // Exercise an unavailable control plane: bootstrap remains sufficient to start.
      res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"isolated refresh unavailable"}')
    } else res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const port = (server.address() as AddressInfo).port
  const childEnv: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[key]) childEnv[key] = process.env[key]
  }
  Object.assign(childEnv, {
    NODE_ENV: 'production', DOTENV_CONFIG_PATH: '__isolated_nonexistent_env__',
    CUMORA_RUNTIME_CLIENT: 'http', CUMORA_AGENT_ID: 'isolated-agent',
    CUMORA_AGENT_RUNTIME_URL: `http://127.0.0.1:${port}/runtime`,
    CUMORA_AGENT_RUNTIME_TOKEN: 'isolated-runtime-token',
  })
  assert.equal(childEnv.DATABASE_URL, undefined)
  assert.equal(childEnv.REDIS_URL, undefined)
  const script = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      const port = typeof options === 'object' ? options.port : options;
      if (Number(port) !== ${port}) {
        console.error('FORBIDDEN_CONNECTION', port);
        throw new Error('Unexpected network access');
      }
      return connect.apply(this, args);
    };
    const settings = await import('./server/src/settings.ts');
    const managed = await import('./server/src/managed-pod-settings.ts');
    const defs = settings.SETTING_DEFS.filter(def => def.pod);
    const values = Object.fromEntries(defs.map(def => [def.key, def.envValue()]));
    managed.installManagedPodSettings({ version: 2, agentId: 'isolated-agent', companyId: 'isolated-company',
      defaults: values, source: 'bootstrap', policy: { revision: '1', settings: values,
        sources: Object.fromEntries(defs.map(def => [def.key, 'default'])) } });
    const { pool } = await import('./server/src/db/pool.ts');
    await assert.rejects(pool.query('SELECT 1'), /forbidden/);
    await assert.rejects(pool.connect(), /forbidden/);
    const { redis } = await import('./server/src/redis.ts');
    assert.throws(() => redis.ping(), /forbidden/);
    await assert.rejects(redis.connect(), /forbidden/);
    const { refreshModelPricing } = await import('./server/src/model-pricing.ts');
    await refreshModelPricing(true);
    const { env } = await import('./server/src/env.ts');
    assert.equal(env.AGENT_RUNTIME_SECRET, '');
    const { getLlmClient, getLlmCandidateClient, executeImage } = await import('./server/src/llm.ts');
    await assert.rejects(getLlmClient('isolated-company'), /server-only/);
    await assert.rejects(getLlmCandidateClient({}, {}), /server-only/);
    await assert.rejects(executeImage({}, {}, async () => { throw new Error('unexpected storage'); }), /runtime CLI/);
    await import('./server/src/agents/runtime/pod-agent.ts');
    console.log('ISOLATED_IMPORTS_VERIFIED');
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: childEnv, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  await Promise.race([wakeConnected, once(child, 'exit').then(([code]) => { throw new Error(`Pod exited ${code}: ${output}`) })])
  assert.match(output, /ISOLATED_IMPORTS_VERIFIED/)
  assert.match(output, /Pod ready source=bootstrap revision=1/)
  assert.doesNotMatch(output, /FORBIDDEN_CONNECTION|ECONNREFUSED|unhandledRejection/)
  assert.ok(paths.includes('/runtime/llm/settings'))
  assert.ok(paths.includes('/runtime/status'))
  assert.ok(paths.includes('/runtime/wake-stream'))
})
