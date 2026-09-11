import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import IORedis from 'ioredis'
import ts from 'typescript'
import type { InProcRuntimeClient } from '../agents/runtime/inproc-client.js'

// Load the real methods without importing server singletons or opening Postgres.
const source = ts.createSourceFile('inproc.ts', readFileSync(new URL('../agents/runtime/inproc-client.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const runtimeClass = source.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'InProcRuntimeClient') as ts.ClassDeclaration
const methods = runtimeClass.members.filter(m => ts.isMethodDeclaration(m) && ['claimWork', 'releaseWork'].includes(m.name.getText(source)))
const helpers = source.statements.filter(s => ts.isFunctionDeclaration(s) && ['worklogKey', 'worklogField', 'normalizeWorkSubject', 'parseWorklogEntry'].includes(s.name?.text ?? ''))
const code = ts.transpileModule(`${helpers.map(s => s.getText(source).replace(/^export /, '')).join('\n')}
class Runtime { ${methods.map(m => m.getText(source)).join('\n')} }; new Runtime()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

function runtime(redis: IORedis, hget = redis.hget.bind(redis)): InProcRuntimeClient {
  return runInNewContext(code, {
    Date,
    console: { warn: (...args: unknown[]) => { throw new Error(`Unexpected Redis fail-open: ${args.join(' ')}`) } },
    redis: new Proxy(redis, {
      get(target, property) {
        if (property === 'hget') return hget
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
  }) as InProcRuntimeClient
}

test('worklog claims on isolated Redis', async t => {
  const clients = [0, 1].map(() => new IORedis('redis://127.0.0.1:16379', {
    lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0,
  }))
  const scopeKey = `fix-z6-test:${randomUUID()}`
  const key = `cumora:worklog:${scopeKey}`
  const field = 'doc-create::atomic claim'
  const args = { scopeKey, taskType: 'doc-create' as const, subject: 'Atomic claim' }
  const [a, b] = clients
  try {
    await Promise.all(clients.map(client => client.connect()))
    await t.test('two concurrent stale takeovers have one winner, including a delayed stale reader', async () => {
      await a.hset(key, field, JSON.stringify({ ...args, agentId: 'expired', startedAt: Date.now() - 301_000 }))
      await a.expire(key, 600)
      let bothRead!: () => void
      const snapshotsReady = new Promise<void>(resolve => { bothRead = resolve })
      let firstFinished!: () => void
      const firstDone = new Promise<void>(resolve => { firstFinished = resolve })
      let reads = 0
      const contender = (client: IORedis, delayed: boolean) => runtime(client, async (k, f) => {
        const snapshot = await client.hget(k, f)
        if (++reads <= 2) {
          if (reads === 2) bothRead()
          await snapshotsReady
          if (delayed) await firstDone
        }
        return snapshot
      })
      const first = contender(a, false).claimWork({ ...args, agentId: 'a' }).finally(firstFinished)
      const second = contender(b, true).claimWork({ ...args, agentId: 'b' })
      const results = await Promise.all([first, second])
      assert.equal(results.filter(result => result.accepted).length, 1)
      assert.equal(results[0].accepted, true)
      assert.equal(results[1].accepted, false)
      if (!results[1].accepted) assert.equal(results[1].existing.agentId, 'a')
      assert.equal(JSON.parse((await a.hget(key, field))!).agentId, 'a')
      assert.ok((await a.ttl(key)) > 0 && (await a.ttl(key)) <= 300)
    })
    await t.test('an unexpired lease cannot be taken and a rejected claim does not renew it', async () => {
      const raw = await a.hget(key, field)
      await a.expire(key, 120)
      const result = await runtime(b).claimWork({ ...args, agentId: 'b' })
      assert.equal(result.accepted, false)
      assert.equal(await a.hget(key, field), raw)
      assert.ok((await a.ttl(key)) <= 120)
    })
    await t.test('only the owner can release, then another agent can claim with its chosen TTL', async () => {
      await runtime(b).releaseWork({ ...args, agentId: 'b' })
      assert.equal((await runtime(b).claimWork({ ...args, agentId: 'b' })).accepted, false)
      await runtime(a).releaseWork({ ...args, agentId: 'a' })
      assert.equal((await runtime(b).claimWork({ ...args, agentId: 'b', ttlSec: 42 })).accepted, true)
      assert.equal(JSON.parse((await a.hget(key, field))!).agentId, 'b')
      assert.ok((await a.ttl(key)) > 0 && (await a.ttl(key)) <= 42)
    })
  } finally {
    if (a.status === 'ready') await a.del(key)
    for (const client of clients) client.disconnect()
  }
})
