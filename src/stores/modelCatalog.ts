import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import { api, type ApiModelCatalog } from '@/api/client'
import { modelPlatformLabel } from '@/lib/modelPlatforms'
import { useAuth } from '@/stores/auth'

export interface CatalogPlatform {
  platform: string
  status?: string
  stale?: boolean
  models?: string[]
  diagnostic?: string
  errorCode?: string | null
}

export type Catalog = ApiModelCatalog & {
  byoa?: Array<{ companyId: string; computerId: string; engine: string; models: string[] }>
}

export function catalogPlatforms(catalog: Catalog | null): CatalogPlatform[] {
  const platforms = catalog?.platforms
  return Array.isArray(platforms) ? platforms : Object.entries(platforms ?? {}).map(([platform, status]) => ({ ...status, platform }))
}

export function catalogOptions(catalog: Catalog | null, bucket: 'text' | 'image' | 'audio' | 'embedding'): string[] {
  if (!catalog) return []
  const local = new Set(catalog.byoa?.flatMap((entry) => entry.models) ?? [])
  const managed = new Set(catalogPlatforms(catalog).flatMap((entry) => entry.models ?? []))
  // T9's compatibility buckets also include BYOA models. Keep those in their host picker.
  return [...new Set(catalog[bucket])].filter((id) => !local.has(id) || managed.has(id)
    || catalog.models?.some((m) => m.id === id && m.source !== 'byoa'))
}

export interface CatalogIndex {
  ids: string[]
  idSet: Set<string>
  hintById: Map<string, string>
  groupById: Map<string, string>
}

const EMPTY_INDEX: CatalogIndex = {
  ids: [],
  idSet: new Set(),
  hintById: new Map(),
  groupById: new Map(),
}
const indexCache = new WeakMap<object, CatalogIndex>()

/** One scan of a catalog object: ids, platform group, and hint. Cached by identity. */
export function catalogIndex(catalog: Catalog | null): CatalogIndex {
  if (!catalog) return EMPTY_INDEX
  const hit = indexCache.get(catalog)
  if (hit) return hit
  const hintById = new Map<string, string>()
  const groupById = new Map<string, string>()
  const ids: string[] = []
  const idSet = new Set<string>()
  const addId = (id: string) => {
    if (!id || idSet.has(id)) return
    idSet.add(id)
    ids.push(id)
  }
  for (const platform of catalogPlatforms(catalog)) {
    const group = modelPlatformLabel(platform.platform)
    const hint = `${group} · ${platform.stale ? 'stale' : 'live'}`
    for (const id of platform.models ?? []) {
      addId(id)
      if (!groupById.has(id)) groupById.set(id, group)
      const prev = hintById.get(id)
      hintById.set(id, prev ? `${prev} / ${hint}` : hint)
    }
  }
  for (const bucket of ['text', 'image', 'audio', 'embedding'] as const) {
    for (const id of catalogOptions(catalog, bucket)) addId(id)
  }
  for (const model of catalog.models ?? []) {
    if (!hintById.has(model.id) && model.source) hintById.set(model.id, model.source)
  }
  const index = { ids, idSet, hintById, groupById }
  indexCache.set(catalog, index)
  return index
}

export function catalogSource(catalog: Catalog | null, id: string): string {
  return catalogIndex(catalog).hintById.get(id)
    ?? catalog?.models?.find((m) => m.id === id)?.source
    ?? 'configured / history'
}

const CATALOG_TTL_MS = 60_000

interface ModelCatalogState {
  scope: string | null
  catalog: Catalog | null
  error: string | null
  loading: boolean
  fetchedAt: number
  ensure: (scope: string, opts?: { refresh?: boolean }) => Promise<void>
}

let inflight: { scope: string; refresh: boolean; promise: Promise<void> } | null = null

export const useModelCatalogStore = create<ModelCatalogState>((set, get) => ({
  scope: null,
  catalog: null,
  error: null,
  loading: false,
  fetchedAt: 0,
  async ensure(scope, opts) {
    const refresh = opts?.refresh === true
    const current = get()
    if (!refresh && current.scope === scope && current.catalog && !current.error
      && Date.now() - current.fetchedAt < CATALOG_TTL_MS) {
      return
    }
    if (inflight && inflight.scope === scope && (!refresh || inflight.refresh)) {
      return inflight.promise
    }
    const session = useAuth.getState()
    const stillCurrent = () => useAuth.getState().contextEpoch === session.contextEpoch
      && useAuth.getState().token === session.token
      && useAuth.getState().activeCompanyId === session.activeCompanyId
    if (current.scope !== scope) {
      set({ scope, loading: true, error: null, catalog: null, fetchedAt: 0 })
    } else if (refresh || !current.catalog) {
      set({ loading: true, error: refresh ? current.error : null })
    }
    let promise!: Promise<void>
    promise = (async () => {
      try {
        const catalog = await api.getAvailableModels(refresh)
        if (!stillCurrent()) return
        set((s) => {
          if (s.scope !== scope) return s
          if (s.catalog === catalog) return { loading: false, error: null, fetchedAt: Date.now() }
          return { catalog, error: null, loading: false, fetchedAt: Date.now() }
        })
      } catch (error) {
        if (!stillCurrent()) return
        set((s) => {
          if (s.scope !== scope) return s
          return {
            catalog: s.catalog
              ? { ...s.catalog, platforms: catalogPlatforms(s.catalog).map((p) => ({ ...p, stale: true })) }
              : null,
            error: error instanceof Error ? error.message : String(error),
            loading: false,
          }
        })
      } finally {
        if (inflight?.promise === promise) inflight = null
      }
    })()
    inflight = { scope, refresh, promise }
    return promise
  },
}))

export function useModelCatalog(enabled = true) {
  const epoch = useAuth((s) => s.contextEpoch)
  const company = useAuth((s) => s.activeCompanyId)
  const identity = useAuth((s) => s.user?.id)
  const scope = JSON.stringify([epoch, identity, company])
  const catalog = useModelCatalogStore((s) => (s.scope === scope ? s.catalog : null))
  const error = useModelCatalogStore((s) => (s.scope === scope ? s.error : null))
  const loading = useModelCatalogStore((s) => (s.scope === scope ? s.loading : false))
  useEffect(() => {
    if (!enabled) return
    void useModelCatalogStore.getState().ensure(scope)
  }, [enabled, scope])
  const refresh = useCallback(() => {
    void useModelCatalogStore.getState().ensure(scope, { refresh: true })
  }, [scope])
  if (!enabled) return { catalog: null, error: null, loading: false, refresh }
  return {
    catalog,
    error,
    loading: loading || (catalog == null && error == null),
    refresh,
  }
}
