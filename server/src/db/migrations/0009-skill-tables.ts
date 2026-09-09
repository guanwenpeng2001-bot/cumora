import { createHash } from 'node:crypto'

/**
 * Migration 0009: company skill library + per-agent enablement.
 *
 * skills: one row per company-level skill (the library). `files` is a JSONB
 * array of {path, body} matching the SkillManifest shape the managed-agent
 * installer (agents/skills.ts) already validates; `source` records where it
 * came from ('skillhub' | 'local' | 'paste'), `hub_id` the SkillHub id when
 * applicable.
 *
 * agent_skills: which library skills an agent has enabled. Managed agents
 * get the files materialized into their FUSE workspace (skills/<name>/…);
 * BYOA agents receive them in the daemon's seedHome payload via
 * /computers/me/agents.
 */
export const SKILL_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'paste',
  hub_id      TEXT,
  files       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

-- participants.id has no plain UNIQUE (agent ids are unique only via a
-- partial index WHERE kind='agent'), so agent_skills.agent_id can't carry
-- an FK — orphan cleanup happens in code paths that already know the
-- participant lifecycle.
CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id   TEXT NOT NULL,
  skill_id   TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, skill_id)
);
`

export function skillTablesChecksum(): string {
  return createHash('sha256').update(SKILL_TABLES_SQL).digest('hex')
}
