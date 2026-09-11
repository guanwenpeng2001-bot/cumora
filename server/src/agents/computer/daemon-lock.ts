import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { createServer, type ListenOptions } from 'node:net'

export const DAEMON_ALREADY_RUNNING_EXIT_CODE = 73

/** Kernel-owned lock, independent of package version and server URL. Unlike a
 * PID file, acquisition is atomic and a crash cannot leave a stale owner.
 * Windows named pipes and Linux abstract sockets have no on-disk socket to
 * unlink. Other platforms use an exclusive loopback port; a hash collision or
 * unrelated listener fails closed (never retries on a different endpoint).
 * running.json remains status/legacy-migration evidence, NOT the lock. */
export async function daemonLockAddress(stateDir: string): Promise<{ stateDir: string; location: string; options: ListenOptions }> {
  await mkdir(stateDir, { recursive: true })
  const canonical = await realpath(stateDir)
  const key = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex')
  if (process.platform === 'win32' || process.platform === 'linux') {
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\cumora-daemon-${key}` : `\0cumora-daemon-${key}`
    return { stateDir: canonical, location: path.replace('\0', '@'), options: { path, exclusive: true } }
  }
  const port = 32768 + (Number.parseInt(key.slice(0, 8), 16) % 28232)
  return { stateDir: canonical, location: `127.0.0.1:${port}`, options: { host: '127.0.0.1', port, exclusive: true } }
}

export async function acquireDaemonLock(stateDir: string): Promise<{ location: string; release(): Promise<void> }> {
  const address = await daemonLockAddress(stateDir)
  const server = createServer(socket => socket.destroy())
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(address.options, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    server.close()
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(`[computer] daemon startup refused: ${code === 'EADDRINUSE' ? 'another daemon owns the single-instance lock' : `cannot acquire single-instance lock (${code})`}; state directory: ${address.stateDir}; lock: ${address.location}; ownership is decided by exclusive OS bind, not running.json`, { cause: error })
  }
  // Startup validation may return without starting any timers. Do not keep an
  // unpaired/failed CLI alive solely because it owns the lock.
  server.unref()
  return {
    location: address.location,
    release: () => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return }
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}
