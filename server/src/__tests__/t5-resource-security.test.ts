import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pool } from '../db/pool.js'
import { refreshServerSettings } from '../settings.js'
import { validateLibraryManifest, importLocalSkill, listLocalHub, installFromHub, searchHub } from '../skill-library.js'
import { validateConnector } from '../mcp-connectors.js'

const body = '---\nname: actual-skill\ndescription: fixture\n---\nBody'
const manifest = () => ({ name: 'actual-skill', description: 'fixture', files: [{ path: 'SKILL.md', body }] })

test('manifest validation rejects malicious paths, invalid shapes, conflicts and size/count limits', () => {
  validateLibraryManifest(manifest())
  for (const path of ['../secret', '/secret', 'C:/secret', 'a' + String.fromCharCode(92) + 'secret', './a', 'a//b', 'a/./b', 'a\0b', 'CON.txt', 'a.', 'a ']) {
    assert.throws(() => validateLibraryManifest({ ...manifest(), files: [...manifest().files, { path, body: '' }] }), { status: 400 }, path)
  }
  for (const bad of [
    null, {}, { ...manifest(), name: 1 }, { ...manifest(), description: {} },
    { ...manifest(), files: [null] }, { ...manifest(), files: [{ path: 'SKILL.md', body: 2 }] },
    { ...manifest(), files: [] }, { ...manifest(), files: Array(101).fill(manifest().files[0]) },
    { ...manifest(), files: [...manifest().files, { path: 'big.txt', body: '中'.repeat(90_000) }] },
    { ...manifest(), files: [...manifest().files, { path: 'skill.md', body }] },
    { ...manifest(), files: [...manifest().files, { path: 'dir', body: '' }, { path: 'dir/file.txt', body: '' }] },
    { ...manifest(), name: 'different' },
  ]) assert.throws(() => validateLibraryManifest(bad), { status: 400 })
})

test('MCP validates booleans, string maps, transport fields and URLs', () => {
  const stdio = { name: 'test', type: 'stdio', command: 'node' }
  const http = { name: 'test', type: 'http', url: 'https://example.invalid/mcp' }
  for (const enabled of [null, 0, 'false', {}]) assert.ok(validateConnector({ ...stdio, enabled }))
  for (const value of [null, 1, true, [], {}]) {
    assert.ok(validateConnector({ ...stdio, env: { TOKEN: value } }))
    assert.ok(validateConnector({ ...http, headers: { Authorization: value } }))
  }
  for (const extra of [{ args: ['secret'] }, { args: 'bad' }, { env: { TOKEN: 'secret' } }, { env: null }, { command: 'node' }]) {
    assert.ok(validateConnector({ ...http, ...extra }))
  }
  assert.ok(validateConnector({ ...stdio, command: ' ' }))
  assert.ok(validateConnector({ ...http, url: 'http://' }))
  assert.equal(validateConnector({ ...http, args: [], env: {}, enabled: false, headers: { Authorization: 'secret' } }), null)
})

test('local import uses directory identifier and rejects traversal, links and missing/unavailable hubs', async (t) => {
  const old = process.env.LOCAL_SKILLHUB_PATH
  t.after(() => { if (old === undefined) delete process.env.LOCAL_SKILLHUB_PATH; else process.env.LOCAL_SKILLHUB_PATH = old })
  const parent = await mkdtemp(join(tmpdir(), 't5-resource-security-'))
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 't5-local-'))
  process.env.LOCAL_SKILLHUB_PATH = root
  await mkdir(join(root, 'directory-label'))
  await writeFile(join(root, 'directory-label', 'SKILL.md'), body)
  let writes = 0
  t.mock.method(pool, 'query', async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT')) {
      // A fresh snapshot must win over whatever revision an earlier test (or a
      // real DB refresh) installed — installSnapshot rejects lower revisions.
      if (sql.includes('server_settings')) return { rows: [{ key: '__settings_revision', value: String(Date.now()) }] }
      return { rows: [] }
    }
    assert.ok(sql.includes('INSERT INTO skills'))
    writes++
    return { rows: [{ id: params[0], company_id: params[1], name: params[2], description: params[3],
      source: params[4], hub_id: params[5], files: JSON.parse(params[6] as string), created_at: new Date() }] }
  })
  await refreshServerSettings(true)
  const entries = await listLocalHub('company-a')
  assert.equal(entries[0].name, 'directory-label')
  assert.equal(entries[0].directory, 'directory-label')
  assert.equal(entries[0].skillName, 'actual-skill')
  assert.equal((await importLocalSkill('company-a', entries[0].name)).name, 'actual-skill')
  assert.equal(writes, 1)
  for (const name of ['..', '../other', '/absolute', 'C:/absolute', 'a' + String.fromCharCode(92) + 'b', 'directory-label/SKILL.md']) {
    await assert.rejects(importLocalSkill('company-a', name), { status: 400 })
  }
  await assert.rejects(importLocalSkill('company-a', 'missing'), { status: 404 })
  const outside = await mkdtemp(join(parent, 't5-outside-'))
  await writeFile(join(outside, 'SKILL.md'), body)
  await symlink(outside, join(root, 'escape'), 'junction')
  await assert.rejects(importLocalSkill('company-a', 'escape'), { status: 400 })
  await symlink(outside, join(root, 'directory-label', 'nested'), 'junction')
  await assert.rejects(importLocalSkill('company-a', 'directory-label'), { status: 400 })
  assert.equal(writes, 1)
  process.env.LOCAL_SKILLHUB_PATH = join(root, 'unavailable')
  await refreshServerSettings(true)
  await assert.rejects(listLocalHub('company-a'), { status: 503 })
  process.env.LOCAL_SKILLHUB_PATH = ''
  await refreshServerSettings(true)
  await assert.rejects(listLocalHub('company-a'), { status: 409 })
})

test('hub errors are stable and invalid manifests never write to DB', async (t) => {
  const old = process.env.SKILLHUB_URL
  t.after(() => { if (old === undefined) delete process.env.SKILLHUB_URL; else process.env.SKILLHUB_URL = old })
  let writes = 0
  t.mock.method(pool, 'query', async () => { writes++; throw new Error('unexpected DB write') })
  process.env.SKILLHUB_URL = ''
  await assert.rejects(installFromHub('company-a', 'skill'), { status: 409 })
  await assert.rejects(searchHub('skill'), { status: 409 })
  process.env.SKILLHUB_URL = 'https://hub.invalid'
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
  await assert.rejects(installFromHub('company-a', 'skill'), { status: 404 })
  fetchMock.mock.mockImplementation(async () => { throw new TypeError('network down') })
  await assert.rejects(installFromHub('company-a', 'skill'), { status: 503 })
  await assert.rejects(searchHub('skill'), { status: 503 })
  fetchMock.mock.mockImplementation(async () => new Response('', { status: 500 }))
  await assert.rejects(installFromHub('company-a', 'skill'), { status: 503 })
  fetchMock.mock.mockImplementation(async () => new Response('not json'))
  await assert.rejects(installFromHub('company-a', 'skill'), { status: 400 })
  fetchMock.mock.mockImplementation(async () => Response.json({ ...manifest(), files: [...manifest().files, { path: '../escape', body: '' }] }))
  await assert.rejects(installFromHub('company-a', 'skill'), { status: 400 })
  await assert.rejects(installFromHub('company-a', 'https://evil.invalid'), { status: 400 })
  assert.equal(writes, 0)
})
