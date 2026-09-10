/**
 * `cumora` — the published, standalone BYOA agent-daemon CLI.
 *
 * This is the entry point for the fixed Release package (`cumora …`). It is
 * intentionally tiny: it only knows how to run the BYOA "agent computer"
 * daemon, which talks to a Cumora server purely over HTTP (no DB/Redis, no
 * repo). The daemon source lives in the main repo
 * (server/src/agents/computer/) and is bundled in by agent-cli/build.mjs, so
 * there's a single source of truth.
 */
import { runComputerDaemon } from '../../server/src/agents/computer/daemon.js'

declare const __CUMORA_VERSION__: string

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(__CUMORA_VERSION__)
    return
  }
  if (argv[0] === 'agent' && argv[1] === 'computer') {
    await runComputerDaemon(argv.slice(2))
    return
  }
  process.stderr.write(
    'cumora — run your Cumora agents on this machine (BYOA)\n\n' +
    'Usage:\n' +
    '  cumora agent computer --pair <code> [--server <url>]   pair this machine\n' +
    '  cumora agent computer [--server <url>]                 start the daemon\n\n' +
    'Secure default: Claude Code on macOS/Linux/WSL2, or Codex on macOS/Linux/WSL2/Windows.\n' +
    'Kimi Code (kimi-code): install from https://moonshotai.github.io/kimi-code/ and run kimi login.\n' +
    'Kimi and other unsandboxed engines require the high-risk CUMORA_BYOA_ALLOW_UNSANDBOXED=1 compatibility switch. Get a pairing code from\n' +
    'Cumora → You → Computers → Add a computer.\n',
  )
  process.exit(argv.length && argv[0] !== '--help' && argv[0] !== '-h' ? 1 : 0)
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`cumora: ${message}\n`)
  process.exit(70)
})
