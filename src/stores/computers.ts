import { create } from 'zustand'
import { api, ws, type ApiComputer } from '@/api/client'
import type { Computer, ComputerStatus } from '@/types'
import { commitIfContextCurrent } from '@/stores/auth'

interface ComputersState {
  byId: Record<string, Computer>
  loaded: boolean
  /** Hard reload — clears first; used at boot / workspace switch. */
  load: () => Promise<void>
  /** Quiet re-fetch — keeps the list visible during the round-trip. */
  refresh: () => Promise<void>
  /** Patch a single computer's status from a WS event. */
  applyStatus: (id: string, status: ComputerStatus) => void
}

function fromApi(c: ApiComputer): Computer {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    status: c.status,
    availableEngines: c.available_engines ?? [],
    detectedEngines: c.detected_engines ?? [],
    enginesDetectedAt: c.engines_detected_at ?? null,
    lastSeenAt: c.last_seen_at ?? null,
    pairedAt: c.paired_at ?? null,
    daemonVersion: c.daemon_version ?? null,
    daemonSupervised: c.daemon_supervised ?? null,
    latestDaemonVersion: c.latest_daemon_version ?? null,
    latestDaemonDownloadUrl: c.latest_daemon_download_url ?? null,
    daemonOutdated: c.daemon_outdated ?? false,
    runtimePolicy: c.runtimePolicy,
  }
}

function computersEqual(a: Record<string, Computer>, b: Record<string, Computer>): boolean {
  const ids = Object.keys(b)
  if (Object.keys(a).length !== ids.length) return false
  for (const id of ids) {
    if (!a[id] || JSON.stringify(a[id]) !== JSON.stringify(b[id])) return false
  }
  return true
}

let inflight: Promise<void> | null = null

async function fetchInto(set: (partial: Partial<ComputersState> | ((s: ComputersState) => ComputersState | Partial<ComputersState>)) => void): Promise<void> {
  if (inflight) return inflight
  const mine = (async () => {
    try {
      await commitIfContextCurrent(() => api.getComputers(), (list) => {
        const byId: Record<string, Computer> = {}
        for (const c of list) byId[c.id] = fromApi(c)
        set((s) => (s.loaded && computersEqual(s.byId, byId) ? s : { byId, loaded: true }))
      })
    } catch (err) {
      console.warn('[computers] fetch failed', err)
    }
  })()
  inflight = mine
  try {
    await mine
  } finally {
    if (inflight === mine) inflight = null
  }
}

export const useComputers = create<ComputersState>((set) => ({
  byId: {},
  loaded: false,
  async load() {
    set({ byId: {}, loaded: false })
    await fetchInto(set)
  },
  async refresh() {
    await fetchInto(set)
  },
  applyStatus(id, status) {
    set((s) => {
      const cur = s.byId[id]
      if (!cur) return {}
      return { byId: { ...s.byId, [id]: { ...cur, status } } }
    })
  },
}))

let wsBound = false
export function bootComputers() {
  void useComputers.getState().load()
  if (wsBound) return
  wsBound = true
  ws.connect()
  ws.on((e) => {
    if (e.type === 'hello') {
      // Reconnect — Redis pubsub doesn't replay, so backfill any status
      // transition we missed while disconnected.
      void useComputers.getState().refresh()
    } else if (e.type === 'computers.status') {
      const known = useComputers.getState().byId[e.computerId]
      if (e.status === 'online' || !known) {
        // Two cases, both want a full re-fetch rather than a status-only patch:
        //  - status 'online': a daemon just (re)connected — almost always a
        //    restart-to-upgrade. The broadcast carries no version, so patching
        //    only the status dot would leave the stale "outdated" upgrade banner
        //    up. Re-fetching recomputes daemon_version / daemon_outdated for the
        //    daemon that just came back.
        //  - unknown computer: just created by pairing — pull it in (named
        //    after the real machine).
        // Online transitions only fire on offline→online, never on per-task
        // busy churn, so this isn't chatty.
        void useComputers.getState().refresh()
      } else {
        useComputers.getState().applyStatus(e.computerId, e.status)
      }
    }
  })
}
