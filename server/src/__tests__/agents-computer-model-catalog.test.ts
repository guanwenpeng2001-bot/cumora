/**
 * Generic BYOA model-catalog parsing.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-model-catalog.test.ts
 */
import { test } from 'node:test'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readClaudeUserSettings, withClaudeUserSettingsEnv } from '../agents/computer/claude-user-settings.js'
import { clearModelCatalogCache, discoverEngineModelCatalog, parseListedModels } from '../agents/computer/model-catalog.js'

test('OpenCode catalog keeps provider-qualified model ids and deduplicates them', () => {
  assert.deepEqual(
    parseListedModels('anthropic/claude-sonnet-4-6\nopenai/gpt-5.5\nanthropic/claude-sonnet-4-6\n', 'provider'),
    [
      { id: 'anthropic/claude-sonnet-4-6', label: 'anthropic/claude-sonnet-4-6', description: null, recommendedFor: undefined },
      { id: 'openai/gpt-5.5', label: 'openai/gpt-5.5', description: null, recommendedFor: undefined },
    ],
  )
})

test('pi catalog accepts provider/model output and a provider plus model table', () => {
  const out = parseListedModels(
    'Provider Model Context\nanthropic claude-sonnet-4-6 200k\nopenai/gpt-5.5:high\n',
    'pi',
  )
  assert.deepEqual(out.map((model) => model.id), [
    'anthropic/claude-sonnet-4-6',
    'openai/gpt-5.5:high',
  ])
})

test('Cursor catalog accepts bullets and ignores headings', () => {
  const out = parseListedModels('Available models\n* auto\n- claude-4.6-sonnet\n  gpt-5.5\n', 'cursor')
  assert.deepEqual(out.map((model) => model.id), ['auto', 'claude-4.6-sonnet', 'gpt-5.5'])
})

test('Claude custom-provider settings expose only core bootstrap values and model defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-claude-catalog-'))
  const configDir = join(root, 'config')
  await mkdir(configDir)
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({
    model: 'provider/opus-large',
    env: {
      ANTHROPIC_AUTH_TOKEN: 'settings-token',
      ANTHROPIC_BASE_URL: 'https://provider.example.test',
      ANTHROPIC_SMALL_FAST_MODEL: 'provider/haiku-small',
      UNRELATED_SECRET: 'do-not-import',
    },
  }), 'utf8')
  const env = { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_AUTH_TOKEN: 'explicit-token' }
  try {
    const settings = readClaudeUserSettings(env)
    assert.deepEqual(settings, {
      turnEnv: {},
      turnSettings: {},
      coreEnv: {
        ANTHROPIC_AUTH_TOKEN: 'settings-token',
        ANTHROPIC_BASE_URL: 'https://provider.example.test',
        ANTHROPIC_SMALL_FAST_MODEL: 'provider/haiku-small',
      },
      defaultModel: 'provider/opus-large',
      defaultFastModel: 'provider/haiku-small',
      prefersLocalDefault: true,
    })
    const merged = withClaudeUserSettingsEnv(env)
    assert.equal(merged.ANTHROPIC_AUTH_TOKEN, 'explicit-token')
    assert.equal(merged.ANTHROPIC_BASE_URL, 'https://provider.example.test')
    assert.equal(merged.UNRELATED_SECRET, undefined)

    clearModelCatalogCache()
    const catalog = await discoverEngineModelCatalog('claude', '/fixture/claude', true, env)
    assert.equal(catalog.defaultModel, 'provider/opus-large')
    assert.equal(catalog.defaultFastModel, 'provider/haiku-small')
    assert.equal(catalog.prefersLocalDefault, true)
    assert.equal(catalog.source, 'cli')
    assert.deepEqual(catalog.models.map((model) => model.id), [
      'provider/opus-large',
      'provider/haiku-small',
    ])
    assert.doesNotMatch(JSON.stringify(catalog), /settings-token|provider\.example\.test/)

    const modern = await discoverEngineModelCatalog('claude', '/fixture/claude', true, {
      ...env, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'provider/current-haiku',
    })
    assert.equal(modern.defaultFastModel, 'provider/current-haiku')
    assert.equal(modern.models.some(model => model.id === 'provider/current-haiku'), true)
    assert.equal('turnSettings' in modern, false)
    assert.equal('turnEnv' in modern, false)
  } finally {
    clearModelCatalogCache()
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude settings ignore a relative config-root override instead of reading from cwd', () => {
  assert.deepEqual(readClaudeUserSettings({ CLAUDE_CONFIG_DIR: 'relative/config' }), {
    coreEnv: {},
    turnEnv: {},
    turnSettings: {},
    defaultModel: null,
    defaultFastModel: null,
    prefersLocalDefault: false,
  })
})

test('Antigravity catalog parses tab-separated models, ignores fetching banner, and marks recommendations', () => {
  const output = [
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  ].join('\n')

  const out = parseListedModels(output, 'antigravity')
  assert.deepEqual(out, [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', description: null, recommendedFor: ['small'] },
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)', description: null, recommendedFor: ['big'] },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', description: null, recommendedFor: ['big'] },
  ])
})

test('CLI prose and punctuated diagnostics are not model ids', () => {
  for (const style of ['cursor', 'antigravity'] as const) {
    for (const output of [
      'No models available for this account.',
      'Error: not authenticated. Run login.',
      'Failed to fetch models: connect ETIMEDOUT',
      'Es sind keine Modelle verfügbar.',
      '该账户没有可用的模型',
      'Error:  authentication required',
      'Warning:\trequest failed',
    ]) assert.deepEqual(parseListedModels(output, style), [])
  }
  assert.deepEqual(parseListedModels('auto\ngpt-5.5\n', 'cursor').map(m => m.id), ['auto', 'gpt-5.5'])
})

test('Antigravity accepts space-aligned labels', () => {
  assert.deepEqual(parseListedModels('gemini-3.8-flash-high   Gemini 3.8 Flash (High)', 'antigravity'), [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', description: null, recommendedFor: ['small'] },
  ])
})

test('failed CLI discovery preserves the last valid catalog and can recover', async (t) => {
  let output = 'gpt-5.5\n'
  let stderr = 'stderr-only-model\n'
  let code: number | null = 0
  let spawnError = false
  let probes = 0
  t.mock.method(childProcess, 'spawn', () => {
    probes++
    if (spawnError) throw new Error('spawn failed')
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    queueMicrotask(() => {
      child.stdout.end(output)
      child.stderr.end(stderr)
      child.emit('close', code)
    })
    return child
  })
  syncBuiltinESMExports()
  clearModelCatalogCache()
  try {
    const bin = '/fixture/catalog-cli'
    const good = await discoverEngineModelCatalog('cursor', bin, true)
    assert.equal(good.source, 'cli')
    assert.deepEqual(good.models.map(m => m.id), ['gpt-5.5'])

    // Expired successful entries remain a fallback, without refreshing their age on failure.
    const now = Date.now()
    t.mock.method(Date, 'now', () => now + 16 * 60 * 1000)
    output = 'invalid-but-model-shaped\n'
    code = 1
    assert.deepEqual(await discoverEngineModelCatalog('cursor', bin), good)
    const beforeRetry = probes
    assert.deepEqual(await discoverEngineModelCatalog('cursor', bin), good)
    assert.equal(probes, beforeRetry + 1)
    code = null
    assert.deepEqual(await discoverEngineModelCatalog('cursor', bin, true), good)
    code = 0
    output = 'No models available for this account.'
    assert.deepEqual(await discoverEngineModelCatalog('cursor', bin, true), good)
    output = ''
    assert.deepEqual(await discoverEngineModelCatalog('cursor', bin, true), good)
    spawnError = true
    assert.deepEqual(await discoverEngineModelCatalog('cursor', bin, true), good)
    spawnError = false

    // A different CLI path cannot inherit this entry; an engine with presets keeps them.
    output = 'No models available for this account.'
    const empty = await discoverEngineModelCatalog('cursor', '/fixture/other-cli', true)
    assert.equal(empty.source, 'presets')
    assert.deepEqual(empty.models, [])
    const preset = await discoverEngineModelCatalog('antigravity', bin, true)
    assert.equal(preset.source, 'presets')
    assert.equal(preset.models[0]?.id, 'gemini-3.8-flash-high')
    code = 1
    output = 'invalid-but-model-shaped'
    assert.equal((await discoverEngineModelCatalog('antigravity', bin, true)).source, 'presets')

    code = 0
    output = 'gpt-5.6'
    stderr = 'another-stderr-model'
    const recovered = await discoverEngineModelCatalog('cursor', bin, true)
    assert.equal(recovered.source, 'cli')
    assert.deepEqual(recovered.models.map(m => m.id), ['gpt-5.6'])
  } finally {
    clearModelCatalogCache()
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})
