// Docker + Node only. Never restores into an existing container/database.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const docker = (args, input) => execFileSync('docker', args, { input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
const sql = (container, query) => docker(['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'cumora', '-At'], query).toString().trim()
const identifier = (value) => '"' + value.replaceAll('"', '""') + '"'

export function inventory(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap((entry) => {
    const path = join(directory, entry.name)
    const key = prefix + entry.name
    if (entry.isSymbolicLink()) throw new Error('Uploads must not contain symlinks')
    if (entry.isDirectory()) return inventory(path, key + '/')
    if (!entry.isFile()) throw new Error('Unsupported uploads entry')
    return [{ key, bytes: statSync(path).size, sha256: sha(readFileSync(path)) }]
  })
}

function fingerprint(container) {
  const tables = JSON.parse(sql(container, "SELECT coalesce(json_agg(json_build_array(schemaname,tablename) ORDER BY schemaname,tablename),'[]') FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')"))
  return tables.map(([schema, table]) => {
    const rows = sql(container, `SELECT md5(row_to_json(t)::text) FROM ${identifier(schema)}.${identifier(table)} t ORDER BY 1`)
    return { table: schema + '.' + table, rows: rows ? rows.split('\n').length : 0, sha256: sha(rows) }
  })
}

export function backup(container, uploads, output) {
  mkdirSync(output) // Refuse an existing destination; never overwrite a backup.
  const started = Date.now()
  const before = fingerprint(container)
  const dump = docker(['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'cumora', '-Fc', '--no-owner', '--no-acl'])
  writeFileSync(join(output, 'database.dump'), dump)
  const files = inventory(uploads)
  cpSync(uploads, join(output, 'uploads'), { recursive: true, errorOnExist: true })
  if (JSON.stringify(before) !== JSON.stringify(fingerprint(container))) throw new Error('Database changed during backup; quiesce writers and retry to a new directory')
  if (JSON.stringify(files) !== JSON.stringify(inventory(join(output, 'uploads'))) || JSON.stringify(files) !== JSON.stringify(inventory(uploads))) throw new Error('Uploads changed during backup')
  const manifest = { format: 1, createdAt: new Date().toISOString(), databaseSha256: sha(dump), tables: before, files }
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`backup PASS: tables=${before.length}, files=${files.length}, bytes=${files.reduce((n, f) => n + f.bytes, 0)}, elapsedMs=${Date.now() - started}`)
}

async function isolatedPostgres(run) {
  const name = 'cumora-restore-' + randomUUID()
  try {
    // tmpfs covers the image's declared volume; no Docker volume is created.
    docker(['run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=cumora', 'pgvector/pgvector:pg16'])
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      try { sql(name, 'SELECT 1'); ready = true; break } catch { await new Promise((r) => setTimeout(r, 500)) }
    }
    if (!ready) throw new Error('Isolated PostgreSQL startup timed out')
    return await run(name)
  } finally {
    // Name is generated here, never supplied by a caller. No volume deletion.
    docker(['rm', '-f', name])
  }
}

export async function restore(input, output) {
  const started = Date.now()
  const manifest = JSON.parse(readFileSync(join(input, 'manifest.json'), 'utf8'))
  const dump = readFileSync(join(input, 'database.dump'))
  if (manifest.format !== 1 || sha(dump) !== manifest.databaseSha256) throw new Error('Database archive checksum mismatch')
  if (JSON.stringify(inventory(join(input, 'uploads'))) !== JSON.stringify(manifest.files)) throw new Error('Uploads checksum mismatch')
  mkdirSync(output)
  await isolatedPostgres(async (container) => {
    docker(['exec', '-i', container, 'pg_restore', '-U', 'postgres', '-d', 'cumora', '--exit-on-error', '--no-owner', '--no-acl'], dump)
    if (JSON.stringify(fingerprint(container)) !== JSON.stringify(manifest.tables)) throw new Error('Restored database rows differ from backup')
    cpSync(join(input, 'uploads'), join(output, 'uploads'), { recursive: true, errorOnExist: true })
    if (JSON.stringify(inventory(join(output, 'uploads'))) !== JSON.stringify(manifest.files)) throw new Error('Restored uploads differ from backup')
    const report = { ok: true, tables: manifest.tables.length, rows: manifest.tables.reduce((n, t) => n + t.rows, 0), files: manifest.files.length, bytes: manifest.files.reduce((n, f) => n + f.bytes, 0), elapsedMs: Date.now() - started }
    writeFileSync(join(output, 'restore-result.json'), JSON.stringify(report, null, 2))
    console.log('restore PASS: ' + JSON.stringify(report))
  })
}

async function selfTest(output) {
  mkdirSync(output)
  const uploads = join(output, 'source-uploads')
  mkdirSync(join(uploads, 'attachments'), { recursive: true })
  writeFileSync(join(uploads, 'attachments', '校验.bin'), Buffer.from([0, 1, 255, 10]))
  writeFileSync(join(uploads, 'empty.txt'), '')
  await isolatedPostgres(async (container) => {
    sql(container, "CREATE EXTENSION vector; CREATE TABLE schema_migrations(version integer PRIMARY KEY, checksum text); INSERT INTO schema_migrations VALUES(18,'fixture'); CREATE TABLE attachments(id integer PRIMARY KEY, path text, embedding vector(3)); INSERT INTO attachments VALUES(1,'attachments/校验.bin','[1,2,3]'); CREATE TABLE empty_table(id integer)")
    backup(container, uploads, join(output, 'backup'))
  })
  await restore(join(output, 'backup'), join(output, 'restored'))
  writeFileSync(join(output, 'backup', 'uploads', 'empty.txt'), 'corrupted')
  try { await restore(join(output, 'backup'), join(output, 'must-not-restore')); throw new Error('Corruption was accepted') } catch (error) {
    if (error.message !== 'Uploads checksum mismatch') throw error
    console.log('negative PASS: corrupt uploads rejected before restore')
  }
  writeFileSync(join(output, 'backup', 'uploads', 'empty.txt'), '')
  writeFileSync(join(output, 'backup', 'database.dump'), 'corrupted')
  try { await restore(join(output, 'backup'), join(output, 'must-not-restore')); throw new Error('Corruption was accepted') } catch (error) {
    if (error.message !== 'Database archive checksum mismatch') throw error
    console.log('negative PASS: corrupt database archive rejected before restore')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, ...args] = process.argv.slice(2)
    if (mode === 'backup' && args.length === 3) backup(args[0], resolve(args[1]), resolve(args[2]))
    else if (mode === 'restore' && args.length === 2) await restore(resolve(args[0]), resolve(args[1]))
    else if (mode === 'self-test' && args.length === 1) await selfTest(resolve(args[0]))
    else throw new Error('Usage: backup <PG-container> <uploads-directory> <new-backup-dir> | restore <backup-dir> <new-drill-dir> | self-test <new-output-dir>')
  } catch (error) { console.error('backup/restore FAILED: ' + error.message.split('\n')[0]); process.exitCode = 1 }
}
