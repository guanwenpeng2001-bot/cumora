import assert from 'node:assert/strict'
import { test, before, beforeEach, after } from 'node:test'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'
import { startPrivateChat } from '../agents/private_chat.js'
import { inprocClient } from '../agents/runtime/inproc-client.js'

before(ensureSchemaOnce)
beforeEach(resetAllTables)
after(async () => { await teardownAll() })

test('[integration] DM send preserves unseen arrivals; batch receipts consume exactly completed input', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const { agentId: peer } = await seedCompanyWithAgent({ companyId })
  const first = await startPrivateChat({ instigatorId: peer, partnerId: agentId, topic: '', opening: 'first input' })
  const second = await startPrivateChat({ instigatorId: peer, partnerId: agentId, topic: '', opening: 'second input' })
  const initial = await inprocClient.loadInbox(agentId)
  assert.deepEqual(new Set(initial.map(row => row.id)), new Set([first.messageId, second.messageId]))
  const arrival = await startPrivateChat({ instigatorId: peer, partnerId: agentId, topic: '', opening: 'arrived during turn' })
  const reply = await startPrivateChat({ instigatorId: agentId, partnerId: peer, topic: '', opening: 'reply to first batch' })
  assert.equal(reply.conversationId, first.conversationId)
  assert.equal((await inprocClient.loadInbox(agentId)).length, 3, 'sending cannot acknowledge any input')
  await inprocClient.markConversationRead({ agentId, conversationId: first.conversationId,
    upToMessageId: second.messageId, consumedMessageIds: initial.map(row => row.id) })
  assert.deepEqual((await inprocClient.loadInbox(agentId)).map(row => row.id), [arrival.messageId])
  // Replayed receipts are idempotent, and cannot consume the later arrival.
  await inprocClient.markConversationRead({ agentId, conversationId: first.conversationId,
    upToMessageId: second.messageId, consumedMessageIds: initial.map(row => row.id) })
  assert.deepEqual((await inprocClient.loadInbox(agentId)).map(row => row.id), [arrival.messageId])
  const { rows } = await pool.query('SELECT * FROM conversation_reads WHERE user_id = $1', [agentId])
  assert.equal(rows.length, 0)
})

