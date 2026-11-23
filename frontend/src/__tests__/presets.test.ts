import { afterEach, describe, it, expect } from 'vitest'
import { i18n } from '@/i18n'
import {
  GEMINI_DEFAULT_MODELS,
  GEMINI_MODEL_TIERS,
  PROTOCOL_META,
  VENDOR_PROTOCOL_GUIDE,
  OPENAI_PRESETS,
  GEMINI_PRESETS,
  ANTHROPIC_PRESETS,
  getPresetsForProtocol,
  isLocalBaseUrl,
  detectKeyProtocolMismatch,
  findPresetByBaseUrl,
  getPresetById
} from '@/components/ai/presets'
import { isMaskedOrPlaceholderApiKey } from '@/components/ai/constants'
import { buildMatchBriefPrompt, buildTeamAnalysisPrompt } from '@/components/ai/personas'

const CJK_RE = /[\u4e00-\u9fa5]/

describe('ai presets & 3-protocol catalog', () => {
  const origLocale = i18n.global.locale.value

  afterEach(() => {
    i18n.global.locale.value = origLocale
  })

  it('provides Gemini 3 default -latest aliases and tier descriptions', () => {
    expect(GEMINI_DEFAULT_MODELS).toEqual([
      'gemini-flash-latest',
      'gemini-pro-latest',
      'gemini-flash-lite-latest'
    ])
    for (const model of GEMINI_DEFAULT_MODELS) {
      expect(GEMINI_MODEL_TIERS[model]).toBeDefined()
      expect(GEMINI_MODEL_TIERS[model]!.zh.length).toBeGreaterThan(0)
      expect(GEMINI_MODEL_TIERS[model]!.en.length).toBeGreaterThan(0)
    }
    const officialGemini = getPresetById('gemini-official', 'GEMINI')
    expect(officialGemini.models).toEqual(GEMINI_DEFAULT_MODELS)
    expect(officialGemini.baseUrl).toContain('generativelanguage.googleapis.com/v1beta')
  })

  it('defines metadata and bilingual vendor protocol guide without CJK leaks in English fields', () => {
    expect(Object.keys(PROTOCOL_META).sort()).toEqual(['ANTHROPIC', 'GEMINI', 'OPENAI'])
    expect(PROTOCOL_META.OPENAI.authHeader).toContain('Authorization: Bearer')
    expect(PROTOCOL_META.GEMINI.authHeader).toContain('x-goog-api-key')
    expect(PROTOCOL_META.ANTHROPIC.authHeader).toContain('x-api-key')

    expect(getPresetsForProtocol('OPENAI')).toBe(OPENAI_PRESETS)
    expect(getPresetsForProtocol('GEMINI')).toBe(GEMINI_PRESETS)
    expect(getPresetsForProtocol('ANTHROPIC')).toBe(ANTHROPIC_PRESETS)

    const coveredProtocols = new Set(VENDOR_PROTOCOL_GUIDE.map(r => r.protocol))
    expect(coveredProtocols).toEqual(new Set(['OPENAI', 'GEMINI', 'ANTHROPIC']))
    expect(VENDOR_PROTOCOL_GUIDE.some(r => r.vendor.includes('DeepSeek'))).toBe(true)
    expect(VENDOR_PROTOCOL_GUIDE.some(r => r.vendor.includes('Ollama'))).toBe(true)

    for (const row of VENDOR_PROTOCOL_GUIDE) {
      expect(row.vendorZh.trim().length).toBeGreaterThan(0)
      expect(row.vendorEn.trim().length).toBeGreaterThan(0)
      expect(row.vendorEn).not.toMatch(CJK_RE)
      expect(row.notesEn).not.toMatch(CJK_RE)
      expect(row.protocolLabelEn).not.toMatch(CJK_RE)
      expect(row.keyFormat).not.toMatch(CJK_RE)
    }
  })

  it('recognizes loopback base URLs across IPv4/IPv6/localhost cleanly', () => {
    expect(isLocalBaseUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLocalBaseUrl('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLocalBaseUrl('http://[::1]:11434/v1')).toBe(true)
    expect(isLocalBaseUrl('http://ollama.localhost:11434/v1')).toBe(true)

    expect(isLocalBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isLocalBaseUrl('https://api.deepseek.com')).toBe(false)
    expect(isLocalBaseUrl('')).toBe(false)
    expect(isLocalBaseUrl(undefined)).toBe(false)
  })

  it('identifies masked, empty, and error-sentinel API keys via shared helper', () => {
    expect(isMaskedOrPlaceholderApiKey('')).toBe(true)
    expect(isMaskedOrPlaceholderApiKey('   ')).toBe(true)
    expect(isMaskedOrPlaceholderApiKey(null)).toBe(true)
    expect(isMaskedOrPlaceholderApiKey(undefined)).toBe(true)
    expect(isMaskedOrPlaceholderApiKey('****')).toBe(true)
    expect(isMaskedOrPlaceholderApiKey('sk-a***5678')).toBe(true)
    expect(isMaskedOrPlaceholderApiKey('ERR_KEY_LOST')).toBe(true)
    expect(isMaskedOrPlaceholderApiKey('sk-real-key-123456')).toBe(false)
  })

  it('detects protocol mismatch non-blockingly for sk-ant-, AIza, sk-proj/gsk_/xai-, and generic sk- prefixes', () => {
    expect(detectKeyProtocolMismatch('sk-ant-api03-abcdef123456', 'OPENAI')?.suggestedProtocol).toBe('ANTHROPIC')
    expect(detectKeyProtocolMismatch('sk-ant-api03-abcdef123456', 'GEMINI')?.suggestedProtocol).toBe('ANTHROPIC')
    expect(detectKeyProtocolMismatch('sk-ant-api03-abcdef123456', 'ANTHROPIC')).toBeNull()

    expect(detectKeyProtocolMismatch('AIzaSyDummyGoogleKey1234567890', 'OPENAI')?.suggestedProtocol).toBe('GEMINI')
    expect(detectKeyProtocolMismatch('AIzaSyDummyGoogleKey1234567890', 'ANTHROPIC')?.suggestedProtocol).toBe('GEMINI')
    expect(detectKeyProtocolMismatch('AIzaSyDummyGoogleKey1234567890', 'GEMINI')).toBeNull()

    expect(detectKeyProtocolMismatch('sk-proj-abc1234567890', 'GEMINI')?.suggestedProtocol).toBe('OPENAI')
    expect(detectKeyProtocolMismatch('gsk_abc1234567890', 'ANTHROPIC')?.suggestedProtocol).toBe('OPENAI')
    expect(detectKeyProtocolMismatch('xai-abc1234567890', 'GEMINI')?.suggestedProtocol).toBe('OPENAI')
    expect(detectKeyProtocolMismatch('sk-or-v1-abc1234567890', 'GEMINI')?.suggestedProtocol).toBe('OPENAI')
    expect(detectKeyProtocolMismatch('sk-proj-abc1234567890', 'OPENAI')).toBeNull()

    const skHint = detectKeyProtocolMismatch('sk-1234567890abcdefghij', 'GEMINI')
    expect(skHint?.suggestedProtocol).toBe('OPENAI')
    expect(skHint?.confidence).toBe('medium')

    expect(detectKeyProtocolMismatch('sk-a***5678', 'GEMINI')).toBeNull()
    expect(detectKeyProtocolMismatch('****', 'GEMINI')).toBeNull()
    expect(detectKeyProtocolMismatch('ERR_KEY_LOST', 'OPENAI')).toBeNull()
    expect(detectKeyProtocolMismatch('short', 'GEMINI')).toBeNull()
  })

  it('finds matching presets by protocol and base URL including vendor anthropic mirrors', () => {
    expect(findPresetByBaseUrl('https://api.deepseek.com/anthropic', 'ANTHROPIC').id).toBe('anthropic-deepseek')
    expect(findPresetByBaseUrl('https://api.moonshot.cn/anthropic/', 'ANTHROPIC').id).toBe('anthropic-moonshot')
    expect(findPresetByBaseUrl('https://open.bigmodel.cn/api/anthropic', 'ANTHROPIC').id).toBe('anthropic-zhipu')
    expect(findPresetByBaseUrl('http://localhost:11434/v1', 'OPENAI').id).toBe('ollama')
    expect(findPresetByBaseUrl('https://my-gemini-proxy.example.com/v1beta', 'GEMINI').id).toBe('gemini-custom')
  })

  it('builds localized tactical prompts for team deep-dive and match brief shortcuts', () => {
    const teamZh = buildTeamAnalysisPrompt(27570, 'zh')
    const teamEn = buildTeamAnalysisPrompt(27570, 'en')
    expect(teamZh).toContain('#27570')
    expect(teamZh).toMatch(CJK_RE)
    expect(teamEn).toContain('#27570')
    expect(teamEn).not.toMatch(CJK_RE)

    const sched = {
      id: 'm1',
      eventId: 'e1',
      matchNumber: 12,
      tournamentLevel: 'QUALIFICATION' as const,
      red1: 27570,
      red2: 12345,
      blue1: 8888,
      blue2: 9999
    }
    const matchZh = buildMatchBriefPrompt(sched, 'zh')
    const matchEn = buildMatchBriefPrompt(sched, 'en')
    expect(matchZh).toContain('Q12')
    expect(matchZh).toContain('#27570')
    expect(matchEn).toContain('Q12')
    expect(matchEn).not.toMatch(CJK_RE)
  })
})

describe('vue-i18n ai.* compilation check (zh & en)', () => {
  it('compiles and formats every ai.* translation key in both zh and en without SyntaxError or CJK in en', async () => {
    const { i18n } = await import('@/i18n')
    const zhMsgs = (await import('@/locales/zh.json')).default as Record<string, any>
    const enMsgs = (await import('@/locales/en.json')).default as Record<string, any>

    const flattenEntries = (
      obj: Record<string, any>,
      prefix = ''
    ): Array<{ key: string; value: string }> => {
      const items: Array<{ key: string; value: string }> = []
      for (const [k, v] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${k}` : k
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          items.push(...flattenEntries(v, full))
        } else {
          items.push({ key: full, value: String(v) })
        }
      }
      return items
    }

    const zhEntries = flattenEntries(zhMsgs.ai || {}, 'ai')
    const enEntries = flattenEntries(enMsgs.ai || {}, 'ai')
    const aiKeys = zhEntries.map(e => e.key)
    const enAiKeys = enEntries.map(e => e.key)

    expect(aiKeys.length).toBeGreaterThan(100)
    expect(aiKeys.sort()).toEqual(enAiKeys.sort())

    for (const { key, value } of enEntries) {
      expect(value, `Expected zero CJK characters in en.json key ${key}`).not.toMatch(CJK_RE)
    }

    const dummyParams = {
      team: '27570',
      match: 'Q12',
      title: 'Thread 1',
      sec: '1.2',
      protocol: 'Claude',
      count: 3,
      k: '1.4',
      in: 10,
      out: 5,
      tokens: 8,
      rank: 1,
      status: 404
    }

    for (const loc of ['zh', 'en'] as const) {
      i18n.global.locale.value = loc
      for (const key of aiKeys) {
        expect(() => i18n.global.t(key, dummyParams)).not.toThrow()
        const rendered = i18n.global.t(key, dummyParams)
        expect(rendered).not.toBe(key)
      }
    }
  })
})
