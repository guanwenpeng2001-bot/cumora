import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const integrationUrl = process.env.INTEGRATION_DATABASE_URL
test('T32 durable reconciliation and appended migration', { skip: !integrationUrl }, async t => {
  const root = new URL(integrationUrl!)
  // This test creates its own throwaway database off the admin connection, so
  // the base URL just has to be an isolated test server: the local designated
  // instance (15432) or CI's fresh postgres service (its cumora_test DB).
  const isIsolated = ['localhost', '127.0.0.1'].includes(root.hostname)
    && (root.port === '15432' || /test/.test(root.pathname) || process.env.CI === 'true')
  assert.ok(isIsolated, 'use an isolated test database server')
  const dbName = 'cumora_t32_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ connectionString: root.toString() })
  await admin.query(`CREATE DATABASE ${dbName}`)
  root.pathname = '/' + dbName
  process.env.DATABASE_URL = root.toString()
  process.env.SUB2API_ADMIN_KEY = 'test-admin'
  const { pool } = await import('../db/pool.js')
  const { env } = await import('../env.js')
  const { ensureSchema } = await import('../db/migrate.js')
  const { SUB2API_SYNC_SQL } = await import('../db/migrations/0012-sub2api-sync.js')
  const { MAX_SUPPORTED_SCHEMA_VERSION } = await import('../db/migrations/manifest.js')
  const { requestSub2apiSync, reconcileSub2apiSync, getSub2apiSyncStatus, enqueueSub2apiSync, runSub2apiSyncTick } = await import('../sub2api-sync.js')
  const { tierGroups, parseApiKeyMap, SUB2API_PLATFORMS } = await import('../sub2api.js')
  const groups = Object.fromEntries(SUB2API_PLATFORMS.map((p, i) => [p, i + 1]))
  for (const [tier, offset] of [['FREE', 0], ['PRO', 10], ['MAX', 20]] as const) {
    for (const [platform, id] of Object.entries(groups)) {
      ;(env as unknown as Record<string, unknown>)[`SUB2API_TIER_${tier}_GROUP_${platform.toUpperCase()}`] = id + offset
    }
  }
  type Row = Record<string, any>
  const remote = { users: [] as Row[], keys: [] as Row[], subs: [] as Row[], minted: new Map<string, Row>() }
  let call = 0, failAt = 0, loseMint = false, afterCreate = false
  let groupUnavailable = false, zeroBalance = false
  let hook: (() => Promise<void>) | undefined
  const handle = async (url: URL, method: string, body: Row, idem: string): Promise<any> => {
    call++
    if (failAt === call) throw new Error('injected external step failure')
    if (hook) { const fn = hook; hook = undefined; await fn() }
    const p = url.pathname
    let match: RegExpMatchArray | null
    if ((match = p.match(/\/groups\/(\d+)$/))) {
      if (groupUnavailable) throw new Error('group lookup unavailable')
      const id = Number(match[1])
      return { id, platform: SUB2API_PLATFORMS[(id % 10) - 1], status: 'active', subscription_type: zeroBalance ? 'standard' : 'subscription' }
    }
    if (p === '/api/v1/admin/users' && method === 'GET') return { items: remote.users.filter(u => u.email === url.searchParams.get('search')), pages: 1 }
    if (p === '/api/v1/admin/users' && method === 'POST') {
      if (remote.users.some(u => u.email === body.email)) throw new Error('duplicate email')
      const u = { ...body, id: remote.users.length + 1, balance: zeroBalance ? 0 : 100 }
      remote.users.push(u)
      if (afterCreate) { afterCreate = false; throw new Error('lost create response') }
      return u
    }
    if ((match = p.match(/\/users\/(\d+)$/))) {
      const u = remote.users.find(u => u.id === Number(match![1]))!
      if (method === 'PUT') Object.assign(u, body)
      return u
    }
    if (p.endsWith('/subscriptions/assign')) {
      assert.ok(!remote.subs.some(s => s.user_id === body.user_id && s.group_id === body.group_id))
      const sub = { ...body, id: remote.subs.length + 100, status: 'active', expires_at: new Date(Date.now() + 86400000).toISOString() }
      remote.subs.push(sub)
      return sub
    }
    if ((match = p.match(/\/users\/(\d+)\/subscriptions$/))) return remote.subs.filter(s => s.user_id === Number(match![1]))
    if ((match = p.match(/\/subscriptions\/(\d+)$/))) {
      remote.subs = remote.subs.filter(s => s.id !== Number(match![1]))
      return {}
    }
    if ((match = p.match(/\/users\/(\d+)\/api-keys$/))) {
      const uid = Number(match[1])
      if (method === 'GET') return { items: remote.keys.filter(k => k.user_id === uid), pages: 1 }
      assert.ok(idem)
      let key = remote.minted.get(idem)
      if (!key) {
        key = { ...body, id: remote.keys.length + 1, user_id: uid, key: 'sk-test-' + randomUUID(), status: 'active' }
        remote.keys.push(key)
        remote.minted.set(idem, key)
      }
      if (loseMint) { loseMint = false; throw new Error('lost mint response') }
      return key
    }
    if ((match = p.match(/\/api-keys\/(\d+)$/))) {
      const key = remote.keys.find(k => k.id === Number(match![1]))!
      assert.ok(key.name.startsWith('cumora:'), 'must not modify personal key')
      Object.assign(key, body)
      return { api_key: key }
    }
    throw new Error('unexpected fake endpoint ' + p)
  }
  const fake = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.url?.startsWith('/v1/')) {
      const key = remote.keys.find(k => req.headers.authorization === 'Bearer ' + k.key)
      if (!key) { res.statusCode = 401; res.end('{}'); return }
      const platform = SUB2API_PLATFORMS[(key.group_id % 10) - 1]
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: platform + '-test-model' }] }))
      } else {
        const request = JSON.parse(raw)
        if (request.model !== platform + '-test-model') { res.statusCode = 403; res.end('{}'); return }
        res.end(JSON.stringify({ id: 'fake-completion', choices: [{ index: 0, finish_reason: 'stop', message: {
          role: 'assistant', content: JSON.stringify({ userId: key.user_id, groupId: key.group_id }),
        } }] }))
      }
      return
    }
    try {
      const data = await handle(new URL(req.url!, 'http://fake'), req.method!, raw ? JSON.parse(raw) : {}, String(req.headers['idempotency-key'] ?? ''))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 0, data }))
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('lost ')) { res.destroy(); return }
      res.statusCode = 503; res.end(JSON.stringify({ code: 503, message: 'injected failure' }))
    }
  })
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve))
  env.SUB2API_INTERNAL_URL = `http://127.0.0.1:${(fake.address() as { port: number }).port}`
  env.SUB2API_ADMIN_KEY = 'test-admin'
  const addUser = async (id: string) => {
    await pool.query("INSERT INTO users (id,email,display_name,tier) VALUES ($1,$2,$1,'free')", [id, id + '@example.test'])
  }
  const state = async (id: string) => (await pool.query('SELECT tier,sub2api_user_id,sub2api_api_key FROM users WHERE id=$1', [id])).rows[0]
  const check = async (id: string, tier: 'free' | 'pro' | 'max') => {
    const local = await state(id)
    assert.equal(local.tier, tier)
    assert.equal((await getSub2apiSyncStatus(id))?.status, 'succeeded')
    const keys = parseApiKeyMap(local.sub2api_api_key)
    for (const p of SUB2API_PLATFORMS) {
      assert.ok(remote.keys.some(k => k.user_id === Number(local.sub2api_user_id) && k.key === keys[p] && k.group_id === tierGroups(tier)[p]))
    }
    assert.equal(remote.keys.filter(k => k.user_id === Number(local.sub2api_user_id) && k.name.startsWith('cumora:')).length, 4)
  }
  try {
    await t.test('empty migration, repeat, existing v11 upgrade, repeat SQL', async () => {
      await ensureSchema()
      await ensureSchema()
      // Execute a v11 source snapshot in a separate empty test database.
      const dir = join(tmpdir(), 'cumora-work', 'impl', dbName)
      await mkdir(dir, { recursive: true })
      const manifestURL = new URL('../db/migrations/manifest.ts', import.meta.url)
      let manifest = await readFile(manifestURL, 'utf8')
      manifest = manifest.replace(/ {2}\{\s+version: (\d+),[\s\S]*? {2}\},/g,
        (entry, version: string) => Number(version) > 11 ? '' : entry)
        .replace(/MIN_SUPPORTED_SCHEMA_VERSION = \d+/, 'MIN_SUPPORTED_SCHEMA_VERSION = 10')
        .replace(/MAX_SUPPORTED_SCHEMA_VERSION = \d+/, 'MAX_SUPPORTED_SCHEMA_VERSION = 11')
      const manifestPath = join(dir, 'manifest.mts')
      await writeFile(manifestPath, manifest)
      const migrateURL = new URL('../db/migrate.ts', import.meta.url)
      let source = await readFile(migrateURL, 'utf8')
      source = source.replace(/^import \{ SUB2API_SYNC_SQL.*$/m, '')
        .replace(/ {2}\{\s+\.\.\.SCHEMA_MIGRATIONS\[(\d+)\],[\s\S]*? {2}\},/g,
          (entry, index: string) => Number(index) >= 11 ? '' : entry)
        .replace(/from '([^']+)'/g, (all, spec: string) => {
          if (spec === './migrations/manifest.js') return `from '${pathToFileURL(manifestPath).href}'`
          return spec.startsWith('.') ? `from '${new URL(spec.replace(/\.js$/, '.ts'), migrateURL).href}'` : all
        })
      const migratePath = join(dir, 'migrate-v11.mts')
      await writeFile(migratePath, source)
      const upgradeName = dbName + '_upgrade'
      await admin.query(`CREATE DATABASE ${upgradeName}`)
      const upgradeURL = new URL(root); upgradeURL.pathname = '/' + upgradeName
      try {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
          `const old=await import(${JSON.stringify(pathToFileURL(migratePath).href)});await old.ensureSchema();const current=await import('./server/src/db/migrate.ts');await current.ensureSchema();await current.ensureSchema();const {pool}=await import('./server/src/db/pool.ts');await pool.end()`],
          { env: { ...process.env, DATABASE_URL: upgradeURL.toString() }, stdio: ['ignore','pipe','pipe'] })
        let output = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
        const [code] = await once(child, 'exit'); assert.equal(code, 0, output)
      } finally { await admin.query(`DROP DATABASE ${upgradeName}`) }
      await pool.query(SUB2API_SYNC_SQL)
      await pool.query(SUB2API_SYNC_SQL)
      assert.equal(Number((await pool.query('SELECT max(version) AS v FROM schema_migrations')).rows[0].v), MAX_SUPPORTED_SCHEMA_VERSION)
    })
    await t.test('uncommitted intent is invisible and registration survives gateway outage', async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("INSERT INTO users(id,email,display_name) VALUES ('signup','signup@example.test','Signup')")
        await enqueueSub2apiSync(client, 'signup', 'pro')
        const before = call
        await runSub2apiSyncTick()
        assert.equal(call, before)
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      failAt = call + 1
      await runSub2apiSyncTick()
      assert.equal((await state('signup')).tier, 'free')
      assert.equal((await getSub2apiSyncStatus('signup'))?.status, 'failed')
      failAt = 0
      await reconcileSub2apiSync('signup')
      await check('signup', 'pro')
    })
    await t.test('every external step fails once then converges', async () => {
      await addUser('baseline')
      await requestSub2apiSync('baseline', 'pro')
      const before = call
      await reconcileSub2apiSync('baseline')
      await check('baseline', 'pro')
      const steps = call - before
      for (let n = 1; n <= steps; n++) {
        const id = 'step-' + n
        await addUser(id)
        await requestSub2apiSync(id, 'pro')
        failAt = call + n
        await reconcileSub2apiSync(id)
        assert.equal((await state(id)).tier, 'free', 'effective tier before confirmation')
        failAt = 0
        await reconcileSub2apiSync(id)
        await check(id, 'pro')
      }
    })
    await t.test('tier-change step failures reuse managed keys and converge', async () => {
      await addUser('tier-baseline')
      await requestSub2apiSync('tier-baseline', 'free')
      await reconcileSub2apiSync('tier-baseline')
      await requestSub2apiSync('tier-baseline', 'pro')
      const before = call
      await reconcileSub2apiSync('tier-baseline')
      const steps = call - before
      await check('tier-baseline', 'pro')
      for (let n = 1; n <= steps; n++) {
        const id = 'tier-step-' + n
        await addUser(id)
        await requestSub2apiSync(id, 'free')
        await reconcileSub2apiSync(id)
        const original = (await state(id)).sub2api_api_key
        await requestSub2apiSync(id, 'pro')
        failAt = call + n
        await reconcileSub2apiSync(id)
        assert.equal((await state(id)).tier, 'free')
        failAt = 0
        await reconcileSub2apiSync(id)
        await check(id, 'pro')
        assert.equal((await state(id)).sub2api_api_key, original)
      }
    })
    await t.test('superseding a lost mint preserves its operation identity', async () => {
      await addUser('superseded-mint')
      await requestSub2apiSync('superseded-mint', 'pro')
      loseMint = true
      await reconcileSub2apiSync('superseded-mint')
      await requestSub2apiSync('superseded-mint', 'max')
      await reconcileSub2apiSync('superseded-mint')
      await check('superseded-mint', 'max')
    })
    await t.test('lost user and mint responses preserve unique remote objects', async () => {
      await addUser('lost')
      await requestSub2apiSync('lost', 'pro')
      afterCreate = true
      loseMint = true
      await reconcileSub2apiSync('lost')
      assert.equal((await state('lost')).tier, 'free')
      await reconcileSub2apiSync('lost')
      await check('lost', 'pro')
      assert.equal(remote.users.filter(u => u.email === 'lost@example.test').length, 1)
    })
    await t.test('final local commit failure and fresh process recovery', async () => {
      await addUser('restart')
      await requestSub2apiSync('restart', 'pro')
      await pool.query(`CREATE FUNCTION t32_fail_final() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id = 'restart' AND NEW.sub2api_user_id IS NOT NULL THEN RAISE EXCEPTION 'injected final failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER t32_final BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION t32_fail_final()`)
      await reconcileSub2apiSync('restart')
      assert.equal((await state('restart')).tier, 'free')
      await pool.query('DROP TRIGGER t32_final ON users')
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        "const {reconcileSub2apiSync}=await import('./server/src/sub2api-sync.ts');await reconcileSub2apiSync('restart');const {pool}=await import('./server/src/db/pool.ts');await pool.end()"],
        { env: { ...process.env, DATABASE_URL: root.toString(), SUB2API_INTERNAL_URL: env.SUB2API_INTERNAL_URL, SUB2API_ADMIN_KEY: 'test-admin' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', b => { output += b })
      child.stderr.on('data', b => { output += b })
      const [code] = await once(child, 'exit')
      assert.equal(code, 0, output)
      await check('restart', 'pro')
    })
    await t.test('newest target wins, competing consumers and two users stay isolated', async () => {
      await addUser('race')
      await addUser('other')
      await requestSub2apiSync('race', 'pro')
      await requestSub2apiSync('other', 'free')
      hook = async () => {
        assert.equal(await reconcileSub2apiSync('race'), null, 'second consumer cannot claim the same user')
        await requestSub2apiSync('race', 'max')
      }
      await Promise.all([reconcileSub2apiSync('race'), reconcileSub2apiSync('other')])
      await check('race', 'max')
      await check('other', 'free')
      assert.notDeepEqual(parseApiKeyMap((await state('race')).sub2api_api_key), parseApiKeyMap((await state('other')).sub2api_api_key))
    })
    await t.test('real LLM client authenticates two users across four fake platforms', async () => {
      const { getLlmClient } = await import('../llm.js')
      for (const owner of ['race', 'other']) {
        const company = 'company-' + owner
        await pool.query('INSERT INTO companies(id,name,slug,owner_user_id) VALUES ($1,$1,$1,$2)', [company, owner])
        const client = await getLlmClient(company)
        for (const platform of SUB2API_PLATFORMS) {
          const result = await client.chat.completions.create({ model: platform + '-test-model', messages: [{ role: 'user', content: 'test' }] })
          const observed = JSON.parse(result.choices[0].message.content!)
          assert.equal(observed.userId, Number((await state(owner)).sub2api_user_id))
          assert.equal(observed.groupId, tierGroups(owner === 'race' ? 'max' : 'free')[platform])
        }
      }
    })
    await t.test('personal and disabled keys, group errors and standard balance fail closed', async () => {
      const uid = Number((await state('race')).sub2api_user_id)
      const personal = { id: 90000, user_id: uid, name: 'personal', key: 'sk-personal', group_id: 21, status: 'active' }
      remote.keys.push(personal)
      await requestSub2apiSync('race', 'pro')
      groupUnavailable = true
      await reconcileSub2apiSync('race')
      assert.equal((await state('race')).tier, 'max')
      groupUnavailable = false
      await reconcileSub2apiSync('race')
      assert.equal(personal.group_id, 21)
      await check('race', 'pro')
      const managed = remote.keys.find(k => k.user_id === uid && k.name.startsWith('cumora:'))!
      managed.status = 'disabled'
      await requestSub2apiSync('race', 'max')
      await reconcileSub2apiSync('race')
      assert.equal((await getSub2apiSyncStatus('race'))?.status, 'failed')
      assert.equal(managed.status, 'disabled')
      managed.status = 'active'
      await addUser('balance')
      await requestSub2apiSync('balance', 'pro')
      zeroBalance = true
      await reconcileSub2apiSync('balance')
      assert.equal((await state('balance')).tier, 'free')
      assert.equal(remote.users.find(u => u.email === 'balance@example.test')?.balance, 0)
      zeroBalance = false
    })
  } finally {
    await pool.end()
    await new Promise<void>(resolve => fake.close(() => resolve()))
    await admin.query(`DROP DATABASE ${dbName}`)
    await admin.end()
  }
})
