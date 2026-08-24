import { describe, it, expect } from 'vitest'
import { OPENAI_PRESETS, findPresetByBaseUrl, getPresetById } from '@/components/ai/presets'

describe('OpenAI Presets', () => {
  it('contains essential provider presets including DeepSeek, OpenAI, SiliconFlow, Kimi, Zhipu, DashScope, Ollama', () => {
    const ids = OPENAI_PRESETS.map(p => p.id)
    expect(ids).toContain('deepseek')
    expect(ids).toContain('openai')
    expect(ids).toContain('siliconflow')
    expect(ids).toContain('moonshot')
    expect(ids).toContain('zhipu')
    expect(ids).toContain('dashscope')
    expect(ids).toContain('ollama')
    expect(ids).toContain('custom')
  })

  it('correctly maps DeepSeek preset details', () => {
    const deepseek = getPresetById('deepseek')
    expect(deepseek).toBeDefined()
    expect(deepseek.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(deepseek.defaultModel).toBe('deepseek-chat')
    expect(deepseek.models).toContain('deepseek-chat')
    expect(deepseek.models).toContain('deepseek-reasoner')
    expect(deepseek.apiKeyUrl).toBe('https://platform.deepseek.com/api_keys')
  })

  it('finds preset by exact or normalized Base URL', () => {
    expect(findPresetByBaseUrl('https://api.deepseek.com/v1').id).toBe('deepseek')
    expect(findPresetByBaseUrl('https://api.deepseek.com/v1/').id).toBe('deepseek')
    expect(findPresetByBaseUrl('https://api.deepseek.com').id).toBe('deepseek')
    expect(findPresetByBaseUrl('https://api.siliconflow.cn/v1').id).toBe('siliconflow')
    expect(findPresetByBaseUrl('https://open.bigmodel.cn/api/paas/v4').id).toBe('zhipu')
    expect(findPresetByBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1').id).toBe('dashscope')
    expect(findPresetByBaseUrl('http://localhost:11434/v1').id).toBe('ollama')
    expect(findPresetByBaseUrl('https://api.openai.com/v1').id).toBe('openai')
  })

  it('returns custom for unrecognized Base URL', () => {
    const custom = findPresetByBaseUrl('https://my-custom-proxy.internal/api')
    expect(custom.id).toBe('custom')
  })

  it('defaults to first preset or OpenAI if empty Base URL provided', () => {
    const preset = findPresetByBaseUrl('')
    expect(preset).toBeDefined()
    expect(preset.id).toBe('deepseek')
  })

  it('has valid translation keys for all presets in both zh.json and en.json', async () => {
    const zh = (await import('@/locales/zh.json')).default
    const en = (await import('@/locales/en.json')).default

    expect(zh.ai).toBeDefined()
    expect(en.ai).toBeDefined()

    for (const preset of OPENAI_PRESETS) {
      expect((zh.ai.presets as any)[preset.id]).toBeDefined()
      expect((en.ai.presets as any)[preset.id]).toBeDefined()
    }
  })
})
