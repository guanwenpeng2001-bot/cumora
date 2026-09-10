import { useEffect, useState } from 'react'
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

export function catalogSource(catalog: Catalog | null, id: string): string {
  const platforms = catalogPlatforms(catalog).filter((p) => p.models?.includes(id))
  if (platforms.length) return platforms.map((p) => `${modelPlatformLabel(p.platform)} · ${p.stale ? 'stale' : 'live'}`).join(' / ')
  return catalog?.models?.find((m) => m.id === id)?.source ?? 'configured / history'
}

export function useModelCatalog(enabled = true, domain = 'managed') {
  const epoch = useAuth((s) => s.contextEpoch)
  const company = useAuth((s) => s.activeCompanyId)
  const identity = useAuth((s) => s.user?.id)
  const scope = JSON.stringify([epoch, identity, company, domain])
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<{ scope: string; catalog: Catalog | null; error: string | null; loading: boolean }>({ scope, catalog: null, error: null, loading: enabled })
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const session = useAuth.getState()
    const current = () => !controller.signal.aborted && useAuth.getState().contextEpoch === session.contextEpoch
      && useAuth.getState().token === session.token && useAuth.getState().activeCompanyId === session.activeCompanyId
    setState((old) => ({ scope, catalog: old.scope === scope ? old.catalog : null, error: null, loading: true }))
    void api.getAvailableModels(reload > 0, controller.signal).then((catalog) => {
      if (current()) setState({ scope, catalog, error: null, loading: false })
    }).catch((error) => {
      if (current()) setState((old) => ({ ...old,
        catalog: old.catalog ? { ...old.catalog, platforms: catalogPlatforms(old.catalog).map((p) => ({ ...p, stale: true })) } : null,
        error: error instanceof Error ? error.message : String(error), loading: false }))
    })
    return () => controller.abort()
  }, [scope, enabled, reload])
  const visible = enabled && state.scope === scope ? state : { catalog: null, error: null, loading: enabled }
  return { ...visible, refresh: () => setReload((n) => n + 1) }
}
