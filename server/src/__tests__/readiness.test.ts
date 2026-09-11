import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReadinessCheck } from '../readiness.js'

test('readiness succeeds for available dependencies and recovers after failure', async () => {
  let failed = true
  const ready = createReadinessCheck(async () => { if (failed) throw new Error('unavailable') })
  assert.equal(await ready(), false)
  failed = false
  assert.equal(await ready(), true)
})

test('readiness bounds hung dependencies and coalesces probes until underlying work settles', async () => {
  let finish!: () => void
  let calls = 0
  const ready = createReadinessCheck(() => {
    calls++
    return new Promise<void>(resolve => { finish = resolve })
  }, 20)
  assert.deepEqual(await Promise.all([ready(), ready()]), [false, false])
  assert.equal(await ready(), false)
  assert.equal(calls, 1, 'timed-out probes cannot accumulate pool acquisitions')
  finish()
  assert.equal(await ready(), true)
  const next = ready()
  await Promise.resolve()
  assert.equal(calls, 2, 'subsequent probes refresh dependencies')
  finish()
  assert.equal(await next, true)
})
