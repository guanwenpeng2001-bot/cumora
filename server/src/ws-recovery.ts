import type { WebSocket } from 'ws'

export interface RecoveryEvent {
  companyId?: string
  type?: string
  recipientUserIds?: string[]
  mentionedIds?: string[]
  participant?: { id: string; kind: string }
  message?: { deliveryRecipientId?: string }
}

interface RecoveryClient { userId: string; companies: Set<string>; ws: WebSocket }

/** Recovery scope is a conservative superset for this socket's lifetime, never
 * permission to send a business frame. Retain removals for terminal notices. */
export function trackWsRecoveryScope(clients: Iterable<RecoveryClient>, event: RecoveryEvent): void {
  if (!event.companyId) return
  for (const client of clients) {
    if (event.type === 'participants.added' && event.participant?.kind === 'human' && event.participant.id === client.userId
      || event.type === 'workspace.membership' && event.recipientUserIds?.includes(client.userId)) {
      client.companies.add(event.companyId)
    }
  }
}

export function resyncWsClients(clients: Iterable<RecoveryClient>, batch: { event: RecoveryEvent }[]): void {
  const global = !batch.length || batch.some(({ event }) => typeof event.companyId !== 'string' || !event.companyId)
  const companies = new Set(batch.map(({ event }) => event.companyId))
  // Targeted terminal notices can refer to someone who has already left.
  const users = new Set(batch.flatMap(({ event }) => [
    ...event.recipientUserIds ?? [], ...event.mentionedIds ?? [],
    event.message?.deliveryRecipientId,
  ]))
  for (const c of clients) {
    if (!global && !users.has(c.userId) && ![...c.companies].some(id => companies.has(id))) continue
    if (c.ws.readyState !== c.ws.OPEN) continue
    try {
      c.ws.send(JSON.stringify({ type: 'sync.required', reason: 'realtime_backlog', recovery: 'reconnect_then_rest' }))
      c.ws.close(1013, 'REST sync required; reconnect')
    } catch { c.ws.terminate() }
  }
}
