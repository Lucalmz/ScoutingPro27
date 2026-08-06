import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ConnectionStatus, ScoutingRecord } from '@/types'
import type { WebRtcService } from '@/services/webrtc'

export const useConnectionStore = defineStore('connection', () => {
  const status = ref<ConnectionStatus>('offline')
  const rtcService = ref<WebRtcService | null>(null)

  const isConnected = computed(() => status.value === 'connected')
  const isOffline = computed(() => status.value === 'offline')

  // removed unused statusLabel

  const statusIcon = computed(() => {
    switch (status.value) {
      case 'offline':
        return 'wifi_off'
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

  function requestSync(lastSyncTime: string, authCode?: string) {
    rtcService.value?.requestSync(lastSyncTime, authCode)
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
    requestSync,
  }
})
