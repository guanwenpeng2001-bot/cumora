import { randomUUID } from 'node:crypto'

export interface WakeQueueStore {
  eval(script: string, keyCount: number, ...args: (string | number)[]): Promise<unknown>
}

export interface ClaimedWakeJob {
  id: string
  raw: string
  token: string
}

const LEASE_MS = 300_000
const DONE_TTL_SECONDS = 30 * 24 * 60 * 60

/** A replacement invalidates an old lease. Initial fan-out is idempotent even
 * if its event worker dies after enqueueing a recipient that already finished. */
export async function enqueueWakeJob(store: WakeQueueStore, queue: string, id: string,
  payload: object, dueAt: number, replace = false): Promise<void> {
  await store.eval(`
    if redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
    if ARGV[4] == '0' and redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
    local incoming = cjson.decode(ARGV[2])
    local previous = redis.call('HGET', KEYS[1], ARGV[1])
    if previous then
      local old = cjson.decode(previous)
      if old.attempt and incoming.attempt then
        if incoming.options and incoming.options.recoveryProbe then incoming.attempt = 0
        elseif not (old.options and old.options.recoveryProbe) then
          incoming.attempt = math.max(old.attempt, incoming.attempt)
        end
      end
    end
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(incoming))
    redis.call('HDEL', KEYS[3], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
    return 1
  `, 4, `${queue}:jobs`, `${queue}:due`, `${queue}:processing`, `${queue}:done:${id}`,
  id, JSON.stringify({ ...payload, _revision: randomUUID() }), dueAt, replace ? '1' : '0')
}

/** Claim leaves the payload durable and moves its due time to the lease expiry. */
export async function claimWakeJobs(store: WakeQueueStore, queue: string, now: number, limit: number): Promise<ClaimedWakeJob[]> {
  const result = await store.eval(`
    local ids = redis.call('ZRANGEBYSCORE', KEYS[2], 0, ARGV[1], 'LIMIT', 0, ARGV[2])
    local jobs = {}
    for i, id in ipairs(ids) do
      local raw = redis.call('HGET', KEYS[1], id)
      if raw then
        local token = ARGV[4] .. ':' .. i
        redis.call('HSET', KEYS[3], id, token)
        redis.call('ZADD', KEYS[2], tonumber(ARGV[1]) + tonumber(ARGV[3]), id)
        table.insert(jobs, cjson.encode({id=id, raw=raw, token=token}))
      else redis.call('ZREM', KEYS[2], id) end
    end
    return jobs
  `, 3, `${queue}:jobs`, `${queue}:due`, `${queue}:processing`, now, limit, LEASE_MS, randomUUID()) as string[]
  return result.map(raw => JSON.parse(raw) as ClaimedWakeJob)
}

export async function finishWakeJob(store: WakeQueueStore, queue: string, job: ClaimedWakeJob, remember = true): Promise<void> {
  await store.eval(`
    if redis.call('HGET', KEYS[3], ARGV[1]) ~= ARGV[2]
      or redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[3] then return 0 end
    redis.call('HDEL', KEYS[1], ARGV[1])
    redis.call('HDEL', KEYS[3], ARGV[1])
    redis.call('ZREM', KEYS[2], ARGV[1])
    if ARGV[5] == '1' then redis.call('SET', KEYS[4], '1', 'EX', ARGV[4]) end
    return 1
  `, 4, `${queue}:jobs`, `${queue}:due`, `${queue}:processing`, `${queue}:done:${job.id}`,
  job.id, job.token, job.raw, DONE_TTL_SECONDS, remember ? '1' : '0')
}

/** Renew only the generation we own; an expired worker cannot renew a reclaim. */
export async function renewWakeJob(store: WakeQueueStore, queue: string, job: ClaimedWakeJob, now: number): Promise<void> {
  await store.eval(`
    if redis.call('HGET', KEYS[3], ARGV[1]) ~= ARGV[2]
      or redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[3] then return 0 end
    redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
    return 1
  `, 3, `${queue}:jobs`, `${queue}:due`, `${queue}:processing`, job.id, job.token, job.raw, now + LEASE_MS)
}
