import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ConnectionStatus, ScoutingRecord, ConnectionTransportInfo } from '@/types'
import type { WebRtcService } from '@/services/webrtc'
import { probePublicConnectivity } from '@/services/webrtc'

export const useConnectionStore = defineStore('connection', () => {
  const status = ref<ConnectionStatus>('offline')
  const transportInfo = ref<ConnectionTransportInfo | null>(null)
  const rtcService = ref<WebRtcService | null>(null)
  const connectedScouts = ref<{ id: string, name: string }[]>([])
  const isReconnecting = ref(false)
  const sessionConflict = ref<{
    conflictingUsername: string
    conflictingUserId: string
    conflictType?: 'SAME_USER' | 'DUPLICATE_NAME'
    suggestedName?: string
    rejected?: boolean
  } | null>(null)
  const takeoverPrompt = ref<{ requesterUsername: string; timeoutSeconds: number } | null>(null)
  const isKicked = ref<{ reason: string } | null>(null)
  const isIceStalled = ref(false)
  const pendingSas = ref<{
    peerId: string
    username: string
    ecdhPublicKey?: string
    fingerprint: string
  } | null>(null)


  const isConnected = computed(() => status.value === 'connected')
  const isOffline = computed(() => status.value === 'offline')
  const isLongOffline = computed(() => status.value === 'long_offline')
  const isCongested = computed(() => status.value === 'unstable')

  const statusIcon = computed(() => {
    switch (status.value) {
      case 'offline':
        return 'wifi_off'
      case 'long_offline':
        return 'cloud_off'
      case 'degraded':
        return 'signal_wifi_bad'
      case 'unstable':
        return 'network_check'
      case 'connecting':
        return 'sync'
      case 'waiting':
        return 'hourglass_empty'
      case 'connected':
        return 'wifi'
      default:
        return 'wifi_off'
    }
  })

  function setStatus(s: ConnectionStatus) {
    status.value = s
    if (s === 'offline' || s === 'long_offline') {
      transportInfo.value = null
    }
  }

  function setTransportInfo(info: ConnectionTransportInfo | null) {
    transportInfo.value = info
  }


  function setSessionConflict(c: {
    conflictingUsername: string
    conflictingUserId: string
    conflictType?: 'SAME_USER' | 'DUPLICATE_NAME'
    suggestedName?: string
    rejected?: boolean
  } | null) {
    sessionConflict.value = c
  }

  function clearSessionConflict() {
    sessionConflict.value = null
  }

  function setTakeoverPrompt(p: { requesterUsername: string; timeoutSeconds: number } | null) {
    takeoverPrompt.value = p
  }

  function clearTakeoverPrompt() {
    takeoverPrompt.value = null
  }

  function setIsKicked(k: { reason: string } | null) {
    isKicked.value = k
  }

  function requestTakeover(username: string, userId: string) {
    rtcService.value?.requestTakeover(username, userId)
  }

  function respondTakeoverDecision(username: string, permit: boolean) {
    rtcService.value?.sendTakeoverDecision(username, permit)
    takeoverPrompt.value = null
  }

  function setRtcService(svc: WebRtcService | null) {
    rtcService.value = svc
    if (typeof window !== 'undefined') {
      ;(window as any).__rtcDisconnect = () => svc?.disconnect()
      // Test helper: close only the data channel (simulates network drop)
      // without closing signaling, so auto-reconnect can work.
      ;(window as any).__rtcSimulateNetworkDrop = () => {
        const dc = svc?.getDataChannel()
        if (dc) dc.close()
      }
    }
  }

  async function reconnectNow(): Promise<boolean> {
    if (isReconnecting.value) return false
    isReconnecting.value = true
    try {
      if (rtcService.value) {
        return await rtcService.value.reconnectNow()
      }
      return false
    } finally {
      isReconnecting.value = false
    }
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

  function requestSync(sinceVersion: number, authCode?: string, senderUserId?: string, senderUserName?: string, token?: string) {
    rtcService.value?.requestSync(sinceVersion, authCode, senderUserId, senderUserName, token)
  }

  /** Host：对记录数组打 hostSeq（本地写入前调用） */
  function stampHostSeq(records: ScoutingRecord[]): ScoutingRecord[] {
    return rtcService.value?.stampHostSeq(records) ?? records
  }

  /** Host：重启后从记录最大 hostSeq 恢复计数器 */
  function initHostSeq(maxSeq: number) {
    rtcService.value?.initHostSeq(maxSeq)
  }

  function addConnectedScout(id: string, name: string) {
    if (!connectedScouts.value.find(s => s.id === id)) {
      connectedScouts.value.push({ id, name })
    }
  }

  function clearConnectedScouts() {
    connectedScouts.value = []
  }

  function broadcastTagUpdate(tag: import('@/types').TeamTagItem, action: 'ADD' | 'REMOVE') {
    if (isConnected.value && rtcService.value) {
      rtcService.value.broadcastTagUpdate(tag, action)
    }
  }

  function setPendingSas(p: { peerId: string; username: string; ecdhPublicKey?: string; fingerprint: string } | null) {
    pendingSas.value = p
  }

  function clearPendingSas() {
    pendingSas.value = null
  }

  function setIsIceStalled(s: boolean) {
    isIceStalled.value = s
  }

  function confirmSas(peerId?: string) {
    const target = peerId || pendingSas.value?.peerId || 'host'
    rtcService.value?.confirmSas(target)
    pendingSas.value = null
  }

  function rejectSas(peerId?: string, reason?: string) {
    const target = peerId || pendingSas.value?.peerId || 'host'
    rtcService.value?.rejectSas(target, reason)
    pendingSas.value = null
  }

  return {
    status,
    transportInfo,
    rtcService,
    sessionConflict,
    takeoverPrompt,
    isKicked,
    isIceStalled,
    pendingSas,
    isConnected,
    isOffline,
    isLongOffline,
    isCongested,
    isReconnecting,
    statusIcon,
    setStatus,
    setTransportInfo,
    setSessionConflict,

    clearSessionConflict,
    setTakeoverPrompt,
    clearTakeoverPrompt,
    setIsKicked,
    setPendingSas,
    clearPendingSas,
    setIsIceStalled,
    confirmSas,
    rejectSas,
    requestTakeover,
    respondTakeoverDecision,
    setRtcService,
    reconnectNow,
    probePublicConnectivity,
    pushRecords,
    pushIfNeeded,
    requestSync,
    stampHostSeq,
    initHostSeq,
    connectedScouts,
    addConnectedScout,
    clearConnectedScouts,
    broadcastTagUpdate,
  }
})
