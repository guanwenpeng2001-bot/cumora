// Separate from K8s liveness: no migrations, writes, or model calls.
import pg from 'pg'
import Redis from 'ioredis'

const deadline = setTimeout(() => { console.error('dependencies: timeout'); process.exit(1) }, 8000)
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000, query_timeout: 2000 })
const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, connectTimeout: 2000, commandTimeout: 2000, retryStrategy: () => null })
redis.on('error', () => {})
try {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) throw new Error('missing database/redis configuration')
  await db.connect()
  await db.query('SELECT 1')
  await redis.connect()
  if (await redis.ping() !== 'PONG') throw new Error('redis not ready')
  const base = process.env.READINESS_SERVER_URL || 'http://127.0.0.1:5181'
  for (const path of ['/api/livez', '/api/health']) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(2000) })
    if (!response.ok || !(await response.json()).ok) throw new Error('API not ready')
  }
  if (process.argv.includes('--gateway')) {
    if (!process.env.SUB2API_INTERNAL_URL) throw new Error('missing gateway URL')
    const response = await fetch(process.env.SUB2API_INTERNAL_URL.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(2000) })
    if (!response.ok) throw new Error('gateway not live')
    await redis.select(1)
    if (await redis.ping() !== 'PONG') throw new Error('gateway Redis not ready')
    // Compose gateway shares these PG/Redis services, but uses its own DB.
    await db.end()
    const url = new URL(process.env.DATABASE_URL)
    url.pathname = '/sub2api'
    const gatewayDb = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 2000, query_timeout: 2000 })
    try { await gatewayDb.connect(); await gatewayDb.query('SELECT 1') } finally { await gatewayDb.end() }
  }
  console.log('dependencies: ready (Postgres, Redis, API' + (process.argv.includes('--gateway') ? ', shared Compose gateway' : '') + '); model capabilities unverified')
} catch {
  // Avoid logging connection URLs or credentials from dependency errors.
  console.error('dependencies: NOT READY; check database, Redis, API and optional gateway connectivity')
  process.exitCode = 1
} finally {
  await db.end().catch(() => {})
  redis.disconnect()
  clearTimeout(deadline)
}
