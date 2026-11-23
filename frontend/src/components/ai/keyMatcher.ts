import type { AiProtocol } from '@/types'
import { isMaskedOrPlaceholderApiKey } from '@/components/ai/constants'
import {
  ANTHROPIC_PRESETS,
  CUSTOM_PRESET,
  DEFAULT_PRESET,
  GEMINI_PRESETS,
  OPENAI_PRESETS,
  type OpenAiPreset
} from '@/components/ai/protocolCatalog'

export interface KeyMismatchHint {
  suggestedProtocol: AiProtocol
  confidence: 'high' | 'medium'
  reasonKey: string
}

export function getPresetsForProtocol(protocol: AiProtocol): OpenAiPreset[] {
  if (protocol === 'GEMINI') return GEMINI_PRESETS
  if (protocol === 'ANTHROPIC') return ANTHROPIC_PRESETS
  return OPENAI_PRESETS
}

function normalizeUrl(url?: string): string {
  if (!url) return ''
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

export function isLocalBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl || !baseUrl.trim()) return false
  try {
    const parsed = new URL(baseUrl.trim())
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.localhost')
  } catch {
    const lower = baseUrl.trim().toLowerCase()
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/.test(lower)
  }
}

/**
 * Non-blocking API key style detector: nudges the user when an obvious official prefix
 * belongs to a different protocol family without ever preventing saving custom relay keys.
 */
export function detectKeyProtocolMismatch(rawKey: string, currentProtocol: AiProtocol): KeyMismatchHint | null {
  const key = (rawKey || '').trim()
  if (isMaskedOrPlaceholderApiKey(key) || key.length < 8) {
    return null
  }
  if (/^sk-ant-/i.test(key)) {
    if (currentProtocol !== 'ANTHROPIC') {
      return {
        suggestedProtocol: 'ANTHROPIC',
        confidence: 'high',
        reasonKey: 'ai.key_mismatch_anthropic'
      }
    }
    return null
  }
  if (/^AIza/.test(key)) {
    if (currentProtocol !== 'GEMINI') {
      return {
        suggestedProtocol: 'GEMINI',
        confidence: 'high',
        reasonKey: 'ai.key_mismatch_gemini'
      }
    }
    return null
  }
  if (/^(sk-proj-|sk-svcacct-|sk-or-|gsk_|xai-)/i.test(key)) {
    if (currentProtocol !== 'OPENAI') {
      return {
        suggestedProtocol: 'OPENAI',
        confidence: 'high',
        reasonKey: 'ai.key_mismatch_openai'
      }
    }
    return null
  }
  if (/^sk-[a-zA-Z0-9_-]{16,}$/.test(key)) {
    if (currentProtocol === 'GEMINI') {
      return {
        suggestedProtocol: 'OPENAI',
        confidence: 'medium',
        reasonKey: 'ai.key_hint_sk_generic'
      }
    }
  }
  return null
}

/**
 * Finds matching preset by baseUrl across OpenAI or given protocol presets.
 */
export function findPresetByBaseUrl(baseUrl?: string, protocol: AiProtocol = 'OPENAI'): OpenAiPreset {
  const list = getPresetsForProtocol(protocol)
  if (!baseUrl || !baseUrl.trim()) {
    return list[0] || DEFAULT_PRESET
  }

  const normalized = normalizeUrl(baseUrl)
  const direct = list.find(p => p.baseUrl && normalizeUrl(p.baseUrl) === normalized)
  if (direct) return direct

  if (protocol === 'GEMINI') {
    return (normalized.includes('googleapis.com') ? GEMINI_PRESETS[0] : GEMINI_PRESETS[1]) ?? CUSTOM_PRESET
  }
  if (protocol === 'ANTHROPIC') {
    if (normalized.includes('deepseek.com')) return getPresetById('anthropic-deepseek', 'ANTHROPIC')
    if (normalized.includes('moonshot.cn')) return getPresetById('anthropic-moonshot', 'ANTHROPIC')
    if (normalized.includes('bigmodel.cn') || normalized.includes('api.z.ai')) return getPresetById('anthropic-zhipu', 'ANTHROPIC')
    if (normalized.includes('minimaxi.com') || normalized.includes('minimax.io')) return getPresetById('anthropic-minimax', 'ANTHROPIC')
    if (normalized.includes('dashscope.aliyuncs.com')) return getPresetById('anthropic-dashscope', 'ANTHROPIC')
    if (normalized.includes('anthropic.com')) return getPresetById('anthropic-official', 'ANTHROPIC')
    return getPresetById('anthropic-custom', 'ANTHROPIC')
  }

  if (normalized.includes('api.deepseek.com')) return getPresetById('deepseek')
  if (normalized.includes('siliconflow')) return getPresetById('siliconflow')
  if (normalized.includes('moonshot.cn')) return getPresetById('moonshot')
  if (normalized.includes('bigmodel.cn')) return getPresetById('zhipu')
  if (normalized.includes('dashscope.aliyuncs.com')) return getPresetById('dashscope')
  if (normalized.includes('volces.com')) return getPresetById('ark')
  if (normalized.includes('openrouter.ai')) return getPresetById('openrouter')
  if (normalized.includes('baichuan-ai.com')) return getPresetById('baichuan')
  if (normalized.includes('api.groq.com')) return getPresetById('groq')
  if (normalized.includes('mistral.ai')) return getPresetById('mistral')
  if (normalized.includes('11434') || isLocalBaseUrl(baseUrl)) return getPresetById('ollama')
  if (normalized.includes('api.openai.com')) return getPresetById('openai')

  return CUSTOM_PRESET
}

export function getPresetById(id: string, protocol?: AiProtocol): OpenAiPreset {
  if (protocol) {
    const list = getPresetsForProtocol(protocol)
    const hit = list.find(p => p.id === id)
    if (hit) return hit
  }
  const all = [...OPENAI_PRESETS, ...GEMINI_PRESETS, ...ANTHROPIC_PRESETS]
  const matched = all.find(p => p.id === id)
  return matched ?? DEFAULT_PRESET
}
