/**
 * Long-running agent-computer entry point — but only as long as
 * there's work to do.
 *
 * Lifecycle:
 *   1. Boot, set status='avail', connect SSE → /runtime/wake-stream
 *   2. Run drain() once unconditionally (catch up wakes that fired
 *      during cold-start / before the SSE attached)
 *   3. Loop: read SSE events; on `event: wake` → drain()
 *   4. After each drain finishes, kick / reset the idle timer
 *   5. If the idle timer fires (no wakes for CUMORA_AGENT_IDLE_MS):
 *      set status='resting', close the stream, exit 0. K8s deletes
 *      the Pod. PVC stays.
 *   6. SIGTERM (k8s draining the node): cancel current request, finish cleanup, exit 0.
 *
 * Per-agent serialization is intrinsic — one process, awaits each
 * turn before the next.
 *
 * Required env (injected by the orchestrator at pod-spawn time):
 *   CUMORA_AGENT_ID            which agent this Pod IS
 *   CUMORA_AGENT_RUNTIME_URL   server origin + /runtime suffix
 *   CUMORA_AGENT_RUNTIME_TOKEN signed JWT pinning agentId + companyId
 *   CUMORA_AGENT_IDLE_MS       idle timeout (ms); default 10 min
 *   CUMORA_MANAGED_POD_BOOTSTRAP versioned policy, identity and direct settings
 *   OPENAI_API_KEY             legacy direct bootstrap (optional)
 *
 * Exit codes:
 *   0  graceful shutdown (idle, SIGTERM, SIGINT)
 *   2  bad invocation (missing env)
 *   3  unrecoverable stream error (couldn't connect after N retries)
 */
import { pool } from '../../db/pool.js'
import { initializeManagedPodSettings } from '../../settings.js'
import { runAgentTurn, type AgentTurnOptions } from '../turn.js'
import { runtime } from './select.js'
import { notifyAlert } from '../../alerting.js'
import { pushSteer } from '../steer.js'
import { parseSseStream, wakeStreamWasStable } from './sse-parse.js'
import { decidePodExit } from './pod-agent-exit.js'
import { mergeWakeTurnOptions, parseWakeData } from './wake-options.js'

interface RunnerState {
  busy: boolean
  inboxDeferred: { messageIds: string[]; retryAt: number } | null
  pendingRerun: boolean
  shuttingDown: boolean
  /** ms timestamp of the last activity (turn start or wake). Drives
   *  the idle timer's decision to terminate. */
  lastActivityAt: number
  /** True once an SSE 'wake' or 'steer' event has arrived from the
   *  server. The bootstrap drain at SSE-attach does NOT flip this —
   *  it's specifically "did the server tell us there's work AFTER we
   *  subscribed?" If still false after CUMORA_AGENT_NO_WORK_MS, the
   *  no-work-exit path fires to free this pod's /dev/fuse slot for
   *  another agent. See FUSE-cap incident postmortem 2026-05-20. */
  firstWakeReceived: boolean
}

const state: RunnerState = {
  inboxDeferred: null,
  busy: false, pendingRerun: false, shuttingDown: false,
  lastActivityAt: Date.now(),
  firstWakeReceived: false,
}

let activeTurnController: AbortController | null = null

// Consumed once by the first drain, including cold-start inbox catch-up.
// Inbox changes invalidate the scheduler decision inside runAgentTurn.
let pendingTurnOptions: AgentTurnOptions | null = parseWakeData(process.env.CUMORA_AGENT_INITIAL_WAKE).options
delete process.env.CUMORA_AGENT_INITIAL_WAKE
let inboxProbeTimer: NodeJS.Timeout | null = null
let inboxProbeInFlight = false
let inboxRetryTimer: NodeJS.Timeout | null = null

function mergeTurnOptions(next: AgentTurnOptions | null): void {
  pendingTurnOptions = mergeWakeTurnOptions(pendingTurnOptions, next)
}

/** All wake sources pass this gate while holding the drain lock. Only the
 * deferred batch stays gated; a new message must reach triage's human fast path.
 * If those messages were read/removed elsewhere, the stale boundary is cleared. */
async function admitInboxDrain(agentId: string): Promise<boolean> {
  const deferred = state.inboxDeferred
  if (!deferred) return true
  if (Date.now() < deferred.retryAt) {
    const waiting = await runtime.loadInbox(agentId, { onlyMessageIds: deferred.messageIds })
    if (waiting.length > 0) {
      // Probe outside the deferred work page, before LIMIT is applied.
      const fresh = await runtime.loadInbox(agentId, { excludeMessageIds: deferred.messageIds })
      if (fresh.length === 0) return false
      mergeTurnOptions({ excludeInboxMessageIds: deferred.messageIds })
      return true
    }
  }
  state.inboxDeferred = null
  if (inboxRetryTimer) clearTimeout(inboxRetryTimer)
  inboxRetryTimer = null
  return true
}

function deferInboxDrain(agentId: string, deferred: { messageIds: string[]; retryAt: number }): void {
  state.inboxDeferred = deferred
  if (inboxRetryTimer) clearTimeout(inboxRetryTimer)
  inboxRetryTimer = setTimeout(() => {
    inboxRetryTimer = null
    void drain(agentId)
  }, Math.min(2_147_483_647, Math.max(1, deferred.retryAt - Date.now())))
  inboxRetryTimer.unref?.()
}

async function drain(agentId: string, options: AgentTurnOptions | null = null): Promise<void> {
  if (state.shuttingDown) return
  mergeTurnOptions(options)
  state.lastActivityAt = Date.now()
  if (state.busy) { state.pendingRerun = true; return }
  state.busy = true
  try {
    do {
      state.pendingRerun = false
      if (!await admitInboxDrain(agentId)) break
      const turnOptions = pendingTurnOptions ?? {}
      pendingTurnOptions = null
      const started = Date.now()
      try {
        activeTurnController = new AbortController()
        await runAgentTurn(agentId, { ...turnOptions, signal: activeTurnController.signal,
          onInboxDeferred: deferred => { state.inboxDeferred = deferred } })
        console.log(`[pod-agent] turn ok · ${Date.now() - started}ms`)
      } catch (err) {
        console.error(`[pod-agent] turn failed (${Date.now() - started}ms):`,
          err instanceof Error ? err.message : String(err))
      }
      activeTurnController = null
      // Schedule outside runAgentTurn's AsyncLocalStorage snapshot: the retry
      // must capture the next revision, not inherit this turn's settings.
      if (state.inboxDeferred) deferInboxDrain(agentId, state.inboxDeferred)
      state.lastActivityAt = Date.now()
    } while (state.pendingRerun && !state.shuttingDown)
  } catch (err) {
    console.warn('[pod-agent] inbox admission failed:', err instanceof Error ? err.message : String(err))
  } finally {
    state.busy = false
  }
}

/** Periodic self-heal for the managed Pod. A wake can be lost while the
 * server is restarting or while the first loadInbox call fails; the inbox is
 * durable, so probing it is enough to re-enter the normal serialized drain
 * path without creating another turn when the fingerprint is unchanged. */
function stopInboxProbe(): void {
  if (inboxProbeTimer) {
    clearInterval(inboxProbeTimer)
    inboxProbeTimer = null
  }
}

function startInboxProbe(agentId: string, intervalMs = 30_000): void {
  stopInboxProbe()
  const probe = async (): Promise<void> => {
    if (state.shuttingDown || inboxProbeInFlight) return
    inboxProbeInFlight = true
    try {
      const inbox = await runtime.loadInbox(agentId)
      if (inbox.length > 0 && !state.busy) void drain(agentId)
    } catch (err) {
      console.warn('[pod-agent] inbox probe failed:',
        err instanceof Error ? err.message : String(err))
    } finally {
      inboxProbeInFlight = false
    }
  }
  inboxProbeTimer = setInterval(() => { void probe() }, intervalMs)
  inboxProbeTimer.unref?.()
}

// parseSseStream + SseEvent moved to ./sse-parse.ts so the test
// suite can import them without booting pod-agent.ts's auto-running
// main(). Re-exported here for any callers that still depend on the
// old import path.
export type { SseEvent } from './sse-parse.js'
export { parseSseStream }

async function connectStream(agentId: string, url: string, token: string): Promise<void> {
  const res = await fetch(`${url}/wake-stream`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'text/event-stream',
    },
  })
  if (!res.ok || !res.body) {
    throw new Error(`wake-stream connect failed: HTTP ${res.status}`)
  }
  console.log(`[pod-agent] connected to wake-stream`)

  // First connect after a cold start: catch up unconditionally. Any
  // wake events that fired during the spin-up window were dropped
  // server-side (no subscriber yet) — drain() reads inbox directly,
  // so this is self-healing.
  void drain(agentId)

  for await (const evt of parseSseStream(res.body as unknown as AsyncIterable<unknown>)) {
    if (state.shuttingDown) break
    if (evt.event === 'ready') continue
    if (evt.event === 'wake') {
      // Mark "the server has told us there's work" — gates the
      // no-work-exit fast path. A bootstrap drain (line 151) does
      // NOT set this; only a real SSE wake from the bus does.
      state.firstWakeReceived = true
      // Fire-and-forget: drain() handles re-entrancy + serialization.
      // We don't `await` here because the stream itself must keep
      // pulling so we don't miss subsequent events while a turn runs.
      void drain(agentId, parseWakeData(evt.data).options)
      continue
    }
    if (evt.event === 'steer') {
      state.firstWakeReceived = true
      // Mid-turn injection: the user just posted a message that the
      // SERVER decided this agent should see WITHOUT waiting for the
      // current turn to end (because Redis says we're busy). Push
      // onto the steer queue — the turn loop's hop-boundary drain
      // will pick it up. Also kick drain() in case we happen to be
      // idle (the server's busy-check is best-effort + slightly
      // racy); in that case we'll just run a normal turn whose
      // loadInbox sees the message via the messages table.
      //
      // Payload validation: SSE data is bounded by the producer
      // (deliverSteer) in theory, but treat it as untrusted at the
      // boundary — bound author/body lengths so a buggy or hostile
      // upstream can't push megabytes of context. The truncation in
      // pushSteer covers the body case as defense-in-depth; here we
      // gate at the SSE parse layer too.
      try {
        if (!evt.data) continue
        // Cap raw SSE payload at ~16KB. Anything larger is rejected
        // outright — a legitimate steer (≤ 4KB body + small metadata)
        // never approaches this.
        if (evt.data.length > 16_384) {
          console.warn(`[pod-agent] dropped oversized steer payload (${evt.data.length} bytes)`)
          continue
        }
        const parsed = JSON.parse(evt.data) as {
          messageId?: unknown
          conversationId?: unknown
          authorName?: unknown
          body?: unknown
        }
        if (
          typeof parsed.messageId !== 'string' ||
          typeof parsed.conversationId !== 'string' ||
          typeof parsed.body !== 'string'
        ) continue
        // Per-field length caps — guards against a malformed publish.
        // pushSteer ALSO truncates body, but doing it here keeps the
        // log line consistent at the entry point.
        const messageId = parsed.messageId.slice(0, 256)
        const conversationId = parsed.conversationId.slice(0, 256)
        const authorName = typeof parsed.authorName === 'string'
          ? parsed.authorName.slice(0, 128)
          : 'user'
        const body = parsed.body.slice(0, 8192)
        if (!messageId || !conversationId) continue
        pushSteer(agentId, {
          messageId,
          conversationId,
          authorName: authorName || 'user',
          body,
          arrivedAt: Date.now(),
        })
      } catch (err) {
        console.warn(`[pod-agent] failed to parse steer payload:`,
          err instanceof Error ? err.message : err)
      }
      // Always kick drain so an idle pod still runs a turn (steer
      // races with wake on the producer side, and the wake event
      // may not have arrived yet / may have been merged).
      void drain(agentId)
      continue
    }
  }
}

/** Idle watcher — if the pod sits with no work for IDLE_MS (or fails
 *  to receive any wake at all within NO_WORK_MS of boot), it sets the
 *  agent's status to 'resting' and exits 0. K8s reaps the Pod; the
 *  PVC stays bound for the next wake-up. */
function startIdleWatcher(
  agentId: string,
  idleMs: number,
  noWorkMs: number,
  onIdle: (reason: string) => void,
): void {
  const bootedAt = Date.now()
  // Tick cadence: small enough that no-work-exit fires within ~5s
  // of crossing the threshold, but never busier than every 500ms.
  const tickMs = Math.min(5_000, Math.max(500, Math.floor(Math.min(idleMs, noWorkMs) / 10)))
  const tick = setInterval(() => {
    // Keep the in-memory deferred boundary alive until its scheduled retry.
    if (state.inboxDeferred) return
    const reason = decidePodExit(state, bootedAt, Date.now(), idleMs, noWorkMs)
    if (reason !== null) {
      clearInterval(tick)
      onIdle(reason)
    }
  }, tickMs)
  tick.unref?.()
}

async function gracefulExit(reason: string, finalStatus: 'resting' | null): Promise<never> {
  if (state.shuttingDown) {
    // Already shutting down — wait for it.
    await new Promise<void>(() => { /* never resolve */ })
  }
  state.shuttingDown = true
  activeTurnController?.abort(new DOMException(`Pod stopping: ${reason}`, 'AbortError'))
  stopInboxProbe()
  if (inboxRetryTimer) clearTimeout(inboxRetryTimer)
  inboxRetryTimer = null
  console.log('[pod-agent] shutting down: ' + reason)
  // Wait for in-flight turn to finish, capped at 60s.
  const deadline = Date.now() + 60_000
  while (state.busy && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 200))
  }
  if (finalStatus) {
    try {
      const agentId = process.env.CUMORA_AGENT_ID
      if (agentId) await runtime.setStatus(agentId, finalStatus)
    } catch (err) {
      console.warn(`[pod-agent] failed to set status=${finalStatus}:`, err instanceof Error ? err.message : String(err))
    }
  }
  // Settings refreshes may still hold a connection. Bound pool shutdown
  // so a stuck read doesn't keep the Pod alive past its idle bedtime.
  await Promise.race([
    pool.end().catch(() => { /* swallow */ }),
    new Promise<void>((r) => setTimeout(r, 2000)),
  ])
  process.exit(0)
}

async function main(): Promise<void> {
  const agentId = process.env.CUMORA_AGENT_ID
  const url = process.env.CUMORA_AGENT_RUNTIME_URL
  const token = process.env.CUMORA_AGENT_RUNTIME_TOKEN
  const idleMs = Number(process.env.CUMORA_AGENT_IDLE_MS ?? 3 * 60_000)
  const noWorkMs = Number(process.env.CUMORA_AGENT_NO_WORK_MS ?? 90_000)
  if (!agentId || !url || !token) {
    console.error('[pod-agent] missing env: CUMORA_AGENT_ID / CUMORA_AGENT_RUNTIME_URL / CUMORA_AGENT_RUNTIME_TOKEN')
    process.exit(2)
  }
  console.log(`[pod-agent] starting · agent=${agentId} idleMs=${idleMs} noWorkMs=${noWorkMs} pid=${process.pid}`)

  await initializeManagedPodSettings()

  // Announce "I'm awake" — agent shows up in UI as `avail` while
  // waiting for wakes. The turn loop itself flips status to
  // working/thinking during a turn.
  try { await runtime.setStatus(agentId, 'avail') } catch { /* best-effort */ }

  // SIGTERM / SIGINT (k8s drain, ctrl-c in dev): graceful shutdown.
  // We DON'T set status=resting on SIGTERM — that signals "k8s is
  // moving me", not "I have no work". Status sticks at whatever the
  // turn left it as.
  process.on('SIGTERM', () => { void gracefulExit('SIGTERM', null) })
  process.on('SIGINT',  () => { void gracefulExit('SIGINT', null) })

  // Idle timer: ONLY this path sets status=resting.
  startIdleWatcher(agentId, idleMs, noWorkMs, (reason) => { void gracefulExit(reason, 'resting') })
  startInboxProbe(agentId)

  // Connect-loop with exponential backoff. SSE disconnects (server
  // restart, transient network blip) shouldn't kill the Pod.
  let backoffMs = 500
  while (!state.shuttingDown) {
    const startedAt = Date.now()
    try {
      await connectStream(agentId, url, token)
      // A clean close used to reconnect with NO delay at all and reset the
      // ladder, so an endpoint that accepts and immediately ends the stream span
      // the loop as fast as fetch could go.
      console.log(`[pod-agent] wake-stream closed by server · retry in ${backoffMs}ms`)
    } catch (err) {
      console.warn(`[pod-agent] wake-stream error: ${err instanceof Error ? err.message : String(err)} · retry in ${backoffMs}ms`)
    }
    if (state.shuttingDown) break
    // Reset the ladder only after a connection that actually stayed up; merely
    // connecting is not evidence of health.
    if (wakeStreamWasStable(Date.now() - startedAt)) backoffMs = 500
    await new Promise<void>((r) => setTimeout(r, backoffMs))
    backoffMs = Math.min(backoffMs * 2, 30_000)
  }
}

// Process-level safety nets. On modern Node (≥ 15) an unhandled
// promise rejection terminates the agent pod by default — which
// rolls the user back to the "agent went silent" failure mode we
// keep paving over. Most of our async paths either await with
// try/catch or `.catch()`-suffixed fire-and-forget; these handlers
// catch what we missed so a single transient blip can't kill the
// pod mid-task. The pod stays alive, the next wake re-runs.
process.on('unhandledRejection', (reason, _p) => {
  void notifyAlert({
    label: 'pod.unhandledRejection',
    error: reason,
    extras: { agentId: process.env.CUMORA_AGENT_ID },
  })
})
process.on('uncaughtException', (err) => {
  void notifyAlert({
    label: 'pod.uncaughtException',
    error: err,
    extras: { agentId: process.env.CUMORA_AGENT_ID },
  })
})

void main().catch((err) => {
  console.error('[pod-agent] fatal', err)
  process.exit(3)
})
