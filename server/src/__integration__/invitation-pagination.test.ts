import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { pool } from '../db/pool.js'
import { findOrCreateUserByProfile, WaitlistedError } from '../oauth.js'
import { setSetting } from '../admin.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, seedUserMembership, teardownAll } from './_helpers.js'

const ME = 'u-pagination'
let server: Server
let base = ''
before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(ME)
  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  base = `http://127.0.0.1:${address.port}/api`
})
beforeEach(async () => {
  await resetAllTables()
  await pool.query(`DELETE FROM app_settings`)
})
after(async () => { await teardownAll(server) })

async function seed() {
  const result = await seedCompanyWithAgent()
  await seedUserMembership(ME, result.companyId)
  return result.companyId
}
function headers(companyId: string) { return { 'x-company-id': companyId, 'content-type': 'application/json' } }
async function invite(companyId: string, token: string, email: string | null = null) {
  await pool.query(`INSERT INTO company_invitations (token_hash, company_id, invited_by, email, role, max_uses, expires_at)
    VALUES ($1, $2, $3, $4, 'member', 1, NOW() + INTERVAL '1 day')`,
  [createHash('sha256').update(token).digest('base64url'), companyId, ME, email])
}

test('accepted invitation retries succeed even after consumption, expiration and revocation', async () => {
  const companyId = await seed()
  await invite(companyId, 'single-use-token')
  await pool.query(`DELETE FROM company_members WHERE company_id = $1 AND user_id = $2`, [companyId, ME])
  const accept = () => fetch(`${base}/invitations/single-use-token/accept`, { method: 'POST', headers: headers(companyId), body: '{}' })
  const first = await accept()
  assert.equal(first.status, 200, await first.text())
  await pool.query(`UPDATE company_invitations SET revoked_at = NOW(), expires_at = NOW() - INTERVAL '1 day' WHERE company_id = $1`, [companyId])
  for (const response of await Promise.all([accept(), accept()])) {
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { alreadyMember: boolean }).alreadyMember, true)
  }
  const usage = await pool.query(`SELECT use_count FROM company_invitations WHERE company_id = $1`, [companyId])
  assert.equal(usage.rows[0].use_count, 1)
  const preview = await fetch(`${base}/invitations/single-use-token`)
  assert.equal((await preview.json() as { status: string }).status, 'already_member')
})

for (const state of ['revoked', 'expired', 'consumed', 'wrong_email', 'not_found']) {
  test(`invitation ${state} exposes a terminal machine-readable code`, async () => {
    const companyId = await seed()
    await invite(companyId, 'terminal-invite-token', state === 'wrong_email' ? 'someone@example.com' : null)
    await pool.query(`DELETE FROM company_members WHERE company_id = $1 AND user_id = $2`, [companyId, ME])
    if (state === 'revoked') await pool.query(`UPDATE company_invitations SET revoked_at = NOW()`)
    if (state === 'expired') await pool.query(`UPDATE company_invitations SET expires_at = NOW() - INTERVAL '1 day'`)
    if (state === 'consumed') await pool.query(`UPDATE company_invitations SET use_count = 1`)
    if (state === 'not_found') await pool.query(`DELETE FROM company_invitations`)
    const response = await fetch(`${base}/invitations/terminal-invite-token/accept`, { method: 'POST', headers: headers(companyId), body: '{}' })
    assert.equal(response.status, state === 'wrong_email' ? 403 : state === 'not_found' ? 404 : 410)
    const result = await response.json() as { code: string; retryable: boolean }
    assert.equal(result.code, `INVITATION_${state.toUpperCase()}`)
    assert.equal(result.retryable, false)
  })
}

for (const kind of ['documents', 'conversations', 'invitations', 'events']) {
  test(`${kind} pages cover beyond the old cap without truncation or tied-order duplicates`, async () => {
    const companyId = await seed()
    const cap = kind === 'conversations' ? 500 : kind === 'events' ? 1000 : 200
    if (kind === 'documents') await pool.query(`INSERT INTO documents (id, company_id, title, created_by)
      SELECT 'doc-' || n, $1, 'Doc ' || n, $2 FROM generate_series(1, $3::int) n`, [companyId, ME, cap + 1])
    if (kind === 'conversations') await pool.query(`INSERT INTO conversations (id, company_id, kind, title, members)
      SELECT 'conv-' || n, $1, 'group', 'Conversation ' || n, $2::jsonb FROM generate_series(1, $3::int) n`, [companyId, JSON.stringify([ME]), cap + 1])
    if (kind === 'invitations') await pool.query(`INSERT INTO company_invitations (token_hash, company_id, invited_by, role, max_uses, expires_at)
      SELECT 'hash-' || n, $1, $2, 'member', 1, NOW() + INTERVAL '1 day' FROM generate_series(1, $3::int) n`, [companyId, ME, cap + 1])
    if (kind === 'events') await pool.query(`INSERT INTO calendar_events (id, company_id, created_by, title, start_at)
      SELECT 'event-' || n, $1, $2, 'Event ' || n, NOW() FROM generate_series(1, $3::int) n`, [companyId, ME, cap + 1])
    const path = kind === 'invitations' ? `/companies/${companyId}/invitations` : kind === 'events' ? '/calendar/events' : `/${kind}`
    const response = await fetch(`${base}${path}?paginated=1`, { headers: headers(companyId) })
    assert.equal(response.status, 200, response.statusText)
    const first = await response.json() as Record<string, unknown> & { hasMore: boolean; nextCursor: string }
    const firstRows = first[kind] as Array<{ id: string }>
    assert.equal(firstRows.length, cap)
    assert.equal(first.hasMore, true)
    assert.equal(response.headers.get('x-has-more'), 'true')
    const secondResponse = await fetch(`${base}${path}?paginated=1&cursor=${first.nextCursor}`, { headers: headers(companyId) })
    const second = await secondResponse.json() as Record<string, unknown> & { hasMore: boolean; nextCursor: null }
    const secondRows = second[kind] as Array<{ id: string }>
    assert.equal(secondRows.length, 1)
    assert.equal(second.hasMore, false)
    assert.equal(second.nextCursor, null)
    assert.equal(new Set([...firstRows, ...secondRows].map((r) => r.id)).size, cap + 1)
    if (kind === 'documents') {
      const selected = await fetch(`${base}/documents/${secondRows[0].id}`, { headers: headers(companyId) })
      assert.equal(selected.status, 200, 'selected documents outside the first page remain retrievable')
    }
    const invalid = await fetch(`${base}${path}?cursor=invalid`, { headers: headers(companyId) })
    assert.equal(invalid.status, 400)
  })
}

test('calendar defaults exclude old one-off events and retain active recurrences', async () => {
  const companyId = await seed()
  await pool.query(`INSERT INTO calendar_events (id, company_id, created_by, title, start_at, recurrence)
    VALUES ('old', $1, $2, 'Old', NOW() - INTERVAL '2 years', NULL),
           ('recurring', $1, $2, 'Recurring', NOW() - INTERVAL '2 years', '{"freq":"daily"}'),
           ('future', $1, $2, 'Future', NOW() + INTERVAL '2 years', NULL)`, [companyId, ME])
  const response = await fetch(`${base}/calendar/events`, { headers: headers(companyId) })
  const result = await response.json() as { events: Array<{ id: string }>; from: string; to: string }
  assert.deepEqual(result.events.map((r) => r.id), ['recurring'])
  assert.ok(Date.parse(result.from) < Date.now() && Date.parse(result.to) > Date.now())
  const invalid = await fetch(`${base}/calendar/events?from=nope`, { headers: headers(companyId) })
  assert.equal(invalid.status, 400)
})

test('valid email-matching invitations outrank the waitlist; invalid tokens do not', async () => {
  const companyId = await seed()
  await setSetting('waitlist_enabled', true, ME)
  await invite(companyId, 'admission-token', 'join@example.com')
  const profile = { providerId: 'join-valid', email: 'join@example.com', displayName: 'Join', avatarUrl: null }
  const result = await findOrCreateUserByProfile('google', profile, 'admission-token')
  assert.ok(result.userId)
  assert.equal(result.companyId, null, 'invite signup must not create an unwanted personal workspace')
  for (const token of ['admission-token', 'unknown-token', null]) {
    await assert.rejects(() => findOrCreateUserByProfile('google', { ...profile, providerId: `denied-${token}`, email: `denied-${token}@example.com` }, token), WaitlistedError)
  }
  for (const condition of ["revoked_at = NOW()", "revoked_at = NULL, expires_at = NOW() - INTERVAL '1 day'", "expires_at = NOW() + INTERVAL '1 day', use_count = max_uses"]) {
    await pool.query(`UPDATE company_invitations SET email = NULL, ${condition}`)
    await assert.rejects(() => findOrCreateUserByProfile('google', { ...profile, providerId: `denied-${condition}`, email: 'invalid@example.com' }, 'admission-token'), WaitlistedError)
  }
  await setSetting('waitlist_enabled', false, ME)
})

test('invitation membership-limit errors also stop automatic retry', async () => {
  const target = await seed()
  await invite(target, 'limit-invitation-token')
  await pool.query(`DELETE FROM company_members WHERE company_id = $1 AND user_id = $2`, [target, ME])
  for (let i = 0; i < 3; i++) await seed()
  const response = await fetch(`${base}/invitations/limit-invitation-token/accept`, { method: 'POST', headers: headers(target), body: '{}' })
  assert.equal(response.status, 403)
  const result = await response.json() as { code: string; retryable: boolean }
  assert.equal(result.code, 'INVITATION_LIMIT_REACHED')
  assert.equal(result.retryable, false)
})
