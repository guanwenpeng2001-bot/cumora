import type { ModelBinding } from '../../../shared/model-contract.js'
import type { RoleCallPlan } from '../llm-resolver.js'
import type { ModelCatalog } from '../models-catalog.js'
import type { buildModelImport } from './import.js'

/** Diagnostic comparison, never an execution plan. Unresolved choices are retained. */
export function shadowCandidates(data: ReturnType<typeof buildModelImport>, binding: ModelBinding) {
  const scope = binding.targets.primary
  const inherited = binding.domain === 'byoa'
    ? data.bindings.find(b => b.scopeType === 'computer' && b.slot === binding.slot && b.targets.primary.sourceId === scope.sourceId
      && b.targets.primary.engine === scope.engine && (b.targets.primary.profileId ?? '') === (scope.profileId ?? ''))
    : data.bindings.find(b => b.scopeType === 'server' && b.slot === binding.slot && b.purpose === binding.purpose)
      ?? data.bindings.find(b => b.scopeType === 'server' && b.slot === binding.slot && !b.purpose)
  const primary = binding.targets.primary.kind === 'inherit' ? inherited?.targets.primary : binding.targets.primary
  const targets = [primary, ...binding.targets.fallbacks ?? inherited?.targets.fallbacks ?? [], ...binding.targets.direct].filter(t => t?.requestModel)
  const candidates = targets.flatMap(t => {
    const offerings = data.offerings.filter(o => t!.offeringId ? o.id === t!.offeringId : o.requestModel === t!.requestModel
      && (t!.sourceId ? o.sourceId === t!.sourceId : o.sourceKind !== 'byoa')
      && (!t!.engine || o.execution.engine === t!.engine) && (o.execution.profileId ?? '') === (t!.profileId ?? ''))
    return offerings.length ? offerings.map(o => ({ model: t!.requestModel!, requestModel: o.requestModel, source: o.sourceKind, platform: o.platform,
      routeScope: o.sourceKind === 'env' ? o.sourceId : o.sourceKind === 'byoa' ? `${o.sourceId}:${o.scopeKey}` : o.platform, protocol: o.protocol, offeringId: o.id }))
      : [{ model: t!.requestModel!, requestModel: t!.requestModel!, source: 'unresolved', platform: '', routeScope: '', protocol: '', offeringId: '' }]
  })
  // Entire gateway chain precedes direct fallback. Stable sort preserves model order within a source.
  return candidates.sort((a, b) => Number(a.source === 'env') - Number(b.source === 'env'))
}
export function compareShadow(data: ReturnType<typeof buildModelImport>, binding: ModelBinding, legacy: Pick<RoleCallPlan, 'candidates' | 'diagnostics'>, catalog?: ModelCatalog) {
  const current = shadowCandidates(data, binding)
  const old = legacy.candidates.map(c => ({ model: c.model, requestModel: c.requestModel, source: c.route.kind === 'gateway' ? 'sub2api' : 'env', platform: c.route.platform ?? c.route.env ?? '',
    routeScope: c.route.kind === 'gateway' ? c.route.platform ?? '' : `env:${c.route.env}`, protocol: c.protocol }))
  const key = (c: { requestModel: string; source: string; routeScope: string; protocol: string }) => `${c.source}:${c.routeScope}:${c.protocol}:${c.requestModel}`
  const oldKeys = new Set(old.map(key)), newKeys = new Set(current.map(key))
  const differences = [
    ...current.filter(c => !oldKeys.has(key(c))).map(c => ({ kind: 'catalog-only', ...c, reason: 'shadow inventory does not authorize execution' })),
    ...old.filter(c => !newKeys.has(key(c))).map(c => ({ kind: 'legacy-only', ...c, reason: 'legacy route/config inference has no verified offering' })),
  ]
  const oldNames = new Set(catalog ? [...catalog.text, ...catalog.image, ...catalog.audio, ...catalog.embedding] : [])
  return { bindingId: binding.id, newCandidates: current, legacyCandidates: old, differences, orderChanged: JSON.stringify(current.map(key)) !== JSON.stringify(old.map(key)),
    legacyDiagnostics: legacy.diagnostics, missingFromLegacyBuckets: catalog ? current.filter(c => !oldNames.has(c.requestModel)).map(c => c.requestModel) : [] }
}
