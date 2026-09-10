import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, rmdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, test } from 'node:test'
import { ENGINE_IDS, type EngineSkill, getAdapter, seedEngineSkills } from '../agents/computer/engine.js'

const roots: string[] = []
const manifestName = '.cumora-managed-files.json'
const fullBody = '---\nname: example\ndescription: Example skill\n---\n\n# Full instructions\nRead references/data.txt and run scripts/check.js.\n完整正文，不应截断。\n'
const skill: EngineSkill = {
  name: 'example', description: 'Example skill', files: [
    { path: 'SKILL.md', body: fullBody },
    { path: 'references/data.txt', body: '附件数据\n' },
    { path: 'scripts/check.js', body: 'console.log("fixture only")\n' },
  ],
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-t25-skills-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(root))
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel))
    await rm(root, { recursive: true, force: true })
  }
})

for (const engine of ENGINE_IDS) {
  test(`${engine}: persona paths resolve to full skill and attachments, refreshed on reseed`, async () => {
    const home = await fixture()
    const adapter = getAdapter(engine)
    const persona = { id: 'fixture', name: 'Fixture', role: null, systemPrompt: null, skills: [skill] }
    await adapter.seedHome(home, persona)
    const personaFile = engine === 'claude' ? 'CLAUDE.md' : engine === 'gemini' ? 'GEMINI.md' : engine === 'qwen' ? 'QWEN.md' : 'AGENTS.md'
    const text = await readFile(join(home, personaFile), 'utf8')
    const path = text.match(/read `([^`]+\/example\/SKILL.md)`/)?.[1]
    assert.ok(path, 'persona must point to the actual skill file')
    const native = ['codex', 'grok', 'antigravity'].includes(engine) ? 'agents' : engine
    assert.equal(path, `.${native}/skills/example/SKILL.md`)
    const actualSkill = join(home, path)
    assert.equal(await readFile(actualSkill, 'utf8'), fullBody)
    for (const file of skill.files.slice(1)) assert.equal(await readFile(join(dirname(actualSkill), file.path), 'utf8'), file.body)
    await adapter.seedHome(home, { ...persona, skills: [{ ...skill, files: [{ path: 'SKILL.md', body: fullBody + '\nUpdated' }] }] })
    assert.equal(await readFile(actualSkill, 'utf8'), fullBody + '\nUpdated')
    await assert.rejects(lstat(join(dirname(actualSkill), 'references/data.txt')), { code: 'ENOENT' })
    await adapter.seedHome(home, { ...persona, skills: [] })
    await assert.rejects(lstat(actualSkill), { code: 'ENOENT' })
    assert.doesNotMatch(await readFile(join(home, personaFile), 'utf8'), /example\/SKILL.md/)
  })
}

test('cleanup preserves user skills, legacy directories and untracked files inside a managed skill', async () => {
  const home = await fixture()
  const root = join(home, '.agents/skills')
  for (const name of ['personal', 'legacy-empty']) await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, 'personal/SKILL.md'), 'user-owned')
  await seedEngineSkills(home, '.agents/skills', [skill])
  await writeFile(join(root, 'example/notes.txt'), 'user notes')
  // A new invocation must recover ownership from disk, including nested attachments.
  await seedEngineSkills(home, '.agents/skills', [])
  assert.equal(await readFile(join(root, 'personal/SKILL.md'), 'utf8'), 'user-owned')
  assert.equal(await readFile(join(root, 'example/notes.txt'), 'utf8'), 'user notes')
  assert.ok((await lstat(join(root, 'legacy-empty'))).isDirectory())
  for (const file of skill.files) await assert.rejects(lstat(join(root, 'example', file.path)), { code: 'ENOENT' })
  assert.deepEqual(JSON.parse(await readFile(join(root, manifestName), 'utf8')), { version: 1, files: [] })
})

test('same-name legacy skill cannot be silently claimed or overwritten', async () => {
  const home = await fixture()
  const root = join(home, '.agents/skills')
  await mkdir(join(root, 'example'), { recursive: true })
  await writeFile(join(root, 'example/SKILL.md'), 'legacy body')
  await assert.rejects(seedEngineSkills(home, '.agents/skills', [skill]), /unowned skill file/)
  assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), 'legacy body')
  await assert.rejects(lstat(join(root, manifestName)), { code: 'ENOENT' })
})

test('rejects traversal, Windows aliases, duplicate and overlapping files before materializing', async () => {
  const home = await fixture()
  for (const path of ['', '../escape', '/absolute', 'C:/drive', 'C:drive', String.raw`\\server\share`, './dot', 'a//b', 'a/../b', String.raw`a\b`, 'a:stream', 'a\0b', 'a\nb', 'a./b', 'a /b', 'NUL', 'CON.txt', 'com1/data', 'lpt9.txt']) {
    await assert.rejects(seedEngineSkills(home, '.agents/skills', [{ ...skill, files: [{ path, body: 'bad' }] }]), /Unsafe skill file/, JSON.stringify(path))
  }
  for (const name of ['../escape', 'con', 'nul', 'COM1', 'has/slash']) {
    await assert.rejects(seedEngineSkills(home, '.agents/skills', [{ ...skill, name }]), /skill name/)
  }
  for (const paths of [['SKILL.md', 'skill.md'], ['a', 'a/b']]) {
    await assert.rejects(seedEngineSkills(home, '.agents/skills', [{ ...skill, files: paths.map((path) => ({ path, body: 'x' })) }]), /Duplicate|conflict/)
  }
  await assert.rejects(seedEngineSkills(home, '../escape', [skill]), /Unsafe skills directory/)
  assert.deepEqual(await readdir(home), [])
})

test('invalid ownership manifests cannot authorize cleanup', async () => {
  const home = await fixture()
  const root = join(home, '.agents/skills')
  await mkdir(root, { recursive: true })
  await writeFile(join(home, 'sentinel'), 'keep')
  for (const contents of ['{', 'null', JSON.stringify({ version: 2, files: [] }), JSON.stringify({ version: 1, files: ['../../sentinel'] }), JSON.stringify({ version: 1, files: ['example/a', 'example/A'] })]) {
    await writeFile(join(root, manifestName), contents)
    await assert.rejects(seedEngineSkills(home, '.agents/skills', []))
    assert.equal(await readFile(join(home, 'sentinel'), 'utf8'), 'keep')
    assert.equal(await readFile(join(root, manifestName), 'utf8'), contents)
  }
})

test('skill ancestors and stale attachment junctions cannot redirect writes or cleanup', async () => {
  const base = await fixture()
  const outside = join(base, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'data.txt'), 'outside sentinel')
  for (const linked of ['.agents', '.agents/skills', '.agents/skills/example', '.agents/skills/example/references']) {
    const home = join(base, `home-${roots.length}-${linked.split('/').length}`)
    await mkdir(dirname(join(home, linked)), { recursive: true })
    await symlink(outside, join(home, linked), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(seedEngineSkills(home, '.agents/skills', [skill]), /Unsafe skill directory/)
    assert.equal(await readFile(join(outside, 'data.txt'), 'utf8'), 'outside sentinel')
    assert.deepEqual(await readdir(outside), ['data.txt'])
  }
  const home = join(base, 'stale')
  await seedEngineSkills(home, '.agents/skills', [skill])
  const attachment = join(home, '.agents/skills/example/references')
  await rm(join(attachment, 'data.txt'))
  await rmdir(attachment)
  await symlink(outside, attachment, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(seedEngineSkills(home, '.agents/skills', []), /Unsafe skill directory/)
  assert.equal(await readFile(join(outside, 'data.txt'), 'utf8'), 'outside sentinel')
})

test('file and manifest symlinks are rejected without touching their targets', async () => {
  const base = await fixture()
  const outside = join(base, 'outside.txt')
  await writeFile(outside, 'outside sentinel')
  for (const linked of [manifestName, 'example/SKILL.md']) {
    const home = join(base, linked === manifestName ? 'manifest-home' : 'file-home')
    const target = join(home, '.agents/skills', linked)
    await mkdir(dirname(target), { recursive: true })
    await symlink(outside, target, 'file')
    await assert.rejects(seedEngineSkills(home, '.agents/skills', [skill]), /Unsafe skill/)
    assert.equal(await readFile(outside, 'utf8'), 'outside sentinel')
    assert.ok((await lstat(target)).isSymbolicLink())
  }
})

test('failed cleanup keeps ownership for a safe retry after the linked file is removed', async () => {
  const home = await fixture()
  const root = join(home, '.agents/skills')
  await seedEngineSkills(home, '.agents/skills', [skill])
  const before = await readFile(join(root, manifestName), 'utf8')
  const outside = join(home, 'outside.txt')
  await writeFile(outside, 'keep')
  const target = join(root, 'example/references/data.txt')
  await rm(target)
  await symlink(outside, target, 'file')
  await assert.rejects(seedEngineSkills(home, '.agents/skills', []), /Unsafe skill file/)
  assert.equal(await readFile(join(root, manifestName), 'utf8'), before)
  assert.equal(await readFile(join(root, 'example/SKILL.md'), 'utf8'), fullBody)
  await rm(target)
  await seedEngineSkills(home, '.agents/skills', [])
  assert.equal(await readFile(outside, 'utf8'), 'keep')
  assert.deepEqual(JSON.parse(await readFile(join(root, manifestName), 'utf8')).files, [])
})

test('a journal from an interrupted seed can be completed and stale files removed', async () => {
  const home = await fixture()
  const root = join(home, '.agents/skills')
  await seedEngineSkills(home, '.agents/skills', [skill])
  const manifest = join(root, manifestName)
  const saved = JSON.parse(await readFile(manifest, 'utf8')) as { version: number; files: string[] }
  saved.files.push('example/new.txt')
  await writeFile(manifest, JSON.stringify(saved))
  await seedEngineSkills(home, '.agents/skills', [{ ...skill, files: [skill.files[0], { path: 'new.txt', body: 'new content' }] }])
  assert.equal(await readFile(join(root, 'example/new.txt'), 'utf8'), 'new content')
  await assert.rejects(lstat(join(root, 'example/scripts/check.js')), { code: 'ENOENT' })
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')).files, ['example/SKILL.md', 'example/new.txt'])
})
