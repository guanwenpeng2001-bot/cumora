// Update this immutable tag when publishing the next fork CLI Release.
export const AGENT_CLI_RELEASE_TAG = 'agent-cli-v0.16.2-fork.1'
export const AGENT_CLI_RELEASE_URL = `https://github.com/guanwenpeng2001-bot/cumora/releases/download/${AGENT_CLI_RELEASE_TAG}/cumora-agent-cli.tgz`
export const AGENT_CLI_INSTALL_COMMAND = `npm i -g ${AGENT_CLI_RELEASE_URL}`

/** Run the second line only after installation succeeds; works in PowerShell 5 too. */
export function agentCliCommand(args: string): string {
  return `${AGENT_CLI_INSTALL_COMMAND}
cumora agent computer${args}`
}
