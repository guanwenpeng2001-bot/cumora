import { createHash } from 'node:crypto'

export const SUB2API_SYNC_SQL = `
CREATE TABLE IF NOT EXISTS sub2api_sync_intents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  intent_id TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  target_tier TEXT NOT NULL CHECK (target_tier IN ('free', 'pro', 'max')),
  target_groups JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'failed', 'succeeded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  remote_user_id BIGINT,
  managed_keys JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sub2api_sync_due
  ON sub2api_sync_intents(next_attempt_at) WHERE status <> 'succeeded';
`

export function sub2apiSyncChecksum(): string {
  return createHash('sha256').update(SUB2API_SYNC_SQL).digest('hex')
}
