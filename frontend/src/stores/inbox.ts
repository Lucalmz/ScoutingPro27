import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { SystemMessage, DirectMessageOutboxItem, MessageDeliveryStatus } from '@/types'
import { useUserStore } from '@/stores/user'
import { safeJsonParse } from '@/utils/json'

export const useInboxStore = defineStore('inbox', () => {
  const messages = ref<SystemMessage[]>([])
  const outbox = ref<DirectMessageOutboxItem[]>([])
  
  const unreadCount = computed(() => messages.value.filter(m => !m.read).length)
  const pendingOutboxCount = computed(() => outbox.value.filter(m => m.status === 'PENDING_DELIVERY' || m.status === 'DELIVERING').length)
  
  const userStore = useUserStore()

  function getInboxStorageKey() {
    return userStore.userId ? `inbox-messages-${userStore.userId}` : null
  }

  function getOutboxStorageKey() {
    return userStore.userId ? `inbox-outbox-${userStore.userId}` : null
  }

  function loadMessages() {
    const inboxKey = getInboxStorageKey()
    if (inboxKey) {
      const stored = localStorage.getItem(inboxKey)
      if (stored) {
        messages.value = safeJsonParse<SystemMessage[]>(stored) || []
      } else {
        messages.value = []
      }
    } else {
      messages.value = []
    }

    const outboxKey = getOutboxStorageKey()
    if (outboxKey) {
      const stored = localStorage.getItem(outboxKey)
      if (stored) {
        outbox.value = safeJsonParse<DirectMessageOutboxItem[]>(stored) || []
      } else {
        outbox.value = []
      }
    } else {
      outbox.value = []
    }
  }

  function saveMessages() {
    const inboxKey = getInboxStorageKey()
    if (inboxKey) {
      localStorage.setItem(inboxKey, JSON.stringify(messages.value))
    }
    const outboxKey = getOutboxStorageKey()
    if (outboxKey) {
      localStorage.setItem(outboxKey, JSON.stringify(outbox.value))
    }
  }

  watch(() => userStore.userId, () => {
    loadMessages()
  }, { immediate: true })

  watch([messages, outbox], () => {
    saveMessages()
  }, { deep: true })

  function addMessage(msg: Omit<SystemMessage, 'id' | 'read' | 'timestamp'>) {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `msg-${Date.now()}`
    messages.value.unshift({
      ...msg,
      id,
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

  async function sendDirectMessage(
    payload: { targetId: string; targetName?: string; title: string; body: string },
    rtcSender?: { sendDirectMessage: (p: any) => Promise<boolean> }
  ): Promise<DirectMessageOutboxItem> {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `outbox-${Date.now()}`
    const item: DirectMessageOutboxItem = {
      id,
      targetId: payload.targetId,
      targetName: payload.targetName,
      senderId: userStore.userId,
      senderName: userStore.username,
      title: payload.title,
      body: payload.body,
      status: 'PENDING_DELIVERY',
      createdAt: new Date().toISOString(),
      retryCount: 0
    }

    outbox.value.unshift(item)

    if (rtcSender) {
      item.status = 'DELIVERING'
      try {
        const success = await rtcSender.sendDirectMessage({
          messageId: item.id,
          targetId: item.targetId,
          targetName: item.targetName,
          senderId: item.senderId,
          senderName: item.senderName,
          title: item.title,
          body: item.body
        })
        if (success) {
          item.status = 'DELIVERED'
          item.deliveredAt = new Date().toISOString()
        } else {
          item.status = 'PENDING_DELIVERY'
        }
      } catch (err) {
        console.warn('[Outbox] Failed to send direct message, queued for retry:', err)
        item.status = 'PENDING_DELIVERY'
        item.retryCount++
      }
    }

    return item
  }

  function updateDeliveryStatus(id: string, status: MessageDeliveryStatus, deliveredAt?: string) {
    const item = outbox.value.find(o => o.id === id)
    if (item) {
      item.status = status
      if (deliveredAt) {
        item.deliveredAt = deliveredAt
      } else if (status === 'DELIVERED' && !item.deliveredAt) {
        item.deliveredAt = new Date().toISOString()
      }
    }
  }

  async function flushOutbox(
    rtcSender: { sendDirectMessage: (p: any) => Promise<boolean> },
    targetId?: string
  ): Promise<void> {
    const pendingItems = outbox.value.filter(
      item => (item.status === 'PENDING_DELIVERY' || item.status === 'FAILED') &&
              (!targetId || item.targetId === targetId)
    )

    for (const item of pendingItems) {
      item.status = 'DELIVERING'
      try {
        const success = await rtcSender.sendDirectMessage({
          messageId: item.id,
          targetId: item.targetId,
          targetName: item.targetName,
          senderId: item.senderId,
          senderName: item.senderName,
          title: item.title,
          body: item.body
        })
        if (success) {
          item.status = 'DELIVERED'
          item.deliveredAt = new Date().toISOString()
        } else {
          item.status = 'PENDING_DELIVERY'
        }
      } catch {
        item.status = 'PENDING_DELIVERY'
        item.retryCount++
      }
    }
  }

  return {
    messages,
    outbox,
    unreadCount,
    pendingOutboxCount,
    addMessage,
    markRead,
    sendDirectMessage,
    updateDeliveryStatus,
    flushOutbox,
    loadMessages
  }
})
