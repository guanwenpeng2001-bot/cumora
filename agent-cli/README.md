# cumora

Run your [Cumora](https://cumora.ai) agents on your own machine or VPS,
powered by your local agent CLI (BYOA — Bring Your Own Agent). Claude Code and
Codex are sandboxed by default; Grok Build, Cursor Agent, OpenCode, pi, Gemini,
Qwen Code, and Antigravity require an explicit unsandboxed compatibility opt-in. One daemon can
host many agents; each gets its own workspace, memory, and skills on that
machine.

## Usage

First install the fixed fork Release as described below.

In Cumora: **You → Computers → Add a computer** to get a pairing code, then
on the machine you want to host agents:

```sh
cumora agent computer --pair <code> [--server <your-server-url>]
```

Then start the daemon (after pairing, the config is saved):

```sh
cumora agent computer [--server <your-server-url>]
```

`--server` is optional; it defaults to `https://api.cumora.ai`. Pass it when
you self-host.

Requires **Node ≥ 18** and a supported CLI on your `PATH`. Secure mode supports
Claude Code **≥ 2.1.248** on macOS/Linux/WSL2 and Codex **≥ 0.138.0** on
macOS/Linux/WSL2/native Windows. Older CLIs fail closed instead of falling back
to host-level authority.
The daemon talks to the Cumora server over HTTPS only — it needs no database
access. See the repository's `docs/BYOA.md` before enabling
`CUMORA_BYOA_ALLOW_UNSANDBOXED=1`; that switch grants model-generated tools the
host's ordinary file, environment, and network authority.

## Fixed fork Release

Install the selected immutable GitHub Release asset before pairing:

```sh
npm install --global "https://github.com/<owner>/<repo>/releases/download/<tag>/cumora-<fork-version>.tgz"
cumora --version
```

Replace placeholders with the fork repository, fixed tag and asset name. The
version includes the fork version and full source commit, for example
`0.16.2-fork.1+<40-character-commit>`. Keep the same URL and SHA-256 checksum for
all machines in a rollout. Do not publish to the official npm channel.

Ensure Node and the global npm executable directory are on your login shell's
`PATH` (`npm prefix --global`, with `/bin` on macOS/Linux). Service installation
resolves the installed `cumora` command and saves its directory and Node's
directory in the local supervisor environment. Machine paths stay local.

## Background service and explicit upgrades

After pairing, install the service with the configured server address:

```sh
cumora agent computer --install-service --server <your-server-url>
cumora agent computer --status
cumora agent computer --restart
```

Windows Task Scheduler, macOS LaunchAgent, and Linux user systemd launch
`cumora agent computer --server <configured-address>` through the installed
global command. Reinstalling or restarting refreshes the service definition.
Release builds do not check the official npm version or exit to self-upgrade.
To upgrade or roll back, install the chosen fixed Release URL explicitly, then
run `cumora agent computer --restart`. Pairing and sessions are retained.

## Build and pack

From the repository root, with repository dependencies installed:

```sh
npm run build --prefix agent-cli
cd agent-cli
npm pack
```

Build must precede pack: `prepack` checks for the bundle and matching build
metadata. The builder reads the fork version from `agent-cli/package.json`
and the commit from Git HEAD (or `CUMORA_BUILD_COMMIT`, a full 40-character hash).
`CUMORA_CLI_OUTDIR` can direct output into a temporary staging package's `dist`
directory; copy this package manifest and README to staging before packing there.

The build rejects server database modules and non-builtin runtime imports.
The tgz has no runtime npm dependencies. Verify with an isolated global prefix:

```sh
npm install --global --prefix <temporary-prefix> --ignore-scripts --offline <tgz-path>
```

Run `<temporary-prefix>/cumora.cmd --version` on Windows or
`<temporary-prefix>/bin/cumora --version` on macOS/Linux. Both must report the
expected fork version and full source commit before rollout.

The separate `agent-cli-release.yml` workflow is manually dispatched with an
existing immutable `agent-cli-v<fork-version>` tag. It builds, packs, verifies
an isolated installation, and uploads the tgz plus SHA-256 checksum to a draft
GitHub Release. Publishing the draft and switching running machines belong to
the deployment task; this source preparation performs neither action.
