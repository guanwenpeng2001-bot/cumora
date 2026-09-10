import { pool } from './db/pool.js'
import { parseApiKeyMap, listKeyModelsWithStatus, SUB2API_PLATFORMS, sub2apiOpenAIBaseURL, sub2apiRoutingConfigured, type ApiKeyMap, type Platform, type KeyModelsResult } from './sub2api.js'

export class TenantLlmAccessError extends Error {
  readonly status = 403
}

export interface TenantLlmContext {
  companyId: string
  ownerId: string
  authorizationVersion: string
  generation: number
  keys: ApiKeyMap
  baseURL: string
}

export interface PlatformSnapshot extends KeyModelsResult {
  stale: boolean
}
export interface TenantModelSnapshot {
  authorizationVersion: string
  platforms: Record<Platform, PlatformSnapshot>
  at: number
}

const generations = new Map<string, number>()
const snapshots = new Map<string, TenantModelSnapshot>()
const refreshes = new Map<string, { version: string; promise: Promise<TenantModelSnapshot> }>()
const invalidators = new Set<(companyId: string) => void>()
const SNAPSHOT_TTL_MS = 30_000

export function onTenantLlmInvalidated(callback: (companyId: string) => void): void {
  invalidators.add(callback)
}

export function invalidateTenantModelSnapshot(companyId?: string): void {
  if (!companyId) {
    for (const id of new Set([...generations.keys(), ...snapshots.keys(), ...refreshes.keys()])) invalidateTenantModelSnapshot(id)
    return
  }
  generations.set(companyId, (generations.get(companyId) ?? 0) + 1)
  snapshots.delete(companyId)
  refreshes.delete(companyId)
}

/** Read the committed owner row on every resolution, including in agent Pods.
 * xmin changes even for same-key tier updates; no credentials enter public DTOs. */
export async function resolveTenantLlmContext(companyId: string, userId?: string): Promise<TenantLlmContext> {
  const generation = generations.get(companyId) ?? 0
  generations.set(companyId, generation)
  const { rows } = await pool.query<{ owner_user_id: string; sub2api_api_key: string | null; authorization_version: string }>(
    `SELECT c.owner_user_id, u.sub2api_api_key, u.xmin::text AS authorization_version
       FROM companies c JOIN users u ON u.id = c.owner_user_id
      WHERE c.id = $1
        AND ($2::text IS NULL OR EXISTS (
          SELECT 1 FROM company_members cm WHERE cm.company_id = c.id AND cm.user_id = $2
        ))`, [companyId, userId ?? null],
  )
  if (generation !== (generations.get(companyId) ?? 0)) return resolveTenantLlmContext(companyId, userId)
  const row = rows[0]
  if (!row) throw new TenantLlmAccessError('Company not found or access denied')
  return {
    companyId, ownerId: row.owner_user_id, generation,
    authorizationVersion: `${row.owner_user_id}:${row.authorization_version}:${generation}:${sub2apiOpenAIBaseURL()}`,
    keys: parseApiKeyMap(row.sub2api_api_key), baseURL: sub2apiOpenAIBaseURL(),
  }
}

/** Call after the local key commit. The owner can own more than one company. */
export async function invalidateOwnerLlmCaches(ownerId: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM companies WHERE owner_user_id = $1', [ownerId])
  for (const { id } of rows) {
    invalidateTenantModelSnapshot(id)
    for (const invalidate of invalidators) invalidate(id)
  }
}

export async function tenantModelSnapshot(context: TenantLlmContext, refresh = false): Promise<TenantModelSnapshot> {
  const { companyId, authorizationVersion } = context
  if (context.generation !== (generations.get(companyId) ?? 0)) {
    return tenantModelSnapshot(await resolveTenantLlmContext(companyId), refresh)
  }
  const existing = snapshots.get(companyId)
  const previous = existing?.authorizationVersion === authorizationVersion ? existing : undefined
  if (!refresh && previous && Date.now() - previous.at < SNAPSHOT_TTL_MS) return previous
  const running = refreshes.get(companyId)
  if (running?.version === authorizationVersion) return running.promise
  const promise = (async () => {
    const entries = await Promise.all(SUB2API_PLATFORMS.map(async (platform) => {
      const key = context.keys[platform]
      const result: KeyModelsResult = !key
        ? { models: new Set<string>(), ok: false, status: 'no-key' }
        : !sub2apiRoutingConfigured()
          ? { models: new Set<string>(), ok: false, status: 'unavailable', diagnostic: 'gateway-unconfigured' }
          : await listKeyModelsWithStatus(context.baseURL, key)
      const old = previous?.platforms[platform]
      const stale = !result.ok && result.status !== 'no-key' && !!old && (old.ok || old.stale)
      return [platform, { ...result, models: stale ? old.models : result.models, stale }] as const
    }))
    const current = await resolveTenantLlmContext(companyId)
    if (current.authorizationVersion !== authorizationVersion || current.generation !== (generations.get(companyId) ?? 0)) {
      return tenantModelSnapshot(current)
    }
    const snapshot: TenantModelSnapshot = {
      authorizationVersion, platforms: Object.fromEntries(entries) as Record<Platform, PlatformSnapshot>, at: Date.now(),
    }
    snapshots.set(companyId, snapshot)
    return snapshot
  })()
  refreshes.set(companyId, { version: authorizationVersion, promise })
  try { return await promise } finally {
    if (refreshes.get(companyId)?.promise === promise) refreshes.delete(companyId)
  }
}
