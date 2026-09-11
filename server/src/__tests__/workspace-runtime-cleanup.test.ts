import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { KubectlResult } from '../agents/runtime/orchestrator.js'
import type * as Cleanup from '../workspace-cleanup.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const ok: KubectlResult = { code: 0, out: '', err: '', timedOut: false }

// Execute the real deletion functions with a fake kubectl boundary, following
// the source-loading fixtures used by settings/fork-portability tests. No DB,
// Redis connection or local Kubernetes context is touched by these unit tests.
function runtimeFixture(run: (args: string[], opts: { timeoutMs: number; maxAttempts?: number }) => Promise<KubectlResult>) {
  const source = readFileSync(new URL('../agents/runtime/orchestrator.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('orchestrator.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['safeName', 'podName', 'chromeProfilePvcName', 'deletePod', 'deleteChromeProfilePvc']
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
  assert.equal(functions.length, names.length)
  const exports = {} as {
    deletePod: (id: string) => Promise<void>
    deleteChromeProfilePvc: (id: string) => Promise<void>
  }
  runInNewContext(ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, kubectlWithRetry: run })
  return exports
}

function cleanupFixture(runtime: ReturnType<typeof runtimeFixture>, agentIds = ['deleted-managed']) {
  const job = {
    id: 'cleanup-job', agent_ids: agentIds, storage_keys: [] as string[], attempts: 0,
    completed_at: null as string | null, last_error: null as string | null,
    available_at: 0, locked: false,
  }
  const warnings: string[] = []
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('WITH candidates AS')) {
        if (job.completed_at || job.locked || job.available_at > Date.now()) return { rows: [] }
        job.locked = true
        return { rows: [{ ...job }] }
      }
      if (sql.includes('SET completed_at = NOW()')) {
        job.completed_at = 'completed'
        job.last_error = null
        job.locked = false
      } else if (sql.includes('SET attempts = attempts + 1')) {
        job.attempts++
        job.available_at = Date.now() + Number(params[2])
        job.last_error = String(params[3])
        job.locked = false
      } else throw new Error('unexpected SQL: ' + sql)
      return { rows: [] }
    },
  }
  const exports = {} as typeof Cleanup
  const source = readFileSync(new URL('../workspace-cleanup.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, process: { pid: 1 },
    console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
    require: (id: string) => {
      if (id === 'node:crypto') return { randomUUID }
      if (id === './db/pool.js') return { pool }
      if (id === './settings.js') return {
        // Reproduce the persisted legacy false value: it must never skip Pods.
        automationEnabled: () => false,
        automationNumber: (key: string) => key === 'workspace_cleanup_retention_days' ? 0 : 8,
        createOperationsWorker: () => ({}),
      }
      if (id === './agents/runtime/orchestrator.js') return runtime
      if (id === './storage.js') return { normalizeStorageKey: (key: string) => key }
      if (id === './documents/rooms.js') return {}
      throw new Error('unexpected import: ' + id)
    },
  })
  return { job, warnings, drain: exports.drainWorkspaceCleanupJobs }
}

test('workspace cleanup ignores legacy opt-out and waits for Pod absence before PVC and completion', { timeout: 10_000 }, async () => {
  const podDeleted = deferred<KubectlResult>()
  const podStarted = deferred<void>()
  const pvcDeleted = deferred<KubectlResult>()
  const pvcStarted = deferred<void>()
  const calls: string[][] = []
  const runtime = runtimeFixture(async (args, opts) => {
    calls.push(args)
    assert.ok(args.includes('--ignore-not-found=true'))
    assert.ok(args.includes('--wait=true'))
    assert.ok(args.includes('--timeout=15s'))
    assert.equal(opts.timeoutMs, 20_000)
    assert.equal(opts.maxAttempts, 1, 'durable job owns retries')
    if (args[1] === 'pod') { podStarted.resolve(); return podDeleted.promise }
    pvcStarted.resolve()
    return pvcDeleted.promise
  })
  const f = cleanupFixture(runtime)
  const drain = f.drain()
  await podStarted.promise
  assert.equal(f.job.completed_at, null)
  assert.equal(calls.length, 1, 'PVC must wait until its Pod is gone')
  assert.equal(calls[0][2], 'agent-deleted-managed')
  podDeleted.resolve(ok)
  await pvcStarted.promise
  assert.equal(f.job.completed_at, null)
  pvcDeleted.resolve(ok)
  assert.equal((await drain).completed, 1)
  assert.equal(f.job.completed_at, 'completed')
})

for (const failure of [
  { name: 'forbidden', result: { code: 1, out: '', err: 'Forbidden: cannot delete pods', timedOut: false } },
  { name: 'API unavailable', result: { code: 1, out: '', err: 'connection refused', timedOut: false } },
  { name: 'kubectl timeout', result: { code: 124, out: '', err: 'killed after 20000ms timeout', timedOut: true } },
  { name: 'terminating Pod with finalizer', result: { code: 1, out: 'pod deleted', err: 'timed out waiting for the condition', timedOut: false } },
]) {
  test(`workspace cleanup persists ${failure.name}, logs failure and completes only after retry`, async () => {
    let failing = true
    const calls: string[] = []
    const f = cleanupFixture(runtimeFixture(async args => {
      calls.push(args[1])
      return failing ? failure.result : ok
    }))
    const failed = await f.drain()
    assert.equal(failed.failed, 1)
    assert.equal(failed.completed, 0)
    assert.equal(f.job.completed_at, null)
    assert.equal(f.job.attempts, 1)
    assert.equal(f.job.locked, false)
    assert.ok(f.job.available_at > Date.now())
    assert.match(f.job.last_error!, /pod deletion failed for deleted-managed/)
    assert.ok(f.job.last_error!.includes(failure.result.err))
    assert.ok(f.warnings.some(message => message.includes('cleanup-job') && message.includes(failure.result.err)))
    assert.deepEqual(calls, ['pod'])
    assert.equal((await f.drain()).claimed, 0, 'backoff is respected')
    failing = false
    f.job.available_at = 0
    assert.equal((await f.drain()).completed, 1)
    assert.equal(f.job.last_error, null)
    assert.deepEqual(calls, ['pod', 'pod', 'pvc'])
  })
}

test('workspace cleanup retries PVC failure after Pod is already absent', async () => {
  let failing = true
  const f = cleanupFixture(runtimeFixture(async args => args[1] === 'pvc' && failing
    ? { ...ok, code: 1, err: 'PVC deletion forbidden' } : ok))
  assert.equal((await f.drain()).failed, 1)
  assert.equal(f.job.completed_at, null)
  assert.match(f.job.last_error!, /chrome-profile PVC deletion failed/)
  failing = false
  f.job.available_at = 0
  assert.equal((await f.drain()).completed, 1)
})

test('workspace cleanup accepts already absent Pod and PVC without participant lookups', async () => {
  const f = cleanupFixture(runtimeFixture(async () => ok))
  assert.equal((await f.drain()).completed, 1)
  assert.equal(f.job.attempts, 0)
})

test('workspace cleanup settles every agent before releasing a failed job for retry', { timeout: 10_000 }, async () => {
  const held = deferred<void>()
  const started = deferred<void>()
  const f = cleanupFixture({
    async deletePod(id) {
      if (id === 'failed') throw new Error('delete failed')
      started.resolve()
      await held.promise
    },
    async deleteChromeProfilePvc() {},
  }, ['failed', 'slow'])
  const drain = f.drain()
  await started.promise
  assert.equal(f.job.locked, true)
  assert.equal(f.job.attempts, 0)
  held.resolve()
  assert.equal((await drain).failed, 1)
  assert.equal(f.job.completed_at, null)
  assert.equal(f.job.attempts, 1)
})

test('storage-only workspace cleanup never invokes Kubernetes', async () => {
  const f = cleanupFixture(runtimeFixture(async () => { throw new Error('unexpected Kubernetes call') }), [])
  assert.equal((await f.drain()).completed, 1)
})

test('standalone off-board PVC deletion preserves asynchronous deletion and kubectl retries', async () => {
  const runtime = runtimeFixture(async (args, opts) => {
    assert.ok(args.includes('--wait=false'))
    assert.equal(opts.maxAttempts, undefined)
    return ok
  })
  await runtime.deleteChromeProfilePvc('off-board-agent')
})
