import { readFile } from 'node:fs/promises'
import { pool } from '../db/pool.js'
import { readInventory, type Inventory } from '../models/inventory.js'
import { buildModelImport, persistModelImport } from '../models/import.js'

/** Replays a sanitized audit into the selected DB, or imports its own committed legacy facts. */
async function main() {
  const args = process.argv.slice(2)
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('model-hub-import'))")
    const inventory: Inventory = args.includes('--inventory') ? JSON.parse(await readFile(args[args.indexOf('--inventory') + 1], 'utf8')) : await readInventory(client)
    const data = buildModelImport(inventory)
    await persistModelImport(client, data)
    await client.query('COMMIT')
    console.log(JSON.stringify({ sources: data.sources.length, offerings: data.offerings.length, bindings: data.bindings.length, credentials: data.credentials.length, mapping: data.mapping }))
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
main().catch(() => { console.error('model-hub-import failed; transaction rolled back'); process.exitCode = 1 }).finally(() => pool.end())
