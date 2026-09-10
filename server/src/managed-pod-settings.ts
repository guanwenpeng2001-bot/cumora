import type { DirectLlmSlot } from './env.js'
import type { ServerSettingsSnapshot } from './settings.js'
import type { TenantLlmContext } from './tenant-llm-context.js'

export const DIRECT_LLM_SLOTS = ['text', 'image', 'audio', 'embed', 'novita', 'orcarouter'] as const
export interface DirectLlmSettings {
  apiKey: string
  baseURL: string
  keySource: string
  endpointSource: string
  configured: boolean
  protocol: string
}

/** Private runtime payload. Never expose through the settings DTO. */
export interface ManagedPodSettings {
  version: 1
  agentId: string
  policy: ServerSettingsSnapshot
  defaults: Readonly<Record<string, string>>
  gateway: TenantLlmContext
  direct: Readonly<Record<DirectLlmSlot, DirectLlmSettings>>
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

export function installManagedPodSettings(next: ManagedPodSettings): void {
  if (current && (next.agentId !== current.agentId || next.gateway.companyId !== current.gateway.companyId)) {
    throw new Error('Managed Pod configuration identity mismatch')
  }
  if (current && BigInt(next.policy.revision) < BigInt(current.policy.revision)) return
  current = freeze(next)
  // Newly spawned CLI tools inherit the latest complete snapshot.
  process.env.CUMORA_MANAGED_POD_BOOTSTRAP = JSON.stringify(current)
  loaded = true
}

export function getManagedPodSettings(): ManagedPodSettings | null {
  if (loaded) return current
  loaded = true
  const raw = process.env.CUMORA_MANAGED_POD_BOOTSTRAP
  if (!raw) return null
  try {
    const next = JSON.parse(raw) as ManagedPodSettings
    if (next.version !== 1 || next.agentId !== process.env.CUMORA_AGENT_ID || !next.agentId
      || !/^\d+$/.test(next.policy.revision) || !next.gateway.companyId || !next.gateway.ownerId
      || typeof next.gateway.authorizationVersion !== 'string' || typeof next.gateway.baseURL !== 'string'
      || !next.gateway.keys || !next.defaults || !next.policy.settings || !next.policy.sources
      || !DIRECT_LLM_SLOTS.every(slot => {
        const direct = next.direct[slot]
        return direct && ['apiKey', 'baseURL', 'keySource', 'endpointSource', 'protocol'].every(key =>
          typeof direct[key as keyof DirectLlmSettings] === 'string') && typeof direct.configured === 'boolean'
      })) throw new Error('schema')
    installManagedPodSettings({ ...next, source: 'bootstrap' })
  } catch {
    loaded = false
    throw new Error('Invalid managed Pod bootstrap')
  }
  return current
}
