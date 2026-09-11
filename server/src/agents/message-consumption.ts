/** Only completed input receives durable consumption receipts. */
export class TurnMessageConsumption {
  private readonly messages = new Map<string, { conversationId: string; stage: 'queued' | 'injected' | 'completed' }>()

  queue(messageId: string, conversationId: string): void {
    if (!this.messages.has(messageId)) this.messages.set(messageId, { conversationId, stage: 'queued' })
  }

  inject(messageId: string, conversationId: string): void {
    this.queue(messageId, conversationId)
    const message = this.messages.get(messageId)!
    if (message.stage === 'queued') message.stage = 'injected'
  }

  finish(success: boolean): Map<string, string[]> {
    const receipts = new Map<string, string[]>()
    if (!success) return receipts
    for (const [id, message] of this.messages) {
      if (message.stage === 'queued') continue
      message.stage = 'completed'
      const ids = receipts.get(message.conversationId) ?? []
      ids.push(id)
      receipts.set(message.conversationId, ids)
    }
    return receipts
  }
}
