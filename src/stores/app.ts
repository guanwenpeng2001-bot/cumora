import { create } from 'zustand'
import type { CalendarEvent, ViewKey } from '@/types'
import { applyDraftUpdate, type ComposerDraft } from './composerDrafts'
import { loadComposerDrafts, saveComposerDrafts } from './composerDraftsStorage'

export type { ComposerDraft }

export type CalendarEditing = { mode: 'edit'; event: CalendarEvent }
  | { mode: 'new'; prefill?: { startAt: Date; endAt?: Date | null; allDay?: boolean } } | null

interface AppState {
  calendarEditing: CalendarEditing
  setCalendarEditing: (editing: CalendarEditing) => void
  calendarCursor: Date
  setCalendarCursor: (cursor: Date | ((current: Date) => Date)) => void

  librarySection: 'documents' | 'boards' | 'calendar'
  setLibrarySection: (section: 'documents' | 'boards' | 'calendar') => void
  mapLayout: (mobile: boolean) => void
  view: ViewKey['view']
  setView: (v: ViewKey['view']) => void

  selectedConversationId: string | null
  selectConversation: (id: string | null) => void
  setSelectedIfNone: (id: string) => void

  /** mobile-only: which level of the navigation stack we're on */
  mobileStack: 'list' | 'chat' | 'info'
  pushMobileStack: (s: 'list' | 'chat' | 'info') => void

  /**
   * Right info pane on desktop. null = pane is closed. Set to an agent id to
   * pin that specific agent's profile open. Closing happens explicitly (× in
   * the pane); the pane no longer rotates as agent statuses change.
   */
  infoAgentId: string | null
  openAgentInfo: (agentId: string) => void
  closeAgentInfo: () => void

  /**
   * Composer state — currently-quoted message id, keyed by conversation.
   * `{ convoId: messageId }` so switching rooms doesn't drop another room's
   * reply draft. Cleared on send / explicit dismiss.
   */
  replyingTo: Record<string, string>
  setReplyingTo: (convoId: string, messageId: string | null) => void

  /**
   * Centralized "scroll to a message" — set this and the active ChatPane (or
   * MobileChat) picks it up, calls Virtuoso scrollToIndex (which MOUNTS
   * off-screen rows reliably, unlike getElementById), flashes the row, then
   * clears the field. Quote-jumps and `#N` chips both go through here so
   * neither silently no-ops when the target isn't currently mounted.
   */
  pendingJumpMessageId: string | null
  jumpToMessage: (messageId: string) => void
  clearPendingJump: () => void

  /**
   * Composer drafts, keyed by composer SCOPE (a conversation id, or
   * `<id>::thread::<rootId>` for the desktop thread drawer).
   *
   * Both shells route through here for the same reason: their composer is
   * unmounted by ordinary navigation. Mobile loses MobileChat on chat → list
   * → chat; desktop loses the whole ChatPane the moment `view` leaves
   * `conversations`, because DesktopApp mounts views conditionally. Component
   * state cannot survive either, so a half-typed message can't live there.
   * The store is also mirrored to localStorage (see
   * ./composerDraftsStorage), so a
   * reload or an app restart doesn't lose it either. Cleared on send, and on
   * sign-out so drafts don't cross accounts on a shared device.
   */
  composerDrafts: Record<string, ComposerDraft>
  /** Text-only convenience for the mobile composer. */
  setComposerDraft: (convoId: string, text: string) => void
  /** Full read-modify-write, used by the desktop composer (which also carries
   *  an attachment). The updater sees the current draft and returns the next. */
  updateComposerDraft: (scope: string, updater: (current: ComposerDraft) => ComposerDraft) => void
  clearComposerDrafts: () => void

  /**
   * Thread drawer state — when set, the right pane shows the thread view
   * for `{ convoId, rootId }`. Null means closed. Only one open at a time;
   * opening a new thread replaces the previous.
   */
  openThread: { convoId: string; rootId: string } | null
  openThreadView: (convoId: string, rootId: string) => void
  closeThreadView: () => void

  /**
   * Conversation-side artifact peeks. Artifacts opened from chat messages
   * occupy the same right rail as threads / agent profiles so the user can
   * inspect the work without leaving the conversation.
   */
  openDocumentId: string | null
  openDocumentPeek: (documentId: string) => void
  closeDocumentPeek: () => void
  openBoardId: string | null
  openBoardCardId: string | null
  openBoardPeek: (boardId: string, cardId?: string | null) => void
  closeBoardPeek: () => void
  openCalendarEventId: string | null
  openCalendarEventPeek: (eventId: string) => void
  closeCalendarEventPeek: () => void

  /**
   * Email composer state — when set, an overlay drawer is rendered on top
   * of the chat pane. `mode='new'` is a fresh thread; `mode='reply'` is
   * pre-filled from an existing email message (the server derives subject
   * Re:, In-Reply-To, and the recipient list from `replyToMessageId`).
   * Null = composer closed.
   */
  composeEmail: { mode: 'new' } | { mode: 'reply'; replyToMessageId: string } | null
  openComposeNew: () => void
  openComposeReply: (replyToMessageId: string) => void
  closeCompose: () => void
}

export const useApp = create<AppState>((set) => ({
  calendarEditing: null,
  setCalendarEditing: (calendarEditing) => set({ calendarEditing }),
  calendarCursor: new Date(),
  setCalendarCursor: (calendarCursor) => set(s => ({ calendarCursor: typeof calendarCursor === 'function' ? calendarCursor(s.calendarCursor) : calendarCursor })),
  librarySection: 'documents',
  setLibrarySection: (librarySection) => set({ librarySection }),
  mapLayout: (mobile) => set(s => {
    if (mobile && ['documents', 'boards', 'calendar'].includes(s.view)) {
      return { view: 'library', librarySection: s.view as AppState['librarySection'] }
    }
    if (!mobile && s.view === 'library') return { view: s.librarySection }
    return s
  }),
  view: 'conversations',
  setView: (v) => set(s => ({ view: v,
    librarySection: ['documents', 'boards', 'calendar'].includes(v) ? v as AppState['librarySection'] : s.librarySection,
  })),

  // Starts unselected — the real conversations list arrives async from the
  // server. Seeding with a mock id here used to fire a 404 messages fetch
  // before the user picked anything.
  selectedConversationId: null,
  selectConversation: (id) => set({ selectedConversationId: id, mobileStack: id ? 'chat' : 'list' }),
  setSelectedIfNone: (id) => set((s) => s.selectedConversationId ? {} : { selectedConversationId: id }),

  mobileStack: 'list',
  pushMobileStack: (s) => set({ mobileStack: s }),

  infoAgentId: null,
  // Opening agent info closes any open thread — they share the same right
  // slot in DesktopApp. Keeping both states in sync here means the UI never
  // sees both flags on at once.
  openAgentInfo: (agentId) =>
    set({ infoAgentId: agentId, openThread: null, openDocumentId: null, openBoardId: null, openBoardCardId: null, openCalendarEventId: null }),
  closeAgentInfo: () => set({ infoAgentId: null }),

  replyingTo: {},
  setReplyingTo: (convoId, messageId) => set((s) => {
    const next = { ...s.replyingTo }
    if (messageId) next[convoId] = messageId
    else delete next[convoId]
    return { replyingTo: next }
  }),

  pendingJumpMessageId: null,
  // The ChatPane effect clears this after consuming it (scrollToIndex + flash),
  // so repeated jumps to the same id transition null→id each time and re-fire.
  jumpToMessage: (messageId) => set({ pendingJumpMessageId: messageId }),
  clearPendingJump: () => set({ pendingJumpMessageId: null }),

  composerDrafts: loadComposerDrafts(),
  updateComposerDraft: (scope, updater) => set((s) => {
    const next = applyDraftUpdate(s.composerDrafts, scope, updater)
    // applyDraftUpdate returns the same reference when nothing changed, which
    // keeps this a no-op render AND avoids a pointless localStorage write.
    if (next === s.composerDrafts) return s
    saveComposerDrafts(next)
    return { composerDrafts: next }
  }),
  setComposerDraft: (convoId, text) => {
    useApp.getState().updateComposerDraft(convoId, (current) => ({ ...current, text }))
  },
  clearComposerDrafts: () => set(() => {
    saveComposerDrafts({})
    return { composerDrafts: {} }
  }),

  openThread: null,
  openThreadView: (convoId, rootId) =>
    set({ openThread: { convoId, rootId }, infoAgentId: null, openDocumentId: null, openBoardId: null, openBoardCardId: null, openCalendarEventId: null }),
  closeThreadView: () => set({ openThread: null }),

  openDocumentId: null,
  openDocumentPeek: (documentId) =>
    set({ openDocumentId: documentId, openBoardId: null, openBoardCardId: null, openCalendarEventId: null, openThread: null, infoAgentId: null }),
  closeDocumentPeek: () => set({ openDocumentId: null }),
  openBoardId: null,
  openBoardCardId: null,
  openBoardPeek: (boardId, cardId = null) =>
    set({ openBoardId: boardId, openBoardCardId: cardId, openDocumentId: null, openCalendarEventId: null, openThread: null, infoAgentId: null }),
  closeBoardPeek: () => set({ openBoardId: null, openBoardCardId: null }),
  openCalendarEventId: null,
  openCalendarEventPeek: (eventId) =>
    set({ openCalendarEventId: eventId, openDocumentId: null, openBoardId: null, openBoardCardId: null, openThread: null, infoAgentId: null }),
  closeCalendarEventPeek: () => set({ openCalendarEventId: null }),

  composeEmail: null,
  openComposeNew: () => set({ composeEmail: { mode: 'new' } }),
  openComposeReply: (replyToMessageId) => set({ composeEmail: { mode: 'reply', replyToMessageId } }),
  closeCompose: () => set({ composeEmail: null }),
}))
