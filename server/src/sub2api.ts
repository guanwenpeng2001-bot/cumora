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
 * Provisioning flow (`provisionUser`) — every step uses the admin
 * x-api-key; no auth endpoint is ever touched:
 *   1. POST /api/v1/admin/users               — create user
 *   2. POST /api/v1/admin/subscriptions/assign — bind the primary
 *      (openai-platform) group; platform groups are `standard`
 *      subscription_type, so their keys need no subscription record
 *   3. POST /api/v1/admin/users/:id/api-keys   — mint one key per
 *      platform group (reusing existing keys on retry)
 *   4. caller persists {sub2api_user_id, sub2api_api_key} on users
 *
 * The fork's POST /admin/users/:id/api-keys keeps provisioning pure
 * admin API — the user-facing POST /keys would require logging in as
 * the user via /auth/*, which app-level Turnstile gates.
 *
 * Best-effort posture: every helper here returns a Result-shaped value
 * rather than throwing. OAuth sign-in must NEVER fail because sub2api
 * provisioning hiccupped — the user just lands without a sub2api_key
 * and the LLM client falls back to the legacy global key.
 */
import { randomBytes } from 'node:crypto'
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
interface AdminAPIKeyList   { items: AdminAPIKeyRow[]; total: number; page: number; page_size: number; pages: number }

/** End-to-end: create sub2api user + assign the primary subscription +
 *  mint one key per platform group. Returns the numeric user id and the
 *  platform→key map, both to be persisted on the cumora users row. On
 *  any step failure, throws — caller decides whether to swallow (we do
 *  during OAuth signup to never block login).
 *
 *  Idempotent convergence: if the sub2api user already exists, we
 *  re-assert allowed_groups in place, and existing keys are REUSED when
 *  their group already matches (no key rotation on retry); only missing
 *  platform groups get fresh keys.
 *
 *  We mirror the cumora user with their REAL email. sub2api's user
 *  list is the operator's source of truth for "who is on this
 *  platform" — showing synthetic addresses defeats that. The sub2api
 *  admin account is provisioned out of the way (ADMIN_EMAIL something
 *  like `admin@cumora.local`) so there's no collision with real emails. */
export async function provisionUser(args: {
  cumoraUserId: string
  email: string
  displayName: string
  tier?: Tier
  /** The caller's currently persisted key map (if any). Used as a
   *  fallback for deployments whose admin key list masks the secret. */
  existingKeys?: ApiKeyMap
}): Promise<ProvisionResult> {
  const tier = args.tier ?? 'free'
  const groups = tierGroups(tier)
  const primaryGroupId = groups.openai
  // Unique configured groups across platforms (platforms may share a
  // group via the fallback chain).
  const groupIds = [...new Set(SUB2API_PLATFORMS.map((p) => groups[p]).filter((id) => id > 0))]
  // 24 bytes of base64url = 32 chars — well above sub2api's min=6.
  // The admin create-user endpoint requires a password; we never store
  // it or use it to authenticate (keys are minted via the admin API).
  const throwawayPw = randomBytes(24).toString('base64url')

  let created: AdminUserResponse
  try {
    created = await adminFetch<AdminUserResponse>('/api/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: args.email,
        password: throwawayPw,
        username: args.displayName,
        // Empty means "unmapped tier" — we still create the user but with
        // no group access. They'll get gated until SUB2API_TIER_*_GROUP_*
        // is configured. Better than refusing signup.
        allowed_groups: groupIds,
        // Tag the sub2api row with the cumora user id so the operator
        // can grep / trace either direction.
        notes: `cumora user ${args.cumoraUserId}`,
      }),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/email already exists|409/i.test(msg)) throw e
    // Find the existing sub2api user by email.
    const list = await adminFetch<{ items: Array<{ id: number; email: string }> }>(
      `/api/v1/admin/users?search=${encodeURIComponent(args.email)}&page=1&page_size=1`,
    )
    const existing = list.items?.find((u) => u.email.toLowerCase() === args.email.toLowerCase())
    if (!existing) throw new Error(`sub2api claims ${args.email} exists but admin search can't find it`)
    // Re-assert group coverage (no password reset — keys are minted
    // admin-side, so the password is never needed).
    await adminFetch(`/api/v1/admin/users/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify({ allowed_groups: groupIds }),
    })
    created = { id: existing.id, email: existing.email }
  }

  // Assign a subscription for the PRIMARY (openai-platform) group.
  // sub2api groups marked `subscription_type: subscription` refuse to
  // bind an API key to the group without an active subscription record;
  // the primary group anchors quota reads (getUserQuota). Platform
  // groups are `standard` and need no subscription. ~10 years validity
  // so the subscription effectively never expires; tier downgrades go
  // through setUserTier.
  if (primaryGroupId > 0) {
    try {
      await adminFetch('/api/v1/admin/subscriptions/assign', {
        method: 'POST',
        body: JSON.stringify({
          user_id: created.id,
          group_id: primaryGroupId,
          validity_days: TIER_SUBSCRIPTION_VALIDITY_DAYS,
          notes: TIER_SUBSCRIPTION_NOTES,
        }),
      })
    } catch (e) {
      // If the user already has an active subscription on this group
      // (e.g. retry after a partial failure), sub2api typically returns
      // a conflict-shaped error. Don't fail the whole provisioning.
      const msg = e instanceof Error ? e.message : String(e)
      if (!/already|exists|active/i.test(msg)) throw e
    }
  }

  // One key per platform group. Existing keys whose group already
  // matches are reused from the admin list response (or the caller's
  // stored map when that response masks the secret); only an un-recoverable
  // existing key requires a fresh key.
  const existingKeys = await adminFetch<AdminAPIKeyList>(
    `/api/v1/admin/users/${created.id}/api-keys?page=1&page_size=1000`,
  )
  const groupsWithKey = new Set<number>()
  for (const k of existingKeys.items ?? []) {
    if (k.group_id != null) groupsWithKey.add(k.group_id)
  }
  const keyValueByGroup = new Map<number, string>()
  for (const groupId of groupIds) {
    if (groupsWithKey.has(groupId)) {
      const stored = SUB2API_PLATFORMS
        .filter((q) => groups[q] === groupId)
        .map((q) => args.existingKeys?.[q])
        .find((v) => v)
      const listed = existingKeys.items?.find((k) => k.group_id === groupId)?.key
      if (listed || stored) {
        keyValueByGroup.set(groupId, listed ?? stored!)
        continue
      }
    }
    const apiKey = await adminFetch<ApiKeyResponse>(`/api/v1/admin/users/${created.id}/api-keys`, {
      method: 'POST',
      body: JSON.stringify({
        name: `cumora · ${args.displayName} · g${groupId}`,
        group_id: groupId,
      }),
    })
    keyValueByGroup.set(groupId, apiKey.key)
  }

  const apiKeys: ApiKeyMap = {}
  for (const platform of SUB2API_PLATFORMS) {
    const groupId = groups[platform]
    if (groupId <= 0) continue
    const value = keyValueByGroup.get(groupId)
    if (value) apiKeys[platform] = value
  }

  return { sub2apiUserId: created.id, apiKeys, groupId: primaryGroupId }
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
export const MODEL_PLATFORM_PRIORITY: readonly Platform[] = ['kimi', 'deepseek', 'grok', 'openai']

/** Pick the platform whose model list claims `model`. Falls back to
 *  `openai` when no list claims it (unknown models keep historical
 *  behavior) or when openai is the only platform available. */
export function pickPlatformForModel(
  modelsByPlatform: Partial<Record<Platform, ReadonlySet<string>>>,
  model: string,
  available: readonly Platform[],
): Platform {
  for (const platform of MODEL_PLATFORM_PRIORITY) {
    if (!available.includes(platform)) continue
    if (modelsByPlatform[platform]?.has(model)) return platform
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

/** Tier change. Idempotent: re-calling with the same tier is fine.
 *
 *  sub2api's `replace-group` endpoint is only for non-subscription
 *  exclusive groups. Cumora's primary tier groups are subscription
 *  groups, so tier changes must keep three records in sync:
 *    1. target primary subscription is active,
 *    2. the user's API keys point at the target tier's group for the
 *       platform each key currently serves (resolved via the group's
 *       platform, admin-side),
 *    3. stale Cumora tier subscriptions are revoked so quota reads
 *       don't keep seeing the old tier. */
async function syncUserTier(sub2apiUserId: number, tier: Tier): Promise<void> {
  const groups = tierGroups(tier)
  const primaryGroupId = groups.openai
  if (primaryGroupId <= 0) {
    console.warn(`[sub2api] tier=${tier} has no group_id mapped; skip`)
    return
  }

  const tierGroupIds = configuredTierGroupIds()
  const allowedGroups = [...new Set(Object.values(groups).filter((id) => id > 0))]
  await adminFetch('/api/v1/admin/users/' + sub2apiUserId, {
    method: 'PUT',
    body: JSON.stringify({ allowed_groups: allowedGroups }),
  })
  const subscriptions = await adminFetch<AdminSubscriptionRow[]>(
    `/api/v1/admin/users/${sub2apiUserId}/subscriptions`,
  )
  const now = Date.now()
  const staleTargetSubs = subscriptions.filter((s) => s.group_id === primaryGroupId && !subscriptionIsActive(s, now))
  for (const sub of staleTargetSubs) {
    await adminFetch(`/api/v1/admin/subscriptions/${sub.id}`, { method: 'DELETE' })
  }

  const hasActiveTarget = subscriptions.some((s) => s.group_id === primaryGroupId && subscriptionIsActive(s, now))
  if (!hasActiveTarget) {
    await adminFetch('/api/v1/admin/subscriptions/assign', {
      method: 'POST',
      body: JSON.stringify({
        user_id: sub2apiUserId,
        group_id: primaryGroupId,
        validity_days: TIER_SUBSCRIPTION_VALIDITY_DAYS,
        notes: TIER_SUBSCRIPTION_NOTES,
      }),
    })
  }

  const keys = await adminFetch<AdminAPIKeyList>(
    `/api/v1/admin/users/${sub2apiUserId}/api-keys?page=1&page_size=1000`,
  )
  // Resolve each key's platform from the group it currently points at,
  // then retarget to the new tier's group for that platform.
  const groupPlatformCache = new Map<number, string | null>()
  for (const key of keys.items ?? []) {
    if (key.group_id == null) continue
    let platform = groupPlatformCache.get(key.group_id)
    if (platform === undefined) {
      const g = await adminFetch<{ id: number; platform?: string }>(`/api/v1/admin/groups/${key.group_id}`).catch(() => null)
      platform = g?.platform ?? null
      groupPlatformCache.set(key.group_id, platform)
    }
    const target = platform && SUB2API_PLATFORMS.includes(platform as Platform)
      ? groups[platform as Platform]
      : primaryGroupId
    if (target <= 0 || key.group_id === target) continue
    await adminFetch(`/api/v1/admin/api-keys/${key.id}`, {
      method: 'PUT',
      body: JSON.stringify({ group_id: target }),
    })
  }

  const staleTierSubs = subscriptions.filter((s) => (
    s.group_id !== primaryGroupId
    && tierGroupIds.has(s.group_id)
    && subscriptionIsActive(s, now)
  ))
  for (const sub of staleTierSubs) {
    await adminFetch('/api/v1/admin/subscriptions/' + sub.id, {
      method: 'DELETE',
    })
  }
}

export async function setUserTier(sub2apiUserId: number, tier: Tier, ownerId?: string): Promise<void> {
  try {
    await syncUserTier(sub2apiUserId, tier)
  } finally {
    // Partial upstream updates also invalidate the old authorization snapshot.
    // Publish a new committed row version even when the key string is unchanged.
    const { pool } = await import('./db/pool.js')
    const { rows } = await pool.query<{ id: string }>(
      'UPDATE users SET sub2api_api_key = sub2api_api_key WHERE sub2api_user_id = $1 RETURNING id', [sub2apiUserId],
    )
    const { invalidateOwnerLlmCaches } = await import('./tenant-llm-context.js')
    for (const { id } of rows) await invalidateOwnerLlmCaches(id)
    if (ownerId && !rows.some((row) => row.id === ownerId)) await invalidateOwnerLlmCaches(ownerId)
  }
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
