import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import ts from 'typescript'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as compaction from '../agents/turn-compaction.js'
import * as streams from '../agents/turn-stream.js'
import { chatResponseStream } from '../novita.js'

// Load the actual private consumers and executor with isolated I/O dependencies.
export function compile(source: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', 'require', ...Object.keys(globals), output)(exports, (name: string) => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`)
    return dependencies[name]
  }, ...Object.values(globals))
  return exports
}
export const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
export function fixture(behavior: (request: any, signal?: AbortSignal) => AsyncIterable<any>, protocol = 'responses', timeoutMs = 30_000) {
  const records: any[] = [], requests: any[] = []
  const config = { roles: [
    { role: 'brain', models: ['same', 'brain-backup'] },
    { role: 'support', models: ['same', 'support-backup'] },
    ...['completion-verify', 'compaction', 'steer-summary'].map(purpose => ({ role: 'compaction', purpose, models: ['same', `${purpose}-backup`] })),
  ], models: [], routes: [] }
  let current = { revision: '17', settings: { llm_config: JSON.stringify(config), compaction_stream_timeout_ms: String(timeoutMs), agent_turn_timeout_ms: '0' }, sources: {} }
  const snapshots = new AsyncLocalStorage<typeof current>()
  const settings = { getServerSettingsSnapshot: () => snapshots.getStore() ?? current,
    parseLlmConfig: JSON.parse, readLlmModelTarget: (model: string) => ({ requestModel: model }), LLM_ROLES: ['brain', 'support', 'compaction'] }
  const resolver = compile(read('../llm-resolver.ts'), {
    './settings.js': settings, './env.js': { resolveDirectLlmEnv: () => ({ configured: true, protocol }) },
    './tenant-llm-context.js': { bindRoleCallAuth: () => {} }, './sub2api.js': { sub2apiRoutingConfigured: () => false, sub2apiConfigured: () => false, keyedPlatforms: () => [], dashscopeMediaRole: () => null, supportsDashscopeChatAudio: () => false },
    './agents/model-config.js': { REASONING_EFFORTS: new Set(['none']), parseAgentModelConfig: () => null },
  })
  const fallback = compile(read('../agents/fallback.ts'), { '../settings.js': {} })
  const cost = compile(read('../agents/cost.ts'), { './token-usage.js': compile(read('../agents/token-usage.ts'), {}), '../model-pricing.js': { captureDbPricing: () => () => null, refreshModelPricing: async () => {}, seedPriceFor: () => null }, 'node:crypto': { createHash } })
  const create = async (request: any, options: any) => {
    requests.push({ ...request, signal: options?.signal })
    return behavior(request, options?.signal)
  }
  let clientOverride: (() => Promise<any>) | null = null
  const llm = { getLlmCandidateClient: async () => clientOverride ? clientOverride() : ({ responses: { create }, chat: { completions: { create } } }) }
  const execution = compile(read('../llm-execution.ts'), {
    './tenant-llm-context.js': { validateRoleCallAuth: async (plan: any) => { assert.equal(plan.authorizationVersion, undefined) } },
    './db/pool.js': { pool: { query: async () => { throw new Error('Unexpected auxiliary DB access') } } },
    'node:crypto': { randomUUID }, './llm-resolver.js': resolver, './llm.js': llm,
    './agents/fallback.js': fallback, './agents/cost.js': cost, './settings.js': settings,
    './agents/llm-ledger.js': { recordLlmCall: async (r: any) => records.push(r), classifyLlmCallError: () => 'failed' },
  })
  const source = read('../agents/turn.ts')
  const names = ['executeAuxiliaryStream', 'verifyTerminalCompletion', 'summarizeHistoryItems', 'summarizeSteerBatch',
    'utf8Head', 'executeAgentTurnHop', 'contextWindowFor', 'resolveContextWindow', 'hardLimitFor', 'stripImageInputs', 'isImageFetchFailure',
    'isModelProviderConnectionError', 'isModelProviderConnectionText', 'formatItemsForSummary', 'extractJsonObject', 'parseCompletionVerification', 'verifierSideEffects', 'renderSteerBatchTruncated', 'renderSteerBatchVerbatim']
  const ast = ts.createSourceFile('turn.ts', source, ts.ScriptTarget.Latest, true)
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n')
  const turn = compile(functions + '\nexport { ' + names.join(', ') + ' }', {
    '../llm-resolver.js': resolver, '../llm-execution.js': execution, '../llm.js': llm, './cost.js': cost,
    './turn-compaction.js': compaction, './fallback.js': fallback, '../novita.js': {},
  }, { chatResponseStream, ...compaction, ...streams, ...resolver, ...execution, ...llm, ...cost, ...fallback, getServerSettingsSnapshot: settings.getServerSettingsSnapshot,
    traceResponseOutputItem: () => ({}), errorText: (error: unknown) => String(error) })
  return { turn, records, requests, resolver, settings, snapshots,
    setClient: (factory: () => Promise<any>) => { clientOverride = factory },
    refresh: () => { current = { ...current, revision: '18', settings: { ...current.settings, llm_config: JSON.stringify({ ...config, roles: config.roles.map(r => ({ ...r, models: r.models.map(m => `new-${m}`) })) }) } } } }
}
export const failure = () => Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
export const batch = Array.from({ length: 8 }, () => ({ authorName: 'Alice', conversationId: 'c-one', body: 'Please deliver ' + 'x'.repeat(1000) }))
export function invoke(turn: any, purpose: string) {
  if (purpose === 'completion-verify') return turn.verifyTerminalCompletion({ persona: { name: 'Agent', model: 'same' }, tenant: null, agentId: 'a', renderedContext: 'work', turnStatus: { status: 'done' }, sideEffects: [] })
  if (purpose === 'compaction') return turn.summarizeHistoryItems([{ type: 'function_call_output', call_id: '1', output: 'work' }], { name: 'Agent', model: 'same' }, null, 'a')
  return turn.summarizeSteerBatch(batch, { name: 'Agent', model: 'same' }, null, 'a', 'draft')
}
