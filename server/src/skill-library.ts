/**
 * Company skill library (skills table) + per-agent enablement (agent_skills).
 *
 * Sources:
 *   - paste: operator pastes a SKILL.md body
 *   - skillhub: installed from the configured hub (env SKILLHUB_URL)
 *   - local: imported from a local directory of skill folders
 *     (LOCAL_SKILLHUB_PATH env, e.g. the machine's ~/.agents/skills)
 *
 * Enablement: agent_skills rows. Managed agents get enabled skills
 * materialized into their FUSE workspace (agent_workspace skills/<name>/…,
 * the same place the `cumora skills` CLI installs into, so the wake
 * prompt's progressive-disclosure index picks them up unchanged). BYOA
 * agents receive them in the daemon's seedHome payload
 * (/api/computers/me/agents → EnginePersona.skills).
 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pool } from './db/pool.js'
import { getServerSetting } from './settings.js'
import {
  fetchSkillManifest, installSkillFromManifest, parseSkillMd,
  searchSkillHub, validateSkillName,
  type SkillManifest,
} from './agents/skills.js'

export interface SkillFile { path: string; body: string }

export interface SkillRow {
  id: string
  companyId: string
  name: string
  description: string
  source: 'skillhub' | 'local' | 'paste'
  hubId: string | null
  files: SkillFile[]
  createdAt: string
}

interface DbSkillRow {
  id: string; company_id: string; name: string; description: string
  source: string; hub_id: string | null; files: unknown; created_at: Date | string
}

function toRow(r: DbSkillRow): SkillRow {
  return {
    id: r.id, companyId: r.company_id, name: r.name, description: r.description,
    source: (r.source === 'skillhub' || r.source === 'local' ? r.source : 'paste'),
    hubId: r.hub_id, files: (Array.isArray(r.files) ? r.files : []) as SkillFile[],
    createdAt: new Date(r.created_at).toISOString(),
  }
}

export function skillHubUrl(): string {
  return (process.env.SKILLHUB_URL ?? '').trim().replace(/\/+$/, '')
}

export function localSkillHubPath(): string {
  // server_settings wins (runtime-editable), env is the fallback.
  const v = getServerSetting('local_skillhub_path').trim()
  return v || (process.env.LOCAL_SKILLHUB_PATH ?? '').trim()
}

export async function listSkills(companyId: string): Promise<SkillRow[]> {
  const { rows } = await pool.query<DbSkillRow>(
    `SELECT * FROM skills WHERE company_id = $1 ORDER BY name ASC`, [companyId],
  )
  return rows.map(toRow)
}

export async function getSkill(companyId: string, id: string): Promise<SkillRow | null> {
  const { rows } = await pool.query<DbSkillRow>(
    `SELECT * FROM skills WHERE company_id = $1 AND id = $2`, [companyId, id],
  )
  return rows[0] ? toRow(rows[0]) : null
}

async function insertSkill(companyId: string, args: {
  name: string; description: string; source: SkillRow['source']; hubId?: string | null; files: SkillFile[]
}): Promise<SkillRow> {
  const nameError = validateSkillName(args.name)
  if (nameError) throw new Error(`skill name invalid: ${nameError}`)
  const id = `skill-${randomUUID()}`
  const { rows } = await pool.query<DbSkillRow>(
    `INSERT INTO skills (id, company_id, name, description, source, hub_id, files)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (company_id, name) DO UPDATE SET
       description = EXCLUDED.description, source = EXCLUDED.source,
       hub_id = EXCLUDED.hub_id, files = EXCLUDED.files
     RETURNING *`,
    [id, companyId, args.name, args.description, args.source, args.hubId ?? null, JSON.stringify(args.files)],
  )
  return toRow(rows[0])
}

/** Pure parse+validate of a pasted SKILL.md — split out so tests don't
 *  need a DB. Throws on malformed frontmatter / bad name. */
export function parsePastedSkill(skillMd: string): { name: string; description: string; files: SkillFile[] } {
  const { frontmatter } = parseSkillMd(skillMd)
  if (!frontmatter) throw new Error('SKILL.md has missing or malformed YAML frontmatter (name + description required)')
  const nameError = validateSkillName(frontmatter.name)
  if (nameError) throw new Error(`skill name invalid: ${nameError}`)
  return { name: frontmatter.name, description: frontmatter.description, files: [{ path: 'SKILL.md', body: skillMd }] }
}

/** Create from a pasted SKILL.md body (frontmatter supplies name/description). */
export async function createSkillFromPaste(companyId: string, skillMd: string): Promise<SkillRow> {
  const parsed = parsePastedSkill(skillMd)
  return insertSkill(companyId, { ...parsed, source: 'paste' })
}

/** Search the configured SkillHub. Throws when SKILLHUB_URL is unset —
 *  the UI turns that into the "configure a hub" hint. */
export async function searchHub(query: string) {
  const url = skillHubUrl()
  if (!url) throw new Error('SKILLHUB_URL is not configured')
  return searchSkillHub(query, url)
}

/** Install a hub skill into the company library. */
export async function installFromHub(companyId: string, hubId: string): Promise<SkillRow> {
  const url = skillHubUrl()
  if (!url) throw new Error('SKILLHUB_URL is not configured')
  const manifest: SkillManifest = await fetchSkillManifest(hubId, url)
  return insertSkill(companyId, {
    name: manifest.name,
    description: manifest.description,
    source: 'skillhub',
    hubId,
    files: manifest.files,
  })
}

/** Text-ish file extensions we import from a local hub folder. Binary
 *  assets are skipped — library rows are JSONB text. */
const LOCAL_IMPORT_EXT = new Set(['.md', '.txt', '.json', '.ts', '.js', '.mjs', '.py', '.sh', '.yaml', '.yml', '.toml', '.csv'])
const LOCAL_IMPORT_MAX_BYTES = 256 * 1024

async function readLocalSkillFiles(dir: string): Promise<SkillFile[]> {
  const out: SkillFile[] = []
  const walk = async (cur: string, rel: string): Promise<void> => {
    for (const entry of await readdir(cur, { withFileTypes: true })) {
      const abs = join(cur, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        await walk(abs, relPath)
        continue
      }
      const dot = entry.name.lastIndexOf('.')
      const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : ''
      if (relPath !== 'SKILL.md' && !LOCAL_IMPORT_EXT.has(ext)) continue
      const st = await stat(abs)
      if (st.size > LOCAL_IMPORT_MAX_BYTES) continue
      out.push({ path: relPath, body: await readFile(abs, 'utf8') })
    }
  }
  await walk(dir, '')
  return out
}

export interface LocalHubEntry {
  name: string
  description: string
  imported: boolean
}

/** List the local hub's skills (folders with a parseable SKILL.md),
 *  flagged by whether the company library already has them. */
export async function listLocalHub(companyId: string): Promise<LocalHubEntry[]> {
  const root = localSkillHubPath()
  if (!root) return []
  const existing = new Set((await listSkills(companyId)).map((s) => s.name))
  const out: LocalHubEntry[] = []
  let dirs: string[] = []
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
  for (const dir of dirs.sort()) {
    try {
      const body = await readFile(join(root, dir, 'SKILL.md'), 'utf8')
      const { frontmatter } = parseSkillMd(body)
      if (!frontmatter) continue
      out.push({ name: frontmatter.name, description: frontmatter.description, imported: existing.has(frontmatter.name) })
    } catch { /* no SKILL.md — not a skill folder */ }
  }
  return out
}

/** Import one skill from the local hub into the company library. */
export async function importLocalSkill(companyId: string, name: string): Promise<SkillRow> {
  const root = localSkillHubPath()
  if (!root) throw new Error('LOCAL_SKILLHUB_PATH is not configured')
  const dir = join(root, name)
  const body = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null)
  if (!body) throw new Error(`no SKILL.md at ${name}`)
  const { frontmatter } = parseSkillMd(body)
  if (!frontmatter) throw new Error('SKILL.md has missing or malformed YAML frontmatter')
  const files = await readLocalSkillFiles(dir)
  return insertSkill(companyId, {
    name: frontmatter.name,
    description: frontmatter.description,
    source: 'local',
    files,
  })
}

export async function deleteSkill(companyId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM skills WHERE company_id = $1 AND id = $2`, [companyId, id],
  )
  return (rowCount ?? 0) > 0
}

/* ── per-agent enablement ─────────────────────────────────────────────── */

export interface AgentSkillState {
  skill: SkillRow
  enabled: boolean
}

export async function agentSkillsFor(companyId: string, agentId: string): Promise<AgentSkillState[]> {
  const { rows } = await pool.query<DbSkillRow & { enabled: boolean }>(
    `SELECT s.*, (a.agent_id IS NOT NULL) AS enabled
       FROM skills s
       LEFT JOIN agent_skills a ON a.skill_id = s.id AND a.agent_id = $2
      WHERE s.company_id = $1
      ORDER BY s.name ASC`,
    [companyId, agentId],
  )
  return rows.map((r) => ({ skill: toRow(r), enabled: r.enabled }))
}

/** Skill ids currently enabled for the agent (daemon payload path). */
export async function enabledSkillsForAgent(agentId: string): Promise<SkillRow[]> {
  const { rows } = await pool.query<DbSkillRow>(
    `SELECT s.* FROM skills s
       JOIN agent_skills a ON a.skill_id = s.id
      WHERE a.agent_id = $1
      ORDER BY s.name ASC`,
    [agentId],
  )
  return rows.map(toRow)
}

/**
 * Set an agent's enabled skills, then materialize:
 *  - managed: files land in agent_workspace under skills/<name>/ (the
 *    wake prompt's skills index reads from there); deselected ones are
 *    removed so the index shrinks too.
 *  - BYOA: nothing server-side — the daemon writes them into the engine's
 *    skill dir on the next agent start (seedHome payload).
 */
export async function setAgentSkills(companyId: string, agentId: string, skillIds: string[]): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `DELETE FROM agent_skills a
        USING skills s
       WHERE a.agent_id = $1 AND a.skill_id = s.id AND s.company_id = $2`,
      [agentId, companyId],
    )
    for (const skillId of skillIds) {
      await client.query(
        `INSERT INTO agent_skills (agent_id, skill_id)
         SELECT $1, id FROM skills WHERE id = $2 AND company_id = $3
         ON CONFLICT DO NOTHING`,
        [agentId, skillId, companyId],
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  await materializeAgentSkills(agentId)
}

/** Rewrite the agent's managed-workspace skills/ tree from agent_skills.
 *  Safe no-op for BYOA agents (daemon owns their skill dirs). */
export async function materializeAgentSkills(agentId: string): Promise<void> {
  const { rows } = await pool.query<{ kind: string; computer_kind: string | null }>(
    `SELECT p.kind, c.kind AS computer_kind
       FROM participants p
       LEFT JOIN computers c ON c.id = p.computer_id
      WHERE p.id = $1`,
    [agentId],
  )
  const row = rows[0]
  if (!row || row.kind !== 'agent') return
  if (row.computer_kind && row.computer_kind !== 'cloud') return // BYOA — daemon seeds

  const skills = await enabledSkillsForAgent(agentId)
  const wanted = new Map<string, SkillRow>()
  for (const s of skills) wanted.set(s.name, s)

  // Managed workspace files go through the same validator+writer the CLI
  // uses, so path/size rules stay single-sourced.
  for (const skill of skills) {
    const manifest: SkillManifest = { name: skill.name, description: skill.description, files: skill.files }
    // installSkillFromManifest refuses to clobber — delete first when the
    // skill is already present so re-syncs apply content changes.
    await deleteWorkspaceSkill(agentId, skill.name)
    await installSkillFromManifest({ agentId, manifest })
  }

  // Remove workspace skills no longer enabled (only those we know about —
  // a workspace skill the agent wrote itself and that matches no library
  // row is left alone).
  const { rows: wsRows } = await pool.query<{ path: string }>(
    `SELECT DISTINCT path FROM agent_workspace
      WHERE agent_id = $1 AND path LIKE 'skills/%/SKILL.md'`,
    [agentId],
  )
  for (const r of wsRows) {
    const name = r.path.split('/')[1]
    if (name && !wanted.has(name)) {
      // Only remove skills that exist in the company library — agent-authored
      // skills (no library row) belong to the agent.
      const { rowCount } = await pool.query(
        `SELECT 1 FROM skills s JOIN participants p ON p.company_id = s.company_id WHERE p.id = $2 AND s.name = $1 LIMIT 1`,
        [name, agentId],
      )
      if ((rowCount ?? 0) > 0) await deleteWorkspaceSkill(agentId, name)
    }
  }
}

async function deleteWorkspaceSkill(agentId: string, name: string): Promise<void> {
  await pool.query(
    `DELETE FROM agent_workspace WHERE agent_id = $1 AND path LIKE $2`,
    [agentId, `skills/${name}/%`],
  )
}
