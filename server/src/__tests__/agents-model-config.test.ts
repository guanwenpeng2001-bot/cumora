/**
 * Unit tests for per-agent model_config parsing + fallback-chain assembly.
 * Pure functions, no DB.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-model-config.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentModelConfig, validateAgentModelConfig, agentTurnChain } from '../agents/model-config.js'

// ── parseAgentModelConfig ─────────────────────────────────────────────────

test('parse: non-objects and empty objects yield null', () => {
  assert.equal(parseAgentModelConfig(null), null)
  assert.equal(parseAgentModelConfig(undefined), null)
  assert.equal(parseAgentModelConfig('high'), null)
  assert.equal(parseAgentModelConfig([1, 2]), null)
  assert.equal(parseAgentModelConfig({}), null)
  assert.equal(parseAgentModelConfig({ unknown: 'field' }), null)
})

test('parse: valid fields survive, invalid ones are dropped', () => {
  assert.deepEqual(
    parseAgentModelConfig({ effort: 'high', maxOutputTokens: 8000, thinking: false, contextWindow: 256000 }),
    { effort: 'high', maxOutputTokens: 8000, thinking: false, contextWindow: 256000 },
  )
  // wrong types dropped
  assert.deepEqual(parseAgentModelConfig({ effort: 5, maxOutputTokens: 'x' }), null)
  assert.deepEqual(parseAgentModelConfig({ maxOutputTokens: -1, contextWindow: 0 }), null)
})

test('parse: fallbackModels dedupes, trims, drops empties', () => {
  assert.deepEqual(
    parseAgentModelConfig({ fallbackModels: [' a ', 'a', '', 5, 'b'] }),
    { fallbackModels: ['a', 'b'] },
  )
  // all-empty list → field dropped → null config
  assert.equal(parseAgentModelConfig({ fallbackModels: [] }), null)
})

// ── agentTurnChain ────────────────────────────────────────────────────────

test('agentTurnChain: explicit agent chain wins outright', () => {
  assert.deepEqual(
    agentTurnChain('k3', { fallbackModels: ['deepseek-v4-flash'] }, ['k3', 'k3-256k']),
    ['k3', 'deepseek-v4-flash'],
  )
  // primary duplicated in the explicit list is deduped
  assert.deepEqual(
    agentTurnChain('k3', { fallbackModels: ['k3', 'x'] }, []),
    ['k3', 'x'],
  )
})

test('agentTurnChain: empty agent chain follows the global brain chain behind the pinned model', () => {
  assert.deepEqual(
    agentTurnChain('pinned-model', null, ['k3', 'k3-256k']),
    ['pinned-model', 'k3', 'k3-256k'],
  )
  // global primary === pinned → no self-dup
  assert.deepEqual(agentTurnChain('k3', null, ['k3', 'k3-256k']), ['k3', 'k3-256k'])
})

test('agentTurnChain: nothing to follow → null (client-side global fallback handles it)', () => {
  assert.equal(agentTurnChain('k3', null, []), null)
  assert.equal(agentTurnChain('k3', null, ['k3']), null)
  assert.equal(agentTurnChain('k3', {}, ['k3']), null)
})

test('cerebellum writes trim models and clear inheritance; invalid values are rejected', () => {
  assert.deepEqual(validateAgentModelConfig({ cerebellumModel: ' cloud-small ' }), { cerebellumModel: 'cloud-small' })
  assert.equal(validateAgentModelConfig({ cerebellumModel: '  ' }), null)
  assert.throws(() => validateAgentModelConfig({ cerebellumModel: 123 }), /cerebellumModel/)
  assert.equal(parseAgentModelConfig({ cerebellumModel: 123 }), null)
})
