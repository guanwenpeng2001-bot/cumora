import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { SweepTarget } from '../db-gc.js'

function harness(days = 1) {
  const queries: { sql: string; params: unknown[] }[] = []
  const dependencies: Record<string, unknown> = {
    './env.js': { env: new Proxy({}, { get: (_target, key) => String(key).endsWith('_DAYS') ? days : 0 }) },
    './metrics.js': { inc: () => {} },
    './db/pool.js': { pool: { connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params })
        return sql.startsWith('SELECT') ? { rows: [{ pk: 'expired' }] } : { rows: [], rowCount: 1 }
      },
      release: () => {},
    }) } },
  }
  const source = readFileSync(new URL('../db-gc.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const exports = {} as {
    targets(): SweepTarget[]
    runDbGcTick(opts: { batchSize: number; maxBatchesPerTable: number }): Promise<Record<string, number>>
  }
  new Function('require', 'exports', outputText)((name: string) => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`)
    return dependencies[name]
  }, exports)
  return { ...exports, queries }
}

test('GC sweep selects by time and deletes by primary key within bounded transactions', async () => {
  const h = harness()
  const targets = h.targets()
  assert.ok(targets.length > 0)
  const deleted = await h.runDbGcTick({ batchSize: 1, maxBatchesPerTable: 2 })
  for (const t of targets) {
    const selects = h.queries.filter(({ sql }) => sql.startsWith(`SELECT ${t.pkCol} AS pk FROM ${t.table}\n`))
    assert.equal(selects.length, 2)
    for (const { sql, params } of selects) {
      assert.ok(sql.includes(`WHERE ${t.timeCol} <`))
      assert.ok(sql.includes(`ORDER BY ${t.timeCol} ASC`))
      assert.deepEqual(params, [1, 1])
    }
    assert.equal(deleted[t.table], 2)
    assert.equal(h.queries.filter(({ sql }) => sql === `DELETE FROM ${t.table} WHERE ${t.pkCol} = ANY($1)`).length, 2)
  }
  assert.equal(h.queries.filter(({ sql }) => sql === 'COMMIT').length, targets.length * 2)
})

test('GC retention zero still disables every sweep without opening a transaction', async () => {
  const h = harness(0)
  assert.deepEqual(await h.runDbGcTick({ batchSize: 1, maxBatchesPerTable: 2 }), {})
  assert.deepEqual(h.queries, [])
})
