/**
 * Unit tests for the unified fallback engine. isFallbackableError and
 * runWithFallback are pure — no DB, no settings snapshot needed.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-fallback.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFallbackableError, runWithFallback } from '../agents/fallback.js'

test('isFallbackableError: 402/429/5xx and transport errors advance the chain', () => {
  assert.equal(isFallbackableError(Object.assign(new Error('quota'), { status: 402 })), true)
  assert.equal(isFallbackableError(Object.assign(new Error('rate'), { status: 429 })), true)
  assert.equal(isFallbackableError(Object.assign(new Error('oops'), { status: 500 })), true)
  assert.equal(isFallbackableError(Object.assign(new Error('oops'), { status: 503 })), true)
  assert.equal(isFallbackableError(new Error('ECONNRESET')), true)
})

test('isFallbackableError: 400/401 surface immediately', () => {
  assert.equal(isFallbackableError(Object.assign(new Error('bad request'), { status: 400 })), false)
  assert.equal(isFallbackableError(Object.assign(new Error('unauthorized'), { status: 401 })), false)
  assert.equal(isFallbackableError(Object.assign(new Error('not found'), { status: 404 })), false)
})

test('runWithFallback: advances on fallbackable errors and returns the first success', async () => {
  const tried: string[] = []
  const r = await runWithFallback(['a', 'b', 'c'], async (model) => {
    tried.push(model)
    if (model !== 'c') throw Object.assign(new Error('boom'), { status: 429 })
    return `ok:${model}`
  })
  assert.equal(r, 'ok:c')
  assert.deepEqual(tried, ['a', 'b', 'c'])
})

test('runWithFallback: non-fallbackable error stops the chain immediately', async () => {
  const tried: string[] = []
  await assert.rejects(
    runWithFallback(['a', 'b'], async (model) => {
      tried.push(model)
      throw Object.assign(new Error('bad key'), { status: 401 })
    }),
    /bad key/,
  )
  assert.deepEqual(tried, ['a'])
})

test('runWithFallback: exhausted chain throws the last error', async () => {
  await assert.rejects(
    runWithFallback(['a', 'b'], async () => {
      throw Object.assign(new Error('down'), { status: 502 })
    }),
    /down/,
  )
})
