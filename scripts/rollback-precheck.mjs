import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function schemaRange(source) {
  const value = (name) => {
    const match = source.match(new RegExp('export const ' + name + ' = (\\d+)'))
    if (!match) throw new Error('Cannot read literal schema range: ' + name)
    return Number(match[1])
  }
  const min = value('MIN_SUPPORTED_SCHEMA_VERSION')
  const max = value('MAX_SUPPORTED_SCHEMA_VERSION')
  if (min < 1 || min > max) throw new Error('Invalid schema range')
  return { min, max }
}

export function checkRollback(candidate, rollback) {
  const target = candidate.max
  return { target, compatible: rollback.min <= target && target <= rollback.max }
}

// Automatic undo is deliberately narrower than a declared range: immutable
// migration metadata must match exactly. Wider compatibility needs a rehearsal.
export function checkRollbackManifests(candidateSource, rollbackSource) {
  const result = checkRollback(schemaRange(candidateSource), schemaRange(rollbackSource))
  const ledger = (source) => {
    const entries = [...source.matchAll(/version:\s*(\d+),\s*name:\s*'([^']+)',\s*checksum:\s*'([a-f0-9]{64})'/g)]
      .map(([, version, name, checksum]) => ({ version: Number(version), name, checksum }))
    if (!entries.length || entries.some((entry, index) => entry.version !== index + 1)) throw new Error('Missing or invalid migration metadata')
    if (entries.at(-1).version !== schemaRange(source).max) throw new Error('Manifest tip differs from schema maximum')
    return entries
  }
  return { ...result, compatible: result.compatible && JSON.stringify(ledger(candidateSource)) === JSON.stringify(ledger(rollbackSource)) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const rollbackPath = process.argv[2]
    if (!rollbackPath || process.argv.length > 4) throw new Error('Usage: node scripts/rollback-precheck.mjs <rollback-image-manifest.ts> [candidate-image-manifest.ts]; missing rollback evidence means rollback is unverified')
    const candidateSource = readFileSync(process.argv[3] || new URL('../server/src/db/migrations/manifest.ts', import.meta.url), 'utf8')
    const rollbackSource = readFileSync(rollbackPath, 'utf8')
    const rollback = schemaRange(rollbackSource)
    const result = checkRollbackManifests(candidateSource, rollbackSource)
    if (!result.compatible) throw new Error('Rollback schema/ledger gate rejects candidate schema ' + result.target + ' (rollback supports ' + rollback.min + '-' + rollback.max + '). Do not rely on rollout undo; prepare a compatible rollback artifact or plan forward repair.')
    console.warn('WARNING: schema range precheck passed for target ' + result.target + ' only. Verify the exact rollback image digest, migration ledger/checksums and application behavior against a migrated isolated database before release. This check does not certify rollback safety.')
  } catch (error) {
    console.error('WARNING: rollback precheck failed: ' + error.message)
    process.exitCode = 1
  }
}
