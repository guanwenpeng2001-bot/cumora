import type { api, AgentCreateInput, AgentInput } from '../api/client'
import type { EngineId } from '../types'

export type BindingStatus = 'loading' | 'error' | 'ready'

export function bindingReplacement(status: BindingStatus, initial: ReadonlySet<string>, checked: ReadonlySet<string>): string[] | null {
  if (status !== 'ready' || (initial.size === checked.size && [...initial].every((id) => checked.has(id)))) return null
  return [...checked]
}

export type SaveStage = 'profile' | 'host' | 'skills' | 'mcp'
export type StageStatus = 'pending' | 'saving' | 'saved' | 'skipped' | 'error'
type SaveApi = Pick<typeof api, 'createAgent' | 'updateAgent' | 'assignAgentComputer' | 'setAgentSkills' | 'setAgentMcpConnectors'>

interface SaveSnapshot {
  agentId?: string
  profile: AgentInput
  create: AgentCreateInput
  assignment?: {
    computerId: string
    engine?: EngineId
    inherit: boolean
    model: string | null
    fastModel: string | null
  }
  skills: string[] | null
  mcp: string[] | null
  expectedEngine?: EngineId
  engineError: string
}

export class AgentEditorSave {
  readonly snapshot: SaveSnapshot
  agentId?: string
  readonly stages: Record<SaveStage, StageStatus>
  private createdEngine?: EngineId
  private running = false

  constructor(snapshot: SaveSnapshot) {
    this.snapshot = structuredClone(snapshot)
    this.agentId = snapshot.agentId
    this.stages = {
      profile: 'pending',
      host: !snapshot.agentId || snapshot.assignment ? 'pending' : 'skipped',
      skills: snapshot.skills === null ? 'skipped' : 'pending',
      mcp: snapshot.mcp === null ? 'skipped' : 'pending',
    }
  }

  async run(client: SaveApi, isCurrent: () => boolean, changed: () => void, signal?: AbortSignal): Promise<boolean> {
    if (this.running || !isCurrent()) return false
    this.running = true
    const snapshot = this.snapshot
    try {
      for (const stage of ['profile', 'host', 'skills', 'mcp'] as const) {
        if (!isCurrent()) return false
        if (this.stages[stage] === 'saved' || this.stages[stage] === 'skipped') continue
        this.stages[stage] = 'saving'
        changed()
        try {
          if (stage === 'profile') {
            if (snapshot.agentId) await client.updateAgent(snapshot.agentId, structuredClone(snapshot.profile))
            else {
              const created = await client.createAgent(structuredClone(snapshot.create))
              this.agentId = created.id
              this.createdEngine = created.engine
            }
          } else if (stage === 'host') {
            let engine = this.createdEngine
            if (snapshot.assignment) {
              const a = snapshot.assignment
              const out = await client.assignAgentComputer(this.agentId!, a.computerId, a.engine, a.inherit, a.model, a.fastModel)
              engine = out.engine
            }
            if (snapshot.expectedEngine && engine !== snapshot.expectedEngine) throw new Error(snapshot.engineError)
          } else if (stage === 'skills') {
            await client.setAgentSkills(this.agentId!, [...snapshot.skills!], signal)
          } else {
            await client.setAgentMcpConnectors(this.agentId!, [...snapshot.mcp!], signal)
          }
          this.stages[stage] = 'saved'
        } catch (error) {
          this.stages[stage] = 'error'
          throw error
        } finally {
          if (isCurrent()) changed()
        }
      }
      return isCurrent()
    } finally {
      this.running = false
    }
  }
}
