import { createHash } from 'node:crypto'

/**
 * Migration 0015: per-engine default model settings on Computers.
 *
 * Upstream shipped this as 0007; the fork already used 0007–0014 for
 * server_settings / pricing / skills / MCP / usage, so the same SQL is
 * appended here as a new ledger entry. Checksum is of the SQL body.
 *
 * Cumora users with custom provider endpoints (CC Switch and friends) need a
 * per-engine model policy: which main + fast model each local CLI should run
 * when an agent has no explicit pin. Stored as a JSONB map on the Computer:
 * { "claude": { "model": "…", "fastModel": "…" }, … }. Agents inherit these in
 * listAgentsForComputer when participants.model / fast_model are unset.
 */
export const ENGINE_DEFAULTS_SQL = `
ALTER TABLE computers
  ADD COLUMN IF NOT EXISTS engine_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;
`

export function engineDefaultsChecksum(): string {
  return createHash('sha256').update(ENGINE_DEFAULTS_SQL).digest('hex')
}
