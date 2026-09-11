import { getServerSettingsSnapshot, parseLlmConfig, readLlmModelTarget, LLM_ROLES, type LlmRole, type LlmProtocol, type ServerSettingsSnapshot } from './settings.js'
import { resolveDirectLlmEnv, type DirectLlmSlot } from './env.js'
import { resolveTenantLlmContext, tenantRoutingSnapshot, waitForLlmResolution, bindRoleCallAuth } from './tenant-llm-context.js'
import { sub2apiRoutingConfigured, sub2apiConfigured, pickPlatformForModel, supportsGatewayImages, gatewayCatalogHasImages, dashscopeMediaRole, supportsDashscopeChatAudio, keyedPlatforms, type Platform } from './sub2api.js'
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
export async function resolveRoleCall(company: string | null, domain: RoleCallPlan['domain'], role: LlmRole, purpose: string, agent?: RoleCallAgent, captured?: ServerSettingsSnapshot, signal?: AbortSignal): Promise<RoleCallPlan> {
  signal?.throwIfAborted()
  const snapshot = captured ?? getServerSettingsSnapshot()
  const diagnostics: string[] = [...(snapshot.diagnostics ?? [])]
  const plan: RoleCallPlan = { companyId: company, domain, role, purpose, agentId: agent?.id, revision: snapshot.revision,
    routable: sub2apiRoutingConfigured(), provisionable: sub2apiConfigured(), candidates: [], diagnostics }
  if (domain === 'byoa') return freeze({ ...plan, diagnostics: ['byoa-engine-managed'] })
  if (!LLM_ROLES.includes(role)) return freeze({ ...plan, diagnostics: ['invalid-role'] })
  const config = parseLlmConfig(snapshot.settings.llm_config ?? '')
  const selected = config.roles.find(r => r.role === role && role !== 'embed' && r.purpose === purpose) ?? config.roles.find(r => r.role === role && r.purpose === undefined)
  const mc = role === 'brain' ? parseAgentModelConfig(agent?.modelConfig ?? agent?.model_config) : null
  const inherited = snapshot.settings[`${role}_model`]?.trim() ?? ''
  const primary = role === 'brain' && agent?.model?.trim() ? agent.model.trim() : selected?.models[0] ?? inherited
  const fallbacks = mc?.fallbackModels ?? selected?.models.slice(1) ?? (snapshot.settings[`${role}_fallback_models`] ?? '').split(',')
  const models = primary ? [...new Set([primary, ...(role === 'embed' ? [] : fallbacks)].map(m => m.trim()).filter(Boolean))] : []
  if (!primary) diagnostics.push(`missing-primary:${role}`)
  const context = company && sub2apiRoutingConfigured() ? await waitForLlmResolution(resolveTenantLlmContext(company), 500, signal) : null
  const discovery = role !== 'embed' && context && keyedPlatforms(context.keys).length ? await tenantRoutingSnapshot(context, signal) : null
  if (context && discovery && context.authorizationVersion !== discovery.authorizationVersion) {
    return resolveRoleCall(company, domain, role, purpose, agent, snapshot, signal)
  }
  if (context && !discovery && role !== 'embed') diagnostics.push('discovery:pending')
  const available = context ? keyedPlatforms(context.keys) : []
  if (discovery) {
    for (const platform of available) {
      const status = discovery.platforms[platform]
      if (!status) continue
      if (!status.ok || status.stale) diagnostics.push(`discovery:${platform}:${status.status}${status.stale ? ':stale' : ''}`)
    }
  }
  plan.authorizationVersion = discovery?.authorizationVersion ?? context?.authorizationVersion
  const modelsByPlatform = discovery ? Object.fromEntries(Object.entries(discovery.platforms).map(([p, s]) => [p, s.models])) : {}
  const readInteger = (key: string, fallback: number, min: number) => {
    const raw = snapshot.settings[key] ?? ''
    const n = Number(raw)
    if (raw && Number.isSafeInteger(n) && n >= min && n <= 1_000_000) return n
    if (raw) diagnostics.push(`invalid-setting:${key}`)
    return fallback
  }
  const targets = role !== 'embed' && selected?.fallbackPolicy === 'env_after_chain' ? selected.directTargets ?? [] : []
  const entries = [...models.map(model => ({ model, target: undefined as typeof targets[number] | undefined })),
    ...targets.map(target => ({ model: target.model, target }))]
  const expanded = entries.flatMap(entry => {
    const translated = readLlmModelTarget(entry.model, config, entry.target)
    if (entry.target || translated.route || role === 'embed' || !available.length || dashscopeMediaRole(translated.requestModel) === 'audio') return [{ ...entry, platformHint: undefined as Platform | undefined }]
    const preferred = pickPlatformForModel(modelsByPlatform, translated.requestModel, available)
    const membership = available.filter(p => [...modelsByPlatform[p] ?? []].some(id => id.trim().toLowerCase() === translated.requestModel.trim().toLowerCase()))
    const routes = [...new Set([preferred, ...membership])].filter(p => available.includes(p))
    if (!routes.length && available.some(p => {
      const status = discovery?.platforms[p]
      return !status || status.status === 'timeout' || status.status === 'unavailable'
    })) throw new DOMException('LLM model discovery pending; resolve again', 'TimeoutError')
    return (routes.length ? routes : [preferred]).map(platformHint => ({ ...entry, platformHint }))
  })
  const candidates = expanded.map(({ model, target, platformHint }): RoleCallCandidate => {
    const sourceKey = model === primary ? `${role}_model` : `${role}_fallback_models`
    const translated = readLlmModelTarget(model, config, target)
    const { metadata, route: explicit } = translated
    const slot: DirectLlmSlot = explicit?.env ?? (['image', 'audio', 'embed'].includes(role) ? role as DirectLlmSlot : 'text')
    const direct = resolveDirectLlmEnv(slot)
    const dashscope = dashscopeMediaRole(translated.requestModel) === role
    const discoveredImage = role === 'image' && supportsGatewayImages(translated.requestModel) && available.some(p => [...modelsByPlatform[p] ?? []].some(id => id.toLowerCase() === translated.requestModel.toLowerCase()))
    const kind = explicit?.kind ?? (dashscope && !discoveredImage ? 'direct' : role === 'embed' ? direct.configured || !sub2apiRoutingConfigured() ? 'direct' : 'gateway' : available.length ? 'gateway' : 'direct')
    const platform = kind === 'gateway' ? explicit?.platform ?? platformHint ?? (role === 'embed' ? 'openai' : pickPlatformForModel(modelsByPlatform, model, available)) : undefined
    const protocol = translated.protocol ?? explicit?.protocol ?? (kind === 'direct' ? direct.protocol as LlmProtocol : role === 'image' ? 'images' : role === 'audio' ? 'chat' : role === 'embed' ? 'embeddings' : platform === 'zhipu' ? 'chat' : 'responses')
    const gatewaySupported = role !== 'image' || kind !== 'gateway' || protocol === 'images' && supportsGatewayImages(translated.requestModel)
    const platformDiscovery = kind === 'gateway' && platform && discovery ? discovery.platforms[platform] : undefined
    const catalogKnown = Boolean(platformDiscovery && (platformDiscovery.ok || platformDiscovery.stale))
    const gatewayGroupReady = role !== 'image' || kind !== 'gateway' || !gatewaySupported || !catalogKnown
      || gatewayCatalogHasImages(platform ? modelsByPlatform[platform] : undefined)
    // Native ASR families must not be sent to the incompatible Chat endpoint.
    const audioSupported = role !== 'audio' || !dashscope || supportsDashscopeChatAudio(translated.requestModel)
    const effortKey = role === 'brain' ? 'agent_reasoning_effort' : 'support_reasoning_effort'
    const rawEffort = snapshot.settings[effortKey]?.trim().toLowerCase() ?? 'none'
    const effort = mc?.effort ?? metadata?.effort ?? (REASONING_EFFORTS.has(rawEffort) ? rawEffort : 'none')
    if (!REASONING_EFFORTS.has(rawEffort)) diagnostics.push(`invalid-setting:${effortKey}`)
    const text = ['brain', 'support', 'compaction'].includes(role)
    const max = mc?.maxOutputTokens ?? metadata?.maxOutputTokens ?? (role === 'brain' ? readInteger('agent_max_output_tokens', 4000, 1) : undefined)
    const contextWindow = metadata?.contextWindow === undefined ? mc?.contextWindow : Math.min(mc?.contextWindow ?? metadata.contextWindow, metadata.contextWindow)
    const compatible = (!metadata?.roles || metadata.roles.includes(role)) && (text ? ['responses', 'chat'].includes(protocol) : role === 'image' ? ['images', 'dashscope-image'].includes(protocol) : role === 'embed' ? protocol === 'embeddings' : protocol === 'chat')
    return {
      model, requestModel: translated.requestModel,
      route: { id: explicit?.id ?? `${kind}:${kind === 'gateway' ? platform : slot}`, kind, platform,
        env: kind === 'direct' ? slot : undefined,
        endpointSource: kind === 'gateway' ? 'sub2api-env' : direct.endpointSource,
        credentialSource: kind === 'gateway' ? 'owner-key-map' : direct.keySource },
      protocol, available: compatible && gatewaySupported && audioSupported && gatewayGroupReady && (kind === 'gateway' ? Boolean(context?.baseURL && platform && context.keys[platform] && platformDiscovery?.status !== 'unauthorized' && platformDiscovery?.status !== 'empty') : direct.configured),
      source: target ? 'llm_config:env_after_chain' : role === 'brain' && ((model === primary && agent?.model?.trim()) || (model !== primary && mc?.fallbackModels)) ? 'agent' : selected ? `${snapshot.sources.llm_config}:llm_config` : `${snapshot.sources[sourceKey] ?? 'env'}:${sourceKey}`,
      parameterSources: { effort: mc?.thinking !== undefined || mc?.effort !== undefined ? 'agent' : metadata?.thinking !== undefined || metadata?.effort !== undefined ? 'llm_config' : effortKey,
        maxOutputTokens: mc?.maxOutputTokens !== undefined ? 'agent:model-cap' : metadata?.maxOutputTokens !== undefined ? 'llm_config' : role === 'brain' ? 'agent_max_output_tokens' : 'caller-budget',
        contextWindow: metadata?.contextWindow !== undefined ? 'llm_config:model-cap' : mc?.contextWindow !== undefined ? 'agent' : 'unspecified' },
      parameters: text ? { effort: mc?.thinking === false || metadata?.thinking === false || effort === 'none' ? undefined : effort,
        maxOutputTokens: max === undefined ? undefined : Math.min(max, metadata?.maxOutputTokens ?? max, contextWindow ?? max), contextWindow,
        reasoningHeadroom: role === 'brain' ? undefined : readInteger('support_reasoning_headroom', 0, 0) } : {},
      capabilities: { tools: metadata?.tools, vision: metadata?.vision },
      diagnostic: !gatewaySupported ? 'gateway-image-model-unsupported' : !audioSupported ? 'dashscope-audio-requires-native-protocol' : !compatible ? 'incompatible-capability' : kind === 'direct' && !direct.configured ? 'direct-unconfigured' : kind === 'gateway' && !context?.keys[platform!] ? 'gateway-unprovisioned' : !gatewayGroupReady ? 'gateway-image-group-unavailable' : undefined,
    }
  })
  const seen = new Set<string>()
  const unique = candidates.filter(candidate => {
    const key = JSON.stringify([candidate.route.kind, candidate.route.kind === 'gateway' ? candidate.route.platform : candidate.route.env, candidate.requestModel])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const resolved = freeze({ ...plan, candidates: unique, diagnostics: [...new Set(diagnostics)] })
  if (context) bindRoleCallAuth(resolved, context)
  return resolved
}
