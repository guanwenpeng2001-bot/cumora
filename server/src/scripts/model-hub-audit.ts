import 'dotenv/config'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { readInventory, record, type GatewayInventory, type Inventory } from '../models/inventory.js'
import { buildModelImport } from '../models/import.js'
import { readGatewayInventory } from '../models/sources/sub2api.js'
import { matchLegacyCredentialIds } from '../models/credentials.js'

const runFile = promisify(execFile)
/** psql only receives SELECTs, each enforced by a read-only transaction. No shell interpolation. */
export function dockerReader(container: string, database: string) {
  const docker = process.platform === 'win32' ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' : 'docker'
  return async (sql: string): Promise<Record<string, unknown>[]> => {
    if (!/^\s*SELECT\b/i.test(sql) || sql.includes(';')) throw new Error('Audit accepts a single SELECT only')
    const { stdout } = await runFile(docker, ['exec', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
      '-c', `BEGIN READ ONLY; SELECT COALESCE(json_agg(a), '[]') FROM (${sql}) a; COMMIT;`], { maxBuffer: 32 * 1024 * 1024 })
    return JSON.parse(stdout.trim())
  }
}
/** Direct DB adapter includes tombstones and all discovered scalar/array group reference columns. */
export async function readGatewayDatabase(read: (sql: string) => Promise<Record<string, unknown>[]>): Promise<GatewayInventory> {
  const out: GatewayInventory = { groups: [], accounts: [], keys: [], users: [], subscriptions: [], references: [], proxies: [], diagnostics: [] }
  const tables: Record<string, string[]> = {
    groups: ['id', 'name', 'platform', 'status', 'subscription_type', 'deleted_at', 'allow_image_generation', 'daily_limit_usd', 'weekly_limit_usd', 'monthly_limit_usd', 'fallback_group_id', 'fallback_group_id_on_invalid_request'],
    accounts: ['id', 'name', 'platform', 'status', 'schedulable', 'proxy_id', 'deleted_at', 'type'],
    api_keys: ['id', 'user_id', 'group_id', 'name', 'status', 'expires_at', 'deleted_at'],
    users: ['id', 'status', 'balance', 'deleted_at'],
    user_subscriptions: ['id', 'user_id', 'group_id', 'status', 'start_time', 'expire_time', 'daily_window_start', 'weekly_window_start', 'monthly_window_start', 'daily_usage_usd', 'weekly_usage_usd', 'monthly_usage_usd', 'assigned_by', 'deleted_at'],
    proxies: ['id', 'name', 'protocol', 'host', 'port', 'status', 'deleted_at'],
  }
  for (const [table, fields] of Object.entries(tables)) {
    const rows = await read(`SELECT ${fields.map(f => `to_jsonb(t)->'${f}' AS "${f}"`).join(',')} FROM ${table} t ORDER BY id`)
    const key = table === 'api_keys' ? 'keys' : table === 'user_subscriptions' ? 'subscriptions' : table
    Object.assign(out, { [key]: rows })
  }
  const mappings = await read(`SELECT id, credentials->'model_mapping' AS mapping, credentials->>'base_url' AS endpoint FROM accounts`)
  const accountGroups = await read('SELECT account_id, group_id FROM account_groups')
  const { endpointProvider } = await import('../models/sources/env.js')
  for (const a of out.accounts) {
    const mapping = mappings.find(m => m.id === a.id)
    a.models = [...new Set([...Object.keys(record(mapping?.mapping)), ...Object.values(record(mapping?.mapping)).filter(v => typeof v === 'string')])]
    a.provider = endpointProvider(typeof mapping?.endpoint === 'string' ? mapping.endpoint : '')
    a.group_ids = accountGroups.filter(g => g.account_id === a.id).map(g => g.group_id)
  }
  const columns = await read(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND (column_name LIKE '%group_id%' OR column_name IN ('allowed_groups','composite_model_routes')) ORDER BY table_name,column_name`)
  for (const col of columns) {
    const table = String(col.table_name), column = String(col.column_name)
    if (!/^[a-z_][a-z0-9_]*$/.test(table) || !/^[a-z_][a-z0-9_]*$/.test(column)) continue
    const refs = await read(`SELECT to_jsonb(t)->'${column}' AS reference, COUNT(*)::int AS count FROM "${table}" t WHERE to_jsonb(t)->'${column}' <> 'null'::jsonb GROUP BY to_jsonb(t)->'${column}'`)
    out.references.push({ table, column, values: refs })
  }
  return out
}
export function auditSummary(input: Inventory) {
  const data = buildModelImport(input)
  const names = new Map<string, string[]>()
  for (const o of data.offerings) names.set(o.requestModel, [...names.get(o.requestModel) ?? [], o.id])
  const remoteIds = new Set(input.users.map(u => Number(u.remoteUserId)).filter(Boolean))
  const managedKeys = new Set(input.credentials.map(c => c.keyId).filter(Boolean))
  const gateway = input.gateway
  const externalRecords = gateway ? {
    users: gateway.users.filter(u => !remoteIds.has(Number(u.id))),
    keys: gateway.keys.filter(k => !remoteIds.has(Number(k.user_id)) || !managedKeys.has(Number(k.id))).map(k => ({ ...k, reason: remoteIds.has(Number(k.user_id)) ? 'ownership-unverified' : 'external-user' })),
    subscriptions: gateway.subscriptions.map(s => ({ ...s, ownership: remoteIds.has(Number(s.user_id)) ? 'manual-or-legacy-unverified' : 'external-user' })),
  } : null
  return { counts: { roles: data.bindings.filter(b => b.scopeType === 'server').length, agents: input.agents.length, computers: input.computers.length,
    sources: data.sources.length, offerings: data.offerings.length, bindings: data.bindings.length, credentials: data.credentials.length,
    groups: gateway?.groups.length ?? 0, accounts: gateway?.accounts.length ?? 0, proxies: gateway?.proxies.length ?? 0 },
    platformMapping: data.mapping, proposedLegacyOpenaiMapping: { '2': 15, '3': 15, '4': 15, state: 'audit-only-no-mutation' },
    ambiguousModels: [...names].filter(([, ids]) => ids.length > 1).map(([model, offerings]) => ({ model, offerings })),
    unresolvedBindings: data.bindings.flatMap(b => [b.targets.primary, ...b.targets.fallbacks ?? [], ...b.targets.direct].filter(t => t.state === 'unresolved').map(t => ({ bindingId: b.id, target: t }))),
    externalRecords, entitlementWindows: input.users.map(u => ({ ...u, subscriptions: gateway?.subscriptions.filter(s => Number(s.user_id) === Number(u.remoteUserId)) ?? [], state: 'pending-policy-import' })),
    missingQuotas: input.users.map(u => ({ userId: u.id, tier: u.tier, state: 'pending', reason: 'cumora-tier-quota-not-configured; subscription-windows-preserved-separately' })),
    diagnostics: gateway?.diagnostics ?? ['gateway-not-audited'] }
}
export async function main() {
  const args = process.argv.slice(2), arg = (name: string) => args[args.indexOf(name) + 1]
  if (!args.includes('--read-only') || !args.includes('--output')) throw new Error('Required: --read-only --output <directory>')
  const directory = resolve(arg('--output'))
  if (directory === process.cwd() || directory.startsWith(`${process.cwd()}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Audit output must be outside repository')
  let inventory: Inventory
  if (args.includes('--docker-postgres')) {
    const read = dockerReader(arg('--docker-postgres'), args.includes('--database') ? arg('--database') : 'cumora')
    inventory = await readInventory({ query: async (sql: string) => ({ rows: await read(sql) }) } as Pick<PoolClient, 'query'>)
    const gatewayRead = dockerReader(arg('--docker-postgres'), 'sub2api')
    inventory.gateway = await readGatewayDatabase(gatewayRead)
    const users = await read('SELECT id, sub2api_api_key FROM users') as Array<{ id: string; sub2api_api_key: string | null }>
    const keys = await gatewayRead('SELECT id, user_id, key FROM api_keys') as Array<{ id: number; user_id: number; key: string }>
    inventory.credentials = matchLegacyCredentialIds(inventory.credentials, users, keys)
  } else {
    const client = await pool.connect()
    try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); inventory = await readInventory(client); await client.query('COMMIT') }
    catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    inventory.gateway = await readGatewayInventory(args.includes('--gateway-url') ? arg('--gateway-url') : undefined)
  }
  const summary = auditSummary(inventory), data = buildModelImport(inventory)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'inventory.json'), JSON.stringify(inventory, null, 2))
  await writeFile(join(directory, 'audit.json'), JSON.stringify({ at: new Date().toISOString(), readOnly: true, ...summary, bindings: data.bindings, sources: data.sources }, null, 2))
  console.log(JSON.stringify(summary.counts))
  if (args.includes('--compare-resolvers')) {
    const { runShadowAudit } = await import('./model-hub-shadow.js')
    await runShadowAudit(inventory, directory)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('model-hub-audit failed (no remote body or secrets logged)'); process.exitCode = 1 }).finally(() => pool.end())
}
