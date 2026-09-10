/**
 * MCP connector registry (mcp_connectors) + per-agent enablement
 * (agent_mcp_connectors), plus the per-engine config generators.
 *
 * Phase 5 scope: registry + BYOA injection. Managed (cloud) agents get
 * MCP client support in phase 6 — the registry and checkbox state work
 * for them today, the UI notes that.
 *
 * BYOA injection paths (daemon owns every write — secure engines ignore
 * user-level config by design):
 *   - Claude secure: merged into the daemon-built --mcp-config JSON
 *     (buildClaudeMcpServers merged with the cumora bridge entry)
 *   - Claude compat: <home>/.mcp.json written at seedHome
 *   - Codex secure: extra `-c mcp_servers.<name>={…}` args (its user
 *     config is ignored via --ignore-user-config)
 *   - other engines: skipped with a daemon log note
 */
import { randomUUID } from 'node:crypto'
import { pool } from './db/pool.js'
import { ResourceError, requireResourceAgent } from './skill-library.js'

export type ConnectorType = 'stdio' | 'http'

export interface McpConnectorRow {
  id: string
  companyId: string
  name: string
  type: ConnectorType
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  headers: Record<string, string>
  enabled: boolean
  createdAt: string
}

interface DbRow {
  id: string; company_id: string; name: string; type: string
  command: string | null; args: unknown; env: unknown
  url: string | null; headers: unknown; enabled: boolean
  created_at: Date | string
}

function toRow(r: DbRow, redactSecrets = false): McpConnectorRow {
  const env = (r.env && typeof r.env === 'object' && !Array.isArray(r.env) ? r.env : {}) as Record<string, string>
  const headers = (r.headers && typeof r.headers === 'object' && !Array.isArray(r.headers) ? r.headers : {}) as Record<string, string>
  return {
    id: r.id, companyId: r.company_id, name: r.name,
    type: r.type === 'http' ? 'http' : 'stdio',
    command: redactSecrets ? null : r.command,
    args: !redactSecrets && Array.isArray(r.args) ? r.args.filter((x): x is string => typeof x === 'string') : [],
    env: redactSecrets ? Object.fromEntries(Object.keys(env).map((key) => [key, '***'])) : env,
    url: redactSecrets ? null : r.url,
    headers: redactSecrets ? Object.fromEntries(Object.keys(headers).map((key) => [key, '***'])) : headers,
    enabled: r.enabled,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

/** Validate an upsert payload. Returns a human error string or null. */
export function validateConnector(input: {
  name?: unknown; type?: unknown; command?: unknown; args?: unknown
  env?: unknown; url?: unknown; headers?: unknown; enabled?: unknown
}): string | null {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) return 'name must be 1-64 chars of a-z 0-9 _ - (start alnum)'
  if (name.includes('__')) return 'name must not contain __'
  if (input.type !== 'stdio' && input.type !== 'http') return 'type must be stdio | http'
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return 'enabled must be boolean'
  if (input.type === 'stdio') {
    if (typeof input.command !== 'string' || !input.command.trim()) return 'stdio connectors need a command'
    if (input.args !== undefined && !Array.isArray(input.args)) return 'args must be an array of strings'
    if (Array.isArray(input.args) && input.args.some((a) => typeof a !== 'string')) return 'args must be strings'
  } else {
    if (input.command != null || (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 0))
        || (input.env !== undefined && (input.env === null || typeof input.env !== 'object' || Array.isArray(input.env) || Object.keys(input.env).length > 0))) return 'http connectors do not accept command, args or env'
    if (typeof input.url !== 'string' || !/^https?:\/\//.test(input.url.trim())) return 'http connectors need an http(s) url'
    try {
      const url = new URL(input.url.trim())
      if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) return 'invalid http url'
    } catch { return 'invalid http url' }
  }
  for (const m of [input.env, input.headers]) {
    if (m !== undefined && (typeof m !== 'object' || m === null || Array.isArray(m))) return 'env/headers must be objects'
    if (m && Object.values(m).some((value) => typeof value !== 'string')) return 'env/headers values must be strings'
  }
  return null
}

export async function listConnectors(companyId: string, opts: { redactSecrets?: boolean } = {}): Promise<McpConnectorRow[]> {
  const { rows } = await pool.query<DbRow>(
    `SELECT * FROM mcp_connectors WHERE company_id = $1 ORDER BY name ASC`, [companyId],
  )
  return rows.map((row) => toRow(row, opts.redactSecrets !== false))
}

export async function upsertConnector(companyId: string, input: {
  id?: string; name: string; type: ConnectorType
  command?: string | null; args?: string[]; env?: Record<string, string>
  url?: string | null; headers?: Record<string, string>; enabled?: boolean
}): Promise<McpConnectorRow> {
  const error = validateConnector(input)
  if (error) throw new ResourceError(400, error)
  const id = input.id ?? `mcp-${randomUUID()}`
  const { rows } = await pool.query<DbRow>(
    `INSERT INTO mcp_connectors (id, company_id, name, type, command, args, env, url, headers, enabled)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, type = EXCLUDED.type, command = EXCLUDED.command,
       args = EXCLUDED.args, env = EXCLUDED.env, url = EXCLUDED.url,
       headers = EXCLUDED.headers, enabled = EXCLUDED.enabled
     WHERE mcp_connectors.company_id = EXCLUDED.company_id
     RETURNING *`,
    [id, companyId, input.name, input.type, input.command ?? null,
     JSON.stringify(input.args ?? []), JSON.stringify(input.env ?? {}),
     input.url ?? null, JSON.stringify(input.headers ?? {}), input.enabled ?? true],
  )
  if (!rows[0]) throw new ResourceError(404, 'connector not found')
  const { invalidatePersonaCache } = await import('./agents/personas.js')
  invalidatePersonaCache()
  return toRow(rows[0])
}

export async function deleteConnector(companyId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM mcp_connectors WHERE company_id = $1 AND id = $2`, [companyId, id],
  )
  const { invalidatePersonaCache } = await import('./agents/personas.js')
  invalidatePersonaCache()
  return (rowCount ?? 0) > 0
}

export interface AgentConnectorState {
  connector: McpConnectorRow
  enabled: boolean
}

export async function agentConnectorsFor(companyId: string, agentId: string, opts: { redactSecrets?: boolean } = {}): Promise<AgentConnectorState[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireResourceAgent(client, companyId, agentId)
    const { rows } = await client.query<DbRow & { on: boolean }>(
      `SELECT c.*, (a.agent_id IS NOT NULL) AS on
         FROM mcp_connectors c
         LEFT JOIN agent_mcp_connectors a ON a.connector_id = c.id AND a.agent_id = $2
        WHERE c.company_id = $1
          AND EXISTS (SELECT 1 FROM participants p WHERE p.id = $2 AND p.company_id = c.company_id AND p.kind = 'agent' AND p.departed_at IS NULL)
        ORDER BY c.name ASC`,
      [companyId, agentId],
    )
    await client.query('COMMIT')
    return rows.map((r) => ({ connector: toRow(r, opts.redactSecrets !== false), enabled: r.on }))
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

export async function setAgentConnectors(companyId: string, agentId: string, connectorIds: string[]): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireResourceAgent(client, companyId, agentId)
    if (!Array.isArray(connectorIds) || connectorIds.some((id) => typeof id !== 'string' || !id)) throw new ResourceError(400, 'invalid connectorIds')
    const ids = [...new Set(connectorIds)]
    const resources = await client.query(`SELECT id FROM mcp_connectors WHERE company_id = $1 AND id = ANY($2::text[]) AND enabled FOR SHARE`, [companyId, ids])
    if (resources.rows.length !== ids.length) throw new ResourceError(400, 'connector not found in company')
    await client.query(
      `DELETE FROM agent_mcp_connectors a
        USING mcp_connectors c
       WHERE a.agent_id = $1 AND a.connector_id = c.id AND c.company_id = $2`,
      [agentId, companyId],
    )
    for (const id of ids) {
      await client.query(
        `INSERT INTO agent_mcp_connectors (agent_id, connector_id)
         SELECT $1, id FROM mcp_connectors WHERE id = $2 AND company_id = $3 AND enabled
         ON CONFLICT DO NOTHING`,
        [agentId, id, companyId],
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  const { invalidatePersonaCache } = await import('./agents/personas.js')
  invalidatePersonaCache(agentId)
}

/** Connectors enabled for the agent (daemon payload path). */
export async function enabledConnectorsForAgent(agentId: string): Promise<McpConnectorRow[]> {
  const { rows } = await pool.query<DbRow>(
    `SELECT c.* FROM mcp_connectors c
       JOIN agent_mcp_connectors a ON a.connector_id = c.id
       JOIN participants p ON p.id = a.agent_id AND p.company_id = c.company_id AND p.kind = 'agent' AND p.departed_at IS NULL
      WHERE a.agent_id = $1 AND c.enabled
      ORDER BY c.name ASC`,
    [agentId],
  )
  return rows.map((row) => toRow(row))
}

/* ── per-engine config generation ──────────────────────────────────────
 *  The generators live in agents/computer/engine.ts (the daemon bundle
 *  stays pg-free); these adapt registry rows to the engine-side spec. */
import {
  buildEngineMcpServers, mergeEngineSecureMcpConfig, buildEngineCodexMcpArgs,
  type EngineMcpConnector,
} from './agents/computer/engine.js'

function toEngineSpec(c: McpConnectorRow): EngineMcpConnector {
  return {
    name: c.name, type: c.type, command: c.command, args: c.args, env: c.env,
    url: c.url, headers: c.headers,
  }
}

export function buildClaudeMcpServers(connectors: McpConnectorRow[]): Record<string, unknown> {
  return buildEngineMcpServers(connectors.filter((c) => c.enabled).map(toEngineSpec))
}

export function buildClaudeMcpJson(connectors: McpConnectorRow[]): string {
  return JSON.stringify({ mcpServers: buildClaudeMcpServers(connectors) }, null, 2)
}

export function mergeClaudeSecureMcpConfig(existingJson: string, connectors: McpConnectorRow[]): string {
  return mergeEngineSecureMcpConfig(existingJson, connectors.filter((c) => c.enabled).map(toEngineSpec))
}

export function buildCodexMcpArgs(connectors: McpConnectorRow[]): string[] {
  return buildEngineCodexMcpArgs(connectors.filter((c) => c.enabled).map(toEngineSpec))
}
