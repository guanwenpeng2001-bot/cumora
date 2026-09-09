/**
 * Local avatar cache.
 *
 * Holds participants' avatars as `URL.createObjectURL(blob)` keyed by
 * context, participant, URL and generation. Components (via `useCachedAvatarSrc`)
 * re-render automatically when the server broadcasts
 * `participants.avatar` for that id (the participants store calls
 * `invalidateAvatar(id)` from its WS listener).
 *
 * Falls back gracefully on fetch failure: the hook just emits the raw
 * remote URL so the browser's native `<img>` fetch can still try.
 *
 * Revocation discipline: an objectUrl that's currently the `src` of a
 * mounted <img> must NOT be revoked synchronously — the browser will
 * fail to render and React state still pointing at the dead URL would
 * surface as a broken-image fallback. We always schedule revocation
 * with a grace window (REVOKE_GRACE_MS) so subscribers have time to
 * swap to the new objectUrl first.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useAuth } from '@/stores/auth'
import { resolveAssetUrl } from '@/api/client'
import { isNativePlatform } from './native'

interface Entry {
  objectUrl: string
  fetchedAt: number
}

interface Pending {
  controller: AbortController
  promise: Promise<string | null>
}

const cache = new Map<string, Entry>()
const inFlight = new Map<string, Pending>()
const generations = new Map<string, number>()
const activeKeys = new Map<string, string>()
const listeners = new Set<() => void>()
let cacheGeneration = 0
let revision = 0
const AVATAR_TTL_MS = 60_000
const REVOKE_GRACE_MS = 5_000

function scheduleRevoke(objectUrl: string): void {
  setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_GRACE_MS)
}

function requestKey(participantId: string, url: string): string {
  const { contextEpoch, activeCompanyId } = useAuth.getState()
  return JSON.stringify([contextEpoch, activeCompanyId, participantId, url,
    cacheGeneration, generations.get(participantId) ?? 0])
}

function retire(key: string): void {
  inFlight.get(key)?.controller.abort()
  inFlight.delete(key)
  const entry = cache.get(key)
  if (entry) scheduleRevoke(entry.objectUrl)
  cache.delete(key)
}

function fetchAndCache(participantId: string, url: string): Promise<string | null> {
  const key = requestKey(participantId, url)
  const active = activeKeys.get(participantId)
  if (active && active !== key) retire(active)
  activeKeys.set(participantId, key)
  const prev = cache.get(key)
  if (prev && Date.now() - prev.fetchedAt < AVATAR_TTL_MS) {
    return Promise.resolve(prev.objectUrl)
  }
  const pending = inFlight.get(key)
  if (pending) return pending.promise
  const controller = new AbortController()
  const current = () => !controller.signal.aborted
    && requestKey(participantId, url) === key && activeKeys.get(participantId) === key
  const promise = (async () => {
    try {
      // Revalidate only avatar requests, including URLs overwritten in place.
      const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' })
      if (!current()) return null
      if (!response.ok) return url
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      if (!current()) {
        URL.revokeObjectURL(objectUrl)
        return null
      }
      cache.set(key, { objectUrl, fetchedAt: Date.now() })
      if (prev) scheduleRevoke(prev.objectUrl)
      notify()
      return objectUrl
    } catch {
      return current() ? url : null
    } finally {
      if (inFlight.get(key)?.controller === controller) inFlight.delete(key)
    }
  })()
  inFlight.set(key, { controller, promise })
  return promise
}

function notify(): void {
  revision += 1
  for (const fn of listeners) fn()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Invalidate after the participant's URL has been updated in the store. */
export function invalidateAvatar(participantId: string): void {
  generations.set(participantId, (generations.get(participantId) ?? 0) + 1)
  const key = activeKeys.get(participantId)
  if (key) retire(key)
  activeKeys.delete(participantId)
  notify()
}

/** Advance the generation before notifying subscribers or aborting old work. */
export function clearAvatarCache(): void {
  cacheGeneration += 1
  for (const pending of inFlight.values()) pending.controller.abort()
  inFlight.clear()
  for (const entry of cache.values()) scheduleRevoke(entry.objectUrl)
  cache.clear()
  activeKeys.clear()
  generations.clear()
  notify()
}

useAuth.subscribe((state, previous) => {
  if (state.contextEpoch !== previous.contextEpoch) clearAvatarCache()
})

/**
 * Hook: returns the cached object-URL for a participant's avatar, or
 * the raw URL while the first fetch is in flight (so the browser still
 * paints something instead of blanking). Refetches whenever:
 *   - the participant id or URL prop changes, OR
 *   - invalidateAvatar(participantId) is called, OR
 *   - clearAvatarCache() fires.
 *
 * Returns null when the participant has no avatar URL configured.
 */
const AVATAR_MAX_RETRIES = 3

/** Bounded-but-revivable retry for an avatar `<img>` load.
 *
 *  On native the raw CDN URL is handed straight to `<img>` (see
 *  `useCachedAvatarSrc` below). iOS makes one-shot loading hopeless:
 *  the WebView resumes before the radio on cold start, and WKWebView
 *  kills in-flight image loads when the app backgrounds. A single
 *  `onError` used to latch the initial-letter fallback PERMANENTLY —
 *  the URL rarely changes, so the reset-on-src-change never fired and
 *  every avatar in the session stayed a letter. That's the "iOS never
 *  fetches the real avatar" bug.
 *
 *  Strategy: retry the SAME url a few times with a short backoff by
 *  remounting the `<img>` (key bump). If all attempts fail, give up —
 *  but re-open a fresh retry epoch whenever the app returns to the
 *  foreground or the network comes back, instead of staying broken
 *  for the rest of the session. Resets cleanly whenever the resolved
 *  src changes (regenerated avatar / workspace switch). */
export function useAvatarImg(cachedSrc: string | null): {
  showImg: boolean
  imgKey: string
  onError: () => void
} {
  const [key, setKey] = useState(0)
  const [broke, setBroke] = useState(false)
  const attemptsRef = useRef(0)
  useEffect(() => {
    attemptsRef.current = 0
    setBroke(false)
    setKey(0)
  }, [cachedSrc])
  const reopen = useCallback(() => {
    attemptsRef.current = 0
    setBroke(false)
    setKey((k) => k + 1)
  }, [])
  // Only latched-broken avatars listen for a wake signal, so a long
  // virtualized list doesn't pay for listeners it doesn't need.
  useEffect(() => {
    if (!broke) return
    const onVisible = () => { if (document.visibilityState === 'visible') reopen() }
    window.addEventListener('online', reopen)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', reopen)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [broke, reopen])
  const onError = useCallback(() => {
    if (attemptsRef.current >= AVATAR_MAX_RETRIES) { setBroke(true); return }
    attemptsRef.current += 1
    // Backoff (500ms, 1s, 1.5s) gives a cold-start radio a beat to come
    // up before we remount the <img> and re-request the same URL.
    window.setTimeout(() => setKey((k) => k + 1), 500 * attemptsRef.current)
  }, [])
  return { showImg: Boolean(cachedSrc) && !broke, imgKey: `${cachedSrc ?? ''}#${key}`, onError }
}

/** `loading` attribute for avatar <img>s. WKWebView's lazy loader can
 *  silently never fire inside transformed/virtualized scroll containers
 *  (the row count is already bounded by virtualization, so eager is
 *  cheap there); browsers keep the lazy win. */
export const AVATAR_IMG_LOADING: 'eager' | 'lazy' = isNativePlatform() ? 'eager' : 'lazy'

export function useCachedAvatarSrc(
  participantId: string,
  url: string | null | undefined,
): string | null {
  const native = isNativePlatform()
  const contextEpoch = useAuth((s) => s.contextEpoch)
  useSyncExternalStore(subscribe, () => revision, () => revision)
  const resolved = url ? resolveAssetUrl(url) : null
  const key = requestKey(participantId, resolved ?? '')
  const generation = generations.get(participantId) ?? 0
  // Native images bypass fetch; a local version makes same-URL updates reload.
  const nativeSrc = resolved && generation && !/^(data|blob):/i.test(resolved)
    ? (() => {
      const hashAt = resolved.indexOf('#')
      const base = hashAt < 0 ? resolved : resolved.slice(0, hashAt)
      const hash = hashAt < 0 ? '' : resolved.slice(hashAt)
      return `${base}${base.includes('?') ? '&' : '?'}cumora_avatar=${cacheGeneration}-${generation}${hash}`
    })()
    : resolved
  const [result, setResult] = useState<{ key: string; src: string | null } | null>(null)
  const entry = cache.get(key)

  useEffect(() => {
    if (!resolved || native) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      void fetchAndCache(participantId, resolved).then((src) => {
        if (cancelled || requestKey(participantId, resolved) !== key || src === null) return
        setResult({ key, src })
        timer = setTimeout(refresh, AVATAR_TTL_MS)
      })
    }
    refresh()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [participantId, resolved, native, key, contextEpoch])

  if (!resolved) return null
  if (native) return nativeSrc
  return entry?.objectUrl ?? (result?.key === key ? result.src : resolved)
}
