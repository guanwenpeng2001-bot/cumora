import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { EngineId, EngineRunResult } from '../agents/computer/engine.js'
import { runWithSessionRecovery } from '../agents/computer/session-recovery.js'
import { EngineSessionStore } from '../agents/computer/session-store.js'

test('Claude to Codex to Claude never crosses session ownership and recovers a stale Claude session', async () => {
  const sessionsDir = await mkdtemp(join(tmpdir(), 'cumora-engine-hot-switch-'))
  const agentId = 'atlas-a745'
  const claude = new EngineSessionStore(sessionsDir, agentId, 'claude')
  const codex = new EngineSessionStore(sessionsDir, agentId, 'codex')
  const attempts: Array<{ engine: EngineId; resumeSessionId: string | null }> = []

  try {
    await claude.save('claude-session-old')

    // Claude becomes unavailable. The replacement Codex runner must see only
    // Codex-owned state and therefore starts a fresh thread.
    const codexResume = await codex.load()
    assert.equal(codexResume, null)
    const codexResult = await runWithSessionRecovery({
      resumeSessionId: codexResume,
      run: async (resumeSessionId): Promise<EngineRunResult> => {
        attempts.push({ engine: 'codex', resumeSessionId })
        return { exitCode: 0, sessionId: 'codex-session-new' }
      },
      reset: () => codex.save(null),
    })
    await codex.save(codexResult.sessionId ?? null)

    // When Claude returns, its runner restores the original Claude pointer,
    // never the Codex id. A stale target is cleared and this turn retries once.
    const claudeResume = await claude.load()
    assert.equal(claudeResume, 'claude-session-old')
    const claudeResult = await runWithSessionRecovery({
      resumeSessionId: claudeResume,
      run: async (resumeSessionId): Promise<EngineRunResult> => {
        attempts.push({ engine: 'claude', resumeSessionId })
        return resumeSessionId
          ? { exitCode: 1, executionPhase: 'not-started', error: `No conversation found with session ID: ${resumeSessionId}` }
          : { exitCode: 0, sessionId: 'claude-session-fresh' }
      },
      reset: () => claude.save(null),
    })
    await claude.save(claudeResult.sessionId ?? null)
    await Promise.all([claude.flush(), codex.flush()])

    assert.deepEqual(attempts, [
      { engine: 'codex', resumeSessionId: null },
      { engine: 'claude', resumeSessionId: 'claude-session-old' },
      { engine: 'claude', resumeSessionId: null },
    ])
    assert.equal(attempts.some(({ engine, resumeSessionId }) => engine === 'claude' && resumeSessionId === 'codex-session-new'), false)
    assert.equal(await readFile(claude.sessionFile, 'utf8'), 'claude-session-fresh\n')
    assert.equal(await readFile(codex.sessionFile, 'utf8'), 'codex-session-new\n')
  } finally {
    await rm(sessionsDir, { recursive: true, force: true })
  }
})

test('switching onto kimi never resumes a Claude or Codex session id', async () => {
  const sessionsDir = await mkdtemp(join(tmpdir(), 'cumora-engine-kimi-switch-'))
  const agentId = 'atlas-a745'
  try {
    await new EngineSessionStore(sessionsDir, agentId, 'claude').save('claude-id')
    await new EngineSessionStore(sessionsDir, agentId, 'codex').save('codex-id')
    const kimi = new EngineSessionStore(sessionsDir, agentId, 'kimi')
    assert.equal(await kimi.load(), null)
    const result = await runWithSessionRecovery({
      resumeSessionId: await kimi.load(),
      run: async (resumeSessionId): Promise<EngineRunResult> => {
        assert.equal(resumeSessionId, null)
        return { exitCode: 0, sessionId: 'kimi-id' }
      },
      reset: () => kimi.save(null),
    })
    await kimi.save(result.sessionId ?? null)
    assert.equal(await new EngineSessionStore(sessionsDir, agentId, 'claude').load(), 'claude-id')
    assert.equal(await new EngineSessionStore(sessionsDir, agentId, 'codex').load(), 'codex-id')
    assert.equal(await kimi.load(), 'kimi-id')
  } finally {
    await rm(sessionsDir, { recursive: true, force: true })
  }
})
