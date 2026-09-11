import { pool } from '../db/pool.js'
import type { PoolClient } from 'pg'

/** Lock the bucket before reading raw facts. Concurrent receipt transactions mark it
 * dirty after publication. Delete ALL old groups, including vanished model/provider groups. */
export async function refreshLlmRollupV3(connection?: PoolClient): Promise<number> {
  const client = connection ?? await pool.connect()
  try {
    await client.query('BEGIN')
    const buckets = await client.query<{ bucket_hour: Date }>(`SELECT bucket_hour FROM llm_rollup_state_v3
      WHERE dirty AND bucket_hour < date_trunc('hour',NOW(),'UTC') ORDER BY bucket_hour LIMIT 48 FOR UPDATE SKIP LOCKED`)
    for (const { bucket_hour: hour } of buckets.rows) {
      await client.query('DELETE FROM llm_calls_rollup_v3 WHERE bucket_hour=$1', [hour])
      await client.query(`INSERT INTO llm_calls_rollup_v3
        SELECT date_trunc('hour',occurred_at,'UTC'), company_id,agent_id,run_id,purpose,
          COALESCE(actual_model,request_model,model),source,source_kind,source_id,provider_id,platform,route_id,offering_id,capability,role,
          logical_call_id,daemon_version,observation_granularity,
          COUNT(*),COUNT(*) FILTER(WHERE status IN ('ok','succeeded')),COUNT(*) FILTER(WHERE status NOT IN ('ok','succeeded')),
          COUNT(*) FILTER(WHERE status='rate_limited' OR http_status=429),
          SUM(input_tokens),SUM(cached_input_tokens),SUM(cache_creation_tokens),SUM(output_tokens),SUM(reasoning_tokens),
          SUM(reference_cost_usd),BOOL_OR(cost_estimated),SUM(reference_cost_usd),SUM(upstream_cost_usd),SUM(quota_debit),
          COUNT(*) FILTER(WHERE usage_state='unknown'),COUNT(*) FILTER(WHERE pricing_state='unpriced'),
          COUNT(*) FILTER(WHERE schema_version<2 OR source_kind IS NULL),COUNT(*) FILTER(WHERE settlement_state='pending'),
          actual_model,request_model,actual_model_state
        FROM llm_calls WHERE occurred_at >= $1 AND occurred_at < $1::timestamptz+INTERVAL '1 hour' AND record_kind='attempt'
        GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,actual_model,request_model,actual_model_state`, [hour])
      await client.query("UPDATE llm_rollup_state_v3 SET dirty=FALSE,status='ready',aggregated_at=NOW() WHERE bucket_hour=$1", [hour])
    }
    await client.query('COMMIT')
    return buckets.rows.length
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { if (!connection) client.release() }
}
