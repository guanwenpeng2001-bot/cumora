/** Known gateway/direct platforms — UI labels only, not a closed union. */
export const API_MODEL_PLATFORM_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  grok: 'Grok',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  zhipu: 'Zhipu',
  minimax: 'MiniMax',
  composite: 'Composite',
  dashscope: 'DashScope',
  novita: 'Novita',
  orcarouter: 'OrcaRouter',
  'chatgpt-web': 'ChatGPT Web',
  google: 'Google',
  xai: 'xAI',
}

export function modelPlatformLabel(platform: string): string {
  const key = platform.trim().toLowerCase()
  return API_MODEL_PLATFORM_LABELS[key] ?? platform
}
