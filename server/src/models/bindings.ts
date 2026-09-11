import type { ModelBinding, ModelTarget } from '../../../shared/model-contract.js'
import { parseLlmConfig, LLM_ROLES } from '../settings.js'
import { parseAgentModelConfig } from '../agents/model-config.js'
import { identity, record, revision, str, type Inventory } from './inventory.js'
import { engineInventories } from './sources/byoa.js'

const target = (name: string, extra: Partial<ModelTarget> = {}): ModelTarget => name ? { kind: 'model', requestModel: name, state: 'unresolved', ...extra } : { kind: 'inherit', ...extra }
const chain = (raw: string): ModelTarget[] => raw.split(',').map(v => v.trim()).filter(Boolean).map(v => target(v))
export function importBindings(input: Inventory): ModelBinding[] {
  const out: ModelBinding[] = []
  function add(b: Omit<ModelBinding, 'id' | 'revision'>) {
    out.push({ ...b, id: identity('binding', b.scopeType, b.scopeId, b.domain, b.slot, b.purpose), revision: revision(b) })
  }
  const config = parseLlmConfig(input.settings.llm_config ?? '')
  for (const slot of LLM_ROLES) {
    const rows = config.roles.filter(r => r.role === slot)
    const roles = rows.some(r => !r.purpose) ? rows : [undefined, ...rows]
    for (const role of roles) add({ scopeType: 'server', scopeId: '', domain: 'server', slot, purpose: role?.purpose ?? '',
      targets: { primary: target(role?.models[0] ?? input.settings[`${slot}_model`] ?? ''),
        fallbacks: slot === 'embed' ? [] : role ? role.models.slice(1).map(v => target(v)) : chain(input.settings[`${slot}_fallback_models`] ?? ''),
        direct: (role?.directTargets ?? []).map(t => {
          const route = config.routes.find(r => r.id === t.route)
          return target(t.model, { sourceKind: 'env', sourceId: `env:${route?.env}`, protocol: t.protocol ?? route?.protocol })
        }) }, parameters: { origin: role ? 'llm_config' : input.settingOrigins[`${slot}_model`], fallbackOrigin: input.settingOrigins[`${slot}_fallback_models`],
          effort: input.settings[slot === 'support' ? 'support_reasoning_effort' : 'agent_reasoning_effort'] }, fallbackPolicy: role?.fallbackPolicy ?? 'legacy' })
  }
  for (const c of input.computers.filter(c => c.kind !== 'cloud')) for (const e of engineInventories(c)) {
    const defaults = record(record(c.engine_defaults)[str(e.id)]), catalog = record(e.modelCatalog)
    const profiles = [null, ...(Array.isArray(e.providerProfiles) ? e.providerProfiles.map(record) : [])]
    for (const profile of profiles) for (const [slot, key, cliKey] of [['brain', 'model', 'defaultModel'], ['engine_fast', 'fastModel', 'defaultFastModel']]) {
      const model = profile ? str(profile[key]) : str(defaults[key]) || str(catalog[cliKey])
      const scope = { sourceKind: 'byoa' as const, sourceId: `byoa:${c.id}`, engine: str(e.id), ...(profile ? { profileId: str(profile.id) } : {}) }
      add({ scopeType: 'computer', scopeId: c.id, domain: 'byoa', slot, purpose: identity(str(e.id), profile ? str(profile.id) : ''),
        targets: { primary: model ? target(model, scope) : { kind: 'engine-default', ...scope }, fallbacks: null, direct: [] },
        parameters: { origin: profile ? 'provider_profile' : defaults[key] ? 'engine_defaults' : 'cli-default' }, fallbackPolicy: 'byoa-only' })
    }
  }
  for (const a of input.agents) {
    const computer = input.computers.find(c => c.id === a.computer_id && c.company_id === a.company_id)
    const byoa = !!computer && computer.kind !== 'cloud'
    const mc = parseAgentModelConfig(a.model_config)
    const scope = byoa ? { sourceKind: 'byoa' as const, sourceId: `byoa:${computer.id}`, engine: a.engine ?? '', ...(a.provider_profile ? { profileId: a.provider_profile } : {}) } : {}
    add({ scopeType: 'agent', scopeId: a.id, domain: byoa ? 'byoa' : 'managed', slot: 'brain', purpose: '',
      targets: { primary: target(a.model ?? '', scope), fallbacks: mc?.fallbackModels?.map(m => target(m, scope)) ?? null, direct: [] },
      parameters: { ...mc, origin: 'participants', companyId: a.company_id, providerProfile: a.provider_profile }, fallbackPolicy: byoa ? 'byoa-only' : 'legacy' })
    if (byoa) add({ scopeType: 'agent', scopeId: a.id, domain: 'byoa', slot: 'engine_fast', purpose: '',
      targets: { primary: target(a.fast_model ?? '', scope), fallbacks: null, direct: [] }, parameters: {}, fallbackPolicy: 'byoa-only' })
    if (mc?.cerebellumModel) add({ scopeType: 'agent', scopeId: a.id, domain: 'server', slot: 'support', purpose: '',
      targets: { primary: target(mc.cerebellumModel), fallbacks: null, direct: [] }, parameters: { origin: 'cerebellumModel' }, fallbackPolicy: 'legacy' })
  }
  return out
}
