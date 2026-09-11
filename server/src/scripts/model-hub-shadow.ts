import { mock } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { refreshServerSettings, type LlmRole } from '../settings.js'
import { resolveRoleCall } from '../llm-resolver.js'
import { availableModels } from '../models-catalog.js'
import { invalidateTenantModelSnapshot } from '../tenant-llm-context.js'
import { buildModelImport } from '../models/import.js'
import { compareShadow } from '../models/shadow.js'
import type { Inventory } from '../models/inventory.js'

/** Offline replay against the actual legacy implementations. Every I/O is replaced with audited metadata. */
export async function runShadowAudit(input: Inventory, directory?: string) {
  const data = buildModelImport(input)
  const platforms = [...new Set(data.offerings.filter(o => o.sourceKind === 'sub2api').map(o => o.platform))]
  const keyMap = Object.fromEntries(platforms.map(p => [p, `shadow-${p}`]))
  const gatewayUrl = env.SUB2API_INTERNAL_URL
  env.SUB2API_INTERNAL_URL = 'http://shadow.invalid'
  const queryMock = mock.method(pool, 'query', async (query: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
    const sql = typeof query === 'string' ? query : query.text
    const params = typeof query === 'string' ? values : query.values
    if (sql.includes('server_settings')) return { rows: Object.entries(input.settings).map(([key, value]) => ({ key, value })) }
    if (sql.includes('owner_user_id')) return { rows: [{ owner_user_id: 'shadow-owner', sub2api_api_key: JSON.stringify(keyMap), authorization_version: '1' }] }
    if (sql.includes('detected_engines FROM computers')) return { rows: input.computers.filter(c => c.company_id === params?.[0] && c.kind !== 'cloud' && !c.revoked_at && (!params?.[1] || c.id === params[1])) }
    throw new Error('Unstubbed shadow database query')
  })
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization') ?? ''
    const platform = authorization.replace('Bearer shadow-', '')
    return new Response(JSON.stringify({ data: data.offerings.filter(o => o.sourceKind === 'sub2api' && o.platform === platform).map(o => ({ id: o.requestModel })) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  try {
    invalidateTenantModelSnapshot()
    await refreshServerSettings(true)
    const comparisons = []
    for (const b of data.bindings.filter(b => b.scopeType === 'server' || b.scopeType === 'agent' && b.slot === 'brain')) {
      const agent = input.agents.find(a => a.id === b.scopeId)
      const company = agent?.company_id ?? input.computers[0]?.company_id ?? 'shadow-company'
      const legacyCatalog = await availableModels('shadow-actor', false, company)
      const legacy = await resolveRoleCall(company, b.domain, b.slot as LlmRole, b.purpose || 'agent-turn', agent)
      comparisons.push({ agentId: agent?.id, name: agent?.name ?? `${b.slot}:${b.purpose}`, ...compareShadow(data, b, legacy, legacyCatalog) })
    }
    const result = { mode: 'offline-audited-inventory-replay', networkRequests: 0,
      note: 'Gateway discovery is a metadata fixture, not an upstream health probe. Legacy BYOA main calls delegate to the local engine.',
      coverage: { gatewayPlatforms: platforms, directSlots: [...new Set(data.offerings.filter(o => o.sourceKind === 'env').map(o => o.sourceId))],
        localCodex: data.offerings.filter(o => o.execution.engine === 'codex').map(o => o.id), agents: comparisons.filter(c => /^(atlas-4b42|test-codex-01)$/.test(c.agentId ?? '')).map(c => c.agentId) }, comparisons }
    if (directory) await writeFile(join(directory, 'shadow.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ coverage: result.coverage, comparisons: comparisons.length, differences: comparisons.reduce((n, c) => n + c.differences.length, 0) }))
    return result
  } finally { queryMock.mock.restore(); fetchMock.mock.restore(); env.SUB2API_INTERNAL_URL = gatewayUrl; invalidateTenantModelSnapshot() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const directory = args[args.indexOf('--output') + 1]
  readFile(join(directory, 'inventory.json'), 'utf8').then(raw => runShadowAudit(JSON.parse(raw), directory))
    .catch(() => { console.error('model-hub-shadow failed'); process.exitCode = 1 }).finally(() => pool.end())
}
