import type { AiProviderProfile } from '@/types'

export interface VoiceModelOption {
  id: string
  labelZh: string
  labelEn: string
}

export interface VoiceSpeakerOption {
  id: string
  labelZh: string
  labelEn: string
}

export type VoiceEngineKind = 'gemini-live' | 'openai-realtime' | 'turn-voice'
export type VoiceInputMode = 'vad' | 'ptt'

export interface VoiceCapability {
  tier: 'native-live' | 'turn-voice'
  engine: VoiceEngineKind
  defaultModel: string
  models: VoiceModelOption[]
  voices: VoiceSpeakerOption[]
  directSttSupported: boolean
  canForceOpenAiRealtime: boolean
}

export interface VoicePreferences {
  geminiModel: string
  geminiVoice: string
  openaiModel: string
  openaiVoice: string
  inputMode: VoiceInputMode
  sttHelperProfileId: string
  autoSpeakTurnVoice: boolean
  forceOpenAiRealtimeByProfile: Record<string, boolean>
}

export const VOICE_PREFS_STORAGE_KEY = 'sp27_ai_voice_prefs'

export const GEMINI_LIVE_MODELS: VoiceModelOption[] = [
  {
    id: 'gemini-3.8-live',
    labelZh: 'Gemini 3.8 Live（低延迟实时主力）',
    labelEn: 'Gemini 3.8 Live (Low-Latency Default)'
  },
  {
    id: 'gemini-3.8-live-extended-thinking',
    labelZh: 'Gemini 3.8 Live 深度思考',
    labelEn: 'Gemini 3.8 Live Extended Thinking'
  },
  {
    id: 'gemini-3.1-flash-live-preview',
    labelZh: 'Gemini 3.1 Flash Live Preview',
    labelEn: 'Gemini 3.1 Flash Live Preview'
  },
  {
    id: 'gemini-2.5-flash-native-audio-preview-12-2025',
    labelZh: 'Gemini 2.5 Flash Native Audio (兼容)',
    labelEn: 'Gemini 2.5 Flash Native Audio (Legacy)'
  }
]

export const GEMINI_VOICES: VoiceSpeakerOption[] = [
  { id: 'Kore', labelZh: 'Kore · 清晰稳重', labelEn: 'Kore · Firm' },
  { id: 'Puck', labelZh: 'Puck · 轻快活力', labelEn: 'Puck · Upbeat' },
  { id: 'Zephyr', labelZh: 'Zephyr · 明亮自然', labelEn: 'Zephyr · Bright' },
  { id: 'Aoede', labelZh: 'Aoede · 温和流畅', labelEn: 'Aoede · Breezy' },
  { id: 'Charon', labelZh: 'Charon · 沉稳低音', labelEn: 'Charon · Informative' },
  { id: 'Fenrir', labelZh: 'Fenrir · 干练果断', labelEn: 'Fenrir · Excitable' }
]

export const OPENAI_REALTIME_MODELS: VoiceModelOption[] = [
  {
    id: 'gpt-realtime',
    labelZh: 'GPT Realtime（GA 主力）',
    labelEn: 'GPT Realtime (GA)'
  },
  {
    id: 'gpt-realtime-mini',
    labelZh: 'GPT Realtime Mini（轻量高速）',
    labelEn: 'GPT Realtime Mini'
  },
  {
    id: 'gpt-4o-realtime-preview',
    labelZh: 'GPT-4o Realtime Preview',
    labelEn: 'GPT-4o Realtime Preview'
  }
]

export const OPENAI_VOICES: VoiceSpeakerOption[] = [
  { id: 'alloy', labelZh: 'Alloy · 均衡中性', labelEn: 'Alloy · Balanced' },
  { id: 'ash', labelZh: 'Ash · 干练沉稳', labelEn: 'Ash · Crisp' },
  { id: 'ballad', labelZh: 'Ballad · 细腻叙述', labelEn: 'Ballad · Expressive' },
  { id: 'coral', labelZh: 'Coral · 清晰亲和', labelEn: 'Coral · Warm' },
  { id: 'echo', labelZh: 'Echo · 稳健男声', labelEn: 'Echo · Resonant' },
  { id: 'sage', labelZh: 'Sage · 冷静理性', labelEn: 'Sage · Calm' },
  { id: 'shimmer', labelZh: 'Shimmer · 清亮活泼', labelEn: 'Shimmer · Bright' },
  { id: 'verse', labelZh: 'Verse · 自然流畅', labelEn: 'Verse · Versatile' }
]

export function isGeminiLiveModel(modelName?: string | null): boolean {
  if (!modelName) return false
  return /(live|native-audio)/i.test(modelName.trim())
}

export function isOpenAiRealtimeModel(modelName?: string | null): boolean {
  if (!modelName) return false
  return /realtime/i.test(modelName.trim())
}

export function isDirectSttCapableProfile(profile?: AiProviderProfile | null): boolean {
  if (!profile) return false
  if (profile.protocol === 'GEMINI') return true
  if (profile.protocol !== 'OPENAI') return false
  const url = (profile.baseUrl || '').toLowerCase()
  const preset = (profile.presetId || '').toLowerCase()
  return (
    !url ||
    url.includes('api.openai.com') ||
    preset === 'openai' ||
    preset === 'groq' ||
    url.includes('groq.com') ||
    preset === 'siliconflow' ||
    url.includes('siliconflow')
  )
}

export function resolveVoiceCapability(
  profile: AiProviderProfile | null,
  forceOpenAiRealtime = false
): VoiceCapability {
  if (!profile) {
    return {
      tier: 'turn-voice',
      engine: 'turn-voice',
      defaultModel: '',
      models: [],
      voices: [],
      directSttSupported: false,
      canForceOpenAiRealtime: false
    }
  }

  if (profile.protocol === 'GEMINI') {
    const defaultModel = isGeminiLiveModel(profile.modelName)
      ? profile.modelName.trim()
      : GEMINI_LIVE_MODELS[0]!.id
    return {
      tier: 'native-live',
      engine: 'gemini-live',
      defaultModel,
      models: GEMINI_LIVE_MODELS,
      voices: GEMINI_VOICES,
      directSttSupported: true,
      canForceOpenAiRealtime: false
    }
  }

  if (profile.protocol === 'OPENAI') {
    const url = (profile.baseUrl || '').toLowerCase()
    const preset = (profile.presetId || '').toLowerCase()
    const isOfficialOpenAi = !url || url.includes('api.openai.com') || preset === 'openai'
    const hasRealtimeModel = isOpenAiRealtimeModel(profile.modelName)
    const useRealtime = isOfficialOpenAi || hasRealtimeModel || forceOpenAiRealtime
    const directStt = isDirectSttCapableProfile(profile)

    if (useRealtime) {
      return {
        tier: 'native-live',
        engine: 'openai-realtime',
        defaultModel: hasRealtimeModel ? profile.modelName.trim() : OPENAI_REALTIME_MODELS[0]!.id,
        models: OPENAI_REALTIME_MODELS,
        voices: OPENAI_VOICES,
        directSttSupported: true,
        canForceOpenAiRealtime: !isOfficialOpenAi && !hasRealtimeModel
      }
    }

    return {
      tier: 'turn-voice',
      engine: 'turn-voice',
      defaultModel: profile.modelName || '',
      models: OPENAI_REALTIME_MODELS,
      voices: OPENAI_VOICES,
      directSttSupported: directStt,
      canForceOpenAiRealtime: true
    }
  }

  return {
    tier: 'turn-voice',
    engine: 'turn-voice',
    defaultModel: profile.modelName || '',
    models: [],
    voices: [],
    directSttSupported: false,
    canForceOpenAiRealtime: false
  }
}

export function findBestSttHelperProfiles(profiles: AiProviderProfile[]): AiProviderProfile[] {
  const scoreProfile = (p: AiProviderProfile): number => {
    if (p.protocol === 'ANTHROPIC') return -1
    const url = (p.baseUrl || '').toLowerCase()
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url)
    if (!p.hasApiKey && !isLoopback) return -1

    let score = 0
    if (p.protocol === 'GEMINI') {
      score = 100
    } else if (p.protocol === 'OPENAI') {
      if (!url || url.includes('api.openai.com') || p.presetId === 'openai') score = 90
      else if (p.presetId === 'groq' || url.includes('groq.com')) score = 85
      else if (p.presetId === 'siliconflow' || url.includes('siliconflow')) score = 80
      else if (p.hasApiKey) score = 40
      else score = 10
    }
    if (p.isActive) score += 5
    return score
  }

  return profiles
    .map(profile => ({ profile, score: scoreProfile(profile) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.profile)
}

export function stripMarkdownForSpeech(raw: string): string {
  if (!raw) return ''
  let text = raw
  // Remove fenced code blocks completely so TTS does not read syntax punctuation
  text = text.replace(/```[\s\S]*?```/g, ' ')
  // Replace inline code with inner text
  text = text.replace(/`([^`]+)`/g, '$1')
  // Convert markdown links [label](url) -> label
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // Strip images ![alt](url) -> alt
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
  // Remove Markdown table divider rows like ---|---|---
  text = text.replace(/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/gm, ' ')
  // Replace table pipes with brief comma/space pauses
  text = text.replace(/\|/g, '，')
  // Strip heading hashes, blockquotes, and list bullets at line start
  text = text.replace(/^\s{0,3}(?:#{1,6}|>+)\s*/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+\.\s+/gm, '')
  // Remove bold/italic/strikethrough markers
  text = text.replace(/(\*\*\*|___|\*\*|__|~~|\*|_)/g, '')
  // Make team chips sound natural when spoken: `#27570` -> `27570`
  text = text.replace(/#(\d{1,6})\b/g, '$1')
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()
  return text
}

export function defaultVoicePrefs(): VoicePreferences {
  return {
    geminiModel: GEMINI_LIVE_MODELS[0]!.id,
    geminiVoice: GEMINI_VOICES[0]!.id,
    openaiModel: OPENAI_REALTIME_MODELS[0]!.id,
    openaiVoice: OPENAI_VOICES[0]!.id,
    inputMode: 'vad',
    sttHelperProfileId: '',
    autoSpeakTurnVoice: true,
    forceOpenAiRealtimeByProfile: {}
  }
}

export function loadVoicePrefs(): VoicePreferences {
  const defaults = defaultVoicePrefs()
  if (typeof localStorage === 'undefined') return defaults
  try {
    const raw = localStorage.getItem(VOICE_PREFS_STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return defaults
    return {
      geminiModel: typeof parsed.geminiModel === 'string' && parsed.geminiModel.trim() ? parsed.geminiModel : defaults.geminiModel,
      geminiVoice: typeof parsed.geminiVoice === 'string' && parsed.geminiVoice.trim() ? parsed.geminiVoice : defaults.geminiVoice,
      openaiModel: typeof parsed.openaiModel === 'string' && parsed.openaiModel.trim() ? parsed.openaiModel : defaults.openaiModel,
      openaiVoice: typeof parsed.openaiVoice === 'string' && parsed.openaiVoice.trim() ? parsed.openaiVoice : defaults.openaiVoice,
      inputMode: parsed.inputMode === 'ptt' ? 'ptt' : 'vad',
      sttHelperProfileId: typeof parsed.sttHelperProfileId === 'string' ? parsed.sttHelperProfileId : '',
      autoSpeakTurnVoice: parsed.autoSpeakTurnVoice !== false,
      forceOpenAiRealtimeByProfile:
        parsed.forceOpenAiRealtimeByProfile && typeof parsed.forceOpenAiRealtimeByProfile === 'object'
          ? parsed.forceOpenAiRealtimeByProfile
          : {}
    }
  } catch {
    return defaults
  }
}

export function saveVoicePrefs(prefs: VoicePreferences): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(VOICE_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Ignore storage quota errors
  }
}
