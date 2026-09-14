import { defineStore } from 'pinia'
import { ref } from 'vue'

import { i18n } from '@/i18n'
import { formatUserFriendlyError } from '@/utils/errorHelper'

export interface Toast {
  id: number
  message: string
  type: 'error' | 'success' | 'info' | 'warning'
  detail?: string
  icon?: string
}

export interface ToastOptions {
  duration?: number
  detail?: string
  icon?: string
}

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([])
  let nextId = 0

  function showToast(
    message: string,
    type: 'error' | 'success' | 'info' | 'warning' = 'info',
    optionsOrDuration: number | ToastOptions = 3500
  ) {
    const id = nextId++
    let duration = 3500
    let detail: string | undefined
    let icon: string | undefined

    if (typeof optionsOrDuration === 'number') {
      duration = optionsOrDuration
    } else if (typeof optionsOrDuration === 'object' && optionsOrDuration !== null) {
      if (optionsOrDuration.duration !== undefined) duration = optionsOrDuration.duration
      detail = optionsOrDuration.detail
      icon = optionsOrDuration.icon
    }

    toasts.value.push({ id, message, type, detail, icon })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, duration)
  }

  function showError(errOrMsg: unknown, fallbackMessage?: string, duration = 4500) {
    const { message, detail } = formatUserFriendlyError(errOrMsg, fallbackMessage)
    showToast(message, 'error', { duration, detail })
  }

  return { toasts, showToast, showError }
})
