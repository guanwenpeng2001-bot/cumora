import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { WsDispatch } from '../ws-dispatch.js'

const require = createRequire(import.meta.url)
function declarations(file: string, names: string[], deps: Record<string, unknown>) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const selected = ast.statements.filter(n =>
    ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '') ||
    ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast))),
  ).map(n => n.getText(ast)).join('\n')
  const js = ts.transpileModule(selected + '\nexport { ' + names.join(',') + ' }', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const result: Record<string, any> = {}
  new Function('exports', ...Object.keys(deps), js)(result, ...Object.values(deps))
  return result
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function drain<T>(queue: WsDispatch<T>) {
  for (let i = 0; i < 100 && queue.snapshot().queued; i++) await turn()
  assert.equal(queue.snapshot().queued, 0)
}

test('WS batches preserve FIFO, amortize live authorization, and revisit revoked membership', async () => {
  let allowed = true, queries = 0
  const delivered: number[] = [], batches: number[][] = []
  const queue = new WsDispatch<number>(async values => {
    queries++
    batches.push(values)
    if (allowed) delivered.push(...values)
    allowed = false // revocation committed before the next batch lookup
  }, () => assert.fail('unexpected resync'), { batch: 3, concurrency: 2, events: 20, bytes: 100, ageMs: 5000 })
  for (let i = 0; i < 10; i++) queue.enqueue('room', i, 1)
  await drain(queue)
  assert.deepEqual(batches.flat(), Array.from({ length: 10 }, (_, i) => i))
  assert.deepEqual(delivered, [0, 1, 2])
  assert.equal(queries, 4)
})

test('WS room batches retain terminal notice recipients only on their persisted message', async () => {
  let calls = 0
  const api = declarations('../ws.ts', ['resolveWsConversationBatch'], { pool: { query: async (sql: string, args: unknown[]) => {
    calls++
    assert.match(sql, /m\.kind = 'system'/)
    assert.match(sql, /m\.company_id = c\.company_id/)
    assert.deepEqual(args, ['room', 'tenant', ['normal', 'leave']])
    return { rows: [{ user_id: 'member', message_id: null }, { user_id: 'removed', message_id: 'leave' }] }
  } } })
  const result = await api.resolveWsConversationBatch([
    { type: 'message.new', companyId: 'tenant', conversationId: 'room', message: { id: 'normal' } },
    { type: 'message.new', companyId: 'tenant', conversationId: 'room', message: { id: 'leave' } },
    { type: 'message.delta', companyId: 'tenant', conversationId: 'room' },
  ])
  assert.deepEqual(result.map((s: Set<string>) => [...s]), [['member'], ['member', 'removed'], ['member']])
  assert.equal(calls, 1)
})

test('WS bounds include in-flight work; overflow and authorization failure request REST recovery', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const lost: number[] = [], sent: number[] = []
  const queue = new WsDispatch<number>(async batch => { await blocked; sent.push(...batch) },
    batch => { lost.push(...batch) }, { batch: 2, concurrency: 1, events: 3, bytes: 3, ageMs: 5000 })
  queue.enqueue('a', 1, 1); queue.enqueue('a', 2, 1)
  await turn()
  queue.enqueue('a', 3, 1); queue.enqueue('a', 4, 1)
  assert.equal(queue.snapshot().queued, 3)
  assert.equal(queue.snapshot().queuedBytes, 3)
  assert.deepEqual(lost, [4])
  release(); await drain(queue)
  assert.deepEqual(sent, [1, 2, 3])
  const failed = new WsDispatch<number>(async () => { throw new Error('DB down') }, batch => { lost.push(...batch) })
  failed.enqueue('a', 5, 1); await drain(failed)
  assert.deepEqual(lost, [4, 5])
})

test('WS hot room yields its dispatch slot to a quiet room', async () => {
  const order: number[] = []
  const queue = new WsDispatch<number>(async batch => { order.push(...batch) }, () => {},
    { batch: 2, concurrency: 1, events: 20, bytes: 20, ageMs: 5000 })
  for (let i = 0; i < 10; i++) queue.enqueue('hot', i, 1)
  queue.enqueue('quiet', 99, 1)
  await drain(queue)
  assert.equal(order.indexOf(99), 2)
})

test('WS rejects an expired batch after a slow authorization lookup', async () => {
  const recovered: number[] = []
  let sends = 0
  const queue = new WsDispatch<number>(async (_batch, expired) => {
    await new Promise(resolve => setTimeout(resolve, 20))
    if (expired()) throw new Error('lookup expired')
    sends++
  }, batch => { recovered.push(...batch) }, { batch: 2, concurrency: 1, events: 4, bytes: 4, ageMs: 1 })
  queue.enqueue('room', 1, 1)
  await new Promise(resolve => setTimeout(resolve, 40))
  await drain(queue)
  assert.equal(sends, 0)
  assert.deepEqual(recovered, [1])
})

test('PostgreSQL: a fresh WS batch observes room and workspace revocation without losing the terminal notice',
  { skip: !process.env.PERF_TEST_PG_CONTAINER }, () => {
    const source = readFileSync(new URL('../ws.ts', import.meta.url), 'utf8')
    const query = source.match(/`(WITH scoped_conversation[^`]+)`/)![1]
    const sql = `BEGIN;
      CREATE TEMP TABLE conversations(id text,company_id text);
      CREATE TEMP TABLE participants(id text,company_id text,kind text,departed_at timestamptz);
      CREATE TEMP TABLE company_members(user_id text,company_id text);
      CREATE TEMP TABLE conversation_members(conversation_id text,company_id text,participant_id text);
      CREATE TEMP TABLE messages(id text,conversation_id text,company_id text,kind text,delivery_recipient_id text);
      INSERT INTO conversations VALUES('room','tenant');
      INSERT INTO participants VALUES('alice','tenant','human',NULL),('bob','tenant','human',NULL);
      INSERT INTO company_members VALUES('alice','tenant'),('bob','tenant');
      INSERT INTO conversation_members VALUES('room','tenant','alice'),('room','tenant','bob');
      INSERT INTO messages VALUES('normal','room','tenant','text',NULL),('leave','room','tenant','system','bob');
      PREPARE recipients(text,text,text[]) AS SELECT COALESCE(jsonb_agg(r ORDER BY user_id,message_id),'[]') FROM (${query}) r;
      EXECUTE recipients('room','tenant',ARRAY['normal','leave']);
      DELETE FROM conversation_members WHERE participant_id='bob';
      EXECUTE recipients('room','tenant',ARRAY['normal','leave']);
      DELETE FROM company_members WHERE user_id='bob';
      EXECUTE recipients('room','tenant',ARRAY['normal','leave']);
      EXECUTE recipients('room','other-tenant',ARRAY['normal','leave']);
      ROLLBACK;`
    const output = execFileSync(process.env.PERF_DOCKER_BIN ?? 'docker',
      ['exec', '-i', process.env.PERF_TEST_PG_CONTAINER!, 'psql', '-U', 'postgres', '-d', 'cumora', '-XqAt', '-v', 'ON_ERROR_STOP=1'],
      { input: sql, encoding: 'utf8', windowsHide: true })
    const [before, roomRevoked, tenantRevoked, foreign] = output.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(before.length, 3)
    assert.deepEqual(roomRevoked, [{ user_id: 'alice', message_id: null }, { user_id: 'bob', message_id: 'leave' }])
    assert.deepEqual(tenantRevoked, [{ user_id: 'alice', message_id: null }])
    assert.deepEqual(foreign, [])
  })

test('session activity is durable once per minute, monotonic, and does not bypass expiry or suspension', async () => {
  let at = Date.now() - 61_000, updates = 0, suspended: string | null = null
  const api = declarations('../auth.ts', ['hashToken', 'resolveSession', 'SESSION_IDLE_TTL_MS'], {
    createHash: require('node:crypto').createHash,
    pool: { query: async (sql: string) => {
      if (sql.startsWith('SELECT')) return { rows: [{ user_id: 'u', expires_at: new Date(Date.now() + 86400000), last_used_at: new Date(at), suspended_at: suspended, deleted_at: null }] }
      if (sql.startsWith('UPDATE')) {
        assert.match(sql, /last_used_at <= NOW\(\) - INTERVAL '1 minute'/)
        if (at <= Date.now() - 60000) { at = Date.now(); updates++ }
      }
      return { rows: [] }
    } },
  })
  const before = at
  await Promise.all(Array.from({ length: 50 }, () => api.resolveSession('test')))
  assert.equal(updates, 1)
  assert.ok(at > before)
  for (let i = 0; i < 100; i++) assert.deepEqual(await api.resolveSession('test'), { userId: 'u' })
  assert.equal(updates, 1)
  at = Date.now() - 61000
  await api.resolveSession('test')
  assert.equal(updates, 2)
  suspended = new Date().toISOString()
  assert.equal(await api.resolveSession('test'), null)
  suspended = null; at = 0
  assert.equal(await api.resolveSession('test'), null)
})
