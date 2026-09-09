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
import { readdir, readFile, stat, realpath, lstat } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { pool } from './db/pool.js'
import { getServerSetting } from './settings.js'
import {
  installSkillFromManifest, parseSkillMd,
  searchSkillHub, validateSkillName,
  type SkillManifest,
} from './agents/skills.js'

export class ResourceError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export async function requireResourceAgent(client: import('pg').PoolClient, companyId: string, agentId: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT id FROM participants WHERE id = $1 AND company_id = $2 AND kind = 'agent'
       AND departed_at IS NULL FOR UPDATE`, [agentId, companyId],
  )
  if (!rows[0]) throw new ResourceError(404, 'agent not found')
}

export function validateLibraryManifest(input: unknown): asserts input is SkillManifest {
  const m = input as SkillManifest | null
  if (!m || typeof m !== 'object' || typeof m.name !== 'string' || validateSkillName(m.name)
      || typeof m.description !== 'string' || !m.description.trim() || m.description.length > 1024) throw new ResourceError(400, 'invalid manifest metadata')
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > 100) throw new ResourceError(400, 'manifest must have 1-100 files')
  const seen = new Set<string>()
  for (const f of m.files) {
    if (!f || typeof f.path !== 'string' || typeof f.body !== 'string') throw new ResourceError(400, 'every file needs string path and body')
    if (!f.path || f.path.length > 200 || /[\\:*?<>"|\x00-\x1f]/.test(f.path)
        || f.path.includes('..') || f.path.split('/').some((part) => !part || part === '.' || /[. ]$/.test(part)
          || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new ResourceError(400, 'unsafe manifest path')
    const key = f.path.toLowerCase()
    if (seen.has(key)) throw new ResourceError(400, 'duplicate manifest path')
    seen.add(key)
    if (Buffer.byteLength(f.body, 'utf8') > 256 * 1024) throw new ResourceError(400, 'manifest file too large')
  }
  for (const path of seen) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) throw new ResourceError(400, 'manifest file/directory conflict')
  }
  const root = m.files.find((f) => f.path === 'SKILL.md')
  if (!root || parseSkillMd(root.body).frontmatter?.name !== m.name) throw new ResourceError(400, 'manifest requires matching SKILL.md frontmatter')
}

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
  validateLibraryManifest(args)
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
  if (!url) throw new ResourceError(409, 'SKILLHUB_URL is not configured')
  try { return await searchSkillHub(query, url) } catch { throw new ResourceError(503, 'SkillHub unavailable') }
}

/** Install a hub skill into the company library. */
export async function installFromHub(companyId: string, hubId: string): Promise<SkillRow> {
  const url = skillHubUrl()
  if (!url) throw new ResourceError(409, 'SKILLHUB_URL is not configured')
  if (!hubId.trim() || hubId === '.' || hubId === '..' || /^(?:https?:)?\/\//i.test(hubId)) throw new ResourceError(400, 'install by skill id')
  let response: Response
  try {
    response = await fetch(`${url}/skills/${encodeURIComponent(hubId)}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  } catch { throw new ResourceError(503, 'SkillHub unavailable') }
  if (response.status === 404) throw new ResourceError(404, 'hub skill not found')
  if (!response.ok) throw new ResourceError(503, 'SkillHub unavailable')
  const maxManifestBytes = 32 * 1024 * 1024
  const reader = response.body?.getReader()
  if (!reader) throw new ResourceError(400, 'empty hub manifest')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxManifestBytes) {
        await reader.cancel().catch(() => {})
        throw new ResourceError(400, 'hub manifest too large')
      }
      chunks.push(value)
    }
  } catch (e) {
    if (e instanceof ResourceError) throw e
    throw new ResourceError(503, 'SkillHub unavailable')
  } finally { reader.releaseLock() }
  let manifest: unknown
  try { manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ResourceError(400, 'invalid hub manifest JSON') }
  validateLibraryManifest(manifest)
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

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
}

async function localRoot(): Promise<string> {
  const root = localSkillHubPath()
  if (!root) throw new ResourceError(409, 'LOCAL_SKILLHUB_PATH is not configured')
  try {
    const resolved = await realpath(root)
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory')
    return resolved
  } catch { throw new ResourceError(503, 'local hub unavailable') }
}

async function localDirectory(root: string, name: string): Promise<string> {
  if (!name || name.includes('..') || /[\\/:\x00-\x1f]/.test(name) || isAbsolute(name) || name === '.') throw new ResourceError(400, 'local skill must be a direct directory name')
  try {
    const entry = (await readdir(root, { withFileTypes: true })).find((item) => item.name === name)
    if (!entry || (!entry.isDirectory() && !entry.isSymbolicLink())) throw new ResourceError(404, 'local skill not found')
    const dir = await realpath(join(root, name))
    if (!inside(root, dir)) throw new ResourceError(400, 'local skill crosses hub boundary')
    if (!(await stat(dir)).isDirectory()) throw new ResourceError(404, 'local skill not found')
    return dir
  } catch (e) {
    if (e instanceof ResourceError) throw e
    throw new ResourceError((e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 503, 'local skill unavailable')
  }
}

async function readLocalSkillFiles(dir: string): Promise<SkillFile[]> {
  const out: SkillFile[] = []
  const walk = async (cur: string, rel: string): Promise<void> => {
    for (const entry of await readdir(cur, { withFileTypes: true })) {
      const abs = join(cur, entry.name)
      const resolved = await realpath(abs)
      if (!inside(dir, resolved) || (await lstat(abs)).isSymbolicLink()) throw new ResourceError(400, 'local skill contains a link or boundary escape')
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        await walk(resolved, relPath)
        continue
      }
      if (!entry.isFile()) throw new ResourceError(400, 'local skill contains a non-regular file')
      const dot = entry.name.lastIndexOf('.')
      const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : ''
      if (relPath !== 'SKILL.md' && !LOCAL_IMPORT_EXT.has(ext)) continue
      if ((await stat(resolved)).size > LOCAL_IMPORT_MAX_BYTES) throw new ResourceError(400, 'local skill file too large')
      out.push({ path: relPath, body: await readFile(resolved, 'utf8') })
      if (out.length > 100) throw new ResourceError(400, 'too many local skill files')
    }
  }
  try { await walk(dir, '') } catch (e) {
    if (e instanceof ResourceError) throw e
    throw new ResourceError((e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 503, 'local skill unavailable')
  }
  return out
}

export interface LocalHubEntry {
  name: string
  directory?: string
  skillName?: string
  description: string
  imported: boolean
}

export async function listLocalHub(companyId: string): Promise<LocalHubEntry[]> {
  const root = await localRoot()
  const existing = new Set((await listSkills(companyId)).map((s) => s.name))
  const out: LocalHubEntry[] = []
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { throw new ResourceError(503, 'local hub unavailable') }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith('.')) continue
    try {
      const files = await readLocalSkillFiles(await localDirectory(root, entry.name))
      const body = files.find((f) => f.path === 'SKILL.md')?.body
      const frontmatter = body && parseSkillMd(body).frontmatter
      if (!frontmatter) continue
      validateLibraryManifest({ ...frontmatter, files })
      out.push({ name: entry.name, directory: entry.name, skillName: frontmatter.name, description: frontmatter.description, imported: existing.has(frontmatter.name) })
    } catch (e) {
      if (!(e instanceof ResourceError) || e.status === 503) throw e
    }
  }
  return out
}

export async function importLocalSkill(companyId: string, name: string): Promise<SkillRow> {
  const files = await readLocalSkillFiles(await localDirectory(await localRoot(), name))
  const body = files.find((f) => f.path === 'SKILL.md')?.body
  if (!body) throw new ResourceError(404, 'local skill SKILL.md not found')
  const { frontmatter } = parseSkillMd(body)
  if (!frontmatter) throw new ResourceError(400, 'SKILL.md has missing or malformed YAML frontmatter')
  return insertSkill(companyId, { name: frontmatter.name, description: frontmatter.description, source: 'local', files })
}

export async function deleteSkill(companyId: string, id: string): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Delete the materialized tree in the same transaction as the library
    // row. The agent_skills FK cascade handles enablement rows, while this
    // explicit cleanup handles their already-materialized workspace files.
    const { rowCount } = await client.query(
      `DELETE FROM agent_workspace aw
        USING skills s
       WHERE s.company_id = $1 AND s.id = $2
         AND aw.company_id = s.company_id
         AND aw.path LIKE 'skills/' || s.name || '/%'`,
      [companyId, id],
    )
    const deleted = await client.query(
      `DELETE FROM skills WHERE company_id = $1 AND id = $2`, [companyId, id],
    )
    await client.query('COMMIT')
    if ((rowCount ?? 0) > 0) {
      console.info('[skills] removed ' + rowCount + ' materialized file(s) for deleted skill ' + id)
    }
    return (deleted.rowCount ?? 0) > 0
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/* ── per-agent enablement ─────────────────────────────────────────────── */

export interface AgentSkillState {
  skill: SkillRow
  enabled: boolean
}

export async function agentSkillsFor(companyId: string, agentId: string): Promise<AgentSkillState[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await requireResourceAgent(client, companyId, agentId)
    const { rows } = await client.query<DbSkillRow & { enabled: boolean }>(
      `SELECT s.*, (a.agent_id IS NOT NULL) AS enabled
         FROM skills s
         LEFT JOIN agent_skills a ON a.skill_id = s.id AND a.agent_id = $2
        WHERE s.company_id = $1
          AND EXISTS (SELECT 1 FROM participants p WHERE p.id = $2 AND p.company_id = s.company_id AND p.kind = 'agent' AND p.departed_at IS NULL)
        ORDER BY s.name ASC`,
      [companyId, agentId],
    )
    await client.query('COMMIT')
    return rows.map((r) => ({ skill: toRow(r), enabled: r.enabled }))
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}

/** Skill ids currently enabled for the agent (daemon payload path). */
export async function enabledSkillsForAgent(agentId: string): Promise<SkillRow[]> {
  const { rows } = await pool.query<DbSkillRow>(
    `SELECT s.* FROM skills s
       JOIN agent_skills a ON a.skill_id = s.id
       JOIN participants p ON p.id = a.agent_id AND p.company_id = s.company_id AND p.kind = 'agent' AND p.departed_at IS NULL
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
    await requireResourceAgent(client, companyId, agentId)
    if (!Array.isArray(skillIds) || skillIds.some((id) => typeof id !== 'string' || !id)) throw new ResourceError(400, 'invalid skillIds')
    const ids = [...new Set(skillIds)]
    const resources = await client.query(`SELECT id FROM skills WHERE company_id = $1 AND id = ANY($2::text[]) FOR SHARE`, [companyId, ids])
    if (resources.rows.length !== ids.length) throw new ResourceError(400, 'skill not found in company')
    await client.query(
      `DELETE FROM agent_skills a
        USING skills s
       WHERE a.agent_id = $1 AND a.skill_id = s.id AND s.company_id = $2`,
      [agentId, companyId],
    )
    for (const skillId of ids) {
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
  // Enablement is the source of truth. Materialization is deliberately
  // asynchronous and serialized per agent so rapid checkbox changes cannot
  // overlap destructive rewrite passes; each pass reads the latest DB state
  // and is safe to repeat.
  scheduleAgentSkillsMaterialization(agentId)
}

interface MaterializationState {
  revision: number
  appliedRevision: number
  running: Promise<void> | null
}

const materializationStates = new Map<string, MaterializationState>()

/** Queue an idempotent, latest-state materialization for one agent. */
export function scheduleAgentSkillsMaterialization(agentId: string): void {
  const state = materializationStates.get(agentId) ?? { revision: 0, appliedRevision: 0, running: null }
  state.revision += 1
  materializationStates.set(agentId, state)
  if (state.running) return

  state.running = (async () => {
    while (state.appliedRevision < state.revision) {
      const targetRevision = state.revision
      try {
        await materializeAgentSkills(agentId)
        state.appliedRevision = targetRevision
      } catch (e) {
        console.warn('[skills] materialization failed for ' + agentId + '; retrying', e instanceof Error ? e.message : e)
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
      }
    }
  })().finally(() => {
    state.running = null
    // A revision can arrive between the final loop check and cleanup.
    if (state.appliedRevision < state.revision) scheduleAgentSkillsMaterialization(agentId)
  })
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
