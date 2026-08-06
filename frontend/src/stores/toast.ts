import { defineStore } from 'pinia'
import { ref } from 'vue'

import { i18n } from '@/i18n'

export interface Toast {
  id: number
  message: string
  type: 'error' | 'success' | 'info'
}

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([])
  let nextId = 0

  function showToast(message: string, type: 'error' | 'success' | 'info' = 'error', duration = 3000) {
    const id = nextId++
    toasts.value.push({ id, message, type })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, duration)
  }

  function showError(msg: string) {
    let friendlyMessage = msg
    const t = i18n.global.t.bind(i18n.global)
    if (msg.includes("username and password required")) friendlyMessage = t('toast.require_login')
    else if (msg.includes("username or password too long")) friendlyMessage = t('toast.too_long')
    else if (msg.includes("Invalid password")) friendlyMessage = t('toast.invalid_password')
    else if (msg.includes("Passwords do not match")) friendlyMessage = t('toast.passwords_mismatch')
    else if (msg.includes("Internal Server Error")) friendlyMessage = t('toast.server_error')
    else if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) friendlyMessage = t('toast.network_error')
    
    showToast(friendlyMessage, 'error')
  }

  return { toasts, showToast, showError }
})
