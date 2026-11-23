import { computed, ref } from 'vue'
import type { useUserStore } from '@/stores/user'
import { i18n } from '@/i18n'
import type { AiProtocol, AiProviderProfile, AiSettings } from '@/types'
import {
  AI_PROFILE_DEFAULTS,
  API_KEY_ERR_LOST,
  isMaskedOrPlaceholderApiKey
} from '@/components/ai/constants'
import { GEMINI_DEFAULT_MODELS, getPresetById, isLocalBaseUrl } from '@/components/ai/presets'
import { readAiStorage, writeAiStorage } from './aiDockState'

const KEY_ACTIVE_PROFILE = 'sp27_ai_active_profile_id'

export interface ConnectionCheckParams {
  profileId?: string
  protocol?: AiProtocol | string
  provider?: string
  apiKey?: string
  proxyHost?: string
  proxyPort?: number | null
  baseUrl?: string
  anthropicVersion?: string
}

export interface ConnectionCheckResponse {
  success: boolean
  modelsSupported?: boolean
  statusCode?: number
  latencyMs?: number
  models?: string[]
  messageCode?: string
  message?: string
  error?: string
}

export function createAiProfilesModule(userStore: ReturnType<typeof useUserStore>) {
  const profiles = ref<AiProviderProfile[]>([])
  const loadingProfiles = ref(false)
  const activeProfileId = ref<string>(readAiStorage(KEY_ACTIVE_PROFILE) || '')

  // Backwards-compatible legacy refs
  const settingsList = ref<AiSettings[]>([])
  const loading = ref(false)
  const activeProvider = ref<'OPENAI' | 'GEMINI' | 'ANTHROPIC'>('OPENAI')

  const activeProfile = computed<AiProviderProfile | null>(() => {
    if (profiles.value.length === 0) return null
    const byStoredId = activeProfileId.value
      ? profiles.value.find(p => p.id === activeProfileId.value)
      : undefined
    const byServerFlag = profiles.value.find(p => p.isActive)
    return byServerFlag || byStoredId || profiles.value[0] || null
  })

  const canSendWithActiveProfile = computed<boolean>(() => {
    const p = activeProfile.value
    if (!p) return false
    if (p.hasApiKey) return true
    return p.protocol === 'OPENAI' && isLocalBaseUrl(p.baseUrl)
  })

  function normalizeProfile(raw: any): AiProviderProfile {
    const proto: AiProtocol =
      raw?.protocol === 'GEMINI' || raw?.protocol === 'ANTHROPIC' ? raw.protocol : 'OPENAI'
    const rawCustomModels = Array.isArray(raw?.customModels)
      ? raw.customModels.map(String).filter(Boolean)
      : proto === 'GEMINI'
        ? [...GEMINI_DEFAULT_MODELS]
        : []
    const preset = getPresetById(raw?.presetId || 'custom', proto)
    return {
      id: String(raw?.id || ''),
      userId: raw?.userId,
      name: String(raw?.name || preset.name || proto),
      presetId: String(raw?.presetId || 'custom'),
      protocol: proto,
      apiKeyEncrypted: String(raw?.apiKeyEncrypted || ''),
      hasApiKey: Boolean(raw?.hasApiKey ?? (raw?.apiKeyEncrypted && raw.apiKeyEncrypted !== API_KEY_ERR_LOST)),
      baseUrl: String(raw?.baseUrl || ''),
      modelName: String(raw?.modelName || ''),
      customModels: rawCustomModels,
      systemPrompt: String(raw?.systemPrompt || ''),
      temperature: typeof raw?.temperature === 'number' ? raw.temperature : AI_PROFILE_DEFAULTS.temperature,
      maxTokens: typeof raw?.maxTokens === 'number' ? raw.maxTokens : AI_PROFILE_DEFAULTS.maxTokens,
      enableThinking: raw?.enableThinking !== false,
      thinkingBudget: typeof raw?.thinkingBudget === 'number' ? raw.thinkingBudget : AI_PROFILE_DEFAULTS.thinkingBudget,
      anthropicVersion: String(raw?.anthropicVersion || AI_PROFILE_DEFAULTS.anthropicVersion),
      maxContextMsgs: typeof raw?.maxContextMsgs === 'number' ? raw.maxContextMsgs : AI_PROFILE_DEFAULTS.maxContextMsgs,
      proxyHost: String(raw?.proxyHost || ''),
      proxyPort: raw?.proxyPort != null && raw.proxyPort !== '' ? Number(raw.proxyPort) : null,
      isActive: Boolean(raw?.isActive),
      createdAt: raw?.createdAt,
      updatedAt: raw?.updatedAt
    }
  }

  function syncLegacyBridgeFromProfiles() {
    const act = activeProfile.value
    if (act) {
      activeProfileId.value = act.id
      writeAiStorage(KEY_ACTIVE_PROFILE, act.id)
      activeProvider.value = act.protocol
    }
  }

  async function fetchProfiles(): Promise<AiProviderProfile[]> {
    if (!userStore.userId || !userStore.token) return []
    loadingProfiles.value = true
    try {
      const res = await fetch(`/api/users/${userStore.userId}/ai-profiles`, {
        headers: { Authorization: `Bearer ${userStore.token}` }
      })
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data)) {
          profiles.value = data.map(normalizeProfile)
          syncLegacyBridgeFromProfiles()
        }
      }
    } catch (e) {
      console.error('Failed to fetch AI profiles', e)
    } finally {
      loadingProfiles.value = false
    }
    return profiles.value
  }

  async function saveProfile(
    profile: Partial<AiProviderProfile>
  ): Promise<{ ok: boolean; profile?: AiProviderProfile; error?: string }> {
    if (!userStore.userId || !userStore.token) {
      return { ok: false, error: i18n.global.t('ai.err_not_logged_in') }
    }
    const payload: Record<string, any> = { ...profile }
    if (payload.apiKeyEncrypted && isMaskedOrPlaceholderApiKey(String(payload.apiKeyEncrypted))) {
      delete payload.apiKeyEncrypted
    }
    if (payload.proxyPort === '' || payload.proxyPort === undefined) {
      payload.proxyPort = null
    }

    try {
      const res = await fetch(`/api/users/${userStore.userId}/ai-profiles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userStore.token}`
        },
        body: JSON.stringify(payload)
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        return { ok: false, error: data?.error || `HTTP ${res.status}` }
      }
      const saved = normalizeProfile(data)
      await fetchProfiles()
      return { ok: true, profile: saved }
    } catch (e: any) {
      return { ok: false, error: e?.message || i18n.global.t('ai.err_network') }
    }
  }

  async function activateProfile(profileId: string): Promise<boolean> {
    if (!userStore.userId || !userStore.token || !profileId) return false
    try {
      const res = await fetch(`/api/users/${userStore.userId}/ai-profiles/${profileId}/activate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userStore.token}` }
      })
      if (res.ok) {
        profiles.value = profiles.value.map(p => ({ ...p, isActive: p.id === profileId }))
        activeProfileId.value = profileId
        writeAiStorage(KEY_ACTIVE_PROFILE, profileId)
        syncLegacyBridgeFromProfiles()
        return true
      }
    } catch (e) {
      console.error('Failed to activate profile', e)
    }
    return false
  }

  async function quickSwitchModel(profileId: string, modelName: string): Promise<boolean> {
    const target = profiles.value.find(p => p.id === profileId)
    if (!target) return false
    const cleanModel = modelName.trim()
    if (!cleanModel) return false
    const res = await saveProfile({
      ...target,
      modelName: cleanModel,
      isActive: true
    })
    return res.ok
  }

  async function deleteProfile(profileId: string): Promise<boolean> {
    if (!userStore.userId || !userStore.token || !profileId) return false
    try {
      const res = await fetch(`/api/users/${userStore.userId}/ai-profiles/${profileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userStore.token}` }
      })
      if (res.ok) {
        await fetchProfiles()
        return true
      }
    } catch (e) {
      console.error('Failed to delete profile', e)
    }
    return false
  }

  async function callConnectionOrModelsEndpoint(
    endpoint: string,
    params: ConnectionCheckParams
  ): Promise<ConnectionCheckResponse> {
    if (!userStore.token) return { success: false, models: [], error: i18n.global.t('ai.err_not_logged_in') }
    const cleanKey = !isMaskedOrPlaceholderApiKey(params.apiKey) ? params.apiKey!.trim() : undefined
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userStore.token}`
        },
        body: JSON.stringify({
          profileId: params.profileId || undefined,
          protocol: params.protocol || params.provider || undefined,
          provider: params.provider || params.protocol || undefined,
          apiKey: cleanKey,
          proxyHost: params.proxyHost || undefined,
          proxyPort: params.proxyPort ?? undefined,
          baseUrl: params.baseUrl || undefined,
          anthropicVersion: params.anthropicVersion || undefined
        })
      })
      if (res.ok) {
        return await res.json()
      }
      const errJson = await res.json().catch(() => null)
      return {
        success: false,
        models: [],
        error: errJson?.error || `HTTP ${res.status}`
      }
    } catch (e: any) {
      return { success: false, models: [], error: e?.message || i18n.global.t('ai.err_network') }
    }
  }

  async function fetchModels(params: ConnectionCheckParams): Promise<ConnectionCheckResponse> {
    return callConnectionOrModelsEndpoint('/api/ai/models', params)
  }

  async function testConnection(
    arg1: string | ConnectionCheckParams,
    apiKey?: string,
    proxyHost?: string,
    proxyPort?: number,
    baseUrl?: string
  ): Promise<ConnectionCheckResponse> {
    const params: ConnectionCheckParams =
      typeof arg1 === 'string'
        ? { protocol: arg1, provider: arg1, apiKey, proxyHost, proxyPort, baseUrl }
        : arg1
    return callConnectionOrModelsEndpoint('/api/ai/test-connection', params)
  }

  async function fetchSettings() {
    if (!userStore.userId || !userStore.token) return
    loading.value = true
    try {
      const res = await fetch(`/api/users/${userStore.userId}/ai-settings`, {
        headers: { Authorization: `Bearer ${userStore.token}` }
      })
      if (res.ok) {
        settingsList.value = await res.json()
      }
    } catch (e) {
      console.error('Failed to fetch AI settings', e)
    } finally {
      loading.value = false
    }
  }

  async function saveSettings(settings: Partial<AiSettings>) {
    if (!userStore.userId || !userStore.token) return false
    const payload = { ...settings }
    if (payload.apiKeyEncrypted && isMaskedOrPlaceholderApiKey(payload.apiKeyEncrypted)) {
      delete payload.apiKeyEncrypted
    }
    try {
      const res = await fetch(`/api/users/${userStore.userId}/ai-settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userStore.token}`
        },
        body: JSON.stringify(payload)
      })
      if (res.ok) {
        await fetchSettings()
        return true
      }
    } catch (e) {
      console.error('Failed to save AI settings', e)
    }
    return false
  }

  function getSettingsForProvider(provider: string): AiSettings | undefined {
    return settingsList.value.find(s => s.provider === provider)
  }

  return {
    profiles,
    loadingProfiles,
    activeProfileId,
    activeProfile,
    canSendWithActiveProfile,
    fetchProfiles,
    saveProfile,
    activateProfile,
    quickSwitchModel,
    deleteProfile,
    fetchModels,
    testConnection,
    settingsList,
    loading,
    activeProvider,
    fetchSettings,
    saveSettings,
    getSettingsForProvider
  }
}
