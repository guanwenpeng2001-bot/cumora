/**
 * llm_calls_rollup refresher — keeps the Observability pre-aggregation current.
 *
 * WHY THIS EXISTS: llm_calls is ~470k rows and 100% inside the 30d dashboard
 * window (growing ~70k/day), so every Observability aggregation was a full seq
 * scan and the page fired 6 of them concurrently → 5-25s. The rollup collapses
 * the table to ~30k hourly-bucketed rows (15× smaller); the dashboard reads it
 * in ~230ms. This worker is the thing that keeps that rollup fresh.
 *
 * Refresh model — recompute, don't increment:
 *   Each tick re-derives the FULL aggregate for a recent window of hourly
 *   buckets straight from llm_calls and UPSERTs it (ON CONFLICT … DO UPDATE,
 *   overwriting the row). Recomputing is idempotent and self-healing: a missed
 *   tick, a double-run across replicas, or a late-arriving row all converge to
 *   the correct value on the next pass. Past hours are immutable (no new rows
 *   land in them) so only the trailing window needs re-touching.
 *
 *   First run on a fresh/empty table (or after a long outage) widens the window
 *   to fill the gap from the persisted completion watermark — so a single code path
 *   does both initial backfill and steady-state catch-up.
 *
 * Single-writer: an advisory lock means only one replica refreshes per tick;
 * the others no-op. Correctness wouldn't break without it (the upsert is
 * idempotent), but it avoids two replicas scanning llm_calls in lock-step.
 */
import { pool } from '../db/pool.js'
import type { PoolClient } from 'pg'

/** Interval between rollup refresh ticks. Default 120s; set 0 to disable. Read
 *  straight from process.env (not env.ts) to keep this self-contained. */
const INTERVAL_MS = Number(process.env.LLM_ROLLUP_INTERVAL_MS ?? 120_000)

// Distinct from migrate's SCHEMA_LOCK_KEY (7_643_178_926_104n).
const ROLLUP_LOCK_KEY = 7_643_178_926_211n

// Steady-state trailing window: the current partial hour plus slack for clock
// skew / late writes. 3h is generous and still ~150ms to recompute.
const STEADY_WINDOW_HOURS = 3
// Initial backfill / max catch-up reach. The dashboard's widest range is 90d;
// a touch more keeps the boundary clean. Capped so a brand-new table can't try
// to scan unbounded history in one statement.
const MAX_BACKFILL_HOURS = 95 * 24
// Drop buckets older than this so the rollup stays bounded as history grows.
const RETENTION_HOURS = 95 * 24

/**
 * Upsert every hourly bucket whose source rows are newer than `sinceHours`.
 * Returns the number of buckets written (inserted or updated).
 */
export async function refreshLlmRollup(sinceHours: number, connection?: PoolClient): Promise<number> {
  if (!Number.isFinite(sinceHours) || sinceHours <= 0) throw new RangeError('invalid rollup window')
  const client = connection ?? await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ since: Date; until: Date; retained_from: Date }>(
      `SELECT GREATEST(date_trunc('hour', NOW(), 'UTC') - ($1::int * INTERVAL '1 hour'),
                       date_trunc('hour', NOW() - ($2::double precision * INTERVAL '1 day'), 'UTC') + INTERVAL '1 hour') AS since,
              NOW() AS until,
              date_trunc('hour', NOW() - ($2::double precision * INTERVAL '1 day'), 'UTC') + INTERVAL '1 hour' AS retained_from`,
      [Math.min(MAX_BACKFILL_HOURS, Math.max(1, Math.ceil(sinceHours))),
        Number(process.env.DB_GC_LLM_CALLS_DAYS ?? 90) > 0 ? Math.min(95, Number(process.env.DB_GC_LLM_CALLS_DAYS ?? 90)) : 95],
    )
    const { since, until, retained_from: retainedFrom } = rows[0]!
    const params = [since, until]
    await client.query(`INSERT INTO llm_calls_rollup (
       bucket_hour, company_id, agent_id, purpose, model, source, daemon_version,
       calls, ok_calls, failed_calls, rate_limited_calls,
       input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_tokens,
       cost_usd, cost_estimated)
     SELECT date_trunc('hour', created_at, 'UTC'), company_id, agent_id, purpose, model, source, daemon_version,
            COUNT(*),
            COUNT(*) FILTER (WHERE status = 'ok'),
            COUNT(*) FILTER (WHERE status != 'ok'),
            COUNT(*) FILTER (WHERE status = 'rate_limited'),
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(cached_input_tokens), 0),
            COALESCE(SUM(cache_creation_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(reasoning_tokens), 0),
            COALESCE(SUM(cost_usd), 0),
            BOOL_OR(cost_estimated)
       FROM llm_calls
      WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
      GROUP BY 1, 2, 3, 4, 5, 6, 7
     ON CONFLICT (bucket_hour, company_id, agent_id, purpose, model, source, daemon_version)
     DO UPDATE SET
       calls = EXCLUDED.calls,
       ok_calls = EXCLUDED.ok_calls,
       failed_calls = EXCLUDED.failed_calls,
       rate_limited_calls = EXCLUDED.rate_limited_calls,
       input_tokens = EXCLUDED.input_tokens,
       cached_input_tokens = EXCLUDED.cached_input_tokens,
       cache_creation_tokens = EXCLUDED.cache_creation_tokens,
       output_tokens = EXCLUDED.output_tokens,
       reasoning_tokens = EXCLUDED.reasoning_tokens,
       cost_usd = EXCLUDED.cost_usd,
       cost_estimated = EXCLUDED.cost_estimated`, params)
    const res = await client.query(`INSERT INTO llm_calls_rollup_v2 (
       bucket_hour, company_id, agent_id, purpose, model, source, daemon_version, route, platform, unknown_calls, unpriced_calls,
       calls, ok_calls, failed_calls, rate_limited_calls,
       input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_tokens,
       cost_usd, cost_estimated)
     SELECT date_trunc('hour', created_at, 'UTC'), company_id, agent_id, purpose, model, source, daemon_version,
            extras->>'route', extras->>'platform',
            COUNT(*) FILTER (WHERE measured IS NOT TRUE),
            COUNT(*) FILTER (WHERE COALESCE(extras->>'unpriced', '') NOT IN ('', 'false')),
            COUNT(*),
            COUNT(*) FILTER (WHERE status = 'ok'),
            COUNT(*) FILTER (WHERE status != 'ok'),
            COUNT(*) FILTER (WHERE status = 'rate_limited'),
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(cached_input_tokens), 0),
            COALESCE(SUM(cache_creation_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(reasoning_tokens), 0),
            COALESCE(SUM(cost_usd), 0),
            BOOL_OR(cost_estimated)
       FROM llm_calls
      WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
     ON CONFLICT (bucket_hour, company_id, agent_id, purpose, model, source, daemon_version, route, platform)
     DO UPDATE SET
       unknown_calls = EXCLUDED.unknown_calls,
       unpriced_calls = EXCLUDED.unpriced_calls,
       calls = EXCLUDED.calls,
       ok_calls = EXCLUDED.ok_calls,
       failed_calls = EXCLUDED.failed_calls,
       rate_limited_calls = EXCLUDED.rate_limited_calls,
       input_tokens = EXCLUDED.input_tokens,
       cached_input_tokens = EXCLUDED.cached_input_tokens,
       cache_creation_tokens = EXCLUDED.cache_creation_tokens,
       output_tokens = EXCLUDED.output_tokens,
       reasoning_tokens = EXCLUDED.reasoning_tokens,
       cost_usd = EXCLUDED.cost_usd,
       cost_estimated = EXCLUDED.cost_estimated`, params)
    await client.query(
      `UPDATE llm_rollup_state SET
         coverage_from = CASE WHEN completed_through < $1::timestamptz THEN $1::timestamptz
                              ELSE COALESCE(coverage_from, $1::timestamptz) END,
         completed_through = date_trunc('hour', $2::timestamptz, 'UTC'),
         aggregated_at = $2, attempted_at = $2, status = 'ready'
       WHERE id`, [since > retainedFrom ? since : retainedFrom, until],
    )
    await client.query('COMMIT')
    return res.rowCount ?? 0
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    await client.query("UPDATE llm_rollup_state SET status = 'failed', attempted_at = NOW() WHERE id").catch(() => {})
    throw error
  } finally {
    if (!connection) client.release()
  }
}

/** One refresh pass: take the lock, pick the window (gap-fill on first run),
 *  upsert, prune old buckets. Best-effort + non-fatal — a failure just retries
 *  next tick. */
export async function runLlmRollupTick(): Promise<{ skipped?: boolean; buckets?: number; sinceHours?: number }> {
  const client = await pool.connect()
  try {
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [ROLLUP_LOCK_KEY])
    if (lock.rows[0]?.ok !== true) return { skipped: true }
    try {
      // Window = max(steady, gap since last completed hour), capped at the
      // backfill reach. A missing watermark triggers initial backfill.
      const { rows } = await client.query<{ gap_hours: number | null }>(
        `SELECT CEIL(EXTRACT(EPOCH FROM (NOW() - completed_through)) / 3600.0)::int AS gap_hours
           FROM llm_rollup_state WHERE id`,
      )
      const gap = rows[0]?.gap_hours
      const sinceHours = gap == null
        ? MAX_BACKFILL_HOURS
        : Math.min(MAX_BACKFILL_HOURS, Math.max(STEADY_WINDOW_HOURS, gap + 1))
      const buckets = await refreshLlmRollup(sinceHours, client)
      await client.query(
        `DELETE FROM llm_calls_rollup WHERE bucket_hour < NOW() - ($1::int * INTERVAL '1 hour')`,
        [RETENTION_HOURS],
      )
      await client.query(
        `DELETE FROM llm_calls_rollup_v2 WHERE bucket_hour < NOW() - ($1::int * INTERVAL '1 hour')`,
        [RETENTION_HOURS],
      )
      return { buckets, sinceHours }
    } catch (error) {
      await client.query("UPDATE llm_rollup_state SET status = 'failed', attempted_at = NOW() WHERE id").catch(() => {})
      throw error
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ROLLUP_LOCK_KEY]).catch(() => { /* swallow */ })
    }
  } finally {
    client.release()
  }
}

let timer: NodeJS.Timeout | null = null

/** Start the periodic rollup refresher. Idempotent. Fires the first tick
 *  immediately (so a fresh deploy backfills right away rather than waiting a
 *  full interval), then on the interval. LLM_ROLLUP_INTERVAL_MS=0 disables. */
export function startLlmRollupRefresher(): { stop(): void } | null {
  if (timer) return { stop: stopLlmRollupRefresher }
  const intervalMs = INTERVAL_MS
  if (intervalMs <= 0) {
    void pool.query("UPDATE llm_rollup_state SET status = 'paused' WHERE id").catch(() => {})
    console.log('[llm-rollup] disabled (LLM_ROLLUP_INTERVAL_MS=0)')
    return null
  }
  console.log(`[llm-rollup] starting · interval=${intervalMs}ms`)
  const tick = async () => {
    const t = Date.now()
    try {
      const r = await runLlmRollupTick()
      if (!r.skipped) console.log(`[llm-rollup] refreshed ${r.buckets} buckets (window=${r.sinceHours}h) in ${Date.now() - t}ms`)
    } catch (e) {
      console.error('[llm-rollup] tick failed:', e instanceof Error ? e.message : String(e))
    }
  }
  // Kick the first pass now so the dashboard has data ASAP after boot.
  void tick()
  timer = setInterval(() => { void tick() }, intervalMs)
  return { stop: stopLlmRollupRefresher }
}

export function stopLlmRollupRefresher(): void {
  if (timer) {
    clearInterval(timer); timer = null
    void pool.query("UPDATE llm_rollup_state SET status = 'paused' WHERE id").catch(() => {})
  }
}
