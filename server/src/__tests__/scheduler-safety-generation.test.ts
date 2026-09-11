import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { triageDisposition, deferTriage } from '../agents/triage-core.js'
import { inboxTriageBoundary } from '../agents/runtime/wake-options.js'
import { enqueueWakeJob } from '../agents/wake-queue.js'
import { wakeQueueFixture } from './wake-queue-fixture.js'

function fixture() {
  const source = readFileSync(new URL('../agents/scheduler.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('scheduler.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['triageWakeRecipient', 'renderTriageNote', 'wakeOneCaptured', 'scheduleWakeRetry',
    'postWakeRetryExhaustedNotice', 'wakeRetryId', '_shouldRetryWakeFailure', '_shouldRetryEnsurePodFailure',
    'triageRetryDelayMs', '_wakeRetryDelayMs']
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
    .map(node => node.getText(ast)).join('\n')
  const state = { generation: '3', paused: false, race: false }
  const inbox = [{ id: 'system-notice', conversation_id: 'room', kind: 'system', body: '{}' }]
  const consumed = new Set<string>(), statements: string[] = [], notices: any[] = []
  // Run the actual receipt transaction and safety comparison, including rollback.
  const query = async (sql: string, values: any[] = []) => {
    statements.push(sql.trim())
    if (sql.includes('FROM companies c JOIN participants p')) return { rows: [{ company_id: 'company' }] }
    if (sql.includes('FROM company_turn_safety')) return { rows: [{ ...state }] }
    if (sql.includes('INSERT INTO agent_message_consumptions')) for (const id of values[2]) consumed.add(id)
    return { rows: [] }
  }
  const clientSource = readFileSync(new URL('../agents/runtime/inproc-client.ts', import.meta.url), 'utf8')
  const clientAst = ts.createSourceFile('inproc.ts', clientSource, ts.ScriptTarget.Latest, true)
  const cls = clientAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'InProcRuntimeClient') as ts.ClassDeclaration
  const method = cls.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(clientAst) === 'markConversationRead')!
  const receiptCode = ts.transpileModule(`return new class { ${method.getText(clientAst)} }`, {}).outputText
  const receipts = new Function('pool', receiptCode)({ connect: async () => ({ query, release() {} }) })
  const queue = wakeQueueFixture()
  const deps = {
    inprocClient: { ...receipts, markConversationRead: receipts.markConversationRead.bind(receipts),
      loadPersona: async () => ({ companyId: 'company' }),
      loadInbox: async () => inbox.filter(row => !consumed.has(row.id)), loadContext: async () => [],
      postSystemNotice: async (notice: any) => { notices.push(notice); return { posted: true } } },
    turnAdmission: async () => ({ allowed: !state.paused, generation: state.generation, reason: state.paused ? 'emergency_stop' : null }),
    classifyInboxTriage: async () => {
      if (state.race) { state.generation = String(Number(state.generation) + 1); state.race = false }
      return { actionable: false, reason: 'system-only inbox', promptNote: '', source: 'system-only' }
    },
    triageDisposition, deferTriage, inboxTriageBoundary, enqueueWakeJob, redis: queue.store,
    automationNumber: (key: string) => key === 'triage_backoff_base_ms' ? 30_000 : 60_000,
    resolveAgentHost: async () => ({ status: 'resolved', kind: 'managed' }), isByoaKind: () => false,
    notifyAlert: async () => {}, WAKE_RETRY_QUEUE: 'cumora:wake-retry',
    MESSAGE_WAKE_RETRY_MAX_ATTEMPTS: 5, WAKE_RETRY_MAX_ATTEMPTS: 60,
  }
  const output = ts.transpileModule(functions + '\nexport { ' + names.join(', ') + ' }', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const api: Record<string, any> = {}
  new Function('exports', ...Object.keys(deps), output)(api, ...Object.values(deps))
  return { api, state, consumed, statements, notices, queue }
}

test('resumed company generation > 0 acknowledges a system-only inbox', async () => {
  const f = fixture()
  assert.equal(await f.api.triageWakeRecipient('agent'), null)
  assert.deepEqual([...f.consumed], ['system-notice'])
  assert.ok(f.statements.includes('COMMIT'))
})

test('durable departure receipt captures the resumed safety generation', async () => {
  const f = fixture()
  assert.equal(await f.api.triageWakeRecipient('agent', { conversationId: 'room', messageId: 'system-notice' }), null)
  assert.deepEqual([...f.consumed], ['system-notice'])
})

test('triage racing stop/resume rejects stale receipts and durably reschedules triage', async () => {
  const f = fixture()
  f.state.race = true
  assert.equal(await f.api.wakeOneCaptured('agent', 'message.new', 'room', null,
    { placementTriage: true, wakeMessageId: 'system-notice' }), false)
  assert.equal(f.consumed.size, 0)
  assert.ok(f.statements.includes('ROLLBACK'))
  const jobs = [...f.queue.hash('cumora:wake-retry:jobs').values()].map(raw => JSON.parse(raw))
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].failureClass, 'triage')
  assert.match(jobs[0].lastFailure, /triage receipt rejected: stale safety generation/)
  assert.equal(jobs[0].options.placementTriage, true)
  assert.equal(await f.api.wakeOneCaptured('agent', 'message.new', 'room', null, jobs[0].options, jobs[0].attempt), true)
  assert.deepEqual([...f.consumed], ['system-notice'])
})

test('paused company retains system inbox and exhaustion notice preserves failure phase', async () => {
  const f = fixture()
  f.state.paused = true
  const result = await f.api.triageWakeRecipient('agent')
  assert.equal(result.triageDeferred.outcome, 'defer')
  assert.equal(f.consumed.size, 0)
  await f.api.postWakeRetryExhaustedNotice('agent', 'room', 6, 'triage receipt rejected: stale safety generation', 'triage')
  assert.equal(f.notices[0].noticeKind, 'triage_retry_exhausted')
  assert.match(f.notices[0].text, /Agent inbox triage could not complete after 5 retries/)
  assert.match(f.notices[0].text, /triage receipt rejected: stale safety generation/)
})
