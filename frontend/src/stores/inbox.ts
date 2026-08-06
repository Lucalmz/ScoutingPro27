import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { SystemMessage } from '@/types'
import { useUserStore } from '@/stores/user'

export const useInboxStore = defineStore('inbox', () => {
  const messages = ref<SystemMessage[]>([])
  const unreadCount = computed(() => messages.value.filter(m => !m.read).length)
  const userStore = useUserStore()

  function getStorageKey() {
    return userStore.userId ? `inbox-messages-${userStore.userId}` : null
  }

  function loadMessages() {
    const key = getStorageKey()
    if (key) {
      const stored = localStorage.getItem(key)
      if (stored) {
        try {
          messages.value = JSON.parse(stored)
        } catch {
          messages.value = []
        }
      } else {
        messages.value = []
      }
    } else {
      messages.value = []
    }
  }

  function saveMessages() {
    const key = getStorageKey()
    if (key) {
      localStorage.setItem(key, JSON.stringify(messages.value))
    }
  }

  watch(() => userStore.userId, () => {
    loadMessages()
  }, { immediate: true })

  watch(messages, () => {
    saveMessages()
  }, { deep: true })

  function addMessage(msg: Omit<SystemMessage, 'id' | 'read' | 'timestamp'>) {
    messages.value.unshift({
      ...msg,
      id: crypto.randomUUID(),
      read: false,
      timestamp: new Date().toISOString()
    })
  }

  function markRead(id: string) {
    const msg = messages.value.find(m => m.id === id)
    if (msg) {
      msg.read = true
    }
  }

  return {
    messages,
    unreadCount,
    addMessage,
    markRead
  }
})
