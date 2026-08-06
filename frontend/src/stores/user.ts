import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { login as apiLogin } from '@/services/api'
import { useToastStore } from '@/stores/toast'
import type { User } from '@/types'

export const useUserStore = defineStore('user', () => {
  const user = ref<User | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isLoggedIn = computed(() => user.value !== null)
  const userId = computed(() => user.value?.id ?? '')
  const username = computed(() => user.value?.username ?? '')

  // Try to restore from localStorage
  function restoreFromCache() {
    const cached = localStorage.getItem('scoutingpro-user')
    if (cached) {
      try {
        user.value = JSON.parse(cached) as User
      } catch {
        localStorage.removeItem('scoutingpro-user')
      }
    }
  }

  async function login(usernameInput: string, passwordInput: string): Promise<boolean> {
    loading.value = true
    error.value = null
    try {
      const u = await apiLogin({ username: usernameInput, password: passwordInput })
      user.value = u
      localStorage.setItem('scoutingpro-user', JSON.stringify(u))
      return true
    } catch (e: any) {
      const msg = e.message ?? 'Login failed'
      error.value = msg
      useToastStore().showError(msg)
      return false
    } finally {
      loading.value = false
    }
  }

  function logout() {
    user.value = null
    localStorage.removeItem('scoutingpro-user')
  }

  return { user, loading, error, isLoggedIn, userId, username, restoreFromCache, login, logout }
})
