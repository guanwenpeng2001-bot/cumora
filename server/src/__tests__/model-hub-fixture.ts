import type { Inventory } from '../models/inventory.js'

export function modelHubFixture(): Inventory {
  return { settings: { brain_model: 'deepseek-v4-flash', brain_fallback_models: '', support_model: 'k3', compaction_model: 'deepseek-v4-flash',
    image_model: 'grok-imagine-image', audio_model: 'qwen3-asr-flash', embed_model: 'text-embedding-v4', llm_config: '' },
    settingOrigins: { brain_model: 'server_settings', brain_fallback_models: 'server_settings' },
    tierGroups: Object.fromEntries(['free', 'pro', 'max'].map(t => [t, { openai: 15, kimi: 13, deepseek: 14, grok: 16 }])),
    direct: [{ slot: 'text', provider: 'kimi', models: ['k3'], configured: true, protocol: 'responses', keyRef: 'OPENAI_API_KEY', endpointRef: 'OPENAI_BASE_URL', modelRefs: ['OPENAI_MODEL'] },
      { slot: 'novita', provider: 'deepseek', models: ['deepseek-v4-flash'], configured: true, protocol: 'chat', keyRef: 'NOVITA_API_KEY', endpointRef: 'NOVITA_BASE_URL', modelRefs: ['NOVITA_MODEL'] }],
    computers: [{ id: 'computer-a', company_id: 'company-a', kind: 'local', status: 'online', last_seen_at: '2026-09-12T01:00:00Z', revoked_at: null,
      detected_engines: [{ id: 'codex', modelCatalog: { source: 'cli', defaultModel: 'gpt-6-astra', models: [{ id: 'gpt-6-astra' }] }, providerProfiles: [{ id: 'custom', model: 'private-model', fastModel: 'private-fast' }] }], engine_defaults: { codex: { model: 'gpt-6-astra', fastModel: 'gpt-5.4-mini' } } }],
    agents: [{ id: 'atlas-4b42', name: 'Atlas', company_id: 'company-a', computer_id: null, engine: 'managed', model: 'deepseek-v4-pro', fast_model: null, model_config: { fallbackModels: ['k3'], effort: 'high' }, provider_profile: null },
      { id: 'test-codex-01', name: 'Codex', company_id: 'company-a', computer_id: 'computer-a', engine: 'codex', model: 'gpt-6-astra', fast_model: null, model_config: null, provider_profile: null }],
    users: [{ id: 'user-a', tier: 'pro', remoteUserId: 4 }], syncIntents: [],
    credentials: [{ ownerUserId: 'user-a', platform: 'openai', remoteUserId: 4, keyId: 42, present: true, integrationOwner: 'cumora' }],
    gateway: { groups: [], accounts: [{ id: 1, platform: 'openai', provider: 'openai', group_ids: [15], models: ['gpt-6-astra'], status: 'active' },
      { id: 2, platform: 'kimi', provider: 'kimi', group_ids: [13], models: ['k3'], status: 'error' }], keys: [], users: [], subscriptions: [], references: [], proxies: [], diagnostics: [] } }
}
