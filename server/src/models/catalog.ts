import type { ModelBinding, ModelCatalogDTO, ModelDomain, ModelOffering, Capability } from '../../../shared/model-contract.js'
import { assertModelCatalog } from '../../../shared/model-contract.js'
import { pool } from '../db/pool.js'
import { TenantLlmAccessError } from '../tenant-llm-context.js'
import { parseApiKeyMap } from '../sub2api.js'
import { revision, type ComputerInventory } from './inventory.js'
import { computerAvailability } from './sources/byoa.js'
import { resolveDirectLlmEnv, type DirectLlmSlot } from '../env.js'

export interface CatalogQuery { domain?: ModelDomain; computerId?: string; engine?: string; profileId?: string; capability?: Capability }
export function filterCatalog(offerings: ModelOffering[], query: CatalogQuery): ModelOffering[] {
  return offerings.filter(o => (!query.domain || (query.domain === 'byoa' ? o.sourceKind === 'byoa' : o.sourceKind !== 'byoa'))
    && (!query.computerId || o.execution.computerId === query.computerId)
    && (!query.engine || o.execution.engine === query.engine)
    && (query.profileId === undefined || (o.execution.profileId ?? '') === query.profileId)
    && (!query.capability || o.capabilities.includes(query.capability)))
}
/** Read committed membership and scope in one snapshot. No gateway request can block env inventory. */
export async function modelCatalog(userId: string, companyId: string, query: CatalogQuery = {}): Promise<ModelCatalogDTO> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const { rows: owners } = await client.query(`SELECT u.id, u.xmin::text AS revision, u.sub2api_api_key FROM companies c JOIN users u ON u.id=c.owner_user_id
      WHERE c.id=$1 AND EXISTS(SELECT 1 FROM company_members WHERE company_id=c.id AND user_id=$2)`, [companyId, userId])
    if (!owners.length) throw new TenantLlmAccessError('Company not found or access denied')
    const computers = (await client.query<ComputerInventory>('SELECT id, company_id, kind, status, last_seen_at, revoked_at FROM computers WHERE company_id=$1', [companyId])).rows
    if (query.computerId && !computers.some(c => c.id === query.computerId && !c.revoked_at)) throw new TenantLlmAccessError('Computer not found or access denied')
    const keys = parseApiKeyMap(owners[0].sub2api_api_key)
    const rows = (await client.query(`SELECT o.*, s.kind, s.computer_id, s.enabled AS source_enabled, s.config, s.revision AS source_revision, d.provider_id
      FROM model_offerings o JOIN model_sources s ON s.id=o.source_id JOIN model_definitions d ON d.id=o.model_id
      WHERE (s.scope_company_id IS NULL OR s.scope_company_id=$1)
        AND (s.kind <> 'byoa' OR EXISTS(SELECT 1 FROM computers c WHERE c.id=s.computer_id AND c.company_id=$1 AND c.revoked_at IS NULL)) ORDER BY o.id`, [companyId])).rows
    const bindings = (await client.query(`SELECT b.* FROM model_bindings b WHERE b.scope_type='server'
      OR (b.scope_type='company' AND b.scope_id=$1)
      OR (b.scope_type='computer' AND EXISTS(SELECT 1 FROM computers c WHERE c.id=b.scope_id AND c.company_id=$1 AND c.revoked_at IS NULL))
      OR (b.scope_type='agent' AND EXISTS(SELECT 1 FROM participants p WHERE p.id=b.scope_id AND p.company_id=$1 AND p.kind='agent' AND p.departed_at IS NULL)) ORDER BY b.id`, [companyId])).rows
      .map((b): ModelBinding => ({ id: b.id, scopeType: b.scope_type, scopeId: b.scope_id, domain: b.domain, slot: b.slot, purpose: b.purpose,
        targets: b.targets, parameters: b.parameters, fallbackPolicy: b.fallback_policy, revision: b.revision }))
      .filter(b => (!query.domain || b.domain === query.domain || b.scopeType === 'server' && query.domain !== 'byoa')
        && (!query.computerId || b.scopeType === 'computer' && b.scopeId === query.computerId || b.targets.primary.sourceId === `byoa:${query.computerId}`)
        && (!query.engine || b.targets.primary.engine === query.engine)
        && (query.profileId === undefined || (b.targets.primary.profileId ?? '') === query.profileId)
        && (!query.capability || (['image', 'audio', 'embed'].includes(b.slot) ? b.slot : 'text') === query.capability))
    const offerings = rows.map((r): ModelOffering => {
      let availability: ModelOffering['availability'] = { ...r.discovery_state, enabled: r.enabled && r.source_enabled, schedulable: false }
      if (r.kind === 'byoa') availability = { ...computerAvailability(computers.find(c => c.id === r.computer_id)!), enabled: availability.enabled }
      if (r.kind === 'env') {
        const direct = resolveDirectLlmEnv(r.config.slot as DirectLlmSlot)
        availability.configured = direct.configured
        availability.reasonCodes = [...new Set([...availability.reasonCodes.filter(v => v !== 'env-unconfigured'), ...(!direct.configured ? ['env-unconfigured'] : [])])]
      }
      if (r.kind === 'sub2api' && !keys[r.platform]) {
        availability.entitlement = 'unknown'; availability.reasonCodes = [...new Set([...availability.reasonCodes, 'owner-platform-credential-missing'])]
      }
      return { id: r.id, sourceId: r.source_id, sourceKind: r.kind, providerId: r.provider_id, provider: r.provider_id, platform: r.platform,
        logicalModelId: r.model_id, requestModel: r.request_model, protocol: r.protocol, capabilities: r.capabilities, features: r.features,
        execution: r.kind === 'byoa' ? { location: 'computer', computerId: r.computer_id, engine: r.engine, ...(r.profile ? { profileId: r.profile } : {}),
          inferenceLocation: !r.profile && ['codex', 'claude', 'kimi', 'grok', 'gemini'].includes(r.engine) ? 'remote' : 'unknown' } : { location: 'server', inferenceLocation: 'remote' }, availability,
        price: { state: r.kind === 'byoa' ? 'external' : 'unpriced', reason: r.kind === 'byoa' ? 'byoa-external-billing' : 'pricing-not-imported-wave-a' }, catalogRevision: '' }
    })
    const selected = filterCatalog(offerings, query)
    const entitlementRevision = revision([companyId, owners[0].id, owners[0].revision])
    const catalogRevision = revision([query, entitlementRevision, selected, bindings, rows.map(r => r.source_revision)])
    for (const o of selected) o.catalogRevision = catalogRevision
    const result: ModelCatalogDTO = { mode: 'shadow', offerings: selected, bindings, catalogRevision, entitlementRevision,
      diagnostics: ['shadow-only', 'legacy-execution-authoritative', ...(rows.length ? [] : ['inventory-not-imported'])] }
    assertModelCatalog(result)
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
