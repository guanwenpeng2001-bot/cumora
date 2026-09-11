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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const rollbackPath = process.argv[2]
    if (!rollbackPath || process.argv.length !== 3) throw new Error('Usage: node scripts/rollback-precheck.mjs <rollback-image-manifest.ts>; missing rollback evidence means rollback is unverified')
    const candidate = schemaRange(readFileSync(new URL('../server/src/db/migrations/manifest.ts', import.meta.url), 'utf8'))
    const rollback = schemaRange(readFileSync(rollbackPath, 'utf8'))
    const result = checkRollback(candidate, rollback)
    if (!result.compatible) throw new Error('Rollback schema gate rejects candidate schema ' + result.target + ' (rollback supports ' + rollback.min + '-' + rollback.max + '). Do not rely on rollout undo; prepare a compatible rollback artifact or plan forward repair.')
    console.warn('WARNING: schema range precheck passed for target ' + result.target + ' only. Verify the exact rollback image digest, migration ledger/checksums and application behavior against a migrated isolated database before release. This check does not certify rollback safety.')
  } catch (error) {
    console.error('WARNING: rollback precheck failed: ' + error.message)
    process.exitCode = 1
  }
}
