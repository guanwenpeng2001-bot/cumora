/** One shared dependency check per process, including while a timed-out pool
 * acquisition is still pending. Probes cannot build an unbounded query queue. */
export function createReadinessCheck(checkDependencies: () => Promise<unknown>, timeoutMs = 1000) {
  let pending: Promise<unknown> | undefined
  return async (): Promise<boolean> => {
    if (!pending) {
      pending = Promise.resolve().then(checkDependencies).finally(() => { pending = undefined })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        pending.then(() => true, () => false),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
