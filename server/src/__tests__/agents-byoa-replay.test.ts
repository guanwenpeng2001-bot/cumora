import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

function source(path: string) {
  return ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
}
function methods(path: string, className: string, names: string[]) {
  const ast = source(path)
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === className) as ts.ClassDeclaration
  return cls.members.filter(n => n.name && names.includes(n.name.getText(ast))).map(n => n.getText(ast)).join('\n')
}
function compile(code: string, globals: Record<string, unknown>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(globals), js)(...Object.values(globals))
}

// Exercise the real orchestration methods, including their catch/finally blocks.
function turnFixture(result: { exitCode: number; error?: string } | Error, cancelReason?: string, admissionStopped = false) {
  const requests: { path: string; body: any }[] = []
  let receipts = 0
  let admissionCalls = 0
  let engineCalls = 0
  let cancellation: Promise<void> | undefined
  const runner = compile(`return new class { ${methods('../agents/computer/daemon.ts', 'AgentRunner',
    ['runTurn', 'maybeAgendaTurn', 'admitSafety', 'emergencyCancel', 'finishCancelledTurn', 'ackSeen', 'assertRunning'])} }`, {
    api: async () => admissionStopped && ++admissionCalls > 1
      ? { allowed: false, generation: '1', reason: 'emergency_stop' }
      : { allowed: true, generation: '0' },
    runtimeBest: async (_url: string, path: string, _token: string, body: unknown) => {
      requests.push({ path, body })
      if (path === '/conversation/mark-read') receipts++
      return path === '/runs' ? { runId: 'run-test' } : { ok: true }
    },
    runtimeGet: async (_url: string, path: string) => path === '/agenda' ? { actionable: true, brief: 'task' } : { roster: '' },
    setInterval: () => ({ unref() {} }), clearInterval() {},
    AGENDA_QUIET_MS: 0, AGENDA_CHECK_MS: 0, TYPING_REFRESH_MS: 1000,
    acquireRunnerSlot: async () => {}, bigBrainSem: { release() {}, queueDepth: 0 },
    spawnPacer: { gate: async () => {}, onOk() {}, onRateLimited() {}, intervalMs: 0 },
    typingConversation: () => 'c', wakeHasActionableInput: () => true,
    triageDisposition: (v: unknown) => v, mergeWakeBackgroundBriefs: (a: unknown) => a,
    classifyTurnOutcome: (error: unknown) => error ? 'failed' : 'ok',
    redactProviderSecret: (v: unknown) => v, usageFromClaude: (v: unknown) => v,
    console: { log() {}, warn() {}, error() {} },
  })
  Object.assign(runner, {
    cfg: { serverUrl: 'fake' }, agent: { id: 'agent', model: 'model' }, adapter: { id: 'codex' },
    token: 'token', teardown: new AbortController(), pendingRerun: false, turnCancelled: false, safetyGeneration: '0',
    lastTurnEndedAt: 0, lastAgendaCheckAt: 0,
    reporter: { flush: async () => {} },
    applyPendingResources: async () => true, ensureToken: async () => {},
    snapshotUnread: async () => ({ seen: new Map([['c', ['m1', 'm2']]]), displayed: new Map([['c', ['m2']]]), digest: 'inputs', hasReal: true, projectIds: [] }),
    inboxTriage: async () => ({ outcome: 'act', ackAllowed: false }),
    memoryDigest: async () => '', formatTriageNote: () => '', chatDelta: () => '', agendaDelta: () => '',
    beatRun: () => () => {}, visibleEngineError: (_code: number, error?: string) => error || 'nonzero engine exit',
    mustResetSession: () => false, applyTurnBackoff: () => {},
    publishEngineFailure: async () => { requests.push({ path: '/notices', body: { noticeKind: 'byoa_engine_failed' } }) },
    runWithSessionRecovery: async () => {
      engineCalls++
      if (cancelReason) cancellation = runner.emergencyCancel('1', cancelReason)
      if (result instanceof Error) throw result
      return result
    },
  })
  return { runner, requests, receipts: () => receipts, engineCalls: () => engineCalls, cancellation: () => cancellation }
}

for (const path of ['runTurn', 'maybeAgendaTurn']) {
  test(`BYOA ${path}: stop observed at admission before SSE is a cancellation`, async () => {
    const f = turnFixture({ exitCode: 0 }, undefined, true)
    await f.runner[path]('test')
    assert.equal(f.engineCalls(), 0)
    assert.equal(f.receipts(), 0)
    assert.equal(f.requests.find(r => r.path.endsWith('/finish'))?.body.summary, 'aborted_by_user')
    assert.equal(f.requests.find(r => r.path.endsWith('/finish'))?.body.status, 'skipped')
    assert.equal(f.requests.filter(r => r.path === '/notices').length, 0)
  })
  for (const result of [{ exitCode: 1, error: 'engine killed' }, { exitCode: 0 }, new Error('AbortError')]) {
    test(`BYOA ${path}: user cancellation is audited and never becomes engine failure (${result instanceof Error ? 'throw' : result.exitCode})`, async () => {
      const f = turnFixture(result, 'aborted_by_user')
      await f.runner[path]('test')
      await f.cancellation()
      const finish = f.requests.find(r => r.path.endsWith('/finish'))?.body
      assert.equal(finish?.status, 'skipped')
      assert.equal(finish?.summary, 'aborted_by_user')
      assert.equal(finish?.error, null)
      assert.equal(f.requests.filter(r => r.path === '/notices').length, 0)
      assert.equal(f.requests.find(r => r.path === '/events')?.body.kind, 'turn.cancelled')
      assert.equal(f.requests.find(r => r.path === '/stop-confirmed')?.body.generation, '1')
      assert.equal(f.receipts(), 0, 'cancelled inputs must remain replayable')
    })
  }
}
test('BYOA failed turns retain inputs; successful replay commits only displayed message IDs', async () => {
  for (const result of [{ exitCode: 1, error: 'provider failed' }, { exitCode: 1 }, new Error('spawn failed')]) {
    const f = turnFixture(result)
    await f.runner.runTurn('test')
    assert.equal(f.receipts(), 0)
    assert.equal(f.requests.find(r => r.path.endsWith('/finish'))?.body.status, 'failed')
    assert.equal(f.requests.filter(r => r.path === '/notices').length, 1)
  }
  const replay = turnFixture({ exitCode: 0 })
  await replay.runner.runTurn('replay')
  assert.deepEqual(replay.requests.find(r => r.path === '/conversation/mark-read')?.body.consumedMessageIds, ['m2'])
})
test('BYOA safety validation outage is distinct from a user cancellation', async () => {
  const f = turnFixture(new Error('AbortError'), 'safety_validation_failed')
  await f.runner.runTurn('test')
  assert.equal(f.requests.find(r => r.path.endsWith('/finish'))?.body.summary, 'safety_validation_failed')
  assert.equal(f.receipts(), 0)
})

test('receipt commit rejects paused or stale turns before consuming any message', async () => {
  for (const safety of [{ paused: true, generation: '1' }, { paused: false, generation: '2' }]) {
    const writes: string[] = []
    const query = async (sql: string) => {
      if (sql.includes('FOR SHARE OF c')) return { rows: [{ company_id: 'co' }] }
      if (sql.includes('FROM company_turn_safety')) return { rows: [safety] }
      writes.push(sql)
      return { rows: [] }
    }
    const client = compile(`return new class { ${methods('../agents/runtime/inproc-client.ts', 'InProcRuntimeClient', ['markConversationRead'])} }`, {})
    await assert.rejects(client.markConversationRead({ agentId: 'a', conversationId: 'c', upToMessageId: 'm2', consumedMessageIds: ['m2'], safetyGeneration: '1' }, { query }), /turn stopped; retaining unfinished inputs/)
    assert.deepEqual(writes, [])
  }
})

// Opt in only to the explicitly named disposable test container. TEMP tables
// shadow the application tables; the transaction rolls back even on assertion failure.
test('PostgreSQL: ack cursor cannot hide unconsumed inputs; exact receipts preserve gaps and delivery scope', {
  skip: !process.env.BYOA_REPLAY_TEST_DOCKER,
}, async () => {
  assert.equal(process.env.BYOA_REPLAY_TEST_DOCKER, 'cumora-test-pg')
  const statements: { sql: string; args: unknown[] }[] = []
  const query = async (sql: string, args: unknown[] = []) => {
    statements.push({ sql, args })
    return { rows: sql.includes('FOR SHARE OF c') ? [{ company_id: 'co' }] : [], rowCount: 1 }
  }
  const client = compile(`return new class { ${methods('../agents/runtime/inproc-client.ts', 'InProcRuntimeClient', ['loadInbox', 'markConversationRead'])} }`, { pool: { query }, refreshAttachmentUrls: async () => {} })
  await client.loadInbox('a', { onlyMessageIds: ['m1', 'm2', 'm3', 'delivery', 'foreign'] })
  const inbox = statements[0]
  const cli = source('../agents/cli.ts')
  const functions = cli.statements.filter(n => ts.isFunctionDeclaration(n) && ['loadInbox', 'cmdAck'].includes(n.name?.text ?? '')).map(n => n.getText(cli)).join('\n')
  const cliFns = compile(`${functions}; return {loadInbox,cmdAck}`, { pool: { query }, freshenRowAttachment: async () => {}, resolveAs: () => 'a', agentCompany: async () => 'co', clearHold: async () => {}, ok: (s: string) => s })
  await cliFns.loadInbox('a')
  const cliInbox = statements.at(-1)!
  await cliFns.cmdAck({ positional: ['c'], flags: {} })
  const ack = statements.at(-1)!
  await client.markConversationRead({ agentId: 'a', conversationId: 'c', upToMessageId: 'm3', consumedMessageIds: ['m2', 'foreign'] }, { query })
  const receipt = statements.at(-1)!
  await client.markConversationRead({ agentId: 'a', conversationId: 'c', upToMessageId: 'm3' }, { query })
  const legacyReceipt = statements.at(-1)!
  const literal = (v: unknown): string => v == null ? 'NULL' : Array.isArray(v) ? `ARRAY[${v.map(literal).join(',')}]::text[]` : `'${String(v).replaceAll("'", "''")}'`
  const bind = (s: typeof inbox) => s.sql.replace(/\$(\d+)/g, (_m, n) => literal(s.args[Number(n) - 1]))
  const expectIds = (s: typeof inbox, ids: string[]) => `DO $$ BEGIN ASSERT (SELECT array_agg(id ORDER BY id) FROM (${bind(s)}) q) = ${literal([...ids].sort())}, 'unexpected inbox visibility'; END $$;`
  const sql = `BEGIN;
    CREATE TEMP TABLE companies(id text PRIMARY KEY);
    CREATE TEMP TABLE participants(id text PRIMARY KEY, company_id text, kind text, name text, departed_at timestamptz);
    CREATE TEMP TABLE conversations(id text PRIMARY KEY, company_id text, title text, kind text, topic text, project_id text);
    CREATE TEMP TABLE conversation_members(conversation_id text,company_id text,participant_id text);
    CREATE TEMP TABLE conversation_reads(user_id text,conversation_id text,last_read_at timestamptz,last_read_message_id text,PRIMARY KEY(user_id,conversation_id));
    CREATE TEMP TABLE projects(id text,name text);
    CREATE TEMP TABLE conversation_mutes(user_id text,conversation_id text,muted_until timestamptz);
    CREATE TEMP TABLE messages(id text PRIMARY KEY,conversation_id text,company_id text,author_id text,body text,kind text,sequence integer,created_at timestamptz,attachment jsonb,poll jsonb,quoted_message_id text,delivery_recipient_id text);
    CREATE TEMP TABLE agent_message_consumptions(agent_id text,message_id text,PRIMARY KEY(agent_id,message_id));
    INSERT INTO companies VALUES ('co'),('other');
    INSERT INTO participants(id,company_id,kind) VALUES ('a','co','agent'),('h','co','human'),('other','other','human');
    INSERT INTO conversations(id,company_id,kind) VALUES ('c','co','group'),('delivered','co','group'),('foreign-c','other','group');
    INSERT INTO conversation_members VALUES ('c','co','a'),('foreign-c','other','a');
    INSERT INTO messages(id,conversation_id,company_id,author_id,body,kind,created_at) SELECT id,'c','co','h',id,'text',NOW()-INTERVAL '1 hour' FROM unnest(ARRAY['m1','m2','m3']) id;
    INSERT INTO messages(id,conversation_id,company_id,author_id,kind,created_at,delivery_recipient_id) VALUES ('delivery','delivered','co','h','system',NOW()-INTERVAL '1 hour','a'),('foreign','foreign-c','other','other','text',NOW(),NULL);
    INSERT INTO conversation_reads VALUES ('a','delivered',NOW(),'z');
    ${bind(ack)};
    DO $$ BEGIN ASSERT (SELECT count(*) FROM agent_message_consumptions)=0, 'ack fabricated receipts'; END $$;
    ${expectIds(inbox, ['m1', 'm2', 'm3', 'delivery'])}
    ${expectIds(cliInbox, ['m1', 'm2', 'm3', 'delivery'])}
    ${bind(receipt)};
    ${bind(receipt)};
    DO $$ BEGIN ASSERT (SELECT array_agg(message_id) FROM agent_message_consumptions)=ARRAY['m2'], 'receipt crossed a gap or tenant'; END $$;
    ${expectIds(inbox, ['m1', 'm3', 'delivery'])}
    ${bind(legacyReceipt)};
    ${expectIds(inbox, ['m1', 'delivery'])}
    ROLLBACK; SELECT 'BYOA_REPLAY_SQL_OK';`
  const output = execFileSync(process.env.BYOA_REPLAY_DOCKER_BIN || 'docker', ['exec', '-i', 'cumora-test-pg', 'psql', '-U', 'postgres', '-d', 'postgres', '-XAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', windowsHide: true })
  assert.match(output, /BYOA_REPLAY_SQL_OK/)
})
