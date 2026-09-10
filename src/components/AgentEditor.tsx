import { useEffect, useRef, useState } from 'react'
import { api, getPairingServerOrigin, resolveAssetUrl, type AgentInput } from '@/api/client'
import { FallbackChainEditor, CatalogStatus, EFFORT_OPTIONS, modelInteger } from '@/components/ModelFields'
import { useModelCatalog, catalogOptions, catalogSource } from '@/stores/modelCatalog'
import { Checkbox } from '@/components/Checkbox'
import { cn } from '@/lib/utils'
import type { AgentModelConfig } from '@/types'
import { isNativePlatform } from '@/lib/native'
import { useParticipants } from '@/stores/participants'
import { useComputers } from '@/stores/computers'
import { useConversations } from '@/stores/conversations'
import { useAuth } from '@/stores/auth'
import { Input } from '@/components/Input'
import { TextArea } from '@/components/TextArea'
import { Select } from '@/components/Select'
import { Combobox, type ComboboxOption } from '@/components/Combobox'
import type { Participant, EngineId } from '@/types'
import { useT, useLocaleStore } from '@/lib/i18n'
import { AgentEditorSave, bindingReplacement, type BindingStatus, type SaveStage, type StageStatus } from './agentEditorSave'
import { engineLabel } from '@/lib/engines'

const INHERIT_ENGINE = '__inherit__'

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
  /** Called after a successful save, once the modal is already closed. */
  onSaved?: () => void
}

export function AgentEditor({ agent, onClose, onSaved }: Props) {
  const t = useT()
  const editing = agent !== null
  const locale = useLocaleStore((s) => s.locale)
  const copy = locale === 'zh-CN' ? {
    loading: '正在加载绑定…', loadError: '读取失败；保存档案不会替换此区绑定。',
    retryLoad: '重新读取', empty: '暂无可用资源', dirty: '有未保存的绑定修改',
    unchanged: '绑定未修改', retry: '重试未完成阶段',
    frozen: '本次保存内容已锁定；重试会继续保存相同内容。已完成的阶段不会重复提交。',
    contextChanged: '公司或登录身份已变化，此编辑器已失效。请关闭后重新打开。',
    profile: '档案', host: '主机', skills: '技能', mcp: 'MCP',
    pending: '待保存', saving: '保存中', saved: '已保存', skipped: '无需写入', error: '失败，待重试',
    savedId: '已创建 Agent ID',
  } : {
    loading: 'Loading bindings…', loadError: 'Loading failed; saving the profile will preserve these bindings.',
    retryLoad: 'Reload', empty: 'No resources available', dirty: 'Unsaved binding changes',
    unchanged: 'Bindings unchanged', retry: 'Retry unfinished stages',
    frozen: 'This save is locked to its original content. Retry continues that content and skips completed stages.',
    contextChanged: 'The company or sign-in context changed. Close and reopen this editor.',
    profile: 'Profile', host: 'Host', skills: 'Skills', mcp: 'MCP',
    pending: 'Pending', saving: 'Saving', saved: 'Saved', skipped: 'No write needed', error: 'Failed; retry needed',
    savedId: 'Created Agent ID',
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
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // Skills: checkbox over the company library; edit mode loads the agent's
  // enablement, create mode saves after creation.
  const [skillChoices, setSkillChoices] = useState<Array<{ id: string; name: string; description: string }>>([])
  const [skillChecked, setSkillChecked] = useState<Set<string>>(new Set())
  const [connectorChoices, setConnectorChoices] = useState<Array<{ id: string; name: string; type: 'stdio' | 'http' }>>([])
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
      ? api.getAgentMcpConnectors(agent.id, controller.signal).then((r) => r.items.map((x) => ({ id: x.connector.id, name: x.connector.name, type: x.connector.type, enabled: x.enabled })))
      : api.getMcpConnectors(controller.signal).then((r) => r.items.filter((x) => x.enabled).map((x) => ({ id: x.id, name: x.name, type: x.type, enabled: false })))
    void load.then((items) => {
      if (controller.signal.aborted || !isCurrent()) return
      const initial = new Set(items.filter((x) => x.enabled).map((x) => x.id))
      setConnectorChoices(items.map(({ id, name, type }) => ({ id, name, type })))
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
  const modelOptions: Array<ComboboxOption<string>> = [
    {
      value: '',
      label: t('agent.followEngineDefault'),
      hint: modelCatalog?.defaultModel ?? undefined,
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
      hint: modelCatalog?.defaultFastModel ?? undefined,
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
  // Managed agents pick from the global models catalog (text bucket);
  // BYOA keeps using the host engine's reported catalog (modelOptions).
  const catalogState = useModelCatalog(!isByoa && !contextChanged)
  const catalogText = catalogOptions(catalogState.catalog, 'text')
  const effortOptions = EFFORT_OPTIONS

  const origin = getPairingServerOrigin()
  const repairCommand = repairCode
    ? `npx cumora@latest agent computer --pair ${repairCode}${origin ? ` --server ${origin}` : ''}`
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
    if (!selectedComputerOffline || !selectedComputer || !isCurrent() || save.current) return

    let cancelled = false
    void api.repairComputer(selectedComputer.id)
      .then((out) => { if (!cancelled) setRepairCode(out.code) })
      .catch((e) => {
        if (!cancelled) setRepairErr(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [selectedComputer?.id, selectedComputerOffline])
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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (submitting.current || generatingAvatar || !isCurrent()) return
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
          skills: bindingReplacement(skillStatus, skillInitial, skillChecked),
          mcp: bindingReplacement(connectorStatus, connectorInitial, connectorChecked),
        })
      }
      const attempt = save.current
      const completed = await attempt.run(api, isCurrent, () => {
        setProgress({ ...attempt.stages })
        if (attempt.stages.skills === 'saved') setSkillInitial(new Set(attempt.snapshot.skills!))
        if (attempt.stages.mcp === 'saved') setConnectorInitial(new Set(attempt.snapshot.mcp!))
      }, requests.current.signal)
      if (!completed || !isCurrent()) return
      save.current = null
      onClose()
      if (onSaved) {
        onSaved()
      } else {
        void useParticipants.getState().refresh()
        void useConversations.getState().reload()
      }
    } catch (e) {
      if (isCurrent()) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      submitting.current = false
      if (isCurrent()) setBusy(false)
    }
  }

  const initial = (name || agent?.id || '?').charAt(0).toUpperCase()

  const generateAvatar = async () => {
    if (!editing || !agent || !isCurrent() || submitting.current || save.current || generatingAvatar) return
    setAvatarErr(null)
    setGeneratingAvatar(true)
    try {
      // First save any pending edits so the prompt reflects what the user typed.
      await api.updateAgent(agent.id, { name, role, systemPrompt, bio, avatarBg })
      if (!isCurrent()) return
      const r = await api.generateAgentAvatar(agent.id)
      if (!isCurrent()) return
      setAvatarUrl(r.url)
      await useParticipants.getState().refresh()
    } catch (e) {
      if (isCurrent()) setAvatarErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (isCurrent()) setGeneratingAvatar(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
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
            onClick={onClose}
            className="w-8 h-8 rounded-full grid place-items-center text-ink-500 hover:bg-sky2-50 hover:text-ink-900 transition"
            aria-label={t('common.close')}
          >×</button>
        </div>

        <fieldset disabled={busy || !!progress || contextChanged || generatingAvatar} className="px-6 py-5 space-y-4 overflow-y-auto flex-1 min-h-0">
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
                options={[
                  { value: '', label: t('agent.followGlobalDefault') },
                  ...[...new Set([...catalogText, model, ...(agent?.modelConfig?.fallbackModels ?? [])].filter(Boolean))].map((m) => ({ value: m, label: m, hint: catalogSource(catalogState.catalog, m) })),
                ]}
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

          <div className="rounded-[10px] border border-ink-100 bg-paper/60">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left"
              aria-expanded={advancedOpen}
            >
              <span className={cn('text-[10px] text-ink-400 transition-transform inline-block', advancedOpen && 'rotate-90')}>▶</span>
              <span className="text-[12.5px] font-semibold text-ink-700">{t('agent.advancedModelSettings')}</span>
              {isByoa && (
                <span className="ml-auto text-[10.5px] text-ink-400 italic">{t('agent.engineManagedTag')}</span>
              )}
            </button>
            {advancedOpen && (
              <div className="px-3.5 pb-3.5 pt-1 space-y-3 border-t border-ink-100">
                {isByoa ? (
                  <div className="text-[11.5px] text-ink-500 italic">{t('agent.engineManagedNote')}</div>
                ) : (
                  <>
                    <div className="grid grid-cols-[96px_1fr] items-center gap-x-3 gap-y-2.5">
                      <label className="text-[11.5px] font-semibold text-ink-500">{t('agent.mcEffort')}</label>
                      <select
                        value={mcEffort}
                        onChange={(e) => setMcEffort(e.target.value)}
                        className="h-8 px-2 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30"
                        style={{ border: '1px solid var(--ink-100)' }}
                      >
                        <option value="">{t('agent.mcFollowGlobal')}</option>
                        {mcEffort && !effortOptions.includes(mcEffort) && <option value={mcEffort} disabled>{mcEffort} — {locale === 'zh-CN' ? '不支持，请重新选择' : 'Unsupported; choose another value'}</option>}
                        {effortOptions.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                      <label className="text-[11.5px] font-semibold text-ink-500">{t('agent.mcContextWindow')}</label>
                      <input
                        type="text" inputMode="numeric"
                        value={mcContextWindow}
                        onChange={(e) => setMcContextWindow(e.target.value)}
                        placeholder={t('agent.mcContextWindowPh')}
                        className="h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
                        style={{ border: '1px solid var(--ink-100)' }}
                      />
                      <label className="text-[11.5px] font-semibold text-ink-500">{t('agent.mcMaxTokens')}</label>
                      <input
                        type="text" inputMode="numeric"
                        value={mcMaxTokens}
                        onChange={(e) => setMcMaxTokens(e.target.value)}
                        placeholder={t('agent.mcMaxTokensPh')}
                        className="h-8 px-2.5 rounded-[8px] text-[12.5px] text-ink-900 bg-paper outline-none focus:ring-2 focus:ring-skype/30 font-mono"
                        style={{ border: '1px solid var(--ink-100)' }}
                      />
                      <label className="text-[11.5px] font-semibold text-ink-500">{t('agent.mcThinking')}</label>
                      <select value={mcThinking === undefined ? '' : String(mcThinking)}
                        onChange={(e) => setMcThinking(e.target.value === '' ? undefined : e.target.value === 'true')}
                        className="h-8 px-2 rounded-[8px] text-[12.5px] bg-paper">
                        <option value="">{t('agent.mcFollowGlobal')}</option>
                        <option value="true">{locale === 'zh-CN' ? '启用（仍受模型配置约束）' : 'Enabled (subject to model configuration)'}</option>
                        <option value="false">{locale === 'zh-CN' ? '关闭' : 'Disabled'}</option>
                      </select>
                    </div>
                    <div>
                      <div className="text-[11.5px] font-semibold text-ink-500 mb-1.5">{t('agent.mcFallbacks')}</div>
                      <div className="text-[10.5px] text-ink-400 mb-1.5 italic">{t('agent.mcFallbacksHint')}</div>
                      <FallbackChainEditor
                        value={mcFallbacks}
                        onChange={setMcFallbacks}
                        options={catalogText}
                        primary={model}
                        history={agent?.modelConfig?.fallbackModels}
                        catalog={catalogState.catalog}
                        listId="agent-mc-fallbacks"
                        t={t}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

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
                  checked={skillChecked.has(sk.id)}
                  onCheckedChange={(next) => {
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
              {isByoa ? t('agent.connectorsByoaNote') : t('agent.connectorsManagedNote')}
            </div>
            <div className="space-y-1">
              {connectorStatus === 'ready' && connectorChoices.map((c) => (
                <Checkbox
                  key={c.id}
                  checked={connectorChecked.has(c.id)}
                  onCheckedChange={(next) => {
                    setConnectorChecked((prev) => {
                      const copy = new Set(prev)
                      if (next) copy.add(c.id)
                      else copy.delete(c.id)
                      return copy
                    })
                  }}
                  label={c.name}
                  description={c.type}
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
            {selectedComputerOffline && (
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
                  disabled={!editing || generatingAvatar}
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

        {(progress || err || contextChanged) && (
          <div className="px-6 py-3 text-[12px] border-t border-ink-100" aria-live="polite">
            {contextChanged ? <div role="alert">{copy.contextChanged}</div> : <>
              {progress && <>
                <div>{copy.frozen}</div>
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
            onClick={onClose}
            className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-ink-700 bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}
          >{t('agent.cancelBtn')}</button>
          <div className="flex-1" />
          <button
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
          </button>
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-bold tracking-wider uppercase text-ink-500 mb-1">{label}</label>
      {hint && <div className="text-[11.5px] text-ink-300 mb-1.5 font-display italic">{hint}</div>}
      {children}
    </div>
  )
}
