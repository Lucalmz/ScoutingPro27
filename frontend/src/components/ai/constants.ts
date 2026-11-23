export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

export const AI_PROFILE_DEFAULTS = {
  temperature: 0.4,
  maxTokens: 4096,
  enableThinking: true,
  thinkingBudget: 4096,
  anthropicVersion: DEFAULT_ANTHROPIC_VERSION,
  maxContextMsgs: 16
} as const

export const MIN_DOCK_WIDTH = 360
export const MAX_DOCK_WIDTH = 680
export const DEFAULT_DOCK_WIDTH = 420

export const AI_LAYOUT = {
  WIDE_DESKTOP_BREAKPOINT: 1120,
  SIDEBAR_DOCK_BREAKPOINT: 720,
  DUAL_COLUMN_CARD_BREAKPOINT: 520,
  DEFAULT_MOBILE_WIDTH: 390
} as const

export const API_KEY_ERR_LOST = 'ERR_KEY_LOST'
export const API_KEY_MASK_SENTINEL = '****'

export const DEFAULT_THREAD_TITLES = ['New Tactical Chat', '新战术分析'] as const

/**
 * Returns true if the stored/input API key is blank or a masked sentinel (`****`, `***`, `ERR_KEY_LOST`),
 * so plain HTTP payloads do not overwrite server-held encrypted keys and mismatch detectors stay quiet.
 */
export function isMaskedOrPlaceholderApiKey(raw?: string | null): boolean {
  const key = (raw || '').trim()
  return !key || key === API_KEY_MASK_SENTINEL || key === API_KEY_ERR_LOST || key.includes('***')
}

export function isZhLocale(locale?: string | null): boolean {
  return (locale || 'zh').toLowerCase().startsWith('zh')
}
