import assert from 'node:assert/strict'
import { test } from 'node:test'
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
