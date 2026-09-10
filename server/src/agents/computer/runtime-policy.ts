import { createHash } from 'node:crypto'

export const BYOA_SYNC_INTERVALS = Object.freeze({ policyHeartbeatMs: 30_000, resourceSyncMs: 60_000 })

export interface ByoaPolicyValues {
  bigBrainConcurrency: number
  triageConcurrency: number
  spawnIntervalMs: number
  triageTimeoutMs: number
  triageBackoffBaseMs: number
  triageBackoffMaxMs: number
  groupSteerEnabled: boolean
  groupSteerIntervalMs: number
}

export interface ByoaRuntimePolicy extends ByoaPolicyValues {
  schemaVersion: 1
  revision: string
  version: string
}

export interface ByoaPolicyReport {
  schemaVersion: 1
  received: string | null
  applied: string | null
}

export function makeByoaPolicy(revision: string, values: ByoaPolicyValues): ByoaRuntimePolicy {
  const digest = createHash('sha256').update(JSON.stringify(values)).digest('hex')
  return Object.freeze({ schemaVersion: 1, revision, version: `${revision}:${digest}`, ...values })
}

export function parseByoaPolicy(raw: unknown): ByoaRuntimePolicy | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (p.schemaVersion !== 1 || typeof p.revision !== 'string' || !/^\d{1,30}$/.test(p.revision)) return null
  const positive = ['bigBrainConcurrency', 'triageConcurrency', 'triageTimeoutMs', 'triageBackoffBaseMs', 'triageBackoffMaxMs']
  const nonnegative = ['spawnIntervalMs', 'groupSteerIntervalMs']
  for (const key of [...positive, ...nonnegative]) {
    if (!Number.isSafeInteger(p[key]) || Number(p[key]) < (positive.includes(key) ? 1 : 0) || Number(p[key]) > 2147483647) return null
  }
  if (typeof p.groupSteerEnabled !== 'boolean' || Number(p.triageBackoffBaseMs) > Number(p.triageBackoffMaxMs)) return null
  const values: ByoaPolicyValues = {
    bigBrainConcurrency: Number(p.bigBrainConcurrency), triageConcurrency: Number(p.triageConcurrency),
    spawnIntervalMs: Number(p.spawnIntervalMs), triageTimeoutMs: Number(p.triageTimeoutMs),
    triageBackoffBaseMs: Number(p.triageBackoffBaseMs), triageBackoffMaxMs: Number(p.triageBackoffMaxMs),
    groupSteerEnabled: p.groupSteerEnabled, groupSteerIntervalMs: Number(p.groupSteerIntervalMs),
  }
  const policy = makeByoaPolicy(p.revision, values)
  return p.version === policy.version ? policy : null
}

export function parseByoaPolicyReport(raw: unknown): ByoaPolicyReport | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const valid = (v: unknown): v is string | null => v === null || (typeof v === 'string' && /^\d{1,30}:[a-f0-9]{64}$/.test(v))
  if (p.schemaVersion !== 1 || !valid(p.received) || !valid(p.applied) || (p.applied && !p.received)) return null
  if (p.applied && p.received && BigInt(p.applied.split(':')[0]) > BigInt(p.received.split(':')[0])) return null
  return { schemaVersion: 1, received: p.received, applied: p.applied }
}

/** Reserve a slot before resolving a waiter, so fresh arrivals cannot steal it. */
export class ByoaSemaphore {
  private inFlight = 0
  private readonly waiters: Array<() => void> = []
  constructor(private max: number, private readonly onRelease: () => void = () => {}) {}
  acquire(): Promise<void> {
    return new Promise((resolve) => { this.waiters.push(resolve); this.drain() })
  }
  private drain(): void {
    while (this.inFlight < this.max && this.waiters.length) {
      this.inFlight += 1
      this.waiters.shift()!()
    }
  }
  setMax(max: number): void { this.max = max; this.drain() }
  release(): void { this.inFlight -= 1; this.onRelease(); this.drain() }
  get active(): number { return this.inFlight }
  get queueDepth(): number { return this.waiters.length }
}

/** A pending snapshot closes admission until existing spawns reach a safe boundary. */
export class ByoaPolicyController {
  readonly bigBrain: ByoaSemaphore
  readonly triage: ByoaSemaphore
  private received: ByoaRuntimePolicy | null = null
  private applied: ByoaRuntimePolicy | null = null
  private pending: ByoaRuntimePolicy | null = null
  values: Readonly<ByoaPolicyValues>
  constructor(local: ByoaPolicyValues, private readonly onApply: (values: ByoaPolicyValues) => void = () => {}) {
    this.values = Object.freeze({ ...local })
    this.bigBrain = new ByoaSemaphore(local.bigBrainConcurrency, () => this.applyPending())
    this.triage = new ByoaSemaphore(local.triageConcurrency, () => this.applyPending())
  }
  receive(raw: unknown): boolean {
    const policy = parseByoaPolicy(raw)
    if (!policy || (this.received && BigInt(policy.revision) < BigInt(this.received.revision))) return false
    if (policy.version === this.received?.version) return true
    this.received = this.pending = policy
    this.bigBrain.setMax(0)
    this.triage.setMax(0)
    this.applyPending()
    return true
  }
  private applyPending(): void {
    if (!this.pending || this.bigBrain.active || this.triage.active) return
    const policy = this.pending
    this.onApply(policy)
    this.values = this.applied = policy
    this.pending = null
    this.bigBrain.setMax(policy.bigBrainConcurrency)
    this.triage.setMax(policy.triageConcurrency)
  }
  report(): ByoaPolicyReport {
    return { schemaVersion: 1, received: this.received?.version ?? null, applied: this.applied?.version ?? null }
  }
}
