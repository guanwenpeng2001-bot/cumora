import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

// Load the real helpers with explicit dependency fakes, without importing any
// database, Redis, environment credentials, or push transport singletons.
function loadHelper(file: string, dependencies: Record<string, unknown>): Record<string, any> {
  const source = readFileSync(new URL(`../agents/${file}.ts`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const exports = {}
  new Function('require', 'exports', outputText)((name: string) => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`)
    return dependencies[name]
  }, exports)
  return exports
}

function harness(file: 'private_chat' | 'scanner_helper', options: {
  existing?: boolean; invalid?: boolean; cooldown?: boolean; failCommit?: boolean
} = {}) {
  const events: string[] = []
  const pushes: Record<string, unknown>[] = []
  const writes: { sql: string; params: unknown[] }[] = []
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql === 'COMMIT' && options.failCommit) throw new Error('commit failed')
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) events.push(sql)
    if (sql.includes('SELECT company_id FROM participants')) return { rows: [{ company_id: 'tenant' }] }
    if (sql.includes('FOR SHARE')) return { rows: options.invalid ? [] : [
      { id: 'agent', name: 'Agent', kind: 'agent' },
      { id: 'human', name: 'Human', kind: 'human' },
    ] }
    if (sql.includes('FOR UPDATE OF c')) return { rows: options.existing ? [{ id: 'existing-dm' }] : [] }
    if (sql.includes("pulled_by ->> 'agentId'")) return { rows: options.cooldown ? [
      { id: 'recent-group', title: 'Recent', at: new Date().toISOString() },
    ] : [] }
    if (sql.includes('RETURNING next_sequence')) return { rows: [{ seq: 7 }] }
    if (sql.includes('INSERT INTO messages')) writes.push({ sql, params })
    return { rows: [] }
  }
  const helper = loadHelper(file, {
    'node:crypto': { randomUUID },
    '../db/pool.js': { pool: { query, connect: async () => ({ query, release: () => events.push('release') }) } },
    '../redis.js': {
      CH_MESSAGE_NEW: 'message.new', CH_GROUP_PULLED: 'group.pulled',
      publish: async (channel: string) => { events.push(channel) },
    },
    '../realtime-outbox.js': {
      enqueueBroadcast: async () => { events.push('enqueue') },
      nudgeRealtimeOutbox: () => { events.push('nudge') },
    },
    '../push.js': { dispatchMessagePush: (args: Record<string, unknown>) => {
      events.push('push')
      pushes.push(args)
      // A pending delivery must not prevent the helper returning its result.
      return new Promise<void>(() => {})
    } },
  })
  const run = () => file === 'private_chat'
    ? helper.startPrivateChat({ instigatorId: 'agent', partnerId: 'human', topic: 'topic', opening: 'opening' })
    : helper.startPulledGroup({ instigatorId: 'agent', members: ['human'], title: 'title', reason: 'reason', opening: 'opening' })
  return { run, events, pushes, writes }
}

for (const file of ['private_chat', 'scanner_helper'] as const) {
  test(`${file}: opening dispatches once after commit and release without waiting for push`, async () => {
    const h = harness(file)
    const result = await h.run()
    assert.equal(h.pushes.length, 1)
    assert.equal(h.writes.length, 1)
    assert.deepEqual(h.pushes[0], {
      conversationId: result.conversationId, authorId: 'agent',
      messageId: h.writes[0].params[0], body: 'opening', companyId: 'tenant',
    })
    assert.ok(h.events.indexOf('push') > h.events.indexOf('COMMIT'))
    assert.ok(h.events.indexOf('push') > h.events.indexOf('release'))
    if (file === 'private_chat') {
      assert.ok(h.events.indexOf('enqueue') < h.events.indexOf('COMMIT'))
      assert.equal(h.writes[0].params[4], 7)
    } else {
      assert.ok(h.events.indexOf('message.new') > h.events.indexOf('COMMIT'))
    }
  })

  test(`${file}: failed commit rolls back and never dispatches`, async () => {
    const h = harness(file, { failCommit: true })
    await assert.rejects(h.run(), /commit failed/)
    assert.deepEqual(h.pushes, [])
    assert.ok(h.events.includes('ROLLBACK'))
    assert.ok(h.events.includes('release'))
  })

  test(`${file}: invalid participants produce neither message nor push`, async () => {
    const h = harness(file, { invalid: true })
    await assert.rejects(h.run(), /foreign, departed, or missing|active participants/)
    assert.deepEqual(h.pushes, [])
    assert.deepEqual(h.writes, [])
    assert.ok(h.events.includes('ROLLBACK'))
  })
}

test('private_chat: reused direct conversation still dispatches its new message', async () => {
  const h = harness('private_chat', { existing: true })
  const result = await h.run()
  assert.equal(result.conversationId, 'existing-dm')
  assert.equal(h.pushes[0].conversationId, 'existing-dm')
  assert.equal(h.pushes[0].messageId, result.messageId)
})

test('scanner_helper: human pull cooldown still rejects without a message or push', async () => {
  const h = harness('scanner_helper', { cooldown: true })
  await assert.rejects(h.run(), /rate-limited/)
  assert.deepEqual(h.pushes, [])
  assert.deepEqual(h.writes, [])
})
