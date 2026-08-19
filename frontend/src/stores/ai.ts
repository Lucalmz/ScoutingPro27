import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useUserStore } from './user'
import type { AiSettings } from '@/types'

export const useAiStore = defineStore('ai', () => {
  const userStore = useUserStore()
  
  const settingsList = ref<AiSettings[]>([])
  const loading = ref(false)
  
  const activeProvider = ref<'OPENAI' | 'GEMINI'>('OPENAI')
  
  async function fetchSettings() {
    if (!userStore.userId || !userStore.token) return
    loading.value = true
    try {
      const res = await fetch(`/api/users/${userStore.userId}/ai-settings`, {
        headers: { 'Authorization': `Bearer ${userStore.token}` }
      })
      if (res.ok) {
        const data = await res.json()
        settingsList.value = data
      }
    } catch (e) {
      console.error('Failed to fetch AI settings', e)
    } finally {
      loading.value = false
    }
  }

  async function saveSettings(settings: Partial<AiSettings>) {
    if (!userStore.userId || !userStore.token) return false
    
    // Create a copy and remove masked keys if unmodified
    const payload = { ...settings }
    if (payload.apiKeyEncrypted && (payload.apiKeyEncrypted === '****' || payload.apiKeyEncrypted.includes('***'))) {
      delete payload.apiKeyEncrypted
    }
    
    try {
      const res = await fetch(`/api/users/${userStore.userId}/ai-settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userStore.token}`
        },
        body: JSON.stringify(payload)
      })
      
      if (res.ok) {
        await fetchSettings() // refresh
        return true
      }
    } catch (e) {
      console.error('Failed to save AI settings', e)
    }
    return false
  }

  async function testConnection(provider: string, apiKey?: string, proxyHost?: string, proxyPort?: number, baseUrl?: string) {
    if (!userStore.token) return { success: false, error: 'Not logged in' }
    
    const params = new URLSearchParams()
    params.append('provider', provider)
    if (apiKey && !apiKey.includes('***') && apiKey !== '****') {
      params.append('apiKey', apiKey.trim())
    }
    if (proxyHost) params.append('proxyHost', proxyHost)
    if (proxyPort) params.append('proxyPort', proxyPort.toString())
    if (baseUrl) params.append('baseUrl', baseUrl)
    
    try {
      const res = await fetch(`/api/ai/test-connection?${params.toString()}`, {
        headers: { 'Authorization': `Bearer ${userStore.token}` }
      })
      if (res.ok) {
        return await res.json() // {success, statusCode, latencyMs, message, error}
      } else {
        return { success: false, error: 'HTTP ' + res.status }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  function getSettingsForProvider(provider: string): AiSettings | undefined {
    return settingsList.value.find(s => s.provider === provider)
  }

  async function fetchChatHistory(eventId: string) {
    if (!userStore.token) return []
    try {
      const res = await fetch(`/api/events/${eventId}/ai-chat`, {
        headers: { 'Authorization': `Bearer ${userStore.token}` }
      })
      if (res.ok) {
        return await res.json()
      }
    } catch (e) {
      console.error('Failed to fetch chat history', e)
    }
    return []
  }

  async function saveChatHistory(eventId: string, chatArray: any[]) {
    if (!userStore.token) return false
    try {
      const res = await fetch(`/api/events/${eventId}/ai-chat`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userStore.token}`
        },
        body: JSON.stringify(chatArray)
      })
      return res.ok
    } catch (e) {
      console.error('Failed to save chat history', e)
      return false
    }
  }

  return {
    settingsList,
    loading,
    activeProvider,
    fetchSettings,
    saveSettings,
    testConnection,
    getSettingsForProvider,
    fetchChatHistory,
    saveChatHistory
  }
})
