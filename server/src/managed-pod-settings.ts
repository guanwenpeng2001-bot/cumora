import type { ServerSettingsSnapshot } from './settings.js'

/** Version 2 contains policy only. Credentials and routing are server-owned. */
export interface ManagedPodSettings {
  version: 2
  agentId: string
  companyId: string
  policy: ServerSettingsSnapshot
  defaults: Readonly<Record<string, string>>
  source: 'bootstrap' | 'db'
}

let current: ManagedPodSettings | null = null
let loaded = false

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** A new binary can start from a v1 manifest, but discards its credential fields. */
export function parseManagedPodSettings(value: unknown): ManagedPodSettings {
  const next = value as ManagedPodSettings
  const legacy = value as { version: number; gateway?: { companyId?: string } }
  const companyId = legacy?.version === 1 ? legacy.gateway?.companyId : next?.companyId
  if (!next || ![1, 2].includes(legacy.version) || typeof next.agentId !== 'string' || !next.agentId
    || typeof companyId !== 'string' || !companyId || !next.policy || typeof next.policy.revision !== 'string' || !/^\d+$/.test(next.policy.revision)
    || !next.policy.settings || !next.policy.sources || !next.defaults
    || ![next.defaults, next.policy.settings].every(map => typeof map === 'object' && !Array.isArray(map)
      && Object.values(map).every(v => typeof v === 'string'))
    || !['bootstrap', 'db'].includes(next.source)) throw new Error('Invalid managed Pod bootstrap')
  return { version: 2, agentId: next.agentId, companyId,
    policy: structuredClone(next.policy), defaults: { ...next.defaults }, source: next.source }
}

export function installManagedPodSettings(value: ManagedPodSettings): void {
  const next = parseManagedPodSettings(value)
  if ((process.env.CUMORA_AGENT_ID && next.agentId !== process.env.CUMORA_AGENT_ID)
    || (current && (next.agentId !== current.agentId || next.companyId !== current.companyId))) {
    throw new Error('Managed Pod configuration identity mismatch')
  }
  if (current && BigInt(next.policy.revision) < BigInt(current.policy.revision)) return
  current = freeze(next)
  process.env.CUMORA_MANAGED_POD_BOOTSTRAP = JSON.stringify(current)
  loaded = true
}

export function getManagedPodSettings(): ManagedPodSettings | null {
  if (loaded) return current
  const raw = process.env.CUMORA_MANAGED_POD_BOOTSTRAP
  if (!raw) { loaded = true; return null }
  try { installManagedPodSettings(parseManagedPodSettings(JSON.parse(raw))) }
  catch { throw new Error('Invalid managed Pod bootstrap') }
  return current
}
