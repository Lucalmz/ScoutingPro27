import type {
  ConnectionStatus,
  ScoutingEvent
} from '@/types'
import type { DataChannelSender } from '@/services/dataChannelSender'
import {
  generateEcdhKeyPair,
  exportEcdhPublicKey
} from '@/utils/crypto'
import {
  getOrCreateDeviceIdentity,
  type DeviceIdentity
} from '@/utils/identityStore'

import type { WebRtcCallbacks, WebRtcService, ClientEntry } from './types'
import { SignalingChannel, resolveBrokerUrl } from './signaling'
import { OfflineMessageManager } from './offlineQueue'
import { createChannelMessageHandler } from './channelMessageHandler'
import { SasSecurityManager } from './sasManager'
import { PeerConnectionManager } from './peerManager'
import { createHostSignalingHandler } from './hostSession'
import { createClientSession } from './clientSession'
import { createMessageDispatcher } from './messageDispatcher'
import { setupSelfHealing } from './selfHealing'
import { createLogger } from '@/utils/logger'
import { isMobileDevice } from '@/composables/useIsMobile'

const log = createLogger('WebRTC:Service')

export * from './types'
export * from './connectivity'
export * from './signaling'
export * from './offlineQueue'
export * from './sdpUtil'
export * from './messageDispatcher'
export * from './selfHealing'

/**
 * 确定性全序主机权威比较器 (Deterministic Total-Order Host Authority Comparator)
 * 返回值:
 *   > 0: A 的权威高于 B (A 胜出保持/当选主机，B 必须降级从机)
 *   < 0: B 的权威高于 A (B 胜出，A 必须降级从机)
 *   = 0: 同一会话
 */
export function compareHostAuthority(
  epochA: number,
  deviceIdA: string,
  sessionIdA: string,
  epochB: number,
  deviceIdB: string,
  sessionIdB: string
): number {
  // 1. 任期号优先：高任期号绝对压制低任期号
  if (epochA !== epochB) {
    return epochA - epochB
  }
  // 2. 仲裁第一平局项：SessionId 字典序 (更小更早创设的先占会话权威更高)
  const sessionCmp = sessionIdB.localeCompare(sessionIdA)
  if (sessionCmp !== 0) {
    return sessionCmp
  }
  // 3. 仲裁第二平局项：设备 ID 字典序
  return deviceIdB.localeCompare(deviceIdA)
}

export function createWebRtcService(callbacks: WebRtcCallbacks): WebRtcService {
  let isHostMode = false
  let isExplicitlyClosed = false
  let signaling: SignalingChannel | null = null
  let status: ConnectionStatus = 'offline'
  let currentInviteCode = ''
  let hostSessionId = ''
  let currentHostSessionId = ''
  let currentClientSessionId = ''
  let currentEventMetadata: ScoutingEvent | null = null
  let currentUsername = ''
  let currentUserId = ''

  // Host Mutex & Standby State
  let isStandbyHostMode = false
  let isProbing = false
  let probeTimer: any = null
  let hostHeartbeatTimer: any = null
  let standbyWatchdogTimer: any = null
  let lastActiveHostHeartbeat = 0
  let activeHostSessionId = ''
  let activeHostDeviceId = ''

  // Ephemeral / Persistent ECDH Key Pair & Identity State
  let localEcdhKeyPair: CryptoKeyPair | null = null
  let localEcdhPubHex = ''
  let localDeviceId = ''
  let localDeviceIdentity: DeviceIdentity | null = null

  // Client mode state
  let clientPc: RTCPeerConnection | null = null
  let clientDc: RTCDataChannel | null = null
  let clientSender: DataChannelSender | null = null
  let clientPendingCandidates: any[] = []
  let clientHostSenderId: string | undefined = undefined
  let clientForceRelay = false

  // Host mode state
  const clients = new Map<string, ClientEntry>()
  const stagedClients = new Map<string, ClientEntry>()
  const preOfferCandidates = new Map<string, any[]>()
  const hostQueues = new Map<string, Promise<void>>()
  const scoutIdToClientIds = new Map<string, Set<string>>()
  const clientIdToScoutId = new Map<string, string>()
  const clientIdToScoutName = new Map<string, string>()
  const pendingTakeovers = new Map<string, {
    newClientId: string
    oldClientId?: string
    username: string
    timeoutTimer: any
  }>()
  const takeoverCooldowns = new Map<string, number>()

  const offlineMessages = new OfflineMessageManager()
  const sas = new SasSecurityManager()

  let localUserId: string | undefined = undefined
  let localUserName: string | undefined = undefined

  function resolveCurrentUserId(): string {
    return callbacks.getCurrentUser?.()?.userId || currentUserId || localUserId || ''
  }

  function resolveCurrentUsername(): string {
    return callbacks.getCurrentUser?.()?.username || currentUsername || localUserName || ''
  }

  let hostSeqCounter = 0
  let localEpoch = 0
  try {
    const savedEpoch = localStorage.getItem('scoutingpro_host_epoch')
    if (savedEpoch) localEpoch = parseInt(savedEpoch, 10) || 0
  } catch (_) {}

  function setLocalEpoch(ep: number) {
    localEpoch = ep
    try {
      localStorage.setItem('scoutingpro_host_epoch', String(ep))
    } catch (_) {}
  }

  let inTakeoverReconciliation = false
  let takeoverReconciliationResolvers: Array<() => void> = []
  let takeoverReconciliationTimer: any = null

  function startTakeoverReconciliation(timeoutMs = 2000) {
    inTakeoverReconciliation = true
    if (takeoverReconciliationTimer) clearTimeout(takeoverReconciliationTimer)
    takeoverReconciliationTimer = setTimeout(() => {
      finishTakeoverReconciliation('timeout')
    }, timeoutMs)
  }

  function finishTakeoverReconciliation(reason = 'completed') {
    if (!inTakeoverReconciliation) return
    console.log(`[WebRTC Host] Takeover reconciliation finished (${reason})`)
    inTakeoverReconciliation = false
    if (takeoverReconciliationTimer) {
      clearTimeout(takeoverReconciliationTimer)
      takeoverReconciliationTimer = null
    }
    const resolvers = [...takeoverReconciliationResolvers]
    takeoverReconciliationResolvers = []
    for (const resolve of resolvers) {
      try {
        resolve()
      } catch (e) {
        console.error(e)
      }
    }
  }

  function waitForTakeoverReconciliation(): Promise<void> {
    if (!inTakeoverReconciliation) return Promise.resolve()
    return new Promise((resolve) => {
      takeoverReconciliationResolvers.push(resolve)
    })
  }

  function enqueueHostTask(sender: string, task: () => Promise<void>): Promise<void> {
    const q = hostQueues.get(sender) || Promise.resolve()
    const nextQ = q.then(task).catch(console.error)
    hostQueues.set(sender, nextQ)
    return nextQ
  }

  function setStatus(s: ConnectionStatus) {
    status = s
    if (s === 'connected') {
      // 成功建联后清除强制 relay 标记，确保后续重连继续优先尝试 LAN 与 IPv6 P2P
      clientForceRelay = false
    }
    if (s === 'offline' || s === 'long_offline') {
      peerMgr.resetTransportInfo()
    }
    callbacks.onStatusChange(s)
  }

  function updateHostStatus() {
    if (!isHostMode) return
    let active = 0
    clients.forEach((c) => {
      if (c.dc && c.dc.readyState === 'open') active++
    })
    if (active > 0) {
      setStatus('connected')
    } else if (signaling) {
      setStatus('waiting')
    } else {
      setStatus('offline')
    }
  }

  const peerMgr = new PeerConnectionManager({
    getSignaling: () => signaling,
    isHostMode: () => isHostMode,
    callbacks,
    setStatus,
    onHostDisconnected: () => {
      console.log('[WebRTC] Host connection degraded (timeout)')
      setStatus('degraded')
    },
    onClientRebuildRelay: () => {
      clientSession.setupClientConnection(true)
    },
    getLocalEcdhPubHex: () => localEcdhPubHex,
    getCurrentHostSessionId: () => currentHostSessionId,
    getClientSessionId: () => currentClientSessionId,
    getClientSharedAesKey: () => sas.clientSharedAesKey,
    getClientSharedKey: (senderId: string) => sas.clientSharedKeys.get(senderId) || null,
    getClientFingerprint: (senderId?: string) =>
      senderId ? sas.clientFingerprints.get(senderId) : Array.from(sas.clientFingerprints.values())[0],
    getClientSecurityFingerprint: () => sas.clientSecurityFingerprint,
    onHostClientClosed: (targetSender: string) => {
      clients.delete(targetSender)
      sas.cleanupPeerResources(targetSender)
      hostQueues.delete(targetSender)
      preOfferCandidates.delete(targetSender)
      const scoutId = clientIdToScoutId.get(targetSender)
      if (scoutId) {
        const set = scoutIdToClientIds.get(scoutId)
        if (set) {
          set.delete(targetSender)
          if (set.size === 0) scoutIdToClientIds.delete(scoutId)
        }
        clientIdToScoutId.delete(targetSender)
      }
      clientIdToScoutName.delete(targetSender)
    },
    updateHostStatus,
    getClientDcState: () => clientDc?.readyState,
    getClientPc: () => clientPc,
    isExplicitlyClosed: () => isExplicitlyClosed,
    isDirectIpv6Eligible: (targetSender?: string) => {
      if (isHostMode) {
        return Boolean((hostSignalingHandler as any)?.isPeerDirectIpv6Eligible?.(targetSender))
      } else {
        return Boolean(clientSession?.isDirectIpv6Eligible?.())
      }
    },
    onDirectNicFallback: (targetSender?: string) => {
      if (isHostMode) {
        ;(hostSignalingHandler as any)?.handleDirectNicFallback?.(targetSender)
      } else {
        clientSession?.handleDirectNicFallback?.()
      }
    }
  })

  const dispatcher = createMessageDispatcher({
    isHostMode: () => isHostMode,
    getCurrentInviteCode: () => currentInviteCode,
    getHostSessionId: () => hostSessionId,
    getCurrentEventMetadata: () => currentEventMetadata,
    clients,
    stagedClients,
    scoutIdToClientIds,
    clientIdToScoutId,
    clientIdToScoutName,
    offlineMessages,
    sas,
    getClientDc: () => clientDc,
    getClientSender: () => clientSender,
    setClientSender: (sender) => {
      clientSender = sender
    },
    setStatus,
    getLocalUserId: () => localUserId,
    setLocalUserId: (id) => {
      localUserId = id
    },
    getLocalUserName: () => localUserName,
    setLocalUserName: (name) => {
      localUserName = name
    },
    getHostSeqCounter: () => hostSeqCounter,
    setHostSeqCounter: (seq) => {
      hostSeqCounter = seq
    },
    onClientConnected: callbacks.onClientConnected,
    onRequestSync: (sinceVersion, clientId) => callbacks.onRequestSync(sinceVersion, clientId)
  })

  const {
    sendMessage,
    promoteTakeover,
    requestSync,
    pushRecords,
    ackRecords,
    sendDirectMessage,
    broadcastTagUpdate,
    sendTagsFullSync,
    requestTagsSync,
    requestTakeover,
    sendTakeoverDecision,
    sendIdentityMigration,
    initHostSeq,
    stampHostSeq,
    sendHostHandoffBatch,
    sendHostHandoffAck
  } = dispatcher

  const pendingMergeRequests = new Map<
    string,
    {
      resolve: (res: { success: boolean; newId?: string; newUsername?: string; token?: string; error?: string }) => void
      reject: (err: any) => void
      timer: any
    }
  >()

  function requestAccountMerge(
    targetUsername: string,
    targetPassword: string,
    sourceUserId: string,
    sourceUsername: string
  ): Promise<{ success: boolean; newId?: string; newUsername?: string; token?: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const requestId = `merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const timer = setTimeout(() => {
        pendingMergeRequests.delete(requestId)
        resolve({ success: false, error: 'Merge request timed out (15s)' })
      }, 15000)

      pendingMergeRequests.set(requestId, { resolve, reject, timer })

      sendMessage({
        type: 'MERGE_ACCOUNT_REQUEST',
        requestId,
        targetUsername,
        targetPassword,
        sourceUserId,
        sourceUsername,
        authCode: currentInviteCode
      }).catch((err) => {
        clearTimeout(timer)
        pendingMergeRequests.delete(requestId)
        resolve({ success: false, error: err?.message || 'Failed to send merge request' })
      })
    })
  }

  function handleMergeAccountResponse(msg: any) {
    const pending = pendingMergeRequests.get(msg.requestId)
    if (pending) {
      clearTimeout(pending.timer)
      pendingMergeRequests.delete(msg.requestId)
      pending.resolve({
        success: Boolean(msg.success),
        newId: msg.newId,
        newUsername: msg.newUsername,
        token: msg.token,
        error: msg.error
      })
    }
  }

  const rawHandleChannelMessage = createChannelMessageHandler({
    isHostMode: () => isHostMode,
    currentInviteCode: () => currentInviteCode,
    getCurrentEventId: () => currentEventMetadata?.id || '',
    getHostSessionId: () => hostSessionId,
    getCurrentHostSessionId: () => currentHostSessionId,
    setCurrentHostSessionId: (id: string) => {
      currentHostSessionId = id
    },
    handleMergeAccountResponse,
    callbacks,
    clients,
    stagedClients,
    scoutIdToClientIds,
    clientIdToScoutId,
    clientIdToScoutName,
    pendingTakeovers,
    takeoverCooldowns,
    offlineMessages,
    sendMessage,
    promoteTakeover,
    enqueueHostTask,
    cleanupPeerResources: (peerId: string) => {
      sas.cleanupPeerResources(peerId)
      hostQueues.delete(peerId)
      preOfferCandidates.delete(peerId)
      const scoutId = clientIdToScoutId.get(peerId)
      if (scoutId) {
        const set = scoutIdToClientIds.get(scoutId)
        if (set) {
          set.delete(peerId)
          if (set.size === 0) scoutIdToClientIds.delete(scoutId)
        }
        clientIdToScoutId.delete(peerId)
      }
      clientIdToScoutName.delete(peerId)
    },
    stampHostSeq,
    getHostSeqCounter: () => hostSeqCounter,
    setHostSeqCounter: (n: number) => {
      hostSeqCounter = n
    },
    closeClient: () => {
      if (clientDc) {
        clientDc.onclose = null
        clientDc.close()
        clientDc = null
      }
      if (clientPc) {
        clientPc.close()
        clientPc = null
      }
    },
    setStatus,
    isTakeoverReconciling: () => inTakeoverReconciliation,
    waitForTakeoverReconciliation,
    finishTakeoverReconciliation,
    getUsername: () => currentUsername,
    getUserId: () => currentUserId,
    onPongReceived: (ts: number) => clientSession.handlePong(ts)
  })

  async function handleChannelMessage(ev: MessageEvent, senderId?: string): Promise<void> {
    const peerSas = isHostMode
      ? senderId
        ? sas.clientSasStates.get(senderId) || 'VERIFIED'
        : 'VERIFIED'
      : sas.clientSasState

    let isControlMsg = false
    try {
      if (typeof ev.data === 'string') {
        const parsed = JSON.parse(ev.data)
        if (
          parsed.type === 'SESSION_CONFLICT' ||
          parsed.type === 'SESSION_KICKED' ||
          parsed.type === 'TAKEOVER_PROMPT'
        ) {
          isControlMsg = true
        }
      }
    } catch {}

    if (peerSas === 'PENDING_VERIFICATION' && !isControlMsg) {
      log.info(`Buffering incoming message from ${senderId || 'host'} (SAS pending verification)`)
      if (isHostMode && senderId) {
        const q = sas.hostPendingIncoming.get(senderId) || []
        q.push({ ev, senderId })
        sas.hostPendingIncoming.set(senderId, q)
      } else {
        sas.clientPendingIncoming.push({ ev, senderId })
      }
      return
    }

    if (peerSas === 'REJECTED') {
      log.warn(`Discarding message from rejected peer ${senderId || 'host'}`)
      return
    }

    return rawHandleChannelMessage(ev, senderId)
  }

  function confirmSas(peerId = 'host'): void {
    log.info(`Confirming SAS verification for peer ${peerId}`)
    sas.confirmSas(peerId, isHostMode, currentInviteCode, callbacks, sendMessage, handleChannelMessage)
    if (isHostMode && peerId && peerId !== 'host') {
      signaling?.send({ type: 'sas_verified', hostSessionId }, peerId)
    } else if (!isHostMode) {
      signaling?.send({ type: 'sas_verified', clientSessionId: currentClientSessionId })
    }
  }

  function rejectSas(peerId = 'host', reason = 'Security code verification rejected'): void {
    log.warn(`Rejecting SAS verification for peer ${peerId}. Reason: ${reason}`)
    if (isHostMode && peerId && peerId !== 'host') {
      signaling?.send({ type: 'sas_rejected', reason, hostSessionId }, peerId)
    } else if (!isHostMode) {
      signaling?.send({ type: 'sas_rejected', reason, clientSessionId: currentClientSessionId })
    }
    sas.rejectSas(
      peerId,
      reason,
      isHostMode,
      callbacks,
      (targetPeerId: string) => {
        const client = clients.get(targetPeerId) || stagedClients.get(targetPeerId)
        if (client) {
          try {
            if (client.dc) client.dc.close()
          } catch {}
          try {
            if (client.pc) client.pc.close()
          } catch {}
          clients.delete(targetPeerId)
          stagedClients.delete(targetPeerId)
        }
      },
      () => {
        try {
          if (clientDc) clientDc.close()
        } catch {}
        try {
          if (clientPc) clientPc.close()
        } catch {}
        setStatus('offline')
      }
    )
  }

  async function retrySas(peerId = 'host'): Promise<void> {
    if (isHostMode) {
      if (peerId && peerId !== 'host') {
        const fp = sas.clientFingerprints.get(peerId)
        if (fp && signaling) {
          sas.clientSasStates.set(peerId, 'PENDING_VERIFICATION')
          const username = sas.clientVerifiedIdentities.get(peerId)?.username || clientIdToScoutName.get(peerId) || 'Client'
          callbacks.onSasVerificationRequired?.(
            {
              peerId,
              username,
              ecdhPublicKey: sas.clientEcdhPubHexes.get(peerId) || ''
            },
            fp
          )
          signaling.send(
            {
              type: 'sas_challenge',
              fingerprint: fp,
              hostSessionId,
              username: resolveCurrentUsername()
            },
            peerId
          )
        }
      }
    } else {
      sas.clientSasState = 'PENDING_VERIFICATION'
      if (!clientPc || clientPc.connectionState !== 'connected' || !clientDc || clientDc.readyState !== 'open') {
        await reconnectNow()
      } else if (signaling && signaling.isConnected()) {
        signaling.send({ type: 'sas_retry', clientSessionId: currentClientSessionId })
      }
      if (sas.clientSecurityFingerprint) {
        callbacks.onSasVerificationRequired?.(
          {
            peerId: 'host',
            username: sas.clientHostUsername || 'Node',
            ecdhPublicKey: sas.clientHostEcdhPubHex || ''
          },
          sas.clientSecurityFingerprint
        )
      }
    }
  }

  const hostSignalingHandler = createHostSignalingHandler({
    clients,
    stagedClients,
    preOfferCandidates,
    enqueueHostTask,
    updateHostStatus,
    peerMgr,
    sas,
    getSignaling: () => signaling,
    getLocalEcdhKeyPair: () => localEcdhKeyPair,
    getLocalEcdhPubHex: () => localEcdhPubHex,
    getLocalDeviceId: () => localDeviceId,
    getHostSessionId: () => hostSessionId,
    getCurrentInviteCode: () => currentInviteCode,
    getCurrentEventMetadata: () => currentEventMetadata,
    sendMessage,
    handleChannelMessage,
    rejectSas,
    confirmSas,
    getUsername: resolveCurrentUsername,
    getUserId: resolveCurrentUserId,
    callbacks
  })

  const clientSession = createClientSession({
    peerMgr,
    sas,
    getSignaling: () => signaling,
    getLocalEcdhKeyPair: () => localEcdhKeyPair,
    getLocalEcdhPubHex: () => localEcdhPubHex,
    getLocalDeviceId: () => localDeviceId,
    getCurrentInviteCode: () => currentInviteCode,
    getCurrentHostSessionId: () => currentHostSessionId,
    setCurrentHostSessionId: (id: string) => {
      currentHostSessionId = id
    },
    getClientSessionId: () => currentClientSessionId,
    setClientSessionId: (id: string) => {
      currentClientSessionId = id
    },
    getClientHostSenderId: () => clientHostSenderId,
    setClientHostSenderId: (id: string) => {
      clientHostSenderId = id
    },
    getClientPc: () => clientPc,
    setClientPc: (pc) => {
      clientPc = pc
    },
    getClientDc: () => clientDc,
    setClientDc: (dc) => {
      clientDc = dc
    },
    setClientSender: (sender) => {
      clientSender = sender
    },
    getClientPendingCandidates: () => clientPendingCandidates,
    setClientPendingCandidates: (cands) => {
      clientPendingCandidates = cands
    },
    getClientForceRelay: () => clientForceRelay,
    setClientForceRelay: (force) => {
      clientForceRelay = force
    },
    isExplicitlyClosed: () => isExplicitlyClosed,
    getStatus: () => status,
    setStatus,
    sendMessage,
    handleChannelMessage,
    rejectSas,
    confirmSas,
    getUsername: resolveCurrentUsername,
    getUserId: resolveCurrentUserId,
    callbacks
  })

  function startHostHeartbeat() {
    stopHostHeartbeat()
    const payload = {
      type: 'host_heartbeat',
      hostSessionId,
      deviceId: localDeviceId,
      ecdhPublicKey: localEcdhPubHex,
      timestamp: Date.now(),
      hostEpoch: localEpoch,
      username: resolveCurrentUsername(),
      userId: resolveCurrentUserId()
    }
    if (isHostMode && signaling) {
      signaling.send(payload)
    }
    hostHeartbeatTimer = setInterval(() => {
      if (isHostMode && signaling) {
        signaling.send({
          ...payload,
          timestamp: Date.now(),
          hostEpoch: localEpoch,
          username: resolveCurrentUsername(),
          userId: resolveCurrentUserId()
        })
      }
    }, 3000)
  }

  function stopHostHeartbeat() {
    if (hostHeartbeatTimer) {
      clearInterval(hostHeartbeatTimer)
      hostHeartbeatTimer = null
    }
  }

  function startStandbyWatchdog() {
    lastActiveHostHeartbeat = Date.now()
    if (!standbyWatchdogTimer) {
      const timeoutMs = (globalThis as any).__TEST_WATCHDOG_TIMEOUT_MS__ ?? 5000
      const checkIntervalMs = (globalThis as any).__TEST_WATCHDOG_INTERVAL_MS__ ?? 2000
      standbyWatchdogTimer = setInterval(() => {
        if (isStandbyHostMode && lastActiveHostHeartbeat > 0 && Date.now() - lastActiveHostHeartbeat > timeoutMs) {
          log.warn(`[Standby Watchdog] Active host heartbeat missing for >${timeoutMs}ms, notifying active host left`)
          peerMgr.resetTransportInfo()
          setStatus('degraded')
          callbacks.onActiveHostLeft?.()
        }
      }, checkIntervalMs)
    }
  }

  function stopStandbyWatchdog() {
    if (standbyWatchdogTimer) {
      clearInterval(standbyWatchdogTimer)
      standbyWatchdogTimer = null
    }
    lastActiveHostHeartbeat = 0
  }

  async function enterStandbyMode(existingHostSessionId: string, existingDeviceId?: string) {
    if (isMobileDevice()) {
      log.info('Mobile device ignored enterStandbyMode; strictly acting as scout client.')
      return
    }
    log.info(`Entering standby mode. Existing active host: ${existingHostSessionId}`)
    stopHostHeartbeat()
    startStandbyWatchdog()
    if (probeTimer) {
      clearTimeout(probeTimer)
      probeTimer = null
    }
    isProbing = false
    isHostMode = false
    isStandbyHostMode = true
    activeHostSessionId = existingHostSessionId
    currentHostSessionId = existingHostSessionId
    activeHostDeviceId = existingDeviceId || ''
    callbacks.onHostStandby?.({ hostSessionId: existingHostSessionId, hostDeviceId: existingDeviceId })

    if (localEcdhPubHex) {
      signaling?.send({ type: 'client_hello', ecdhPublicKey: localEcdhPubHex, deviceId: localDeviceId })
    }
    const isConnectedAndOpen = clientPc && clientPc.connectionState === 'connected' && clientDc && clientDc.readyState === 'open'
    if (!isConnectedAndOpen) {
      await clientSession.setupClientConnection()
    }
  }

  async function demoteToStandby(newHostSessionId: string, newDeviceId?: string) {
    if (isMobileDevice()) {
      log.info('Mobile device ignored demoteToStandby.')
      return
    }
    log.info(`Demoted to Standby by new host: ${newHostSessionId}`)
    stopHostHeartbeat()
    startStandbyWatchdog()
    isHostMode = false
    isStandbyHostMode = true
    activeHostSessionId = newHostSessionId
    currentHostSessionId = newHostSessionId
    activeHostDeviceId = newDeviceId || ''

    clients.forEach((c) => {
      if (c.dc) c.dc.onclose = null
      c.pc.onconnectionstatechange = null
      c.pc.oniceconnectionstatechange = null
      c.dc?.close()
      c.pc.close()
    })
    clients.clear()
    stagedClients.forEach((c) => {
      if (c.dc) c.dc.onclose = null
      c.pc.onconnectionstatechange = null
      c.pc.oniceconnectionstatechange = null
      c.dc?.close()
      c.pc.close()
    })
    stagedClients.clear()
    scoutIdToClientIds.clear()
    clientIdToScoutId.clear()
    clientIdToScoutName.clear()
    hostQueues.clear()
    preOfferCandidates.clear()

    callbacks.onHostDemoted?.({ hostSessionId: newHostSessionId, hostDeviceId: newDeviceId })

    if (localEcdhPubHex) {
      signaling?.send({ type: 'client_hello', ecdhPublicKey: localEcdhPubHex, deviceId: localDeviceId })
    }
    await clientSession.setupClientConnection()
  }

  async function takeoverHost(): Promise<void> {
    if (isMobileDevice()) {
      log.warn('Mobile devices are strictly prohibited from acting as host or taking over host.')
      return
    }
    log.info('Standby device initiating takeover to become Active Host!')
    stopStandbyWatchdog()
    clientSession.stopDataChannelHeartbeat()
    peerMgr.resetTransportInfo()
    setStatus('waiting')
    const newHostSessionId = `host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    hostSessionId = newHostSessionId
    const nextEpoch = localEpoch + 1
    setLocalEpoch(nextEpoch)
    startTakeoverReconciliation(2000)

    await signaling?.send({
      type: 'host_takeover',
      oldHostSessionId: activeHostSessionId,
      newHostSessionId,
      deviceId: localDeviceId,
      hostEpoch: nextEpoch,
      username: resolveCurrentUsername(),
      userId: resolveCurrentUserId()
    })

    if (clientDc) {
      clientDc.onclose = null
      clientDc.close()
      clientDc = null
    }
    if (clientPc) {
      clientPc.close()
      clientPc = null
    }

    scoutIdToClientIds.clear()
    clientIdToScoutId.clear()
    clientIdToScoutName.clear()
    hostQueues.clear()
    preOfferCandidates.clear()

    isStandbyHostMode = false
    isHostMode = true

    await signaling?.send({
      type: 'host_hello',
      hostSessionId: newHostSessionId,
      hostIpv6: (hostSignalingHandler as any)?.getHostIpv6?.() || undefined,
      ecdhPublicKey: localEcdhPubHex,
      deviceId: localDeviceId,
      hostEpoch: nextEpoch,
      username: resolveCurrentUsername(),
      userId: resolveCurrentUserId()
    })
    startHostHeartbeat()
    callbacks.onHostPromoted?.()
    updateHostStatus()
  }

  // =====================================================
  // Host: create room & wait for client offer
  // =====================================================
  function resolveTargetSignalingEndpoint(preferredBroker?: string): string {
    const activeTarget = preferredBroker || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('sp27-active-broker') : null) || undefined
    return resolveBrokerUrl(activeTarget)
  }

  async function host(inviteCode: string, eventMetadata?: ScoutingEvent, username?: string, userId?: string, preferredBroker?: string): Promise<void> {
    if (isMobileDevice()) {
      log.warn('Mobile devices are strictly prohibited from acting as host. Falling back to join() client mode.')
      return join(inviteCode, username, userId, preferredBroker)
    }
    isHostMode = true
    isStandbyHostMode = false
    isProbing = true
    isExplicitlyClosed = false
    currentInviteCode = inviteCode
    setLocalEpoch(Math.max(localEpoch, 1))
    if (username) currentUsername = username
    if (userId) currentUserId = userId
    if (eventMetadata) {
      currentEventMetadata = eventMetadata
    }
    clients.forEach((c) => {
      if (c.dc) c.dc.onclose = null
      c.pc.onconnectionstatechange = null
      c.pc.oniceconnectionstatechange = null
      c.dc?.close()
      c.pc.close()
    })
    clients.clear()
    stagedClients.clear()
    scoutIdToClientIds.clear()
    clientIdToScoutId.clear()
    clientIdToScoutName.clear()
    hostQueues.clear()
    preOfferCandidates.clear()

    hostSessionId = `host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setStatus('connecting')

    try {
      localDeviceIdentity = await getOrCreateDeviceIdentity()
      localEcdhKeyPair = localDeviceIdentity.keyPair
      localEcdhPubHex = localDeviceIdentity.publicKeyHex
      localDeviceId = localDeviceIdentity.deviceId
      log.info(`Using persistent device identity: ${localDeviceId}`)
    } catch (e) {
      log.warn('Ephemeral ECDH generation fallback:', e)
      try {
        localEcdhKeyPair = await generateEcdhKeyPair()
        localEcdhPubHex = localEcdhKeyPair ? await exportEcdhPublicKey(localEcdhKeyPair.publicKey) : ''
      } catch (err) {
        log.warn('ECDH unavailable in insecure context:', err)
        localEcdhKeyPair = null
        localEcdhPubHex = ''
      }
    }

    signaling = new SignalingChannel(inviteCode, resolveTargetSignalingEndpoint(preferredBroker))
    await signaling.initTopic()

    const sessionStartTime = Date.now()

    const onHostSignalingMessage = async (data: any) => {
      if (!data) return

      // When another device is actively probing, if this device is the Active Host, reply immediately!
      if (data.type === 'host_probe') {
        if (data.sender === signaling?.clientId || data.hostSessionId === hostSessionId) {
          return
        }
        if (isHostMode && !isStandbyHostMode && data.hostSessionId !== hostSessionId) {
          await signaling?.send({
            type: 'host_heartbeat',
            hostSessionId,
            deviceId: localDeviceId,
            ecdhPublicKey: localEcdhPubHex,
            timestamp: Date.now(),
            hostEpoch: localEpoch,
            username: resolveCurrentUsername(),
            userId: resolveCurrentUserId()
          })
        }
        return
      }

      if (isProbing) {
        if (
          (data.type === 'host_heartbeat' || data.type === 'host_hello') &&
          data.hostSessionId !== hostSessionId
        ) {
          if (data.sender === signaling?.clientId) {
            return
          }
          // Stale messages from own device's prior session (e.g. before page reload) must NOT trigger standby demotion
          if (data.deviceId && data.deviceId === localDeviceId) {
            const msgTs = Number(data.timestamp || 0)
            if (msgTs && msgTs < sessionStartTime - 100) {
              log.info(`Ignoring stale host message from same device prior session during probe: ${data.hostSessionId}`)
              return
            }
          }
          log.info(`Discovered existing host during probe: ${data.hostSessionId} (sender: ${data.sender})`)
          if (probeTimer) {
            clearTimeout(probeTimer)
            probeTimer = null
          }
          isProbing = false
          await enterStandbyMode(data.hostSessionId, data.deviceId)
          return
        }
      }

      if (data.type === 'host_heartbeat' || data.type === 'host_hello') {
        const hasIncomingEpoch = data.hostEpoch !== undefined && data.hostEpoch !== null
        const incomingEpoch = hasIncomingEpoch ? Number(data.hostEpoch) : localEpoch
        const incomingDeviceId = String(data.deviceId ?? '')
        const incomingSessionId = String(data.hostSessionId ?? '')

        if (incomingSessionId && incomingSessionId !== hostSessionId) {
          if (data.sender === signaling?.clientId) {
            return
          }
          if (isStandbyHostMode) {
            activeHostSessionId = incomingSessionId
            activeHostDeviceId = incomingDeviceId
            if (hasIncomingEpoch) {
              setLocalEpoch(Math.max(localEpoch, incomingEpoch))
            }
            lastActiveHostHeartbeat = Date.now()
            if (data.type === 'host_hello') {
              await clientSession.handleClientSignalingMessage(data)
            }
            return
          }
          if (isHostMode) {
            // 使用严格全序比较器判定胜负，杜绝低 Epoch 旧心跳错误降级新任期主机！
            const cmp = compareHostAuthority(
              localEpoch,
              localDeviceId,
              hostSessionId,
              incomingEpoch,
              incomingDeviceId,
              incomingSessionId
            )
            if (cmp < 0) {
              log.info(
                `Local host session yields to higher-authority host: ${incomingSessionId} (epoch ${incomingEpoch} vs local ${localEpoch})`
              )
              if (hasIncomingEpoch) {
                setLocalEpoch(incomingEpoch)
              }
              await demoteToStandby(incomingSessionId, incomingDeviceId)
              return
            } else if (cmp > 0) {
              // 本地主机权威更高，压制低权威对端并重发心跳通知其降级
              log.warn(
                `Suppressed lower-authority heartbeat/hello (epoch: ${incomingEpoch} vs local ${localEpoch}, sender: ${incomingSessionId})`
              )
              await signaling?.send({
                type: 'host_heartbeat',
                hostSessionId,
                deviceId: localDeviceId,
                ecdhPublicKey: localEcdhPubHex,
                timestamp: Date.now(),
                hostEpoch: localEpoch,
                username: resolveCurrentUsername(),
                userId: resolveCurrentUserId()
              })
              return
            }
          }
        }
        return
      }

      if (data.type === 'host_takeover') {
        if (data.sender === signaling?.clientId || data.newHostSessionId === hostSessionId) {
          return
        }
        const hasIncomingEpoch = data.hostEpoch !== undefined && data.hostEpoch !== null
        const incomingEpoch = Number(data.hostEpoch ?? 0)
        const incomingDeviceId = String(data.deviceId ?? '')
        const incomingSessionId = String(data.newHostSessionId ?? '')

        if (isHostMode && data.sender !== signaling?.clientId) {
          const cmp = compareHostAuthority(
            localEpoch,
            localDeviceId,
            hostSessionId,
            incomingEpoch,
            incomingDeviceId,
            incomingSessionId
          )

          const incomingWins = !hasIncomingEpoch || cmp < 0

          if (incomingWins) {
            log.info(
              `Yielding to higher-authority takeover: ${incomingSessionId} (epoch ${incomingEpoch} vs local ${localEpoch})`
            )
            setLocalEpoch(Math.max(localEpoch, incomingEpoch))
            await demoteToStandby(incomingSessionId, incomingDeviceId)
            return
          } else {
            log.warn(
              `Suppressed lower-authority takeover (epoch: ${incomingEpoch} vs local ${localEpoch}, deviceId: ${incomingDeviceId} vs ${localDeviceId})`
            )
            signaling?.send({
              type: 'host_hello',
              hostSessionId,
              ecdhPublicKey: localEcdhPubHex,
              deviceId: localDeviceId,
              hostEpoch: localEpoch,
              username: resolveCurrentUsername(),
              userId: resolveCurrentUserId()
            })
            return
          }
        } else {
          activeHostSessionId = incomingSessionId
          activeHostDeviceId = incomingDeviceId
          if (hasIncomingEpoch) {
            setLocalEpoch(Math.max(localEpoch, incomingEpoch))
          }
          lastActiveHostHeartbeat = Date.now()
        }
        return
      }

      if (data.type === 'HOST_LEAVING') {
        if (data.sender === signaling?.clientId || data.hostSessionId === hostSessionId) {
          return
        }
        if (isStandbyHostMode && data.hostSessionId === activeHostSessionId) {
          callbacks.onActiveHostLeft?.()
        }
        return
      }

      if (isHostMode) {
        hostSignalingHandler(data)
      } else {
        await clientSession.handleClientSignalingMessage(data)
      }
    }

    signaling.connect({
      onConnect: () => {
        const probeMs = (globalThis as any).__TEST_PROBE_MS__ ?? 1200
        isProbing = true
        // Actively probe for existing active host
        signaling!.send({
          type: 'host_probe',
          hostSessionId,
          deviceId: localDeviceId
        })
        probeTimer = setTimeout(() => {
          if (isProbing) {
            isProbing = false
            probeTimer = null
            isStandbyHostMode = false
            isHostMode = true
            updateHostStatus()
            signaling!.send({
              type: 'host_hello',
              hostSessionId,
              hostIpv6: (hostSignalingHandler as any)?.getHostIpv6?.() || undefined,
              ecdhPublicKey: localEcdhPubHex,
              deviceId: localDeviceId,
              hostEpoch: localEpoch,
              username: resolveCurrentUsername(),
              userId: resolveCurrentUserId()
            })
            startHostHeartbeat()
            callbacks.onHostPromoted?.()
          }
        }, probeMs)
      },
      onError: () => {
        updateHostStatus()
      },
      onMessage: onHostSignalingMessage
    })
  }

  // =====================================================
  // Client: join a room via invite code
  // =====================================================
  async function join(inviteCode: string, username?: string, userId?: string, preferredBroker?: string): Promise<void> {
    isHostMode = false
    isExplicitlyClosed = false
    currentInviteCode = inviteCode
    if (username) currentUsername = username
    if (userId) currentUserId = userId
    setStatus('connecting')

    try {
      localDeviceIdentity = await getOrCreateDeviceIdentity()
      localEcdhKeyPair = localDeviceIdentity.keyPair
      localEcdhPubHex = localDeviceIdentity.publicKeyHex
      localDeviceId = localDeviceIdentity.deviceId
      console.log(`[WebRTC Client] Using persistent device identity: ${localDeviceId}`)
    } catch (e) {
      console.warn('[WebRTC Client] Ephemeral ECDH generation fallback:', e)
      try {
        localEcdhKeyPair = await generateEcdhKeyPair()
        localEcdhPubHex = localEcdhKeyPair ? await exportEcdhPublicKey(localEcdhKeyPair.publicKey) : ''
      } catch (err) {
        console.warn('[WebRTC Client] ECDH unavailable in insecure context:', err)
        localEcdhKeyPair = null
        localEcdhPubHex = ''
      }
    }

    signaling = new SignalingChannel(inviteCode, resolveTargetSignalingEndpoint(preferredBroker))
    await signaling.initTopic()

    signaling.connect({
      onConnect: async () => {
        if (localEcdhPubHex) {
          signaling!.send({ type: 'client_hello', ecdhPublicKey: localEcdhPubHex, deviceId: localDeviceId })
        }
        const isConnectedAndOpen = clientPc && clientPc.connectionState === 'connected' && clientDc && clientDc.readyState === 'open'
        if (!isConnectedAndOpen) {
          await clientSession.setupClientConnection()
        }
      },
      onError: () => setStatus('offline'),
      onMessage: async (data: any) => {
        await clientSession.handleClientSignalingMessage(data)
      }
    })
  }

  async function reconnectNow(forceFreshSignaling = false): Promise<boolean> {
    isExplicitlyClosed = false
    if (!isHostMode && sas.clientSasState === 'REJECTED') {
      log.warn('Circuit breaker active: SAS verification was rejected. Suppressing automatic reconnection.')
      return false
    }
    if (isHostMode) {
      if (currentInviteCode) {
        await host(currentInviteCode)
        return true
      }
      return false
    }

    if (!forceFreshSignaling && status === 'connected' && clientDc?.readyState === 'open' && clientPc?.connectionState === 'connected') {
      return true
    }

    clientSession.clearReconnectTimer()
    clientSession.resetReconnectAttempts()
    clientSession.resetOfferTimestamp()
    setStatus('connecting')

    const needsFreshSignaling = forceFreshSignaling || !signaling || !signaling.isConnected()

    if (needsFreshSignaling) {
      if (signaling) {
        try { signaling.close() } catch (_) {}
        signaling = null
      }
      signaling = new SignalingChannel(currentInviteCode, resolveTargetSignalingEndpoint())
      await signaling.initTopic()
      signaling.connect({
        onConnect: async () => {
          if (localEcdhPubHex) {
            signaling!.send({ type: 'client_hello', ecdhPublicKey: localEcdhPubHex, deviceId: localDeviceId })
          }
          if (
            !forceFreshSignaling &&
            clientPc &&
            clientPc.connectionState === 'connected' &&
            clientDc &&
            clientDc.readyState === 'open'
          ) {
            return
          }
          await clientSession.setupClientConnection(clientForceRelay)
        },
        onError: () => {
          if (status !== 'connected' && (!clientPc || clientPc.connectionState !== 'connected')) {
            setStatus('offline')
          }
        },
        onMessage: async (data: any) => {
          await clientSession.handleClientSignalingMessage(data)
        }
      })
    } else {
      if (signaling && localEcdhPubHex) {
        signaling.send({ type: 'client_hello', ecdhPublicKey: localEcdhPubHex, deviceId: localDeviceId })
      }
      await clientSession.setupClientConnection(clientForceRelay)
    }
    return true
  }

  const selfHealing = setupSelfHealing({
    getStatus: () => status,
    reconnectNow,
    isHealthy: () => {
      if (isHostMode) return true
      return Boolean(clientDc && clientDc.readyState === 'open' && clientPc && clientPc.connectionState === 'connected')
    },
    pingPeer: async () => {
      if (isHostMode) return true
      return await clientSession.pingHost(800)
    },
    isConflictActive: () => Boolean(callbacks.isConflictActive?.())
  })

  function setEventMetadata(meta: ScoutingEvent) {
    currentEventMetadata = meta
  }

  function disconnect() {
    isExplicitlyClosed = true
    selfHealing.dispose()
    clientSession.clearReconnectTimer()

    if (probeTimer) {
      clearTimeout(probeTimer)
      probeTimer = null
    }
    isProbing = false
    stopHostHeartbeat()
    stopStandbyWatchdog()
    isStandbyHostMode = false

    if (isHostMode) {
      if (signaling) {
        signaling.send({
          type: 'HOST_LEAVING',
          hostSessionId,
          deviceId: localDeviceId
        })
      }
      clients.forEach((c) => {
        if (c.dc) c.dc.onclose = null
        c.pc.onconnectionstatechange = null
        c.pc.oniceconnectionstatechange = null
        c.dc?.close()
        c.pc.close()
      })
      clients.clear()

      stagedClients.forEach((c) => {
        if (c.dc) c.dc.onclose = null
        c.pc.onconnectionstatechange = null
        c.pc.oniceconnectionstatechange = null
        c.dc?.close()
        c.pc.close()
      })
      stagedClients.clear()
      hostQueues.clear()
      preOfferCandidates.clear()
      offlineMessages.clear()
      scoutIdToClientIds.clear()
      clientIdToScoutId.clear()
      clientIdToScoutName.clear()
      pendingTakeovers.forEach((p) => clearTimeout(p.timeoutTimer))
      pendingTakeovers.clear()
      takeoverCooldowns.clear()
      finishTakeoverReconciliation('closed')
    } else {
      clientSender = null
      if (clientDc) clientDc.onclose = null
      if (clientPc) {
        clientPc.onconnectionstatechange = null
        clientPc.oniceconnectionstatechange = null
      }
      clientDc?.close()
      clientPc?.close()
      clientDc = null
      clientPc = null
    }

    sas.clear()
    peerMgr.clientIceRestartAttempts = 0
    peerMgr.hostIceRestartAttempts.clear()
    clientForceRelay = false

    for (const [, req] of pendingMergeRequests) {
      clearTimeout(req.timer)
      req.resolve({ success: false, error: 'Disconnected before merge completed' })
    }
    pendingMergeRequests.clear()

    signaling?.close()
    signaling = null
    setStatus('offline')
  }

  return {
    host,
    setEventMetadata,
    join,
    requestSync,
    pushRecords,
    ackRecords,
    sendMessage,
    sendDirectMessage,
    broadcastTagUpdate,
    sendTagsFullSync,
    requestTagsSync,
    requestTakeover,
    sendTakeoverDecision,
    sendIdentityMigration,
    takeoverHost,
    sendHostHandoffBatch,
    sendHostHandoffAck,
    getHostSeqCounter: () => hostSeqCounter,
    getCurrentHostSessionId: () => currentHostSessionId,
    isStandbyHost: () => isStandbyHostMode,
    pingPeer: async (timeoutMs?: number) => (isHostMode ? true : clientSession.pingHost(timeoutMs ?? 800)),
    reconnectNow,
    disconnect,
    initHostSeq,
    stampHostSeq,
    confirmSas,
    rejectSas,
    retrySas,
    getSasState: (peerId?: string) => isHostMode ? (peerId ? sas.clientSasStates.get(peerId) || 'PENDING_VERIFICATION' : 'PENDING_VERIFICATION') : sas.clientSasState,
    getSasFingerprint: (peerId?: string) => isHostMode ? (peerId ? sas.clientFingerprints.get(peerId) : undefined) : sas.clientSecurityFingerprint,
    getStatus: () => status,
    getTransportInfo: () => peerMgr.currentTransportInfo,
    getDataChannel: () => (isHostMode ? clients.values().next().value?.dc || null : clientDc),
    isHostMode: () => isHostMode,
    requestAccountMerge,
    updateCallbacks: (newCallbacks: Partial<WebRtcCallbacks>) => {
      Object.assign(callbacks, newCallbacks)
    }
  }
}
