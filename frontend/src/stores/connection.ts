import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ConnectionStatus, ScoutingRecord } from '@/types'
import type { WebRtcService } from '@/services/webrtc'

export const useConnectionStore = defineStore('connection', () => {
  const status = ref<ConnectionStatus>('offline')
  const rtcService = ref<WebRtcService | null>(null)
  const connectedScouts = ref<{ id: string, name: string }[]>([])

  const isConnected = computed(() => status.value === 'connected')
  const isOffline = computed(() => status.value === 'offline')

  // removed unused statusLabel

  const statusIcon = computed(() => {
    switch (status.value) {
      case 'offline':
        return 'wifi_off'
      case 'degraded':
        return 'signal_wifi_bad'
      case 'connecting':
        return 'sync'
      case 'waiting':
        return 'hourglass_empty'
      case 'connected':
        return 'wifi'
    }
  })

  function setStatus(s: ConnectionStatus) {
    status.value = s
  }

  function setRtcService(svc: WebRtcService | null) {
    rtcService.value = svc
  }

  // --- helpers ---
  function pushRecords(records: ScoutingRecord[], targetId?: string) {
    rtcService.value?.pushRecords(records, targetId)
  }

  function pushIfNeeded(records: ScoutingRecord[] | undefined | null, targetId?: string) {
    if (isConnected.value && records && records.length > 0) {
      pushRecords(records, targetId)
    }
  }

  function requestSync(lastSyncTime: string, authCode?: string, senderUserId?: string, senderUserName?: string) {
    rtcService.value?.requestSync(lastSyncTime, authCode, senderUserId, senderUserName)
  }

  function addConnectedScout(id: string, name: string) {
    if (!connectedScouts.value.find(s => s.id === id)) {
      connectedScouts.value.push({ id, name })
    }
  }

  function clearConnectedScouts() {
    connectedScouts.value = []
  }

  return {
    status,
    rtcService,
    isConnected,
    isOffline,
    statusIcon,
    setStatus,
    setRtcService,
    pushRecords,
    pushIfNeeded,
    requestSync,
    connectedScouts,
    addConnectedScout,
    clearConnectedScouts,
  }
})
