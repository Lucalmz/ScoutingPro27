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
import { compareHostAuthority, createHostElectionController } from './hostElection'
import { probeLocalInterfaceIpv6, warmUpDoHStunIpv6 } from './connectivity'
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
export { compareHostAuthority }

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
      if (status !== 'connected') setStatus('connected')
    } else if (signaling) {
      if (status !== 'waiting') setStatus('waiting')
    } else {
      if (status !== 'offline') setStatus('offline')
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
    getClientSharedAesKey: () => sas.clientSharedAesKey,
    getClientSharedKey: (senderId: string) => sas.clientSharedKeys.get(senderId) || null,
    getClientFingerprint: (senderId?: string) =>
      senderId ? sas.clientFingerprints.get(senderId) : Array.from(sas.clientFingerprints.values())[0],
    getClientSecurityFingerprint: () => sas.clientSecurityFingerprint,
    getClientHostSenderId: () => clientHostSenderId,
    onHostClientClosed: (targetSender: string, peer?: RTCPeerConnection) => {
      // 身份校验：若当前会话已由 VirtualDataChannel 接管且处于 open，或已被新 Offer 替换，绝不清理会话与 ECDH 密钥！
      const current = clients.get(targetSender) || stagedClients.get(targetSender)
      if (current && (current.dc as any)?.isVirtual && current.dc?.readyState === 'open') {
        log.info(`Ignoring native PeerConnection closure for ${targetSender} because VirtualDataChannel is active`)
        return
      }
      if (peer && current && current.pc !== peer) {
        log.info(`Ignoring closure of superseded PeerConnection for ${targetSender}`)
        return
      }
      if (current?.drainingVirtualDc) {
        try { current.drainingVirtualDc.close() } catch {}
        current.drainingVirtualDc = undefined
      }
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

  let electionCtrl: ReturnType<typeof createHostElectionController>

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
    isTakeoverReconciling: () => electionCtrl.isTakeoverReconciling,
    waitForTakeoverReconciliation: () => electionCtrl.waitForTakeoverReconciliation(),
    finishTakeoverReconciliation: (reason?: string) => electionCtrl.finishTakeoverReconciliation(reason),
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
    if (isHostMode && peerId && peerId !== 'host') {
      const identity = sas.clientVerifiedIdentities.get(peerId)
      const effectiveUserId = identity?.userId || peerId
      const effectiveUsername = identity?.username || peerId
      if (effectiveUserId) {
        clientIdToScoutId.set(peerId, effectiveUserId)
        if (effectiveUsername) {
          clientIdToScoutName.set(peerId, effectiveUsername)
        }
        let cSet = scoutIdToClientIds.get(effectiveUserId)
        if (!cSet) {
          cSet = new Set()
          scoutIdToClientIds.set(effectiveUserId, cSet)
        }
        cSet.add(peerId)
      }
    }
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
          if (client.drainingVirtualDc) {
            try { client.drainingVirtualDc.close() } catch {}
            client.drainingVirtualDc = undefined
          }
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
    callbacks,
    clientIdToScoutId,
    clientIdToScoutName,
    scoutIdToClientIds
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
    getClientSender: () => clientSender,
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
    isHostMode: () => isHostMode,
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

  electionCtrl = createHostElectionController({
    getSignaling: () => signaling,
    getIsHostMode: () => isHostMode,
    setIsHostMode: (val) => {
      isHostMode = val
    },
    getHostSessionId: () => hostSessionId,
    setHostSessionId: (id) => {
      hostSessionId = id
    },
    setCurrentHostSessionId: (id) => {
      currentHostSessionId = id
    },
    getLocalDeviceId: () => localDeviceId,
    getLocalEcdhPubHex: () => localEcdhPubHex,
    getHostIpv6: () => (hostSignalingHandler as any)?.getHostIpv6?.(),
    resolveCurrentUsername,
    resolveCurrentUserId,
    getClientPc: () => clientPc,
    getClientDc: () => clientDc,
    setClientSender: (sender) => {
      clientSender = sender
    },
    clients,
    stagedClients,
    scoutIdToClientIds,
    clientIdToScoutId,
    clientIdToScoutName,
    hostQueues,
    preOfferCandidates,
    peerMgr,
    setStatus,
    updateHostStatus,
    callbacks,
    clientSession,
    hostSignalingHandler
  })

  function resolveTargetSignalingEndpoint(preferredBroker?: string): string {
    const activeTarget = preferredBroker || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('sp27-active-broker') : null) || undefined
    return resolveBrokerUrl(activeTarget)
  }

  async function host(inviteCode: string, eventMetadata?: ScoutingEvent, username?: string, userId?: string, preferredBroker?: string): Promise<void> {
    if (isMobileDevice()) {
      log.warn('Mobile devices are strictly prohibited from acting as host. Falling back to join() client mode.')
      return join(inviteCode, username, userId, preferredBroker)
    }
    electionCtrl.prepareForHostStart()
    if (signaling) {
      try { signaling.close() } catch {}
      signaling = null
    }

    isHostMode = true
    isExplicitlyClosed = false
    currentInviteCode = inviteCode
    if (username) currentUsername = username
    if (userId) currentUserId = userId
    if (eventMetadata) {
      currentEventMetadata = eventMetadata
    }
    clients.forEach((c) => {
      if (c.drainingVirtualDc) {
        try { c.drainingVirtualDc.close() } catch {}
      }
      if (c.dc) c.dc.onclose = null
      c.pc.onconnectionstatechange = null
      c.pc.oniceconnectionstatechange = null
      c.dc?.close()
      c.pc.close()
    })
    clients.clear()
    stagedClients.forEach((c) => {
      if (c.drainingVirtualDc) {
        try { c.drainingVirtualDc.close() } catch {}
      }
      if (c.dc) c.dc.onclose = null
      c.pc.onconnectionstatechange = null
      c.pc.oniceconnectionstatechange = null
      c.dc?.close()
      c.pc.close()
    })
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

    signaling.connect({
      onConnect: () => {
        electionCtrl.startHostProbeWindow()
      },
      onError: () => {
        updateHostStatus()
      },
      onMessage: electionCtrl.createHostSignalingMessageHandler(sessionStartTime)
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
    void probeLocalInterfaceIpv6().catch(() => {})
    void warmUpDoHStunIpv6().catch(() => {})

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
        const isHandshakeActive =
          (clientPc &&
            (clientPc.connectionState === 'connected' ||
              clientPc.connectionState === 'connecting' ||
              clientPc.iceConnectionState === 'checking')) ||
          (clientDc && clientDc.readyState === 'open')
        if (!isHandshakeActive) {
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
      if (signaling && signaling.isConnected() && (status === 'connected' || status === 'waiting')) {
        return true
      }
      if (currentInviteCode) {
        await host(currentInviteCode, currentEventMetadata || undefined, currentUsername || undefined, currentUserId || undefined)
        return true
      }
      return false
    }

    if (
      !forceFreshSignaling &&
      status === 'connected' &&
      clientDc?.readyState === 'open' &&
      ((clientDc as any)?.isVirtual || clientPc?.connectionState === 'connected')
    ) {
      return true
    }

    // 关键硬复位：重连时彻底清除 forceRelay 锁死状态与所有残留旧信道
    clientForceRelay = false
    clientSession.hardResetChannels()
    clientSession.resetReconnectAttempts()
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
          const isHandshakeActive =
            !forceFreshSignaling &&
            (((clientPc &&
              (clientPc.connectionState === 'connected' ||
                clientPc.connectionState === 'connecting' ||
                clientPc.iceConnectionState === 'checking')) ||
              (clientDc && clientDc.readyState === 'open')))
          if (!isHandshakeActive) {
            await clientSession.setupClientConnection(false)
          }
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
      await clientSession.setupClientConnection(false)
    }
    return true
  }

  const selfHealing = setupSelfHealing({
    getStatus: () => status,
    reconnectNow,
    isHostMode: () => isHostMode,
    isHealthy: () => {
      if (isHostMode) return Boolean(signaling && signaling.isConnected())
      return Boolean(
        clientDc &&
          clientDc.readyState === 'open' &&
          ((clientDc as any)?.isVirtual || (clientPc && clientPc.connectionState === 'connected'))
      )
    },
    pingPeer: async () => {
      if (isHostMode) return true
      const isVirtual = Boolean((clientDc as any)?.isVirtual)
      return await clientSession.pingHost(isVirtual ? 2500 : 800)
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
    electionCtrl.stopAllElectionTimers()

    const closingSignaling = signaling
    signaling = null
    let hostLeavingPromise: Promise<void> | null = null

    if (isHostMode) {
      if (closingSignaling) {
        hostLeavingPromise = closingSignaling
          .send({
            type: 'HOST_LEAVING',
            hostSessionId,
            deviceId: localDeviceId
          })
          .catch(() => {})
      }
      clients.forEach((c) => {
        if (c.drainingVirtualDc) {
          try { c.drainingVirtualDc.close() } catch {}
        }
        if (c.dc) c.dc.onclose = null
        c.pc.onconnectionstatechange = null
        c.pc.oniceconnectionstatechange = null
        c.dc?.close()
        c.pc.close()
      })
      clients.clear()

      stagedClients.forEach((c) => {
        if (c.drainingVirtualDc) {
          try { c.drainingVirtualDc.close() } catch {}
        }
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
      electionCtrl.finishTakeoverReconciliation('closed')
    } else {
      if (clientSender) {
        try { clientSender.abort('Service disconnected') } catch (_) {}
      }
      clientSender = null
      clientSession?.hardResetChannels()
      clientDc = null
      clientPc = null
    }

    sas.clear()
    clientForceRelay = false

    for (const [, req] of pendingMergeRequests) {
      clearTimeout(req.timer)
      req.resolve({ success: false, error: 'Disconnected before merge completed' })
    }
    pendingMergeRequests.clear()

    setStatus('offline')
    const isTest =
      (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
      Boolean((globalThis as any).__vitest_worker__) ||
      (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ !== undefined

    if (!isTest && hostLeavingPromise && closingSignaling) {
      void hostLeavingPromise.finally(() => {
        closingSignaling.close()
      })
    } else {
      closingSignaling?.close()
    }
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
    takeoverHost: () => electionCtrl.takeoverHost(),
    sendHostHandoffBatch,
    sendHostHandoffAck,
    getHostSeqCounter: () => hostSeqCounter,
    getCurrentHostSessionId: () => currentHostSessionId,
    isStandbyHost: () => electionCtrl.isStandbyHostMode,
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
    isQuarantinedPeer: (peerId: string) => rawHandleChannelMessage.isQuarantinedPeer(peerId),
    requestAccountMerge,
    updateCallbacks: (newCallbacks: Partial<WebRtcCallbacks>) => {
      Object.assign(callbacks, newCallbacks)
    }
  }
}
