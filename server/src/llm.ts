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
 * Critical: failures resolving the sub2api key are NEVER fatal — we
 * fall back to the legacy client. A wedged sub2api lookup must not
 * take down agent turns.
 *
 * Provider routing (model-based, on top of the above): whichever client is
 * chosen by the tenant rules is wrapped by `withProviderRouting` before it's
 * returned. That wrapper inspects the `model` on each individual
 * `responses.create()` call — not the tenant — and reroutes calls whose
 * model carries a recognized provider prefix:
 *   - `novita/<model>`       → Novita's real Chat Completions API via
 *                              server/src/novita.ts's translation shim, since
 *                              Novita has no Responses API to swap a base URL
 *                              onto.
 *   - `orcarouter/<model>`   → OrcaRouter (https://www.orcarouter.ai) via a
 *                              pure base-URL swap (server/src/orcarouter.ts),
 *                              since OrcaRouter speaks the Responses API
 *                              natively — no translation needed.
 * Everything else about the returned client (chat.completions, images,
 * embeddings, non-prefixed responses.create calls) is the same object
 * callers already know.
 */
import OpenAI from 'openai'
import { pool } from './db/pool.js'
import { env } from './env.js'
import { isNovitaModel, novitaResponsesShim } from './novita.js'
import { resolvedChain, runWithFallback, isFallbackableError } from './agents/fallback.js'
import { isOrcaRouterModel, orcarouterResponsesCreate } from './orcarouter.js'
import { sub2apiRoutingConfigured, sub2apiOpenAIBaseURL, parseApiKeyMap, pickPlatformForModel, listKeyModelsWithStatus, SUB2API_PLATFORMS, type Platform, type ApiKeyMap } from './sub2api.js'

interface CachedClient {
  client: OpenAI
  /** unix-ms when the cache entry was minted; expire after 5 min so a
   *  silent tier change / key rotation doesn't strand the cache forever
   *  even when the explicit invalidate path is missed. */
  mintedAt: number
}

const CACHE_TTL_MS = 5 * 60_000
const cache = new Map<string, CachedClient>()

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

/** Wrap a client so any call whose `model` carries a recognized provider
 *  prefix is routed to that provider instead of this client's own
 *  `responses.create`:
 *    - `novita/<model>`     → Novita (server/src/novita.ts), translated
 *                             through `novitaResponsesShim` so the caller sees
 *                             an ordinary Responses-API stream/return.
 *    - `orcarouter/<model>` → OrcaRouter (server/src/orcarouter.ts), a pure
 *                             base-URL swap — OrcaRouter speaks the Responses
 *                             API natively.
 *
 *  Model, not tenant, decides the provider: `getLlmClient` is resolved
 *  once per tenant/hop before the model for that specific call is even
 *  read off `args.model`, so routing has to happen at `.responses.create()`
 *  call time, not here. Every caller in this codebase reads only
 *  `client.responses.create(...)`, so wrapping just that property is a
 *  complete, minimal interception — everything else (chat.completions,
 *  images, embeddings) passes through to the real client untouched. */
let novitaUnconfiguredWarned = false
let orcarouterUnconfiguredWarned = false
/** One log line per provider, not one per call — this fires on every hop of
 *  every turn of an agent whose model names an unconfigured provider. */
function warnProviderUnconfiguredOnce(provider: 'Novita' | 'OrcaRouter', model: string | undefined): void {
  if (provider === 'Novita') {
    if (novitaUnconfiguredWarned) return
    novitaUnconfiguredWarned = true
    console.warn(`[llm] model "${model}" requests Novita but NOVITA_API_KEY is unset — using the tenant's normal client instead`)
    return
  }
  if (orcarouterUnconfiguredWarned) return
  orcarouterUnconfiguredWarned = true
  console.warn(`[llm] model "${model}" requests OrcaRouter but ORCAROUTER_API_KEY is unset — using the tenant's normal client instead`)
}

function withProviderRouting(client: OpenAI): OpenAI {
  return new Proxy(client, {
    get(target, prop, receiver): unknown {
      if (prop !== 'responses') return Reflect.get(target, prop, receiver)
      const real = target.responses
      return new Proxy(real, {
        get(rt, p, rr): unknown {
          if (p !== 'create') return Reflect.get(rt, p, rr)
          return (args: { model?: string } & Record<string, unknown>, opts?: unknown) => {
            if (isNovitaModel(args.model)) {
              // Route to Novita only when this deployment actually configured
              // a key — otherwise fall through to the tenant's normal client,
              // exactly as env.ts documents. Without this guard an unset key
              // sent the call to api.novita.ai with an empty bearer and the
              // agent died on an unexplained 401 instead of degrading.
              if (env.NOVITA_API_KEY) {
                return novitaResponsesShim.create(args as never, opts as never)
              }
              warnProviderUnconfiguredOnce('Novita', args.model)
            } else if (isOrcaRouterModel(args.model)) {
              // Same degrade-not-die guard for OrcaRouter: an unset key must
              // fall through to the tenant's normal client, not send a bare
              // bearer to api.orcarouter.ai.
              if (env.ORCAROUTER_API_KEY) {
                return orcarouterResponsesCreate(args, opts)
              }
              warnProviderUnconfiguredOnce('OrcaRouter', args.model)
            }
            return (real.create as (a: unknown, o?: unknown) => unknown)(args, opts)
          }
        },
      })
    },
  })
}

/** Text-role fallback wrapper: when the requested model IS a role primary
 *  (brain/support/compaction), retry the call down the role's chain on
 *  fallbackable errors (402/429/5xx/network). Chain hops re-enter the
 *  wrapped client's normal routing (provider prefixes, then per-platform
 *  sub2api keys), so a hop can live on a different platform group. */
function withModelFallback(client: OpenAI): OpenAI {
  return new Proxy(client, {
    get(target, prop, receiver): unknown {
      if (prop !== 'responses') return Reflect.get(target, prop, receiver)
      const real = target.responses
      return new Proxy(real, {
        get(rt, p, rr): unknown {
          if (p !== 'create') return Reflect.get(rt, p, rr)
          const realCreate = real.create as (a: unknown, o?: unknown) => unknown
          return (args: { model?: string } & Record<string, unknown>, opts?: unknown) => {
            let chain: string[] = []
            const model = args?.model
            // Provider-prefixed models can still be role primaries. The
            // provider router below decides where each hop is sent.
            if (model) {
              for (const role of ['brain', 'support', 'compaction'] as const) {
                const c = resolvedChain(role)
                if (c[0] && c[0] === model) { chain = c; break }
              }
            }
            if (chain.length <= 1) return realCreate.call(real, args, opts)
            return runWithFallback(chain, (m) => realCreate.call(real, { ...args, model: m }, opts) as Promise<unknown>)
          }
        },
      })
    },
  })
}

interface LlmClientOptions {
  /** The caller owns an explicit hop chain and must avoid a second wrapper. */
  skipModelFallback?: boolean
}

function prepareLlmClient(client: OpenAI, options: LlmClientOptions): OpenAI {
  const routed = withProviderRouting(client)
  return options.skipModelFallback ? routed : withModelFallback(routed)
}

/** Per-tenant model→platform route cache for multi-key sub2api users.
 *  Built from each platform key's gateway /v1/models view (scoped to the
 *  key's group); failed refreshes retain the previous route and mark it
 *  stale, while an initial failure falls back without caching an empty set. */
interface ModelRouteCache {
  byPlatform: Partial<Record<Platform, ReadonlySet<string>>>
  at: number
  stale: boolean
}
const MODEL_ROUTE_TTL_MS = 5 * 60_000
const modelRouteCache = new Map<string, ModelRouteCache>()
const modelRouteRefreshes = new Map<string, Promise<ModelRouteCache | null>>()
const modelRouteGenerations = new Map<string, number>()

async function refreshModelRouteCache(
  baseURL: string,
  keys: ApiKeyMap,
  tenant: string,
): Promise<ModelRouteCache | null> {
  const running = modelRouteRefreshes.get(tenant)
  if (running) return running

  const existing = modelRouteCache.get(tenant)
  const generation = modelRouteGenerations.get(tenant) ?? 0
  const available = SUB2API_PLATFORMS.filter((p) => keys[p])
  const refresh = (async (): Promise<ModelRouteCache | null> => {
    const results = await Promise.all(available.map(async (platform) => ({
      platform,
      result: await listKeyModelsWithStatus(baseURL, keys[platform]!),
    })))
    if ((modelRouteGenerations.get(tenant) ?? 0) !== generation) {
      return modelRouteCache.get(tenant) ?? existing ?? null
    }

    if (results.some(({ result }) => !result.ok)) {
      if (!existing) return null
      const stale = { ...existing, at: Date.now(), stale: true }
      modelRouteCache.set(tenant, stale)
      return stale
    }

    const byPlatform: Partial<Record<Platform, ReadonlySet<string>>> = {}
    for (const { platform, result } of results) byPlatform[platform] = result.models
    const fresh = { byPlatform, at: Date.now(), stale: false }
    modelRouteCache.set(tenant, fresh)
    return fresh
  })()
  modelRouteRefreshes.set(tenant, refresh)
  try {
    return await refresh
  } finally {
    if (modelRouteRefreshes.get(tenant) === refresh) modelRouteRefreshes.delete(tenant)
  }
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
  let entry = modelRouteCache.get(tenant)
  if (!entry || Date.now() - entry.at > MODEL_ROUTE_TTL_MS) {
    entry = await refreshModelRouteCache(baseURL, keys, tenant) ?? entry
  }
  return pickPlatformForModel(entry?.byPlatform ?? {}, model, available)
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
 *  Always returns a working client — never throws on lookup failure. */
export async function getLlmClient(tenant: string | null, options: LlmClientOptions = {}): Promise<OpenAI> {
  if (testLlmOverride) return testLlmOverride(tenant)
  // No tenant context → legacy. Gate on the base URL only (not the
  // admin key): agent pods route per-platform without admin rights.
  if (!tenant || !sub2apiRoutingConfigured()) return prepareLlmClient(legacyClient(), options)

  const cached = cache.get(tenant)
  if (cached && Date.now() - cached.mintedAt < CACHE_TTL_MS) {
    return prepareLlmClient(cached.client, options)
  }

  try {
    const { rows } = await pool.query<{ sub2api_api_key: string | null }>(
      `SELECT u.sub2api_api_key
         FROM companies c
         JOIN users u ON u.id = c.owner_user_id
        WHERE c.id = $1`,
      [tenant],
    )
    const rawKey = rows[0]?.sub2api_api_key
    if (!rawKey) {
      // Tenant exists but owner hasn't been provisioned in sub2api yet.
      // Cache the legacy fallback briefly so we don't re-query on every
      // hop, but with a short TTL so the next backfill picks up quickly.
      const c = legacyClient()
      cache.set(tenant, { client: c, mintedAt: Date.now() })
      return prepareLlmClient(c, options)
    }
    const c = buildSub2apiClient(sub2apiOpenAIBaseURL(), parseApiKeyMap(rawKey), tenant)
    cache.set(tenant, { client: c, mintedAt: Date.now() })
    return prepareLlmClient(c, options)
  } catch (e) {
    console.warn(`[llm] tenant ${tenant} client lookup failed; legacy fallback`, e instanceof Error ? e.message : e)
    return prepareLlmClient(legacyClient(), options)
  }
}

/** Drop a tenant's cached client. Call from tier-change handlers so the
 *  next LLM hop picks up the swapped key / group. */
export function invalidateLlmClient(tenant: string): void {
  cache.delete(tenant)
}

export function invalidateModelRouteCache(tenant: string): void {
  modelRouteGenerations.set(tenant, (modelRouteGenerations.get(tenant) ?? 0) + 1)
  modelRouteCache.delete(tenant)
}

let _legacy: OpenAI | null = null
function legacyClient(): OpenAI {
  if (!_legacy) _legacy = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    maxRetries: SDK_MAX_RETRIES,
    timeout: SDK_TIMEOUT_MS,
  })
  return _legacy
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
  output?: {
    task_id?: string
    task_status?: string
    results?: { url?: string }[]
    message?: string
  }
}

function dashscopeImageClient(apiKey: string): OpenAI {
  const base = 'https://dashscope.aliyuncs.com/api/v1'

  function dashscopeHttpError(message: string, status: number): Error & { status: number } {
    return Object.assign(new Error(message), { status })
  }

  async function downloadAsB64(url: string): Promise<{ b64_json: string }> {
    // Download here and return b64_json instead of the URL: the caller's
    // fetchImageBytes SSRF guard DNS-pins the host, which breaks on fake-ip
    // VPN DNS (resolves to reserved ranges).
    const img = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!img.ok) throw dashscopeHttpError(`dashscope result download failed: ${img.status}`, img.status)
    return { b64_json: Buffer.from(await img.arrayBuffer()).toString('base64') }
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
      signal: AbortSignal.timeout(180_000),
    })
    if (!resp.ok) throw dashscopeHttpError(`dashscope multimodal-generation failed: ${resp.status} ${await resp.text()}`, resp.status)
    const body = (await resp.json()) as {
      output?: { choices?: { message?: { content?: { image?: string }[] } }[] }
    }
    const url = body.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image
    if (!url) throw new Error(`dashscope multimodal-generation returned no image: ${JSON.stringify(body).slice(0, 300)}`)
    return { data: [await downloadAsB64(url)] }
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
      signal: AbortSignal.timeout(30_000),
    })
    if (!create.ok) throw dashscopeHttpError(`dashscope task create failed: ${create.status} ${await create.text()}`, create.status)
    const created = (await create.json()) as DashscopeTaskResponse
    const taskId = created.output?.task_id
    if (!taskId) throw new Error(`dashscope task create returned no task_id: ${JSON.stringify(created)}`)

    const deadline = Date.now() + 180_000
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000))
      const poll = await fetch(`${base}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      })
      if (!poll.ok) throw dashscopeHttpError(`dashscope task poll failed: ${poll.status}`, poll.status)
      const status = (await poll.json()) as DashscopeTaskResponse
      const state = status.output?.task_status
      if (state === 'SUCCEEDED') {
        const url = status.output?.results?.[0]?.url
        if (!url) throw new Error('dashscope task succeeded with no result url')
        return { data: [await downloadAsB64(url)] }
      }
      if (state === 'FAILED' || state === 'CANCELED') {
        throw dashscopeHttpError(`dashscope task ${state}: ${status.output?.message ?? 'no message'}`, 400)
      }
      if (Date.now() > deadline) throw new Error('dashscope task timed out after 180s')
    }
  }

  async function generate(args: { model: string; prompt: string; size?: string; n?: number }) {
    // Chain from runtime settings (server_settings, env fallback): the image
    // role's primary + ordered fallbacks. A caller-passed model that differs
    // from the settings primary is honored as the first hop. Only
    // fallbackable errors (402/429/5xx/network) advance the chain.
    const settingsChain = resolvedChain('image')
    const chain = args.model && !settingsChain.includes(args.model)
      ? [args.model, ...settingsChain]
      : settingsChain.length > 0 ? settingsChain : [args.model]
    let lastErr: unknown = null
    for (const model of chain) {
      try {
        if (model.startsWith('qwen-image')) {
          return await generateSync(model, args.prompt, args.size, args.n)
        }
        return await generateAsync(model, args.prompt, args.size, args.n)
      } catch (e) {
        lastErr = e
        if (!isFallbackableError(e)) throw e
        console.warn(`[image] ${model} failed, trying next:`, e instanceof Error ? e.message.slice(0, 200) : e)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  return { images: { generate } } as unknown as OpenAI
}

let _imageClient: OpenAI | null = null
export function getImageClient(): OpenAI {
  if (_imageClient) return _imageClient
  const apiKey = process.env.OPENAI_IMAGE_API_KEY ?? ''
  const provider = (process.env.OPENAI_IMAGE_PROVIDER ?? '').toLowerCase()
  const baseURL = (process.env.OPENAI_IMAGE_BASE_URL ?? '').replace(/\/+$/, '')
  if (provider === 'dashscope' && apiKey) {
    _imageClient = dashscopeImageClient(apiKey)
  } else if (baseURL && apiKey) {
    _imageClient = new OpenAI({ apiKey, baseURL, maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS })
  } else {
    _imageClient = legacyClient()
  }
  return _imageClient
}

/** Transcribe an audio clip via DashScope's OpenAI-compatible chat
 *  endpoint — the qwen3-asr models accept an `input_audio` content part
 *  carrying a base64 data URL.
 *
 *  Chain comes from runtime settings (server_settings audio_model +
 *  audio_fallback_models, env fallback); only fallbackable errors
 *  (402/429/5xx/network) advance — 400/401 surface immediately.
 *  Key comes from OPENAI_AUDIO_API_KEY, falling back to
 *  OPENAI_IMAGE_API_KEY (same Bailian key on this deployment). */
export async function transcribeAudio(audioBase64: string, format: string): Promise<string> {
  const apiKey = (process.env.OPENAI_AUDIO_API_KEY ?? '').trim() || (process.env.OPENAI_IMAGE_API_KEY ?? '').trim()
  if (!apiKey) throw new Error('OPENAI_AUDIO_API_KEY is not set (and no OPENAI_IMAGE_API_KEY fallback)')
  const chain = resolvedChain('audio')
  if (chain.length === 0) throw new Error('audio_model is not set (OPENAI_AUDIO_MODEL)')
  const base = (process.env.OPENAI_AUDIO_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')
  let lastErr: unknown = null
  for (const model of chain) {
    try {
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: `data:audio/${format};base64,${audioBase64}` } }],
          }],
        }),
        signal: AbortSignal.timeout(120_000),
      })
      // Carry the status so isFallbackableError can tell 401/400 (fatal)
      // from 429/5xx (advance the chain).
      if (!resp.ok) throw Object.assign(new Error(`asr request failed: ${resp.status} ${(await resp.text()).slice(0, 300)}`), { status: resp.status })
      const body = (await resp.json()) as { choices?: { message?: { content?: string } }[] }
      const text = body.choices?.[0]?.message?.content?.trim()
      if (!text) throw new Error(`asr returned no text: ${JSON.stringify(body).slice(0, 300)}`)
      return text
    } catch (e) {
      lastErr = e
      if (!isFallbackableError(e)) throw e
      console.warn(`[asr] ${model} failed, trying next:`, e instanceof Error ? e.message.slice(0, 200) : e)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
