import { create } from 'zustand'
import { api, type ApiAutonomy } from '@/api/client'
import { commitIfContextCurrent, useAuth } from '@/stores/auth'

interface PrefsState {
  prefs: Record<string, unknown>
  autonomy: Record<string, ApiAutonomy>
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  setPref: (key: string, value: unknown) => Promise<void>
  setAutonomy: (agentId: string, threshold: number) => Promise<void>
}

type Edit = { key: string; value: unknown }
let confirmedPrefs: Record<string, unknown> = {}
let edits: Edit[] = []
let queue = Promise.resolve()
let revision = 0
function paintPrefs() {
  const prefs = { ...confirmedPrefs }
  for (const edit of edits) prefs[edit.key] = edit.value
  usePrefs.setState({ prefs })
}

export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: {}, autonomy: {}, loaded: false, error: null,
  async load() {
    const startRevision = revision
    await commitIfContextCurrent(
      () => Promise.all([api.getPreferences(), api.getAllAutonomy()]),
      ([prefs, auto]) => {
        if (revision !== startRevision) return
        confirmedPrefs = prefs
        const autonomy: Record<string, ApiAutonomy> = {}
        for (const a of auto) autonomy[a.agentId] = a
        set({ prefs, autonomy, loaded: true, error: null })
      },
      error => set({ error: error instanceof Error ? error.message : String(error) }),
    )
  },
  setPref(key, value) {
    const epoch = useAuth.getState().contextEpoch
    const edit = { key, value }
    edits.push(edit)
    ++revision
    paintPrefs()
    const task = queue.then(async () => {
      if (useAuth.getState().contextEpoch !== epoch) return
      if (!get().loaded) {
        let ready = false
        const current = await commitIfContextCurrent(() => api.getPreferences(), prefs => {
          confirmedPrefs = prefs
          ready = true
          set({ loaded: true })
        }, error => set({ error: error instanceof Error ? error.message : String(error) }))
        if (!current) return
        if (!ready) {
          edits = edits.filter(item => item !== edit)
          paintPrefs()
          return
        }
      }
      const next = { ...confirmedPrefs, [key]: value }
      await commitIfContextCurrent(() => api.putPreferences(next), () => {
        confirmedPrefs = next
        set({ error: null })
      }, error => set({ error: error instanceof Error ? error.message : String(error) }), () => {
        edits = edits.filter(item => item !== edit)
        paintPrefs()
      })
    })
    queue = task.catch(() => {})
    return task
  },
  setAutonomy(agentId, threshold) {
    const epoch = useAuth.getState().contextEpoch
    ++revision
    const task = queue.then(async () => {
      if (useAuth.getState().contextEpoch !== epoch) return
      const previous = get().autonomy[agentId]
      const optimistic = {
        ...(previous ?? { userId: useAuth.getState().user?.id ?? '', agentId, pulled: 0, led: 0, dissolved: 0, threshold: 0.6 }),
        threshold,
      }
      set(s => ({ autonomy: { ...s.autonomy, [agentId]: optimistic } }))
      await commitIfContextCurrent(() => api.putAutonomy(agentId, threshold), result => {
        set(s => ({ autonomy: { ...s.autonomy, [agentId]: { ...optimistic, threshold: result.threshold } }, error: null }))
      }, error => {
        const autonomy = { ...get().autonomy }
        if (previous) autonomy[agentId] = previous
        else delete autonomy[agentId]
        set({ autonomy, error: error instanceof Error ? error.message : String(error) })
      })
    })
    queue = task.catch(() => {})
    return task
  },
}))

useAuth.subscribe((state, previous) => {
  if (state.contextEpoch === previous.contextEpoch) return
  ++revision
  confirmedPrefs = {}
  edits = []
  queue = Promise.resolve()
  usePrefs.setState({ prefs: {}, autonomy: {}, loaded: false, error: null })
})
