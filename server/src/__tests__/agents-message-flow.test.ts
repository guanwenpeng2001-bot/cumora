import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { TurnMessageConsumption } from '../agents/message-consumption.js'
import { hasDraftDelivery, replyDraftId, resolveDeclaredAutoRelayTarget } from '../agents/auto-relay.js'
import { enqueueWakeJob, claimWakeJobs, finishWakeJob, renewWakeJob } from '../agents/wake-queue.js'
import { agentMessageConsumptionsChecksum } from '../db/migrations/0017-agent-message-consumptions.js'
import { SCHEMA_MIGRATIONS } from '../db/migrations/manifest.js'
import { wakeQueueFixture } from './wake-queue-fixture.js'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll(String.fromCharCode(13), '')
function compile(body: string, dependencies: Record<string, unknown>): any {
  const output = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(dependencies), output)(...Object.values(dependencies))
}
function receipt(conversationId: string, body: string) {
  return { event: 'message.posted', command: 'reply', visibleToUser: true,
    conversationId, messageId: `sent-${conversationId}`, draftId: replyDraftId(body) }
}

// Execute the production relay control flow with a real typed receipt channel.
function relayFixture(prior: ReturnType<typeof receipt>[], target: string, deliverReceipt = true) {
  const source = read('../agents/turn.ts')
  const start = source.indexOf('  // Model-declared assistant-text relay:')
  const end = source.indexOf('  // Otherwise:', start)
  assert.ok(start > 0 && end > start)
  const commands: string[] = []
  const body = 'Here is the final answer.'
  const run = compile(`return async function() {
    let finalStatus = 'completed', finalError = '', toolCallCount = 0
    let postedReplyViaTool = cliSideEffectsThisTurn.length > 0
    ${source.slice(start, end)}
    return { finalStatus, finalError, toolCallCount }
  }`, {
    pendingAssistantText: body, declaredTurnStatus: { assistantTextAction: 'reply', replyConversationId: target, reason: 'final' },
    cliSideEffectsThisTurn: [...prior], replySideEffectChannelUnreliable: false,
    hasDraftDelivery, resolveDeclaredAutoRelayTarget,
    inbox: [{ conversation_id: 'a' }, { conversation_id: 'b' }],
    runCompanyId: 'company', runId: 'run', agentId: 'agent', namespace: {},
    runtime: { recordEvent: async () => {} },
    bashOutputSideEffects: (output: any) => output.sideEffects ?? [],
    executePodTool: async (args: any) => {
      commands.push(JSON.parse(args.argsJson).command)
      return { ok: true, output: { sideEffects: deliverReceipt ? [receipt(target, body)] : [] } }
    },
  })
  return { run, commands }
}

for (const target of ['a', 'b']) test(`same turn progress in a does not suppress final relay to ${target}`, async () => {
  const f = relayFixture([receipt('a', 'Working on it.')], target)
  const result = await f.run()
  assert.equal(result.finalStatus, 'completed')
  assert.equal(f.commands.length, 1)
  assert.match(f.commands[0], new RegExp(`cumora reply ${target} `))
  assert.ok(f.commands[0].endsWith('--continue'))
})

test('a matching target plus draft receipt suppresses duplicate final delivery', async () => {
  const f = relayFixture([receipt('b', 'Here is the final answer.')], 'b')
  assert.equal((await f.run()).finalStatus, 'completed')
  assert.equal(f.commands.length, 0)
})

test('identical draft delivered to another conversation still relays to the declared target', async () => {
  const f = relayFixture([receipt('a', 'Here is the final answer.')], 'b')
  await f.run()
  assert.equal(f.commands.length, 1)
})

test('successful shell without a matching delivery receipt cannot complete relay', async () => {
  const f = relayFixture([], 'b', false)
  assert.equal((await f.run()).finalStatus, 'failed')
})

for (const scenario of ['failed', 'cancelled', 'completed']) test(`turn ${scenario} acknowledges only completed input, not queued or missing steers`, async () => {
  const source = read('../agents/turn.ts')
  const start = source.indexOf('    // Queued and injected are not completion.')
  const end = source.indexOf('    // Steering: also discard', start)
  const consumption = new TurnMessageConsumption()
  consumption.inject('initial', 'c')
  consumption.queue('queued-only', 'c')
  consumption.inject('steer-newer', 'c')
  consumption.inject('steer-older', 'c')
  const controller = new AbortController()
  if (scenario === 'cancelled') controller.abort()
  const reads: any[] = []
  const run = compile(`return async function() { ${source.slice(start, end)} }`, {
    consumption, finalStatus: scenario === 'failed' ? 'failed' : 'completed', options: { signal: controller.signal },
    markInitialInboxReadOnCompletion: false, postedReplyViaTool: true, declaredTurnStatus: { status: 'done' },
    isTerminalTurnStatus: () => true, fingerprint: 'f', rememberCompletedInbox: () => {}, agentId: 'agent', runtime: { markConversationRead: async (args: any) => { reads.push(args) } },
  })
  await run()
  assert.deepEqual(reads.map(row => row.consumedMessageIds), scenario === 'completed'
    ? [['initial', 'steer-newer', 'steer-older']] : [])
})

test('reply transaction does not acknowledge a new message that arrived during inference', async () => {
  const source = read('../agents/cli.ts')
  const start = source.indexOf('    await txClient.query(\n      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, attachment, quoted_message_id, company_id)')
  const end = source.indexOf('    await enqueueBroadcast', start)
  assert.ok(start > 0 && end > start)
  const statements: string[] = []
  const run = compile(`return async function() { ${source.slice(start, end)} }`, {
    txClient: { query: async (sql: string) => { statements.push(sql) } },
    messageId: 'reply', convoId: 'c', me: 'agent', finalBody: 'answer to A', sequence: 3,
    attachment: null, resolvedQuotedId: null, companyId: 'company',
  })
  await run()
  assert.equal(statements.length, 2)
  assert.ok(statements.every(sql => !/conversation_reads|agent_message_consumptions/.test(sql)))
})

test('worker death retains a leased payload and expired owners cannot ack or renew its reclaim', async () => {
  const f = wakeQueueFixture(), queue = 'q'
  await enqueueWakeJob(f.store, queue, 'm', { body: 'durable' }, 0)
  const [first] = await claimWakeJobs(f.store, queue, 0, 10)
  assert.equal(f.hash('q:jobs').size, 1)
  assert.deepEqual(await claimWakeJobs(f.store, queue, 299_999, 10), [])
  const [second] = await claimWakeJobs(f.store, queue, 300_000, 10)
  assert.notEqual(first.token, second.token)
  await finishWakeJob(f.store, queue, first)
  await renewWakeJob(f.store, queue, first, 900_000)
  assert.equal(f.sorted('q:due').get('m'), 600_000)
  await finishWakeJob(f.store, queue, second)
  assert.equal(f.hash('q:jobs').size, 0)
  await enqueueWakeJob(f.store, queue, 'm', { body: 'event replay' }, 600_000)
  assert.equal(f.hash('q:jobs').size, 0, 'fan-out replay cannot recreate a completed recipient')
})

test('migration receipt schema matches the appended immutable manifest', () => {
  const entry = SCHEMA_MIGRATIONS.find((m) => m.name.startsWith('0017_'))
  assert.ok(entry, '0017 receipt migration is registered')
  assert.equal(agentMessageConsumptionsChecksum(), entry.checksum)
})

function runtimeMethod(name: string, pool: unknown) {
  const source = read('../agents/runtime/inproc-client.ts')
  const ast = ts.createSourceFile('inproc.ts', source, ts.ScriptTarget.Latest, true)
  const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'InProcRuntimeClient') as ts.ClassDeclaration
  const method = cls.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name)!
  return compile(`return new class { ${method.getText(ast)} }`, { pool, refreshAttachmentUrls: async () => {} })
}

test('200 deferred messages cannot hide a new human from work selection or the independent admission probe', async () => {
  const old = Array.from({ length: 200 }, (_, i) => ({ id: `old-${i}`, conversation_id: 'c', author_kind: 'agent' }))
  const human = { id: 'new-human', conversation_id: 'c', author_kind: 'human' }
  const all = [...old, human]
  const client = runtimeMethod('loadInbox', { query: async (sql: string, values: any[]) => {
    // Exercise the production loader with an isolated relational result, and
    // verify both exclusions and priority are inside the SQL page boundaries.
    assert.ok(sql.indexOf('NOT (mm.id = ANY($2::text[]))') < sql.indexOf('LIMIT 200'))
    assert.match(sql, /ORDER BY EXISTS \(SELECT 1 FROM participants human/)
    assert.match(sql, /ORDER BY \(p.kind = 'human'\) DESC NULLS LAST/)
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM agent_message_consumptions/)
    const rows = all.filter(row => !values[1].includes(row.id) && (!values[2] || values[2].includes(row.id)))
      .sort((a, b) => Number(b.author_kind === 'human') - Number(a.author_kind === 'human')).slice(0, 200)
    return { rows }
  } })
  assert.deepEqual(await client.loadInbox('agent'), [human], 'old deferred batch is excluded from the work input')
  const source = read('../agents/runtime/pod-agent.ts')
  const ast = ts.createSourceFile('pod.ts', source, ts.ScriptTarget.Latest, true)
  const gate = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'admitInboxDrain')!
  const state = { inboxDeferred: { messageIds: old.map(row => row.id), retryAt: Date.now() + 60_000 } }
  const merged: any[] = []
  const admit = compile(`${gate.getText(ast)}; return admitInboxDrain`, {
    state, runtime: client, inboxRetryTimer: null, mergeTurnOptions: (options: any) => merged.push(options),
  })
  assert.equal(await admit('agent'), true)
  assert.deepEqual(merged[0].excludeInboxMessageIds, old.map(row => row.id))
  assert.equal(state.inboxDeferred.messageIds.length, 200, 'admitting new work preserves old deferred state')
  const consumption = new TurnMessageConsumption()
  for (const row of await client.loadInbox('agent', { excludeMessageIds: merged[0].excludeInboxMessageIds })) consumption.inject(row.id, row.conversation_id)
  assert.deepEqual([...consumption.finish(true).values()], [['new-human']])
})

test('exact consumption writes cannot advance a cursor over an unread gap, including legacy one-message calls', async () => {
  const ids: string[][] = []
  const handler = async (sql: string, values: any[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] }
    if (sql.includes('FROM companies c JOIN participants p')) return { rows: [{ company_id: 'co' }] }
    if (sql.includes('FROM company_turn_safety')) return { rows: [{ paused: false, generation: '0' }] }
    assert.match(sql, /m.id = ANY\(\$3::text\[\]\)/)
    assert.match(sql, /p.company_id = c.company_id/)
    assert.match(sql, /ON CONFLICT DO NOTHING/)
    assert.doesNotMatch(sql, /INSERT INTO conversation_reads|UPDATE conversation_reads/)
    ids.push(values[2])
    return { rows: [] }
  }
  const fakePool = {
    query: handler,
    connect: async () => ({ query: handler, release: () => {} }),
  }
  const client = runtimeMethod('markConversationRead', fakePool)
  await client.markConversationRead({ agentId: 'a', conversationId: 'c', upToMessageId: 'newer', consumedMessageIds: ['older', 'newer'] })
  await client.markConversationRead({ agentId: 'a', conversationId: 'c', upToMessageId: 'latest' })
  assert.deepEqual(ids, [['older', 'newer'], ['latest']])
})

for (const state of ['not_applied', 'unknown', 'applied']) test(`ensurePod reports ${state} when preparation throws at that stage`, async () => {
  const source = read('../agents/runtime/orchestrator.ts')
  const ast = ts.createSourceFile('orchestrator.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ensurePod')!
  const ensure = compile(`${fn.getText(ast).replace(/^export /, '')}; return ensurePod`, {
    inFlight: new Map(), ENSURE_POD_WATCHDOG_MS: 1000, notifyAlert: async () => {},
    ensurePodImpl: async (_agent: string, _signal: unknown, _triage: unknown, progress: any) => {
      progress.value = state
      throw Error('injected failure')
    },
  })
  assert.equal((await ensure('agent')).applyState, state)
})

for (const observed of ['offline', 'missing', 'Running', 'Pending', 'Failed']) test(`Pod reconciliation ${observed} distinguishes uncertainty from absence`, async () => {
  const source = read('../agents/runtime/orchestrator.ts')
  const ast = ts.createSourceFile('orchestrator.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'probePodApplication')!
  const probe = compile(`${fn.getText(ast).replace(/^export /, '')}; return probePodApplication`, {
    podName: (id: string) => id,
    parsePodHealth: (raw: string) => ({ phase: JSON.parse(raw).status?.phase }),
    stuckPendingReason: () => null,
    kubectlWithRetry: async () => ({ code: observed === 'offline' ? 1 : 0,
      out: observed === 'missing' ? '' : JSON.stringify({ status: { phase: observed } }) }),
  })
  assert.equal(await probe('a'), observed === 'offline' ? 'unknown'
    : observed === 'missing' ? 'not_applied' : observed === 'Failed' ? 'recoverable' : 'applied')
})

for (const failPersistence of [false, true]) test(`outbox ${failPersistence ? 'retains' : 'publishes'} message event only after durable scheduler handoff`, async () => {
  const source = read('../realtime-outbox.ts')
  const ast = ts.createSourceFile('outbox.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'drainRealtimeOutbox')!
  const order: string[] = []
  const drain = compile(`${fn.getText(ast).replace(/^export /, '')}; return drainRealtimeOutbox`, {
    cleanupTerminalRows: async () => {}, discardExpired: async () => 0, BATCH_SIZE: 32,
    claimBatch: async () => [{ id: 'outbox', channel: 'message', payload: { type: 'message.new', message: { id: 'm' } } }],
    markPublished: async () => { order.push('completed') }, markFailed: async () => { order.push('retained') },
  })
  const result = await drain({ publishFn: async () => { order.push('published') },
    persistWakeFn: async () => { order.push('persisted'); if (failPersistence) throw Error('Redis unavailable') },
  })
  assert.deepEqual(order, failPersistence ? ['persisted', 'retained'] : ['persisted', 'published', 'completed'])
  assert.equal(result.failed, Number(failPersistence))
})

test('failed consumption receipt does not cache completion and hide the retryable inbox', async () => {
  const source = read('../agents/turn.ts')
  const start = source.indexOf('    // Queued and injected are not completion.')
  const end = source.indexOf('    // Steering: also discard', start)
  const consumption = new TurnMessageConsumption()
  consumption.inject('unread', 'c')
  let remembered = false
  const run = compile(`return async function() { ${source.slice(start, end)} }`, {
    consumption, finalStatus: 'completed', options: {}, markInitialInboxReadOnCompletion: true,
    postedReplyViaTool: false, declaredTurnStatus: null, agentId: 'a', fingerprint: 'f',
    rememberCompletedInbox: () => { remembered = true },
    runtime: { markConversationRead: async () => { throw Error('receipt unavailable') } },
  })
  await run()
  assert.equal(remembered, false)
})
