import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildModelImport } from '../models/import.js'
import { importBindings } from '../models/bindings.js'
import { filterCatalog } from '../models/catalog.js'
import { endpointProvider } from '../models/sources/env.js'
import { computerAvailability } from '../models/sources/byoa.js'
import { platformMapping } from '../models/sources/sub2api.js'
import { modelHubFixture } from './model-hub-fixture.js'
import { runShadowAudit } from '../scripts/model-hub-shadow.js'
import { assertModelCatalog, type ModelCatalogDTO } from '../../../shared/model-contract.js'
import { shadowCandidates } from '../models/shadow.js'
import { matchLegacyCredentialIds } from '../models/credentials.js'

test('catalog DTO separates gateway/env/BYOA identity, provider and execution; no secret in projection', () => {
  const input = modelHubFixture(), data = buildModelImport(input)
  const offerings = data.offerings.map(o => ({ ...o, catalogRevision: 'revision-1' }))
  const dto: ModelCatalogDTO = { mode: 'shadow', offerings, bindings: data.bindings, catalogRevision: 'revision-1', entitlementRevision: 'owner-1', diagnostics: [] }
  assertModelCatalog(dto)
  assert.equal(offerings.filter(o => o.requestModel === 'gpt-6-astra').length, 2)
  assert.equal(offerings.filter(o => o.requestModel === 'deepseek-v4-flash').length, 2)
  assert.equal(offerings.find(o => o.sourceId === 'env:novita')?.provider, 'deepseek')
  assert.equal(offerings.find(o => o.execution.engine === 'codex')?.execution.inferenceLocation, 'remote')
  assert(offerings.every(o => !o.availability.schedulable && !!o.price.state))
  assert.equal(offerings.find(o => o.sourceKind === 'sub2api' && o.platform === 'kimi')?.availability.health, 'degraded')
  assert.equal(data.credentials[0].key_id, 42)
  assert.match(data.credentials[0].secret_ref, /^users\/user-a\/sub2api_api_key\/openai$/)
  assert.equal(endpointProvider('https://api.deepseek.com/v1'), 'deepseek')
  assert.equal(endpointProvider('https://api.deepseek.com.evil.invalid/v1'), 'unknown')
  assert.throws(() => assertModelCatalog({ ...dto, offerings: [{ ...offerings[0], price: {} } as never] }))
})

test('empty DB brain fallback remains explicitly empty; agent absent inherits and profile namespace stays separate', () => {
  const input = modelHubFixture(), bindings = importBindings(input)
  assert.deepEqual(bindings.find(b => b.scopeType === 'server' && b.slot === 'brain')?.targets.fallbacks, [])
  assert.equal(bindings.find(b => b.scopeId === 'test-codex-01' && b.slot === 'brain')?.targets.fallbacks, null)
  assert.deepEqual(bindings.find(b => b.scopeId === 'atlas-4b42')?.targets.fallbacks?.map(t => t.requestModel), ['k3'])
  const data = buildModelImport(input)
  const local = filterCatalog(data.offerings, { domain: 'byoa', computerId: 'computer-a', engine: 'codex', profileId: 'custom', capability: 'text' })
  assert.deepEqual(local.map(o => o.requestModel).sort(), ['private-fast', 'private-model'])
  assert(filterCatalog(data.offerings, { domain: 'server' }).every(o => o.sourceKind !== 'byoa'))
  assert.equal(filterCatalog(data.offerings, { computerId: 'another-company' }).length, 0)
})

test('conflicting tier group references stay unresolved without rewriting tiers or groups', () => {
  const input = modelHubFixture()
  input.tierGroups.free.openai = 2
  const mapping = platformMapping(input)
  assert.equal(mapping.platformGroups.openai, undefined)
  assert.deepEqual(mapping.conflicts.openai, [2, 15])
  assert.equal(input.users[0].tier, 'pro')
})

test('legacy platform credential preserves remote key id by exact user/key match without exporting secret material', () => {
  const c = { ...modelHubFixture().credentials[0], keyId: null }
  const result = matchLegacyCredentialIds([c], [{ id: 'user-a', sub2api_api_key: 'fixture-secret' }],
    [{ id: 41, user_id: 3, key: 'fixture-secret' }, { id: 42, user_id: 4, key: 'fixture-secret' }])
  assert.equal(result[0].keyId, 42)
  assert(!JSON.stringify(result).includes('fixture-secret'))
  assert.equal(matchLegacyCredentialIds([c], [{ id: 'user-a', sub2api_api_key: 'different' }], [{ id: 42, user_id: 4, key: 'fixture-secret' }])[0].keyId, null)
})

test('BYOA grace is bounded and revocation immediate; catalog never grants execution', () => {
  const computer = modelHubFixture().computers[0]
  const seen = Date.parse(computer.last_seen_at!)
  assert.equal(computerAvailability({ ...computer, status: 'offline' }, seen + 119_000).health, 'stale')
  assert.equal(computerAvailability(computer, seen + 120_000).health, 'offline')
  assert.equal(computerAvailability({ ...computer, revoked_at: new Date(seen).toISOString() }, seen + 1).health, 'revoked')
})

test('unbound BYOA model inherits its computer default and never the server fallback namespace', () => {
  const input = modelHubFixture()
  input.agents[1].model = null
  input.settings.brain_fallback_models = 'cloud-only-fallback'
  const data = buildModelImport(input)
  const b = data.bindings.find(b => b.scopeId === 'test-codex-01' && b.slot === 'brain')!
  assert.deepEqual(shadowCandidates(data, b).map(c => c.requestModel), ['gpt-6-astra'])
})

test('shadow compares actual legacy resolver and available buckets: four gateways, env, local Codex and both named agents', async () => {
  const result = await runShadowAudit(modelHubFixture())
  assert.deepEqual(result.coverage.gatewayPlatforms.sort(), ['deepseek', 'grok', 'kimi', 'openai'])
  assert(result.coverage.directSlots.includes('env:text'))
  assert(result.coverage.localCodex.length > 0)
  assert.deepEqual(result.coverage.agents.sort(), ['atlas-4b42', 'test-codex-01'])
  const atlas = result.comparisons.find(c => c.agentId === 'atlas-4b42')!
  assert.deepEqual([...new Set(atlas.newCandidates.map(c => c.model))], ['deepseek-v4-pro', 'k3'])
  const codex = result.comparisons.find(c => c.agentId === 'test-codex-01')!
  assert(codex.newCandidates.some(c => c.requestModel === 'gpt-6-astra' && c.source === 'byoa'))
  assert(codex.legacyDiagnostics.includes('byoa-engine-managed'))
  assert.equal(result.networkRequests, 0)
  // Deliberately no equality assertion: shadow differences are evidence for the next wave.
})
