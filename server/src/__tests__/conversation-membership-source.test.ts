import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const serverSource = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function productionTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__integration__' || entry.name === 'migrations') continue
      files.push(...await productionTypeScriptFiles(path))
    } else if (extname(entry.name) === '.ts') {
      files.push(path)
    }
  }
  return files
}

test('production authorization and routing never use the JSONB membership projection', async () => {
  const violations: string[] = []
  for (const path of await productionTypeScriptFiles(serverSource)) {
    // Migration 0001 is frozen historical SQL and deliberately retains its
    // old containment index and compatibility helpers. Normalize to POSIX
    // separators — path.relative() yields backslashes on Windows and the
    // comparison below must hold on every dev machine.
    const rel = relative(serverSource, path).replaceAll('\\', '/')
    if (rel === 'db/migrate.ts') continue
    const source = await readFile(path, 'utf8')
    for (const pattern of [
      /members\s*@>/g,
      /jsonb_array_length\([^\n]*members/g,
      /jsonb_array_elements_text\([^\n]*members/g,
      /\.members\.includes\(/g,
    ]) {
      if (pattern.test(source)) violations.push(`${rel}: ${pattern.source}`)
    }
  }
  assert.deepEqual(violations, [])
})
