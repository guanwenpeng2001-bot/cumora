/**
 * Unit tests for the skill library's pure seams: pasted SKILL.md
 * parse+validate (the create-from-paste path) and the agent-skill state
 * mapping used by the editor's checkbox list.
 *
 * Run: node --import tsx --test server/src/__tests__/skill-library.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePastedSkill } from '../skill-library.js'

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
