import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WebSocket } from 'ws'
import { WsDispatch } from '../ws-dispatch.js'
import { resyncWsClients, trackWsRecoveryScope, type RecoveryEvent } from '../ws-recovery.js'

function client(userId: string, companies: string[]) {
  const frames: string[] = [], codes: number[] = []
  return { userId, companies: new Set(companies), frames, codes, ws: {
    OPEN: 1, readyState: 1, send: (frame: string) => frames.push(frame),
    close: (code: number) => codes.push(code), terminate: () => assert.fail('unexpected termination'),
  } as unknown as WebSocket }
}

for (const global of [false, true]) test(`A1: failed authorization batch ${global ? 'with unknown scope recovers all sockets' : 'recovers only the affected tenant'}`, async () => {
  const a = client('a', ['tenant-a']), b = client('b', ['tenant-b']), both = client('both', ['tenant-a', 'tenant-b'])
  const clients = [a, b, both]
  const event = global ? {} : { companyId: 'tenant-a' }
  const recovered = new Promise<void>(resolve => {
    const dispatch = new WsDispatch<{ event: RecoveryEvent }>(async () => { throw new Error('authorization database unavailable') }, batch => {
      resyncWsClients(clients, batch)
      resolve()
    })
    dispatch.enqueue('a', { event }, 1)
  })
  await recovered
  assert.deepEqual(a.codes, [1013])
  assert.deepEqual(b.codes, global ? [1013] : [])
  assert.deepEqual(both.codes, [1013])
  for (const c of clients) for (const frame of c.frames) {
    assert.equal(JSON.parse(frame).type, 'sync.required')
    assert.ok(!frame.includes('tenant-a'), 'failed authorization never exposes event content')
  }
})

test('A1: recovery tracks a join before dispatch, and covers removed targeted users', () => {
  const joined = client('joined', []), removed = client('removed', []), other = client('other', ['other'])
  const clients = [joined, removed, other]
  trackWsRecoveryScope(clients, { companyId: 'new', type: 'participants.added', participant: { id: 'joined', kind: 'human' } })
  resyncWsClients(clients, [{ event: { companyId: 'new', type: 'workspace.membership', recipientUserIds: ['removed'] } }])
  assert.deepEqual(joined.codes, [1013])
  assert.deepEqual(removed.codes, [1013])
  assert.deepEqual(other.codes, [])
})

test('A1: overflow also keeps recovery local', () => {
  const a = client('a', ['a']), b = client('b', ['b'])
  const queue = new WsDispatch<{ event: RecoveryEvent }>(async () => assert.fail('overflow was delivered'),
    batch => resyncWsClients([a, b], batch), { batch: 1, concurrency: 1, events: 0, bytes: 1, ageMs: 10 })
  queue.enqueue('a', { event: { companyId: 'a' } }, 2)
  assert.deepEqual(a.codes, [1013])
  assert.deepEqual(b.codes, [])
})
