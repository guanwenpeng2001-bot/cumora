import assert from 'node:assert/strict'
import type { WakeQueueStore } from '../agents/wake-queue.js'

/** Isolated Redis command model. No sockets, server singleton, or database. */
export function wakeQueueFixture() {
  const hashes = new Map<string, Map<string, string>>()
  const scores = new Map<string, Map<string, number>>()
  const done = new Set<string>()
  const scripts: string[] = []
  const hash = (key: string) => {
    if (!hashes.has(key)) hashes.set(key, new Map())
    return hashes.get(key)!
  }
  const sorted = (key: string) => {
    if (!scores.has(key)) scores.set(key, new Map())
    return scores.get(key)!
  }
  const store: WakeQueueStore = { async eval(script, count, ...values) {
    scripts.push(script)
    const keys = values.slice(0, count).map(String), args = values.slice(count)
    const jobs = hash(keys[0]), due = sorted(keys[1]), processing = hash(keys[2])
    if (script.includes('ZRANGEBYSCORE')) {
      assert.doesNotMatch(script, /HDEL/, 'claim must retain payload through worker failure')
      const now = Number(args[0]), limit = Number(args[1])
      const ordered = [...due].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      const eligible = ordered.filter(([, score]) => score >= 0 && score <= now)
      const offset = Number(args[4]) >= eligible.length ? 0 : Number(args[4])
      const window = eligible.slice(offset, offset + 512)
      const groups = new Map<string, { id: string; raw: string }[]>()
      for (const [id] of window) {
        const raw = jobs.get(id)
        if (!raw) { due.delete(id); continue }
        let group = id
        try {
          const payload = JSON.parse(raw)
          group = `${payload.companyId ?? ''}:${payload.conversationId ?? payload.agentId ?? id}`
        } catch { /* Invalid payloads are grouped by job id, like Lua. */ }
        if (!groups.has(group)) groups.set(group, [])
        groups.get(group)!.push({ id, raw })
      }
      const result: { id: string; raw: string; token: string }[] = []
      for (let round = 0; result.length < limit; round++) {
        let more = false
        for (const group of groups.values()) {
          const job = group[round]
          if (!job || result.length >= limit) continue
          more = true
          const token = `${args[3]}:${result.length + 1}`
          processing.set(job.id, token); due.set(job.id, now + Number(args[2]))
          result.push({ ...job, token })
        }
        if (!more) break
      }
      return JSON.stringify({ jobs: result, cursor: offset + window.length - result.length,
        pending: eligible.length, oldestAgeMs: Math.max(0, now - (ordered[0]?.[1] ?? now)) })
    }
    const id = String(args[0])
    if (script.includes('HEXISTS')) {
      if (done.has(keys[3]) || args[3] === '0' && jobs.has(id)) return 0
      const incoming = JSON.parse(String(args[1])), previous = jobs.get(id)
      if (previous && incoming.attempt !== undefined) {
        const old = JSON.parse(previous)
        if (incoming.options?.recoveryProbe) incoming.attempt = 0
        else if (!old.options?.recoveryProbe) incoming.attempt = Math.max(old.attempt, incoming.attempt)
      }
      jobs.set(id, JSON.stringify(incoming)); processing.delete(id); due.set(id, Number(args[2]))
      return 1
    }
    assert.match(script, /HGET.*KEYS\[3\]/)
    assert.match(script, /HGET.*KEYS\[1\]/)
    if (processing.get(id) !== args[1] || jobs.get(id) !== args[2]) return 0
    if (script.includes("redis.call('SET'")) {
      jobs.delete(id); due.delete(id); processing.delete(id)
      if (args[4] === '1') done.add(keys[3])
    } else due.set(id, Number(args[3]))
    return 1
  } }
  return { store, hash, sorted, done, scripts }
}
