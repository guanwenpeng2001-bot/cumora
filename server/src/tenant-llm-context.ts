import { getManagedPodSettings } from './managed-pod-settings.js'
import { pool } from './db/pool.js'
import { parseApiKeyMap, listKeyModelsWithStatus, keyedPlatforms, sub2apiOpenAIBaseURL, sub2apiRoutingConfigured, type ApiKeyMap, type KeyModelsResult } from './sub2api.js'

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
  platforms: Record<string, PlatformSnapshot>
  at: number
}

const generations = new Map<string, number>()
const snapshots = new Map<string, TenantModelSnapshot>()
const refreshes = new Map<string, { version: string; promise: Promise<TenantModelSnapshot> }>()
const invalidators = new Set<(companyId: string) => void>()
const SNAPSHOT_TTL_MS = 30_000
/** Same order as catalog snapshots. Key rotation still invalidates via generation. */
const CONTEXT_TTL_MS = SNAPSHOT_TTL_MS
const CONTEXT_MAX = 2_048
const SNAPSHOT_MAX = 2_048
const contexts = new Map<string, { context: TenantLlmContext; at: number }>()
const planAuth = new WeakMap<object, TenantLlmContext>()

function capTtlMap<K, V>(map: Map<K, V>, max: number, expired: (value: V) => boolean): void {
  for (const [key, value] of map) if (expired(value)) map.delete(key)
  while (map.size >= max) {
    const first = map.keys().next().value
    if (first === undefined) break
    map.delete(first)
  }
}

/** Freeze the resolved owner keys onto a plan object without putting credentials in the public DTO. */
export function bindRoleCallAuth(plan: object, context: TenantLlmContext): void {
  planAuth.set(plan, context)
}

/** Reuse the context resolved with this plan unless authorization has rotated. */
export async function contextForRoleCallPlan(plan: {
  companyId: string | null
  authorizationVersion?: string
}): Promise<TenantLlmContext> {
  if (!plan.companyId) throw new Error('Missing tenant LLM route')
  const bound = planAuth.get(plan)
  if (bound
    && bound.companyId === plan.companyId
    && bound.authorizationVersion === plan.authorizationVersion
    && bound.generation === (generations.get(plan.companyId) ?? 0)
    && bound.baseURL === sub2apiOpenAIBaseURL()) {
    return bound
  }
  const context = await resolveTenantLlmContext(plan.companyId)
  if (plan.authorizationVersion && context.authorizationVersion !== plan.authorizationVersion) {
    throw new Error('Tenant LLM authorization changed; resolve the plan again')
  }
  return context
}

/** Bound route preparation independently of a business call's model budget. */
export function waitForLlmResolution<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')))
    const timer = setTimeout(() => finish(() => reject(new DOMException('LLM route resolution timed out', 'TimeoutError'))), timeoutMs)
    function finish(done: () => void) { clearTimeout(timer); signal?.removeEventListener('abort', abort); done() }
    signal?.addEventListener('abort', abort, { once: true })
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
    if (signal?.aborted) abort()
  })
}

export function onTenantLlmInvalidated(callback: (companyId: string) => void): void {
  invalidators.add(callback)
}

export function invalidateTenantModelSnapshot(companyId?: string): void {
  if (!companyId) {
    for (const id of new Set([...generations.keys(), ...snapshots.keys(), ...refreshes.keys()])) invalidateTenantModelSnapshot(id)
    return
  }
  generations.set(companyId, (generations.get(companyId) ?? 0) + 1)
  contexts.delete(companyId)
  snapshots.delete(companyId)
  refreshes.delete(companyId)
}

/** Main-service requests read the committed owner; Pods read their refreshed identity snapshot.
 * xmin changes even for same-key tier updates; no credentials enter public DTOs. */
export async function resolveTenantLlmContext(companyId: string, userId?: string): Promise<TenantLlmContext> {
  const managed = getManagedPodSettings()
  if (managed) {
    if (managed.gateway.companyId !== companyId || userId !== undefined) {
      throw new TenantLlmAccessError('Managed Pod identity does not authorize this request')
    }
    return managed.gateway
  }
  const generation = generations.get(companyId) ?? 0
  generations.set(companyId, generation)
  const cached = contexts.get(companyId)
  if (cached && Date.now() - cached.at >= CONTEXT_TTL_MS) contexts.delete(companyId)
  else if (userId === undefined && cached && cached.context.generation === generation
    && cached.context.baseURL === sub2apiOpenAIBaseURL()) return cached.context
  const { rows } = await waitForLlmResolution(pool.query<{ owner_user_id: string; sub2api_api_key: string | null; authorization_version: string }>(
    { text: `SELECT c.owner_user_id, u.sub2api_api_key, u.xmin::text AS authorization_version
       FROM companies c JOIN users u ON u.id = c.owner_user_id
      WHERE c.id = $1
        AND ($2::text IS NULL OR EXISTS (
          SELECT 1 FROM company_members cm WHERE cm.company_id = c.id AND cm.user_id = $2
        ))`, values: [companyId, userId ?? null], query_timeout: 500 } as import('pg').QueryConfig & { query_timeout: number },
  ), 500)
  if (generation !== (generations.get(companyId) ?? 0)) return resolveTenantLlmContext(companyId, userId)
  const row = rows[0]
  if (!row) throw new TenantLlmAccessError('Company not found or access denied')
  const context: TenantLlmContext = {
    companyId, ownerId: row.owner_user_id, generation,
    authorizationVersion: `${row.owner_user_id}:${row.authorization_version}:${generation}:${sub2apiOpenAIBaseURL()}`,
    keys: parseApiKeyMap(row.sub2api_api_key), baseURL: sub2apiOpenAIBaseURL(),
  }
  if (userId === undefined) {
    capTtlMap(contexts, CONTEXT_MAX, entry => Date.now() - entry.at >= CONTEXT_TTL_MS)
    contexts.set(companyId, { context, at: Date.now() })
  }
  return context
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
    const entries = await Promise.all(keyedPlatforms(context.keys).map(async (platform) => {
      const key = context.keys[platform]!
      const result: KeyModelsResult = !sub2apiRoutingConfigured()
        ? { models: new Set<string>(), ok: false, status: 'unavailable', diagnostic: 'gateway-unconfigured' }
        : await listKeyModelsWithStatus(context.baseURL, key)
      const old = previous?.platforms[platform]
      const stale = !result.ok && result.status !== 'no-key' && !!old && (old.ok || old.stale)
      return [platform, { ...result, models: stale ? old.models : result.models, stale }] as const
    }))
    const current = getManagedPodSettings()?.gateway ?? contexts.get(companyId)?.context
    if (context.generation !== (generations.get(companyId) ?? 0)
      || current && current.authorizationVersion !== authorizationVersion) {
      throw new TenantLlmAccessError('Tenant LLM authorization changed during discovery')
    }
    const snapshot: TenantModelSnapshot = {
      authorizationVersion, platforms: Object.fromEntries(entries) as Record<string, PlatformSnapshot>, at: Date.now(),
    }
    capTtlMap(snapshots, SNAPSHOT_MAX, entry => Date.now() - entry.at >= SNAPSHOT_TTL_MS * 4)
    snapshots.set(companyId, snapshot)
    return snapshot
  })()
  refreshes.set(companyId, { version: authorizationVersion, promise })
  try { return await promise } finally {
    if (refreshes.get(companyId)?.promise === promise) refreshes.delete(companyId)
  }
}

/** Business routes use only this authorization version; refresh never blocks a warm call. */
export async function tenantRoutingSnapshot(context: TenantLlmContext, signal?: AbortSignal): Promise<TenantModelSnapshot | null> {
  signal?.throwIfAborted()
  const existing = snapshots.get(context.companyId)
  const previous = existing?.authorizationVersion === context.authorizationVersion ? existing : null
  // Warm catalog: return the snapshot and do not start another /models round-trip.
  if (previous && Date.now() - previous.at < SNAPSHOT_TTL_MS) return previous
  const refresh = tenantModelSnapshot(context)
  // Background discovery can fail after the caller has returned or cancelled.
  void refresh.catch(() => {})
  if (previous) return previous
  try { return await waitForLlmResolution(refresh, 250, signal) }
  catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && error.name === 'TimeoutError') return null
    throw error
  }
}
