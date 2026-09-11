import { useEffect, useMemo, useRef, useState } from 'react'
import { type AgentInput, api, getPairingServerOrigin, http, resolveAssetUrl } from '@/api/client'
import { Checkbox } from '@/components/Checkbox'
import { Combobox, type ComboboxOption } from '@/components/Combobox'
import { Input } from '@/components/Input'
import { AgentModelFields, CatalogStatus, EFFORT_OPTIONS, modelComboboxOptions, modelInteger, modelSuggestions } from '@/components/ModelFields'
import { Select } from '@/components/Select'
import { TextArea } from '@/components/TextArea'
import { agentCliCommand } from '@/lib/agentCliRelease'
import { engineLabel } from '@/lib/engines'
import { translate, useLocaleStore, useT } from '@/lib/i18n'
import { isNativePlatform } from '@/lib/native'
import { useAuth } from '@/stores/auth'
import { useComputers } from '@/stores/computers'
import { useConversations } from '@/stores/conversations'
import { useModelCatalog } from '@/stores/modelCatalog'
import { useParticipants } from '@/stores/participants'
import type { AgentModelConfig, EngineId, Participant } from '@/types'
import { AgentEditorSave, type BindingStatus, bindingReplacement, type SaveStage, type StageStatus } from './agentEditorSave'

const INHERIT_ENGINE = '__inherit__'

const formatAvatarError = (error: unknown, t: (key: 'agent.avatarGatewayNoAccounts') => string): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (/no available compatible accounts|gateway group has no available accounts|没有可用账号/i.test(message)) {
    return t('agent.avatarGatewayNoAccounts')
  }
  return message
}

function newCreateRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Which engine-dropdown value to show for a saved agent.
 *  Official production has no `engineInherit`: a stored engine that isn't
 *  the computer default means the user pinned it. */
function initialEngineChoice(agent: Participant | null, computer: { kind: string; availableEngines: EngineId[] } | undefined): string {
  if (!agent || !computer || computer.kind === 'cloud') return INHERIT_ENGINE
  const advertised = computer.availableEngines
  const engine = agent.engine
  if (!engine || engine === 'managed' || !advertised.includes(engine)) return INHERIT_ENGINE
  if (agent.engineInherit === true) return INHERIT_ENGINE
  if (agent.engineInherit === false) return engine
  return engine === advertised[0] ? INHERIT_ENGINE : engine
}

const PALETTE = [
  '#FFB088', '#FFD9D2', '#FFB7AF', '#F4B740',
  '#7C5CFF', '#A593FF', '#4FC2F4', '#41B5DC',
  '#4FC2A1', '#6EC56A', '#E9A0E9', '#FF7AB6',
]

interface Props {
  /** if provided, edit mode; otherwise create mode */
  agent: Participant | null
  onClose: () => void
  /** Called after any persisted save stage, once the modal is already closed. */
  onSaved?: () => void
}

export function AgentEditor({ agent, onClose, onSaved }: Props) {
  const t = useT()
  const editing = agent !== null
  const canWrite = useAuth((s) => ['owner', 'admin'].includes(s.companies.find((c) => c.id === s.activeCompanyId)?.role ?? ''))
  const [savedAgentId, setSavedAgentId] = useState<string | null>(null)
  const [resourceRefresh, setResourceRefresh] = useState(0)
  const locale = useLocaleStore((s) => s.locale)
  const copy = {
    loading: translate(locale, 'settings.loadingBindings'),
    loadError: translate(locale, 'settings.loadingFailedSavingTheProfileWillPreserveTheseBindings'),
    retryLoad: translate(locale, 'settings.reload'),
    empty: translate(locale, 'settings.noResourcesAvailable'),
    dirty: translate(locale, 'settings.unsavedBindingChanges'),
    unchanged: translate(locale, 'settings.bindingsUnchanged'),
    retry: translate(locale, 'settings.retryUnfinishedStages'),
    frozen: translate(locale, 'settings.thisSaveIsLockedToItsOriginalContentRetry'),
    contextChanged: translate(locale, 'settings.theCompanyOrSignInContextChangedCloseAnd'),
    profile: translate(locale, 'settings.profile'),
    host: translate(locale, 'settings.host'),
    skills: translate(locale, 'me.tab.skills'),
    mcp: t('agent.stageMcp'),
    pending: translate(locale, 'settings.pending2'),
    saving: translate(locale, 'settings.saving'),
    saved: translate(locale, 'settings.saved'),
    skipped: translate(locale, 'settings.noWriteNeeded'),
    error: translate(locale, 'settings.failedRetryNeeded'),
    savedId: translate(locale, 'settings.createdAgentId'),
  }
  const context = useRef(useAuth.getState())
  const epoch = useAuth((s) => s.contextEpoch)
  const mounted = useRef(true)
  const requests = useRef(new AbortController())
  const isCurrent = () => {
    const current = useAuth.getState()
    return mounted.current && current.contextEpoch === context.current.contextEpoch
      && current.activeCompanyId === context.current.activeCompanyId && current.token === context.current.token
  }
  const contextChanged = epoch !== context.current.contextEpoch
  const save = useRef<AgentEditorSave | null>(null)
  const submitting = useRef(false)
  const [progress, setProgress] = useState<Record<SaveStage, StageStatus> | null>(null)
  useEffect(() => {
    mounted.current = true
    requests.current = new AbortController()
    const unsubscribe = useAuth.subscribe(() => {
      if (!isCurrent()) requests.current.abort()
    })
    return () => { mounted.current = false; requests.current.abort(); unsubscribe() }
  }, [])
  const [name, setName] = useState(agent?.name ?? '')
  const [role, setRole] = useState(agent?.role ?? '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '')
  const [bio, setBio] = useState(agent?.bio ?? '')
  const [avatarBg, setAvatarBg] = useState(agent?.avatarBg ?? PALETTE[0])
  const [model, setModel] = useState(agent?.model ?? '')
  const [fastModel, setFastModel] = useState(agent?.fastModel ?? '')
  // Advanced model settings (participants.model_config). Empty/'' fields
  // mean "inherit the global role setting". Managed agents only — BYOA is
  // engine-managed.
  const [mcEffort, setMcEffort] = useState(agent?.modelConfig?.effort ?? '')
  const [mcContextWindow, setMcContextWindow] = useState(agent?.modelConfig?.contextWindow != null ? String(agent.modelConfig.contextWindow) : '')
  const [mcMaxTokens, setMcMaxTokens] = useState(agent?.modelConfig?.maxOutputTokens != null ? String(agent.modelConfig.maxOutputTokens) : '')
  const [mcThinking, setMcThinking] = useState<boolean | undefined>(agent?.modelConfig?.thinking)
  const [mcFallbacks, setMcFallbacks] = useState<string[]>(agent?.modelConfig?.fallbackModels ?? [])
  // Skills: checkbox over the company library; edit mode loads the agent's
  // enablement, create mode saves after creation.
  const [skillChoices, setSkillChoices] = useState<Array<{ id: string; name: string; description: string }>>([])
  const [skillChecked, setSkillChecked] = useState<Set<string>>(new Set())
  const [connectorChoices, setConnectorChoices] = useState<Array<{ id: string; name: string; type: 'stdio' | 'http'; globallyEnabled: boolean }>>([])
  const [connectorChecked, setConnectorChecked] = useState<Set<string>>(new Set())
  const [skillStatus, setSkillStatus] = useState<BindingStatus>('loading')
  const [connectorStatus, setConnectorStatus] = useState<BindingStatus>('loading')
  const [skillInitial, setSkillInitial] = useState<Set<string>>(new Set())
  const [connectorInitial, setConnectorInitial] = useState<Set<string>>(new Set())
  const [skillReload, setSkillReload] = useState(0)
  const [connectorReload, setConnectorReload] = useState(0)
  const skillDirty = bindingReplacement(skillStatus, skillInitial, skillChecked) !== null
  const connectorDirty = bindingReplacement(connectorStatus, connectorInitial, connectorChecked) !== null
  useEffect(() => {
    if (!isCurrent()) return
    const controller = new AbortController()
    const abort = () => controller.abort()
    const parentSignal = requests.current.signal
    parentSignal.addEventListener('abort', abort)
    setSkillStatus('loading')
    const load = editing && agent
      ? api.getAgentSkills(agent.id, controller.signal).then((r) => r.items.map((x) => ({ id: x.skill.id, name: x.skill.name, description: x.skill.description, enabled: x.enabled })))
      : api.getSkills(controller.signal).then((r) => r.items.map((x) => ({ id: x.id, name: x.name, description: x.description, enabled: false })))
    void load.then((items) => {
      if (controller.signal.aborted || !isCurrent()) return
      const initial = new Set(items.filter((x) => x.enabled).map((x) => x.id))
      setSkillChoices(items.map(({ id, name, description }) => ({ id, name, description })))
      setSkillInitial(initial)
      setSkillChecked(new Set(initial))
      setSkillStatus('ready')
    }).catch(() => {
      if (!controller.signal.aborted && isCurrent()) setSkillStatus('error')
    })
    return () => { controller.abort(); parentSignal.removeEventListener('abort', abort) }
  }, [editing, agent?.id, skillReload])
  useEffect(() => {
    if (!isCurrent()) return
    const controller = new AbortController()
    const abort = () => controller.abort()
    const parentSignal = requests.current.signal
    parentSignal.addEventListener('abort', abort)
    setConnectorStatus('loading')
    const load = editing && agent
      ? api.getAgentMcpConnectors(agent.id, controller.signal).then((r) => r.items.map((x) => ({ id: x.connector.id, name: x.connector.name, type: x.connector.type, globallyEnabled: x.connector.enabled, enabled: x.enabled })))
      : api.getMcpConnectors(controller.signal).then((r) => r.items.map((x) => ({ id: x.id, name: x.name, type: x.type, globallyEnabled: x.enabled, enabled: false })))
    void load.then((items) => {
      if (controller.signal.aborted || !isCurrent()) return
      const initial = new Set(items.filter((x) => x.enabled).map((x) => x.id))
      setConnectorChoices(items.map(({ id, name, type, globallyEnabled }) => ({ id, name, type, globallyEnabled })))
      setConnectorInitial(initial)
      setConnectorChecked(new Set(initial))
      setConnectorStatus('ready')
    }).catch(() => {
      if (!controller.signal.aborted && isCurrent()) setConnectorStatus('error')
    })
    return () => { controller.abort(); parentSignal.removeEventListener('abort', abort) }
  }, [editing, agent?.id, connectorReload])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(agent?.avatarUrl ?? null)
  const [generatingAvatar, setGeneratingAvatar] = useState(false)
  const [avatarErr, setAvatarErr] = useState<string | null>(null)
  const [repairCode, setRepairCode] = useState<string | null>(null)
  const [repairErr, setRepairErr] = useState<string | null>(null)
  const [repairCopied, setRepairCopied] = useState(false)
  // Survives an ambiguous network failure and the user's retry click, but a
  // newly opened editor gets a fresh key. The server binds it to the payload.
  const createRequestId = useRef(newCreateRequestId())

  // "Runs on" — which Computer hosts this agent. Cloud = managed engine.
  // Free tier is BYOA-only: it has no real Cumora Cloud computer; we show a
  // LOCKED "Cumora Cloud (Pro)" upsell instead and never default/select it.
  const activeTier = useAuth((s) => s.companies.find((c) => c.id === s.activeCompanyId)?.tier)
  const isFreeTier = activeTier === 'free'
  const computersById = useComputers((s) => s.byId)
  const computers = Object.values(computersById)
    .sort((a, b) => (a.kind === 'cloud' ? 0 : 1) - (b.kind === 'cloud' ? 0 : 1) || a.name.localeCompare(b.name))
  const cloud = computers.find((c) => c.kind === 'cloud')
  const firstByoa = computers.find((c) => c.kind !== 'cloud')
  // Default for a NEW agent: paid → Cumora Cloud; free → first paired computer.
  const [computerId, setComputerId] = useState(agent?.computerId ?? (isFreeTier ? firstByoa?.id : cloud?.id) ?? '')
  const [engineChoice, setEngineChoice] = useState(
    initialEngineChoice(agent, agent?.computerId ? computersById[agent.computerId] : undefined),
  )
  const engineTouched = useRef(false)
  const selectedComputer = computerId ? computersById[computerId] : undefined
  const isByoa = !!selectedComputer && selectedComputer.kind !== 'cloud'
  const selectedEngineId: EngineId = (
    engineChoice !== INHERIT_ENGINE
      ? engineChoice
      : (selectedComputer?.availableEngines[0] ?? 'claude')
  ) as EngineId
  const selectedComputerOffline = isByoa && selectedComputer.status !== 'online'
  const modelCatalog = selectedComputer?.detectedEngines
    ?.find((engine) => engine.id === selectedEngineId)
    ?.modelCatalog
  // Per-computer engine model defaults (configured on the Computer card).
  // When the local CLI catalog can't name a default (e.g. custom endpoints),
  // these Cumora-side settings show as the hint for "follow engine default".
  const engineDefaultModel = selectedComputer?.engineDefaults?.[selectedEngineId]?.model ?? undefined
  const engineDefaultFastModel = selectedComputer?.engineDefaults?.[selectedEngineId]?.fastModel ?? undefined
  const modelOptions: Array<ComboboxOption<string>> = [
    {
      value: '',
      label: t('agent.followEngineDefault'),
      hint: engineDefaultModel ?? modelCatalog?.defaultModel ?? undefined,
    },
    ...(modelCatalog?.models ?? []).map((option) => ({
      value: option.id,
      label: option.label,
      hint: [
        option.label !== option.id ? option.id : null,
        option.recommendedFor?.includes('big') ? t('agent.recommended') : null,
      ].filter(Boolean).join(' · ') || undefined,
    })),
  ]
  const fastModelOptions: Array<ComboboxOption<string>> = [
    {
      value: '',
      label: t('agent.followSmallBrainDefault'),
      hint: engineDefaultFastModel ?? modelCatalog?.defaultFastModel ?? undefined,
    },
    ...(modelCatalog?.models ?? []).map((option) => ({
      value: option.id,
      label: option.label,
      hint: [
        option.label !== option.id ? option.id : null,
        option.recommendedFor?.includes('small') ? t('agent.recommended') : null,
      ].filter(Boolean).join(' · ') || undefined,
    })),
  ]
  // Managed primary and fallback pickers share the full global model catalog;
  // BYOA keeps using the host engine's reported catalog (modelOptions).
  const catalogState = useModelCatalog(!isByoa && !contextChanged)
  const catalog = catalogState.catalog
  const catalogText = useMemo(
    () => modelSuggestions(catalog, [model, agent?.model ?? ''], mcFallbacks, agent?.modelConfig?.fallbackModels ?? []),
    [catalog, model, agent?.model, mcFallbacks, agent?.modelConfig?.fallbackModels],
  )
  const managedModelOptions = useMemo(
    () => [
      { value: '', label: t('agent.followGlobalDefault') },
      ...modelComboboxOptions(catalog, [model, agent?.model ?? ''], mcFallbacks, agent?.modelConfig?.fallbackModels ?? []),
    ],
    [catalog, model, agent?.model, mcFallbacks, agent?.modelConfig?.fallbackModels, locale],
  )
  const effortOptions = EFFORT_OPTIONS

  const origin = getPairingServerOrigin()
  const repairCommand = repairCode
    ? agentCliCommand(` --pair ${repairCode}${origin ? ` --server ${origin}` : ''}`)
    : ''

  useEffect(() => { void useComputers.getState().refresh() }, [])
  useEffect(() => {
    if (!agent || engineTouched.current) return
    const host = agent.computerId ? computersById[agent.computerId] : undefined
    if (!host) return
    setEngineChoice(initialEngineChoice(agent, host))
  }, [agent, computersById])
  useEffect(() => {
    setRepairCopied(false)
    setRepairErr(null)
    setRepairCode(null)
    if (!canWrite || !selectedComputerOffline || !selectedComputer || !isCurrent() || save.current) return

    let cancelled = false
    void api.repairComputer(selectedComputer.id)
      .then((out) => { if (!cancelled) setRepairCode(out.code) })
      .catch((e) => {
        if (!cancelled) setRepairErr(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [selectedComputer?.id, selectedComputerOffline, canWrite])
  useEffect(() => {
    if (!repairCopied) return
    const t = window.setTimeout(() => setRepairCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [repairCopied])
  // Default selection once the list loads (new agents): paid → Cumora Cloud,
  // free → the first paired computer (never cloud).
  useEffect(() => {
    if (computerId) return
    if (isFreeTier && firstByoa) { setComputerId(firstByoa.id); setEngineChoice(INHERIT_ENGINE) }
    else if (!isFreeTier && cloud) { setComputerId(cloud.id); setEngineChoice(INHERIT_ENGINE) }
  }, [cloud, firstByoa, computerId, isFreeTier])

  // Model ids belong to the selected local engine/account. Do not carry a pin
  // across a host or engine switch where the new CLI may reject it.
  const clearModelPins = (): void => {
    setModel('')
    setFastModel('')
  }

  const changeComputer = (id: string): void => {
    if (id === computerId) return
    engineTouched.current = true
    setComputerId(id)
    setEngineChoice(INHERIT_ENGINE)
    clearModelPins()
  }

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented
        || document.querySelector('[role="combobox"][aria-expanded="true"]')
        || Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]'))
          .some((list) => list.getClientRects().length > 0 && getComputedStyle(list).visibility !== 'hidden')) return
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onSaved, savedAgentId])

  const submit = async () => {
    if (!canWrite || savedAgentId || submitting.current || generatingAvatar || !name.trim() || !systemPrompt.trim() || !isCurrent()) return
    submitting.current = true
    setErr(null)
    setBusy(true)
    try {
      if (!save.current) {
        const target = computerId || cloud?.id
        const current = agent?.computerId ?? cloud?.id
        const targetComputer = target ? computersById[target] : undefined
        const isByoaTarget = !!targetComputer && targetComputer.kind !== 'cloud'
        const inherit = engineChoice === INHERIT_ENGINE
        const pinned = inherit ? undefined : (engineChoice as EngineId)
        const savedChoice = initialEngineChoice(agent, targetComputer)
        const inheritChanged = isByoaTarget && inherit !== (savedChoice === INHERIT_ENGINE)
        const engineChanged = isByoaTarget && !inherit && pinned !== ((agent?.engine as EngineId) ?? null)
        const assignmentChanged = Boolean(target && (target !== current || inheritChanged || engineChanged))
        // BYOA agents are engine-managed — never send modelConfig for them.
        // Managed: build the object; null clears a previously saved config.
        const modelConfigPayload = ((): AgentModelConfig | null | undefined => {
          if (isByoaTarget) return undefined
          const mc: AgentModelConfig = {}
          if (mcEffort && !effortOptions.includes(mcEffort)) throw new Error('effort: ' + effortOptions.join('/'))
          if (mcEffort) mc.effort = mcEffort
          const cw = modelInteger(mcContextWindow, t('agent.mcContextWindow'), 1, 2_000_000)
          if (cw !== undefined) mc.contextWindow = cw
          const mt = modelInteger(mcMaxTokens, t('agent.mcMaxTokens'), 1, 1_000_000)
          if (mt !== undefined) mc.maxOutputTokens = mt
          if (mcThinking !== undefined) mc.thinking = mcThinking
          if (mcFallbacks.length > 0) mc.fallbackModels = mcFallbacks
          return Object.keys(mc).length > 0 ? mc : null
        })()
        const payload: AgentInput = {
          name, role, systemPrompt, bio, avatarBg,
          model: model.trim() || null,
          fastModel: fastModel.trim() || null,
          modelConfig: modelConfigPayload,
        }
        // A host/engine change persists these pins in the assignment's single
        // SQL UPDATE. Do not clear them earlier if that assignment may fail.
        const profilePayload = assignmentChanged
          ? { ...payload, model: undefined, fastModel: undefined }
          : payload
        if (editing && (agent!.avatarUrl ?? null) !== avatarUrl) profilePayload.avatarUrl = avatarUrl
        save.current = new AgentEditorSave({
          agentId: agent?.id,
          profile: profilePayload,
          create: {
            ...payload,
            requestId: createRequestId.current,
            computerId: target || null,
            engine: isByoaTarget ? pinned : undefined,
            inherit: isByoaTarget ? inherit : false,
          },
          assignment: editing && target && assignmentChanged ? {
            computerId: target,
            engine: isByoaTarget ? pinned : undefined,
            inherit: isByoaTarget ? inherit : false,
            model: model.trim() || null,
            fastModel: fastModel.trim() || null,
          } : undefined,
          expectedEngine: (!editing || assignmentChanged) && isByoaTarget ? pinned : undefined,
          engineError: t('agent.enginePinRejected', { engine: engineLabel(pinned ?? 'managed') }),
          skills: canWrite ? bindingReplacement(skillStatus, skillInitial, skillChecked) : null,
          mcp: canWrite ? bindingReplacement(connectorStatus, connectorInitial, connectorChecked) : null,
        })
      }
      const attempt = save.current
      const completed = await attempt.run(api, isCurrent, () => {
        setProgress({ ...attempt.stages })
        setResourceRefresh((n) => n + 1)
        if (attempt.stages.skills === 'saved') setSkillInitial(new Set(attempt.snapshot.skills!))
        if (attempt.stages.mcp === 'saved') setConnectorInitial(new Set(attempt.snapshot.mcp!))
      }, requests.current.signal)
      if (!completed || !isCurrent()) return
      setSavedAgentId(attempt.agentId!)
      setResourceRefresh((n) => n + 1)
      void useParticipants.getState().refresh()
      void useConversations.getState().reload()
      return attempt.agentId
    } catch (e) {
      if (isCurrent()) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      submitting.current = false
      if (isCurrent()) setBusy(false)
    }
  }

  const close = () => {
    const shouldRefresh = !!(save.current?.agentId || savedAgentId) && isCurrent()
    onClose()
    if (shouldRefresh) {
      void useParticipants.getState().refresh()
      void useConversations.getState().reload()
      onSaved?.()
    }
  }

  const initial = (name || agent?.id || '?').charAt(0).toUpperCase()

  const generateAvatar = async () => {
    if (!canWrite || !editing || !agent || !isCurrent() || submitting.current || save.current || generatingAvatar) return
    setAvatarErr(null)
    // Complete every stage before generating from the persisted profile.
    const agentId = await submit()
    if (!agentId || !isCurrent()) return
    setGeneratingAvatar(true)
    try {
      const r = await api.generateAgentAvatar(agentId)
      if (!isCurrent()) return
      setAvatarUrl(r.url)
      await useParticipants.getState().refresh()
    } catch (e) {
      if (isCurrent()) setAvatarErr(formatAvatarError(e, t))
    } finally {
      if (isCurrent()) setGeneratingAvatar(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={close}
    >
      <div
        className="bg-cloud rounded-[18px] shadow-pop w-full max-w-[560px] max-h-[90vh] flex flex-col overflow-hidden"
        style={{ border: '1px solid var(--ink-100)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-ink-100 flex items-center gap-3 shrink-0">
          <div
            className="w-12 h-12 rounded-full grid place-items-center text-white font-bold text-[18px] shrink-0 overflow-hidden relative"
            style={{ background: avatarUrl ? 'transparent' : avatarBg }}
          >
            {avatarUrl
              ? <img src={resolveAssetUrl(avatarUrl)} alt={name || initial} className="absolute inset-0 w-full h-full object-cover" />
              : initial}
          </div>
          <div className="flex-1">
            <h2 className="font-display font-medium text-[20px] tracking-tight">
              {editing ? t('agent.editAgent', { name: agent!.name }) : t('agent.newAgent')}
            </h2>
            <div className="text-[12.5px] text-ink-500 italic font-display">
              {editing ? t('agent.editSubtitle') : t('agent.newSubtitle')}
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="w-8 h-8 rounded-full grid place-items-center text-ink-500 hover:bg-sky2-50 hover:text-ink-900 transition"
            aria-label={t('common.close')}
          >×</button>
        </div>

        {/* Chromium does not reliably clip/scroll a flex-shrunk fieldset's anonymous
            content box. Let a regular flex item own scrolling; keep the fieldset
            at its intrinsic height so native disabled semantics still apply. */}
        <div className="overflow-y-auto flex-1 min-h-0 min-w-0">
        <fieldset disabled={!canWrite || busy || !!progress || contextChanged || generatingAvatar} className="px-6 py-5 space-y-4 min-w-0">
          <Field label={t('agent.nameLabel')} hint={t('agent.nameHint')}>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('agent.namePh')}
            />
          </Field>

          <Field label={t('agent.roleLabel')} hint={t('agent.roleHint')}>
            <Input
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder={t('agent.rolePh')}
            />
          </Field>

          <Field label={t('agent.styleLabel')} hint={t('agent.styleHint')}>
            <TextArea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={5}
              placeholder={t('agent.stylePh')}
              className="font-display italic"
              style={{ minHeight: 110 }}
            />
          </Field>

          <Field label={t('agent.bioLabel')} hint={t('agent.bioHint')}>
            <TextArea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={2}
              placeholder={t('agent.bioPh')}
            />
          </Field>

          <Field
            label={isByoa ? t('agent.modelLabelByoa') : t('agent.modelLabel')}
            hint={isByoa ? t('agent.modelHintByoaCatalog') : t('agent.modelHintCloud')}
          >
            {isByoa ? (
              <Combobox
                ariaLabel={t('agent.modelLabelByoa')}
                value={model}
                onValueChange={setModel}
                options={modelOptions}
                searchPlaceholder={t('agent.searchModels')}
                allowCustom={modelCatalog?.supportsCustom !== false}
                customLabel={(value) => t('agent.useCustomModel', { model: value })}
              />
            ) : (
              <Combobox
                ariaLabel={t('agent.modelLabel')}
                value={model}
                onValueChange={setModel}
                options={managedModelOptions}
                searchPlaceholder={t('agent.searchModels')}
                allowCustom
                customLabel={(value) => t('agent.useCustomModel', { model: value })}
              />
            )}
          </Field>

          {!isByoa && <CatalogStatus {...catalogState} />}

          {isByoa && (!modelCatalog || modelCatalog.fastModelScope === 'agent') && (
            <Field
              label={t('agent.fastLabelByoa')}
              hint={t('agent.fastHintByoaCatalog')}
            >
              <Combobox
                ariaLabel={t('agent.fastLabelByoa')}
                value={fastModel}
                onValueChange={setFastModel}
                options={fastModelOptions}
                searchPlaceholder={t('agent.searchModels')}
                allowCustom={modelCatalog?.supportsCustom !== false}
                customLabel={(value) => t('agent.useCustomModel', { model: value })}
              />
            </Field>
          )}

          <AgentModelFields
            isByoa={isByoa}
            mcEffort={mcEffort} setMcEffort={setMcEffort}
            mcContextWindow={mcContextWindow} setMcContextWindow={setMcContextWindow}
            mcMaxTokens={mcMaxTokens} setMcMaxTokens={setMcMaxTokens}
            mcThinking={mcThinking} setMcThinking={setMcThinking}
            mcFallbacks={mcFallbacks} setMcFallbacks={setMcFallbacks}
            catalogText={catalogText} model={model}
            history={agent?.modelConfig?.fallbackModels}
            catalog={catalogState.catalog}
          />

          <div className="rounded-[10px] border border-ink-100 bg-paper/60 px-3.5 py-2.5">
            <div className="text-[12.5px] font-semibold text-ink-700 mb-1.5">{t('agent.skillsTitle')}</div>
            <div className="text-[11.5px] text-ink-500" role="status">
              {skillStatus === 'loading' ? copy.loading : skillStatus === 'error' ? copy.loadError
                : skillChoices.length === 0 ? copy.empty : skillDirty ? copy.dirty : copy.unchanged}
              {skillStatus === 'error' && <button type="button" className="ml-2 underline" onClick={() => setSkillReload((n) => n + 1)}>{copy.retryLoad}</button>}
            </div>
            <div className="space-y-1">
              {skillStatus === 'ready' && skillChoices.map((sk) => (
                <Checkbox
                  key={sk.id}
                  disabled={!canWrite}
                  checked={skillChecked.has(sk.id)}
                  onCheckedChange={(next) => {
                    if (!canWrite) return
                    setSkillChecked((prev) => {
                      const copy = new Set(prev)
                      if (next) copy.add(sk.id)
                      else copy.delete(sk.id)
                      return copy
                    })
                  }}
                  label={sk.name}
                  description={sk.description}
                />
              ))}
            </div>
          </div>

          <div className="rounded-[10px] border border-ink-100 bg-paper/60 px-3.5 py-2.5">
            <div className="text-[12.5px] font-semibold text-ink-700 mb-1.5">{t('agent.connectorsTitle')}</div>
            <div className="text-[11.5px] text-ink-500" role="status">
              {connectorStatus === 'loading' ? copy.loading : connectorStatus === 'error' ? copy.loadError
                : connectorChoices.length === 0 ? copy.empty : connectorDirty ? copy.dirty : copy.unchanged}
              {connectorStatus === 'error' && <button type="button" className="ml-2 underline" onClick={() => setConnectorReload((n) => n + 1)}>{copy.retryLoad}</button>}
            </div>
            <div className="text-[10.5px] text-ink-400 italic mb-1.5">
              {translate(locale, 'settings.checkToBindUncheckAndSaveToUnbindFrom')}
            </div>
            <div className="space-y-1">
              {connectorStatus === 'ready' && connectorChoices.map((c) => (
                <Checkbox
                  key={c.id}
                  disabled={!canWrite}
                  checked={connectorChecked.has(c.id)}
                  onCheckedChange={(next) => {
                    if (!canWrite) return
                    setConnectorChecked((prev) => {
                      const copy = new Set(prev)
                      if (next) copy.add(c.id)
                      else copy.delete(c.id)
                      return copy
                    })
                  }}
                  label={c.name}
                  description={c.type + (c.globallyEnabled ? '' : (translate(locale, 'settings.globallyDisabledBindingRetained')))}
                />
              ))}
            </div>
          </div>

          <Field
            label={t('agent.runsOnLabel')}
            hint={t('agent.runsOnHint')}
          >
            <Select
              ariaLabel={t('agent.runsOnLabel')}
              value={computerId}
              onValueChange={changeComputer}
              options={[
                // Free tier has no real Cumora Cloud computer — filter any out
                // (defensive) and append a locked Pro upsell entry instead.
                // NOT on native: App Store Guideline 3.1.1 forbids referencing
                // a paid tier that isn't purchasable in-app via IAP, so the
                // iOS/Android builds omit the upsell entirely.
                ...computers
                  .filter((c) => !(isFreeTier && c.kind === 'cloud'))
                  .map((c) => ({
                    value: c.id,
                    label: `${c.kind === 'cloud' ? '☁' : c.kind === 'vps' ? '🖥' : '💻'} ${c.name}`
                      + (c.kind !== 'cloud' && c.status !== 'online' ? ` ${t('agent.offlineSuffix')}` : ''),
                  })),
                ...(isFreeTier && !isNativePlatform()
                  ? [{ value: '__cloud_pro__', label: t('agent.upgradeToPro'), disabled: true }]
                  : []),
              ]}
            />
            {selectedComputer && selectedComputer.kind !== 'cloud' && (
              <div className="mt-2">
                <Select
                  ariaLabel={t('agent.engineLabel')}
                  value={engineChoice}
                  onValueChange={(value) => {
                    if (value === engineChoice) return
                    engineTouched.current = true
                    setEngineChoice(value)
                    clearModelPins()
                  }}
                  options={(() => {
                    const advertised = selectedComputer.availableEngines.length
                      ? selectedComputer.availableEngines
                      : (['claude'] as EngineId[])
                    const defaultId = advertised[0]
                    return [
                      { value: INHERIT_ENGINE, label: t('agent.engineInherit', { engine: engineLabel(defaultId) }) },
                      ...advertised.map((en) => ({ value: en, label: engineLabel(en) })),
                    ]
                  })()}
                />
                <div className="mt-1.5 text-[11.5px] text-ink-400">{t('agent.engineHint')}</div>
              </div>
            )}
            {canWrite && selectedComputerOffline && (
              <div
                className="mt-3 rounded-[12px] p-3"
                style={{ background: 'var(--sky-50)', border: '1px solid var(--sky-100)' }}
              >
                <div className="text-[12px] font-semibold text-ink-900 mb-1">
                  {t('agent.computerOfflineMsg', { name: selectedComputer?.name ?? '' })}
                </div>
                {repairErr ? (
                  <div className="text-[11.5px] text-coral-deep bg-coral-soft rounded-[8px] p-2">{repairErr}</div>
                ) : repairCommand ? (
                  <>
                    <pre className="bg-ink-900 text-cloud rounded-[9px] p-2.5 text-[11.5px] overflow-x-auto whitespace-pre-wrap break-all font-mono select-all">
                      {repairCommand}
                    </pre>
                    <button
                      type="button"
                      onClick={() => { void navigator.clipboard?.writeText(repairCommand); setRepairCopied(true) }}
                      className="mt-2 inline-flex items-center justify-center min-w-[108px] text-[11.5px] font-semibold px-3 py-1.5 rounded-[9px] text-white transition-colors duration-200"
                      style={{ background: repairCopied ? '#3BB273' : 'var(--skype)' }}
                    >
                      {repairCopied ? t('agent.copied') : t('agent.copyCommand')}
                    </button>
                  </>
                ) : (
                  <div className="text-[11.5px] text-ink-400">{t('agent.generatingReconnect')}</div>
                )}
              </div>
            )}
          </Field>

          <Field label={t('agent.avatarColorLabel')} hint={t('agent.avatarColorHint')}>
            <div className="flex flex-wrap gap-2">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setAvatarBg(c)}
                  className="w-8 h-8 rounded-full transition"
                  style={{
                    background: c,
                    boxShadow: avatarBg === c
                      ? '0 0 0 3px var(--cloud), 0 0 0 5px var(--skype)'
                      : 'inset 0 0 0 1px rgba(0,0,0,0.06)',
                  }}
                  aria-label={c}
                />
              ))}
            </div>
          </Field>

          <Field
            label={t('agent.aiPortraitLabel')}
            hint={editing ? t('agent.aiPortraitHintEdit') : t('agent.aiPortraitHintNew')}
          >
            <div className="flex items-center gap-4">
              {/* Avatar preview with breathing/sparkle animation while generating */}
              <div className="relative shrink-0" style={{ width: 88, height: 88 }}>
                {/* Soft outer glow that breathes */}
                {generatingAvatar && (
                  <div
                    className="absolute rounded-full pointer-events-none"
                    style={{
                      inset: -8,
                      background: 'conic-gradient(from 0deg, #FFB088, #7C5CFF, #4FC2F4, #6EC56A, #FFB088)',
                      filter: 'blur(8px)',
                      opacity: 0.55,
                      animation: 'ae-spin 3s linear infinite, ae-breathe 1.6s ease-in-out infinite',
                    }}
                  />
                )}
                {/* Avatar bubble */}
                <div
                  className="absolute inset-0 rounded-full grid place-items-center text-white font-bold text-[28px]"
                  style={{
                    background: avatarUrl ? 'transparent' : avatarBg,
                    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.05)',
                    transform: generatingAvatar ? undefined : 'scale(1)',
                    animation: generatingAvatar ? 'ae-pop 1.6s cubic-bezier(.36,1.6,.4,1) infinite' : undefined,
                  }}
                >
                  {avatarUrl
                    ? <img src={resolveAssetUrl(avatarUrl)} alt={name || initial} className="absolute inset-0 w-full h-full object-cover rounded-full" />
                    : initial}
                  {/* Diagonal shimmer sweep */}
                  {generatingAvatar && (
                    <div
                      className="absolute inset-0 rounded-full pointer-events-none overflow-hidden"
                    >
                      <div
                        className="absolute"
                        style={{
                          inset: '-50%',
                          background: 'linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.55) 50%, transparent 65%)',
                          animation: 'ae-sheen 2.2s cubic-bezier(.4,0,.2,1) infinite',
                        }}
                      />
                    </div>
                  )}
                </div>
                {/* Twinkling sparkles ✦ */}
                {generatingAvatar && (
                  <>
                    <span className="absolute text-whisper select-none pointer-events-none"
                      style={{ top: -2, right: 6, fontSize: 14, animation: 'ae-twinkle 1.4s ease-in-out infinite', animationDelay: '0s' }}>✦</span>
                    <span className="absolute text-skype-deep select-none pointer-events-none"
                      style={{ bottom: 4, left: -4, fontSize: 11, animation: 'ae-twinkle 1.4s ease-in-out infinite', animationDelay: '0.45s' }}>✦</span>
                    <span className="absolute text-gold select-none pointer-events-none"
                      style={{ top: '40%', left: -6, fontSize: 9, animation: 'ae-twinkle 1.4s ease-in-out infinite', animationDelay: '0.9s' }}>✦</span>
                  </>
                )}
              </div>

              <div className="flex-1 flex flex-col gap-2 min-w-0">
                <button
                  type="button"
                  onClick={generateAvatar}
                  disabled={!editing || generatingAvatar || !name.trim() || !systemPrompt.trim()}
                  className="self-start inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[10px] text-[12.5px] font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    // Hardcoded purple — this button intentionally keeps the
                    // old AI-portrait accent, decoupled from the whisper
                    // palette which has since moved to sage. Don't switch
                    // back to var(--whisper) here.
                    background: editing
                      ? 'linear-gradient(135deg, #7C5CFF, #4A2D9E)'
                      : 'var(--ink-100)',
                    color: editing ? 'white' : 'var(--ink-500)',
                    boxShadow: editing && !generatingAvatar ? '0 4px 12px -3px rgba(124, 92, 255, 0.45)' : 'none',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    style={generatingAvatar ? { animation: 'ae-icon-twinkle 1.2s ease-in-out infinite', transformOrigin: 'center' } : undefined}>
                    <path d="M12 2l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/><path d="M19 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>
                  </svg>
                  {generatingAvatar
                    ? <span>{t('agent.painting')}<span className="ae-dots" /></span>
                    : (avatarUrl ? t('agent.regenerate') : t('agent.generateAi'))}
                </button>

                {generatingAvatar && (
                  <div className="text-[11.5px] text-whisper-deep font-display italic leading-[1.5]">
                    {t('agent.composingPortrait', { name: name || t('agent.composingPortraitFallback') })}
                  </div>
                )}

                {avatarUrl && !generatingAvatar && (
                  <button
                    type="button"
                    onClick={() => setAvatarUrl(null)}
                    className="self-start text-[11.5px] text-ink-500 hover:text-coral-deep transition"
                  >{t('agent.clearPortrait')}</button>
                )}

                {avatarErr && (
                  <div className="text-[11.5px] text-coral-deep bg-coral-soft py-1.5 px-2 rounded-md leading-[1.4]">
                    {avatarErr}
                  </div>
                )}
              </div>
            </div>
          </Field>

        </fieldset>
        </div>

        {!contextChanged && <ResourceApplication agentId={savedAgentId ?? save.current?.agentId ?? agent?.id ?? null} refresh={resourceRefresh} saving={busy} />}
        {!canWrite && <div role="status" className="px-6 py-2 text-[12px]">{translate(locale, 'settings.readOnlyEditingAgentsAndBindingsRequiresCompanyOwner')}</div>}
        {(progress || err || contextChanged) && (
          <div className="px-6 py-3 text-[12px] border-t border-ink-100" aria-live="polite">
            {contextChanged ? <div role="alert">{copy.contextChanged}</div> : <>
              {progress && <>
                <div>{savedAgentId ? (translate(locale, 'settings.savedSeeRuntimeApplicationStatusAbove')) : copy.frozen}</div>
                {save.current?.agentId && !editing && <div>{copy.savedId}: {save.current.agentId}</div>}
                <ul>{(['profile', 'host', 'skills', 'mcp'] as const).map((stage) => (
                  <li key={stage}>{copy[stage]}: {copy[progress[stage]]}</li>
                ))}</ul>
              </>}
              {err && <div role="alert" className="text-coral-deep">{err}</div>}
            </>}
          </div>
        )}

        <div className="px-6 py-4 border-t border-ink-100 flex items-center gap-2 bg-paper shrink-0">
          <button
            type="button"
            onClick={close}
            className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-ink-700 bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}
          >{savedAgentId ? t('common.close') : t('agent.cancelBtn')}</button>
          <div className="flex-1" />
          {canWrite && !savedAgentId && <button
            type="button"
            onClick={submit}
            disabled={busy || generatingAvatar || contextChanged || !name.trim() || !systemPrompt.trim()}
            className="px-5 py-2 rounded-[9px] text-[12.5px] font-semibold text-white transition disabled:opacity-50"
            style={{
              background: 'var(--skype)',
              boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)',
            }}
          >
            {busy ? t('agent.saving') : progress ? copy.retry : (editing ? t('agent.saveChanges') : t('agent.createAgent'))}
          </button>}
        </div>
      </div>

      <style>{`
        /* === avatar generation animations === */
        @keyframes ae-spin   { to { transform: rotate(360deg); } }
        @keyframes ae-breathe {
          0%, 100% { opacity: 0.45; transform: scale(1); }
          50%      { opacity: 0.75; transform: scale(1.08); }
        }
        @keyframes ae-pop {
          0%, 100% { transform: scale(1); }
          40%      { transform: scale(1.04); }
          70%      { transform: scale(0.985); }
        }
        @keyframes ae-sheen {
          0%   { transform: translateX(-60%) translateY(-60%) rotate(0deg); }
          100% { transform: translateX(60%)  translateY(60%)  rotate(0deg); }
        }
        @keyframes ae-twinkle {
          0%, 100% { opacity: 0.2; transform: scale(0.7); }
          50%      { opacity: 1;   transform: scale(1.15); }
        }
        @keyframes ae-icon-twinkle {
          0%, 100% { opacity: 0.7; transform: scale(0.92); }
          50%      { opacity: 1;   transform: scale(1.08); }
        }
        @keyframes ae-dot {
          0%, 20%  { opacity: 0; }
          50%      { opacity: 1; }
          80%, 100%{ opacity: 0; }
        }
        .ae-dots::after {
          content: '...';
          letter-spacing: 2px;
          display: inline-block;
          margin-left: 2px;
          animation: ae-dot 1.4s steps(4, end) infinite;
        }
      `}</style>
    </div>
  )
}

interface ResourceApplicationState {
  saved: true
  version: string
  appliedVersion: string | null
  status: 'pending' | 'applied' | 'failed'
  error?: string
}

function ResourceApplication({ agentId, refresh, saving }: { agentId: string | null; refresh: number; saving: boolean }) {
  const zh = useLocaleStore((s) => s.locale === 'zh-CN')
  const epoch = useAuth((s) => s.contextEpoch)
  const [state, setState] = useState<ResourceApplicationState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    setState(null)
    setError(null)
    if (!agentId || saving) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      let delay = 30_000
      try {
        const r = await http<ResourceApplicationState>(`/agents/${encodeURIComponent(agentId)}/resources/status`, { signal: controller.signal })
        if (controller.signal.aborted || useAuth.getState().contextEpoch !== epoch) return
        if (r.saved !== true || typeof r.version !== 'string' || !['pending', 'applied', 'failed'].includes(r.status)
            || (r.status === 'applied' && r.appliedVersion !== r.version)) throw new Error(translate(zh ? 'zh-CN' : 'en', 'settings.invalidResourceStatusResponse'))
        setState(r)
        setError(null)
        if (r.status === 'applied') return
        delay = r.status === 'failed' ? 30_000 : 5_000
      } catch (e) {
        if (controller.signal.aborted || useAuth.getState().contextEpoch !== epoch) return
        setState(null)
        setError(e instanceof Error ? e.message : String(e))
      }
      if (!controller.signal.aborted && useAuth.getState().contextEpoch === epoch) timer = setTimeout(() => void load(), delay)
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [agentId, refresh, saving, reload, epoch, zh])
  if (!agentId) return null
  const label = state?.status === 'applied' ? (translate(zh ? 'zh-CN' : 'en', 'settings.applied'))
    : state?.status === 'failed' ? (translate(zh ? 'zh-CN' : 'en', 'settings.applicationFailed')) : (translate(zh ? 'zh-CN' : 'en', 'settings.pendingApplication'))
  // Keep every status/detail in its own intrinsic-height row, including when
  // the panel reaches its scroll limit. Do not compress rows to fit that limit.
  return <div
    className="px-6 py-3 border-t border-ink-100 text-[12px] shrink-0 min-w-0 max-h-[30vh] overflow-y-auto break-words"
    style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gridAutoRows: 'max-content', rowGap: 6, lineHeight: 1.625 }}
    aria-live="polite"
  >
    <div className="font-semibold">{translate(zh ? 'zh-CN' : 'en', 'settings.skillsMcpResourceApplication')}</div>
    {saving ? <div>{translate(zh ? 'zh-CN' : 'en', 'settings.savingApplicationStatusWillRefreshAfterSaving')}</div>
      : error ? <div role="alert" className="text-coral-deep">{translate(zh ? 'zh-CN' : 'en', 'settings.applicationStatusUnavailable')}{error}</div>
      : state ? <>
        <div>{translate(zh ? 'zh-CN' : 'en', 'settings.saved')}</div>
        <div>{label}</div>
        <div className="break-all text-[10.5px] text-ink-400">{translate(zh ? 'zh-CN' : 'en', 'settings.desiredVersion')}<span className="font-mono whitespace-nowrap" title={state.version}>{state.version.length > 8 ? state.version.slice(0, 8) + '…' : state.version}</span></div>
        {state.appliedVersion && <div className="break-all text-[10.5px] text-ink-400">{translate(zh ? 'zh-CN' : 'en', 'settings.appliedVersion')}<span className="font-mono whitespace-nowrap" title={state.appliedVersion}>{state.appliedVersion.length > 8 ? state.appliedVersion.slice(0, 8) + '…' : state.appliedVersion}</span></div>}
        {state.status === 'failed' && <div role="alert" className="text-coral-deep">{state.error ?? (translate(zh ? 'zh-CN' : 'en', 'settings.theRuntimeCouldNotApplyResources'))}</div>}
      </> : <div>{translate(zh ? 'zh-CN' : 'en', 'settings.loadingApplicationStatus')}</div>}
    <div className="text-ink-500">{translate(zh ? 'zh-CN' : 'en', 'settings.savedChangesApplyAtTheNextSafeTurnBoundary')}</div>
    <button type="button" disabled={saving} className="underline mt-1 justify-self-start text-left" onClick={() => setReload((n) => n + 1)}>{translate(zh ? 'zh-CN' : 'en', 'settings.refreshApplicationStatus')}</button>
  </div>
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-bold tracking-wider uppercase text-ink-500 mb-1">{label}</label>
      {hint && <div className="text-[11.5px] text-ink-300 mb-1.5 font-display italic">{hint}</div>}
      {children}
    </div>
  )
}
