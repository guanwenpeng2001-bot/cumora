import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../agents/computer/daemon.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('daemon.ts', source, ts.ScriptTarget.Latest, true)
const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'AgentRunner') as ts.ClassDeclaration
function fixture(rows: unknown[], payload: unknown = { messageIds: ['m-44'], verdict: { outcome: 'ignore', ackAllowed: true } }) {
  const declarations = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'renderInboxDigest').map(n => n.getText(ast).replace(/^export /, '')).join('\n')
  const methods = cls.members.filter(n => n.name && ['snapshotUnread', 'ackSeen', 'parseAlarmPayload', 'inboxTriage'].includes(n.name.getText(ast))).map(n => n.getText(ast)).join('\n')
  const requests: any[] = []
  const globals = {
    DIGEST_MAX_MESSAGE_LINES: 40,
    runtimeGet: async (_url: string, path: string) => path === '/inbox' ? { rows } : payload,
    runtimeBest: async (_url: string, _path: string, _token: string, body: unknown) => { requests.push(body) },
    conversationHeader: () => 'conversation', attachmentNote: () => '', uniqueProjectIds: () => [],
    deferTriage: () => ({ outcome: 'defer', ackAllowed: false }), triageDisposition: (v: unknown) => v,
  }
  const js = ts.transpileModule(`${declarations}; return new class { cfg = {}; agent = { id: 'agent' }; teardown = new AbortController(); ${methods} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return { runner: new Function(...Object.keys(globals), js)(...Object.values(globals)), requests }
}

test('BYOA preserves the entire snapshot but acknowledges only displayed inputs', async () => {
  const { runner, requests } = fixture(Array.from({ length: 45 }, (_, i) => ({ id: `m-${i}`, conversation_id: 'c', kind: 'text', body: `body ${i}` })))
  const snapshot = await runner.snapshotUnread('token')
  assert.equal(snapshot.seen.get('c').length, 45)
  assert.deepEqual(snapshot.displayed.get('c'), snapshot.seen.get('c').slice(5))
  assert.match(snapshot.digest, /5 older unread/)
  await runner.ackSeen('token', snapshot.displayed)
  assert.deepEqual(requests[0].consumedMessageIds, snapshot.seen.get('c').slice(5))
  assert.equal(requests[0].upToMessageId, 'm-44')
  assert.equal((await runner.inboxTriage('token', snapshot.seen)).outcome, 'defer', 'triage covering only the final ID cannot acknowledge the batch')
  runner.turnCancelled = true
  await runner.ackSeen('token', snapshot.seen)
  assert.equal(requests.length, 1)
})

test('BYOA full batch receipt contains every message when the digest fits', async () => {
  const { runner, requests } = fixture(['m1', 'm2', 'm3'].map(id => ({ id, conversation_id: 'c', kind: 'text' })))
  const snapshot = await runner.snapshotUnread('token')
  await runner.ackSeen('token', snapshot.displayed)
  assert.deepEqual(requests[0].consumedMessageIds, ['m1', 'm2', 'm3'])
})


test('BYOA triage may consume a full classified batch but missing coverage fails closed', async () => {
  const ids = Array.from({ length: 45 }, (_, i) => `m-${i}`)
  const rows = ids.map(id => ({ id, conversation_id: 'c', kind: 'text' }))
  const { runner, requests } = fixture(rows, { messageIds: ids, verdict: { outcome: 'ignore', ackAllowed: true } })
  const snapshot = await runner.snapshotUnread('token')
  assert.equal((await runner.inboxTriage('token', snapshot.seen)).outcome, 'ignore')
  await runner.ackSeen('token', snapshot.seen)
  assert.deepEqual(requests[0].consumedMessageIds, ids)
  const missing = fixture(rows, { verdict: { outcome: 'ignore', ackAllowed: true } })
  assert.equal((await missing.runner.inboxTriage('token', snapshot.seen)).outcome, 'defer')
})

test('BYOA zero-budget conversations receive no completion receipts', async () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ id: `m-${i}`, conversation_id: `c-${i}`, kind: 'text' }))
  const { runner, requests } = fixture(rows)
  const snapshot = await runner.snapshotUnread('token')
  assert.equal(snapshot.seen.size, 45)
  assert.equal(snapshot.displayed.size, 40)
  await runner.ackSeen('token', snapshot.displayed)
  assert.equal(requests.length, 40)
  for (const request of requests) {
    assert.equal(request.consumedMessageIds.length, 1)
    assert.ok(snapshot.digest.includes(`[${request.consumedMessageIds[0]}]`))
  }
})
