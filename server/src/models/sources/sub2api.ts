import { env } from '../../env.js'
import { record, str, type GatewayInventory, type Inventory } from '../inventory.js'

/** A conflicting tier mapping is unresolved; P1 never silently migrates legacy groups. */
export function platformMapping(input: Inventory): { platformGroups: Record<string, number>; conflicts: Record<string, number[]>; legacyOpenaiGroups: number[] } {
  let db: Record<string, unknown> = {}
  try { db = record(JSON.parse(input.settings.sub2api_group_config || '{}')) } catch { /* audited as missing */ }
  const candidates = new Map<string, Set<number>>()
  for (const tier of ['free', 'pro', 'max']) {
    for (const [p, id] of Object.entries({ ...input.tierGroups[tier], ...record(db[tier]) })) {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue
      if (!candidates.has(p)) candidates.set(p, new Set())
      candidates.get(p)!.add(id)
    }
  }
  const platformGroups: Record<string, number> = {}, conflicts: Record<string, number[]> = {}
  for (const [p, ids] of candidates) {
    if (ids.size === 1) platformGroups[p] = [...ids][0]
    else conflicts[p] = [...ids].sort((a, b) => a - b)
  }
  return { platformGroups, conflicts, legacyOpenaiGroups: [...candidates.get('openai') ?? []].filter(id => [2, 3, 4].includes(id)) }
}

/** GET-only adapter. Remote bodies and error text never reach audit artifacts. */
export async function readGatewayInventory(baseURL = env.SUB2API_INTERNAL_URL): Promise<GatewayInventory> {
  const out: GatewayInventory = { groups: [], accounts: [], keys: [], users: [], subscriptions: [], references: [], proxies: [], diagnostics: [] }
  if (!baseURL || !env.SUB2API_ADMIN_KEY) { out.diagnostics.push('gateway-admin-unconfigured'); return out }
  const fields: Record<string, string[]> = {
    groups: ['id', 'name', 'platform', 'status', 'subscription_type', 'deleted_at', 'allow_image_generation', 'daily_limit_usd', 'weekly_limit_usd', 'monthly_limit_usd', 'fallback_group_id', 'fallback_group_id_on_invalid_request'],
    accounts: ['id', 'name', 'platform', 'status', 'schedulable', 'group_ids', 'proxy_id', 'type'],
    users: ['id', 'status', 'balance', 'allowed_groups'],
    proxies: ['id', 'name', 'protocol', 'host', 'port', 'status'],
  }
  async function list(path: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    for (let page = 1; page <= 1000; page++) {
      const response = await fetch(`${baseURL.replace(/\/$/, '')}/api/v1/admin/${path}${path.includes('?') ? '&' : '?'}page=${page}&page_size=100`, { headers: { 'x-api-key': env.SUB2API_ADMIN_KEY }, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`http-${response.status}`)
      const body = record(await response.json()), data = body.data ?? body
      const payload = record(data), items = Array.isArray(data) ? data : payload.items ?? payload.data
      if (!Array.isArray(items)) throw new Error('unknown-list-shape')
      rows.push(...items.map(record))
      if (Array.isArray(data) || items.length < 100 || typeof payload.pages === 'number' && page >= payload.pages) return rows
    }
    throw new Error('pagination-limit')
  }
  for (const entity of ['groups', 'accounts', 'users', 'proxies'] as const) {
    try {
      const rows = await list(entity)
      out[entity] = rows.map(r => Object.fromEntries(fields[entity].filter(k => r[k] !== undefined).map(k => [k, r[k]])))
      if (entity === 'accounts') {
        // Explicit mapping names are discovery evidence, not a proof of capability or price.
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i], credentials = record(r.credentials)
          const mapping = record(credentials.model_mapping ?? record(r.extra).model_mapping)
          out.accounts[i].models = [...new Set([...Object.keys(mapping), ...Object.values(mapping).filter((v): v is string => typeof v === 'string')])]
          out.accounts[i].group_ids = r.group_ids ?? (Array.isArray(r.groups) ? r.groups.map(g => record(g).id) : [])
          // Endpoint is inspected only in memory; credentials and URLs are not exported.
          const { endpointProvider } = await import('./env.js')
          out.accounts[i].provider = endpointProvider(str(credentials.base_url))
        }
      }
    } catch (error) { out.diagnostics.push(`${entity}:${error instanceof Error && /^(http-\d+|unknown-list-shape|pagination-limit)$/.test(error.message) ? error.message : 'unreachable'}`) }
  }
  for (const user of out.users) {
    for (const entity of ['keys', 'subscriptions'] as const) {
      try {
        const rows = await list(`users/${Number(user.id)}/${entity === 'keys' ? 'api-keys' : 'subscriptions'}`)
        const allowed = entity === 'keys' ? ['id', 'user_id', 'group_id', 'status', 'expires_at', 'name']
          : ['id', 'user_id', 'group_id', 'status', 'start_time', 'expire_time', 'daily_window_start', 'weekly_window_start', 'monthly_window_start', 'daily_usage_usd', 'weekly_usage_usd', 'monthly_usage_usd', 'assigned_by']
        out[entity].push(...rows.map(r => ({ ...Object.fromEntries(allowed.filter(k => r[k] !== undefined).map(k => [k, r[k]])), user_id: user.id })))
      } catch { out.diagnostics.push(`${entity}:user-${user.id}:unavailable`) }
    }
  }
  out.references.push(...out.groups.map(g => ({ table: 'groups', id: g.id, fallbackGroupId: g.fallback_group_id, invalidRequestFallbackGroupId: g.fallback_group_id_on_invalid_request })),
    ...out.accounts.map(a => ({ table: 'account_groups', accountId: a.id, groupIds: a.group_ids })),
    ...out.users.map(u => ({ table: 'user_allowed_groups', userId: u.id, groupIds: u.allowed_groups })))
  out.diagnostics.push('admin-api-excludes-some-tombstones-and-financial-references:database-audit-required')
  return out
}
