import { test, mock, after } from 'node:test'
import { pool } from '../db/pool.js'
import assert from 'node:assert/strict'
import { env } from '../env.js'
import {
  getUserQuota, sub2apiOpenAIBaseURL, tierGroups, parseApiKeyMap, serializeApiKeyMap,
  pickPlatformForModel,
} from '../sub2api.js'

mock.method(pool, 'query', async () => ({ rows: [], rowCount: 0 }))
after(async () => { await pool.end(); mock.restoreAll() })

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

test('getUserQuota ignores active subscriptions past expires_at', async () => {
  configureSub2apiTestEnv()
  const past = new Date(Date.now() - 86_400_000).toISOString()
  globalThis.fetch = (async () => ok([{
    id: 31,
    user_id: 77,
    group_id: 3,
    status: 'active',
    expires_at: past,
    daily_usage_usd: 1,
    weekly_usage_usd: 2,
    monthly_usage_usd: 3,
    daily_window_start: null,
    weekly_window_start: null,
    monthly_window_start: null,
    group: { id: 3, name: 'pro', daily_limit_usd: 10, weekly_limit_usd: 20, monthly_limit_usd: 30 },
  }])) as typeof fetch
  try {
    assert.equal(await getUserQuota(77), null)
  } finally {
    restoreSub2apiTestState()
  }
})

test('DeepSeek routing survives cold, empty and reseller-only discovery without inventing access', () => {
  for (const models of [{}, { deepseek: new Set<string>() }, { openai: new Set(['deepseek-v4-flash']) }]) {
    assert.equal(pickPlatformForModel(models, 'deepseek-v4-flash', ['openai', 'deepseek']), 'deepseek')
  }
  assert.equal(pickPlatformForModel({}, ' DeepSeek-V4-Flash ', ['openai', 'deepseek']), 'deepseek')
  assert.equal(pickPlatformForModel({}, 'deepseek-v4-flash', ['openai']), 'openai')
  assert.equal(pickPlatformForModel({}, 'deepseekish-model', ['openai', 'deepseek']), 'openai')
  assert.equal(pickPlatformForModel({ grok: new Set(['custom-model']) }, 'custom-model', ['openai', 'deepseek', 'grok']), 'grok')
})
