/** Multi-replica K8s requires R2; single-replica PVC and Compose allow local uploads. */
export const REQUIRED_R2_KEYS = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const

export function checkStorageConfig(config: Record<string, string | undefined>): 'r2' | 'local' {
  const missing = REQUIRED_R2_KEYS.filter((key) => !config[key]?.trim())
  if (missing.length && config.CUMORA_REQUIRE_R2 === 'true') {
    throw new Error('Shared storage required; missing: ' + missing.join(', '))
  }
  if (!missing.length) {
    const endpoint = new URL(config.R2_ENDPOINT!)
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('R2_ENDPOINT must be HTTP(S)')
    return 'r2'
  }
  return 'local'
}
