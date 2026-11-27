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

  it('defaults enableThinking to false when hydrating undefined/false and exposes thinkingBudget for GEMINI & ANTHROPIC', async () => {
    const aiStore = useAiStore()
    aiStore.profiles = [
      {
        id: 'prof-gemini-1',
        userId: 'u1',
        name: 'Gemini Default',
        presetId: 'gemini-official',
        protocol: 'GEMINI',
        apiKeyEncrypted: 'AIza****1234',
        hasApiKey: true,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        modelName: 'gemini-flash-latest',
        customModels: ['gemini-flash-latest'],
        systemPrompt: '',
        temperature: 0.4,
        maxTokens: 4096,
        enableThinking: undefined as unknown as boolean,
        thinkingBudget: 4096,
        anthropicVersion: '2023-06-01',
        maxContextMsgs: 16,
        proxyHost: '',
        proxyPort: null,
        isActive: true
      }
    ]

    const wrapper = track(mount(AiSettingsModal, {
      global: { plugins: [i18n] }
    }))

    aiStore.openSettingsModal('prof-gemini-1')
    await flushPromises()
    await nextTick()

    await wrapper.find('.btn-advanced-toggle').trigger('click')
    const advancedGrid = wrapper.find('.advanced-grid')
    expect(advancedGrid.exists()).toBe(true)

    const thinkingCheckbox = advancedGrid.find('input[type="checkbox"]')
    expect(thinkingCheckbox.exists()).toBe(true)
    expect((thinkingCheckbox.element as HTMLInputElement).checked).toBe(false)

    // thinkingBudget hidden while enableThinking is false
    expect(advancedGrid.text()).not.toContain('思考预算')

    // Enable thinking -> thinkingBudget appears for GEMINI
    await thinkingCheckbox.setValue(true)
    expect(advancedGrid.text()).toContain('思考预算')

    // Switch to OPENAI -> thinkingBudget hidden
    await wrapper.findAll('.proto-tab-btn')[0]!.trigger('click')
    expect(wrapper.find('.advanced-grid').text()).not.toContain('思考预算')

    // Switch to ANTHROPIC -> thinkingBudget visible again
    await wrapper.findAll('.proto-tab-btn')[2]!.trigger('click')
    expect(wrapper.find('.advanced-grid').text()).toContain('思考预算')
  })

  it('refreshes profiles on modal open if cached profiles belong to another userId', async () => {
    const aiStore = useAiStore()
    aiStore.profiles = [
      {
        id: 'prof-other-user',
        userId: 'u_old',
        name: 'Old User Profile',
        presetId: 'deepseek',
        protocol: 'OPENAI',
        apiKeyEncrypted: 'sk-****1111',
        hasApiKey: true,
        baseUrl: 'https://api.deepseek.com/v1',
        modelName: 'deepseek-chat',
        customModels: ['deepseek-chat'],
        systemPrompt: '',
        temperature: 0.4,
        maxTokens: 4096,
        enableThinking: false,
        thinkingBudget: 4096,
        anthropicVersion: '2023-06-01',
        maxContextMsgs: 16,
        proxyHost: '',
        proxyPort: null,
        isActive: true
      }
    ]

    const wrapper = track(mount(AiSettingsModal, {
      global: { plugins: [i18n] }
    }))

    aiStore.openSettingsModal()
    await flushPromises()
    await nextTick()

    const fetchCall = fetchMock.mock.calls.find(
      c => c[0] === '/api/users/u1/ai-profiles' && (!c[1]?.method || c[1].method === 'GET')
    )
    expect(fetchCall).toBeDefined()
  })

  it('keeps masked key in placeholder instead of editable value, omits key on blank save, and surfaces ERR_KEY_LOST 400 error', async () => {
    const aiStore = useAiStore()
    aiStore.profiles = [
      {
        id: 'prof-cloud-1',
        userId: 'u1',
        name: 'Cloud OpenAI',
        presetId: 'openai-official',
        protocol: 'OPENAI',
        apiKeyEncrypted: 'sk****************1234',
        hasApiKey: true,
        baseUrl: 'https://api.openai.com/v1',
        modelName: 'gpt-4o',
        customModels: ['gpt-4o'],
        systemPrompt: '',
        temperature: 0.4,
        maxTokens: 4096,
        enableThinking: false,
        thinkingBudget: 4096,
        anthropicVersion: '2023-06-01',
        maxContextMsgs: 16,
        proxyHost: '',
        proxyPort: null,
        isActive: true
      },
      {
        id: 'prof-lost-1',
        userId: 'u1',
        name: 'Lost Key Profile',
        presetId: 'openai-official',
        protocol: 'OPENAI',
        apiKeyEncrypted: 'ERR_KEY_LOST',
        hasApiKey: false,
        baseUrl: 'https://api.openai.com/v1',
        modelName: 'gpt-4o',
        customModels: ['gpt-4o'],
        systemPrompt: '',
        temperature: 0.4,
        maxTokens: 4096,
        enableThinking: false,
        thinkingBudget: 4096,
        anthropicVersion: '2023-06-01',
        maxContextMsgs: 16,
        proxyHost: '',
        proxyPort: null,
        isActive: false
      }
    ]

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/users/u1/ai-profiles' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'))
        if (body.id === 'prof-lost-1' && (!body.apiKeyEncrypted || body.apiKeyEncrypted === 'ERR_KEY_LOST')) {
          return new Response(
            JSON.stringify({ error: 'Saved API key could not be decrypted; please re-enter your API key' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response(
          JSON.stringify({
            id: body.id || 'prof-cloud-1',
            userId: 'u1',
            name: body.name || 'Cloud OpenAI',
            presetId: body.presetId || 'openai-official',
            protocol: body.protocol || 'OPENAI',
            baseUrl: body.baseUrl || 'https://api.openai.com/v1',
            modelName: body.modelName || 'gpt-4o',
            customModels: body.customModels || ['gpt-4o'],
            hasApiKey: true,
            apiKeyEncrypted: 'sk****************1234',
            isActive: true
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url === '/api/users/u1/ai-profiles') {
        return new Response(JSON.stringify(aiStore.profiles), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200 })
    })

    const wrapper = track(mount(AiSettingsModal, {
      global: { plugins: [i18n] }
    }))

    // 1. Valid masked key stays in placeholder, NOT input.value, and save omits apiKeyEncrypted
    aiStore.openSettingsModal('prof-cloud-1')
    await flushPromises()
    await nextTick()

    const keyInput = wrapper.find('#ai-api-key').element as HTMLInputElement
    expect(keyInput.value).toBe('')
    expect(keyInput.placeholder).toBe('sk****************1234')

    await wrapper.find('.btn-primary-save').trigger('click')
    await flushPromises()
    const saveValidCall = fetchMock.mock.calls.find(
      c => c[0] === '/api/users/u1/ai-profiles' && c[1]?.method === 'POST'
    )
    expect(saveValidCall).toBeDefined()
    const sentValid = JSON.parse(String(saveValidCall![1].body))
    expect(sentValid.apiKeyEncrypted).toBeUndefined()
    expect(aiStore.settingsModalOpen).toBe(false)

    // 2. ERR_KEY_LOST profile: saving without entering a new key returns 400 and keeps modal open
    aiStore.openSettingsModal('prof-lost-1')
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.key-lost-banner').exists()).toBe(true)

    await wrapper.find('.btn-primary-save').trigger('click')
    await flushPromises()
    expect(aiStore.settingsModalOpen).toBe(true)
  })
})
