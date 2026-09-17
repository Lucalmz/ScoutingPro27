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
import { SignalingChannel } from './signaling'
import { OfflineMessageManager } from './offlineQueue'
import { createChannelMessageHandler } from './channelMessageHandler'
import { SasSecurityManager } from './sasManager'
import { PeerConnectionManager } from './peerManager'
import { createHostSignalingHandler } from './hostSession'
import { createClientSession } from './clientSession'
import { createMessageDispatcher } from './messageDispatcher'
import { setupSelfHealing } from './selfHealing'
import { createLogger } from '@/utils/logger'

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
  // 中继兜底预算：ICE 停滞看门狗触发 relay-only 重建时消耗一次。
  // 用完后回到 'all' 策略重新尝试 P2P（局域网 / NAT 穿透 / IPv6 直连），
  // 而不是像旧实现那样把 iceTransportPolicy 永久钉死在 'relay'。
  let relayFallbackUsed = 0
  const RELAY_FALLBACK_MAX_ATTEMPTS = 3

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
      // 中继兜底是一次性降级，不是永久状态。预算耗尽后必须回到 'all' 重新
      // 尝试 IPv6/局域网/NAT 直连，否则一次 IPv6 黑洞就会让整个会话再也建不出 P2P 信道。
      if (relayFallbackUsed < RELAY_FALLBACK_MAX_ATTEMPTS) {
        relayFallbackUsed++
        clientForceRelay = true
        log.warn(
          `Relay-only fallback engaged (attempt ${relayFallbackUsed}/${RELAY_FALLBACK_MAX_ATTEMPTS}).`
        )
        clientSession.setupClientConnection(true)
      } else {
        clientForceRelay = false
        log.warn(
          'Relay fallback budget exhausted; retrying with iceTransportPolicy:"all" to recover direct P2P (IPv6/LAN/NAT).'
        )
        clientSession.setupClientConnection(false)
      }
    },
    getLocalEcdhPubHex: () => localEcdhPubHex,
    getCurrentHostSessionId: () => currentHostSessionId,
    getClientSessionId: () => currentClientSessionId,
    getLocalDeviceId: () => localDeviceId,
    getUsername: () => currentUsername || localUserName || '',
    getUserId: () => currentUserId || localUserId || '',
    getClientHostSenderId: () => clientHostSenderId,
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
      // 清理该 peer 的 ICE 重启计数，否则 Map 无界增长，且同一 senderId 复用时
      // 会带着上一次的计数进来，直接跳过 restartIce 走到中继兜底。
      peerMgr.hostIceRestartAttempts.delete(targetSender)
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
    isExplicitlyClosed: () => isExplicitlyClosed
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
    getUserId: () => currentUserId
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
              username: currentUsername || 'Host'
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
            username: 'Host',
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
    getUsername: () => currentUsername,
    getUserId: () => currentUserId,
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
    onRelayFallbackRecovered: () => {
      clientForceRelay = false
      relayFallbackUsed = 0
      peerMgr.clientIceRestartAttempts = 0
    },
    isExplicitlyClosed: () => isExplicitlyClosed,
    getStatus: () => status,
    setStatus,
    sendMessage,
    handleChannelMessage,
    rejectSas,
    confirmSas,
    getUsername: () => currentUsername,
    getUserId: () => currentUserId,
    isStandbyHost: () => isStandbyHostMode,
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
      username: currentUsername || localUserName || 'Host',
      userId: currentUserId || localUserId || 'host'
    }
    if (isHostMode && signaling) {
      signaling.send(payload)
    }
    hostHeartbeatTimer = setInterval(() => {
      if (isHostMode && signaling) {
        signaling.send({
          ...payload,
          timestamp: Date.now(),
          hostEpoch: localEpoch
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
      standbyWatchdogTimer = setInterval(() => {
        if (isStandbyHostMode && lastActiveHostHeartbeat > 0 && Date.now() - lastActiveHostHeartbeat > 8000) {
          log.warn('[Standby Watchdog] Active host heartbeat missing for >8s, notifying active host left')
          callbacks.onActiveHostLeft?.()
        }
      }, 3000)
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
    log.info('Standby device initiating takeover to become Active Host!')
    stopStandbyWatchdog()
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
      username: currentUsername || localUserName || 'Host',
      userId: currentUserId || localUserId || 'host'
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
      ecdhPublicKey: localEcdhPubHex,
      deviceId: localDeviceId,
      hostEpoch: nextEpoch,
      username: currentUsername || localUserName || 'Host',
      userId: currentUserId || localUserId || 'host'
    })
    startHostHeartbeat()
    callbacks.onHostPromoted?.()
    updateHostStatus()
  }

  // =====================================================
  // Host: create room & wait for client offer
  // =====================================================
  async function host(inviteCode: string, eventMetadata?: ScoutingEvent, username?: string, userId?: string): Promise<void> {
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

    signaling = new SignalingChannel(inviteCode)
    await signaling.initTopic()

    const onHostSignalingMessage = async (data: any) => {
      if (!data) return

      // When another device is actively probing, if this device is the Active Host, reply immediately!
      if (data.type === 'host_probe') {
        if (data.deviceId && data.deviceId === localDeviceId) {
          return
        }
        if (isHostMode && !isStandbyHostMode && data.hostSessionId !== hostSessionId) {
          await signaling?.send({
            type: 'host_heartbeat',
            hostSessionId,
            deviceId: localDeviceId,
            timestamp: Date.now()
          })
        }
        return
      }

      if (isProbing) {
        if (
          (data.type === 'host_heartbeat' || data.type === 'host_hello') &&
          data.hostSessionId !== hostSessionId
        ) {
          // Stale messages from own device's prior session must NOT trigger standby demotion
          if (data.deviceId && data.deviceId === localDeviceId) {
            log.info(`Ignoring stale host message from same device during probe: ${data.hostSessionId}`)
            return
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
          if (incomingDeviceId && incomingDeviceId === localDeviceId) {
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
                username: currentUsername || localUserName || 'Host',
                userId: currentUserId || localUserId || 'host'
              })
              return
            }
          }
        }
        return
      }

      if (data.type === 'host_takeover') {
        if (data.deviceId && data.deviceId === localDeviceId) {
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
              username: currentUsername || localUserName || 'Host',
              userId: currentUserId || localUserId || 'host'
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
        if (data.deviceId && data.deviceId === localDeviceId) {
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
            signaling!.send({ type: 'host_hello', hostSessionId, ecdhPublicKey: localEcdhPubHex, deviceId: localDeviceId, hostEpoch: localEpoch })
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
  async function join(inviteCode: string, username?: string, userId?: string): Promise<void> {
    isHostMode = false
    isExplicitlyClosed = false
    currentInviteCode = inviteCode
    // 每次进房都从 P2P 优先 (iceTransportPolicy:'all') 重新开始，
    // 不继承上一次链路的中继降级状态——否则 IPv6/局域网直连将永远无法再建立。
    clientForceRelay = false
    relayFallbackUsed = 0
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

    signaling = new SignalingChannel(inviteCode)
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

  async function reconnectNow(): Promise<boolean> {
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

    if (status === 'connected') return true

    clientSession.clearReconnectTimer()
    clientSession.resetReconnectAttempts()
    // 显式重连 = 网络环境可能已变化，重新给 P2P（含 IPv6 直连）一次机会
    clientForceRelay = false
    relayFallbackUsed = 0
    peerMgr.clientIceRestartAttempts = 0
    setStatus('connecting')

    if (!signaling || !signaling.isConnected()) {
      if (signaling) {
        try { signaling.close() } catch (_) {}
      }
      signaling = new SignalingChannel(currentInviteCode)
      await signaling.initTopic()
      signaling.connect({
        onConnect: async () => {
          if (localEcdhPubHex) {
            signaling!.send({ type: 'client_hello', ecdhPublicKey: localEcdhPubHex, deviceId: localDeviceId })
          }
          if (clientPc && clientPc.connectionState === 'connected' && clientDc && clientDc.readyState === 'open') {
            return
          }
          await clientSession.setupClientConnection()
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
      if (localEcdhPubHex) {
        signaling.send({ type: 'client_hello', ecdhPublicKey: localEcdhPubHex, deviceId: localDeviceId })
      }
      await clientSession.setupClientConnection()
    }
    return true
  }

  const selfHealing = setupSelfHealing({
    getStatus: () => status,
    reconnectNow,
    isHealthy: () => {
      if (isHostMode) return true
      return Boolean(clientDc && clientDc.readyState === 'open' && clientPc && clientPc.connectionState === 'connected')
    }
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
