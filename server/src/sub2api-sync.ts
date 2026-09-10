import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from './db/pool.js'
import {
  sub2apiConfigured, tierGroups, parseApiKeyMap, serializeApiKeyMap, reconcileSub2apiUser,
  type Tier, type Platform, type ManagedIntegrationKeys, type ProvisionResult,
} from './sub2api.js'

interface SyncIntent {
  user_id: string
  intent_id: string
  version: string
  target_tier: Tier
  target_groups: Record<Platform, number>
  status: 'pending' | 'processing' | 'failed' | 'succeeded'
  attempts: number
  remote_user_id: string | null
  managed_keys: ManagedIntegrationKeys
}
export interface Sub2apiSyncStatus {
  targetTier: Tier
  version: string
  status: SyncIntent['status']
  attempts: number
  nextAttemptAt: string | null
  lastError: string | null
}

/** Caller owns the transaction. Never contacts the gateway. */
export async function enqueueSub2apiSync(client: Pick<PoolClient, 'query'>, userId: string, tier: Tier): Promise<void> {
  if (!['free', 'pro', 'max'].includes(tier)) throw new Error('invalid_tier')
  const user = await client.query('SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [userId])
  if (!user.rowCount) throw new Error('user_not_found')
  await client.query(
    `INSERT INTO sub2api_sync_intents (user_id, intent_id, target_tier, target_groups, remote_user_id)
     SELECT id, $2, $3, $4::jsonb, sub2api_user_id FROM users WHERE id = $1
     ON CONFLICT (user_id) DO UPDATE SET
       intent_id = EXCLUDED.intent_id, version = sub2api_sync_intents.version + 1,
       target_tier = EXCLUDED.target_tier, target_groups = EXCLUDED.target_groups,
       status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL, updated_at = NOW()`,
    [userId, randomUUID(), tier, JSON.stringify(tierGroups(tier))],
  )
}

export async function requestSub2apiSync(userId: string, tier: Tier): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await enqueueSub2apiSync(client, userId, tier)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

export async function getSub2apiSyncStatus(userId: string): Promise<Sub2apiSyncStatus | null> {
  const { rows } = await pool.query<Sub2apiSyncStatus>(
    `SELECT target_tier AS "targetTier", version::text AS version, status, attempts,
       CASE WHEN status = 'succeeded' THEN NULL ELSE next_attempt_at END AS "nextAttemptAt",
       last_error AS "lastError" FROM sub2api_sync_intents WHERE user_id = $1`, [userId],
  )
  return rows[0] ?? null
}

/** Session lock serializes gateway work across processes; no transaction spans HTTP. */
export async function reconcileSub2apiSync(userId: string): Promise<ProvisionResult | null> {
  if (!sub2apiConfigured()) return null
  const client = await pool.connect()
  let locked = false
  let version: string | undefined
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('cumora.sub2api-sync'), hashtext($1)) AS locked", [userId],
    )
    locked = lock.rows[0].locked
    if (!locked) return null
    for (let pass = 0; pass < 10; pass++) {
      const { rows } = await client.query<SyncIntent & {
        email: string; display_name: string; sub2api_api_key: string | null
      }>(
        `SELECT i.*, u.email, u.display_name, u.sub2api_api_key
           FROM sub2api_sync_intents i JOIN users u ON u.id = i.user_id
          WHERE i.user_id = $1 AND u.deleted_at IS NULL`, [userId],
      )
      const intent = rows[0]
      if (!intent || intent.status === 'succeeded') return null
      version = intent.version
      await client.query(
        `UPDATE sub2api_sync_intents SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
          WHERE user_id = $1 AND version = $2`, [userId, version],
      )
      const result = await reconcileSub2apiUser({
        cumoraUserId: userId, email: intent.email, displayName: intent.display_name,
        intentId: intent.intent_id, groups: intent.target_groups,
        remoteUserId: intent.remote_user_id ? Number(intent.remote_user_id) : null,
        existingKeys: parseApiKeyMap(intent.sub2api_api_key), managedKeys: intent.managed_keys,
        checkpoint: async (remoteId, keys) => {
          // Progress survives a newer target; only this session's consumer writes it.
          await client.query(
            `UPDATE sub2api_sync_intents SET remote_user_id = $2, managed_keys = $3::jsonb, updated_at = NOW()
              WHERE user_id = $1`, [userId, remoteId, JSON.stringify(keys)],
          )
        },
      })
      await client.query('BEGIN')
      const owner = await client.query('SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [userId])
      const current = await client.query<{ version: string }>(
        'SELECT version FROM sub2api_sync_intents WHERE user_id = $1 FOR UPDATE', [userId],
      )
      if (!owner.rowCount || current.rows[0]?.version !== version) {
        await client.query('ROLLBACK')
        continue
      }
      await client.query(
        'UPDATE users SET sub2api_user_id = $2, sub2api_api_key = $3, tier = $4 WHERE id = $1',
        [userId, result.sub2apiUserId, serializeApiKeyMap(result.apiKeys), intent.target_tier],
      )
      await client.query(
        `UPDATE sub2api_sync_intents SET status = 'succeeded', last_error = NULL, confirmed_at = NOW(), updated_at = NOW()
          WHERE user_id = $1 AND version = $2`, [userId, version],
      )
      await client.query('COMMIT')
      // The committed users.xmin is also the cross-process authorization version.
      const { invalidateOwnerLlmCaches } = await import('./tenant-llm-context.js')
      await invalidateOwnerLlmCaches(userId).catch(() => console.warn('[sub2api-sync] cache invalidation failed', userId))
      const trial = await client.query(
        'SELECT id FROM users WHERE id = $1 AND tier = $2 AND pro_trial_expires_at > NOW()', [userId, 'pro'],
      )
      if (trial.rowCount) {
        // Preserve the signup starter-team side effect after delayed confirmation.
        try {
          const { rows: companies } = await client.query<{ id: string }>('SELECT id FROM companies WHERE owner_user_id = $1', [userId])
          const { ensureCloudComputer, cloudComputerId } = await import('./agents/computer/registry.js')
          const { onboardStarterAgents } = await import('./onboardCompany.js')
          for (const company of companies) {
            await ensureCloudComputer(company.id)
            await onboardStarterAgents(company.id, { computerId: cloudComputerId(company.id), engine: 'managed' })
          }
        } catch { console.warn('[sub2api-sync] trial starter onboarding failed', userId) }
      }
      return result
    }
    return null
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (locked && version) {
      await client.query(
        `UPDATE sub2api_sync_intents SET status = 'failed', last_error = $3,
           next_attempt_at = NOW() + LEAST(300, POWER(2, LEAST(attempts, 8))) * INTERVAL '1 second',
           updated_at = NOW() WHERE user_id = $1 AND version = $2 AND status <> 'succeeded'`,
        [userId, version, error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'reconciliation_failed'],
      ).catch(() => {})
    }
    console.warn('[sub2api-sync] reconciliation pending', userId)
    return null
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext('cumora.sub2api-sync'), hashtext($1))", [userId])
      } catch { client.release(true); locked = false }
      if (locked) client.release()
    } else { client.release() }
  }
}

export async function runSub2apiSyncTick(): Promise<void> {
  if (!sub2apiConfigured()) return
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT i.user_id FROM sub2api_sync_intents i JOIN users u ON u.id = i.user_id
      WHERE i.status <> 'succeeded' AND i.next_attempt_at <= NOW() AND u.deleted_at IS NULL
      ORDER BY i.next_attempt_at LIMIT 100`,
  )
  for (const row of rows) await reconcileSub2apiSync(row.user_id)
}

let timer: ReturnType<typeof setInterval> | undefined
let running = false
export function startSub2apiSyncWorker(): void {
  if (timer) return
  const tick = async () => {
    if (running) return
    running = true
    try { await runSub2apiSyncTick() }
    catch { console.warn('[sub2api-sync] poll failed') }
    finally { running = false }
  }
  timer = setInterval(() => { void tick() }, 5_000)
  timer.unref()
  void tick()
}
