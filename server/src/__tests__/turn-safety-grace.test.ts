import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { TurnSafetyGrace, TURN_SAFETY_PROBE, boundedSafetyProbe } from '../turn-safety-policy.js'

const transportErrors = [new DOMException('timed out', 'TimeoutError'),
  Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
  new TypeError('fetch failed'), Object.assign(new Error('unavailable'), { status: 503 }),
  new Error('Connection terminated unexpectedly'), new Error('Connection terminated due to connection timeout'),
  new Error('timeout exceeded when trying to connect'), new Error('Query read timeout')]

for (const error of transportErrors) test('E3: transport grace is bounded and resets on success: ' + error.message, () => {
  const grace = new TurnSafetyGrace()
  assert.equal(grace.shouldStop(error), false)
  assert.equal(grace.shouldStop(error), false)
  grace.success()
  assert.equal(grace.shouldStop(error), false)
  assert.equal(grace.shouldStop(error), false)
  assert.equal(grace.shouldStop(error), true)
})

for (const status of [400, 401, 403]) test('E3: explicit HTTP refusal stops immediately: ' + status, () => {
  assert.equal(new TurnSafetyGrace().shouldStop(Object.assign(new Error('denied'), { status })), true)
})

test('E3: programming errors and explicit aborts do not earn network grace', () => {
  for (const error of [new Error('bad validation data'), new TypeError('bad property'), new DOMException('stop', 'AbortError'),
    Object.assign(new Error('invalid fetch argument'), { code: 'UND_ERR_INVALID_ARG' })]) {
    assert.equal(new TurnSafetyGrace().shouldStop(error), true)
  }
})

test('E3: an unresponsive managed validation is bounded by the shared probe deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const result = boundedSafetyProbe(new Promise<boolean>(() => {}))
  const rejected = assert.rejects(result, { name: 'TimeoutError' })
  t.mock.timers.tick(TURN_SAFETY_PROBE.timeoutMs)
  await rejected
})

test('E3: the BYOA SSE stop handler cancels immediately during network grace', () => {
  const source = readFileSync(new URL('../agents/computer/daemon.ts', import.meta.url), 'utf8')
  const start = source.indexOf("          if (evt.event === 'stop')")
  const end = source.indexOf("          if (evt.event === 'wake'", start)
  assert.ok(start > 0 && end > start)
  const code = ts.transpileModule(`for (const evt of events) { ${source.slice(start, end)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const grace = new TurnSafetyGrace()
  assert.equal(grace.shouldStop(new TypeError('fetch failed')), false)
  const stopped: string[] = []
  new Function('events', code).call({ safetyGeneration: '7', emergencyCancel: async (generation: string) => { stopped.push(generation) } },
    [{ event: 'stop', data: JSON.stringify({ generation: '8' }) }])
  assert.deepEqual(stopped, ['8'])
})

// Execute the actual timer blocks from both integrations with a controlled clock.
for (const mode of ['byoa', 'managed'] as const) {
  function fixture() {
    const source = readFileSync(new URL(mode === 'byoa' ? '../agents/computer/daemon.ts' : '../agents/turn.ts', import.meta.url), 'utf8')
    const start = source.indexOf(mode === 'byoa' ? '    let safetyChecking = false' : '    let checkingSafety = false')
    const end = source.indexOf('    safetyTimer.unref()', start) + '    safetyTimer.unref()'.length
    assert.ok(start > 0 && end > start)
    const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    let tick: () => void = () => assert.fail('timer missing')
    let result: boolean | Error = true
    const controller = new AbortController()
    const cancelled: string[] = []
    const deps = {
      TurnSafetyGrace, TURN_SAFETY_PROBE, boundedSafetyProbe, AbortSignal, DOMException,
      controller, signal: controller.signal, agentId: 'agent', admission: { generation: '7' },
      runtime: { validateTurn: async (_id: string, generation: string) => {
        assert.equal(generation, '7')
        if (result instanceof Error) throw result
        return result
      } },
      api: async (_url: string, _path: string, init: RequestInit) => {
        assert.equal(JSON.parse(String(init.body)).generation, '7')
        if (result instanceof Error) throw result
        return { valid: result }
      },
      setInterval: (fn: () => void, ms: number) => { assert.equal(ms, TURN_SAFETY_PROBE.intervalMs); tick = fn; return { unref() {} } },
    }
    new Function(...Object.keys(deps), code).call({ cancellingSafety: false, cfg: { serverUrl: 'test' }, token: 'token', safetyGeneration: '7',
      emergencyCancel: async (_generation: string, reason = 'stop') => { cancelled.push(reason) },
    }, ...Object.values(deps))
    return {
      stopped: () => mode === 'byoa' ? cancelled.length > 0 : controller.signal.aborted,
      async probe(value: boolean | Error) {
        result = value
        tick()
        await new Promise<void>(resolve => setImmediate(resolve))
      },
    }
  }
  test(`E3: ${mode} actual probe tolerates one network failure, then cancels at shared threshold`, async () => {
    const f = fixture(), error = Object.assign(new Error('offline'), { code: 'ECONNRESET' })
    await f.probe(error)
    assert.equal(f.stopped(), false)
    await f.probe(true)
    for (let i = 1; i <= TURN_SAFETY_PROBE.failures; i++) {
      await f.probe(error)
      assert.equal(f.stopped(), i === TURN_SAFETY_PROBE.failures)
    }
  })
  for (const value of [false, Object.assign(new Error('denied'), { status: 401 }), Object.assign(new Error('denied'), { status: 403 })]) {
    test(`E3: ${mode} actual probe immediately stops on ${value === false ? 'invalid generation/stop' : (value as Error & { status: number }).status}`, async () => {
      const f = fixture()
      await f.probe(value)
      assert.equal(f.stopped(), true)
    })
  }
}
