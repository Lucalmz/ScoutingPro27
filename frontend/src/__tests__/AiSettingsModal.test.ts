import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import AiSettingsModal from '@/components/ai/AiSettingsModal.vue'
import { i18n } from '@/i18n'
import { useUserStore } from '@/stores/user'
import { useAiStore } from '@/stores/ai'

describe('AiSettingsModal.vue', () => {
  const origLocale = i18n.global.locale.value
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    i18n.global.locale.value = 'zh'

    const userStore = useUserStore()
    userStore.$patch({
      user: { id: 'u1', username: 'coach', token: 'jwt-test-token' }
    })

    fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/users/u1/ai-profiles' && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url === '/api/users/u1/ai-profiles' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'))
        return new Response(
          JSON.stringify({
            id: body.id || 'prof-saved-1',
            userId: 'u1',
            name: body.name || 'Saved Profile',
            presetId: body.presetId || 'ollama',
            protocol: body.protocol || 'OPENAI',
            baseUrl: body.baseUrl || '',
            modelName: body.modelName || '',
            customModels: body.customModels || [],
            hasApiKey: Boolean(body.apiKeyEncrypted),
            apiKeyEncrypted: body.apiKeyEncrypted ? '****' : '',
            isActive: true
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/ai/models') {
        return new Response(
          JSON.stringify({
            success: true,
            modelsSupported: true,
            models: ['gemini-flash-latest', 'gemini-pro-latest', 'gemini-2.5-pro'],
            latencyMs: 42
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/ai/test-connection') {
        return new Response(
          JSON.stringify({
            success: true,
            statusCode: 200,
            latencyMs: 38,
            models: ['deepseek-chat'],
            message: 'OK'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()!.unmount()
    i18n.global.locale.value = origLocale
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('uses native <dialog> without redundant role="dialog" or aria-modal and handles 3-protocol + mismatch + custom models', async () => {
    const aiStore = useAiStore()
    const wrapper = track(mount(AiSettingsModal, {
      global: { plugins: [i18n] }
    }))

    aiStore.openSettingsModal()
    await flushPromises()
    await nextTick()

    const dialog = wrapper.find('dialog.ai-settings-dialog')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('role')).toBeUndefined()
    expect(dialog.attributes('aria-modal')).toBeUndefined()
    expect(dialog.attributes('closedby')).toBe('any')
    expect(dialog.attributes('aria-label')).toMatch(/\S+/)
    expect(dialog.attributes('open')).toBeDefined()

    // Switch to GEMINI protocol tab -> defaults to 3 -latest models
    const protoBtns = wrapper.findAll('.proto-tab-btn')
    expect(protoBtns.length).toBe(3)
    await protoBtns[1]!.trigger('click')
    const modelInput = wrapper.find('#ai-model-name')
    expect((modelInput.element as HTMLInputElement).value).toBe('gemini-flash-latest')
    const chips = wrapper.findAll('.model-chip-select').map(b => b.text())
    expect(chips.some(c => c.includes('gemini-flash-latest'))).toBe(true)
    expect(chips.some(c => c.includes('gemini-pro-latest'))).toBe(true)
    expect(chips.some(c => c.includes('gemini-flash-lite-latest'))).toBe(true)

    // Pin custom model + remove a chip
    await modelInput.setValue('my-custom-gemini-fork')
    const pinBtn = wrapper.find('.model-label-actions .btn-mini-action:not(.fetch-btn)')
    await pinBtn.trigger('click')
    expect(wrapper.findAll('.model-chip-select').map(b => b.text())).toContain('my-custom-gemini-fork')

    const removeButtons = wrapper.findAll('.model-chip-remove')
    await removeButtons[0]!.trigger('click')
    expect(wrapper.findAll('.model-chip-select').length).toBe(3)

    // Fetch live models opens searchable picker
    await wrapper.find('.fetch-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.fetched-models-drawer').exists()).toBe(true)
    await wrapper.find('.fetched-header input').setValue('2.5')
    expect(wrapper.findAll('.fetched-row').length).toBe(1)

    // Vendor guide toggle & 1-click fill
    await wrapper.find('.btn-link-guide').trigger('click')
    expect(wrapper.find('.vendor-guide-card').exists()).toBe(true)
    await wrapper.find('.btn-fill-vendor').trigger('click')
    expect(wrapper.find('.vendor-guide-card').exists()).toBe(false)

    // Non-blocking KEY mismatch nudge: enter sk-ant- under OPENAI -> suggests Claude/ANTHROPIC
    await protoBtns[0]!.trigger('click')
    await wrapper.find('#ai-api-key').setValue('sk-ant-api03-mismatch-test-12345')
    expect(wrapper.find('.mismatch-nudge').exists()).toBe(true)
    await wrapper.find('.btn-switch-suggested').trigger('click')
    expect(wrapper.findAll('.proto-tab-btn')[2]!.classes()).toContain('active')
    expect((wrapper.find('#ai-api-key').element as HTMLInputElement).value).toBe('sk-ant-api03-mismatch-test-12345')
    expect(wrapper.find('.mismatch-nudge').exists()).toBe(false)
  })

  it('allows saving local Ollama profile with empty API key via local loopback bypass', async () => {
    const aiStore = useAiStore()
    const wrapper = track(mount(AiSettingsModal, {
      global: { plugins: [i18n] }
    }))

    aiStore.openSettingsModal()
    await flushPromises()
    await nextTick()

    await wrapper.findAll('.proto-tab-btn')[0]!.trigger('click')
    await wrapper.find('#ai-base-url').setValue('http://127.0.0.1:11434/v1')
    await wrapper.find('#ai-base-url').trigger('input')
    await wrapper.find('#ai-api-key').setValue('')
    await wrapper.find('#ai-model-name').setValue('qwen2.5:14b')

    expect(wrapper.find('.local-bypass-badge').exists()).toBe(true)
    expect(wrapper.find('.optional-tag').exists()).toBe(true)

    await wrapper.find('.btn-primary-save').trigger('click')
    await flushPromises()

    const saveCall = fetchMock.mock.calls.find(
      c => c[0] === '/api/users/u1/ai-profiles' && c[1]?.method === 'POST'
    )
    expect(saveCall).toBeDefined()
    const sentBody = JSON.parse(String(saveCall![1].body))
    expect(sentBody.protocol).toBe('OPENAI')
    expect(sentBody.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(sentBody.modelName).toBe('qwen2.5:14b')
    expect(aiStore.settingsModalOpen).toBe(false)
  })
})
