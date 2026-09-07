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
import { isOrcaRouterModel, orcarouterResponsesCreate } from './orcarouter.js'
import { sub2apiConfigured, sub2apiOpenAIBaseURL } from './sub2api.js'

interface CachedClient {
  client: OpenAI
  /** What we built the client from — used for cheap invalidation. */
  key: string
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
 *  its default ceiling (2) is too thin for the bursty 502 windows we
 *  see; 5 absorbs short outages without making the wall-clock pathological.
 *  Timeout is 5 min — model responses (especially with reasoning) can
 *  legitimately take a couple minutes; the SDK aborts and retries within
 *  this budget. */
const SDK_MAX_RETRIES = 5
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

/** Build (and cache) the OpenAI client for this tenant. Async because
 *  resolving the tenant's owner_user_id + sub2api_api_key is a DB hop.
 *  Always returns a working client — never throws on lookup failure. */
export async function getLlmClient(tenant: string | null): Promise<OpenAI> {
  if (testLlmOverride) return testLlmOverride(tenant)
  // No tenant context → legacy.
  if (!tenant || !sub2apiConfigured()) return withProviderRouting(legacyClient())

  const cached = cache.get(tenant)
  if (cached && Date.now() - cached.mintedAt < CACHE_TTL_MS) {
    return withProviderRouting(cached.client)
  }

  try {
    const { rows } = await pool.query<{ sub2api_api_key: string | null }>(
      `SELECT u.sub2api_api_key
         FROM companies c
         JOIN users u ON u.id = c.owner_user_id
        WHERE c.id = $1`,
      [tenant],
    )
    const apiKey = rows[0]?.sub2api_api_key
    if (!apiKey) {
      // Tenant exists but owner hasn't been provisioned in sub2api yet.
      // Cache the legacy fallback briefly so we don't re-query on every
      // hop, but with a short TTL so the next backfill picks up quickly.
      const c = legacyClient()
      cache.set(tenant, { client: c, key: 'legacy', mintedAt: Date.now() })
      return withProviderRouting(c)
    }
    const c = new OpenAI({
      apiKey,
      baseURL: sub2apiOpenAIBaseURL(),
      maxRetries: SDK_MAX_RETRIES,
      timeout: SDK_TIMEOUT_MS,
    })
    cache.set(tenant, { client: c, key: apiKey, mintedAt: Date.now() })
    return withProviderRouting(c)
  } catch (e) {
    console.warn(`[llm] tenant ${tenant} client lookup failed; legacy fallback`, e instanceof Error ? e.message : e)
    return withProviderRouting(legacyClient())
  }
}

/** Drop a tenant's cached client. Call from tier-change handlers so the
 *  next LLM hop picks up the swapped key / group. */
export function invalidateLlmClient(tenant: string): void {
  cache.delete(tenant)
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

  async function downloadAsB64(url: string): Promise<{ b64_json: string }> {
    // Download here and return b64_json instead of the URL: the caller's
    // fetchImageBytes SSRF guard DNS-pins the host, which breaks on fake-ip
    // VPN DNS (resolves to reserved ranges).
    const img = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!img.ok) throw new Error(`dashscope result download failed: ${img.status}`)
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
    if (!resp.ok) throw new Error(`dashscope multimodal-generation failed: ${resp.status} ${await resp.text()}`)
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
    })
    if (!create.ok) throw new Error(`dashscope task create failed: ${create.status} ${await create.text()}`)
    const created = (await create.json()) as DashscopeTaskResponse
    const taskId = created.output?.task_id
    if (!taskId) throw new Error(`dashscope task create returned no task_id: ${JSON.stringify(created)}`)

    const deadline = Date.now() + 180_000
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000))
      const poll = await fetch(`${base}/tasks/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` } })
      if (!poll.ok) throw new Error(`dashscope task poll failed: ${poll.status}`)
      const status = (await poll.json()) as DashscopeTaskResponse
      const state = status.output?.task_status
      if (state === 'SUCCEEDED') {
        const url = status.output?.results?.[0]?.url
        if (!url) throw new Error('dashscope task succeeded with no result url')
        return { data: [await downloadAsB64(url)] }
      }
      if (state === 'FAILED' || state === 'CANCELED') {
        throw new Error(`dashscope task ${state}: ${status.output?.message ?? 'no message'}`)
      }
      if (Date.now() > deadline) throw new Error('dashscope task timed out after 180s')
    }
  }

  async function generate(args: { model: string; prompt: string; size?: string; n?: number }) {
    // Fallback chain: primary model from the caller, then OPENAI_IMAGE_FALLBACK_MODELS
    // in order. Quota exhaustion / unknown model / transient failure all advance
    // the chain; the last error surfaces if every model fails.
    const fallbacks = (process.env.OPENAI_IMAGE_FALLBACK_MODELS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean)
    const chain = [args.model, ...fallbacks.filter((m) => m !== args.model)]
    let lastErr: unknown = null
    for (const model of chain) {
      try {
        if (model.startsWith('qwen-image')) {
          return await generateSync(model, args.prompt, args.size, args.n)
        }
        return await generateAsync(model, args.prompt, args.size, args.n)
      } catch (e) {
        lastErr = e
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
 *  Fallback chain mirrors dashscopeImageClient: primary model from
 *  OPENAI_AUDIO_MODEL, then OPENAI_AUDIO_FALLBACK_MODELS (comma-separated)
 *  in order; the last error surfaces if every model fails.
 *  Key comes from OPENAI_AUDIO_API_KEY, falling back to
 *  OPENAI_IMAGE_API_KEY (same Bailian key on this deployment). */
export async function transcribeAudio(audioBase64: string, format: string): Promise<string> {
  const apiKey = (process.env.OPENAI_AUDIO_API_KEY ?? '').trim() || (process.env.OPENAI_IMAGE_API_KEY ?? '').trim()
  if (!apiKey) throw new Error('OPENAI_AUDIO_API_KEY is not set (and no OPENAI_IMAGE_API_KEY fallback)')
  const primary = (process.env.OPENAI_AUDIO_MODEL ?? '').trim()
  if (!primary) throw new Error('OPENAI_AUDIO_MODEL is not set')
  const base = (process.env.OPENAI_AUDIO_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')
  const fallbacks = (process.env.OPENAI_AUDIO_FALLBACK_MODELS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  const chain = [primary, ...fallbacks.filter((m) => m !== primary)]
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
      if (!resp.ok) throw new Error(`asr request failed: ${resp.status} ${(await resp.text()).slice(0, 300)}`)
      const body = (await resp.json()) as { choices?: { message?: { content?: string } }[] }
      const text = body.choices?.[0]?.message?.content?.trim()
      if (!text) throw new Error(`asr returned no text: ${JSON.stringify(body).slice(0, 300)}`)
      return text
    } catch (e) {
      lastErr = e
      console.warn(`[asr] ${model} failed, trying next:`, e instanceof Error ? e.message.slice(0, 200) : e)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
