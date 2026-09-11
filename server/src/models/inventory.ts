import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { SETTING_DEFS } from '../settings.js'
import { readEnvTierPlatformGroups, type DirectLlmSlot } from '../env.js'
import { readEnvSources } from './sources/env.js'
import { parseApiKeyMap } from '../sub2api.js'

export const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
export const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
export const str = (v: unknown): string => typeof v === 'string' ? v : ''
export const revision = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 24)
export const identity = (...parts: string[]): string => parts.map(encodeURIComponent).join(':')
export interface DirectSource { slot: DirectLlmSlot; provider: string; models: string[]; configured: boolean; protocol: string; keyRef: string; endpointRef: string; modelRefs: string[] }
export interface ComputerInventory { id: string; company_id: string; kind: string; status: string; last_seen_at: string | null; revoked_at: string | null; detected_engines: unknown; engine_defaults: unknown }
export interface AgentInventory { id: string; name: string; company_id: string; computer_id: string | null; engine: string | null; model: string | null; fast_model: string | null; model_config: unknown; provider_profile: string | null }
export interface CredentialInventory { ownerUserId: string; platform: string; remoteUserId: number | null; keyId: number | null; present: boolean; integrationOwner: string }
export interface Inventory {
  settings: Record<string, string>; settingOrigins: Record<string, string>; direct: DirectSource[]
  tierGroups: Record<string, Record<string, number>>; computers: ComputerInventory[]; agents: AgentInventory[]
  credentials: CredentialInventory[]; users: Record<string, unknown>[]; syncIntents: Record<string, unknown>[]
  legacyPrices?: Record<string, unknown>[]
  gateway?: GatewayInventory
}
export interface GatewayInventory {
  groups: Record<string, unknown>[]; accounts: Record<string, unknown>[]; keys: Record<string, unknown>[]
  users: Record<string, unknown>[]; subscriptions: Record<string, unknown>[]; references: Record<string, unknown>[]
  proxies: Record<string, unknown>[]; diagnostics: string[]
}
/** Must run in a caller-owned REPEATABLE READ READ ONLY transaction. Never selects secrets into the output. */
export async function readInventory(client: Pick<PoolClient, 'query'>): Promise<Inventory> {
  const settingsRows = await client.query<{ key: string; value: string }>('SELECT key, value FROM server_settings')
  const settings: Record<string, string> = {}, settingOrigins: Record<string, string> = {}
  for (const d of SETTING_DEFS.filter(d => /_model$|_fallback_models$|reasoning|output_tokens/.test(d.key) || ['llm_config', 'sub2api_group_config'].includes(d.key))) {
    const row = settingsRows.rows.find(r => r.key === d.key)
    settings[d.key] = row ? row.value : d.envValue()
    settingOrigins[d.key] = row ? 'server_settings' : 'env/default'
  }
  const computers = (await client.query<ComputerInventory>('SELECT id, company_id, kind, status, last_seen_at, revoked_at, detected_engines, engine_defaults FROM computers ORDER BY id')).rows
  const agents = (await client.query<AgentInventory>(`SELECT id, name, company_id, computer_id, engine, model, fast_model, model_config, provider_profile FROM participants WHERE kind = 'agent' AND departed_at IS NULL ORDER BY id`)).rows
  const rawUsers = (await client.query(`SELECT id, tier, pro_trial_expires_at AS trial_expires_at, sub2api_user_id, sub2api_api_key FROM users ORDER BY id`)).rows
  const rawIntents = (await client.query('SELECT user_id, intent_id, version, target_tier, target_groups, status, remote_user_id, managed_keys, confirmed_at FROM sub2api_sync_intents ORDER BY user_id')).rows
  const credentials: CredentialInventory[] = []
  for (const u of rawUsers) for (const [platform, key] of Object.entries(parseApiKeyMap(u.sub2api_api_key))) {
    const managed = record(record(rawIntents.find(i => i.user_id === u.id)?.managed_keys)[platform])
    credentials.push({ ownerUserId: u.id, platform, remoteUserId: u.sub2api_user_id, keyId: typeof managed.id === 'number' ? managed.id : null, present: !!key, integrationOwner: managed.id ? 'cumora' : 'legacy-unverified' })
  }
  return { settings, settingOrigins, direct: readEnvSources(), computers, agents, credentials,
    legacyPrices: (await client.query('SELECT model, input_per_1m, cached_input_per_1m, cache_write_per_1m, output_per_1m, priced_at FROM model_pricing ORDER BY model')).rows,
    tierGroups: Object.fromEntries(['free', 'pro', 'max'].map(t => [t, readEnvTierPlatformGroups(t as 'free' | 'pro' | 'max')])),
    users: rawUsers.map(u => ({ id: u.id, tier: u.tier, trialExpiresAt: u.trial_expires_at, remoteUserId: u.sub2api_user_id, credentialPresent: !!u.sub2api_api_key })),
    syncIntents: rawIntents.map(i => ({ userId: i.user_id, intentId: i.intent_id, version: i.version, targetTier: i.target_tier, targetGroups: i.target_groups, status: i.status, remoteUserId: i.remote_user_id, confirmedAt: i.confirmed_at,
      managedKeys: Object.fromEntries(Object.entries(record(i.managed_keys)).map(([p, v]) => [p, { id: record(v).id, mintGroup: record(v).mintGroup }])) })) }
}
