import { test } from 'node:test'
import assert from 'node:assert/strict'
import { env } from '../env.js'
import {
  setUserTier, sub2apiOpenAIBaseURL, tierGroups, parseApiKeyMap, serializeApiKeyMap,
  pickPlatformForModel, provisionUser,
} from '../sub2api.js'

test('sub2apiOpenAIBaseURL prefers the internal service URL for backend model traffic', () => {
  assert.equal(
    sub2apiOpenAIBaseURL({
      internalUrl: 'http://sub2api:8080/',
      publicUrl: 'https://sub2api.cumora.ai/',
    }),
    'http://sub2api:8080/v1',
  )
})
test('sub2apiOpenAIBaseURL falls back to the public URL when no internal URL exists', () => {
  assert.equal(
    sub2apiOpenAIBaseURL({
      internalUrl: '',
      publicUrl: 'https://sub2api.cumora.ai/',
    }),
    'https://sub2api.cumora.ai/v1',
  )
})

const savedSub2apiEnv = {
  internalUrl: env.SUB2API_INTERNAL_URL,
  adminKey: env.SUB2API_ADMIN_KEY,
  freeGroup: env.SUB2API_TIER_FREE_GROUP_ID,
  proGroup: env.SUB2API_TIER_PRO_GROUP_ID,
  maxGroup: env.SUB2API_TIER_MAX_GROUP_ID,
  freeOpenai: env.SUB2API_TIER_FREE_GROUP_OPENAI,
  freeKimi: env.SUB2API_TIER_FREE_GROUP_KIMI,
  freeDeepseek: env.SUB2API_TIER_FREE_GROUP_DEEPSEEK,
  freeGrok: env.SUB2API_TIER_FREE_GROUP_GROK,
  proOpenai: env.SUB2API_TIER_PRO_GROUP_OPENAI,
  proKimi: env.SUB2API_TIER_PRO_GROUP_KIMI,
  proDeepseek: env.SUB2API_TIER_PRO_GROUP_DEEPSEEK,
  proGrok: env.SUB2API_TIER_PRO_GROUP_GROK,
  maxOpenai: env.SUB2API_TIER_MAX_GROUP_OPENAI,
  maxKimi: env.SUB2API_TIER_MAX_GROUP_KIMI,
  maxDeepseek: env.SUB2API_TIER_MAX_GROUP_DEEPSEEK,
  maxGrok: env.SUB2API_TIER_MAX_GROUP_GROK,
}
const originalFetch = globalThis.fetch

function restoreSub2apiTestState(): void {
  env.SUB2API_INTERNAL_URL = savedSub2apiEnv.internalUrl
  env.SUB2API_ADMIN_KEY = savedSub2apiEnv.adminKey
  env.SUB2API_TIER_FREE_GROUP_ID = savedSub2apiEnv.freeGroup
  env.SUB2API_TIER_PRO_GROUP_ID = savedSub2apiEnv.proGroup
  env.SUB2API_TIER_MAX_GROUP_ID = savedSub2apiEnv.maxGroup
  env.SUB2API_TIER_FREE_GROUP_OPENAI = savedSub2apiEnv.freeOpenai
  env.SUB2API_TIER_FREE_GROUP_KIMI = savedSub2apiEnv.freeKimi
  env.SUB2API_TIER_FREE_GROUP_DEEPSEEK = savedSub2apiEnv.freeDeepseek
  env.SUB2API_TIER_FREE_GROUP_GROK = savedSub2apiEnv.freeGrok
  env.SUB2API_TIER_PRO_GROUP_OPENAI = savedSub2apiEnv.proOpenai
  env.SUB2API_TIER_PRO_GROUP_KIMI = savedSub2apiEnv.proKimi
  env.SUB2API_TIER_PRO_GROUP_DEEPSEEK = savedSub2apiEnv.proDeepseek
  env.SUB2API_TIER_PRO_GROUP_GROK = savedSub2apiEnv.proGrok
  env.SUB2API_TIER_MAX_GROUP_OPENAI = savedSub2apiEnv.maxOpenai
  env.SUB2API_TIER_MAX_GROUP_KIMI = savedSub2apiEnv.maxKimi
  env.SUB2API_TIER_MAX_GROUP_DEEPSEEK = savedSub2apiEnv.maxDeepseek
  env.SUB2API_TIER_MAX_GROUP_GROK = savedSub2apiEnv.maxGrok
  globalThis.fetch = originalFetch
}

function configureSub2apiTestEnv(): void {
  env.SUB2API_INTERNAL_URL = 'http://sub2api.test'
  env.SUB2API_ADMIN_KEY = 'admin-test-key'
  // Legacy mapping only: free=2 pro=3 max=4, no per-platform overrides.
  env.SUB2API_TIER_FREE_GROUP_ID = 2
  env.SUB2API_TIER_PRO_GROUP_ID = 3
  env.SUB2API_TIER_MAX_GROUP_ID = 4
  env.SUB2API_TIER_FREE_GROUP_OPENAI = 0
  env.SUB2API_TIER_FREE_GROUP_KIMI = 0
  env.SUB2API_TIER_FREE_GROUP_DEEPSEEK = 0
  env.SUB2API_TIER_FREE_GROUP_GROK = 0
  env.SUB2API_TIER_PRO_GROUP_OPENAI = 0
  env.SUB2API_TIER_PRO_GROUP_KIMI = 0
  env.SUB2API_TIER_PRO_GROUP_DEEPSEEK = 0
  env.SUB2API_TIER_PRO_GROUP_GROK = 0
  env.SUB2API_TIER_MAX_GROUP_OPENAI = 0
  env.SUB2API_TIER_MAX_GROUP_KIMI = 0
  env.SUB2API_TIER_MAX_GROUP_DEEPSEEK = 0
  env.SUB2API_TIER_MAX_GROUP_GROK = 0
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: 'success', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// ── tierGroups fallback chain ─────────────────────────────────────────────

test('tierGroups: per-platform var wins, then tier openai group, then legacy value', () => {
  configureSub2apiTestEnv()
  try {
    // legacy only → every platform falls back to the legacy id
    assert.deepEqual(tierGroups('pro'), { openai: 3, kimi: 3, deepseek: 3, grok: 3 })
    // openai platform var overrides legacy; others fall back to it
    env.SUB2API_TIER_PRO_GROUP_OPENAI = 30
    assert.deepEqual(tierGroups('pro'), { openai: 30, kimi: 30, deepseek: 30, grok: 30 })
    // per-platform var wins over the openai fallback
    env.SUB2API_TIER_PRO_GROUP_KIMI = 31
    env.SUB2API_TIER_PRO_GROUP_GROK = 32
    assert.deepEqual(tierGroups('pro'), { openai: 30, kimi: 31, deepseek: 30, grok: 32 })
    // nothing configured → all zero (provision without group access)
    env.SUB2API_TIER_MAX_GROUP_ID = 0
    assert.deepEqual(tierGroups('max'), { openai: 0, kimi: 0, deepseek: 0, grok: 0 })
  } finally {
    restoreSub2apiTestState()
  }
})

// ── api key map (storage shape) ───────────────────────────────────────────

test('parseApiKeyMap reads legacy bare strings as the openai key', () => {
  assert.deepEqual(parseApiKeyMap('sk-legacy'), { openai: 'sk-legacy' })
  assert.deepEqual(parseApiKeyMap(null), {})
  assert.deepEqual(parseApiKeyMap(''), {})
  assert.deepEqual(parseApiKeyMap('not-json{'), { openai: 'not-json{' })
})

test('parseApiKeyMap reads JSON maps and drops unknown platforms', () => {
  assert.deepEqual(
    parseApiKeyMap('{"openai":"sk-o","kimi":"sk-k","bogus":"sk-x"}'),
    { openai: 'sk-o', kimi: 'sk-k' },
  )
})

test('serializeApiKeyMap keeps openai-only maps as bare strings', () => {
  assert.equal(serializeApiKeyMap({ openai: 'sk-o' }), 'sk-o')
  assert.equal(serializeApiKeyMap({ openai: 'sk-o', grok: 'sk-g' }), '{"openai":"sk-o","grok":"sk-g"}')
  assert.equal(serializeApiKeyMap({}), '')
})

// ── model → platform routing ──────────────────────────────────────────────

test('pickPlatformForModel: native platform claims its models, openai is the fallback', () => {
  const available = ['openai', 'kimi', 'grok'] as const
  const models = {
    openai: new Set(['qwen-max', 'deepseek-v3.1']),  // reseller overlap
    kimi: new Set(['k3']),
    grok: new Set(['grok-4']),
  }
  assert.equal(pickPlatformForModel(models, 'k3', [...available]), 'kimi')
  assert.equal(pickPlatformForModel(models, 'grok-4', [...available]), 'grok')
  assert.equal(pickPlatformForModel(models, 'qwen-max', [...available]), 'openai')
  // overlap: native (deepseek) beats the openai reseller when present
  const withDs = { ...models, deepseek: new Set(['deepseek-v3.1']) }
  assert.equal(pickPlatformForModel(withDs, 'deepseek-v3.1', ['openai', 'deepseek']), 'deepseek')
  // unknown model → openai fallback
  assert.equal(pickPlatformForModel(models, 'some-random-model', [...available]), 'openai')
  // no openai key at all → first available
  assert.equal(pickPlatformForModel({ kimi: new Set(['k3']) }, 'whatever', ['kimi']), 'kimi')
})

// ── provisionUser ─────────────────────────────────────────────────────────

test('provisionUser: full platform coverage — all groups in allowed_groups, subscription on primary, one key per unique group', async () => {
  configureSub2apiTestEnv()
  env.SUB2API_TIER_MAX_GROUP_OPENAI = 15
  env.SUB2API_TIER_MAX_GROUP_KIMI = 13
  env.SUB2API_TIER_MAX_GROUP_DEEPSEEK = 14
  env.SUB2API_TIER_MAX_GROUP_GROK = 16
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null
    const path = `${url.pathname}${url.search}`
    calls.push({ method, path, body })
    if (method === 'POST' && path === '/api/v1/admin/users') return ok({ id: 90, email: 'new@example.com' })
    if (method === 'POST' && path === '/api/v1/admin/subscriptions/assign') return ok({ id: 1 })
    if (method === 'GET' && path === '/api/v1/admin/users/90/api-keys?page=1&page_size=1000') {
      return ok({ items: [], total: 0, page: 1, page_size: 1000, pages: 0 })
    }
    if (method === 'POST' && path === '/api/v1/admin/users/90/api-keys') {
      const gid = (body as { group_id: number }).group_id
      return ok({ id: gid * 10, key: `sk-g${gid}` })
    }
    return new Response(JSON.stringify({ code: 404, message: `unexpected ${method} ${path}` }), { status: 404 })
  }) as typeof fetch

  try {
    const r = await provisionUser({ cumoraUserId: 'u-x', email: 'new@example.com', displayName: 'New', tier: 'max' })
    assert.equal(r.sub2apiUserId, 90)
    assert.equal(r.groupId, 15)
    assert.deepEqual(r.apiKeys, { openai: 'sk-g15', kimi: 'sk-g13', deepseek: 'sk-g14', grok: 'sk-g16' })
    const create = calls.find((c) => c.path === '/api/v1/admin/users' && c.method === 'POST')
    assert.deepEqual((create?.body as { allowed_groups: number[] }).allowed_groups, [15, 13, 14, 16])
    // subscription assigned once, on the primary (openai) group only
    const assigns = calls.filter((c) => c.path === '/api/v1/admin/subscriptions/assign')
    assert.equal(assigns.length, 1)
    assert.equal((assigns[0]?.body as { group_id: number }).group_id, 15)
    // one key minted per unique group
    const mints = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/api-keys'))
    assert.deepEqual(mints.map((c) => (c.body as { group_id: number }).group_id), [15, 13, 14, 16])
  } finally {
    restoreSub2apiTestState()
  }
})

test('provisionUser: platforms sharing a group via fallback mint a single shared key', async () => {
  configureSub2apiTestEnv()
  env.SUB2API_TIER_FREE_GROUP_OPENAI = 15
  env.SUB2API_TIER_FREE_GROUP_KIMI = 13
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null
    const path = `${url.pathname}${url.search}`
    calls.push({ method, path, body })
    if (method === 'POST' && path === '/api/v1/admin/users') return ok({ id: 91, email: 'e@example.com' })
    if (method === 'POST' && path === '/api/v1/admin/subscriptions/assign') return ok({ id: 1 })
    if (method === 'GET' && path === '/api/v1/admin/users/91/api-keys?page=1&page_size=1000') {
      return ok({ items: [], total: 0, page: 1, page_size: 1000, pages: 0 })
    }
    if (method === 'POST' && path === '/api/v1/admin/users/91/api-keys') {
      const gid = (body as { group_id: number }).group_id
      return ok({ id: gid * 10, key: `sk-g${gid}` })
    }
    return new Response(JSON.stringify({ code: 404, message: `unexpected ${method} ${path}` }), { status: 404 })
  }) as typeof fetch

  try {
    const r = await provisionUser({ cumoraUserId: 'u-y', email: 'e@example.com', displayName: 'E', tier: 'free' })
    // deepseek/grok fell back to the openai group 15 → share its key
    assert.deepEqual(r.apiKeys, { openai: 'sk-g15', kimi: 'sk-g13', deepseek: 'sk-g15', grok: 'sk-g15' })
    const mints = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/api-keys'))
    assert.equal(mints.length, 2)
  } finally {
    restoreSub2apiTestState()
  }
})

test('provisionUser: retry reuses keys already in the right group and mints only the missing ones', async () => {
  configureSub2apiTestEnv()
  env.SUB2API_TIER_MAX_GROUP_OPENAI = 15
  env.SUB2API_TIER_MAX_GROUP_KIMI = 13
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null
    const path = `${url.pathname}${url.search}`
    calls.push({ method, path, body })
    if (method === 'POST' && path === '/api/v1/admin/users') {
      return new Response(JSON.stringify({ code: 409, message: 'email already exists' }), { status: 409 })
    }
    if (method === 'GET' && path.startsWith('/api/v1/admin/users?search=')) {
      return ok({ items: [{ id: 92, email: 'dup@example.com' }], total: 1, page: 1, page_size: 1, pages: 1 })
    }
    if (method === 'PUT' && path === '/api/v1/admin/users/92') return ok({ id: 92 })
    if (method === 'POST' && path === '/api/v1/admin/subscriptions/assign') return ok({ id: 2 })
    if (method === 'GET' && path === '/api/v1/admin/users/92/api-keys?page=1&page_size=1000') {
      // group 15 already has a key from a previous partial run
      return ok({ items: [{ id: 700, group_id: 15 }], total: 1, page: 1, page_size: 1000, pages: 1 })
    }
    if (method === 'POST' && path === '/api/v1/admin/users/92/api-keys') return ok({ id: 701, key: 'sk-g13' })
    return new Response(JSON.stringify({ code: 404, message: `unexpected ${method} ${path}` }), { status: 404 })
  }) as typeof fetch

  try {
    const r = await provisionUser({
      cumoraUserId: 'u-z', email: 'dup@example.com', displayName: 'Dup', tier: 'max',
      existingKeys: { openai: 'sk-stored' },
    })
    assert.equal(r.sub2apiUserId, 92)
    // openai's group-15 key reused from the stored map; kimi minted fresh;
    // deepseek/grok fell back to group 15 → share the reused value
    assert.deepEqual(r.apiKeys, { openai: 'sk-stored', kimi: 'sk-g13', deepseek: 'sk-stored', grok: 'sk-stored' })
    const mints = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/api-keys'))
    assert.equal(mints.length, 1)
    // retry re-asserts allowed_groups without touching the password
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/admin/users/92')
    assert.deepEqual(put?.body, { allowed_groups: [15, 13] })
  } finally {
    restoreSub2apiTestState()
  }
})

test('provisionUser: reused group without a recoverable stored value mints a fresh key', async () => {
  configureSub2apiTestEnv()
  env.SUB2API_TIER_MAX_GROUP_OPENAI = 15
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null
    const path = `${url.pathname}${url.search}`
    calls.push({ method, path, body })
    if (method === 'POST' && path === '/api/v1/admin/users') return ok({ id: 93, email: 'f@example.com' })
    if (method === 'POST' && path === '/api/v1/admin/subscriptions/assign') return ok({ id: 3 })
    if (method === 'GET' && path === '/api/v1/admin/users/93/api-keys?page=1&page_size=1000') {
      // a key exists for group 15 but nothing stored caller-side
      return ok({ items: [{ id: 800, group_id: 15 }], total: 1, page: 1, page_size: 1000, pages: 1 })
    }
    if (method === 'POST' && path === '/api/v1/admin/users/93/api-keys') return ok({ id: 801, key: 'sk-fresh-15' })
    return new Response(JSON.stringify({ code: 404, message: `unexpected ${method} ${path}` }), { status: 404 })
  }) as typeof fetch

  try {
    const r = await provisionUser({ cumoraUserId: 'u-w', email: 'f@example.com', displayName: 'F', tier: 'max' })
    assert.deepEqual(r.apiKeys, { openai: 'sk-fresh-15', kimi: 'sk-fresh-15', deepseek: 'sk-fresh-15', grok: 'sk-fresh-15' })
    const mints = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/api-keys'))
    assert.equal(mints.length, 1)
  } finally {
    restoreSub2apiTestState()
  }
})

// ── setUserTier ───────────────────────────────────────────────────────────

test('setUserTier uses subscription-group sync instead of replace-group', async () => {
  configureSub2apiTestEnv()
  const future = new Date(Date.now() + 86_400_000).toISOString()
  const past = new Date(Date.now() - 86_400_000).toISOString()
  const calls: Array<{ method: string; path: string; body: unknown }> = []

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null
    const path = `${url.pathname}${url.search}`
    calls.push({ method, path, body })

    if (method === 'GET' && path === '/api/v1/admin/users/76/subscriptions') {
      return ok([
        { id: 10, user_id: 76, group_id: 2, status: 'active', expires_at: future, daily_usage_usd: 0, weekly_usage_usd: 0, monthly_usage_usd: 0, daily_window_start: null, weekly_window_start: null, monthly_window_start: null },
        { id: 11, user_id: 76, group_id: 9, status: 'active', expires_at: future, daily_usage_usd: 0, weekly_usage_usd: 0, monthly_usage_usd: 0, daily_window_start: null, weekly_window_start: null, monthly_window_start: null },
        { id: 12, user_id: 76, group_id: 3, status: 'expired', expires_at: past, daily_usage_usd: 0, weekly_usage_usd: 0, monthly_usage_usd: 0, daily_window_start: null, weekly_window_start: null, monthly_window_start: null },
      ])
    }
    if (method === 'DELETE' && path === '/api/v1/admin/subscriptions/12') return ok({ message: 'revoked' })
    if (method === 'POST' && path === '/api/v1/admin/subscriptions/assign') return ok({ id: 13 })
    if (method === 'GET' && path === '/api/v1/admin/users/76/api-keys?page=1&page_size=1000') {
      return ok({ items: [{ id: 501, group_id: 2 }, { id: 502, group_id: 3 }], total: 2, page: 1, page_size: 1000, pages: 1 })
    }
    if (method === 'GET' && path === '/api/v1/admin/groups/2') return ok({ id: 2, platform: 'openai' })
    if (method === 'GET' && path === '/api/v1/admin/groups/3') return ok({ id: 3, platform: 'openai' })
    if (method === 'PUT' && path === '/api/v1/admin/api-keys/501') return ok({ api_key: { id: 501, group_id: 3 } })
    if (method === 'DELETE' && path === '/api/v1/admin/subscriptions/10') return ok({ message: 'revoked' })
    return new Response(JSON.stringify({ code: 404, message: `unexpected ${method} ${path}` }), { status: 404 })
  }) as typeof fetch

  try {
    await setUserTier(76, 'pro')
  } finally {
    restoreSub2apiTestState()
  }

  assert.equal(calls.some((c) => c.path.includes('replace-group')), false)
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'GET /api/v1/admin/users/76/subscriptions',
    'DELETE /api/v1/admin/subscriptions/12',
    'POST /api/v1/admin/subscriptions/assign',
    'GET /api/v1/admin/users/76/api-keys?page=1&page_size=1000',
    'GET /api/v1/admin/groups/2',
    'PUT /api/v1/admin/api-keys/501',
    'GET /api/v1/admin/groups/3',
    'DELETE /api/v1/admin/subscriptions/10',
  ])
  assert.deepEqual(calls[2]?.body, {
    user_id: 76,
    group_id: 3,
    validity_days: 3650,
    notes: 'cumora auto-provision',
  })
  assert.deepEqual(calls[5]?.body, { group_id: 3 })
})

test('setUserTier is idempotent when subscription and API keys already match', async () => {
  configureSub2apiTestEnv()
  const future = new Date(Date.now() + 86_400_000).toISOString()
  const calls: Array<{ method: string; path: string }> = []

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const path = `${url.pathname}${url.search}`
    calls.push({ method, path })
    if (method === 'GET' && path === '/api/v1/admin/users/76/subscriptions') {
      return ok([
        { id: 20, user_id: 76, group_id: 3, status: 'active', expires_at: future, daily_usage_usd: 0, weekly_usage_usd: 0, monthly_usage_usd: 0, daily_window_start: null, weekly_window_start: null, monthly_window_start: null },
      ])
    }
    if (method === 'GET' && path === '/api/v1/admin/users/76/api-keys?page=1&page_size=1000') {
      return ok({ items: [{ id: 501, group_id: 3 }], total: 1, page: 1, page_size: 1000, pages: 1 })
    }
    if (method === 'GET' && path === '/api/v1/admin/groups/3') return ok({ id: 3, platform: 'openai' })
    return new Response(JSON.stringify({ code: 404, message: `unexpected ${method} ${path}` }), { status: 404 })
  }) as typeof fetch

  try {
    await setUserTier(76, 'pro')
  } finally {
    restoreSub2apiTestState()
  }

  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'GET /api/v1/admin/users/76/subscriptions',
    'GET /api/v1/admin/users/76/api-keys?page=1&page_size=1000',
    'GET /api/v1/admin/groups/3',
  ])
})
