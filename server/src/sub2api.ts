/**
 * sub2api gateway — thin admin SDK + provisioning helpers.
 *
 * sub2api (https://github.com/Wei-Shaw/sub2api) is the LLM quota
 * gateway sitting between cumora-server and OpenAI. Each cumora user
 * gets a mirrored sub2api account + API keys + group assignments. All
 * LLM calls flow through sub2api so quotas are enforced at the
 * gateway layer rather than scattered through cumora-server.
 *
 * Group model: sub2api groups are platform-scoped (an account only ever
 * serves its own platform), while a cumora tier spans every platform.
 * So a tier maps onto one group PER platform
 * (SUB2API_TIER_<TIER>_GROUP_<PLATFORM>), and a provisioned user holds
 * one API key per platform group. users.sub2api_api_key stores a JSON
 * map {"openai": "sk-..", "kimi": "sk-..", ...}; legacy rows holding a
 * bare string are read as the openai-platform key. Model → platform
 * routing happens at call time in server/src/llm.ts.
 *
 * Signup and tier changes persist an intent in sub2api-sync.ts. Its consumer
 * owns retries, per-user serialization and atomic confirmation of the key map.
 * Only keys with confirmed integration ownership are managed here.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { env, normalizeLlmEndpoint } from './env.js'
import { getServerSetting, parseGroupConfig, InvalidServerSettingError, type Sub2apiGroupConfig } from './settings.js'

export type Tier = 'free' | 'pro' | 'max'

/** Platforms with their own sub2api account pools. `openai` doubles as
 *  the default/fallback platform: it anchors the quota subscription and
 *  serves anything no other platform claims (incl. DashScope, which is
 *  an openai-platform account upstream). */
export type Platform = 'openai' | 'kimi' | 'deepseek' | 'grok'
export const SUB2API_PLATFORMS: readonly Platform[] = ['openai', 'kimi', 'deepseek', 'grok']

/** Platform → key material for one provisioned user. */
export type ApiKeyMap = Partial<Record<Platform, string>>

export interface ProvisionResult {
  sub2apiUserId: number
  /** Platform → plaintext API key. Persisted (JSON) onto
   *  users.sub2api_api_key by the caller. */
  apiKeys: ApiKeyMap
  /** Primary (openai-platform) group id — the subscription anchor. */
  groupId: number
}

function legacyTierGroupId(tier: Tier): number {
  switch (tier) {
    case 'free': return env.SUB2API_TIER_FREE_GROUP_ID
    case 'pro':  return env.SUB2API_TIER_PRO_GROUP_ID
    case 'max':  return env.SUB2API_TIER_MAX_GROUP_ID
  }
}

/** Read SUB2API_TIER_<TIER>_GROUP_<PLATFORM> from env. */
function envTierPlatformGroup(tier: Tier, platform: Platform): number {
  const table: Record<Tier, Record<Platform, number>> = {
    free: {
      openai:   env.SUB2API_TIER_FREE_GROUP_OPENAI,
      kimi:     env.SUB2API_TIER_FREE_GROUP_KIMI,
      deepseek: env.SUB2API_TIER_FREE_GROUP_DEEPSEEK,
      grok:     env.SUB2API_TIER_FREE_GROUP_GROK,
    },
    pro: {
      openai:   env.SUB2API_TIER_PRO_GROUP_OPENAI,
      kimi:     env.SUB2API_TIER_PRO_GROUP_KIMI,
      deepseek: env.SUB2API_TIER_PRO_GROUP_DEEPSEEK,
      grok:     env.SUB2API_TIER_PRO_GROUP_GROK,
    },
    max: {
      openai:   env.SUB2API_TIER_MAX_GROUP_OPENAI,
      kimi:     env.SUB2API_TIER_MAX_GROUP_KIMI,
      deepseek: env.SUB2API_TIER_MAX_GROUP_DEEPSEEK,
      grok:     env.SUB2API_TIER_MAX_GROUP_GROK,
    },
  }
  return table[tier][platform]
}

/** Resolve a tier to its per-platform group ids. An unconfigured
 *  platform falls back to the tier's openai group, which itself falls
 *  back to the legacy single-value SUB2API_TIER_<TIER>_GROUP_ID. All
 *  zero when nothing is configured (provision without group access —
 *  the staged-rollout posture). */
export function tierGroups(tier: Tier): Record<Platform, number> {
  const configured = parseGroupConfig(getServerSetting('sub2api_group_config'))[tier]
  const valid = (id: number) => {
    if (Number.isSafeInteger(id) && id >= 0) return id
    console.warn('[sub2api] invalid env group reference', tier)
    return 0
  }
  const openai = configured?.openai ?? (valid(envTierPlatformGroup(tier, 'openai')) || valid(legacyTierGroupId(tier)))
  return {
    openai,
    kimi: configured?.kimi ?? (valid(envTierPlatformGroup(tier, 'kimi')) || openai),
    deepseek: configured?.deepseek ?? (valid(envTierPlatformGroup(tier, 'deepseek')) || openai),
    grok: configured?.grok ?? (valid(envTierPlatformGroup(tier, 'grok')) || openai),
  }
}

/** Primary group for quota/subscription purposes: the tier's
 *  openai-platform group. */
export function tierPrimaryGroupId(tier: Tier): number {
  return tierGroups(tier).openai
}

/** Parse users.sub2api_api_key into a platform→key map. Legacy rows
 *  hold a bare key string (pre platform-split) and read as the openai
 *  key, so old rows keep working without a migration. */
export function parseApiKeyMap(raw: string | null | undefined): ApiKeyMap {
  if (!raw) return {}
  const trimmed = raw.trim()
  if (!trimmed) return {}
  if ((trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) || trimmed === 'null') {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid key map')
      for (const provider of Object.keys(parsed)) {
        if (!SUB2API_PLATFORMS.includes(provider as Platform)) console.warn('[sub2api] unknown key provider', provider)
      }
      const out: ApiKeyMap = {}
      for (const platform of SUB2API_PLATFORMS) {
        const v = parsed[platform]
        if (typeof v === 'string' && v.trim()) out[platform] = v.trim()
        else if (v != null) console.warn('[sub2api] invalid API key value for platform', platform)
      }
      return out
    } catch {
      console.warn('[sub2api] invalid API key map JSON')
      return {}
    }
  }
  return { openai: trimmed }
}

/** Serialize for users.sub2api_api_key. Single openai-only maps stay
 *  bare strings so the row shape doesn't churn for legacy-style setups. */
export function serializeApiKeyMap(keys: ApiKeyMap): string {
  const platforms = SUB2API_PLATFORMS.filter((p) => keys[p])
  if (platforms.length === 0) return ''
  if (platforms.length === 1 && platforms[0] === 'openai') return keys.openai ?? ''
  return JSON.stringify(keys)
}

/** True when env is wired enough that we should actually try to talk
 *  to sub2api. When false, callers should silently fall back to the
 *  legacy global OPENAI_API_KEY path. */
export function sub2apiConfigured(): boolean {
  return Boolean(normalizeLlmEndpoint(env.SUB2API_INTERNAL_URL) && env.SUB2API_ADMIN_KEY)
}

/** Read-side gate for LLM routing (getLlmClient). Only needs a gateway
 *  base URL — the admin key is required solely for the admin SDK
 *  (provisioning/quota). Agent pods run without the admin key but still
 *  route per-platform when this is set (they have DATABASE_URL and read
 *  the owner's key map themselves). */
export function sub2apiRoutingConfigured(): boolean {
  return Boolean(sub2apiOpenAIBaseURL())
}

/** OpenAI-compatible base URL for backend agent/model traffic.
 *
 * Prefer the in-cluster service URL. The public sub2api URL sits behind
 * GCP Ingress, whose request timeout is too short for long streaming
 * Responses calls; routing server and agent-pod traffic through that
 * ingress can abort otherwise successful model calls.
 */
export function sub2apiOpenAIBaseURL(args?: {
  internalUrl?: string
  publicUrl?: string
}): string {
  const internalUrl = normalizeLlmEndpoint(args?.internalUrl ?? env.SUB2API_INTERNAL_URL)
  const publicUrl = normalizeLlmEndpoint(args?.publicUrl ?? env.SUB2API_PUBLIC_URL)
  const base = internalUrl || publicUrl
  return base ? base.endsWith('/v1') ? base : `${base}/v1` : ''
}

/** sub2api wraps every response in {code, message, data}. `code: 0`
 *  is success; any non-zero (incl. HTTP-level 4xx/5xx) carries an
 *  error message we surface to logs. */
interface SubResponse<T> {
  code: number
  message?: string
  data?: T
}

async function adminFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${env.SUB2API_INTERNAL_URL}${path}`, {
    signal: AbortSignal.timeout(15_000),
    ...init,
    headers: {
      'x-api-key': env.SUB2API_ADMIN_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = (await r.json()) as SubResponse<T>
  if (!r.ok || body.code !== 0) {
    throw new Error(`sub2api ${path} ${r.status}/${body.code}: ${body.message ?? 'unknown error'}`)
  }
  return body.data as T
}

interface AdminUserResponse { id: number; email: string }
interface ApiKeyResponse    { id: number; key: string }
interface AdminAPIKeyRow    { id: number; group_id: number | null; name?: string; key?: string }

export interface ManagedIntegrationKey {
  id?: number
  key?: string
  mintGroup: number
  idempotencyKey: string
}
export type ManagedIntegrationKeys = Partial<Record<Platform, ManagedIntegrationKey>>

interface IntegrationUser extends AdminUserResponse {
  notes?: string
  balance: number
  allowed_groups?: number[]
}
interface IntegrationKey extends AdminAPIKeyRow {
  user_id: number
  status: string
  expires_at?: string | null
  quota?: number
  quota_used?: number
}
interface IntegrationGroup {
  id: number
  platform: string
  status: string
  subscription_type: string
}

export interface ReconcileSub2apiArgs {
  cumoraUserId: string
  email: string
  displayName: string
  intentId: string
  groups: Record<Platform, number>
  remoteUserId: number | null
  existingKeys: ApiKeyMap
  managedKeys: ManagedIntegrationKeys
  checkpoint: (remoteUserId: number, keys: ManagedIntegrationKeys) => Promise<void>
}

/** External work only; the consumer checkpoints progress after its intent commits. */
export async function reconcileSub2apiUser(args: ReconcileSub2apiArgs): Promise<ProvisionResult> {
  const groupIds = [...new Set(Object.values(args.groups))]
  if (groupIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('unconfigured_group')
  const groupRows = new Map<number, IntegrationGroup>()
  for (const id of groupIds) {
    const group = await adminFetch<IntegrationGroup>(`/api/v1/admin/groups/${id}`)
    if (group.id !== id || group.status !== 'active' || !['standard', 'subscription'].includes(group.subscription_type)) {
      throw new Error('unavailable_group')
    }
    groupRows.set(id, group)
  }
  for (const platform of SUB2API_PLATFORMS) {
    const group = groupRows.get(args.groups[platform])!
    // Preserve the established primary-group fallback for unconfigured platforms.
    if (group.platform !== platform && !(args.groups[platform] === args.groups.openai && group.platform === 'openai')) {
      throw new Error('group_platform_mismatch')
    }
  }

  const marker = `cumora user ${args.cumoraUserId}`
  const findUser = async (): Promise<IntegrationUser | undefined> => {
    for (let page = 1; ; page++) {
      const list = await adminFetch<{ items: IntegrationUser[]; pages: number }>(
        `/api/v1/admin/users?search=${encodeURIComponent(args.email)}&page=${page}&page_size=100`,
      )
      const found = list.items.find(user => user.email.toLowerCase() === args.email.toLowerCase())
      if (found) {
        if (found.notes !== marker) throw new Error('remote_user_ownership_unconfirmed')
        return found
      }
      if (page >= list.pages || list.items.length < 100) return undefined
    }
  }
  let user = args.remoteUserId
    ? await adminFetch<IntegrationUser>(`/api/v1/admin/users/${args.remoteUserId}`)
    : await findUser()
  if (!user) {
    try {
      user = await adminFetch<IntegrationUser>('/api/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email: args.email, password: randomBytes(24).toString('base64url'),
          username: args.displayName, allowed_groups: groupIds, notes: marker }),
      })
    } catch (error) {
      user = await findUser()
      if (!user) throw error
    }
  }
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || (args.remoteUserId && user.id !== args.remoteUserId)) throw new Error('invalid_remote_user')
  await args.checkpoint(user.id, args.managedKeys)
  // Preserve personal group access; this integration never grants wallet credit.
  const allowed = [...new Set([...(user.allowed_groups ?? []), ...groupIds])]
  if ([...groupRows.values()].some(g => g.subscription_type === 'standard')
    && (!Number.isFinite(Number(user.balance)) || Number(user.balance) <= 0)) {
    throw new Error('standard_group_requires_balance')
  }
  await adminFetch(`/api/v1/admin/users/${user.id}`, {
    method: 'PUT', body: JSON.stringify({ allowed_groups: allowed }),
  })
  const subscriptions = await adminFetch<AdminSubscriptionRow[]>(`/api/v1/admin/users/${user.id}/subscriptions`)
  for (const group of groupRows.values()) {
    if (group.subscription_type !== 'subscription') continue
    if (subscriptions.some(sub => sub.group_id === group.id && subscriptionIsActive(sub))) continue
    for (const sub of subscriptions.filter(sub => sub.group_id === group.id && !subscriptionIsActive(sub))) {
      if (sub.notes !== TIER_SUBSCRIPTION_NOTES) throw new Error('subscription_ownership_unconfirmed')
      await adminFetch(`/api/v1/admin/subscriptions/${sub.id}`, { method: 'DELETE' })
    }
    await adminFetch('/api/v1/admin/subscriptions/assign', {
      method: 'POST', body: JSON.stringify({ user_id: user.id, group_id: group.id,
        validity_days: TIER_SUBSCRIPTION_VALIDITY_DAYS, notes: TIER_SUBSCRIPTION_NOTES }),
    })
  }
  const listKeys = async (): Promise<IntegrationKey[]> => {
    const rows: IntegrationKey[] = []
    for (let page = 1; ; page++) {
      const list = await adminFetch<{ items: IntegrationKey[]; pages: number }>(
        `/api/v1/admin/users/${user.id}/api-keys?page=${page}&page_size=100`,
      )
      rows.push(...list.items)
      if (page >= list.pages || list.items.length < 100) return rows
    }
  }
  let listed = await listKeys()
  const valid = (key: IntegrationKey) => key.user_id === user.id && key.status === 'active'
    && (!key.expires_at || Date.parse(key.expires_at) > Date.now())
    && (!(Number(key.quota) > 0) || Number(key.quota_used) < Number(key.quota))
  const apiKeys: ApiKeyMap = {}
  for (const platform of SUB2API_PLATFORMS) {
    const target = args.groups[platform]
    let managed = args.managedKeys[platform]
    if (!managed) {
      const legacy = listed.find(key => key.key === args.existingKeys[platform] && valid(key)
        && (key.name?.startsWith('cumora · ') || key.name?.startsWith(`cumora:${args.cumoraUserId}:`))
        && !Object.values(args.managedKeys).some(entry => entry.id === key.id))
      managed = { mintGroup: target, idempotencyKey: `${args.intentId}:${platform}:${randomUUID()}`,
        ...(legacy ? { id: legacy.id, key: legacy.key } : {}) }
      args.managedKeys[platform] = managed
      await args.checkpoint(user.id, args.managedKeys)
    }
    let key = listed.find(key => key.id === managed.id)
    if (!managed.id) {
      const minted = await adminFetch<ApiKeyResponse>(`/api/v1/admin/users/${user.id}/api-keys`, {
        method: 'POST', headers: { 'Idempotency-Key': managed.idempotencyKey },
        body: JSON.stringify({ name: `cumora:${args.cumoraUserId}:${platform}`, group_id: managed.mintGroup }),
      })
      managed.id = minted.id
      managed.key = minted.key
      await args.checkpoint(user.id, args.managedKeys)
      listed = await listKeys()
      key = listed.find(row => row.id === managed.id)
    }
    if (!key || !valid(key) || !key.key || key.key !== managed.key) throw new Error('managed_key_unavailable')
    if (key.group_id !== target) {
      if (key.group_id == null) throw new Error('managed_key_group_missing')
      const old = await adminFetch<IntegrationGroup>(`/api/v1/admin/groups/${key.group_id}`)
      if (!SUB2API_PLATFORMS.includes(old.platform as Platform)) throw new Error('unknown_group_platform')
      await adminFetch(`/api/v1/admin/api-keys/${key.id}`, { method: 'PUT', body: JSON.stringify({ group_id: target }) })
    }
    apiKeys[platform] = key.key
  }
  for (const sub of subscriptions) {
    if (!groupIds.includes(sub.group_id) && configuredTierGroupIds().has(sub.group_id)
      && sub.notes === TIER_SUBSCRIPTION_NOTES && subscriptionIsActive(sub)) {
      await adminFetch(`/api/v1/admin/subscriptions/${sub.id}`, { method: 'DELETE' })
    }
  }
  const finalKeys = await listKeys()
  for (const platform of SUB2API_PLATFORMS) {
    if (!finalKeys.some(key => key.id === args.managedKeys[platform]?.id && key.group_id === args.groups[platform]
      && key.key === apiKeys[platform] && valid(key))) throw new Error('managed_key_verification_failed')
  }
  return { sub2apiUserId: user.id, apiKeys, groupId: args.groups.openai }
}

export async function provisionUser(args: {
  cumoraUserId: string; email: string; displayName: string; tier?: Tier; existingKeys?: ApiKeyMap
}): Promise<ProvisionResult> {
  const { requestSub2apiSync, reconcileSub2apiSync } = await import('./sub2api-sync.js')
  await requestSub2apiSync(args.cumoraUserId, args.tier ?? 'free')
  const result = await reconcileSub2apiSync(args.cumoraUserId)
  if (!result) throw new Error('sub2api_sync_pending')
  return result
}

/** sub2api subscription window — used + limit per period, in USD. `null`
 *  limit means "unlimited at this tier" (matching sub2api's group config
 *  shape where `*_limit_usd` is a nullable column). */
export interface QuotaWindow {
  usedUsd: number
  limitUsd: number | null
  windowStart: string | null
}

export interface QuotaSnapshot {
  groupId: number
  groupName: string | null
  status: string
  expiresAt: string | null
  daily: QuotaWindow
  weekly: QuotaWindow
  monthly: QuotaWindow
}

interface AdminSubscriptionRow {
  id: number
  user_id: number
  group_id: number
  status: string
  notes?: string
  starts_at: string
  expires_at: string
  daily_window_start: string | null
  weekly_window_start: string | null
  monthly_window_start: string | null
  daily_usage_usd: number
  weekly_usage_usd: number
  monthly_usage_usd: number
  group?: {
    id: number
    name: string
    daily_limit_usd: number | null
    weekly_limit_usd: number | null
    monthly_limit_usd: number | null
  } | null
}

const TIER_SUBSCRIPTION_VALIDITY_DAYS = 3650
const TIER_SUBSCRIPTION_NOTES = 'cumora auto-provision'

function configuredTierGroupIds(): Set<number> {
  const ids = new Set<number>()
  for (const tier of ['free', 'pro', 'max'] as const) {
    for (const platform of SUB2API_PLATFORMS) {
      const id = tierGroups(tier)[platform]
      if (id > 0) ids.add(id)
    }
    const legacy = legacyTierGroupId(tier)
    if (legacy > 0) ids.add(legacy)
  }
  return ids
}

function subscriptionIsActive(row: AdminSubscriptionRow, now = Date.now()): boolean {
  if (row.status !== 'active') return false
  const expiresAt = Date.parse(row.expires_at)
  return Number.isFinite(expiresAt) && expiresAt > now
}

/** Read a user's current quota usage + group-defined limits from sub2api.
 *  Returns `null` when sub2api is not configured or the user has no active
 *  subscriptions (e.g. provisioning didn't complete) — callers should
 *  treat that as "feature unavailable" and not as a hard error.
 *
 *  When the user has multiple active subscriptions we pick the one whose
 *  group has the highest monthly limit, since that's the tier actually
 *  gating most calls. In the common single-tier case the choice is
 *  trivially the only row. */
export async function getUserQuota(sub2apiUserId: number): Promise<QuotaSnapshot | null> {
  if (!sub2apiConfigured()) return null
  const rows = await adminFetch<AdminSubscriptionRow[]>(
    `/api/v1/admin/users/${sub2apiUserId}/subscriptions`,
  )
  const active = rows.filter((r) => subscriptionIsActive(r))
  if (active.length === 0) return null
  // Pick the "most generous" subscription as the visible quota. sub2api
  // technically allows multiple active groups but a cumora user almost
  // always has exactly one (their tier).
  active.sort((a, b) => (b.group?.monthly_limit_usd ?? 0) - (a.group?.monthly_limit_usd ?? 0))
  const r = active[0]
  const group = r.group ?? null
  return {
    groupId: r.group_id,
    groupName: group?.name ?? null,
    status: r.status,
    expiresAt: r.expires_at ?? null,
    daily: {
      usedUsd: Number(r.daily_usage_usd) || 0,
      limitUsd: group?.daily_limit_usd ?? null,
      windowStart: r.daily_window_start,
    },
    weekly: {
      usedUsd: Number(r.weekly_usage_usd) || 0,
      limitUsd: group?.weekly_limit_usd ?? null,
      windowStart: r.weekly_window_start,
    },
    monthly: {
      usedUsd: Number(r.monthly_usage_usd) || 0,
      limitUsd: group?.monthly_limit_usd ?? null,
      windowStart: r.monthly_window_start,
    },
  }
}

/** Platform preference when a model is claimed by several groups'
 *  model lists (e.g. a deepseek-* model exists on both the native
 *  deepseek group and an openai-platform reseller): native platforms
 *  first, openai as the universal fallback. */
/** Matches sub2api's Images admission; discovery alone does not imply protocol support. */
export function supportsGatewayImages(model: string): boolean {
  const id = model.trim().toLowerCase()
  return id.startsWith('gpt-image-') || id === 'grok-imagine' || id === 'grok-imagine-edit' || id.startsWith('grok-imagine-image')
}

/** Provider ownership is distinct from sub2api's four provisioned platform pools.
 * DashScope currently shares the OpenAI pool; media needs its own direct adapter. */
export function dashscopeMediaRole(model: string): 'audio' | 'image' | null {
  const id = model.trim()
  if (/^(qwen3-asr|qwen-audio-3\.0-asr|fun-asr|paraformer)(?:$|[-.])/i.test(id)) return 'audio'
  if (/^(qwen-image|wanx|z-image)(?:$|[-.\d])|^wan\d+(?:\.\d+)?-image(?:$|-)/i.test(id)) return 'image'
  return null
}

/** Fun-ASR/Paraformer and realtime Qwen ASR use native HTTP/WebSocket APIs. */
export function supportsDashscopeChatAudio(model: string): boolean {
  return /^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/i.test(model.trim())
}

export const MODEL_PLATFORM_PRIORITY: readonly Platform[] = ['kimi', 'deepseek', 'grok', 'openai']

/** Prefer recognized native pools even while discovery is cold or stale.
 *  DashScope/Qwen use the existing OpenAI-platform pool, not a separate key.
 *  Explicit route overrides are handled by the resolver before this helper. */
export function pickPlatformForModel(
  modelsByPlatform: Partial<Record<Platform, ReadonlySet<string>>>,
  model: string,
  available: readonly Platform[],
): Platform {
  const id = model.trim().toLowerCase()
  const native: Platform | undefined = /^(kimi|moonshot)(?:$|[-/])|^k\d+(?:$|[.-])/.test(id) ? 'kimi'
    : /^deepseek(?:$|[-/])/.test(id) ? 'deepseek'
    : /^grok(?:$|[-/])/.test(id) ? 'grok'
    : /^(dashscope|qwen)(?:$|[-/\d])/.test(id) ? 'openai' : undefined
  if (native && available.includes(native)) return native
  for (const platform of MODEL_PLATFORM_PRIORITY) {
    if (!available.includes(platform)) continue
    if ([...modelsByPlatform[platform] ?? []].some(known => known.trim().toLowerCase() === id)) return platform
  }
  if (available.includes('openai')) return 'openai'
  return available[0] ?? 'openai'
}

/** Fetch the model ids a user key can call (gateway /v1/models is
 *  scoped to the key's group). `listKeyModelsWithStatus` preserves whether
 *  the fetch succeeded so route-cache refreshes can retain stale data. */
export interface KeyModelsResult {
  models: Set<string>
  ok: boolean
  status: 'success' | 'empty' | 'no-key' | 'unauthorized' | 'timeout' | 'unavailable'
  diagnostic?: 'invalid-json' | 'invalid-format' | 'http-error' | 'network-error' | 'gateway-unconfigured'
}

export async function listKeyModelsWithStatus(baseUrl: string, apiKey: string): Promise<KeyModelsResult> {
  if (!apiKey) return { models: new Set(), ok: false, status: 'no-key' }
  try {
    const r = await fetch(baseUrl.replace(/\/+$/, '') + '/models', {
      headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) return { models: new Set(), ok: false, status: r.status === 401 || r.status === 403 ? 'unauthorized' : 'unavailable', diagnostic: 'http-error' }
    let body: unknown
    try { body = await r.json() } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
      console.warn('[sub2api] model discovery returned invalid JSON')
      return { models: new Set(), ok: false, status: 'unavailable', diagnostic: 'invalid-json' }
    }
    const data = (body as { data?: unknown } | null)?.data
    if (!Array.isArray(data) || data.some((m) => !m || typeof m.id !== 'string' || !m.id.trim())) {
      console.warn('[sub2api] model discovery returned invalid format')
      return { models: new Set(), ok: false, status: 'unavailable', diagnostic: 'invalid-format' }
    }
    const models = new Set<string>(data.map((m) => m.id))
    return { models, ok: true, status: models.size ? 'success' : 'empty' }
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return { models: new Set(), ok: false, status: timeout ? 'timeout' : 'unavailable', diagnostic: timeout ? undefined : 'network-error' }
  }
}

export async function listKeyModels(baseUrl: string, apiKey: string): Promise<Set<string>> {
  return (await listKeyModelsWithStatus(baseUrl, apiKey)).models
}

export async function setUserTier(sub2apiUserId: number, tier: Tier, ownerId?: string): Promise<void> {
  const { pool } = await import('./db/pool.js')
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE sub2api_user_id = $1 AND ($2::text IS NULL OR id = $2)',
    [sub2apiUserId, ownerId ?? null],
  )
  if (rows.length !== 1) throw new Error('remote_user_ownership_unconfirmed')
  const { requestSub2apiSync } = await import('./sub2api-sync.js')
  await requestSub2apiSync(rows[0].id, tier)
}

export interface Sub2apiGroupChoice { id: number; name: string; platform: Platform }

/** Read-only discovery projects a small DTO, excluding upstream account details. */
export async function discoverSub2apiGroups(): Promise<Sub2apiGroupChoice[]> {
  if (!sub2apiConfigured()) throw new InvalidServerSettingError('sub2api provisioning is not configured')
  const rows = await adminFetch<unknown>('/api/v1/admin/groups/all', { signal: AbortSignal.timeout(10_000) })
  if (!Array.isArray(rows)) throw new Error('invalid sub2api group discovery response')
  const out: Sub2apiGroupChoice[] = []
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.name !== 'string') throw new Error('invalid sub2api group discovery row')
    if (!SUB2API_PLATFORMS.includes(row.platform)) {
      console.warn('[sub2api] unsupported group platform')
      continue
    }
    if (row.status !== undefined && row.status !== 'active') continue
    out.push({ id: row.id, name: row.name, platform: row.platform })
  }
  return out
}

export async function validateSub2apiGroupSelection(config: Sub2apiGroupConfig): Promise<void> {
  const choices = await discoverSub2apiGroups()
  for (const groups of Object.values(config)) {
    for (const [platform, id] of Object.entries(groups)) {
      if (!choices.some(g => g.id === id && g.platform === platform)) {
        throw new InvalidServerSettingError('selected group is unavailable or belongs to a different platform')
      }
    }
  }
}
