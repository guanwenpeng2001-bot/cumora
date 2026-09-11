import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readdirSync, readFileSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Atomic, fsynced files on the configured persistent volume. No prompts or credentials. */
export class DurableOutbox<T> {
  constructor(readonly directory: string, private maxBytes = 128 * 1024 * 1024) {}
  ready(): void { mkdirSync(this.directory, { recursive: true, mode: 0o700 }) }
  entries(): Array<{ id: string; payload: T }> {
    this.ready()
    return readdirSync(this.directory).filter(n => /^[a-f0-9-]+\.json$/.test(n)).sort()
      .map(n => ({ id: n.slice(0, -5), payload: JSON.parse(readFileSync(join(this.directory, n), 'utf8')) as T }))
  }
  put(payload: T, id = randomUUID()): string {
    if (!/^[a-f0-9-]+$/.test(id)) throw new Error('invalid outbox id')
    this.ready()
    const content = JSON.stringify(payload)
    const used = readdirSync(this.directory).reduce((n, file) => n + statSync(join(this.directory, file)).size, 0)
    if (used + Buffer.byteLength(content) > this.maxBytes) throw new Error('durable telemetry outbox full; settlement incomplete')
    const temp = join(this.directory, `${id}.${randomUUID()}.tmp`)
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, content); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, join(this.directory, `${id}.json`))
    this.syncDirectory()
    return id
  }
  ack(id: string): void {
    if (!/^[a-f0-9-]+$/.test(id)) throw new Error('invalid outbox id')
    try { unlinkSync(join(this.directory, `${id}.json`)) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    this.syncDirectory()
  }
  private syncDirectory(): void {
    // Windows does not expose directory fsync; atomic replacement remains supported.
    if (process.platform === 'win32') return
    const fd = openSync(this.directory, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
}
