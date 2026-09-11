import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { transform } from 'esbuild'
import ts from 'typescript'
import { resolveComputerServer } from '../agents/computer/daemon.js'

const root = resolve(import.meta.dirname, '../../..')

test('daemon server selection preserves explicit/saved targets and fails closed', () => {
  assert.equal(resolveComputerServer('https://explicit.test/', 'https://saved.test', 'https://env.test', 'https://baked.test'), 'https://explicit.test')
  assert.equal(resolveComputerServer(undefined, 'https://saved.test', 'https://env.test', 'https://baked.test'), 'https://saved.test')
  assert.equal(resolveComputerServer(undefined, undefined, 'https://env.test', 'https://baked.test'), 'https://env.test')
  assert.equal(resolveComputerServer(undefined, undefined, '', 'https://baked.test/'), 'https://baked.test')
  assert.throws(() => resolveComputerServer(undefined, undefined, '', ''), /No Cumora server configured/)
  for (const value of ['', '   ', '--pair', 'ftp://example.com', 'https://user:pass@example.com']) {
    assert.throws(() => resolveComputerServer(value, 'https://saved.test', '', ''))
  }
})

test('electron-builder loads defaults and custom coordinates through package build.extends', () => {
  const script = `const { getConfig } = require('app-builder-lib/out/util/config/config.js');
    getConfig(process.cwd()).then(c => console.log(JSON.stringify({ publish: c.publish, appId: c.appId, target: c.win.target })))`
  for (const custom of [false, true]) {
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, CUMORA_GITHUB_OWNER: custom ? 'my-owner' : '', CUMORA_GITHUB_REPO: custom ? 'my-repo' : '' },
    })
    const config = JSON.parse(output.trim().split('\n').at(-1)!)
    assert.equal(config.publish[0].owner, custom ? 'my-owner' : 'guanwenpeng2001-bot')
    assert.equal(config.publish[0].repo, custom ? 'my-repo' : 'cumora')
    assert.equal(config.publish[0].publishAutoUpdate, true)
    assert.equal(config.appId, 'io.cumora.app')
    assert.equal(config.target[0].target, 'nsis')
  }
})

test('Vite configuration bakes custom GitHub coordinates into frontend CLI commands', async () => {
  const configSource = readFileSync(join(root, 'vite.config.ts'), 'utf8')
  const js = ts.transpile(configSource.replace(/^import .*$/gm, '').replace('export default', 'return'), { target: ts.ScriptTarget.ES2022 })
  for (const custom of [false, true]) {
    const config = new Function('defineConfig', 'react', 'path', '__dirname', 'process', js)(
      (value: unknown) => value, () => ({}), { resolve: () => '' }, root,
      { env: custom ? { CUMORA_GITHUB_OWNER: 'my-owner', CUMORA_GITHUB_REPO: 'my-repo' } : {} },
    )
    const result = await transform(readFileSync(join(root, 'src/lib/agentCliRelease.ts'), 'utf8'), { loader: 'ts', format: 'cjs', define: config.define })
    const module = { exports: {} as { AGENT_CLI_RELEASE_URL: string } }
    new Function('module', 'exports', result.code)(module, module.exports)
    assert.match(module.exports.AGENT_CLI_RELEASE_URL, custom ? /github.com\/my-owner\/my-repo\/releases\/download\/agent-cli-v/ : /github.com\/guanwenpeng2001-bot\/cumora\/releases\/download\/agent-cli-v/)
  }
})

test('unconfigured daemon entry exits before pairing or service installation', () => {
  const staging = mkdtempSync(join(tmpdir(), 'cumora-fork-portability-'))
  try {
    const env = { ...process.env, USERPROFILE: staging, HOME: staging, CUMORA_SERVER_URL: '' }
    const script = `import { runComputerDaemon } from './server/src/agents/computer/daemon.ts';
      await runComputerDaemon(JSON.parse(process.argv[1]));`
    for (const args of [[], ['--pair', 'fake-code'], ['--install-service'], ['--server']]) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify(args)], { cwd: root, env, encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /No Cumora server configured/)
    }
    for (const flag of ['--help', '--version']) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify([flag])], { cwd: root, env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
  } finally { rmSync(staging, { recursive: true, force: true }) }
})

test('release build defines the optional baked default from the build environment', () => {
  const source = readFileSync(join(root, 'agent-cli/build.mjs'), 'utf8')
  const expression = source.match(/define: (\{[^\n]+\}),/)?.[1]
  assert.ok(expression)
  const define = new Function('process', 'version', `return (${expression})`)
  assert.equal(define({ env: {} }, 'test').__CUMORA_DEFAULT_SERVER__, '""')
  assert.equal(define({ env: { CUMORA_DEFAULT_SERVER: ' https://self-hosted.example ' } }, 'test').__CUMORA_DEFAULT_SERVER__, '"https://self-hosted.example"')
})

test('orchestrator uses local image with a warning unless an image is configured', () => {
  const source = readFileSync(join(root, 'server/src/agents/runtime/orchestrator.ts'), 'utf8')
  const block = source.slice(source.indexOf('const IMAGE ='), source.indexOf('/** TTL of the JWT'))
  for (const value of [undefined, '', '  ', 'registry.example/agent@sha256:abc']) {
    const warnings: string[] = []
    const image = new Function('process', 'console', block + ';return IMAGE')({ env: { CUMORA_AGENT_COMPUTER_IMAGE: value } }, { warn: (message: string) => warnings.push(message) })
    assert.equal(image, value?.trim() || 'cumora-agent-computer:dev')
    assert.equal(warnings.length, value?.trim() ? 0 : 1)
  }
})
