import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { ManagedPodSettings } from '../managed-pod-settings.js'

// Unlike the broad integration suite, this test never truncates shared tables.
// Its policy table is private; all other writes use unique fixture identities.
test('real runtime authenticates a credential-free Pod, streams attempts and persists one ledger per send', {
  skip: process.env.INTEGRATION_DATABASE_URL !== 'postgres://postgres:cumora_test@localhost:15432/cumora_test', timeout: 30_000,
}, async t => {
  const suffix = randomUUID().replaceAll('-', '')
  const schema = `fix_y1b_${suffix}`
  const companyId = `y1b-company-${suffix}`
  const agentId = `y1b-agent-${suffix}`
  const ownerId = `y1b-owner-${suffix}`
  const admin = new Pool({ connectionString: process.env.INTEGRATION_DATABASE_URL, connectionTimeoutMillis: 2000 })
  t.after(async () => {
    await admin.query('DELETE FROM llm_calls WHERE company_id = $1', [companyId])
    await admin.query('DELETE FROM participants WHERE company_id = $1', [companyId])
    await admin.query('DELETE FROM companies WHERE id = $1', [companyId])
    await admin.query('DELETE FROM users WHERE id = $1', [ownerId])
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  })
  await admin.query(`CREATE SCHEMA ${schema}`)
  await admin.query(`CREATE TABLE ${schema}.server_settings (LIKE public.server_settings INCLUDING ALL)`)
  await admin.query(`INSERT INTO ${schema}.server_settings (key, value) VALUES ('__settings_revision', '1')`)
  const url = new URL(process.env.INTEGRATION_DATABASE_URL!)
  url.searchParams.set('options', `-csearch_path=${schema},public`)
  Object.assign(process.env, { DATABASE_URL: url.href, REDIS_URL: 'redis://localhost:16379',
    DOTENV_CONFIG_PATH: '__isolated_nonexistent_env__', OPENAI_API_KEY: 'isolated-provider-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:1/v1', OPENAI_MODEL: 'gpt-5.5', OPENAI_COMPACTION_MODEL: 'gpt-5.4-mini',
    SUB2API_INTERNAL_URL: '', SUB2API_PUBLIC_URL: '', SUB2API_ADMIN_KEY: '',
    AGENT_RUNTIME_SECRET: `isolated-server-${suffix}`, CUMORA_RUNTIME_CLIENT: 'inproc',
  })
  const { pool } = await import('../db/pool.js')
  const { redis, sub } = await import('../redis.js')
  t.after(async () => { await pool.end(); redis.disconnect(); sub.disconnect() })
  await admin.query("INSERT INTO users (id, email, display_name, tier) VALUES ($1, $2, 'Isolated owner', 'free')", [ownerId, `${ownerId}@test.invalid`])
  await admin.query("INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, 'Isolated company', $1, $2)", [companyId, ownerId])
  const participant = await admin.query("INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status) VALUES ($1,$2,'agent','Isolated agent','tester','I','#ffffff','avail') RETURNING runtime_assignment_id", [agentId, companyId])
  const { signAgentToken } = await import('../agents/runtime/jwt.js')
  const token = signAgentToken({ agentId, companyId, computerId: null, assignmentId: participant.rows[0].runtime_assignment_id })
  const { __setLlmClientOverrideForTesting } = await import('../llm.js')
  let sends = 0
  __setLlmClientOverrideForTesting(async () => ({ responses: { create: async () => {
    const attempt = ++sends
    return (async function* () {
      yield { type: 'response.created', response: { model: 'isolated-actual', usage: { input_tokens: 3, output_tokens: 1 } } }
      if (attempt === 1) throw Object.assign(new Error('isolated fake transport failure'), { code: 'ECONNRESET' })
      yield { type: 'response.output_text.delta', item_id: 'text', content_index: 0, delta: 'isolated summary' }
      yield { type: 'response.completed', response: { id: 'isolated-response', status: 'completed', model: 'isolated-actual',
        usage: { input_tokens: 5, output_tokens: 2 }, output: [] } }
    })()
  } } } as never))
  t.after(() => __setLlmClientOverrideForTesting(null))
  const express = (await import('express')).default
  const { runtimeRouter } = await import('../agents/runtime/server.js')
  const app = express()
  app.use('/runtime', runtimeRouter)
  const server = createServer(app).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${port}/runtime`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const response = await fetch(`${baseUrl}/llm/settings`, { method: 'POST', headers, body: '{}' })
  assert.equal(response.status, 200)
  const bootstrap = await response.json() as ManagedPodSettings
  assert.equal(bootstrap.version, 2)
  assert.doesNotMatch(JSON.stringify(bootstrap), /apiKey|gateway|isolated-provider-key/)
  const denied = await fetch(`${baseUrl}/llm/stream`, { method: 'POST', headers,
    body: JSON.stringify({ purpose: 'agent-turn', input: [], instructions: '', tools: [], runId: 'foreign-run' }) })
  assert.equal(denied.status, 403)
  assert.equal(sends, 0)
  const childEnv: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[key]) childEnv[key] = process.env[key]
  }
  Object.assign(childEnv, { NODE_ENV: 'production', DOTENV_CONFIG_PATH: '__isolated_nonexistent_env__',
    CUMORA_RUNTIME_CLIENT: 'http', CUMORA_AGENT_ID: agentId, CUMORA_AGENT_RUNTIME_URL: baseUrl,
    CUMORA_AGENT_RUNTIME_TOKEN: token, CUMORA_MANAGED_POD_BOOTSTRAP: JSON.stringify(bootstrap),
  })
  const script = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    const original = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      const port = typeof options === 'object' ? options.port : options;
      assert.equal(Number(port), ${port}, 'Pod attempted a connection outside runtime');
      return original.apply(this, args);
    };
    const { initializeManagedPodSettings } = await import('./server/src/settings.ts');
    await initializeManagedPodSettings();
    const { runtime } = await import('./server/src/agents/runtime/select.ts');
    await runtime.setStatus(process.env.CUMORA_AGENT_ID, 'avail');
    const { executeAgentTurnHop, executeAuxiliaryStream } = await import('./server/src/agents/turn.ts');
    let inputTokens = 0, attempts = 0, retries = 0;
    const result = await executeAgentTurnHop({ context: { purpose: 'agent-turn' }, input: [], tools: [], instructions: '',
      onAttempt: async record => { attempts++; inputTokens += record.usage?.inputTokens ?? 0; },
      retryEvent: async () => { retries++; } });
    assert.equal(result.state.completed, true);
    assert.equal(result.state.responseTextByPart.get('text:0'), 'isolated summary');
    assert.equal(attempts, 2); assert.equal(retries, 1); assert.equal(inputTokens, 8);
    assert.equal(await executeAuxiliaryStream({ purpose: 'compaction', agentId: process.env.CUMORA_AGENT_ID,
      input: [], instructions: '', outputTokens: 50, parse: text => text.trim() }), 'isolated summary');
    console.log('REAL_RUNTIME_CREDENTIAL_FREE_OK');
    process.exit(0);
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, output)
  assert.match(output, /REAL_RUNTIME_CREDENTIAL_FREE_OK/)
  let rows: Array<{ status: string; input_tokens: number }> = []
  for (let n = 0; n < 100; n++) {
    rows = (await admin.query('SELECT status, input_tokens FROM llm_calls WHERE company_id = $1 ORDER BY created_at', [companyId])).rows
    if (rows.length === 3) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(sends, 3)
  assert.equal(rows.length, 3)
  assert.equal(rows.filter(row => row.status === 'ok').length, 2)
  assert.equal(rows.reduce((sum, row) => sum + row.input_tokens, 0), 13)
})
