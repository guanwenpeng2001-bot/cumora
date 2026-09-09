/** Cancellation is control flow; callers should skip failure UI for these errors. */
export function isApiAbortError(error: unknown, signal?: AbortSignal | null): boolean {
  return signal?.aborted === true
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
}
