/**
 * Immutable database-migration ledger understood by this application build.
 *
 * Append new entries; never edit or reorder an applied entry. The checksum is
 * stored in PostgreSQL and compared on every migration run and application
 * startup, so changing historical SQL fails closed instead of silently
 * redefining what an old version meant.
 */
export interface MigrationMetadata {
  version: number
  name: string
  checksum: string
}

export interface AppliedMigration extends MigrationMetadata {
  applied_at?: Date | string
}

export const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: '0001_legacy_baseline',
    checksum: '5250b63e17bb5a028483b72a799b868418b875e7c0802be4168175b9930aa7d0',
  },
  {
    version: 2,
    name: '0002_normalized_conversation_members',
    checksum: '489abe15a28b6c1ee11e7a3e03f79c2949574687333de1d97e7b7eff33c6d2b3',
  },
  {
    version: 3,
    name: '0003_workspace_cleanup_jobs',
    checksum: 'cd4047a09fb585ba166e7e0a48a21169168da567728dcb63ae8e6ff5bd204d89',
  },
  {
    version: 4,
    name: '0004_agent_runtime_assignment',
    checksum: '59956150df026c36238298603ed47438abf154cfc779034758d7141a79ae00b2',
  },
  {
    version: 5,
    name: '0005_search_trigram_index',
    checksum: 'eac389304940a9af260ebc51e13b97f5d0d9d0148460debceaf328d8bbcd76f2',
  },
  {
    version: 6,
    name: '0006_email_messages_company_smtp_id',
    checksum: 'a4a37d6d293f4b36eca5471f20ba3a6e5e40d8c15435133843ef9cb28a636331',
  },
  {
    version: 7,
    name: '0007_server_settings',
    checksum: 'dafcf51d81efea42f3f3bfb251ed0eb95faab7f88b93b704e698610ada651725',
  },
  {
    version: 8,
    name: '0008_model_pricing',
    checksum: '5bcf0d8c87bd26a5faae9edbbeb04f98164830346377ec65ca479912b436b0a4',
  },
  {
    version: 9,
    name: '0009_skill_tables',
    checksum: '8e7a6f91b6112c39bc7bf63b786e758438b35f29fca2749a28795f277ea7a505',
  },
  {
    version: 10,
    name: '0010_mcp_tables',
    checksum: '85b59a79c20f0a1c224f5a3099026fd2f74461e94e17b6e5d4dbaf7c12445bcb',
  },
  {
    version: 11,
    name: '0011_usage_logs_company_created_index',
    checksum: 'ae962b37584a19f8f454b92a0939caa2263395781f78420522d1b01846711d66',
  },
  {
    version: 12,
    name: '0012_sub2api_sync',
    checksum: '4fcb389bb9d9de3de9e01ccf4a7bc546b44c35b613fac9208ab85122b8362661',
  },
  {
    version: 13,
    name: '0013_usage_rollup_v2',
    checksum: '0ea5015a4efcd5cf268d848244f3c20a8cb8f97793b7fe0f67e767a3e1141088',
  },
] as const satisfies readonly MigrationMetadata[]

/** This build intentionally supports one exact schema range. Expand/contract
 * releases may widen the range, but both bounds must remain explicit. */
export const MIN_SUPPORTED_SCHEMA_VERSION = 13
export const MAX_SUPPORTED_SCHEMA_VERSION = 13

function assertManifestShape(): void {
  for (let i = 0; i < SCHEMA_MIGRATIONS.length; i++) {
    const migration = SCHEMA_MIGRATIONS[i]
    if (migration.version !== i + 1) throw new Error('schema migration versions must be contiguous from 1')
    if (!/^\d{4}_[a-z0-9_]+$/.test(migration.name)) throw new Error(`invalid migration name: ${migration.name}`)
    if (!/^[a-f0-9]{64}$/.test(migration.checksum)) throw new Error(`invalid migration checksum: ${migration.name}`)
  }
  if (MAX_SUPPORTED_SCHEMA_VERSION !== SCHEMA_MIGRATIONS.at(-1)?.version) {
    throw new Error('maximum supported schema version must match the manifest tip')
  }
  if (MIN_SUPPORTED_SCHEMA_VERSION < 1 || MIN_SUPPORTED_SCHEMA_VERSION > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new Error('invalid supported schema version range')
  }
}

assertManifestShape()

export class MigrationHistoryError extends Error {
  readonly code: 'schema_uninitialized' | 'schema_behind' | 'schema_ahead' | 'migration_history_invalid'

  constructor(
    code: MigrationHistoryError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'MigrationHistoryError'
    this.code = code
  }
}

export interface MigrationHistoryState {
  currentVersion: number
  pending: readonly MigrationMetadata[]
}

/**
 * Validate that the persisted ledger is an exact, contiguous prefix of this
 * build's immutable manifest. Migrators may accept a pending suffix; normal
 * application startup requires the supported range to already be present.
 */
export function validateMigrationHistory(
  appliedRows: readonly AppliedMigration[],
  opts: { allowPending?: boolean } = {},
): MigrationHistoryState {
  const applied = [...appliedRows].sort((a, b) => a.version - b.version)

  if ((applied.at(-1)?.version ?? 0) > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new MigrationHistoryError(
      'schema_ahead',
      `database schema version ${applied.at(-1)?.version} is newer than this application supports (${MAX_SUPPORTED_SCHEMA_VERSION})`,
    )
  }

  if (applied.length > SCHEMA_MIGRATIONS.length) {
    throw new MigrationHistoryError(
      'schema_ahead',
      `database schema version ${applied.at(-1)?.version ?? 'unknown'} is newer than this application supports (${MAX_SUPPORTED_SCHEMA_VERSION})`,
    )
  }

  for (let i = 0; i < applied.length; i++) {
    const actual = applied[i]
    const expected = SCHEMA_MIGRATIONS[i]
    if (!expected || actual.version !== expected.version) {
      throw new MigrationHistoryError(
        'migration_history_invalid',
        `migration history is not a contiguous prefix at position ${i + 1}`,
      )
    }
    if (actual.name !== expected.name || actual.checksum !== expected.checksum) {
      throw new MigrationHistoryError(
        'migration_history_invalid',
        `migration ${actual.version} does not match immutable manifest metadata`,
      )
    }
  }

  const currentVersion = applied.at(-1)?.version ?? 0
  const pending = SCHEMA_MIGRATIONS.slice(applied.length)
  if (opts.allowPending) return { currentVersion, pending }

  if (currentVersion === 0) {
    throw new MigrationHistoryError(
      'schema_uninitialized',
      'database schema is uninitialized; run `npm run migrate` before starting the server',
    )
  }
  if (currentVersion < MIN_SUPPORTED_SCHEMA_VERSION) {
    throw new MigrationHistoryError(
      'schema_behind',
      `database schema version ${currentVersion} is behind the supported range ${MIN_SUPPORTED_SCHEMA_VERSION}-${MAX_SUPPORTED_SCHEMA_VERSION}; run ` +
        '`npm run migrate` before starting the server',
    )
  }
  if (currentVersion > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new MigrationHistoryError(
      'schema_ahead',
      `database schema version ${currentVersion} is newer than the supported range ${MIN_SUPPORTED_SCHEMA_VERSION}-${MAX_SUPPORTED_SCHEMA_VERSION}`,
    )
  }

  return { currentVersion, pending }
}
