import { createHash } from 'node:crypto'

export const AGENT_MESSAGE_CONSUMPTIONS_SQL = `
CREATE TABLE agent_message_consumptions (
  agent_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, message_id)
);
`

export function agentMessageConsumptionsChecksum(): string {
  return createHash('sha256').update(AGENT_MESSAGE_CONSUMPTIONS_SQL).digest('hex')
}
