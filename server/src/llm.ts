/**
 * OpenAI client factory — every server-side LLM call goes through here.
 *
 * Routing rules (tenant-aware):
 *
 *   1. If sub2api is configured AND we can resolve the tenant's owner
 *      → that owner's sub2api_api_key → OpenAI client pointed at the
 *      sub2api OpenAI-compatible base. Per-user quotas enforced.
 *
 *   2. Else (sub2api unconfigured, or new tenant without a provisioned
 *      key yet) → legacy single `env.OPENAI_API_KEY` client pointed at
 *      OpenAI directly. No quotas — same behavior as pre-sub2api.
 *
 * Callers pass `tenant` (= company_id). When `tenant` is null (e.g.
 * platform-wide tasks like the avatar regen of a seeded agent before
 * any workspace exists) we always use the legacy path.
 *
 * Per-tenant client cache: OpenAI client construction is cheap but we
 * call this on every LLM hop. Cache by tenant; invalidate explicitly
 * (e.g. tier change handler) via `invalidateLlmClient(tenant)`.
 *
 * Database lookup failures propagate; they do not authorize env fallback.
 *
 * Provider routes are resolved from configuration before constructing a candidate client.
 * Request model strings cannot change a candidate's endpoint or credentials.
 */
import { resolveTenantLlmContext, tenantRoutingSnapshot, invalidateTenantModelSnapshot, onTenantLlmInvalidated } from './tenant-llm-context.js'
import OpenAI from 'openai'
import { resolveDirectLlmEnv } from './env.js'
export { resolveRoleCall } from './llm-resolver.js'
import { resolveRoleCall, type RoleCallPlan, type RoleCallCandidate } from './llm-resolver.js'
import { executeLlmPlan } from './llm-execution.js'
import { recordLlmCall, type LlmCallContext } from './agents/llm-ledger.js'
import { fetchImageBytes } from './agents/image-fetcher.js'
import { measuredUsage } from './agents/cost.js'
import { createChatResponsesShim } from './novita.js'
import { fallbackReason, isLlmCancellation } from './agents/fallback.js'
import { sub2apiRoutingConfigured, pickPlatformForModel, SUB2API_PLATFORMS, type Platform, type ApiKeyMap } from './sub2api.js'

interface CachedClient {
  authorizationVersion: string
  client: OpenAI
  /** unix-ms when the cache entry was minted; expire after 5 min so a
   *  silent tier change / key rotation doesn't strand the cache forever
   *  even when the explicit invalidate path is missed. */
  mintedAt: number
}

const CACHE_TTL_MS = 5 * 60_000
const cache = new Map<string, CachedClient>()
const candidateClients = new Map<string, { version: string; clients: Map<string, OpenAI> }>()
const directCandidateClients = new Map<string, { apiKey: string; baseURL: string; client: OpenAI }>()

/** Tolerance settings for both the sub2api-routed client AND the legacy
 *  fallback. Production has surfaced "all four agents 502'd at once →
 *  every run failed → fingerprint locks them out" sequences caused by
 *  brief upstream flakiness on sub2api / the model provider. The OpenAI
 *  SDK retries on 5xx + 408 + 429 + network errors out of the box, but
 *  its default ceiling (2) is enough for a single SDK-level retry; higher
 *  values multiply the application-level fallback attempts.
 *  Timeout is 5 min — model responses (especially with reasoning) can
 *  legitimately take a couple minutes; the SDK aborts and retries within
 *  this budget. */
const SDK_MAX_RETRIES = 1
const SDK_TIMEOUT_MS = 5 * 60_000

/** Test-only override. When set, every {@link getLlmClient} call returns
 *  whatever this function produces. Production code never sets this; it
 *  exists so integration tests can inject a fake OpenAI client whose
 *  `responses.create` returns crafted Responses-API event streams instead
 *  of round-tripping through sub2api / OpenAI. */
let testLlmOverride: ((tenant: string | null) => OpenAI | Promise<OpenAI>) | null = null
export function __setLlmClientOverrideForTesting(fn: typeof testLlmOverride): void {
  testLlmOverride = fn
}
/** True while a test override is installed. The ledger/executor check this to
 *  keep the legacy direct-call recording path: a stubbed client cannot drive
 *  real candidate resolution (no tenant rows exist in unit tests). */
export function __isLlmTestOverrideActive(): boolean {
  return testLlmOverride !== null
}

interface LlmClientOptions {
  /** The caller owns an explicit hop chain and must avoid a second wrapper. */
  skipModelFallback?: boolean
}

function prepareLlmClient(client: OpenAI, _options: LlmClientOptions): OpenAI {
  return client
}

/** A resolved candidate is one route; it never contains an application retry chain. */
export async function getLlmCandidateClient(plan: RoleCallPlan, candidate: RoleCallCandidate): Promise<OpenAI> {
  if (testLlmOverride) return testLlmOverride(plan.companyId)
  if (!candidate.available) throw new Error(candidate.diagnostic ?? 'LLM candidate unavailable')
  if (candidate.route.kind === 'gateway') {
    if (!plan.companyId || !candidate.route.platform) throw new Error('Missing tenant LLM route')
    const context = await resolveTenantLlmContext(plan.companyId)
    if (context.authorizationVersion !== plan.authorizationVersion) throw new Error('Tenant LLM authorization changed; resolve the plan again')
    const apiKey = context.keys[candidate.route.platform]
    if (!apiKey || !context.baseURL) throw new Error('Tenant LLM route is unavailable')
    let cached = candidateClients.get(plan.companyId)
    if (cached?.version !== context.authorizationVersion) {
      cached = { version: context.authorizationVersion, clients: new Map() }
      candidateClients.set(plan.companyId, cached)
    }
    let client = cached.clients.get(candidate.route.platform)
    if (!client) {
      client = new OpenAI({ apiKey, baseURL: context.baseURL, maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS })
      cached.clients.set(candidate.route.platform, client)
    }
    return client
  }
  const direct = resolveDirectLlmEnv(candidate.route.env ?? 'text')
  if (!direct.configured) throw new Error('Direct LLM route is not configured')
  const cacheKey = JSON.stringify([candidate.route.env, candidate.protocol,
    ['novita', 'orcarouter'].includes(candidate.route.env ?? '') ? candidate.requestModel : null])
  const cached = directCandidateClients.get(cacheKey)
  if (cached?.apiKey === direct.apiKey && cached.baseURL === direct.baseURL) return cached.client
  let client = new OpenAI({ apiKey: direct.apiKey, baseURL: direct.baseURL, maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS })
  if (candidate.route.env === 'novita' || candidate.route.env === 'orcarouter') {
    const baseClient = client
    const responses = candidate.protocol === 'chat' ? createChatResponsesShim(baseClient, candidate.requestModel) : {
      create: (args: Record<string, unknown>, opts?: unknown) => baseClient.responses.create({ ...args, model: candidate.requestModel } as never, opts as never),
    }
    client = new Proxy(client, {
      get(target, prop, receiver): unknown { return prop === 'responses' ? responses : Reflect.get(target, prop, receiver) },
    })
  }
  directCandidateClients.set(cacheKey, { apiKey: direct.apiKey, baseURL: direct.baseURL, client })
  return client
}

async function routePlatformForModel(
  baseURL: string,
  keys: ApiKeyMap,
  tenant: string,
  model: string | undefined,
): Promise<Platform> {
  const available = SUB2API_PLATFORMS.filter((p) => keys[p])
  const fallback: Platform = available.includes('openai') ? 'openai' : available[0] ?? 'openai'
  if (!model || available.length <= 1) return fallback
  const context = await resolveTenantLlmContext(tenant)
  // A client already handed to a caller must never use a newer key's discovery.
  if (context.baseURL !== baseURL || SUB2API_PLATFORMS.some((p) => context.keys[p] !== keys[p])) {
    throw new Error('Tenant LLM authorization changed; resolve the client again')
  }
  const snapshot = await tenantRoutingSnapshot(context)
  if (!snapshot) return fallback
  if (snapshot.authorizationVersion !== context.authorizationVersion) {
    throw new Error('Tenant LLM authorization changed; resolve the client again')
  }
  return pickPlatformForModel(Object.fromEntries(SUB2API_PLATFORMS.map((p) => [p, snapshot.platforms[p].models])), model, available)
}

/** Build the sub2api client for a tenant. Single-key users get a plain
 *  client (the pre-split behavior). Multi-key users get a proxy that
 *  routes responses.create / chat.completions.create to the platform
 *  whose group claims the requested model, at call time. */
function buildSub2apiClient(baseURL: string, keys: ApiKeyMap, tenant: string): OpenAI {
  const available = SUB2API_PLATFORMS.filter((p) => keys[p])
  const fallback: Platform = available.includes('openai') ? 'openai' : available[0] ?? 'openai'
  const mk = (p: Platform) => new OpenAI({
    apiKey: keys[p]!,
    baseURL,
    maxRetries: SDK_MAX_RETRIES,
    timeout: SDK_TIMEOUT_MS,
  })
  const base = mk(fallback)
  if (available.length <= 1) return base
  const platformClients = new Map<Platform, OpenAI>([[fallback, base]])
  const clientFor = (p: Platform): OpenAI => {
    let c = platformClients.get(p)
    if (!c) { c = mk(p); platformClients.set(p, c) }
    return c
  }
  // `create` variants return promises (a promise of a Stream when
  // stream:true), so deferring the platform pick into .then is safe.
  // call() receives the resolved client and must invoke the SDK method AS a
  // method call on it (c.responses.create(...)) — extracting the function
  // first would drop `this`, and the SDK's APIResource reads this._client.
  const routedCreate = (call: (c: OpenAI, a: unknown, o?: unknown) => unknown) =>
    (args: { model?: string } & Record<string, unknown>, opts?: unknown) =>
      routePlatformForModel(baseURL, keys, tenant, args?.model).then((p) => call(clientFor(p), args, opts))
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === 'responses') {
        return new Proxy(target.responses, {
          get(rt, p, rr): unknown {
            if (p !== 'create') return Reflect.get(rt, p, rr)
            return routedCreate((c, a, o) => (c.responses.create as (a: unknown, o?: unknown) => unknown).call(c.responses, a, o))
          },
        })
      }
      if (prop === 'chat') {
        return new Proxy(target.chat, {
          get(ct, p, cr): unknown {
            if (p !== 'completions') return Reflect.get(ct, p, cr)
            return new Proxy(target.chat.completions, {
              get(cct, pp, ccr): unknown {
                if (pp !== 'create') return Reflect.get(cct, pp, ccr)
                return routedCreate((c, a, o) => (c.chat.completions.create as (a: unknown, o?: unknown) => unknown).call(c.chat.completions, a, o))
              },
            })
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/** Build (and cache) the OpenAI client for this tenant. Async because
 *  resolving the tenant's owner_user_id + sub2api_api_key is a DB hop.
 *  Lookup failures propagate without changing the credential source. */
export async function getLlmClient(tenant: string | null, options: LlmClientOptions = {}): Promise<OpenAI> {
  if (testLlmOverride) return testLlmOverride(tenant)
  // No tenant context → legacy. Gate on the base URL only (not the
  // admin key): agent pods route per-platform without admin rights.
  if (!tenant || !sub2apiRoutingConfigured()) return prepareLlmClient(legacyClient(), options)

  const context = await resolveTenantLlmContext(tenant)
  const cached = cache.get(tenant)
  if (cached && cached.authorizationVersion === context.authorizationVersion && Date.now() - cached.mintedAt < CACHE_TTL_MS) {
    return prepareLlmClient(cached.client, options)
  }
  const client = SUB2API_PLATFORMS.some((p) => context.keys[p])
    ? buildSub2apiClient(context.baseURL, context.keys, tenant)
    : legacyClient()
  cache.set(tenant, { client, mintedAt: Date.now(), authorizationVersion: context.authorizationVersion })
  return prepareLlmClient(client, options)
}

/** Drop a tenant's cached client. Call from tier-change handlers so the
 *  next LLM hop picks up the swapped key / group. */
export function invalidateLlmClient(tenant: string): void {
  cache.delete(tenant)
  candidateClients.delete(tenant)
  invalidateTenantModelSnapshot(tenant)
}

export function invalidateModelRouteCache(tenant: string): void {
  invalidateTenantModelSnapshot(tenant)
}

onTenantLlmInvalidated(invalidateLlmClient)

let _legacy: OpenAI | null = null
function directTextClient(): OpenAI {
  const direct = resolveDirectLlmEnv('text')
  if (!direct.configured) throw new Error('Direct text LLM is not configured')
  if (!_legacy) _legacy = new OpenAI({
    apiKey: direct.apiKey,
    baseURL: direct.baseURL,
    maxRetries: SDK_MAX_RETRIES,
    timeout: SDK_TIMEOUT_MS,
  })
  return _legacy
}

function legacyClient(): OpenAI {
  const resource = (path: string[]): object => new Proxy({}, {
    get(_target, prop): unknown {
      if (prop === 'then') return undefined
      if (['responses', 'chat', 'completions', 'images', 'embeddings'].includes(String(prop))) return resource([...path, String(prop)])
      const resolve = () => {
        let target: unknown = directTextClient()
        for (const key of path) target = (target as Record<string, unknown>)[key]
        return target as Record<PropertyKey, unknown>
      }
      if (prop === 'create') return (...args: unknown[]) => {
        const target = resolve()
        return (target[prop] as (...args: unknown[]) => unknown).apply(target, args)
      }
      const target = resolve()
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return resource([]) as OpenAI
}

/** Dedicated client for image generation (avatars, agent `cumora image`).
 *  Text calls and image calls often need different providers (e.g. Kimi
 *  for text, DashScope for images). When OPENAI_IMAGE_BASE_URL and
 *  OPENAI_IMAGE_API_KEY are both set, images go there; otherwise fall
 *  back to the shared legacy client (previous behavior). */
/** DashScope (Alibaba Bailian) native text2image shim, shaped like OpenAI's
 *  images.generate. DashScope's OpenAI-compatible mode does NOT expose
 *  /images/generations — image models only exist on the native async task
 *  API, so we create a task and poll it to completion here. */
interface DashscopeTaskResponse {
  usage?: unknown
  model?: string
  output?: {
    task_id?: string
    task_status?: string
    results?: { url?: string }[]
    message?: string
  }
}

function dashscopeImageClient(apiKey: string, base: string, progress?: (stage: 'poll', taskId?: string) => void, signal?: AbortSignal): OpenAI {
  base = base.replace(/\/$/, '')
  const requestSignal = (timeout: number) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)])

  function dashscopeHttpError(message: string, status: number): Error & { status: number } {
    return Object.assign(new Error(message), { status })
  }

  // qwen-image* models live on the synchronous multimodal-generation API;
  // wan*/wanx* live on the async text2image task API.
  async function generateSync(model: string, prompt: string, size?: string, n?: number) {
    const resp = await fetch(`${base}/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
        parameters: { size: (size ?? '1024x1024').replace('x', '*'), n: n ?? 1 },
      }),
      signal: requestSignal(180_000),
    })
    if (!resp.ok) throw dashscopeHttpError(`dashscope multimodal-generation failed: ${resp.status} ${await resp.text()}`, resp.status)
    progress?.('poll')
    const body = (await resp.json()) as {
      usage?: unknown; model?: string
      output?: { choices?: { message?: { content?: { image?: string }[] } }[] }
    }
    const url = body.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image
    if (!url) throw new Error(`dashscope multimodal-generation returned no image: ${JSON.stringify(body).slice(0, 300)}`)
    return { data: [{ url }], usage: body.usage, model: body.model }
  }

  async function generateAsync(model: string, prompt: string, size?: string, n?: number) {
    const create = await fetch(`${base}/services/aigc/text2image/image-synthesis`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-Async': 'enable',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: { prompt },
        parameters: { size: (size ?? '1024x1024').replace('x', '*'), n: n ?? 1 },
      }),
      signal: requestSignal(30_000),
    })
    if (!create.ok) throw dashscopeHttpError(`dashscope task create failed: ${create.status} ${await create.text()}`, create.status)
    progress?.('poll')
    const created = (await create.json()) as DashscopeTaskResponse
    const taskId = created.output?.task_id
    if (!taskId) throw new Error(`dashscope task create returned no task_id: ${JSON.stringify(created)}`)

    progress?.('poll', taskId)
    const deadline = Date.now() + 180_000
    for (;;) {
      signal?.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal!.reason) }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, 2000)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      const poll = await fetch(`${base}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: requestSignal(30_000),
      })
      if (!poll.ok) throw dashscopeHttpError(`dashscope task poll failed: ${poll.status}`, poll.status)
      const status = (await poll.json()) as DashscopeTaskResponse
      const state = status.output?.task_status
      if (state === 'SUCCEEDED') {
        const url = status.output?.results?.[0]?.url
        if (!url) throw new Error('dashscope task succeeded with no result url')
        return { data: [{ url }], usage: status.usage, model: status.model }
      }
      if (state === 'FAILED' || state === 'CANCELED') {
        throw dashscopeHttpError(`dashscope task ${state}: ${status.output?.message ?? 'no message'}`, 400)
      }
      if (Date.now() > deadline) throw new Error('dashscope task timed out after 180s')
    }
  }

  async function generate(args: { model: string; prompt: string; size?: string; n?: number }) {
    return args.model.startsWith('qwen-image')
      ? generateSync(args.model, args.prompt, args.size, args.n)
      : generateAsync(args.model, args.prompt, args.size, args.n)
  }

  return { images: { generate } } as unknown as OpenAI
}

let _imageClient: OpenAI | null = null
export function getImageClient(): OpenAI {
  if (_imageClient) return _imageClient
  const { apiKey, baseURL, protocol, configured } = resolveDirectLlmEnv('image')
  if (!configured) throw new Error('Direct image LLM is not configured')
  if (protocol === 'dashscope-image' && apiKey) {
    _imageClient = dashscopeImageClient(apiKey, baseURL)
  } else if (baseURL && apiKey) {
    _imageClient = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: SDK_TIMEOUT_MS })
  } else {
    _imageClient = legacyClient()
  }
  return _imageClient
}

/** One image attempt includes generation, polling and delivery; external state forbids replay. */
export async function executeImage<T>(context: LlmCallContext,
  args: { prompt: string; size: '1024x1024' | '1536x1024' | '1024x1536'; n?: number },
  store: (buffer: Buffer) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
  const { signal } = options
  signal?.throwIfAborted()
  if (!args.prompt.trim()) throw new Error('Image prompt is empty')
  const plan = await resolveRoleCall(context.companyId, context.domain ?? (context.companyId ? 'managed' : 'server'),
    'image', context.purpose, { id: context.agentId ?? undefined }, undefined, signal)
  let stage: 'generation' | 'poll' | 'download' | 'storage' = 'generation'
  let taskId: string | undefined
  let generationCompleted = false
  return executeLlmPlan({ plan, context: { ...context, role: 'image' }, signal, sdkMaxRetries: 0,
    record: record => recordLlmCall({ ...record, extras: { ...record.extras,
      n: args.n ?? 1, size: args.size, unpriced: 'image-pricing-unavailable',
      imageStage: stage, failureStage: record.status === 'ok' ? null : stage,
      taskId: taskId ?? null, generationCompleted } }),
    prepare: async (candidate, state) => {
      stage = 'generation'
      taskId = undefined
      generationCompleted = false
      if (!['images', 'dashscope-image'].includes(candidate.protocol)) throw new Error('Non-image LLM protocol')
      const routed = await getLlmCandidateClient(plan, candidate)
      if (candidate.protocol === 'dashscope-image' && !routed.apiKey) throw new Error('Image route has no API key')
      const client = candidate.protocol === 'dashscope-image'
        ? dashscopeImageClient(routed.apiKey!, routed.baseURL, (nextStage, id) => {
          state.committed = true
          // Synchronous success also commits, but has no polling phase.
          if (!candidate.requestModel.startsWith('qwen-image')) stage = nextStage
          if (id) taskId = id
        }, signal) : routed
      return async () => {
        const response = await client.images.generate({ ...args, model: candidate.requestModel }, { maxRetries: 0, signal })
        state.committed = true
        state.rawUsage = response.usage ?? null
        state.usage = measuredUsage(response.usage, 'responses')
        state.usageProtocol = 'responses'
        const actualModel = (response as unknown as { model?: unknown }).model
        state.actualModel = typeof actualModel === 'string' ? actualModel : null
        const first = response.data?.[0]
        if (!first?.b64_json && !first?.url) throw new Error('image API returned no image')
        generationCompleted = true
        signal?.throwIfAborted()
        stage = 'download'
        let buffer: Buffer
        if (first.b64_json) buffer = Buffer.from(first.b64_json, 'base64')
        else {
          const fetched = await fetchImageBytes(first.url!, { maxBytes: 20 * 1024 * 1024, timeoutMs: 30_000, signal })
          signal?.throwIfAborted()
          if (!fetched.ok) throw new Error(`image API download failed (${fetched.reason})`)
          buffer = fetched.buffer
        }
        if (!buffer.length) throw new Error('image API returned empty image')
        signal?.throwIfAborted()
        stage = 'storage'
        return store(buffer)
      }
    },
  })
}

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024

export class AudioInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

/** Validate the JSON clip before resolving routes or creating an upstream attempt. */
export function validateAudioInput(audio: unknown, format: unknown = 'webm'): { audio: string; mime: string } {
  const mimes: Record<string, string> = { webm: 'audio/webm', ogg: 'audio/ogg', wav: 'audio/wav',
    mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac' }
  if (typeof format !== 'string' || !Object.hasOwn(mimes, format.trim().toLowerCase())) throw new AudioInputError('invalid audio format')
  const normalized = format.trim().toLowerCase()
  if (typeof audio !== 'string' || !audio.length) throw new AudioInputError('audio is required')
  if (audio.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) throw new AudioInputError('audio too large', 413)
  if (audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) throw new AudioInputError('invalid audio base64')
  const bytes = Buffer.from(audio, 'base64')
  if (!bytes.length || bytes.toString('base64') !== audio) throw new AudioInputError('invalid audio base64')
  if (bytes.length > MAX_AUDIO_BYTES) throw new AudioInputError('audio too large', 413)
  const starts = (value: string) => bytes.subarray(0, value.length).toString('latin1') === value
  const matches = normalized === 'webm' ? bytes.length > 4 && bytes.readUInt32BE(0) === 0x1a45dfa3
    : normalized === 'ogg' ? bytes.length > 27 && starts('OggS')
    : normalized === 'wav' ? bytes.length > 44 && starts('RIFF') && bytes.subarray(8, 12).toString() === 'WAVE'
    : normalized === 'mp3' ? bytes.length > 10 && (starts('ID3') || (bytes[0] === 0xff && (bytes[1]! & 0xe6) === 0xe2))
    : normalized === 'mp4' || normalized === 'm4a' ? bytes.length > 16 && bytes.subarray(4, 8).toString() === 'ftyp'
    : normalized === 'flac' ? bytes.length > 42 && starts('fLaC')
    : bytes.length > 7 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0
  if (!matches) throw new AudioInputError('audio content does not match format/MIME')
  return { audio, mime: mimes[normalized]! }
}

/** Chat input_audio retains the existing data-URL protocol on gateway and env routes. */
export async function transcribeAudio(audioBase64: unknown, format: unknown = 'webm', companyId: string | null = null, options: { signal?: AbortSignal; deadlineAt?: number } = {}): Promise<string> {
  const clip = validateAudioInput(audioBase64, format)
  const remaining = Math.max(0, Math.min(60_000, (options.deadlineAt ?? Date.now() + 60_000) - Date.now()))
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(remaining)])
  signal.throwIfAborted()
  if (!remaining) throw new DOMException('Audio deadline expired', 'TimeoutError')
  const context = { companyId, purpose: 'audio-transcription' as const, role: 'audio' as const }
  const plan = await resolveRoleCall(companyId, companyId ? 'managed' : 'server', 'audio', context.purpose, undefined, undefined, signal)
  return executeLlmPlan({ plan, context, signal, sdkMaxRetries: 0,
    prepare: async (candidate, state) => {
      if (candidate.protocol !== 'chat') throw new Error('Non-audio LLM protocol')
      const client = await getLlmCandidateClient(plan, candidate)
      return async () => {
        try {
          const body = await client.post<{ model?: unknown; usage?: unknown; choices?: { message?: { content?: unknown } }[] }>('/chat/completions', {
            body: { model: candidate.requestModel, stream: false, messages: [{ role: 'user', content: [
              { type: 'input_audio', input_audio: { data: `data:${clip.mime};base64,${clip.audio}` } },
            ] }] }, maxRetries: 0, signal, timeout: remaining,
          })
          state.usage = measuredUsage(body?.usage, 'chat')
          state.usageProtocol = 'chat'
          state.actualModel = typeof body?.model === 'string' ? body.model : null
          const content = body?.choices?.[0]?.message?.content
          if (typeof content !== 'string' || !content.trim()) throw new Error('ASR returned invalid transcription')
          return content.trim()
        } catch (error) {
          // Provider errors can echo the request or transcript; retain only routing diagnostics.
          const reason = fallbackReason(error)
          const status = (error as { status?: unknown } | null)?.status
          const safe = new Error('ASR request failed')
          if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) Object.assign(safe, { status })
          if (isLlmCancellation(error)) safe.name = 'AbortError'
          else if (reason?.startsWith('transport:')) {
            const transport = reason.slice('transport:'.length)
            if (['APIConnectionError', 'APIConnectionTimeoutError', 'TimeoutError'].includes(transport)) safe.name = transport
            else Object.assign(safe, { code: transport })
          }
          throw safe
        }
      }
    },
  })
}
