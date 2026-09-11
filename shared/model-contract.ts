/** Wave A is a read-only inventory. Availability is never an execution grant. */
export type SourceKind = 'sub2api' | 'env' | 'byoa'
export type Capability = 'text' | 'image' | 'audio' | 'embed' | 'video'
export type ModelDomain = 'server' | 'managed' | 'byoa'
export interface ModelOffering {
  id: string; sourceId: string; sourceKind: SourceKind
  providerId: string; provider: string; publisherId?: string
  platform: string; logicalModelId: string; requestModel: string; protocol: string
  capabilities: Capability[]
  features: { tools?: boolean; vision?: boolean; streaming?: boolean; reasoningEfforts?: string[] }
  execution: { location: 'server' | 'computer'; computerId?: string; engine?: string; profileId?: string; inferenceLocation: 'remote' | 'local' | 'unknown' }
  availability: { configured: boolean; enabled: boolean; health: string; entitlement: string; schedulable: boolean; reasonCodes: string[]; observedAt?: string; expiresAt?: string }
  price: { versionId?: string; state: 'priced' | 'unpriced' | 'external' | 'free'; reason?: string }
  catalogRevision: string
}
export interface ModelTarget {
  kind: 'model' | 'inherit' | 'engine-default'
  requestModel?: string; offeringId?: string; logicalModelId?: string
  sourceKind?: SourceKind; sourceId?: string; platform?: string; protocol?: string
  engine?: string; profileId?: string; state?: 'resolved' | 'unresolved'
}
export interface ModelBinding {
  id: string; scopeType: 'server' | 'company' | 'computer' | 'agent'; scopeId: string
  domain: ModelDomain; slot: string; purpose: string
  targets: { primary: ModelTarget; fallbacks: ModelTarget[] | null; direct: ModelTarget[] }
  parameters: Record<string, unknown>; fallbackPolicy: string; revision: string
}
export interface ModelCatalogDTO {
  mode: 'shadow'; offerings: ModelOffering[]; bindings: ModelBinding[]
  catalogRevision: string; entitlementRevision: string; diagnostics: string[]
}
export function assertModelCatalog(value: ModelCatalogDTO): void {
  if (value.mode !== 'shadow' || !value.catalogRevision || !Array.isArray(value.bindings)) throw new Error('Invalid catalog')
  for (const o of value.offerings) {
    if (!o.id || !['sub2api', 'env', 'byoa'].includes(o.sourceKind) || !o.provider || !o.platform
      || !o.protocol || !Array.isArray(o.capabilities) || !o.availability || typeof o.availability.schedulable !== 'boolean'
      || !['priced', 'unpriced', 'external', 'free'].includes(o.price.state) || o.catalogRevision !== value.catalogRevision
      || !['server', 'computer'].includes(o.execution.location)) throw new Error('Invalid model offering')
  }
}
