/**
 * Unit tests for the skill library's pure seams: pasted SKILL.md
 * parse+validate (the create-from-paste path) and the agent-skill state
 * mapping used by the editor's checkbox list.
 *
 * Run: node --import tsx --test server/src/__tests__/skill-library.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { pool } from '../db/pool.js'
import { parsePastedSkill, applyPendingAgentResources } from '../skill-library.js'

test('parsePastedSkill: valid SKILL.md yields name/description/files', () => {
  const md = '---\nname: pdf-tools\ndescription: Read and split PDFs\n---\n\n# PDF tools\n\nDo the thing.\n'
  const r = parsePastedSkill(md)
  assert.equal(r.name, 'pdf-tools')
  assert.equal(r.description, 'Read and split PDFs')
  assert.deepEqual(r.files, [{ path: 'SKILL.md', body: md }])
})

test('parsePastedSkill: quoted scalars are unquoted', () => {
  const r = parsePastedSkill('---\nname: "my-skill"\ndescription: \'quoted\'\n---\nbody\n')
  assert.equal(r.name, 'my-skill')
  assert.equal(r.description, 'quoted')
})

test('parsePastedSkill: rejects missing frontmatter / missing fields / bad names', () => {
  assert.throws(() => parsePastedSkill('# no frontmatter\n'), /frontmatter/)
  assert.throws(() => parsePastedSkill('---\nname: only-name\n---\n'), /frontmatter/)
  assert.throws(() => parsePastedSkill('---\nname: BAD NAME!\ndescription: x\n---\n'), /name invalid/)
})


test('managed resources skip unchanged UPSERTs and update only owned changed files', async (t) => {
  const { redis, sub } = await import('../redis.js')
  const body = '---\nname: sample\ndescription: fixture\n---\nbody'
  let snapshot = { id: 'f16-agent', companyId: 'c1', assignmentId: 'assignment1', computerId: null,
    computerKind: null, name: 'Agent', role: null, systemPrompt: null,
    skills: [{ name: 'sample', description: 'fixture', files: [{ path: 'SKILL.md', body }, { path: 'tool.txt', body: 'v1' }] }], mcpConnectors: [] }
  const workspace = new Map<string, { body: string; managed: boolean; updated: number }>()
  workspace.set('skills/custom/notes.txt', { body: 'user', managed: false, updated: 0 })
  const sqls: string[] = []
  let reports = 0
  let writes = 0
  let fullReads = 0
  const digest = (body: string) => createHash('md5').update(body).digest('hex')
  const query = async (sql: string, params: unknown[] = []) => {
    sqls.push(sql)
    if (sql.startsWith('SELECT md5(row_to_json')) return { rows: [{ fingerprint: digest(JSON.stringify(snapshot)) }] }
    if (sql.includes('AS "computerKind"')) { fullReads++; return { rows: [structuredClone(snapshot)] } }
    if (sql.includes('SELECT path, md5(body)')) return { rows: [...workspace.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([path, row]) => ({ path, digest: digest(row.body), managed: row.managed })) }
    if (sql.includes('INSERT INTO agent_workspace')) { writes++; workspace.set(String(params[1]), { body: String(params[2]), managed: true, updated: writes }); return { rows: [] } }
    if (sql.includes('DELETE FROM agent_workspace')) { workspace.delete(String(params[2])); return { rows: [] } }
    return { rows: [{ id: snapshot.id }] }
  }
  t.mock.method(pool, 'connect', async () => ({ query, release() {} }))
  t.mock.method(redis, 'set', async () => { reports++; return 'OK' })
  t.after(() => { redis.disconnect(); sub.disconnect() })
  assert.equal((await applyPendingAgentResources(snapshot.id)).status, 'applied')
  assert.equal(writes, 2)
  const updated = [...workspace.values()].map(row => row.updated)
  sqls.length = 0
  assert.equal((await applyPendingAgentResources(snapshot.id)).status, 'applied')
  assert.equal((await applyPendingAgentResources(snapshot.id)).status, 'applied')
  assert.equal(sqls.filter(sql => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)).length, 0)
  assert.deepEqual([...workspace.values()].map(row => row.updated), updated)
  assert.equal(fullReads, 1, 'unchanged resource content is not reloaded')
  assert.equal(reports, 1, 'unchanged application does not rewrite its status')
  snapshot.name = 'Renamed agent'
  assert.equal((await applyPendingAgentResources(snapshot.id)).status, 'applied')
  assert.equal(writes, 2, 'a new resource version with unchanged files performs zero UPSERTs')
  snapshot.skills[0].files[1].body = 'v2'
  assert.equal((await applyPendingAgentResources(snapshot.id)).status, 'applied')
  assert.equal(writes, 3, 'only the changed attachment is upserted')
  // Workspace drift must invalidate the shortcut even with the same resource version.
  workspace.get('skills/sample/tool.txt')!.body = 'drift'
  assert.equal((await applyPendingAgentResources(snapshot.id)).status, 'applied')
  assert.equal(writes, 4)
  workspace.set('skills/sample/same.txt', { body: 'same', managed: false, updated: 0 })
  snapshot.skills[0].files.push({ path: 'same.txt', body: 'same' })
  assert.equal((await applyPendingAgentResources(snapshot.id)).status, 'applied')
  assert.equal(workspace.get('skills/sample/same.txt')!.managed, false, 'identical unowned files are not adopted')
  snapshot = { ...snapshot, skills: [] }
  sqls.length = 0
  assert.equal((await applyPendingAgentResources(snapshot.id)).status, 'applied')
  assert.equal(sqls.filter(sql => sql.includes('DELETE FROM agent_workspace')).length, 2)
  assert.deepEqual([...workspace.keys()].sort(), ['skills/custom/notes.txt', 'skills/sample/same.txt'])
  assert.equal((await applyPendingAgentResources(snapshot.id, 'stale')).status, 'failed')
  const beforeRetry = reports
  assert.equal((await applyPendingAgentResources(snapshot.id)).status, 'applied')
  assert.equal(reports, beforeRetry + 1, 'retry replaces the failure report even when files are unchanged')
})
