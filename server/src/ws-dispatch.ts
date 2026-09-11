/** Bounded per-route FIFO with one live authorization snapshot per batch.
 * No authorization result survives a batch, and delivery must be synchronous. */
export class WsDispatch<T> {
  private routes = new Map<string, { items: { value: T; at: number; bytes: number }[]; running: boolean; startedAt?: number }>()
  private active = 0
  private scheduled = false
  private bytes = 0
  private count = 0
  readonly metrics = { delivered: 0, rejected: 0, batches: 0, delayTotalMs: 0, delayMaxMs: 0 }

  constructor(private readonly deliver: (values: T[], expired: () => boolean) => Promise<void>,
    private readonly resync: (values: T[]) => void,
    private readonly limits = { batch: 128, concurrency: 4, events: 4096, bytes: 16 * 1024 * 1024, ageMs: 5000 }) {}

  snapshot() {
    let oldest = Date.now()
    for (const route of this.routes.values()) oldest = Math.min(oldest, route.startedAt ?? oldest, route.items[0]?.at ?? oldest)
    return { ...this.metrics, queued: this.count, queuedBytes: this.bytes, active: this.active, oldestAgeMs: Date.now() - oldest }
  }

  enqueue(key: string, value: T, bytes: number) {
    if (this.count >= this.limits.events || this.bytes + bytes > this.limits.bytes) {
      this.metrics.rejected++
      this.resync([value])
      return
    }
    let route = this.routes.get(key)
    if (!route) { route = { items: [], running: false }; this.routes.set(key, route) }
    route.items.push({ value, bytes, at: Date.now() })
    this.bytes += bytes
    this.count++
    this.schedule()
  }

  private schedule() {
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => { this.scheduled = false; this.pump() })
  }

  private pump() {
    for (const [key, route] of this.routes) {
      if (this.active >= this.limits.concurrency) break
      if (route.running || !route.items.length) continue
      const batch = route.items.splice(0, this.limits.batch)
      route.running = true
      route.startedAt = batch[0].at
      this.active++
      // Keep in-flight payloads in the memory budget until delivery completes.
      const expired = () => Date.now() - batch[0].at > this.limits.ageMs
      const work = expired() ? Promise.reject(new Error('dispatch age exceeded')) : this.deliver(batch.map(item => item.value), expired)
      void work.then(() => {
        this.metrics.batches++
        this.metrics.delivered += batch.length
        for (const item of batch) {
          const delay = Date.now() - item.at
          this.metrics.delayTotalMs += delay
          this.metrics.delayMaxMs = Math.max(this.metrics.delayMaxMs, delay)
        }
      }).catch(() => {
        this.metrics.rejected += batch.length
        this.resync(batch.map(item => item.value))
      }).finally(() => {
        this.count -= batch.length
        this.bytes -= batch.reduce((sum, item) => sum + item.bytes, 0)
        this.active--
        route.running = false
        route.startedAt = undefined
        this.routes.delete(key)
        // Move busy rooms to the tail so other rooms get the next slot.
        if (route.items.length) this.routes.set(key, route)
        this.schedule()
      })
    }
  }
}
