import { resolveDirectLlmEnv, type DirectLlmSlot } from '../../env.js'
import type { DirectSource } from '../inventory.js'

/** Provider evidence comes from the endpoint, never the compatibility slot name. */
export function endpointProvider(endpoint: string): string {
  try {
    const host = new URL(endpoint).hostname
    for (const [suffix, provider] of [['deepseek.com', 'deepseek'], ['kimi.com', 'kimi'], ['moonshot.cn', 'kimi'], ['aliyuncs.com', 'dashscope'], ['openai.com', 'openai'], ['x.ai', 'xai'], ['novita.ai', 'novita']]) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return provider
    }
  } catch { /* unknown endpoint */ }
  return 'unknown'
}
export function readEnvSources(): DirectSource[] {
  return (['text', 'image', 'audio', 'embed', 'novita', 'orcarouter'] as DirectLlmSlot[]).map(slot => {
    const resolved = resolveDirectLlmEnv(slot)
    const prefix = slot === 'text' ? 'OPENAI' : ['novita', 'orcarouter'].includes(slot) ? slot.toUpperCase() : `OPENAI_${slot.toUpperCase()}`
    const modelRefs = [`${prefix}_MODEL`]
    if (slot === 'text') modelRefs.push('OPENAI_MODEL_SUPPORT', 'OPENAI_COMPACTION_MODEL')
    if (['image', 'audio'].includes(slot)) modelRefs.push(`${prefix}_FALLBACK_MODELS`)
    if (['novita', 'orcarouter'].includes(slot)) modelRefs.push('OPENAI_MODEL', 'OPENAI_MODEL_SUPPORT', 'OPENAI_COMPACTION_MODEL')
    const models = modelRefs.flatMap(ref => (process.env[ref] ?? '').split(',').map(v => v.trim()).filter(Boolean).flatMap(model => {
      const match = /^(novita|orcarouter)\/(.+)$/.exec(model)
      if (match) return match[1] === slot ? [match[2]] : []
      return ref.startsWith(prefix) ? [model] : []
    }))
    return { slot, provider: endpointProvider(resolved.baseURL), models: [...new Set(models)],
      configured: resolved.configured, protocol: resolved.protocol, keyRef: resolved.keySource, endpointRef: resolved.endpointSource, modelRefs }
  })
}
