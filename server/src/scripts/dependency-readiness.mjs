// HTTP-only client: dependency connections belong to the running application.
const base = (process.env.READINESS_SERVER_URL || 'http://127.0.0.1:5181').replace(/\/$/, '')
try {
  const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) })
  if (!response.ok || !(await response.json()).ok) throw new Error('API not ready')
  console.log('dependencies: ready (application Postgres, Redis, API); model capabilities unverified')
} catch {
  console.error('dependencies: NOT READY; check application Postgres, Redis and API connectivity')
  process.exitCode = 1
}

// Opt-in process-health diagnostic only. Never gates Cumora readiness or .env fallback.
if (process.argv.includes('--gateway')) {
  try {
    if (!process.env.SUB2API_INTERNAL_URL) throw new Error('missing gateway URL')
    const response = await fetch(process.env.SUB2API_INTERNAL_URL.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(2000) })
    if (!response.ok) throw new Error('gateway not live')
    console.log('gateway diagnostic: live; dependencies and model capabilities unverified')
  } catch {
    console.warn('gateway diagnostic: unavailable or unconfigured; does not affect Cumora readiness')
  }
}
