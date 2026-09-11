import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { dispatchEvent, tickCalendar, type CalendarEventRow } from '../calendar.js'
import { applyAgentEdit, applyLocalUpdate, bootDocumentBus, evictDocumentRoom, readDocumentText, subscribe } from '../documents/rooms.js'
import { readDocumentState } from '../documents/persistence.js'
import { drainRealtimeOutbox } from '../realtime-outbox.js'
import { sub, CH_DOC_UPDATE } from '../redis.js'
import { runCli } from '../agents/cli.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'

before(ensureSchemaOnce)
beforeEach(resetAllTables)
afterEach(async () => {
  evictDocumentRoom('fix-z4-doc')
  for (const table of ['document_updates', 'realtime_outbox', 'messages', 'calendar_dispatches']) {
    await pool.query(`DROP TRIGGER IF EXISTS fix_z4_fail ON ${table}`)
  }
  await pool.query('DROP FUNCTION IF EXISTS fix_z4_fail()')
})
after(async () => { await teardownAll() })

async function failWrites(table: 'document_updates' | 'realtime_outbox' | 'messages' | 'calendar_dispatches', update = false) {
  await pool.query(`CREATE OR REPLACE FUNCTION fix_z4_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fix-z4 injected persistence failure'; END $$`)
  await pool.query(`CREATE TRIGGER fix_z4_fail BEFORE ${update ? 'UPDATE' : 'INSERT'} ON ${table}
    FOR EACH ROW EXECUTE FUNCTION fix_z4_fail()`)
}
async function seedDoc() {
  const fixture = await seedCompanyWithAgent()
  await pool.query('INSERT INTO documents (id, company_id, title, created_by) VALUES ($1,$2,$3,$4)',
    ['fix-z4-doc', fixture.companyId, 'Audit', fixture.agentId])
  return { ...fixture, documentId: 'fix-z4-doc' }
}
async function coldDoc() {
  const doc = new Y.Doc()
  for (const row of await readDocumentState(pool, 'fix-z4-doc')) Y.applyUpdate(doc, row.bytes)
  return doc
}

test('document persistence failure rejects, broadcasts nothing, and retry survives cold load', async () => {
  const { documentId, companyId, agentId } = await seedDoc()
  const updates: Uint8Array[] = []
  await subscribe(documentId, companyId, { originId: 'observer', onUpdate: u => updates.push(u), onAwareness() {} })
  await failWrites('document_updates')
  await assert.rejects(applyAgentEdit(documentId, companyId, agentId, [{ kind: 'append', text: 'retry me' }]), /injected/)
  assert.equal(updates.length, 0)
  assert.equal((await pool.query('SELECT * FROM realtime_outbox')).rowCount, 0)
  await pool.query('DROP TRIGGER fix_z4_fail ON document_updates')
  await applyAgentEdit(documentId, companyId, agentId, [{ kind: 'append', text: 'retry me' }])
  assert.equal(updates.length, 1)
  evictDocumentRoom(documentId)
  assert.equal(await readDocumentText(documentId, companyId), 'retry me')
})

test('document outbox failure rolls back the edit and CLI create body cannot report success', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  await failWrites('realtime_outbox')
  const result = await runCli(['--as', agentId, 'doc', 'create', 'Atomic body', '--body', 'must survive'])
  assert.equal(result.ok, false)
  assert.match(result.text, /injected/)
  assert.equal((await pool.query('SELECT * FROM documents WHERE company_id=$1', [companyId])).rowCount, 0)
  assert.equal((await pool.query('SELECT * FROM document_updates')).rowCount, 0)
  assert.equal((await pool.query('SELECT * FROM realtime_outbox')).rowCount, 0)
  await pool.query('DROP TRIGGER fix_z4_fail ON realtime_outbox')
  const retry = await runCli(['--as', agentId, 'doc', 'create', 'Atomic body', '--body', 'must survive'])
  assert.equal(retry.ok, true, retry.text)
  const docId = String(retry.sideEffects?.[0]?.documentId)
  assert.equal(await readDocumentText(docId, companyId), 'must survive')
  evictDocumentRoom(docId)
})

test('caller transaction rollback leaves a subscribed document unchanged', async () => {
  const { documentId, companyId, agentId } = await seedDoc()
  const updates: Uint8Array[] = []
  await subscribe(documentId, companyId, { originId: 'observer', onUpdate: u => updates.push(u), onAwareness() {} })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await applyAgentEdit(documentId, companyId, agentId, [{ kind: 'append', text: 'uncommitted' }], client)
    assert.equal(updates.length, 0)
    await client.query('ROLLBACK')
  } finally { client.release() }
  assert.equal(await readDocumentText(documentId, companyId), '')
  assert.equal((await pool.query('SELECT * FROM realtime_outbox')).rowCount, 0)
  await applyAgentEdit(documentId, companyId, agentId, [{ kind: 'append', text: 'committed' }])
  assert.equal(await readDocumentText(documentId, companyId), 'committed')
})

test('concurrent agent edits serialize against durable state and retain both appends', async () => {
  const { documentId, companyId, agentId } = await seedDoc()
  await Promise.all(['first', 'second'].map(text => applyAgentEdit(documentId, companyId, agentId, [{ kind: 'append', text }])))
  const text = await readDocumentText(documentId, companyId)
  assert.ok(text.includes('first') && text.includes('second'), text)
  assert.equal((await pool.query('SELECT * FROM document_updates')).rowCount, 2)
})

test('out-of-order local Yjs updates are durable even before their dependency arrives', async () => {
  const { documentId, companyId, agentId } = await seedDoc()
  const source = new Y.Doc()
  const updates: Uint8Array[] = []
  source.on('update', (u: Uint8Array) => updates.push(u))
  source.getText('text').insert(0, 'A')
  source.getText('text').insert(1, 'B')
  await applyLocalUpdate(documentId, companyId, 'human', agentId, updates[1])
  evictDocumentRoom(documentId)
  await applyLocalUpdate(documentId, companyId, 'human', agentId, updates[0])
  const cold = await coldDoc()
  assert.equal(cold.getText('text').toString(), 'AB')
  source.destroy()
  cold.destroy()
})

async function seedEvent() {
  const { companyId, agentId } = await seedCompanyWithAgent()
  await pool.query(`INSERT INTO conversations (id, company_id, kind, title, members)
    VALUES ('fix-z4-chat', $1, 'group', 'Audit', $2::jsonb)`, [companyId, JSON.stringify([agentId])])
  await pool.query(`INSERT INTO conversation_members (conversation_id, company_id, participant_id, ordinal)
    VALUES ('fix-z4-chat', $1, $2, 0) ON CONFLICT DO NOTHING`, [companyId, agentId])
  const slot = new Date('2026-09-11T10:00:00Z')
  const { rows } = await pool.query<CalendarEventRow>(`INSERT INTO calendar_events
    (id, company_id, created_by, kind, title, assignee_id, target_conversation_id, start_at, status)
    VALUES ('fix-z4-event', $1, $2, 'agent_task', 'Audit', $2, 'fix-z4-chat', $3, 'active') RETURNING *`, [companyId, agentId, slot])
  return { event: rows[0], slot }
}

test('failed calendar tick does not consume its occurrence and the next tick retries', async () => {
  const { slot } = await seedEvent()
  await failWrites('messages')
  assert.equal((await tickCalendar(slot)).fired, 0)
  const { rows } = await pool.query('SELECT status, last_fired_at FROM calendar_events')
  assert.equal(rows[0].status, 'active')
  assert.equal(rows[0].last_fired_at, null)
  assert.equal((await pool.query('SELECT * FROM calendar_dispatches')).rowCount, 0)
  await pool.query('DROP TRIGGER fix_z4_fail ON messages')
  assert.equal((await tickCalendar(slot)).fired, 1)
  assert.equal((await pool.query('SELECT * FROM messages')).rowCount, 1)
  assert.equal((await tickCalendar(slot)).fired, 0)
})

test('failure marking calendar completion rolls back message and outbox; retry posts once', async () => {
  const { event, slot } = await seedEvent()
  await failWrites('calendar_dispatches', true)
  assert.equal((await dispatchEvent(event, slot)).status, 'failed')
  assert.equal((await pool.query('SELECT * FROM messages')).rowCount, 0)
  assert.equal((await pool.query('SELECT * FROM realtime_outbox')).rowCount, 0)
  await pool.query('DROP TRIGGER fix_z4_fail ON calendar_dispatches')
  assert.equal((await dispatchEvent(event, slot)).status, 'dispatched')
  // Simulate process exit after dispatch commit but before tick advanced the cursor.
  await tickCalendar(slot)
  assert.equal((await pool.query('SELECT * FROM messages')).rowCount, 1)
  assert.equal((await pool.query('SELECT status FROM calendar_events')).rows[0].status, 'done')
})

for (const status of ['pending', 'failed']) test(`calendar recovers legacy ${status} occurrence with a single concurrent winner`, async () => {
  const { event, slot } = await seedEvent()
  await pool.query(`INSERT INTO calendar_dispatches (id,event_id,company_id,scheduled_for,status)
    VALUES ('old-dispatch',$1,$2,$3,$4)`, [event.id, event.company_id, slot, status])
  const results = await Promise.all([dispatchEvent(event, slot), dispatchEvent(event, slot)])
  assert.deepEqual(results.map(r => r.status).sort(), ['dispatched', 'duplicate'])
  assert.equal((await pool.query('SELECT * FROM messages')).rowCount, 1)
  assert.equal((await pool.query('SELECT * FROM realtime_outbox')).rowCount, 1)
})

test('two agents racing an expired board claim have exactly one winner', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const peer = await seedCompanyWithAgent({ companyId })
  const created = await runCli(['--as', agentId, 'kanban', 'create', 'Claim audit'])
  assert.equal(created.ok, true, created.text)
  const boardId = String(created.sideEffects?.[0]?.boardId)
  const columnId = (await pool.query('SELECT id FROM board_columns WHERE board_id=$1 ORDER BY position LIMIT 1', [boardId])).rows[0].id
  await pool.query(`INSERT INTO board_cards (id, board_id, column_id, title, assignee_id, created_by, updated_at)
    VALUES ('fix-z4-card',$1,$2,'Claim audit','old-agent',$3,NOW()-INTERVAL '30 minutes')`, [boardId, columnId, agentId])
  const results = await Promise.all([agentId, peer.agentId].map(id => runCli(['--as', id, 'card', 'claim', 'fix-z4-card'])))
  assert.equal(results.filter(r => r.ok).length, 1, JSON.stringify(results))
  assert.match(results.find(r => !r.ok)!.text, /already being worked/)
  const holder = (await pool.query("SELECT assignee_id FROM board_cards WHERE id='fix-z4-card'")).rows[0].assignee_id
  assert.ok([agentId, peer.agentId].includes(holder))
})



test('committed caller edits reach the live room through the durable outbox', async () => {
  const { documentId, companyId, agentId } = await seedDoc()
  bootDocumentBus()
  await sub.subscribe(CH_DOC_UPDATE)
  let received!: () => void
  const delivered = new Promise<void>(resolve => { received = resolve })
  const replica = new Y.Doc()
  const initial = await subscribe(documentId, companyId, {
    originId: 'observer', onUpdate(update) { Y.applyUpdate(replica, update); received() }, onAwareness() {},
  })
  Y.applyUpdate(replica, initial.initialState)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await applyAgentEdit(documentId, companyId, agentId, [{ kind: 'append', text: 'committed delivery' }], client)
    assert.equal(replica.getXmlFragment('default').length, 0)
    await client.query('COMMIT')
  } finally { client.release() }
  const timer = setTimeout(received, 3000)
  try {
    const result = await drainRealtimeOutbox()
    assert.equal(result.failed, 0)
    await delivered
    assert.match(replica.getXmlFragment('default').toString(), /committed delivery/)
  } finally { clearTimeout(timer); replica.destroy() }
})

test('documents without subscribers still compact durable updates', async () => {
  const { documentId, companyId, agentId } = await seedDoc()
  const source = new Y.Doc()
  source.getText('text').insert(0, 'A')
  await pool.query(`INSERT INTO document_updates (document_id, author_id, update_bytes)
    SELECT $1,$2,$3 FROM generate_series(1,200)`, [documentId, agentId, Buffer.from(Y.encodeStateAsUpdate(source))])
  source.getText('text').insert(1, 'B')
  await applyLocalUpdate(documentId, companyId, 'human', agentId, Y.encodeStateAsUpdate(source))
  const deadline = Date.now() + 3000
  while ((await pool.query('SELECT 1 FROM document_snapshots WHERE document_id=$1', [documentId])).rowCount === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal((await pool.query('SELECT * FROM document_updates')).rowCount, 0)
  const cold = await coldDoc()
  assert.equal(cold.getText('text').toString(), 'AB')
  source.destroy()
  cold.destroy()
})
