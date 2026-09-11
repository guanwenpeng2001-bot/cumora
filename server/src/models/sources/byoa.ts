import type { ModelOffering } from '../../../../shared/model-contract.js'
import { record, str, type ComputerInventory } from '../inventory.js'

/** Bounded transient grace is descriptive only. Revocation never receives grace. */
export function computerAvailability(computer: ComputerInventory, now = Date.now()): ModelOffering['availability'] {
  const observed = computer.last_seen_at ? new Date(computer.last_seen_at).getTime() : 0
  const fresh = observed > 0 && now - observed < 120_000
  return { configured: true, enabled: !computer.revoked_at, health: computer.revoked_at ? 'revoked' : fresh ? computer.status === 'offline' ? 'stale' : 'reported' : 'offline',
    entitlement: 'unknown', schedulable: false, reasonCodes: [computer.revoked_at ? 'computer-revoked' : fresh ? 'execution-not-verified' : 'computer-offline', 'shadow-only'],
    ...(observed ? { observedAt: new Date(observed).toISOString(), expiresAt: new Date(observed + 120_000).toISOString() } : {}) }
}
export function engineInventories(computer: ComputerInventory) {
  return (Array.isArray(computer.detected_engines) ? computer.detected_engines : []).map(record).filter(e => str(e.id))
}
