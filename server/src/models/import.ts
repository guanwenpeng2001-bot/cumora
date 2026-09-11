import type { PoolClient } from 'pg'
import type { Capability, ModelOffering } from '../../../shared/model-contract.js'
import { detectNativePlatform } from '../sub2api.js'
import { parseLlmConfig, readLlmModelTarget } from '../settings.js'
import { importBindings } from './bindings.js'
import { credentialReferences } from './credentials.js'
import { identity, record, revision, str, type Inventory } from './inventory.js'
import { platformMapping } from './sources/sub2api.js'
import { computerAvailability, engineInventories } from './sources/byoa.js'

export function buildModelImport(input: Inventory) {
  const mapping = platformMapping(input)
  const sources = [{ id: 'sub2api', kind: 'sub2api', scope_company_id: null as string | null, computer_id: null as string | null,
    config: { platformGroups: mapping.platformGroups, mappingConflicts: mapping.conflicts } as Record<string, unknown>, enabled: true }]
  sources.push(...input.direct.map(d => ({ id: `env:${d.slot}`, kind: 'env', scope_company_id: null, computer_id: null,
    config: { slot: d.slot, keyRef: d.keyRef, endpointRef: d.endpointRef, modelRefs: d.modelRefs }, enabled: true })))
  sources.push(...input.computers.filter(c => c.kind !== 'cloud').map(c => ({ id: `byoa:${c.id}`, kind: 'byoa', scope_company_id: c.company_id,
    computer_id: c.id, config: {}, enabled: !c.revoked_at })))
  const offerings = new Map<string, ModelOffering & { scopeKey: string; origin: string }>()
  const bindings = importBindings(input)
  function add(sourceId: string, provider: string, platform: string, model: string, protocol: string, capability: Capability, scopeKey = '', engine?: string, profileId?: string, origin = 'configured-unverified') {
    if (!model || /[*?]/.test(model)) return
    const source = sources.find(s => s.id === sourceId)!
    const id = identity('offering', sourceId, scopeKey, platform, model, protocol)
    const old = offerings.get(id)
    if (old) {
      if (!old.capabilities.includes(capability)) old.capabilities.push(capability)
      if (old.providerId === 'unknown' && provider !== 'unknown') {
        old.providerId = provider; old.provider = provider; old.logicalModelId = identity('model', provider, model)
      } else if (provider !== 'unknown' && old.providerId !== provider) {
        old.providerId = 'unknown'; old.provider = 'unknown'; old.logicalModelId = identity('model', 'unknown', model)
        old.availability.reasonCodes.push('provider-conflict')
      }
      return
    }
    const computer = input.computers.find(c => c.id === source.computer_id)
    const direct = input.direct.find(d => sourceId === `env:${d.slot}`)
    const metadata = config.models.find(m => m.model === model)
    offerings.set(id, { id, sourceId, sourceKind: source.kind as ModelOffering['sourceKind'], providerId: provider, provider,
      platform, logicalModelId: identity('model', provider, model), requestModel: model, protocol, capabilities: [capability],
      features: { ...(metadata?.tools !== undefined ? { tools: metadata.tools } : {}), ...(metadata?.vision !== undefined ? { vision: metadata.vision } : {}) },
      execution: computer ? { location: 'computer', computerId: computer.id, engine, profileId,
        inferenceLocation: !profileId && ['codex', 'claude', 'kimi', 'grok', 'gemini'].includes(engine ?? '') ? 'remote' : 'unknown' } : { location: 'server', inferenceLocation: 'remote' },
      availability: computer ? computerAvailability(computer) : { configured: direct ? direct.configured : !!mapping.platformGroups[platform], enabled: true,
        health: 'unverified', entitlement: 'unknown', schedulable: false, reasonCodes: ['shadow-only', 'capability-unverified', ...(direct && !direct.configured ? ['env-unconfigured'] : [])] },
      price: { state: computer ? 'external' : 'unpriced', reason: computer ? 'byoa-external-billing' : 'pricing-not-imported-wave-a' },
      catalogRevision: '', scopeKey, origin })
  }
  const config = parseLlmConfig(input.settings.llm_config ?? '')
  // Only the models explicitly assigned to a direct slot may enter that endpoint.
  for (const d of input.direct) {
    const explicit = config.models.filter(m => config.routes.some(r => r.id === m.route && r.kind === 'direct' && r.env === d.slot)).map(m => ({ model: m.model, protocol: m.protocol }))
    for (const b of bindings.filter(b => b.domain !== 'byoa')) for (const t of [b.targets.primary, ...b.targets.fallbacks ?? []]) {
      if (!t.requestModel) continue
      const translated = readLlmModelTarget(t.requestModel, config)
      if (translated.route?.kind === 'direct' && translated.route.env === d.slot) explicit.push({ model: t.requestModel, protocol: translated.protocol ?? translated.route.protocol })
    }
    for (const role of config.roles) for (const t of role.directTargets ?? []) if (config.routes.some(r => r.id === t.route && r.env === d.slot)) explicit.push({ model: t.model, protocol: t.protocol })
    for (const entry of [...d.models.map(model => ({ model, protocol: d.protocol })), ...explicit]) {
      const translated = readLlmModelTarget(entry.model, config)
      add(`env:${d.slot}`, d.provider, d.provider, translated.requestModel, entry.protocol ?? d.protocol,
        d.slot === 'embed' ? 'embed' : d.slot === 'image' ? 'image' : d.slot === 'audio' ? 'audio' : 'text')
    }
  }
  const gatewayNames = new Map<string, Capability>()
  for (const b of bindings.filter(b => b.domain !== 'byoa')) for (const t of [b.targets.primary, ...b.targets.fallbacks ?? []]) {
    if (t.requestModel) gatewayNames.set(t.requestModel, ['image', 'audio', 'embed'].includes(b.slot) ? b.slot as Capability : 'text')
  }
  for (const m of config.models) if (!gatewayNames.has(m.model)) gatewayNames.set(m.model, 'text')
  for (const [name, capability] of gatewayNames) {
    const translated = readLlmModelTarget(name, config)
    if (translated.route?.kind === 'direct') continue
    const platform = translated.route?.platform ?? detectNativePlatform(translated.requestModel) ?? 'openai'
    add('sub2api', 'unknown', platform, translated.requestModel, translated.protocol ?? (capability === 'embed' ? 'embeddings' : capability === 'image' ? 'images' : 'responses'), capability)
  }
  for (const account of input.gateway?.accounts ?? []) {
    const groups = Array.isArray(account.group_ids) ? account.group_ids : []
    for (const [platform, group] of Object.entries(mapping.platformGroups)) {
      if (!groups.includes(group)) continue
      for (const model of Array.isArray(account.models) ? account.models : []) {
        if (typeof model !== 'string') continue
        add('sub2api', str(account.provider) || 'unknown', platform, model, 'responses', 'text', '', undefined, undefined, 'account-mapping-unverified')
      }
      if (account.status === 'error' || account.schedulable === false) for (const o of offerings.values()) {
        if (o.sourceKind === 'sub2api' && o.platform === platform) {
          o.availability.health = 'degraded'
          o.availability.reasonCodes.push('gateway-account-unavailable')
        }
      }
    }
  }
  for (const c of input.computers.filter(c => c.kind !== 'cloud')) {
    for (const e of engineInventories(c)) {
      const catalog = record(e.modelCatalog)
      for (const m of Array.isArray(catalog.models) ? catalog.models : []) add(`byoa:${c.id}`, 'unknown', str(e.id), str(record(m).id), 'engine', 'text', identity(str(e.id), ''), str(e.id), undefined, `byoa-${str(catalog.source) || 'reported'}`)
    }
    for (const b of bindings.filter(b => b.domain === 'byoa')) for (const t of [b.targets.primary, ...b.targets.fallbacks ?? []]) {
      if (t.sourceId === `byoa:${c.id}` && t.requestModel) add(t.sourceId, 'unknown', t.engine ?? '', t.requestModel, 'engine', 'text', identity(t.engine ?? '', t.profileId ?? ''), t.engine, t.profileId)
    }
  }
  const aliases: Array<{ source_id: string; scope_key: string; platform: string; alias: string; protocol: string; offering_id: string }> = []
  for (const b of bindings) {
    for (const t of [b.targets.primary, ...b.targets.fallbacks ?? [], ...b.targets.direct]) {
      if (!t.requestModel) continue
      const translated = b.domain === 'byoa' ? { requestModel: t.requestModel, route: undefined, protocol: undefined } : readLlmModelTarget(t.requestModel, config)
      const matches = [...offerings.values()].filter(o => o.requestModel === translated.requestModel
        && (t.sourceId ? o.sourceId === t.sourceId : o.sourceKind !== 'byoa')
        && (!t.engine || o.execution.engine === t.engine) && (o.execution.profileId ?? '') === (t.profileId ?? '')
        && (!t.protocol || o.protocol === t.protocol)
        && (!translated.route || (translated.route.kind === 'direct' ? o.sourceId === `env:${translated.route.env}` : o.sourceKind === 'sub2api' && (!translated.route.platform || o.platform === translated.route.platform))))
      if (matches.length === 1) {
        t.offeringId = matches[0].id; t.logicalModelId = matches[0].logicalModelId; t.state = 'resolved'
        if (translated.requestModel !== t.requestModel) aliases.push({ source_id: matches[0].sourceId, scope_key: matches[0].scopeKey, platform: matches[0].platform, alias: t.requestModel, protocol: matches[0].protocol, offering_id: matches[0].id })
      }
    }
    b.revision = revision({ ...b, revision: undefined })
  }
  return { sources: sources.map(s => ({ ...s, revision: revision(s) })), offerings: [...offerings.values()], bindings,
    aliases: [...new Map(aliases.map(a => [JSON.stringify(a), a])).values()], credentials: credentialReferences(input.credentials), mapping }
}

/** Atomic, repeatable projection. Only Wave A tables are writable here; old facts remain authoritative. */
export async function persistModelImport(client: Pick<PoolClient, 'query'>, data: ReturnType<typeof buildModelImport>): Promise<void> {
  const upsert = async (table: string, row: Record<string, unknown>, key = 'id') => {
    const columns = Object.keys(row), updates = columns.filter(c => c !== key)
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})
      ON CONFLICT (${key}) DO UPDATE SET ${updates.map(c => `${c}=EXCLUDED.${c}`).join(',')}
      WHERE (${updates.map(c => `${table}.${c}`).join(',')}) IS DISTINCT FROM (${updates.map(c => `EXCLUDED.${c}`).join(',')})`,
    columns.map(c => row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]))
  }
  for (const s of data.sources) await upsert('model_sources', s)
  const definitions = new Map<string, { provider: string; model: string; origins: Set<string> }>()
  for (const o of data.offerings) {
    const d = definitions.get(o.logicalModelId) ?? { provider: o.providerId, model: o.requestModel, origins: new Set<string>() }
    d.origins.add(o.origin); definitions.set(o.logicalModelId, d)
  }
  for (const [id, d] of definitions) await upsert('model_definitions', { id, provider_id: d.provider, canonical_name: d.model, display_name: d.model, metadata: { origins: [...d.origins].sort() } })
  for (const o of data.offerings) {
    await upsert('model_offerings', { id: o.id, source_id: o.sourceId, model_id: o.logicalModelId, platform: o.platform, request_model: o.requestModel, protocol: o.protocol, scope_key: o.scopeKey,
      capabilities: o.capabilities, features: o.features, limits: {}, engine: o.execution.engine ?? null, profile: o.execution.profileId ?? null,
      enabled: o.availability.enabled, discovery_state: o.availability, metadata_origin: o.origin, observed_at: o.availability.observedAt ?? null,
      expires_at: o.availability.expiresAt ?? null, revision: revision({ ...o, catalogRevision: undefined }) })
  }
  for (const a of data.aliases) await client.query(`INSERT INTO model_aliases(source_id,scope_key,platform,alias,protocol,offering_id) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT(source_id,scope_key,platform,alias,protocol) DO UPDATE SET offering_id=EXCLUDED.offering_id WHERE model_aliases.offering_id IS DISTINCT FROM EXCLUDED.offering_id`, Object.values(a))
  for (const b of data.bindings) await upsert('model_bindings', { id: b.id, scope_type: b.scopeType, scope_id: b.scopeId, domain: b.domain, slot: b.slot, purpose: b.purpose,
    targets: b.targets, parameters: b.parameters, fallback_policy: b.fallbackPolicy, revision: b.revision })
  for (const c of data.credentials) await upsert('model_credentials', c)
}
