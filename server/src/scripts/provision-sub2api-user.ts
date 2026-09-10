/**
 * Manual sub2api provisioning for an EXISTING cumora user.
 *
 * New signups are provisioned automatically (oauth.ts / admin.ts call
 * `provisionUser` post-commit). Users created BEFORE the sub2api gateway
 * was deployed have no mirrored account; this script backfills one:
 * creates the sub2api user, binds the tier's platform groups, mints one
 * API key per platform group, and persists {sub2api_user_id,
 * sub2api_api_key} (a JSON platform→key map) onto the cumora users row.
 *
 * DANGER / ordering: the moment `sub2api_api_key` is written, this user's
 * non-prefixed LLM traffic routes through sub2api (see server/src/llm.ts).
 * If a platform group has no accounts attached in sub2api, calls for that
 * platform's models fail. Add accounts in the sub2api admin UI FIRST.
 *
 * Convergent, not destructive: provisionUser reuses existing sub2api keys
 * already pointing at the right groups and merges them with the stored
 * map, so re-running is safe. Legacy rows (bare string key, pre
 * platform-split) are migrated in place to the JSON map.
 *
 *   docker compose exec server npx tsx server/src/scripts/provision-sub2api-user.ts <email> [free|pro|max]
 */
import { invalidateOwnerLlmCaches } from '../tenant-llm-context.js'
import 'dotenv/config'
import { pool } from '../db/pool.js'
import {
  provisionUser, sub2apiConfigured, parseApiKeyMap, serializeApiKeyMap,
  type Tier,
} from '../sub2api.js'

const email = (process.argv[2] ?? '').trim().toLowerCase()
const tier = (process.argv[3] ?? 'free') as Tier
if (!email || !['free', 'pro', 'max'].includes(tier)) {
  console.error('usage: provision-sub2api-user.ts <email> [free|pro|max]')
  process.exit(1)
}
if (!sub2apiConfigured()) {
  console.error('SUB2API_INTERNAL_URL / SUB2API_ADMIN_KEY not configured')
  process.exit(1)
}

const { rows } = await pool.query<{
  id: string; email: string; display_name: string | null; sub2api_api_key: string | null
}>(`SELECT id, email, display_name, sub2api_api_key FROM users WHERE lower(email) = $1`, [email])
const user = rows[0]
if (!user) {
  console.error(`no cumora user with email ${email}`)
  process.exit(1)
}

const stored = parseApiKeyMap(user.sub2api_api_key)
const r = await provisionUser({
  cumoraUserId: user.id,
  email: user.email,
  displayName: user.display_name ?? user.email,
  tier,
  existingKeys: stored,
})
const serialized = serializeApiKeyMap(r.apiKeys)
if (!serialized) {
  console.error('provisioning produced no keys — check SUB2API_TIER_*_GROUP_* mapping')
  process.exit(1)
}
await pool.query(
  `UPDATE users SET sub2api_user_id = $1, sub2api_api_key = $2 WHERE id = $3`,
  [r.sub2apiUserId, serialized, user.id],
)
await invalidateOwnerLlmCaches(user.id)
console.log(`provisioned ${email}: sub2api_user_id=${r.sub2apiUserId} platforms=${Object.keys(r.apiKeys).join(',')} tier=${tier}`)
await pool.end()
