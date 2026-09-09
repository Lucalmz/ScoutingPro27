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

export * from './types'
export * from './connectivity'
export * from './signaling'
export * from './offlineQueue'
export * from './sdpUtil'
export * from './messageDispatcher'
export * from './selfHealing'

export function createWebRtcService(callbacks: WebRtcCallbacks): WebRtcService {
  let isHostMode = false
  let isExplicitlyClosed = false
  let signaling: SignalingChannel | null = null
  let status: ConnectionStatus = 'offline'
  let currentInviteCode = ''
  let hostSessionId = ''
  let currentHostSessionId = ''
  let currentEventMetadata: ScoutingEvent | null = null

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
  const scoutIdToClientId = new Map<string, string>()
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
      clientSession.setupClientConnection(true)
    },
    getLocalEcdhPubHex: () => localEcdhPubHex,
    getCurrentHostSessionId: () => currentHostSessionId,
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
    scoutIdToClientId,
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
    stampHostSeq
  } = dispatcher

  const rawHandleChannelMessage = createChannelMessageHandler({
    isHostMode: () => isHostMode,
    currentInviteCode: () => currentInviteCode,
    getHostSessionId: () => hostSessionId,
    getCurrentHostSessionId: () => currentHostSessionId,
    setCurrentHostSessionId: (id: string) => {
      currentHostSessionId = id
    },
    callbacks,
    clients,
    stagedClients,
    scoutIdToClientId,
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
    setStatus
  })

  async function handleChannelMessage(ev: MessageEvent, senderId?: string): Promise<void> {
    const peerSas = isHostMode
      ? senderId
        ? sas.clientSasStates.get(senderId) || 'VERIFIED'
        : 'VERIFIED'
      : sas.clientSasState

    if (peerSas === 'PENDING_VERIFICATION') {
      console.log(`[WebRTC Security Gating] Buffering incoming message from ${senderId || 'host'} (SAS pending verification).`)
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
      console.warn(`[WebRTC Security Gating] Discarding message from rejected peer ${senderId || 'host'}.`)
      return
    }

    return rawHandleChannelMessage(ev, senderId)
  }

  function confirmSas(peerId = 'host'): void {
    sas.confirmSas(peerId, isHostMode, currentInviteCode, callbacks, sendMessage, handleChannelMessage)
  }

  function rejectSas(peerId = 'host', reason = 'Security code verification rejected'): void {
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
    callbacks
  })

  // =====================================================
  // Host: create room & wait for client offer
  // =====================================================
  async function host(inviteCode: string, eventMetadata?: ScoutingEvent): Promise<void> {
    isHostMode = true
    isExplicitlyClosed = false
    currentInviteCode = inviteCode
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
      console.log(`[WebRTC Host] Using persistent device identity: ${localDeviceId}`)
    } catch (e) {
      console.warn('[WebRTC Host] Ephemeral ECDH generation fallback:', e)
      try {
        localEcdhKeyPair = await generateEcdhKeyPair()
        localEcdhPubHex = localEcdhKeyPair ? await exportEcdhPublicKey(localEcdhKeyPair.publicKey) : ''
      } catch (err) {
        console.warn('[WebRTC Host] ECDH unavailable in insecure context:', err)
        localEcdhKeyPair = null
        localEcdhPubHex = ''
      }
    }

    signaling = new SignalingChannel(inviteCode)
    await signaling.initTopic()

    signaling.connect({
      onConnect: () => {
        updateHostStatus()
        signaling!.send({ type: 'host_hello', hostSessionId, ecdhPublicKey: localEcdhPubHex, deviceId: localDeviceId })
      },
      onError: () => {
        updateHostStatus()
      },
      onMessage: hostSignalingHandler
    })
  }

  // =====================================================
  // Client: join a room via invite code
  // =====================================================
  async function join(inviteCode: string): Promise<void> {
    isHostMode = false
    isExplicitlyClosed = false
    currentInviteCode = inviteCode
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
    setStatus('connecting')

    if (!signaling) {
      signaling = new SignalingChannel(currentInviteCode)
      await signaling.initTopic()
      signaling.connect({
        onConnect: async () => {
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
      await clientSession.setupClientConnection()
    }
    return true
  }

  const selfHealing = setupSelfHealing({
    getStatus: () => status,
    reconnectNow
  })

  function setEventMetadata(meta: ScoutingEvent) {
    currentEventMetadata = meta
  }

  function disconnect() {
    isExplicitlyClosed = true
    selfHealing.dispose()
    clientSession.clearReconnectTimer()

    if (isHostMode) {
      if (signaling) {
        signaling.send({ type: 'HOST_LEAVING' })
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
      scoutIdToClientId.clear()
      clientIdToScoutId.clear()
      clientIdToScoutName.clear()
      pendingTakeovers.forEach((p) => clearTimeout(p.timeoutTimer))
      pendingTakeovers.clear()
      takeoverCooldowns.clear()
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
    reconnectNow,
    disconnect,
    initHostSeq,
    stampHostSeq,
    confirmSas,
    rejectSas,
    getSasState: (peerId?: string) => isHostMode ? (peerId ? sas.clientSasStates.get(peerId) || 'PENDING_VERIFICATION' : 'PENDING_VERIFICATION') : sas.clientSasState,
    getSasFingerprint: (peerId?: string) => isHostMode ? (peerId ? sas.clientFingerprints.get(peerId) : undefined) : sas.clientSecurityFingerprint,
    getStatus: () => status,
    getTransportInfo: () => peerMgr.currentTransportInfo,
    getDataChannel: () => (isHostMode ? clients.values().next().value?.dc || null : clientDc),
    updateCallbacks: (newCallbacks: Partial<WebRtcCallbacks>) => {
      Object.assign(callbacks, newCallbacks)
    }
  }
}
