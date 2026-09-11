import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  isWindowsSupervisorProcess,
  parseWindowsProcessList,
  renderWindowsSupervisor,
  renderWindowsSupervisorLauncher,
  resolveServicePath,
  renderLaunchAgent,
  renderSystemdUnit,
  checkForUpdate,
  restartService,
  windowsScheduledTaskCommand,
  windowsScheduledTaskCreateArgs,
  windowsScheduledTaskQueryCommand,
  windowsScheduledTaskSettingsCommand,
  windowsTaskName,
  quiesceWindowsDaemons,
} from '../agents/computer/daemon.js'

test('service PATH includes the installed CLI shim and Node directories', async () => {
  assert.equal(await resolveServicePath('win32', 'C:/bin', 'C:/node/node.exe', async (file, args) => {
    assert.equal(file, 'where.exe')
    assert.deepEqual(args, ['cumora.cmd'])
    return { stdout: 'C:/npm/cumora.cmd' + String.fromCharCode(13, 10) }
  }), 'C:/npm;C:/node;C:/bin')
  assert.equal(await resolveServicePath('linux', '/bin', '/opt/node/bin/node', async () => ({ stdout: '/opt/npm/bin/cumora' })), '/opt/npm/bin:/opt/node/bin:/bin')
  await assert.rejects(resolveServicePath('linux', '', '/bin/node', async () => ({ stdout: '' })), /Install a fixed fork Release/)
})

for (const platform of ['win32', 'darwin', 'linux'] as const) test(`${platform} restart refreshes an existing service definition`, async () => {
  const installedUrls: string[] = []

  await restartService({
    platform,
    isServiceInstalled: async () => true,
    loadConfig: async () => ({
      serverUrl: 'https://example.test',
      computerId: 'comp-test',
      deviceToken: 'token-test',
    }),
    installService: async (serverUrl) => { installedUrls.push(serverUrl) },
  })

  assert.deepEqual(installedUrls, ['https://example.test'])
})

test('Windows supervisor restarts the installed fixed daemon with supervision enabled', () => {
  const script = renderWindowsSupervisor(
    "https://example.test/tenant's-api",
    "C:\\Users\\O'Brien\\.cumora\\daemon.log",
    "C:\\Users\\O'Brien\\.cumora\\daemon-supervisor.disabled",
    "C:\\Program Files\\nodejs;C:\\Users\\O'Brien\\bin",
  )

  assert.match(script, /\$env:CUMORA_SUPERVISED = '1'/)
  assert.match(script, /while \(-not \(Test-Path -LiteralPath/)
  assert.match(script, /& cumora agent computer --server/)
  assert.doesNotMatch(script, /npx|@latest/)
  assert.match(script, /tenant''s-api/)
  assert.match(script, /O''Brien/)
  assert.match(script, /2>&1 \| ForEach-Object/)
  assert.match(script, /\[System\.IO\.File\]::AppendAllText/)
  assert.doesNotMatch(script, /Out-File/)
  assert.doesNotMatch(script, /\*>>/)
  assert.match(script, /Start-Sleep -Seconds 5/)
})

test('Windows scheduled task runs the watchdog at login with limited privileges', () => {
  const scriptPath = 'C:\\Users\\Test User\\.cumora\\daemon-supervisor.ps1'
  const launcherPath = 'C:\\Users\\Test User\\.cumora\\daemon-supervisor.vbs'
  const taskName = windowsTaskName('C:\\Users\\Test User')
  const launcher = renderWindowsSupervisorLauncher(scriptPath)
  assert.match(launcher, /CreateObject\("WScript\.Shell"\)/)
  assert.match(launcher, /powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\\Users\\Test User\\\.cumora\\daemon-supervisor\.ps1""/)
  assert.match(launcher, /, 0, True/)
  assert.equal(
    windowsScheduledTaskCommand(launcherPath),
    'wscript.exe //B //Nologo "C:\\Users\\Test User\\.cumora\\daemon-supervisor.vbs"',
  )
  assert.deepEqual(windowsScheduledTaskCreateArgs(launcherPath, taskName), [
    '/Create', '/TN', taskName,
    '/TR', windowsScheduledTaskCommand(launcherPath),
    '/SC', 'ONLOGON', '/RL', 'LIMITED', '/IT', '/F',
  ])

  const settings = windowsScheduledTaskSettingsCommand(taskName)
  assert.match(settings, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/)
  assert.match(settings, /-AllowStartIfOnBatteries/)
  assert.match(settings, /-DontStopIfGoingOnBatteries/)
  assert.match(settings, /-StartWhenAvailable/)
  assert.match(settings, /-MultipleInstances IgnoreNew/)
})

test('Windows install and scheduled startup stop old supervisors before the final daemon sweep', async () => {
  for (const endTask of [true, false]) {
    const calls: string[] = []
    await quiesceWindowsDaemons('test-task', endTask, {
      stopDaemons: async () => { calls.push('daemons') },
      stopWatchdog: async (name, end) => { calls.push(`${name}:${end}`) },
    })
    assert.deepEqual(calls, ['daemons', `test-task:${endTask}`, 'daemons'])
  }
})

test('Windows startup cleanup fails closed when an old watchdog cannot stop', async () => {
  let sweeps = 0
  await assert.rejects(quiesceWindowsDaemons('test-task', false, {
    stopDaemons: async () => { sweeps++ },
    stopWatchdog: async () => { throw new Error('old watchdog still running') },
  }), /old watchdog still running/)
  assert.equal(sweeps, 1)
})

test('Windows supervisor acquires its mutex and cleans legacy processes before hosting', () => {
  const script = renderWindowsSupervisor('http://localhost', 'C:/temp/log', 'C:/temp/disabled')
  assert.match(script, /Global\\CumoraSupervisor-/)
  assert.match(script, /WaitOne\(0\)/)
  assert.match(script, /AbandonedMutexException/)
  assert.ok(script.indexOf('--prepare-service-start') < script.indexOf('while (-not'))
  assert.match(script, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/)
  assert.match(script, /if \(\$LASTEXITCODE -eq 73\) \{ exit \$LASTEXITCODE \}/)
  assert.match(script, /finally[\s\S]*ReleaseMutex\(\)/)
})

test('two real Windows supervisor processes host once and stop retrying on daemon exit 73', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-supervisor-'))
  const children: ChildProcess[] = []
  const log = join(root, 'supervisor.log')
  const calls = join(root, 'calls.log')
  const ready = join(root, 'ready')
  const release = join(root, 'release')
  const script = join(root, 'supervisor.ps1')
  try {
    // Exercise the generated PowerShell, mutex and exit-code propagation. The
    // stub deliberately cannot call the installed CLI or touch scheduled tasks.
    await writeFile(join(root, 'cumora.ps1'), [
      'if ($args -contains "--prepare-service-start") {',
      '  Add-Content -LiteralPath $env:TEST_SUPERVISOR_CALLS -Value "prepare"',
      '  $global:LASTEXITCODE = 0; return',
      '}',
      'Add-Content -LiteralPath $env:TEST_SUPERVISOR_CALLS -Value "host"',
      'New-Item -ItemType File -Path $env:TEST_SUPERVISOR_READY | Out-Null',
      'while (-not (Test-Path -LiteralPath $env:TEST_SUPERVISOR_RELEASE)) { Start-Sleep -Milliseconds 50 }',
      '$global:LASTEXITCODE = 73',
    ].join('\r\n'))
    await writeFile(script, renderWindowsSupervisor('http://127.0.0.1:1', log, join(root, 'disabled'), `${root};${process.env.PATH}`, false))
    const start = () => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true, env: { ...process.env, TEST_SUPERVISOR_CALLS: calls, TEST_SUPERVISOR_RELEASE: release, TEST_SUPERVISOR_READY: ready },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      return child
    }
    const first = start()
    let errors = ''
    first.stderr!.on('data', b => { errors += b })
    // PowerShell Add-Content briefly holds an exclusive Windows file handle.
    // Wait for a separate marker written AFTER it closes the trace file.
    for (let n = 0; n < 100 && !existsSync(ready); n++) {
      if (first.exitCode !== null) break
      await delay(50)
    }
    assert.equal(first.exitCode, null, errors)
    assert.ok(existsSync(calls), errors)
    assert.match(await readFile(calls, 'utf8'), /host/)
    const second = start()
    const [secondCode] = await once(second, 'close')
    assert.equal(secondCode, 73)
    assert.match(await readFile(log, 'utf8'), /supervisor already running; mutex: Global\\CumoraSupervisor-/)
    const firstClosed = once(first, 'close')
    await writeFile(release, '')
    const [firstCode] = await firstClosed
    assert.equal(firstCode, 73, errors)
    assert.deepEqual((await readFile(calls, 'utf8')).trim().split(/\r?\n/), ['prepare', 'host'])
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('Windows task names are stable and isolated per user home', () => {
  assert.equal(windowsTaskName('C:\\Users\\Alice'), windowsTaskName('c:\\users\\alice'))
  assert.notEqual(windowsTaskName('C:\\Users\\Alice'), windowsTaskName('C:\\Users\\Bob'))
})

test('Windows task query distinguishes absence from scheduler failures', () => {
  const query = windowsScheduledTaskQueryCommand("Cumora O'Brien")
  assert.match(query, /Get-ScheduledTask -TaskName 'Cumora O''Brien' -ErrorAction Stop/)
  assert.match(query, /CmdletizationQuery_NotFound_TaskName,\*/)
  assert.match(query, /exit 3/)
  assert.match(query, /Write-Error \$_; exit 1/)
})

test('Windows CIM process output accepts both singleton and array JSON', () => {
  assert.deepEqual(parseWindowsProcessList('{"ProcessId":42,"CommandLine":"node cli.js agent computer"}'), [
    { ProcessId: 42, CommandLine: 'node cli.js agent computer' },
  ])
  assert.deepEqual(parseWindowsProcessList('[{"ProcessId":42,"CommandLine":"a"},{"ProcessId":0,"CommandLine":"b"}]'), [
    { ProcessId: 42, CommandLine: 'a' },
  ])
  assert.deepEqual(parseWindowsProcessList(''), [])
})

test('Windows watchdog matching requires PowerShell -File with the exact script', () => {
  const scriptPath = 'C:\\Users\\Test User\\.cumora\\daemon-supervisor.ps1'
  assert.equal(isWindowsSupervisorProcess({
    ProcessId: 42,
    Name: 'powershell.exe',
    CommandLine: `powershell.exe -NoProfile -File "${scriptPath}"`,
  }, scriptPath), true)
  assert.equal(isWindowsSupervisorProcess({
    ProcessId: 43,
    Name: 'notepad.exe',
    CommandLine: `notepad.exe "${scriptPath}"`,
  }, scriptPath), false)
  assert.equal(isWindowsSupervisorProcess({
    ProcessId: 44,
    Name: 'powershell.exe',
    CommandLine: `powershell.exe -Command "Get-Content '${scriptPath}'"`,
  }, scriptPath), false)
  assert.equal(isWindowsSupervisorProcess({
    ProcessId: 45,
    Name: 'powershell.exe',
    CommandLine: 'powershell.exe -File "C:\\other\\daemon-supervisor.ps1"',
  }, scriptPath), false)
})

test('macOS and Linux templates preserve configured addresses and fixed entrypoints', () => {
  const plist = renderLaunchAgent('https://example.test/?a=1&b=2', '/tmp/test log', '/opt/npm/bin:/usr/bin')
  assert.match(plist, /<string>cumora<\/string><string>agent<\/string><string>computer<\/string><string>--server<\/string>/)
  assert.match(plist, /a=1&amp;b=2/)
  const unit = renderSystemdUnit('https://example.test/%20/$tenant', '/opt/npm bin:/usr/bin')
  assert.match(unit, /ExecStart=\/usr\/bin\/env cumora agent computer --server "https:\/\/example.test\/%%20\/\$\$tenant"/)
  assert.match(unit, /Environment="PATH=\/opt\/npm bin:\/usr\/bin"/)
  assert.doesNotMatch(plist + unit, /npx|@latest/)
})

test('Release builds skip the official update request entirely', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network') })
  await checkForUpdate(true)
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('all supervisor templates persist only an exact installation-time unsandboxed opt-in', () => {
  const previous = process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED
  try {
    for (const value of [undefined, '', '0', 'true', '1']) {
      if (value === undefined) delete process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED
      else process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = value
      const templates = [
        renderLaunchAgent('https://example.test', '/tmp/log', '/bin'),
        renderSystemdUnit('https://example.test', '/bin'),
        renderWindowsSupervisor('https://example.test', 'C:/log', 'C:/disabled', 'C:/bin'),
      ]
      for (const template of templates) {
        assert.equal(template.includes('CUMORA_BYOA_ALLOW_UNSANDBOXED'), value === '1')
      }
      if (value === '1') {
        assert.match(templates[0], /<key>CUMORA_BYOA_ALLOW_UNSANDBOXED<\/key><string>1<\/string>/)
        assert.match(templates[1], /Environment=CUMORA_BYOA_ALLOW_UNSANDBOXED=1/)
        assert.match(templates[2], /\$env:CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'/)
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED
    else process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = previous
  }
})
