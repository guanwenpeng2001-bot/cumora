import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { claimFairWakeJobs, enqueueWakeJob, finishWakeJob, renewWakeJob, wakeQueueMetrics } from '../agents/wake-queue.js'

// Explicit isolated Redis URL; never silently connect to application Redis.
test('Redis: rotating fair claims reach a quiet conversation behind 1500 hot events and preserve leases',
  { skip: !process.env.PERF_TEST_REDIS_URL }, async () => {
    const redis = new Redis(process.env.PERF_TEST_REDIS_URL!, { lazyConnect: true })
    const queue = `cumora:test:fair:${randomUUID()}`
    try {
      await redis.connect()
      const now = Date.now()
      for (let i = 0; i < 1501; i += 50) await Promise.all(Array.from({ length: Math.min(50, 1501 - i) }, (_, n) => {
        const index = i + n
        return enqueueWakeJob(redis, queue, String(index).padStart(5, '0'),
          { companyId: 'tenant', conversationId: index === 1500 ? 'quiet' : 'hot' }, now - 1000 + index / 10)
      }))
      const seen = new Set<string>()
      let quietBatch = -1, batchIndex = 0
      for (;;) {
        const batch = await claimFairWakeJobs(redis, queue, now, 25)
        if (!batch.length) break
        for (const job of batch) {
          assert.ok(!seen.has(job.id), 'no duplicate active lease')
          seen.add(job.id)
          if (JSON.parse(job.raw).conversationId === 'quiet') quietBatch = batchIndex
          await renewWakeJob(redis, queue, job, now)
          await finishWakeJob(redis, queue, { ...job, token: 'expired-owner' }, false)
          assert.ok(await redis.hexists(`${queue}:jobs`, job.id), 'stale owner cannot delete a job')
          await finishWakeJob(redis, queue, job, false)
        }
        batchIndex++
      }
      assert.ok(quietBatch >= 0 && quietBatch <= 3, `quiet room served in batch ${quietBatch}`)
      assert.equal(seen.size, 1501)
      assert.equal(await redis.hlen(`${queue}:jobs`), 0)
      assert.equal(wakeQueueMetrics.get(queue)?.completed, 1501)
    } finally {
      await redis.del(`${queue}:jobs`, `${queue}:due`, `${queue}:processing`)
      await redis.quit()
    }
  })
