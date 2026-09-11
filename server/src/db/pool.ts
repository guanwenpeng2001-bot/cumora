import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { env } from '../env.js'
import * as schema from './schema.js'

const forbiddenDatabaseAccess = () => Promise.reject(new Error('Database access is forbidden in managed Pods'))

/** In HTTP (managed Pod) mode there is no database at all. This stands in for
 *  the Pool as a plain object with own properties, so `t.mock.method(pool,
 *  'query')` in tests can still inspect and override them — a Proxy would make
 *  the own-property lookup fail. */
const forbiddenPool = Object.assign(Object.create(null) as Pool, {
  query: forbiddenDatabaseAccess,
  connect: forbiddenDatabaseAccess,
  end: async () => {},
  on: () => forbiddenPool,
  removeListener: () => forbiddenPool,
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
  // Boot-budget calculations read the configured timeout off the pool; keep a
  // truthful mirror of the real Pool options so those checks still work.
  options: { connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, max: 20, statement_timeout: 60_000 },
})

export const pool = process.env.CUMORA_RUNTIME_CLIENT === 'http' ? forbiddenPool : new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Defense-in-depth against connection-pool exhaustion. A single slow or stuck
  // query must never pin a pool slot indefinitely — that is exactly how one
  // un-indexed hot query (idle.ts' MAX(created_at) seq-scan) held all 20 slots
  // at ~8s each and 503-ed the entire API. 60s is far above any healthy request
  // (sub-second) but reaps genuine runaways; idle-in-transaction reaps leaked
  // transactions holding a slot open doing nothing. The standalone migration
  // owner and CONCURRENTLY index builds legitimately run longer and disable
  // these on their own session (see ensureSchema -> `SET statement_timeout = 0`).
  statement_timeout: 60_000,
  idle_in_transaction_session_timeout: 30_000,
})

pool.on('error', (err) => {
  console.error('[pg] idle client error', err)
})

export const db = process.env.CUMORA_RUNTIME_CLIENT === 'http'
  ? (new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
      get() { throw new Error('Database access is forbidden in managed Pods') },
    }))
  : drizzle(pool, { schema })
