import { createHash } from 'node:crypto'

/**
 * Migration 0010: MCP connector registry + per-agent enablement.
 *
 * mcp_connectors: one row per company-level connector. `type` is 'stdio'
 * (command + args + env) or 'http' (url + headers). `enabled` lets the
 * operator park a connector without deleting it.
 *
 * agent_mcp_connectors: which connectors an agent has enabled. No FK on
 * agent_id — participants.id is only unique via a partial index
 * (WHERE kind='agent'), so Postgres can't back the reference (same
 * constraint as agent_skills in 0009).
 */
export const MCP_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS mcp_connectors (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  command     TEXT,
  args        JSONB NOT NULL DEFAULT '[]'::jsonb,
  env         JSONB NOT NULL DEFAULT '{}'::jsonb,
  url         TEXT,
  headers     JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS agent_mcp_connectors (
  agent_id     TEXT NOT NULL,
  connector_id TEXT NOT NULL REFERENCES mcp_connectors(id) ON DELETE CASCADE,
  enabled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, connector_id)
);
`

export function mcpTablesChecksum(): string {
  return createHash('sha256').update(MCP_TABLES_SQL).digest('hex')
}
