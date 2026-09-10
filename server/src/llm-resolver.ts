import { getServerSettingsSnapshot, parseLlmConfig, LLM_ROLES, type LlmRole, type LlmProtocol, type ServerSettingsSnapshot } from './settings.js'
import { resolveDirectLlmEnv, type DirectLlmSlot } from './env.js'
import { resolveTenantLlmContext, tenantModelSnapshot } from './tenant-llm-context.js'
import { sub2apiRoutingConfigured, sub2apiConfigured, pickPlatformForModel, SUB2API_PLATFORMS, type Platform } from './sub2api.js'
import { parseAgentModelConfig, REASONING_EFFORTS } from './agents/model-config.js'

export interface RoleCallAgent { id?: string; model?: string | null; modelConfig?: unknown; model_config?: unknown }
export interface RoleCallCandidate {
  model: string
  requestModel: string
  route: { id: string; kind: 'gateway' | 'direct'; platform?: Platform; env?: DirectLlmSlot; endpointSource: string; credentialSource: string }
  protocol: LlmProtocol
  available: boolean
  source: string
  parameterSources: { effort: string; maxOutputTokens: string; contextWindow: string }
  parameters: { effort?: string; maxOutputTokens?: number; contextWindow?: number; reasoningHeadroom?: number }
  capabilities: { tools?: boolean; vision?: boolean }
  diagnostic?: string
}
export interface RoleCallPlan {
  companyId: string | null
  domain: 'managed' | 'server' | 'byoa'
  role: LlmRole
  purpose: string
  agentId?: string
  revision: string
  authorizationVersion?: string
  routable: boolean
  provisionable: boolean
  candidates: readonly RoleCallCandidate[]
  diagnostics: readonly string[]
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Resolves one immutable call plan; no clients, credentials or attempts escape into previews. */
export async function resolveRoleCall(company: string | null, domain: RoleCallPlan['domain'], role: LlmRole, purpose: string, agent?: RoleCallAgent, captured?: ServerSettingsSnapshot): Promise<RoleCallPlan> {
  const snapshot = captured ?? getServerSettingsSnapshot()
  const diagnostics: string[] = [...(snapshot.diagnostics ?? [])]
  const plan: RoleCallPlan = { companyId: company, domain, role, purpose, agentId: agent?.id, revision: snapshot.revision,
    routable: sub2apiRoutingConfigured(), provisionable: sub2apiConfigured(), candidates: [], diagnostics }
  if (domain === 'byoa') return freeze({ ...plan, diagnostics: ['byoa-engine-managed'] })
  if (!LLM_ROLES.includes(role)) return freeze({ ...plan, diagnostics: ['invalid-role'] })
  const config = parseLlmConfig(snapshot.settings.llm_config ?? '')
  const selected = config.roles.find(r => r.role === role && r.purpose === purpose) ?? config.roles.find(r => r.role === role && r.purpose === undefined)
  const mc = role === 'brain' ? parseAgentModelConfig(agent?.modelConfig ?? agent?.model_config) : null
  const inherited = snapshot.settings[`${role}_model`]?.trim() ?? ''
  const primary = role === 'brain' && agent?.model?.trim() ? agent.model.trim() : selected?.models[0] ?? inherited
  const fallbacks = mc?.fallbackModels ?? selected?.models.slice(1) ?? (snapshot.settings[`${role}_fallback_models`] ?? '').split(',')
  const models = primary ? [...new Set([primary, ...(role === 'embed' ? [] : fallbacks)].map(m => m.trim()).filter(Boolean))] : []
  if (!primary) diagnostics.push(`missing-primary:${role}`)
  const context = company && sub2apiRoutingConfigured() ? await resolveTenantLlmContext(company) : null
  const discovery = context && SUB2API_PLATFORMS.some(p => context.keys[p]) ? await tenantModelSnapshot(context) : null
  if (context && discovery && context.authorizationVersion !== discovery.authorizationVersion) {
    return resolveRoleCall(company, domain, role, purpose, agent, snapshot)
  }
  if (discovery) {
    for (const platform of SUB2API_PLATFORMS.filter(p => context?.keys[p])) {
      const status = discovery.platforms[platform]
      if (!status.ok || status.stale) diagnostics.push(`discovery:${platform}:${status.status}${status.stale ? ':stale' : ''}`)
    }
  }
  plan.authorizationVersion = discovery?.authorizationVersion ?? context?.authorizationVersion
  const available = context ? SUB2API_PLATFORMS.filter(p => context.keys[p]) : []
  const modelsByPlatform = discovery ? Object.fromEntries(SUB2API_PLATFORMS.map(p => [p, discovery.platforms[p].models])) : {}
  const readInteger = (key: string, fallback: number, min: number) => {
    const raw = snapshot.settings[key] ?? ''
    const n = Number(raw)
    if (raw && Number.isSafeInteger(n) && n >= min && n <= 1_000_000) return n
    if (raw) diagnostics.push(`invalid-setting:${key}`)
    return fallback
  }
  const candidates = models.map((model): RoleCallCandidate => {
    const sourceKey = model === primary ? `${role}_model` : `${role}_fallback_models`
    const metadata = config.models.find(m => m.model === model)
    const explicit = config.routes.find(r => r.id === metadata?.route)
    const prefix = model.startsWith('novita/') ? 'novita' : model.startsWith('orcarouter/') ? 'orcarouter' : undefined
    const slot: DirectLlmSlot = explicit?.env ?? prefix ?? (['image', 'audio', 'embed'].includes(role) ? role as DirectLlmSlot : 'text')
    const direct = resolveDirectLlmEnv(slot)
    const kind = explicit?.kind ?? (prefix && direct.configured ? 'direct' : available.length ? 'gateway' : 'direct')
    const platform = kind === 'gateway' ? explicit?.platform ?? pickPlatformForModel(modelsByPlatform, model, available) : undefined
    const protocol = metadata?.protocol ?? explicit?.protocol ?? (kind === 'direct' ? direct.protocol as LlmProtocol : role === 'image' ? 'images' : role === 'audio' ? 'chat' : role === 'embed' ? 'embeddings' : 'responses')
    const effortKey = role === 'brain' ? 'agent_reasoning_effort' : 'support_reasoning_effort'
    const rawEffort = snapshot.settings[effortKey]?.trim().toLowerCase() ?? 'none'
    const effort = mc?.effort ?? metadata?.effort ?? (REASONING_EFFORTS.has(rawEffort) ? rawEffort : 'none')
    if (!REASONING_EFFORTS.has(rawEffort)) diagnostics.push(`invalid-setting:${effortKey}`)
    const text = ['brain', 'support', 'compaction'].includes(role)
    const max = mc?.maxOutputTokens ?? metadata?.maxOutputTokens ?? (role === 'brain' ? readInteger('agent_max_output_tokens', 4000, 1) : undefined)
    const contextWindow = metadata?.contextWindow === undefined ? mc?.contextWindow : Math.min(mc?.contextWindow ?? metadata.contextWindow, metadata.contextWindow)
    const compatible = (!metadata?.roles || metadata.roles.includes(role)) && (text ? ['responses', 'chat'].includes(protocol) : role === 'image' ? ['images', 'dashscope-image'].includes(protocol) : role === 'embed' ? protocol === 'embeddings' : protocol === 'chat')
    return {
      model, requestModel: kind === 'direct' && prefix === slot ? model.slice(prefix.length + 1) : model,
      route: { id: explicit?.id ?? `${kind}:${kind === 'gateway' ? platform : slot}`, kind, platform,
        env: kind === 'direct' ? slot : undefined,
        endpointSource: kind === 'gateway' ? 'sub2api-env' : direct.endpointSource,
        credentialSource: kind === 'gateway' ? 'owner-key-map' : direct.keySource },
      protocol, available: compatible && (kind === 'gateway' ? Boolean(context?.baseURL && platform && context.keys[platform]) : direct.configured),
      source: role === 'brain' && ((model === primary && agent?.model?.trim()) || (model !== primary && mc?.fallbackModels)) ? 'agent' : selected ? `${snapshot.sources.llm_config}:llm_config` : `${snapshot.sources[sourceKey] ?? 'env'}:${sourceKey}`,
      parameterSources: { effort: mc?.thinking !== undefined || mc?.effort !== undefined ? 'agent' : metadata?.thinking !== undefined || metadata?.effort !== undefined ? 'llm_config' : effortKey,
        maxOutputTokens: mc?.maxOutputTokens !== undefined ? 'agent:model-cap' : metadata?.maxOutputTokens !== undefined ? 'llm_config' : role === 'brain' ? 'agent_max_output_tokens' : 'caller-budget',
        contextWindow: metadata?.contextWindow !== undefined ? 'llm_config:model-cap' : mc?.contextWindow !== undefined ? 'agent' : 'unspecified' },
      parameters: text ? { effort: mc?.thinking === false || metadata?.thinking === false || effort === 'none' ? undefined : effort,
        maxOutputTokens: max === undefined ? undefined : Math.min(max, metadata?.maxOutputTokens ?? max, contextWindow ?? max), contextWindow,
        reasoningHeadroom: role === 'brain' ? undefined : readInteger('support_reasoning_headroom', 0, 0) } : {},
      capabilities: { tools: metadata?.tools, vision: metadata?.vision },
      diagnostic: !compatible ? 'incompatible-capability' : kind === 'direct' && !direct.configured ? 'direct-unconfigured' : kind === 'gateway' && !context?.keys[platform!] ? 'gateway-unprovisioned' : undefined,
    }
  })
  return freeze({ ...plan, candidates, diagnostics: [...new Set(diagnostics)] })
}
