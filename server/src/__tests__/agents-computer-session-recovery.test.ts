import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runWithSessionRecovery } from '../agents/computer/session-recovery.js'

test('a missing resume target is cleared and retried fresh exactly once', async () => {
  const attempts: Array<string | null> = []
  let resets = 0
  const result = await runWithSessionRecovery({
    resumeSessionId: 'stale-id',
    run: async (resume) => {
      attempts.push(resume)
      return resume
        ? { exitCode: 1, executionPhase: 'not-started', error: 'No conversation found with session ID: stale-id' }
        : { exitCode: 0, sessionId: 'fresh-id' }
    },
    reset: async () => { resets += 1 },
  })

  assert.deepEqual(attempts, ['stale-id', null])
  assert.equal(resets, 1)
  assert.equal(result.sessionId, 'fresh-id')
})

test('a failed fresh retry is returned without a third attempt', async () => {
  const attempts: Array<string | null> = []
  const result = await runWithSessionRecovery({
    resumeSessionId: 'stale-id',
    run: async (resume) => {
      attempts.push(resume)
      return resume
        ? { exitCode: 1, executionPhase: 'not-started', error: 'session not found' }
        : { exitCode: 1, error: 'fresh start also failed' }
    },
    reset: async () => {},
  })

  assert.deepEqual(attempts, ['stale-id', null])
  assert.equal(result.failure?.kind, 'unknown')
})

test('ambiguous failures are never replayed', async () => {
  for (const error of [
    'process exited with code 137',
    'engine turn exceeded timeout',
    'read ECONNRESET',
    'failed to resume: ECONNRESET',
    'unable to resume: unauthorized',
    'failed to resume: Internal error',
    'unknown provider error',
  ]) {
    let attempts = 0
    let resets = 0
    const result = await runWithSessionRecovery({
      resumeSessionId: 'existing-id',
      run: async () => { attempts += 1; return { exitCode: 1, error } },
      reset: async () => { resets += 1 },
    })
    assert.equal(attempts, 1, error)
    assert.equal(resets, 0, error)
    assert.notEqual(result.failure?.kind, 'resume-not-found', error)
  }
})

test('a fresh turn never enters resume recovery', async () => {
  let attempts = 0
  const result = await runWithSessionRecovery({
    resumeSessionId: null,
    run: async () => { attempts += 1; return { exitCode: 1, error: 'session not found' } },
    reset: async () => assert.fail('fresh turn must not reset a session'),
  })
  assert.equal(attempts, 1)
  assert.equal(result.failure?.kind, 'unknown')
})


test('a missing-session message without proof of non-submission never authorizes replay', async () => {
  for (const executionPhase of [undefined, 'prompt-submitted', 'effects-possible', 'completed'] as const) {
    let attempts = 0
    const result = await runWithSessionRecovery({
      resumeSessionId: 'existing-id',
      run: async () => { attempts++; return { exitCode: 1, executionPhase, error: 'session not found' } },
      reset: async () => assert.fail('submitted work must retain its session'),
    })
    assert.equal(attempts, 1)
    assert.equal(result.executionPhase, executionPhase)
  }
})

test('cancellation during missing-session recovery prevents the fresh attempt', async () => {
  const abort = new AbortController()
  let attempts = 0
  await assert.rejects(runWithSessionRecovery({
    signal: abort.signal,
    resumeSessionId: 'missing-id',
    run: async () => { attempts++; return { exitCode: 1, executionPhase: 'not-started', error: 'session not found' } },
    reset: async () => { abort.abort() },
  }), { name: 'AbortError' })
  assert.equal(attempts, 1)
})
