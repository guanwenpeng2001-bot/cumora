/**
 * The SES echo dedup has to work for more than one recipient.
 *
 * SES rewrites Message-ID on the wire, so mail we send to a cumora-domain
 * address boomerangs back through the gate carrying an id we never minted. The
 * id-based dedup misses it, and a second pass matches on (from, to, subject)
 * within ten minutes instead.
 *
 * That pass compared `LOWER(to_addrs::text) = LOWER($3)` — jsonb rendered as
 * text against `JSON.stringify`. Postgres puts a space after every comma and
 * JSON.stringify does not, so the two renderings coincide for exactly one
 * recipient:
 *
 *   1 recipient   jsonb::text ["a@x.com"]              stringify ["a@x.com"]
 *   2 recipients  jsonb::text ["a@x.com", "b@x.com"]   stringify ["a@x.com","b@x.com"]
 *
 * The existing boomerang test in inbound.test.ts sends to one address, which is
 * why it passed. Every boomerang of a mail sent to two or more — an agent and a
 * human, two agents, anyone Cc'd — fell through and created a fresh
 * conversation containing our own outbound message.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  buildTestApp, ensureSchemaOnce, resetAllTables, seedCompanyWithAgent,
  signInboundPayload, teardownAll,
} from './_helpers.js'
import { pool } from '../db/pool.js'

let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const app = await buildTestApp()
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll(server) })

async function postInbound(body: unknown): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(body)
  const res = await fetch(`${baseUrl}/webhooks/email/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cumora-signature': signInboundPayload(raw) },
    body: raw,
  })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text } }
}

/** Seed the outbound row compose would have written, then fire the boomerang
 *  SES sends back: same from/to/subject, an id we never minted.
 *
 *  `extra` are the additional recipients beside the agent. The agent's own
 *  address has to be in the set or the request is refused for having no known
 *  recipient long before the echo pass runs — which is also why a
 *  single-recipient boomerang was the only shape anyone tested. */
async function sendThenBoomerang(
  extra: string[],
  reorder?: (addrs: string[]) => string[],
): Promise<{ status: number; body: any }> {
  const { findOrCreateEmailConversation, persistEmailMessage, mintMessageId } = await import('../email.js')
  const { companyId, agentId, agentEmail } = await seedCompanyWithAgent()
  const toAddrs = [agentEmail, ...extra]
  const boomerangTo = reorder ? reorder(toAddrs) : toAddrs
  const fromAddrFull = `yetone <user-x@${process.env.EMAIL_DOMAIN}>`
  const subject = 'ship it'

  const conv = await findOrCreateEmailConversation({
    companyId, inReplyTo: null, references: [], subject, memberIds: [agentId],
  })
  await persistEmailMessage({
    conversationId: conv.conversationId, companyId, authorId: agentId,
    direction: 'out', transportStatus: 'sent', smtpMessageId: mintMessageId(),
    inReplyTo: null, references: [], subject, fromAddr: fromAddrFull,
    toAddrs, body: 'shipping',
  })

  return postInbound({
    messageId: `0106019e2ac91d15-${randomUUID().slice(0, 12)}-000000@ap-northeast-1.amazonses.com`,
    from: fromAddrFull,
    to: boomerangTo,
    subject,
    text: 'shipping',
  })
}

async function counts(): Promise<{ conversations: number; emails: number }> {
  const c = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM conversations WHERE kind = 'email'`)
  const e = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM email_messages`)
  return { conversations: c.rows[0].n, emails: e.rows[0].n }
}

test('[integration] a boomerang addressed to two recipients is still deduplicated', async () => {
  const r = await sendThenBoomerang(['human@external.com'])

  assert.equal(r.status, 200)
  assert.equal(r.body.echo, true, 'a two-recipient boomerang was treated as a new email')
  assert.deepEqual(await counts(), { conversations: 1, emails: 1 })
})

test('[integration] the recipients are compared as a set, not in header order', async () => {
  // Nothing guarantees the To: header comes back in the order we wrote it.
  const r = await sendThenBoomerang(
    ['human@external.com'],
    (addrs) => [addrs[1].toUpperCase(), addrs[0]],
  )

  assert.equal(r.body.echo, true, 'the same recipients in another order read as a different email')
  assert.deepEqual(await counts(), { conversations: 1, emails: 1 })
})

test('[integration] one recipient still dedups', async () => {
  // The case that already worked, kept honest.
  const r = await sendThenBoomerang([])
  assert.equal(r.body.echo, true)
  assert.deepEqual(await counts(), { conversations: 1, emails: 1 })
})

test('[integration] a different recipient set is not an echo', async () => {
  // The guard rail: set comparison must not become "close enough". A genuinely
  // different audience is a genuinely different email.
  const r = await sendThenBoomerang(
    ['human@external.com'],
    (addrs) => [addrs[0], 'someone-else@external.com'],
  )
  assert.notEqual(r.body.echo, true, 'a different recipient set was swallowed as an echo')
})
