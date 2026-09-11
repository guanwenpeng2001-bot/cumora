// Update this immutable tag when publishing the next fork CLI Release.
export const AGENT_CLI_RELEASE_TAG = 'agent-cli-v0.16.2-fork.3'
export const AGENT_CLI_RELEASE_VERSION = AGENT_CLI_RELEASE_TAG.replace('agent-cli-v', '')
// npm pack names the asset from package.json name+version — keep in sync.
export const AGENT_CLI_RELEASE_URL = `https://github.com/guanwenpeng2001-bot/cumora/releases/download/${AGENT_CLI_RELEASE_TAG}/cumora-${AGENT_CLI_RELEASE_VERSION}.tgz`
export const AGENT_CLI_INSTALL_COMMAND = `npm i -g ${AGENT_CLI_RELEASE_URL}`

/** Run the second line only after installation succeeds; works in PowerShell 5 too.
 *  `urlOverride` lets the server point at a newer fork release than this build shipped with. */
export function agentCliCommand(args: string, urlOverride?: string | null): string {
  return `npm i -g ${urlOverride || AGENT_CLI_RELEASE_URL}
cumora agent computer${args}`
}
