// Update this immutable tag when publishing the next fork CLI Release.
export const AGENT_CLI_RELEASE_TAG = 'agent-cli-v0.16.2-fork.4'
export const AGENT_CLI_RELEASE_VERSION = AGENT_CLI_RELEASE_TAG.replace('agent-cli-v', '')
declare const __CUMORA_GITHUB_OWNER__: string | undefined
declare const __CUMORA_GITHUB_REPO__: string | undefined
const GITHUB_OWNER = (typeof __CUMORA_GITHUB_OWNER__ !== 'undefined' && __CUMORA_GITHUB_OWNER__?.trim()) || 'guanwenpeng2001-bot'
const GITHUB_REPO = (typeof __CUMORA_GITHUB_REPO__ !== 'undefined' && __CUMORA_GITHUB_REPO__?.trim()) || 'cumora'
// npm pack names the asset from package.json name+version — keep in sync.
export const AGENT_CLI_RELEASE_URL = `https://github.com/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/releases/download/${AGENT_CLI_RELEASE_TAG}/cumora-${AGENT_CLI_RELEASE_VERSION}.tgz`
export const AGENT_CLI_INSTALL_COMMAND = `npm i -g ${AGENT_CLI_RELEASE_URL}`

/** Run the second line only after installation succeeds; works in PowerShell 5 too.
 *  `urlOverride` lets the server point at a newer fork release than this build shipped with. */
export function agentCliCommand(args: string, urlOverride?: string | null): string {
  return `npm i -g ${urlOverride || AGENT_CLI_RELEASE_URL}
cumora agent computer${args}`
}
