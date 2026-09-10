/**
 * Message-level routing: does an ordinary human group message need EVERY agent
 * in the room to wake up, or is it addressed at specific people?
 *
 * Today the scheduler picks recipients purely by membership, so a five-agent
 * room pays five big-brain turns for `@nova draft the launch email` — and
 * production measures ~26% of group wakes producing no reply at all.
 *
 * The decision is deliberately shaped so the model has the SMALLEST possible
 * job. Targets are derived deterministically (an exact @mention, a quote-reply)
 * — the cerebellum only says whether the message is aimed at those people
 * ("me") or at the room ("each"). It never picks who.
 *
 * Everything here fails OPEN. Narrowing a wake is the one mistake that is
 * silent: an agent that should have answered and was never woken leaves no
 * reply, no typing indicator, and no agent_runs row. So every uncertainty —
 * no targets, an @all, a model error, an unparseable answer — resolves to
 * today's full fan-out.
 */
import type { ResponseMode } from './triage-core.js'

/** `@all` is a broadcast: it must never be narrowed, whatever else the message
 *  says. Same token rule the turn prompt uses to tag a broadcast. */
const ALL_MENTION_RE = /(?<![\w@])@all(?![\w-])/i

export interface RouteRequest {
  /** Set when the answer is known WITHOUT a model call. */
  mode?: ResponseMode
  /** Set when a model call is needed. */
  instructions?: string
  input?: string
}

/** Decide the route, or build the request that decides it.
 *
 *  `candidates` is the set of agents the scheduler would wake today;
 *  `targets` is the deterministically-addressed subset of them. */
export function buildRouteRequest(args: {
  body: string
  conversationKind: string
  candidates: readonly string[]
  targets: readonly string[]
}): RouteRequest {
  // A broadcast is for everyone, by definition.
  if (ALL_MENTION_RE.test(args.body)) return { mode: 'each' }
  // A DM has one recipient; there is nothing to narrow and the existing
  // human-DM triage note already covers it.
  if (args.conversationKind === 'direct') return { mode: 'each' }
  // Nothing to narrow TO. This is the important one: if the message names
  // nobody, narrowing would wake no one at all.
  if (args.targets.length === 0) return { mode: 'each' }
  // Narrowing saves nothing when the targets already are the whole room.
  if (args.targets.length >= args.candidates.length) return { mode: 'each' }

  return {
    instructions: [
      'You route ONE message in a team chat where some teammates are AI agents.',
      'The message explicitly names one or more agents. Decide whether it is aimed at THEM, or at the room.',
      'Answer "me" when the named agents are the ones expected to act or reply — a direct request, an assignment, a question put to them.',
      'Answer "each" when the whole room is still expected to engage — an open question that merely cites someone, a broadcast, a roll call, a request for several independent opinions.',
      'When you are unsure, answer "each". Waking an extra agent costs tokens; failing to wake the right one loses the message.',
      'Respond ONLY with a single JSON object: {"responseMode": "me"|"each"}.',
    ].join('\n'),
    input: [
      `Named agents: ${args.targets.join(', ')}`,
      `Other agents in the room: ${args.candidates.filter((c) => !args.targets.includes(c)).join(', ') || '(none)'}`,
      '',
      'Message:',
      args.body.slice(0, 2000),
    ].join('\n'),
  }
}

/** Parse the router's answer. Anything unexpected — malformed JSON, a mode we
 *  don't know, an empty completion — reads as `each`, i.e. change nothing. */
export function parseRoute(raw: string): ResponseMode {
  const match = raw.match(/"responseMode"\s*:\s*"(me|each|one-of-us)"/i)
  const mode = match?.[1]?.toLowerCase()
  return mode === 'me' ? 'me' : 'each'
}

/** The recipients to actually wake. Separated from the model call so the
 *  narrowing rule itself is testable without one.
 *
 *  Returns `candidates` unchanged unless the route is `me` AND every target is
 *  a real candidate — a target that is not in the wake set (departed, muted out,
 *  the author themselves) must never shrink the room to nothing. */
export function recipientsForRoute(
  mode: ResponseMode,
  candidates: readonly string[],
  targets: readonly string[],
): string[] {
  if (mode !== 'me') return [...candidates]
  const narrowed = targets.filter((t) => candidates.includes(t))
  return narrowed.length > 0 ? narrowed : [...candidates]
}

/** Run the router on the cloud SMALL model. Returns `each` — i.e. today's
 *  behaviour — on any failure, including a model that is rate-limited or down.
 *  Tracked so the call lands in llm_calls with purpose='message-routing' and
 *  its cost is visible next to the turns it is meant to save. */
export async function routeMessage(args: {
  companyId: string | null
  body: string
  conversationKind: string
  candidates: readonly string[]
  targets: readonly string[]
}): Promise<ResponseMode> {
  const req = buildRouteRequest(args)
  if (req.mode) return req.mode
  try {
    const { getTrackedLlmClient } = await import('./llm-ledger.js')
    const { supportModel } = await import('./model-policy.js')
    const client = await getTrackedLlmClient({ role: 'support', purpose: 'message-routing', companyId: args.companyId })
    const r = await client.responses.create({
      model: supportModel(),
      instructions: req.instructions,
      input: req.input ?? '',
      max_output_tokens: 200,
    })
    return parseRoute(r.output_text ?? '')
  } catch (err) {
    console.warn(`[routing] router unavailable; waking everyone: ${err instanceof Error ? err.message : String(err)}`)
    return 'each'
  }
}
