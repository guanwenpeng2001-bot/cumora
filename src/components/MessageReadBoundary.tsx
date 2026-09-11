import { useEffect, useRef, type ReactNode } from 'react'
import type { Message } from '@/types'
import { api } from '@/api/client'
import { commitIfContextCurrent, useAuth } from '@/stores/auth'
import { useApp } from '@/stores/app'
import { useConversations } from '@/stores/conversations'
import { useIsMobile } from '@/lib/utils'

const confirmed = new Map<string, number>()
const pending = new Map<string, number>()
type ReadCandidate = { key: string; conversationId: string; messageId: string; sequence: number; current: () => boolean }
const queued = new Map<string, ReadCandidate>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
function enqueue(candidate: ReadCandidate) {
  const { key } = candidate
  if ((queued.get(key)?.sequence ?? 0) < candidate.sequence) queued.set(key, candidate)
  if (timers.has(key)) return
  timers.set(key, setTimeout(() => {
    timers.delete(key)
    const latest = queued.get(key)
    queued.delete(key)
    if (!latest || !latest.current() || (confirmed.get(key) ?? 0) >= latest.sequence
      || (pending.get(key) ?? 0) >= latest.sequence) return
    pending.set(key, latest.sequence)
    void commitIfContextCurrent(
      () => api.markRead(latest.conversationId, { messageId: latest.messageId, sequence: latest.sequence }),
      () => {
        confirmed.set(key, Math.max(confirmed.get(key) ?? 0, latest.sequence))
        void useConversations.getState().reload()
      },
      () => { /* Keep the badge; observing again on focus retries. */ },
      () => { if (pending.get(key) === latest.sequence) pending.delete(key) },
    )
  }, 50))
}
useAuth.subscribe((state, previous) => {
  if (state.contextEpoch === previous.contextEpoch) return
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear(); queued.clear(); confirmed.clear(); pending.clear()
})

/** Only persisted rows intersecting the chat viewport can advance a receipt. */
export function MessageReadBoundary({ message, children }: { message: Message; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const mobile = useIsMobile()
  const view = useApp(s => s.view)
  const selected = useApp(s => s.selectedConversationId)
  const stack = useApp(s => s.mobileStack)
  const mobileOverlay = useApp(s => !!(s.openDocumentId || s.openBoardId || s.openCalendarEventId || s.infoAgentId))
  const epoch = useAuth(s => s.contextEpoch)
  const sequence = message.sequence
  const conversationId = message.conversationId
  const eligible = view === 'conversations' && selected === conversationId && (!mobile || (stack === 'chat' && !mobileOverlay))
    && !message.pending && !message.failed && !message.unconfirmed
  useEffect(() => {
    const el = ref.current
    if (!el || !eligible || !conversationId || !Number.isSafeInteger(sequence) || !sequence
      || sequence === Number.MAX_SAFE_INTEGER) return
    const key = `${epoch}:${conversationId}`
    let visible = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const observe = () => { observer.unobserve(el); observer.observe(el) }
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.target === el && entry.isIntersecting && entry.intersectionRect.height > 0)
      if (timer !== undefined) clearTimeout(timer)
      if (!visible || document.visibilityState !== 'visible' || !document.hasFocus()) return
      timer = setTimeout(() => {
        const app = useApp.getState()
        if (!visible || document.visibilityState !== 'visible' || !document.hasFocus()
          || app.view !== 'conversations' || app.selectedConversationId !== conversationId
          || document.querySelector('[aria-modal="true"]')
          || (mobile && (app.mobileStack !== 'chat' || app.openDocumentId || app.openBoardId || app.openCalendarEventId || app.infoAgentId)) || useAuth.getState().contextEpoch !== epoch
          || (confirmed.get(key) ?? 0) >= sequence || (pending.get(key) ?? 0) >= sequence) return
        enqueue({ key, conversationId, messageId: message.id, sequence, current: () => {
          const current = useApp.getState()
          return visible && document.visibilityState === 'visible' && document.hasFocus()
            && current.view === 'conversations' && current.selectedConversationId === conversationId
            && !document.querySelector('[aria-modal="true"]')
            && (!mobile || (current.mobileStack === 'chat' && !current.openDocumentId && !current.openBoardId && !current.openCalendarEventId && !current.infoAgentId)) && useAuth.getState().contextEpoch === epoch
        } })
      }, 180)
    }, { threshold: [0, 0.5, 1] })
    observer.observe(el)
    window.addEventListener('focus', observe)
    document.addEventListener('visibilitychange', observe)
    document.addEventListener('focusin', observe)
    return () => {
      visible = false
      observer.disconnect()
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener('focus', observe)
      document.removeEventListener('visibilitychange', observe)
      document.removeEventListener('focusin', observe)
    }
  }, [eligible, epoch, mobile, conversationId, message.id, sequence])
  return <div ref={ref}>{children}</div>
}
