/** Queue or retry an existing user's durable gateway provisioning intent. */
import 'dotenv/config'
import { pool } from '../db/pool.js'
import { sub2apiConfigured, type Tier } from '../sub2api.js'
import { initServerSettings } from '../settings.js'
import { requestSub2apiSync, reconcileSub2apiSync, getSub2apiSyncStatus } from '../sub2api-sync.js'

const email = (process.argv[2] ?? '').trim().toLowerCase()
const requestedTier = process.argv[3] as Tier | undefined
try {
  if (!email || (requestedTier && !['free', 'pro', 'max'].includes(requestedTier))) {
    throw new Error('usage: provision-sub2api-user.ts <email> [free|pro|max]')
  }
  if (!sub2apiConfigured()) throw new Error('sub2api provisioning is not configured')
  await initServerSettings()
  const { rows } = await pool.query<{ id: string; tier: Tier }>(
    'SELECT id, tier FROM users WHERE lower(email) = $1 AND deleted_at IS NULL', [email],
  )
  const user = rows[0]
  if (!user) throw new Error('user not found')
  const previous = await getSub2apiSyncStatus(user.id)
  if (requestedTier || !previous || previous.status === 'succeeded') {
    await requestSub2apiSync(user.id, requestedTier ?? user.tier)
  }
  await reconcileSub2apiSync(user.id)
  const state = await getSub2apiSyncStatus(user.id)
  console.log(JSON.stringify({ userId: user.id, sync: state }))
  if (state?.status !== 'succeeded') process.exitCode = 1
} catch (error) {
  console.error(error instanceof Error ? error.message : 'provisioning failed')
  process.exitCode = 1
} finally { await pool.end() }
