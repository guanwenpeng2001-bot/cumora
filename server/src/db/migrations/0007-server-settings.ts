import { createHash } from 'node:crypto'

/**
 * Migration 0007: server-wide model settings + per-agent model_config reserve.
 *
 * server_settings is the runtime-editable key-value store behind the
 * settings page's model tab — writes land here and take effect without a
 * restart (read side polls on a 30s refresh). Values are seeded from env
 * on first boot (INSERT ... ON CONFLICT DO NOTHING in settings.ts), never
 * in this migration: DDL must stay environment-independent.
 *
 * participants.model_config is the phase-2 reserve for per-agent model
 * overrides (model / effort / context / output cap / fallback chain). The
 * column ships now so phase 2 is UI-only.
 */
export const SERVER_SETTINGS_SQL = `
CREATE TABLE IF NOT EXISTS server_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE participants ADD COLUMN IF NOT EXISTS model_config JSONB;
`

export function serverSettingsChecksum(): string {
  return createHash('sha256').update(SERVER_SETTINGS_SQL).digest('hex')
}
