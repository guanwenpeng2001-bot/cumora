import { getActiveCompanyId, getAuthToken, useAuth } from '@/stores/auth'
import { isApiAbortError } from '@/lib/apiErrors'
import type { AgentModelConfig } from '@/types'
import type {
  BoardCardComment, BoardCardLookup, BoardSnapshot, BoardSummary,
  CalendarDispatch, CalendarEvent, CalendarEventKind, CalendarEventStatus,
  CalendarReminderChannel, ComputerKind, ComputerStatus, DetectedEngine,
  EngineDefaultsMap, EngineId, Message, RecurrenceRule, Status,
} from '@/types'

export { API_MODEL_PLATFORM_LABELS, modelPlatformLabel } from '@/lib/modelPlatforms'

const DEVTOOLS_KEY = 'cumora.devtools.enabled'
const SERVER_URL_KEY = 'cumora.serverUrl'

// Vite's relative proxy keeps browser requests same-origin, but the pairing
// command runs outside the browser and must address the API directly.
const DEV_API_TARGET = import.meta.env.DEV
  ? (import.meta.env.VITE_CUMORA_DEV_API_TARGET as string | undefined)?.replace(/\/+$/, '')
  : undefined

/** Resolve the API base. Three layers, highest priority first:
 *    1. localStorage['cumora.serverUrl'] — runtime override, settable
 *       from the dev console: `localStorage.setItem('cumora.serverUrl',
 *       'https://api.cumora.ai')`. Lets a packaged build switch between
 *       prod and a custom endpoint without rebuilding.
 *    2. import.meta.env.VITE_CUMORA_API_BASE — baked at build time,
 *       e.g. .env.production points it at https://api.cumora.ai.
 *    3. '' — falls back to relative URLs, which work in Vite dev (the
 *       proxy rewrites /api → CUMORA_DEV_API_TARGET) and in any same-
 *       origin static deploy.
 *  Values should be the origin only, with NO trailing slash and NO
 *  `/api` suffix — the suffix is added on use, so `http(...)` and the
 *  WS / ws-ticket paths stay consistent. */
function resolveServerOrigin(): string {
  if (typeof localStorage !== 'undefined') {
    const override = localStorage.getItem(SERVER_URL_KEY)
    if (override) return override.replace(/\/+$/, '')
  }
  const baked = import.meta.env.VITE_CUMORA_API_BASE as string | undefined
  if (baked) return baked.replace(/\/+$/, '')
  return ''
}

const SERVER_ORIGIN = resolveServerOrigin()
const API = `${SERVER_ORIGIN}/api`

/** Public getter for UI surfaces (AuthScreen, Settings). Returns the
 *  origin actually in use this session — same value `http()` and the WS
 *  client are built against. Empty string means "relative URLs, going
 *  through the Vite proxy or same-origin." */
export function getServerOrigin(): string {
  return SERVER_ORIGIN
}

/** Resolve a server-provided asset URL for the current runtime.
 *  Server payloads (`avatar_url`, attachment `url`, …) are relative paths
 *  like `/uploads/...`. In the browser they resolve against the page origin
 *  and just work; in the packaged Electron app the page origin is
 *  `app://cumora`, so relative paths 404 there — prefix the API origin
 *  instead. When getServerOrigin() is '' (Vite dev / same-origin deploys)
 *  the path is returned unchanged, preserving relative-URL behavior.
 *  Absolute URLs (http:, data:, blob:) pass through untouched. */
export function resolveAssetUrl(url: string | null | undefined): string {
  if (!url) return ''
  const origin = resolveServerOrigin()
  if (url.startsWith('//')) {
    const protocol = /^https?:/i.exec(origin)?.[0]
      ?? (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.protocol : 'https:')
    return `${protocol}${url}`
  }
  if (!url.startsWith('/')) return url
  return `${origin}${url}`
}

/** Origin to embed in a local computer pairing command.
 * In Vite dev the browser uses a relative proxy, so SERVER_ORIGIN is empty;
 * the daemon still needs the API target rather than the renderer origin. */
export function getPairingServerOrigin(): string {
  return SERVER_ORIGIN || DEV_API_TARGET || (typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.origin : '')
}

/** Loopback addresses reach only the machine running the pairing command. */
export function isPairingServerLoopback(origin = getPairingServerOrigin()): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase()
    return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host)
  } catch { return false }
}

/** Persist a new server origin override and clear the existing session.
 *  We don't try to hot-swap the in-memory API/WS — anything pending against
 *  the old origin would race or fail in confusing ways. Callers should
 *  follow up with `location.reload()` so the whole app boots fresh against
 *  the new origin. Pass `null` to drop the override entirely (revert to
 *  build-time default). */
export function setServerOrigin(origin: string | null): void {
  if (origin == null || origin.trim() === '') {
    localStorage.removeItem(SERVER_URL_KEY)
  } else {
    localStorage.setItem(SERVER_URL_KEY, origin.trim().replace(/\/+$/, ''))
  }
  // Auth token is server-scoped — DELETE here so a reload lands on AuthScreen
  // instead of probing /auth/me against the new origin with a stale token.
  useAuth.getState().clear()
}

/** WS origin (ws:// or wss://) derived from the resolved server origin.
 *  When SERVER_ORIGIN is empty (Vite dev, same-origin static deploy),
 *  fall back to the page's location so the existing relative path
 *  (`/ws`) still works through the proxy. */
function wsOrigin(): string {
  if (SERVER_ORIGIN) return SERVER_ORIGIN.replace(/^http/, 'ws')
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
}

export function getDevModeEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(DEVTOOLS_KEY) === '1'
}

export function setDevModeEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  if (enabled) localStorage.setItem(DEVTOOLS_KEY, '1')
  else localStorage.removeItem(DEVTOOLS_KEY)
}

export class ApiError extends Error {
  readonly code?: string
  constructor(message: string, readonly status: number, readonly payload?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.code = typeof payload?.error === 'string' ? payload.error : undefined
  }
}

export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const { token, activeCompanyId: company, contextEpoch } = useAuth.getState()
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (company) headers.set('x-company-id', company)
  if (getDevModeEnabled()) headers.set('x-cumora-dev-mode', '1')
  new Headers(init?.headers).forEach((value, key) => { headers.set(key, value) })
  const signal = init?.signal
  try {
    signal?.throwIfAborted()
    const res = await fetch(`${API}${path}`, { ...init, headers })
    signal?.throwIfAborted()
    if (!res.ok) {
      let detail: string | null = null
      let payload: Record<string, unknown> | undefined
      try {
        const text = await res.text()
        if (text) {
          try {
            const j = JSON.parse(text) as { error?: string; message?: string }
            if (j && typeof j === 'object' && !Array.isArray(j)) payload = j
            detail = typeof j?.error === 'string' ? j.error : typeof j?.message === 'string' ? j.message : text.slice(0, 200)
          } catch { detail = text.slice(0, 200) }
        }
      } catch (error) {
        if (isApiAbortError(error, signal)) throw error
      }
      signal?.throwIfAborted()
      // A late response may only expire the context whose credentials it carried.
      if (res.status === 401 && !path.startsWith('/auth/')
        && token && headers.get('authorization') === `Bearer ${token}`
        && useAuth.getState().contextEpoch === contextEpoch
        && useAuth.getState().token === token) {
        useAuth.getState().clear()
      }
      throw new ApiError(detail ? `${detail} (${res.status})` : `${res.status} ${res.statusText}`, res.status, payload)
    }
    const value = await res.json() as T
    signal?.throwIfAborted()
    return value
  } catch (error) {
    if (isApiAbortError(error, signal)) {
      throw new DOMException('The request was aborted.', 'AbortError')
    }
    throw error
  }
}

export interface ApiMessage extends Message {
  sequence: number
  createdAt?: string
  reactions?: Array<{ emoji: string; count: number; mine?: boolean; users?: string[] }>
}

export interface ApiConversation {
  id: string
  kind: 'group' | 'direct' | 'whisper' | 'email'
  title: string
  subtitle: string | null
  topic: string | null
  members: string[]
  pinned: boolean
  muted: boolean
  /** ISO timestamp when the mute auto-expires; null if muted forever or not muted. */
  mutedUntil: string | null
  tag: string | null
  pulledBy: { agentId: string; at: string; reason: string } | null
  projectId: string | null
  projectName: string | null
  projectColor: string | null
  createdAt: string
  updatedAt: string
  unreadCount: number
  lastMessage: {
    sequence?: number
    id: string
    authorId: string
    kind: string
    body: string
    tool?: unknown
    attachment?: { name?: string; kind?: 'img' | 'pdf' | 'file' | 'fig' } | null
    createdAt: string
    /** Set when last message is an email — used to render "Re: subject"
     *  previews in the sidebar instead of the raw body excerpt. */
    email?: { subject: string; direction: 'in' | 'out'; from: string } | null
  } | null
}

/** Legacy capability buckets remain available alongside optional discovery metadata.
 *  An empty gateway catalog does not establish which route a request will use. */
export interface ApiModelCatalog {
  text: string[]
  image: string[]
  audio: string[]
  embedding: string[]
  gateway: boolean
  models?: ApiCatalogModel[]
  /** Server returns a Record keyed by platform; older payloads used an array. */
  platforms?: Record<string, ApiCatalogPlatformEntry> | ApiCatalogPlatformStatus[]
  fetchedAt?: string
}

export type ApiModelRole = 'brain' | 'support' | 'compaction' | 'image' | 'audio' | 'embed'
export type ApiModelPlatform = string

export interface ApiCatalogModel {
  id: string
  source?: 'managed' | 'byoa' | 'configured'
  platform?: ApiModelPlatform
  roles?: ApiModelRole[]
  computerId?: string
  engine?: EngineId
  selectable?: boolean
}

export interface ApiCatalogPlatformEntry {
  status?: string
  stale?: boolean
  models?: string[]
  diagnostic?: string
  errorCode?: string | null
  fetchedAt?: string | null
}

export interface ApiCatalogPlatformStatus extends ApiCatalogPlatformEntry {
  platform: ApiModelPlatform
}

export interface ApiSettingMetadata {
  type?: 'string' | 'number' | 'boolean' | 'list'
  source?: 'db' | 'env' | 'default' | 'inherited'
  scope?: 'global' | 'company' | 'agent'
  allowedValues?: string[]
  sensitive?: boolean
  readOnly?: boolean
  applyMode?: 'immediate' | 'next_turn' | 'next_create' | 'restart'
}

export interface ApiSettingDefinition {
  key: string
  type: 'model' | 'list' | 'string' | 'integer' | 'reasoning' | 'json' | 'boolean' | 'number'
  scope?: 'managed' | 'server' | 'byoa'
  effect?: 'immediate' | 'next-turn' | 'next-gate' | 'next-tick' | 'next-admission' | 'next-create' | 'restart' | 'restart-next-create' | 'fixed' | 'pending-T41'
  allowedValues?: readonly string[]
  defaultValue?: string
  min?: number
  max?: number
  unit?: string
  description?: string
  required?: boolean
  readOnly?: boolean
  envOnly?: boolean
  sensitive?: boolean
}

export interface ApiModelRoutePreview {
  domain: 'managed' | 'server' | 'byoa'
  role: ApiModelRole
  purpose: string
  revision: string
  routable: boolean
  provisionable: boolean
  candidates: Array<{
    model: string
    requestModel: string
    protocol: string
    available: boolean
    source: string
    route: { id: string; kind: 'gateway' | 'direct'; platform?: ApiModelPlatform; env?: string; endpointSource: string; credentialSource: string }
    diagnostic?: string
  }>
  diagnostics: string[]
}

export interface ApiModelGroup { id: number; name: string; platform: ApiModelPlatform }
export interface ApiByoaPolicyState {
  desired: string
  received: string | null
  applied: string | null
  status: 'unknown' | 'unsupported' | 'pending' | 'received' | 'applied'
  reportedAt: string | null
  policyHeartbeatMs: number
  resourceSyncMs: number
}

export interface ApiModelSettings {
  settings: Record<string, string>
  revision?: string
  definitions?: readonly ApiSettingDefinition[]
  sources?: Record<string, 'db' | 'env' | 'default'>
  diagnostics?: readonly string[]
  metadata?: Record<string, ApiSettingMetadata>
}

export interface ApiSettingsWriteResult extends Partial<ApiModelSettings> {
  ok: boolean
}

export interface ApiSyncStatus {
  status?: 'saved' | 'pending' | 'applied' | 'failed'
  desiredRevision?: number
  appliedRevision?: number
  updatedAt?: string | null
  errorCode?: string | null
}

export interface ApiBindingWriteResult {
  ok: boolean
  sync?: ApiSyncStatus
}

export interface ApiUsageMetadata {
  timezone: 'UTC'
  aggregatedAt: string | null
  completedThrough: string | null
  aggregationStatus: 'pending' | 'ready' | 'failed' | 'paused' | 'stale'
  rawRetentionFrom: string | null
  earliestRawAt: string | null
  logsComplete: boolean
  boundaryComplete: boolean
  aggregationVersion: 2
  legacyBefore: string | null
}

/** Usage dashboard rows (GET /api/usage/*). */
export interface ApiUsageSummary {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUsd: number
  costEstimated: boolean
  cacheHitRate: number
  successRate: number
  unknownRequests?: number
  unpricedRequests?: number
  qualityUnknownRequests?: number
  sources?: string[]
  metadata?: ApiUsageMetadata
}
export interface ApiUsageTrendPoint {
  bucket: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}
export interface ApiUsageAgentRow {
  agentId: string
  name: string
  avatarUrl: string | null
  source: 'managed' | 'byoa'
  actualSource?: string
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  successRate: number
}
export interface ApiUsageModelRow {
  model: string
  provider: string
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  costEstimated: boolean
  route?: string | null
  platform?: string | null
  source?: string
  unknownRequests?: number
  unpricedRequests?: number
  qualityUnknownRequests?: number
}
export interface ApiUsageProviderRow {
  provider: string
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}
export interface ApiUsageLogRow {
  id: string
  createdAt: string
  agentId: string | null
  agentName: string | null
  model: string
  provider: string
  purpose: string
  source: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number | null
  status: string
  measured?: boolean
  costEstimated?: boolean
  unpriced?: boolean
  route?: string | null
  platform?: string | null
  requestedModel?: string
  actualModel?: string | null
  failureReason?: string | null
  failureStage?: string | null
  httpStatus?: number | null
  callId?: string | null
  attempt?: number | null
}
export interface ApiUsageLogPage {
  accessibleTotal?: number
  maxPage?: number
  truncated?: boolean
  items: ApiUsageLogRow[]
  total: number
  page: number
  pageSize: number
  metadata?: ApiUsageMetadata
}

/** Company skill library row. */
/** MCP connector registry row. */
export interface ApiMcpConnector {
  id: string
  companyId: string
  name: string
  type: 'stdio' | 'http'
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  headers: Record<string, string>
  enabled: boolean
  createdAt: string
}
export interface ApiAgentConnectorState {
  connector: ApiMcpConnector
  enabled: boolean
  sync?: ApiSyncStatus
}

export interface ApiSkill {
  id: string
  companyId: string
  name: string
  description: string
  source: 'skillhub' | 'local' | 'paste'
  hubId: string | null
  files: Array<{ path: string; body: string }>
  createdAt: string
}
export interface ApiLocalHubEntry {
  name: string
  description: string
  imported: boolean
}
export interface ApiAgentSkillState {
  skill: ApiSkill
  enabled: boolean
  sync?: ApiSyncStatus
}

export interface ApiQuotaWindow {
  usedUsd: number
  limitUsd: number | null
  windowStart: string | null
}

export interface ApiQuotaSnapshot {
  groupId: number
  groupName: string | null
  status: string
  expiresAt: string | null
  daily: ApiQuotaWindow
  weekly: ApiQuotaWindow
  monthly: ApiQuotaWindow
}

export interface ApiQuotaResponse {
  configured: boolean
  snapshot: ApiQuotaSnapshot | null
  error?: string
}

export interface ApiProject {
  id: string
  name: string
  description: string
  color: string | null
  status: 'active' | 'archived'
  createdAt: string
  archivedAt: string | null
  conversationCount: number
}

export interface ApiParticipant {
  id: string
  kind: 'agent' | 'human'
  name: string
  role: string | null
  initial: string
  avatarBg: string
  avatarUrl?: string | null
  status: Status
  statusUpdatedAt?: string | null
  bio: string | null
  tools: string[] | null
  systemPrompt?: string | null
  model?: string | null
  email?: string | null
  departedAt?: string | null
  computerId?: string | null
  engine?: string | null
  engineInherit?: boolean | null
  providerProfile?: string | null
  fastModel?: string | null
  modelConfig?: AgentModelConfig | null
}

/** A Computer (agent host) as returned by GET /api/computers. */
export interface ApiComputer {
  id: string
  company_id: string
  owner_user_id: string | null
  name: string
  kind: ComputerKind
  available_engines: EngineId[]
  detected_engines?: DetectedEngine[]
  engines_detected_at?: string | null
  status: ComputerStatus
  last_seen_at: string | null
  paired_at: string | null
  /** Daemon version this computer is running (null for cloud / a pre-version daemon). */
  daemon_version?: string | null
  /** True = daemon runs under the --install-service supervisor; false = a
   *  manually-run foreground command; null = cloud / an old daemon that
   *  doesn't report it. Drives run-mode-specific update instructions. */
  daemon_supervised?: boolean | null
  /** Newest published cumora daemon version, for the upgrade banner. */
  latest_daemon_version?: string | null
  /** Direct tgz download URL of the newest fork agent-cli release. */
  latest_daemon_download_url?: string | null
  /** True when this BYOA daemon is behind the latest version → show upgrade banner. */
  daemon_outdated?: boolean
  runtimePolicy?: ApiByoaPolicyState
  /** Per-engine default model settings. */
  engine_defaults?: EngineDefaultsMap
}

/** Universal-search response. The backend ranks results inside each bucket;
 *  the frontend renders them in this declared order (participants → rooms →
 *  groups → messages), matching the product priority. */
export interface ApiSearchResults {
  participants: Array<{
    id: string
    kind: 'agent' | 'human'
    name: string
    role: string | null
    initial: string
    avatarBg: string
    avatarUrl: string | null
    status: Status
    bio: string | null
  }>
  rooms: Array<{
    id: string
    kind: 'direct' | 'whisper'
    title: string
    members: string[]
    projectName: string | null
  }>
  groups: Array<{
    id: string
    kind: 'group'
    title: string
    members: string[]
    projectName: string | null
  }>
  messages: Array<{
    id: string
    conversationId: string
    conversationTitle: string
    conversationKind: 'group' | 'direct' | 'whisper'
    authorId: string
    authorName: string | null
    snippet: string
    createdAt: string
  }>
}

export interface AgentInput {
  id?: string
  name?: string
  role?: string
  systemPrompt?: string
  bio?: string
  initial?: string
  avatarBg?: string
  /** pass null to clear the AI portrait and fall back to the color block */
  avatarUrl?: string | null
  /** per-agent big-brain model override; null clears it (use system default) */
  model?: string | null
  /** per-agent small-brain (fast) model override; null clears it */
  fastModel?: string | null
  /** advanced model settings; null clears (managed agents only) */
  modelConfig?: AgentModelConfig | null
  tools?: string[]
}

export interface AgentCreateInput extends AgentInput {
  name: string
  systemPrompt: string
  providerProfile?: string | null
  /** Stable for the lifetime of one create form so ambiguous retries replay. */
  requestId: string
  /** Initial host placement is committed atomically with the Agent row. */
  computerId?: string
  engine?: EngineId
  inherit?: boolean
}

export interface ApiAttachment {
  url: string
  name: string
  kind: 'img' | 'pdf' | 'file' | 'fig'
  mime?: string
  size?: number
  /** Object-storage key, present when the file lives in R2. */
  key?: string
}

export interface UploadCapabilities {
  mode: 'local' | 'r2'
  presignSupported: boolean
  maxBytes: number
  allowedMimes: string[]
}

interface PresignResponse {
  uploadUrl: string
  publicUrl: string
  key: string
  name: string
  mime: string
  size: number
  kind: 'img' | 'file'
}

/** A peek-view entry — either a 1-on-1 direct chat or a multi-agent
 *  group, where every member is an agent. "Whisper" is the frontend tab
 *  name; on the server these are just regular conversations the user
 *  isn't a member of (so they don't show up in /conversations, but the
 *  peek tab lets the user eavesdrop). */
export interface ApiWhisper {
  id: string
  kind: 'direct' | 'group'
  title: string
  members: string[]
  /** Convenience accessors for the 1-on-1 case — null for groups. */
  agentA: string | null
  agentB: string | null
  about: string | null
  createdAt: string
  updatedAt: string
  msgCount: number
}

export interface ApiWhisperMessage {
  id: string
  conversationId: string
  authorId: string
  kind: string
  body: string
  sequence: number
  tool?: { name: string; arg: string; status: string; detail: string; icon?: string } | null
  createdAt: string
}

export interface ApiAutonomy {
  userId: string
  agentId: string
  threshold: number
  pulled: number
  led: number
  dissolved: number
}

export type ApiAgentRunStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'stalled'
export type ApiAgentEventLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ApiAgentRun {
  id: string
  agentId: string
  agentName: string
  agentRole: string | null
  agentAvatarUrl: string | null
  companyId: string
  status: ApiAgentRunStatus
  stage: string | null
  summary: string | null
  error: string | null
  trigger: Record<string, unknown>
  inputMessageIds: string[]
  inboxCount: number
  toolCallCount: number
  tokenCount: number
  fingerprint: string | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  durationMs: number
}

// ── Triage cost-effectiveness ledger ──
export type ApiTriageSource = 'cloud' | 'byoa-claude' | 'byoa-codex' | 'byoa-kimi' | 'byoa-grok' | 'byoa-cursor' | 'byoa-opencode' | 'byoa-pi' | 'byoa-gemini' | 'byoa-qwen' | 'byoa-antigravity' | 'byoa-zcode'

export interface ApiTriageAgentRow {
  agentId: string
  agentName: string
  triageCount: number
  skipCount: number
  wakeCount: number
  triageCostUsd: number
  triageOverheadUsd: number
  turnCount: number
  avgTurnCostUsd: number
  turnCacheHitRate: number
  estimatedNetSavingsUsd: number
}

export interface ApiTriageLedgerRow {
  id: string
  agentId: string
  agentName: string
  source: ApiTriageSource
  model: string | null
  actionable: boolean
  reason: string | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  costUsd: number
  costEstimated: boolean
  measured: boolean
  estSavingUsd: number | null
  createdAt: string
}

export interface ApiTriageUnitPrice {
  role: 'triage' | 'turn'
  model: string
  inPer1M: number
  cachedInPer1M: number
  outPer1M: number
  estimated: boolean
}

export interface ApiTriagePriceRow {
  model: string
  inPer1M: number
  cachedInPer1M: number
  cacheWritePer1M: number
  outPer1M: number
  estimated: boolean
}

/** One row of `GET /agents/observability/wakes`. Group and direct are kept
 *  apart deliberately: a DM legitimately answers far more often, so averaging
 *  the two hides the number that matters. */
export interface ApiSilentWakeBucket {
  conversationKind: string
  runs: number
  silentRuns: number
  silentRate: number
  silentSpendUsd: number
}

export interface ApiTurnsPerMessageBucket {
  conversationKind: string
  messages: number
  turns: number
  avgTurns: number
  medianTurns: number
  hist: { turns: string; messages: number }[]
}

export interface ApiWakeEconomics {
  sinceHours: number
  buckets: ApiSilentWakeBucket[]
  /** The RATIOS are measured either way; only the dollar column is modelled. */
  costEstimated: boolean
  /** Fan-out width per human message. Room-wide: not scoped by the agentId
   *  filter, because width is a property of the room, not of one agent. */
  turnsPerMessage: ApiTurnsPerMessageBucket[]
}

export interface ApiTriageEconomics {
  sinceHours: number
  triageCount: number
  triageSkipCount: number
  triageWakeCount: number
  triageMeasuredCount: number
  triageCostUsd: number
  triageOverheadUsd: number
  triageInputTokens: number
  triageCachedInputTokens: number
  triageOutputTokens: number
  turnCount: number
  turnCostUsd: number
  avgTurnCostUsd: number
  turnCacheHitRate: number
  estimatedAvoidedUsd: number
  estimatedNetSavingsUsd: number
  costEstimated: boolean
  byoaShare: number
  unitPrices: ApiTriageUnitPrice[]
  priceTable: ApiTriagePriceRow[]
  perAgent: ApiTriageAgentRow[]
  recent: ApiTriageLedgerRow[]
}

export interface ApiAgentEvent {
  id: string
  runId: string
  agentId: string
  kind: string
  level: ApiAgentEventLevel
  title: string
  data: Record<string, unknown>
  createdAt: string
}

export interface ApiConveneSession {
  id: string
  conversation_id: string
  title: string
  flair: string | null
  started_by: string
  started_at: string
  ended_at: string | null
  state: 'live' | 'ended'
}

export interface ApiConveneTranscript {
  id: string
  sessionId: string
  authorId: string
  kind: 'text' | 'thought' | 'tool' | 'decision'
  body: string
  sequence: number
  decision: { headline: string; body: string } | null
  createdAt: string
}

export interface ApiDevtoolsCapabilities {
  enabled: boolean
  canEnable: boolean
  localDev: boolean
  productionDevMode: boolean
  role: string
}

export interface ApiAgentWorkspaceFile {
  path: string
  size: number
  lineCount: number
  updatedAt: string
}

export interface ApiAgentWorkspaceFileContent extends ApiAgentWorkspaceFile {
  body: string
}

interface MeResponse {
  user: { id: string; email: string; name: string; emailVerified: boolean; providers: string[]; isAdmin?: boolean }
  companies: Array<{ id: string; name: string; slug: string; role: string; tier?: string }>
  activeCompanyId: string | null
  serverCapabilities: ServerCapabilities
}

export interface ServerCapabilities {
  /** Whether the server can send outbound invitation / welcome emails.
   *  Driven by EMAIL_DOMAIN being set on the server. The invite modal
   *  hides the "Email this invite" checkbox when false. */
  invitationEmail: boolean
}

export type ApiInvitationStatus = 'active' | 'revoked' | 'expired' | 'consumed'

export interface ApiInvitation {
  /** Stable identifier (= server-side token_hash). Used by the revoke
   *  endpoint. The raw token itself is ONLY returned on create — never
   *  re-exposed. */
  id: string
  email: string | null
  role: 'member' | 'admin'
  note: string | null
  maxUses: number
  useCount: number
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  lastAcceptedAt: string | null
  lastAcceptedBy: string | null
  invitedBy: string
  inviterName: string | null
  status: ApiInvitationStatus
}

/** Returned exactly ONCE from the create endpoint. Embeds the freshly-minted
 *  raw token + the public accept URL — the server keeps only the hash, so
 *  the UI must surface this immediately for the user to copy / send. */
export interface ApiInvitationWithToken {
  id: string
  token: string
  url: string
  email: string | null
  role: 'member' | 'admin'
  note: string | null
  maxUses: number
  useCount: number
  createdAt: string
  expiresAt: string
  status: 'active'
  /** Present when the inviter asked the server to send the invite email
   *  on their behalf (`sendEmail: true` in the create payload). Null when
   *  they did not. The UI uses this to render "email sent" /
   *  "email failed: <reason>" feedback alongside the copy-link card. */
  emailDelivery: ApiInvitationEmailDelivery | null
}

export interface ApiInvitationEmailDelivery {
  attempted: boolean
  ok: boolean
  error: string | null
  /** Set when the server deliberately didn't try — today only
   *  'no_email_config' (EMAIL_DOMAIN unset). Distinct from `error` so
   *  the UI can show a different message. */
  skipped: 'no_email_config' | null
}

export type WorkspaceRole = 'owner' | 'admin' | 'member'

export interface ApiWorkspaceMember {
  id: string
  name: string
  email: string
  avatarUrl: string | null
  role: WorkspaceRole
  joinedAt: string
}

export type ApiInvitationPreviewStatus =
  | 'valid' | 'revoked' | 'expired' | 'consumed'
  | 'wrong_email' | 'already_member' | 'not_found'

export interface ApiInvitationPreview {
  status: ApiInvitationPreviewStatus
  invitation?: {
    role: string
    email: string | null
    note: string | null
    expiresAt: string
    createdAt: string
    inviterName: string | null
    company: { id: string; name: string; slug: string }
    multiUse: boolean
  }
}

export interface ApiInvitationAccept {
  ok: true
  alreadyMember: boolean
  company: { id: string; name: string; slug: string; role: string }
}

export type ShippingFeatureStatus =
  | 'draft' | 'contract' | 'building' | 'verifying' | 'ready'
  | 'releasing' | 'watching' | 'learned' | 'paused' | 'archived'
export type ShippingVerificationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'waived'

export interface ShippingFeatureSummary {
  id: string
  title: string
  status: ShippingFeatureStatus
  priority: 'critical' | 'high' | 'medium' | 'low'
  riskLevel: 'critical' | 'high' | 'medium' | 'low'
  releaseTarget: string | null
  builderIds: string[]
  projectId: string | null
  updatedAt: string
  requiredSquares: number
  passedSquares: number
  failedSquares: number
}

export interface ShippingInvariant {
  id: string
  title: string
  description: string
  kind: 'behavior' | 'architecture' | 'data' | 'security' | 'performance' | 'ux' | 'operability'
  required: boolean
  position: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ShippingVerification {
  id: string
  invariantId: string | null
  title: string
  description: string
  method: 'user_path' | 'property' | 'trace' | 'data_reconciliation' | 'design_qa' | 'security' | 'performance' | 'release_note'
  required: boolean
  status: ShippingVerificationStatus
  ownerId: string | null
  verifiedById: string | null
  builderIds: string[]
  evidence: Array<Record<string, unknown>>
  notes: string
  position: number
  dueAt: string | null
  completedAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ShippingRelease {
  id: string
  environment: 'development' | 'staging' | 'canary' | 'production'
  status: 'planned' | 'approved' | 'running' | 'succeeded' | 'failed' | 'rolled_back'
  version: string | null
  commitSha: string | null
  startedBy: string | null
  approvedBy: string | null
  releaseNotes: string
  rollbackPlan: string
  knownGaps: Array<Record<string, unknown>>
  baseline: Array<Record<string, unknown>>
  smokeEvidence: Array<Record<string, unknown>>
  readbackDueAt: string | null
  readbackStatus: 'pending' | 'passed' | 'failed' | 'overdue'
  readbackEvidence: Array<Record<string, unknown>>
  startedAt: string | null
  completedAt: string | null
  rolledBackAt: string | null
  rollbackReason: string | null
  createdAt: string
  updatedAt: string
}

export interface ShippingFriction {
  id: string
  featureId?: string | null
  title: string
  description: string
  source: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  frequency: 'once' | 'occasional' | 'frequent' | 'constant'
  status: 'open' | 'triaged' | 'planned' | 'resolved' | 'dismissed'
  occurrenceCount: number
  lastSeenAt: string
  evidence?: Array<Record<string, unknown>>
}

export interface ShippingRegression {
  id: string
  invariantId: string | null
  sourceVerificationId: string | null
  title: string
  kind: 'automated' | 'benchmark' | 'manual_replay' | 'monitor'
  command: string | null
  expected: string
  status: 'active' | 'passing' | 'failing' | 'disabled'
  lastResult: string
  lastEvidence: Array<Record<string, unknown>>
  lastRunAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ShippingFeatureDetail extends Omit<ShippingFeatureSummary, 'requiredSquares' | 'passedSquares' | 'failedSquares'> {
  problem: string
  desiredOutcome: string
  contractSummary: string
  conversationId: string | null
  documentId: string | null
  boardCardId: string | null
  createdBy: string
  updatedBy: string
  createdAt: string
  archivedAt: string | null
  invariants: ShippingInvariant[]
  verifications: ShippingVerification[]
  releases: ShippingRelease[]
  frictions: ShippingFriction[]
  regressions: ShippingRegression[]
  events: Array<{ id: string; actorId: string | null; kind: string; data: Record<string, unknown>; createdAt: string }>
}

export interface ShippingOverview {
  features: ShippingFeatureSummary[]
  friction: ShippingFriction[]
  dueReadbacks: Array<{ id: string; featureId: string; featureTitle: string; readbackDueAt: string; readbackStatus: 'pending' | 'overdue' }>
}

export const api = {
  health: () => http<{ ok: boolean; ts: number }>('/health'),
  me: () => http<{ id: string; name: string; kind: string }>('/me'),
  /** Full-page redirect into the provider's consent screen. Use
   *  `window.location.assign(api.authStartUrl('google'))` rather than
   *  fetch — the browser needs to do the actual navigation so the
   *  callback can land back on AUTH_DONE_URL with the session token. */
  authStartUrl: (provider: 'google' | 'github' | 'gitlab', opts?: { inviteToken?: string | null; returnUrl?: string | null }) => {
    const params = new URLSearchParams()
    if (opts?.returnUrl) params.set('return', opts.returnUrl)
    if (opts?.inviteToken) params.set('invite', opts.inviteToken)
    const qs = params.toString()
    return `${API}/auth/start/${provider}${qs ? `?${qs}` : ''}`
  },
  authLogout: () =>
    http<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  /** Permanently delete the signed-in user's account. Soft-deletes
   *  the user row + clears PII + invalidates every session + drops
   *  OAuth linkages. After this call returns 200, the local Bearer
   *  token is invalid — caller should `useAuth.clear()` immediately. */
  deleteAccount: () =>
    http<{ ok: boolean }>('/me/account', { method: 'DELETE' }),
  /** Native Sign in with Apple — POST the identity_token JWT obtained
   *  from the iOS-native ASAuthorization flow. Server verifies the JWT
   *  against Apple's JWKS, find-or-creates the user, and returns a
   *  fresh session token. */
  authAppleNative: (input: { identityToken: string; name?: string | null; inviteToken?: string | null }) =>
    http<{ token: string; user: { id: string; email: string; displayName: string }; companyId: string | null }>('/auth/apple/native', {
      method: 'POST',
      body: JSON.stringify({
        identityToken: input.identityToken,
        name: input.name ?? null,
        inviteToken: input.inviteToken ?? null,
      }),
    }),
  authMe: () =>
    http<MeResponse>('/auth/me'),
  /** sub2api-backed quota snapshot for the signed-in user. `configured`
   *  is false on deployments that don't run a sub2api gateway; `snapshot`
   *  is null when the user has no active subscription (e.g. provisioning
   *  hasn't completed yet). Both states render as "unavailable" in the
   *  Usage tab rather than as errors. */
  getQuota: (signal?: AbortSignal) =>
    http<ApiQuotaResponse>('/me/quota', { signal }),
  listCompanies: () =>
    http<Array<{ id: string; name: string; slug: string; createdAt: string; role: string }>>('/companies'),
  listProjects: () => http<ApiProject[]>('/projects'),
  getShippingOverview: () => http<ShippingOverview>('/shipping/overview'),
  getShippingFeature: (id: string) => http<ShippingFeatureDetail>(`/shipping/features/${encodeURIComponent(id)}`),
  createShippingFeature: (input: {
    title: string; problem?: string; desiredOutcome?: string; contractSummary?: string;
    priority?: string; riskLevel?: string; releaseTarget?: string | null; builderIds?: string[];
    projectId?: string | null; conversationId?: string | null; documentId?: string | null; boardCardId?: string | null;
  }) => http<ShippingFeatureDetail>('/shipping/features', { method: 'POST', body: JSON.stringify(input) }),
  updateShippingFeature: (id: string, input: Partial<{
    title: string; problem: string; desiredOutcome: string; contractSummary: string;
    priority: string; riskLevel: string; releaseTarget: string | null; builderIds: string[];
    projectId: string | null; conversationId: string | null; documentId: string | null; boardCardId: string | null;
  }>) => http<ShippingFeatureDetail>(`/shipping/features/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  transitionShippingFeature: (id: string, status: ShippingFeatureStatus) =>
    http<ShippingFeatureDetail>(`/shipping/features/${encodeURIComponent(id)}/transition`, { method: 'POST', body: JSON.stringify({ status }) }),
  createShippingInvariant: (featureId: string, input: { title: string; description?: string; kind?: string; required?: boolean }) =>
    http<ShippingFeatureDetail>(`/shipping/features/${encodeURIComponent(featureId)}/invariants`, { method: 'POST', body: JSON.stringify(input) }),
  createShippingVerification: (featureId: string, input: {
    title: string; description?: string; method?: string; required?: boolean; invariantId?: string | null;
    ownerId?: string | null; builderIds?: string[]; dueAt?: string | null;
  }) => http<ShippingFeatureDetail>(`/shipping/features/${encodeURIComponent(featureId)}/verifications`, { method: 'POST', body: JSON.stringify(input) }),
  updateShippingVerification: (featureId: string, verificationId: string, input: Record<string, unknown>) =>
    http<ShippingFeatureDetail>(`/shipping/features/${encodeURIComponent(featureId)}/verifications/${encodeURIComponent(verificationId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  createShippingRelease: (featureId: string, input: {
    environment: string; version?: string; commitSha?: string; releaseNotes?: string; rollbackPlan?: string;
    knownGaps?: Array<Record<string, unknown>>; baseline?: Array<Record<string, unknown>>; readbackDueAt?: string | null;
  }) => http<ShippingFeatureDetail>(`/shipping/features/${encodeURIComponent(featureId)}/releases`, { method: 'POST', body: JSON.stringify(input) }),
  shippingReleaseAction: (featureId: string, releaseId: string, input: { action: string; evidence?: Array<Record<string, unknown>>; reason?: string }) =>
    http<ShippingFeatureDetail>(`/shipping/features/${encodeURIComponent(featureId)}/releases/${encodeURIComponent(releaseId)}/action`, { method: 'POST', body: JSON.stringify(input) }),
  createShippingFriction: (input: Record<string, unknown>) =>
    http<{ id: string }>('/shipping/friction', { method: 'POST', body: JSON.stringify(input) }),
  updateShippingFriction: (id: string, input: Record<string, unknown>) =>
    http<{ ok: boolean }>(`/shipping/friction/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  createShippingRegression: (featureId: string, input: Record<string, unknown>) =>
    http<ShippingFeatureDetail>(`/shipping/features/${encodeURIComponent(featureId)}/regressions`, { method: 'POST', body: JSON.stringify(input) }),
  updateShippingRegression: (featureId: string, regressionId: string, input: Record<string, unknown>) =>
    http<ShippingFeatureDetail>(`/shipping/features/${encodeURIComponent(featureId)}/regressions/${encodeURIComponent(regressionId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  createProject: (input: { name: string; description?: string; color?: string }) =>
    http<{ id: string; name: string; description: string; color: string | null; status: string }>('/projects', {
      method: 'POST', body: JSON.stringify(input),
    }),
  updateProject: (id: string, input: { name?: string; description?: string; color?: string | null }) =>
    http<{ ok: boolean }>(`/projects/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(input),
    }),
  archiveProject: (id: string, archive = true) =>
    http<{ ok: boolean; status: string }>(`/projects/${encodeURIComponent(id)}/archive`, {
      method: 'POST', body: JSON.stringify({ archive }),
    }),
  attachProject: (conversationId: string, projectId: string | null) =>
    http<{ ok: boolean; projectId: string | null }>(`/conversations/${encodeURIComponent(conversationId)}/project`, {
      method: 'POST', body: JSON.stringify({ projectId }),
    }),
  createCompany: (name: string) =>
    http<{ id: string; name: string; slug: string; role: string }>('/companies', {
      method: 'POST', body: JSON.stringify({ name }),
    }),
  listWorkspaceMembers: (companyId: string) =>
    http<ApiWorkspaceMember[]>(`/companies/${encodeURIComponent(companyId)}/members`),
  updateWorkspaceMemberRole: (companyId: string, userId: string, role: 'member' | 'admin') =>
    http<{ ok: true; member: ApiWorkspaceMember }>(
      `/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: JSON.stringify({ role }) },
    ),
  removeWorkspaceMember: (companyId: string, userId: string) =>
    http<{ ok: true }>(
      `/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),
  deleteCompany: (companyId: string, confirmation: string) =>
    http<{ ok: true; nextCompanyId: string }>(`/companies/${encodeURIComponent(companyId)}`, {
      method: 'DELETE', body: JSON.stringify({ confirmation }),
    }),
  /** Owner/admin-only: list every invitation (active + historical) for a
   *  company so the management UI can show recent activity. */
  listInvitations: (companyId: string) =>
    http<ApiInvitation[]>(`/companies/${encodeURIComponent(companyId)}/invitations`),
  /** Owner/admin-only: mint a fresh invite. Pass `email` for a single-use
   *  email-locked invite, omit (or set `multiUse: true`) for a shareable
   *  link. The returned `url` + `token` are the ONLY copy — the server
   *  stores just the hash. */
  createInvitation: (companyId: string, input: {
    email?: string | null
    role?: 'member' | 'admin'
    note?: string | null
    multiUse?: boolean
    maxUses?: number
    /** Ask the server to send the invitation email on the inviter's
     *  behalf. Ignored unless `email` is also set. Result reported back
     *  via `emailDelivery` on the response. */
    sendEmail?: boolean
  }) =>
    http<ApiInvitationWithToken>(`/companies/${encodeURIComponent(companyId)}/invitations`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  /** Owner/admin-only: revoke an invitation by its id (= token hash). */
  revokeInvitation: (companyId: string, inviteId: string) =>
    http<{ ok: boolean; revoked: boolean }>(
      `/companies/${encodeURIComponent(companyId)}/invitations/${encodeURIComponent(inviteId)}`,
      { method: 'DELETE' },
    ),
  /** Public: preview an invitation by its raw token. Returns the company
   *  + inviter so the accept screen can show "<X> invited you to <Y>"
   *  before the visitor signs in. When the caller IS signed in, the status
   *  also reflects `already_member` / `wrong_email`. */
  previewInvitation: (token: string) =>
    http<ApiInvitationPreview>(`/invitations/${encodeURIComponent(token)}`),
  /** Auth required: redeem an invitation. Joins the caller to the target
   *  company + adds them as a participant + posts "X joined" to #all-hands.
   *  Idempotent — calling twice with the same valid token returns
   *  `alreadyMember: true` on the second hit instead of incrementing
   *  use_count. */
  acceptInvitation: (token: string) =>
    http<ApiInvitationAccept>(`/invitations/${encodeURIComponent(token)}/accept`, {
      method: 'POST', body: JSON.stringify({}),
    }),
  getParticipants: () => http<ApiParticipant[]>('/participants'),

  // ─── Computers (agent hosts: Cumora Cloud + BYOA) ───
  getComputers: (signal?: AbortSignal) => http<ApiComputer[]>('/computers', { signal }),
  /** Start pairing a BYOA computer: returns a persistent token for the daemon.
   *  No computer is created until the daemon pairs and reports the machine's
   *  real hostname, so the UI just shows the command. */
  requestPairingCode: () =>
    http<{ code: string; expiresInSeconds: number | null }>(
      '/computers', { method: 'POST', body: '{}' }),
  /** Revoke a paired computer (its device token + agent JWTs stop working). */
  deleteComputer: (id: string) =>
    http<{ ok: boolean }>(`/computers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Get a re-pair code to reconnect an existing computer (keeps its agents). */
  repairComputer: (id: string) =>
    http<{ code: string; expiresInSeconds: number | null }>(
      `/computers/${encodeURIComponent(id)}/repair`, { method: 'POST', body: '{}' }),
  /** Ask a paired computer to re-probe its local engine inventory + versions. */
  requestComputerEngineDetect: (id: string) =>
    http<{ ok: boolean }>(
      `/computers/${encodeURIComponent(id)}/detect`, { method: 'POST', body: '{}' }),
  /** Read per-engine default model settings for a computer. */
  getEngineDefaults: (id: string) =>
    http<{ defaults: EngineDefaultsMap }>(
      `/computers/${encodeURIComponent(id)}/engine-defaults`),
  /** Update per-engine default model settings for a computer. */
  updateEngineDefaults: (id: string, defaults: EngineDefaultsMap) =>
    http<{ ok: boolean; defaults: EngineDefaultsMap }>(
      `/computers/${encodeURIComponent(id)}/engine-defaults`,
      { method: 'PUT', body: JSON.stringify({ defaults }) }),
  /** Move an agent to a computer, choosing its engine (Cumora Cloud = managed). */
  assignAgentComputer: (
    agentId: string,
    computerId: string,
    engine?: EngineId,
    inherit?: boolean,
    model?: string | null,
    fastModel?: string | null,
    providerProfile?: string | null,
  ) =>
    http<{ ok: boolean; kind: ComputerKind; engine: EngineId; inherit?: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/computer`,
      { method: 'POST', body: JSON.stringify({ computerId, engine, inherit, model, fastModel, providerProfile }) }),
  createAgent: (input: AgentCreateInput) =>
    http<{
      id: string
      replayed: boolean
      kind?: ComputerKind
      engine?: EngineId
      inherit?: boolean
    }>('/agents', { method: 'POST', body: JSON.stringify(input) }),
  updateAgent: (id: string, input: AgentInput) =>
    http<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  /** Soft-delete: marks the agent as off-boarded. Memory + log preserved. */
  offboardAgent: (id: string) =>
    http<{ ok: boolean; departedAt: string }>(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  rehireAgent: (id: string) =>
    http<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}/rehire`, { method: 'POST' }),
  generateAgentAvatar: (id: string) =>
    http<{ url: string }>(`/agents/${encodeURIComponent(id)}/avatar/generate`, { method: 'POST' }),
  getConversations: () => http<ApiConversation[]>('/conversations'),
  createGroup: (input: { title: string; members: string[]; topic?: string; projectId?: string | null }) =>
    http<{ id: string; members: string[]; projectId: string | null }>('/conversations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  leaveConversation: (conversationId: string) =>
    http<{ ok: boolean; members: string[] }>(`/conversations/${encodeURIComponent(conversationId)}/leave`, {
      method: 'POST',
    }),
  openDirect: (otherId: string) =>
    http<{ id: string; created: boolean }>('/conversations/direct', {
      method: 'POST',
      body: JSON.stringify({ otherId }),
    }),
  setTopic: (conversationId: string, topic: string | null) =>
    http<{ ok: boolean; topic: string | null }>(`/conversations/${encodeURIComponent(conversationId)}/topic`, {
      method: 'POST',
      body: JSON.stringify({ topic }),
    }),
  setTitle: (conversationId: string, title: string) =>
    http<{ ok: boolean; title: string }>(`/conversations/${encodeURIComponent(conversationId)}/title`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  togglePin: (conversationId: string, pinned?: boolean) =>
    http<{ ok: boolean; pinned: boolean }>(`/conversations/${encodeURIComponent(conversationId)}/pin`, {
      method: 'POST',
      body: JSON.stringify(pinned === undefined ? {} : { pinned }),
    }),
  /**
   * Mute/unmute. Pass `mute: false` to unmute; `mute: true` with an optional
   * `until` ISO string for a finite mute window (omit for "forever"). The
   * server validates `until` and rejects past timestamps.
   */
  /**
   * Register a push-notification device token. Called from src/lib/push.ts
   * after the user grants permission and Capacitor's `registration` event
   * fires with the APNs/FCM token. Idempotent server-side (upsert on
   * platform+token).
   */
  registerPushDevice: (input: {
    platform: 'ios' | 'android' | 'web'
    token: string
    appVersion?: string
    deviceModel?: string
  }) =>
    http<{ ok: boolean }>(`/push/register`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Best-effort sign-out housekeeping. Soft-disables the token row so
   *  the server stops sending APNs but keeps the audit trail. */
  unregisterPushDevice: (input: { token: string }) =>
    http<{ ok: boolean }>(`/push/unregister`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  setMute: (conversationId: string, mute: boolean, until?: string | null) =>
    http<{ ok: boolean; muted: boolean; mutedUntil: string | null }>(
      `/conversations/${encodeURIComponent(conversationId)}/mute`,
      {
        method: 'POST',
        body: JSON.stringify({ mute, until: until ?? null }),
      },
    ),
  addMember: (conversationId: string, participantId: string) =>
    http<{ ok: boolean; members: string[]; alreadyIn?: boolean }>(`/conversations/${encodeURIComponent(conversationId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ id: participantId }),
    }),
  getMessages: (
    conversationId: string,
    opts?: { before?: number; limit?: number },
  ) => {
    const qs = new URLSearchParams()
    if (opts?.before !== undefined) qs.set('before', String(opts.before))
    if (opts?.limit !== undefined) qs.set('limit', String(opts.limit))
    const q = qs.toString()
    return http<ApiMessage[]>(
      `/conversations/${encodeURIComponent(conversationId)}/messages${q ? `?${q}` : ''}`,
    )
  },
  /** All direct replies to a root message (i.e. messages whose quoted_message_id
   *  equals rootId). Used by the thread drawer. */
  getReplies: (conversationId: string, rootId: string) =>
    http<ApiMessage[]>(
      `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(rootId)}/replies`,
    ),
  sendMessage: (
    conversationId: string,
    body: string,
    attachment?: ApiAttachment | null,
    quotedMessageId?: string | null,
    /** Optional client-supplied idempotency key (the optimistic bubble's
     *  tempId). The server persists it and returns the original message when
     *  the same send is retried. */
    clientId?: string | null,
  ) =>
    http<{ id: string; sequence: number }>(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body,
        attachment: attachment ?? undefined,
        quotedMessageId: quotedMessageId ?? undefined,
        clientId: clientId ?? undefined,
      }),
    }),
  /* ============== Polls ====================================================
   * createPoll → POST /api/polls (server creates a kind='poll' message + broadcasts).
   * castPollVote → POST /api/polls/:id/vote (replaces caller's existing picks).
   * closePoll  → POST /api/polls/:id/close (only the original author). */
  createPoll: (args: {
    conversationId: string
    question: string
    mode: 'single' | 'multi'
    options: string[]
    /** Minutes until the poll auto-closes. null / undefined ⇒ no expiration. */
    expiresInMinutes?: number | null
  }) =>
    http<{ messageId: string; sequence: number; poll: import('../types.js').PollPayload }>(
      '/polls',
      { method: 'POST', body: JSON.stringify(args) },
    ),
  castPollVote: (messageId: string, optionIds: string[]) =>
    http<{ tallies: import('../types.js').PollTally[]; poll: import('../types.js').PollPayload }>(
      `/polls/${encodeURIComponent(messageId)}/vote`,
      { method: 'POST', body: JSON.stringify({ optionIds }) },
    ),
  closePoll: (messageId: string) =>
    http<{ closed: boolean; poll: import('../types.js').PollPayload | null }>(
      `/polls/${encodeURIComponent(messageId)}/close`,
      { method: 'POST' },
    ),
  /** Send a brand-new email thread. Recipients are addresses or
   *  in-tenant participant ids; the server resolves either. `attachments`
   *  references files already uploaded via `api.uploadFile` (the same
   *  upload path chat attachments use) — we hand over the storage key so
   *  Resend can fetch the URL server-side. Returns the resulting
   *  messages.id + the thread's conversations.id so the caller can
   *  navigate to it on success. */
  sendEmail: (args: {
    to: string[]
    cc?: string[]
    subject: string
    body: string
    attachments?: Array<{ key: string; filename: string; mimeType: string; sizeBytes: number }>
  }) =>
    http<{ messageId: string; conversationId: string; transportStatus: string; mock?: boolean; error?: string | null }>(
      '/email/send',
      { method: 'POST', body: JSON.stringify(args) },
    ),
  /** Reply to an existing email message. Headers (subject Re:, In-Reply-To,
   *  References, recipients) are derived server-side from the original. */
  replyEmail: (messageId: string, args: {
    body: string
    cc?: string[]
    attachments?: Array<{ key: string; filename: string; mimeType: string; sizeBytes: number }>
  }) =>
    http<{ messageId: string; conversationId: string; transportStatus: string; mock?: boolean; error?: string | null }>(
      `/email/reply/${encodeURIComponent(messageId)}`,
      { method: 'POST', body: JSON.stringify(args) },
    ),
  /** Fetch the server-sanitized HTML body for an email message. Returns
   *  null when the row has no HTML part (text-only mail) — the renderer
   *  treats that as "nothing to show" rather than an error. */
  fetchEmailHtml: async (messageId: string): Promise<string | null> => {
    const headers: Record<string, string> = {}
    const token = getAuthToken()
    if (token) headers.authorization = `Bearer ${token}`
    const company = getActiveCompanyId()
    if (company) headers['x-company-id'] = company
    if (getDevModeEnabled()) headers['x-cumora-dev-mode'] = '1'
    const res = await fetch(`${API}/email/${encodeURIComponent(messageId)}/html`, { headers })
    if (res.status === 204) return null
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text || `${res.status} ${res.statusText}`)
    }
    return res.text()
  },
  /** Fetch upload-system capabilities. Cached on the client so repeat
   *  uploads in the same session don't re-probe the server. */
  uploadCapabilities: (() => {
    let cache: Promise<UploadCapabilities> | null = null
    return (): Promise<UploadCapabilities> => {
      // Cache the SUCCESSFUL probe only. If the request rejects (network
      // blip at boot, a transient 502, offline-then-online), drop the
      // cached promise so the next upload re-probes — otherwise a single
      // early failure poisons the cache and every subsequent image select
      // instantly throws "Failed to fetch" without ever hitting the wire,
      // until a full page reload.
      if (!cache) {
        cache = http<UploadCapabilities>('/uploads/capabilities').catch((err) => {
          cache = null
          throw err
        })
      }
      return cache
    }
  })(),
  /**
   * Upload a file using the best available path:
   *   - R2 mode → presign + direct browser PUT to R2 (no base64 round-trip,
   *               no server CPU spent decoding, big files work fine)
   *   - local   → POST /uploads with base64 body (only practical option
   *               when there's no presigned-PUT endpoint)
   *
   * Returns an ApiAttachment ready to drop into `sendMessage`.
   */
  uploadFile: async (file: File): Promise<ApiAttachment> => {
    const caps = await api.uploadCapabilities()
    if (caps.maxBytes && file.size > caps.maxBytes) {
      throw new Error(`file too large: ${Math.round(file.size / 1024 / 1024)}MB (max ${Math.round(caps.maxBytes / 1024 / 1024)}MB)`)
    }
    const mime = file.type || 'application/octet-stream'
    if (caps.allowedMimes.length && !caps.allowedMimes.includes(mime)) {
      throw new Error(`file type not allowed: ${mime}`)
    }

    if (caps.presignSupported) {
      // Step 1 — ask the server for a presigned PUT URL.
      const signed = await http<PresignResponse>('/uploads/presign', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, mime, size: file.size }),
      })
      // Step 2 — PUT the raw bytes directly to R2. No auth header; the
      // presigned URL carries everything the bucket needs.
      const r = await fetch(signed.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: file,
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        throw new Error(`R2 PUT failed: ${r.status} ${text.slice(0, 200)}`)
      }
      return {
        url: signed.publicUrl,
        key: signed.key,
        name: signed.name,
        mime: signed.mime,
        size: signed.size,
        kind: signed.kind === 'img' ? 'img' : 'file',
      }
    }

    // Local-storage fallback — base64 through the server.
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    const dataBase64 = btoa(binary)
    return http<ApiAttachment>('/uploads', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, mime, dataBase64 }),
    })
  },
  refreshUploadUrl: (input: string | { url?: string; key?: string }) =>
    http<{ key: string; url: string }>('/uploads/refresh-url', {
      method: 'POST',
      body: JSON.stringify(typeof input === 'string' ? { url: input } : input),
    }),
  /** Voice input: base64 audio clip → server-side ASR → plain text. */
  transcribeAudio: (audio: string, format: string, signal?: AbortSignal) =>
    http<{ text: string }>('/audio/transcription', {
      signal,
      method: 'POST',
      body: JSON.stringify({ audio, format }),
    }),
  /** Settings page "models" tab. */
  getModelSettings: (signal?: AbortSignal) =>
    http<ApiModelSettings>('/settings/models', { signal }),
  getModelRoutePreview: (role: ApiModelRole, purpose = 'preview', signal?: AbortSignal) =>
    http<ApiModelRoutePreview>(`/settings/models/preview?role=${encodeURIComponent(role)}&purpose=${encodeURIComponent(purpose)}`, { signal }),
  getModelGroups: (signal?: AbortSignal) =>
    http<{ groups: ApiModelGroup[] }>('/settings/models/groups', { signal }),
  putModelSettings: (settings: Record<string, string | null>, signal?: AbortSignal) =>
    http<ApiSettingsWriteResult>('/settings/models', {
      signal,
      method: 'PUT',
      body: JSON.stringify({ settings }),
    }),
  getAvailableModels: (refresh = false, signal?: AbortSignal) =>
    http<ApiModelCatalog>(`/models/available${refresh ? '?refresh=1' : ''}`, { signal }),
  /** Usage dashboard. `range` = ISO from/to; `source` filters ledger source. */
  getUsageSummary: (from: string, to: string, source?: string, signal?: AbortSignal) =>
    http<ApiUsageSummary>(`/usage/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${source ? `&source=${encodeURIComponent(source)}` : ''}`, { signal }),
  getUsageTrend: (from: string, to: string, granularity: 'hour' | 'day', signal?: AbortSignal) =>
    http<{ granularity: 'hour' | 'day'; points: ApiUsageTrendPoint[]; metadata?: ApiUsageMetadata }>(`/usage/trend?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&granularity=${granularity}`, { signal }),
  getUsageByAgent: (from: string, to: string, signal?: AbortSignal) =>
    http<{ items: ApiUsageAgentRow[]; metadata?: ApiUsageMetadata }>(`/usage/by-agent?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal }),
  getUsageByModel: (from: string, to: string, signal?: AbortSignal) =>
    http<{ items: ApiUsageModelRow[]; metadata?: ApiUsageMetadata }>(`/usage/by-model?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal }),
  getUsageByProvider: (from: string, to: string, signal?: AbortSignal) =>
    http<{ items: ApiUsageProviderRow[]; metadata?: ApiUsageMetadata }>(`/usage/by-provider?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal }),
  /** Skills library + per-agent enablement. */
  getSkills: (signal?: AbortSignal) =>
    http<{ items: ApiSkill[]; hubConfigured: boolean; localHubConfigured: boolean }>('/skills', { signal }),
  createSkillFromPaste: (skillMd: string, signal?: AbortSignal) =>
    http<ApiSkill>('/skills/paste', { signal, method: 'POST', body: JSON.stringify({ skillMd }) }),
  installSkillFromHub: (hubId: string, signal?: AbortSignal) =>
    http<ApiSkill>('/skills/install', { signal, method: 'POST', body: JSON.stringify({ hubId }) }),
  deleteSkill: (id: string, signal?: AbortSignal) =>
    http<{ ok: boolean }>(`/skills/${encodeURIComponent(id)}`, { signal, method: 'DELETE' }),
  getLocalHubSkills: (signal?: AbortSignal) =>
    http<{ items: ApiLocalHubEntry[]; path: string | null }>('/skills/hub/local', { signal }),
  importLocalSkill: (name: string, signal?: AbortSignal) =>
    http<ApiSkill>('/skills/import-local', { signal, method: 'POST', body: JSON.stringify({ name }) }),
  searchSkillHub: (q: string, signal?: AbortSignal) =>
    http<{ items: Array<{ id: string; name?: string; description?: string }> }>(`/skills/hub/search?q=${encodeURIComponent(q)}`, { signal }),
  /** MCP connectors. */
  getMcpConnectors: (signal?: AbortSignal) =>
    http<{ items: ApiMcpConnector[] }>('/mcp-connectors', { signal }),
  createMcpConnector: (input: Omit<ApiMcpConnector, 'id' | 'companyId' | 'createdAt'>, signal?: AbortSignal) =>
    http<ApiMcpConnector>('/mcp-connectors', { signal, method: 'POST', body: JSON.stringify(input) }),
  updateMcpConnector: (id: string, input: Omit<ApiMcpConnector, 'id' | 'companyId' | 'createdAt'>, signal?: AbortSignal) =>
    http<ApiMcpConnector>(`/mcp-connectors/${encodeURIComponent(id)}`, { signal, method: 'PUT', body: JSON.stringify(input) }),
  deleteMcpConnector: (id: string, signal?: AbortSignal) =>
    http<{ ok: boolean }>(`/mcp-connectors/${encodeURIComponent(id)}`, { signal, method: 'DELETE' }),
  getAgentMcpConnectors: (agentId: string, signal?: AbortSignal) =>
    http<{ items: ApiAgentConnectorState[]; sync?: ApiSyncStatus }>(`/agents/${encodeURIComponent(agentId)}/mcp-connectors`, { signal }),
  setAgentMcpConnectors: (agentId: string, connectorIds: string[], signal?: AbortSignal) =>
    http<ApiBindingWriteResult>(`/agents/${encodeURIComponent(agentId)}/mcp-connectors`, { signal, method: 'PUT', body: JSON.stringify({ connectorIds }) }),
  getAgentSkills: (agentId: string, signal?: AbortSignal) =>
    http<{ items: ApiAgentSkillState[]; sync?: ApiSyncStatus }>(`/agents/${encodeURIComponent(agentId)}/skills`, { signal }),
  setAgentSkills: (agentId: string, skillIds: string[], signal?: AbortSignal) =>
    http<ApiBindingWriteResult>(`/agents/${encodeURIComponent(agentId)}/skills`, { signal, method: 'PUT', body: JSON.stringify({ skillIds }) }),
  getUsageLogs: (from: string, to: string, page: number, pageSize: number, source?: string, signal?: AbortSignal) =>
    http<ApiUsageLogPage>(`/usage/logs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page=${page}&pageSize=${pageSize}${source ? `&source=${encodeURIComponent(source)}` : ''}`, { signal }),
  markRead: (conversationId: string, boundary: { messageId: string; sequence: number }) =>
    http<{ ok: boolean }>(`/conversations/${encodeURIComponent(conversationId)}/read`, {
      method: 'POST',
      body: JSON.stringify(boundary),
    }),
  /** Broadcast a typing indicator into a conversation. Callers should
   *  throttle to roughly one POST every few seconds while typing
   *  continues, then send a final `done:true` when the composer goes
   *  idle, blurs, or sends. */
  emitTyping: (conversationId: string, done: boolean) =>
    http<{ ok: boolean }>(`/conversations/${encodeURIComponent(conversationId)}/typing`, {
      method: 'POST',
      body: JSON.stringify({ done }),
    }),
  toggleReaction: (messageId: string, emoji: string) =>
    http<{ reactions: Array<{ emoji: string; count: number; mine?: boolean; users?: string[] }> }>(
      `/messages/${encodeURIComponent(messageId)}/reactions`,
      { method: 'POST', body: JSON.stringify({ emoji }) },
    ),
  /** "Whispers" is a frontend tab name — on the server these are just
   *  agent-to-agent direct conversations the user can peek at. */
  getWhispers: () => http<ApiWhisper[]>('/peek/agent-chats'),
  getWhisperMessages: (id: string) =>
    http<ApiWhisperMessage[]>(`/peek/agent-chats/${encodeURIComponent(id)}/messages`),
  startConvene: (conversationId: string, topic: string) =>
    http<ApiConveneSession>(`/conversations/${encodeURIComponent(conversationId)}/convene`, {
      method: 'POST',
      body: JSON.stringify({ topic }),
    }),
  getActiveConvene: (conversationId: string) =>
    http<ApiConveneSession | null>(`/conversations/${encodeURIComponent(conversationId)}/convene`),
  getConveneTranscript: (sessionId: string) =>
    http<ApiConveneTranscript[]>(`/convene/${encodeURIComponent(sessionId)}/transcript`),
  /** Browser sign-in providers this deployment has credentials for. Used to
   *  avoid rendering a button that can only 503. */
  authProviders: () => http<{ providers: string[] }>('/auth/providers'),
  getPreferences: () => http<Record<string, unknown>>('/me/preferences'),
  putPreferences: (prefs: Record<string, unknown>) =>
    http<{ ok: boolean }>('/me/preferences', { method: 'PUT', body: JSON.stringify(prefs) }),
  getAllAutonomy: () => http<ApiAutonomy[]>('/agents/autonomy'),
  putAutonomy: (agentId: string, threshold: number) =>
    http<{ ok: boolean; threshold: number }>(`/agents/${encodeURIComponent(agentId)}/autonomy`, {
      method: 'PUT',
      body: JSON.stringify({ threshold }),
    }),
  getAgentRuns: (filters?: { agentId?: string | null; status?: ApiAgentRunStatus | 'all'; limit?: number }) => {
    const q = new URLSearchParams()
    if (filters?.agentId) q.set('agentId', filters.agentId)
    if (filters?.status && filters.status !== 'all') q.set('status', filters.status)
    if (filters?.limit) q.set('limit', String(filters.limit))
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return http<ApiAgentRun[]>(`/agents/observability/runs${suffix}`)
  },
  getAgentRunEvents: (runId: string) =>
    http<ApiAgentEvent[]>(`/agents/observability/runs/${encodeURIComponent(runId)}/events`),
  getTriageEconomics: (filters?: { agentId?: string | null; sinceHours?: number }) => {
    const q = new URLSearchParams()
    if (filters?.agentId) q.set('agentId', filters.agentId)
    if (filters?.sinceHours) q.set('sinceHours', String(filters.sinceHours))
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return http<ApiTriageEconomics>(`/agents/observability/triage${suffix}`)
  },
  getWakeEconomics: (filters?: { agentId?: string | null; sinceHours?: number }) => {
    const q = new URLSearchParams()
    if (filters?.agentId) q.set('agentId', filters.agentId)
    if (filters?.sinceHours) q.set('sinceHours', String(filters.sinceHours))
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return http<ApiWakeEconomics>(`/agents/observability/wakes${suffix}`)
  },
  getDevtoolsCapabilities: () => http<ApiDevtoolsCapabilities>('/devtools/capabilities'),
  listAgentWorkspace: (agentId: string) =>
    http<ApiAgentWorkspaceFile[]>(`/devtools/agent-workspace?agentId=${encodeURIComponent(agentId)}`),
  readAgentWorkspaceFile: (agentId: string, path: string) =>
    http<ApiAgentWorkspaceFileContent>(
      `/devtools/agent-workspace/file?agentId=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`,
    ),
  search: (q: string, signal?: AbortSignal) =>
    http<ApiSearchResults>(`/search?q=${encodeURIComponent(q)}`, { signal }),

  /* ============== Kanban boards ============== */
  listBoards: () => http<BoardSummary[]>('/boards'),
  getBoard: (id: string) => http<BoardSnapshot>(`/boards/${encodeURIComponent(id)}`),
  getBoardCard: (id: string) => http<BoardCardLookup>(`/cards/${encodeURIComponent(id)}`),
  createBoard: (input: { title: string; description?: string; requestId?: string }) =>
    http<{ id: string; replayed: boolean }>('/boards', { method: 'POST', body: JSON.stringify(input) }),
  updateBoard: (id: string, input: { title?: string; description?: string }) =>
    http<{ ok: boolean }>(`/boards/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(input),
    }),
  deleteBoard: (id: string) =>
    http<{ ok: boolean }>(`/boards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  addBoardColumn: (boardId: string, title: string) =>
    http<{ id: string; position: number }>(
      `/boards/${encodeURIComponent(boardId)}/columns`,
      { method: 'POST', body: JSON.stringify({ title }) },
    ),
  updateBoardColumn: (boardId: string, columnId: string, input: { title?: string; position?: number }) =>
    http<{ ok: boolean }>(
      `/boards/${encodeURIComponent(boardId)}/columns/${encodeURIComponent(columnId)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    ),
  deleteBoardColumn: (boardId: string, columnId: string) =>
    http<{ ok: boolean }>(
      `/boards/${encodeURIComponent(boardId)}/columns/${encodeURIComponent(columnId)}`,
      { method: 'DELETE' },
    ),
  createCard: (boardId: string, input: {
    columnId: string; title: string; description?: string; assigneeId?: string | null
  }) =>
    http<{ id: string; position: number; mentions: string[] }>(
      `/boards/${encodeURIComponent(boardId)}/cards`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  updateCard: (boardId: string, cardId: string, input: {
    title?: string; description?: string; position?: number
    columnId?: string; assigneeId?: string | null
  }) =>
    http<{ ok: boolean; mentions?: string[] }>(
      `/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    ),
  deleteCard: (boardId: string, cardId: string) =>
    http<{ ok: boolean }>(
      `/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`,
      { method: 'DELETE' },
    ),
  listCardComments: (boardId: string, cardId: string) =>
    http<BoardCardComment[]>(
      `/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/comments`,
    ),
  addCardComment: (boardId: string, cardId: string, body: string) =>
    http<{ id: string; mentions: string[] }>(
      `/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) },
    ),
  deleteCardComment: (boardId: string, cardId: string, commentId: string) =>
    http<{ ok: boolean }>(
      `/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/comments/${encodeURIComponent(commentId)}`,
      { method: 'DELETE' },
    ),

  /* ============== Calendar ==============
   * Shared schedule used by both humans and agents. Events are scoped to the
   * active company; the server-side scheduler fires agent_task events at
   * their start time (+ recurrence) by posting a typed Calendar system dispatch
   * into the target conversation. */
  listCalendarEvents: (range?: { from?: string; to?: string }) => {
    const params = new URLSearchParams()
    if (range?.from) params.set('from', range.from)
    if (range?.to) params.set('to', range.to)
    const qs = params.toString()
    return http<{ events: CalendarEvent[] }>(`/calendar/events${qs ? `?${qs}` : ''}`)
  },
  getCalendarEvent: (id: string) =>
    http<{ event: CalendarEvent }>(`/calendar/events/${encodeURIComponent(id)}`),
  createCalendarEvent: (input: CalendarEventInput) =>
    http<{ event: CalendarEvent; replayed: boolean }>('/calendar/events', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateCalendarEvent: (id: string, patch: Partial<CalendarEventInput> & { status?: CalendarEventStatus }) =>
    http<{ event: CalendarEvent }>(`/calendar/events/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteCalendarEvent: (id: string) =>
    http<{ ok: boolean }>(`/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runCalendarEventNow: (id: string) =>
    http<{ status: string; messageId?: string; conversationId?: string; error?: string }>(
      `/calendar/events/${encodeURIComponent(id)}/run-now`,
      { method: 'POST' },
    ),
  listCalendarDispatches: (id: string) =>
    http<{ dispatches: CalendarDispatch[] }>(
      `/calendar/events/${encodeURIComponent(id)}/dispatches`,
    ),
  /* ============== Collaborative documents (CRDT) ============== */
  listDocuments: () =>
    http<{ documents: ApiDocument[] }>('/documents'),
  createDocument: (input: { title?: string; conversationId?: string | null; requestId?: string } = {}) =>
    http<ApiDocument & { replayed?: boolean }>('/documents', { method: 'POST', body: JSON.stringify(input) }),
  getDocument: (id: string) =>
    http<ApiDocument>(`/documents/${encodeURIComponent(id)}`),
  renameDocument: (id: string, title: string) =>
    http<{ ok: boolean; title: string }>(`/documents/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify({ title }),
    }),
  deleteDocument: (id: string) =>
    http<{ ok: boolean }>(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

export interface ApiDocument {
  id: string
  title: string
  createdBy: string
  conversationId: string | null
  createdAt: string
  updatedAt: string
}

/** Body shape for create/update calendar event. The server validates each
 *  field independently so partial updates work. */
export interface CalendarEventInput {
  title: string
  kind?: CalendarEventKind
  description?: string | null
  assigneeId?: string | null
  targetConversationId?: string | null
  agentPrompt?: string | null
  startAt: string
  endAt?: string | null
  allDay?: boolean
  recurrence?: RecurrenceRule | null
  status?: CalendarEventStatus
  reminderMinutesBefore?: number | null
  reminderChannel?: CalendarReminderChannel | null
  /** Privacy flag. When true, only the creator + assignee see the row
   *  (and the workspace owner, if the row involves an agent). Default
   *  false = same shared-workspace behavior as before. */
  isPrivate?: boolean
  /** Stable across retries after an ambiguous network failure. */
  requestId?: string
}

/* ============== WebSocket bridge ============== */

export type WsEvent = { deliveryId?: string } & (
  | { type: 'hello'; instanceId: string; ts: number }
  | { type: 'message.new'; conversationId: string; message: ApiMessage }
  | { type: 'message.delta'; conversationId: string; messageId: string; authorId: string; delta: string; sequence: number; done: boolean }
  | { type: 'typing'; conversationId: string; agentId: string; done: boolean }
  | { type: 'participants.status'; participantId: string; status: Status; statusUpdatedAt?: string }
  | { type: 'participants.avatar'; participantId: string; avatarUrl: string }
  | { type: 'computers.status'; computerId: string; status: ComputerStatus }
  | { type: 'participants.added'; companyId?: string; conversationId?: string; participant: {
      id: string; kind: 'human' | 'agent'; name: string; role: string | null;
      initial: string; avatarBg: string; avatarUrl: string | null;
      status: Status; statusUpdatedAt: string | null;
    } }
  | { type: 'message.reactions'; conversationId: string; messageId: string; reactions: Array<{ emoji: string; count: number; mine?: boolean; users?: string[] }> }
  | { type: 'group.pulled'; conversationId: string; pulledById: string }
  | { type: 'conversation.updated'; conversationId: string; patch: { topic?: string | null; title?: string } }
  | { type: 'convene'; sessionId: string; conversationId: string; kind: 'started' | 'transcript' | 'ended' | 'tile'; data?: unknown }
  | { type: 'board.changed'; kind:
        | 'board.created' | 'board.updated' | 'board.deleted'
        | 'column.created' | 'column.updated' | 'column.deleted'
        | 'card.created' | 'card.updated' | 'card.moved' | 'card.deleted'
        | 'comment.created' | 'comment.deleted'
      boardId: string; cardId?: string; columnId?: string; commentId?: string
      mentions?: string[]; actorId?: string }
  | { type: 'doc.sync'; documentId: string; stateB64: string; originId: string }
  | { type: 'doc.update'; documentId: string; updateB64: string; originId: string }
  | { type: 'doc.awareness'; documentId: string; updateB64: string; originId: string }
  | { type: 'doc.error'; documentId?: string; error: string }
  | { type: 'doc.changed'; kind: 'document.created' | 'document.updated' | 'document.deleted'; documentId: string; actorId?: string }
  | { type: 'doc.mention'; documentId: string; documentTitle: string; mentionerId: string; mentionerName: string; mentionedIds: string[] }
  | {
      type: 'calendar.reminder'
      eventId: string
      title: string
      occurrenceAt: string
      leadMinutes: number
      /** Server limits this to humans only; renderer further filters by
       *  meId === one-of(recipientUserIds) before showing the toast. */
      recipientUserIds: string[]
      kind: CalendarEventKind
      assigneeId: string | null
    }
  | {
      /** A calendar row was created / updated / deleted, or the dispatcher
       *  advanced its last_fired_at. Payload is thin — clients refetch the
       *  affected row (or drop it on delete) rather than diffing inline.
       *  Mirrors the `doc.changed` shape. */
      type: 'calendar.changed'
      kind: 'event.created' | 'event.updated' | 'event.deleted' | 'event.dispatched'
      eventId: string
      actorId: string | null
    }
  | {
      type: 'poll.updated'
      conversationId: string
      messageId: string
      poll: import('../types.js').PollPayload
      tallies: import('../types.js').PollTally[]
      actorId: string | null
    }
  | {
      type: 'workspace.membership'
      kind: 'role_changed' | 'removed' | 'workspace_deleted'
      companyId: string
      recipientUserIds: string[]
      actorId: string
      userId?: string
      role?: 'admin' | 'member'
    }
)

type Listener = (e: WsEvent) => void

export class WsClient {
  private generation = 0
  private identity: { token: string; epoch: number } | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private ticketAbort: AbortController | null = null
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private reconnectDelay = 500
  private intentionalClose = false
  /** In-flight `connect()` de-dupe. The `this.ws` guard below cannot catch a
   *  second caller: `this.ws` is not assigned until AFTER the ticket fetch
   *  awaits, and boot fires five connects in the same tick
   *  (bootMessagesStream / bootParticipants / bootConversations /
   *  bootWhispers / bootComputers, each behind its own module-local `wsBound`
   *  flag, so none of them suppresses another). Every socket they opened fanned
   *  into this same `listeners` set, and since `message.delta` is applied by
   *  ACCUMULATING onto the body, the streaming bubble rendered each chunk five
   *  times while an agent typed. Concurrent callers ride the first attempt; the
   *  memo clears once it settles, so a later connect still gets a fresh socket. */
  private connecting: Promise<void> | null = null

  private identityCurrent(): boolean {
    return !!this.identity && this.identity.token === getAuthToken()
      && this.identity.epoch === useAuth.getState().contextEpoch
  }

  connect(): Promise<void> {
    if (this.identity && !this.identityCurrent()) this.close()
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return Promise.resolve()
    const existing = this.connecting
    if (existing) return existing
    this.intentionalClose = false
    const generation = ++this.generation
    const p = this.connectImpl(generation).finally(() => { if (this.connecting === p) this.connecting = null })
    this.connecting = p
    return p
  }

  private async connectImpl(generation: number) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    const token = getAuthToken()
    if (!token) return  // not signed in → don't even try
    // Fetch a SHORT-LIVED one-shot ticket so we never put the actual
    // session token on the WS URL (which would land in proxy access logs
    // / referrer headers). The ticket is consumed atomically server-side.
    const epoch = useAuth.getState().contextEpoch
    this.identity = { token, epoch }
    const current = () => generation === this.generation && !this.intentionalClose
      && token === getAuthToken() && epoch === useAuth.getState().contextEpoch
    const controller = new AbortController()
    this.ticketAbort = controller
    let ticket: string
    try {
      const r = await fetch(`${API}/auth/ws-ticket`, {
        signal: controller.signal,
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      })
      if (!r.ok) {
        // Schedule a retry — auth might be in flight, server bouncing, etc.
        this.scheduleReconnect(generation, token, epoch)
        return
      }
      const j = await r.json() as { ticket: string }
      ticket = j.ticket
    } catch {
      this.scheduleReconnect(generation, token, epoch)
      return
    }
    if (!current()) return
    const url = `${wsOrigin()}/ws?t=${encodeURIComponent(ticket)}`
    const sock = new WebSocket(url)
    this.ws = sock
    sock.onopen = () => {
      if (!current() || this.ws !== sock) { sock.close(); return }
      this.reconnectDelay = 500
    }
    sock.onmessage = (ev) => {
      if (!current() || this.ws !== sock) return
      try {
        const data = JSON.parse(ev.data) as WsEvent
        for (const listener of this.listeners) {
          if (!current() || this.ws !== sock) return
          listener(data)
        }
      } catch { /* ignore */ }
    }
    sock.onclose = () => {
      // Only the socket that is still CURRENT may clear the field. `reconnect()`
      // closes the old socket and opens its replacement immediately, but the
      // close event lands a tick later — nulling `this.ws` then would orphan a
      // LIVE socket (`isOpen()`/`send()` start reporting closed while typing
      // frames are silently dropped) and schedule a second one on top of it,
      // putting us back to two sockets sharing one listener set.
      if (!current() || this.ws !== sock) return
      this.ws = null
      if (!this.intentionalClose) this.scheduleReconnect(generation, token, epoch)
    }
    sock.onerror = () => { /* onclose follows */ }
  }

  private scheduleReconnect(generation: number, token: string, epoch: number) {
    if (generation !== this.generation || this.intentionalClose || token !== getAuthToken()
      || epoch !== useAuth.getState().contextEpoch || this.retryTimer !== null) return
    const d = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (generation === this.generation && !this.intentionalClose && token === getAuthToken()
        && epoch === useAuth.getState().contextEpoch) void this.connect()
    }, d)
  }

  on(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** Send a JSON frame upstream. Drops silently if the socket isn't open —
   *  callers should re-emit on `hello` reconnect rather than queuing. */
  send(payload: unknown): boolean {
    const sock = this.ws
    if (!this.identityCurrent() || !sock || sock.readyState !== WebSocket.OPEN) return false
    try { sock.send(JSON.stringify(payload)); return true } catch { return false }
  }

  isOpen(): boolean {
    return this.identityCurrent() && !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  close() {
    this.intentionalClose = true
    ++this.generation
    this.identity = null
    this.ticketAbort?.abort()
    this.ticketAbort = null
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.connecting = null
    const socket = this.ws
    this.ws = null
    socket?.close()
  }

  /** Force a fresh ticket fetch + reconnect. Used when the auth context
   *  changes (login, logout, company switch) so the socket re-handshakes
   *  with the new identity instead of staying on the old session. */
  reconnect() {
    this.close()
    this.intentionalClose = false
    this.reconnectDelay = 500
    void this.connect()
  }
}

export const ws = new WsClient()
