import type { WebRtcMessage } from '@/types'
import { createWebRtcTicket } from '@/services/api'
import { DataChannelSender } from '@/services/dataChannelSender'
import {
  importEcdhPublicKey,
  deriveSharedAesKey,
  encryptSignalingData,
  decryptSignalingData,
  computeSecurityFingerprint
} from '@/utils/crypto'
import { evaluatePeerKeyTrust, savePeerTrustRecord } from '@/utils/identityStore'

import type { WebRtcCallbacks } from './types'
import {
  optimizeCandidatePriority,
  optimizeSdpCandidates,
  sortCandidatesPreferIpv6
} from './connectivity'
import type { SignalingChannel } from './signaling'
import { toSessionDescription, toIceCandidate } from './sdpUtil'
import type { SasSecurityManager } from './sasManager'
import type { PeerConnectionManager } from './peerManager'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:Client')

export interface ClientSessionContext {
  peerMgr: PeerConnectionManager
  sas: SasSecurityManager
  getSignaling: () => SignalingChannel | null
  getLocalEcdhKeyPair: () => CryptoKeyPair | null
  getLocalEcdhPubHex: () => string
  getLocalDeviceId: () => string
  getCurrentInviteCode: () => string
  getCurrentHostSessionId: () => string
  setCurrentHostSessionId: (id: string) => void
  getClientSessionId: () => string
  setClientSessionId: (id: string) => void
  getClientHostSenderId: () => string | undefined
  setClientHostSenderId: (id: string) => void
  getClientPc: () => RTCPeerConnection | null
  setClientPc: (pc: RTCPeerConnection | null) => void
  getClientDc: () => RTCDataChannel | null
  setClientDc: (dc: RTCDataChannel | null) => void
  setClientSender: (sender: DataChannelSender | null) => void
  getClientPendingCandidates: () => any[]
  setClientPendingCandidates: (cands: any[]) => void
  getClientForceRelay: () => boolean
  setClientForceRelay: (force: boolean) => void
  isExplicitlyClosed: () => boolean
  getStatus: () => string
  setStatus: (s: any) => void
  sendMessage: (msg: WebRtcMessage, targetId?: string) => Promise<void>
  handleChannelMessage: (ev: MessageEvent, senderId?: string) => Promise<void>
  rejectSas: (peerId?: string, reason?: string) => void
  confirmSas?: (peerId?: string) => void
  getUsername?: () => string
  getUserId?: () => string
  isStandbyHost?: () => boolean
  callbacks: WebRtcCallbacks
}

export function createClientSession(ctx: ClientSessionContext) {
  let reconnectAttempts = 0
  let reconnectTimer: any = null
  let isRebuilding = false
  let lastOfferTimestamp = 0

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function resetReconnectAttempts() {
    reconnectAttempts = 0
  }

  function resetOfferTimestamp() {
    lastOfferTimestamp = 0
  }

  function triggerClientReconnect() {
    if (ctx.isExplicitlyClosed() || ctx.getStatus() === 'long_offline') return
    if (ctx.sas.clientSasState === 'PENDING_VERIFICATION') {
      log.info('SAS verification pending; pausing auto-reconnect.')
      return
    }
    if (ctx.sas.clientSasState === 'REJECTED') {
      log.warn('SAS verification rejected; suppressing auto-reconnect.')
      return
    }

    clearReconnectTimer()

    if (reconnectAttempts >= 6) {
      log.warn('Max reconnect attempts (6) reached. Moving to long_offline.')
      ctx.setStatus('long_offline')
      return
    }

    const delay = reconnectAttempts === 0 ? 1000 : Math.min(32000, Math.pow(2, reconnectAttempts) * 1000)
    reconnectAttempts++

    log.info(`Scheduling reconnect in ${delay}ms (Attempt ${reconnectAttempts}/6)...`)
    ctx.setStatus('connecting')

    reconnectTimer = setTimeout(async () => {
      await setupClientConnection()
    }, delay)
  }

  let activeSetupPromise: Promise<void> | null = null

  async function setupClientConnection(forceRelay = false): Promise<void> {
    while (activeSetupPromise) {
      try {
        await activeSetupPromise
      } catch (_) {}
    }
    const currentPromise = doSetupClientConnection(forceRelay)
    activeSetupPromise = currentPromise
    try {
      await currentPromise
    } finally {
      if (activeSetupPromise === currentPromise) {
        activeSetupPromise = null
      }
    }
  }

  async function doSetupClientConnection(forceRelay = false) {
    clearReconnectTimer()
    if (forceRelay) {
      ctx.setClientForceRelay(true)
    }
    ctx.setClientPendingCandidates([])
    const newClientSessionId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    ctx.setClientSessionId(newClientSessionId)
    log.info(`Initiating setupClientConnection (sessionId: ${newClientSessionId}, forceRelay: ${forceRelay}, hostSenderId: ${ctx.getClientHostSenderId() || 'none'})`)

    stopDataChannelHeartbeat()
    isRebuilding = true
    try {
      const oldDc = ctx.getClientDc()
      if (oldDc) {
        try { oldDc.close() } catch (_) {}
      }
      const oldPc = ctx.getClientPc()
      if (oldPc) {
        oldPc.onicecandidate = null
        oldPc.oniceconnectionstatechange = null
        oldPc.onconnectionstatechange = null
        oldPc.ondatachannel = null
        try { oldPc.close() } catch (_) {}
      }
    } finally {
      isRebuilding = false
    }

    const pc = ctx.peerMgr.createPeerConnection(
      undefined,
      triggerClientReconnect,
      ctx.getClientForceRelay(),
      ctx.getClientHostSenderId()
    )
    ctx.setClientPc(pc)

    const dc = pc.createDataChannel('scoutingpro-data')
    ctx.setClientDc(dc)

    const sender = new DataChannelSender(dc, (isCongested) => {
      if (isCongested) {
        log.warn('DataChannel congestion detected (backpressure high). Switching status to unstable.')
        ctx.setStatus('unstable')
      }
    })
    ctx.setClientSender(sender)

    dc.onmessage = (e) => ctx.handleChannelMessage(e)
    dc.onopen = () => {
      log.info(`DataChannel 'scoutingpro-data' OPENED! Client successfully connected to Host.`)
      ctx.setStatus('connected')
      reconnectAttempts = 0
      clearReconnectTimer()
      startDataChannelHeartbeat()
    }
    dc.onclose = () => {
      log.warn(`DataChannel 'scoutingpro-data' CLOSED. isRebuilding=${isRebuilding}, sasState=${ctx.sas.clientSasState}`)
      stopDataChannelHeartbeat()
      ctx.setClientSender(null)
      if (isRebuilding) return
      if (ctx.sas.clientSasState === 'PENDING_VERIFICATION' || ctx.sas.clientSasState === 'REJECTED') {
        return
      }
      if (!ctx.isExplicitlyClosed() && ctx.getStatus() !== 'long_offline') {
        triggerClientReconnect()
      }
    }

    const signaling = ctx.getSignaling()
    const localEcdhPubHex = ctx.getLocalEcdhPubHex()
    const currentInviteCode = ctx.getCurrentInviteCode()
    const localDeviceId = ctx.getLocalDeviceId()

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      log.info(`Client local offer created (SDP length: ${offer.sdp?.length || 0} bytes)`)

      let handshakeTicket: string | undefined = undefined
      if (localEcdhPubHex && currentInviteCode) {
        try {
          const ticketRes = await createWebRtcTicket(currentInviteCode, localEcdhPubHex)
          if (ticketRes && ticketRes.ticket) {
            handshakeTicket = ticketRes.ticket
            log.info('Acquired scoped handshake ticket with pkHash binding.')
          }
        } catch (ticketErr) {
          log.warn('Failed to obtain handshake ticket:', ticketErr)
        }
      }

      const rawOffer = {
        type: offer.type,
        sdp: optimizeSdpCandidates(pc?.localDescription?.sdp || offer.sdp || ''),
        ticket: handshakeTicket,
        deviceId: localDeviceId,
        username: ctx.getUsername?.(),
        userId: ctx.getUserId?.()
      }

      let offerPayload: any = rawOffer
      if (ctx.sas.clientSharedAesKey) {
        try {
          offerPayload = await encryptSignalingData(ctx.sas.clientSharedAesKey, JSON.stringify(rawOffer))
          log.info('Offer payload encrypted with shared AES key.')
        } catch (err) {
          log.warn('Failed to encrypt offer, sending plaintext fallback:', err)
        }
      }

      let clientSessionId = ctx.getClientSessionId()
      if (!clientSessionId) {
        clientSessionId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        ctx.setClientSessionId(clientSessionId)
      }

      lastOfferTimestamp = Date.now()
      log.info(`Dispatched Offer to Host via signaling (target: ${ctx.getClientHostSenderId() || 'broadcast'})`)
      signaling?.send({
        offer: offerPayload,
        ecdhPublicKey: localEcdhPubHex,
        deviceId: localDeviceId,
        clientSessionId,
        hostSessionId: ctx.getCurrentHostSessionId(),
        username: ctx.getUsername?.(),
        userId: ctx.getUserId?.()
      }, ctx.getClientHostSenderId())
    } catch (err) {
      log.error('Error creating offer:', err)
      triggerClientReconnect()
    }
  }

  async function evaluateAndApplyClientTrust(
    hostPubKey: string,
    hostDeviceId?: string,
    hostUsername?: string,
    hostUserId?: string
  ) {
    const sas = ctx.sas
    const previousHostPubHex = sas.clientHostEcdhPubHex
    if (sas.clientSasState === 'PENDING_VERIFICATION' && previousHostPubHex === hostPubKey) {
      return
    }

    const localEcdhPubHex = ctx.getLocalEcdhPubHex()
    const currentInviteCode = ctx.getCurrentInviteCode()
    if (!localEcdhPubHex || !currentInviteCode) return

    // 确定性 Host 设备 ID：若信令未显式提供，依据公钥指纹前缀唯一绑定，支持主备多机并存
    const effectiveHostDeviceId = hostDeviceId || `host_dev_${hostPubKey.slice(0, 16)}`
    sas.clientHostDeviceId = effectiveHostDeviceId
    sas.clientSecurityFingerprint = await computeSecurityFingerprint(localEcdhPubHex, hostPubKey, currentInviteCode)
    log.info(`Computed SAS Fingerprint for Host: ${sas.clientSecurityFingerprint} (Device: ${effectiveHostDeviceId})`)

    const effectiveHostUserId = hostUserId || (hostDeviceId ? `device:${hostDeviceId}` : `peer:${sas.clientHostDeviceId}`)
    const effectiveHostUsername = hostUsername || (hostUserId ? `User ${hostUserId.slice(0, 8)}` : 'Node')
    sas.clientHostUserId = effectiveHostUserId
    sas.clientHostUsername = effectiveHostUsername

    const isFlapping = Boolean(
      previousHostPubHex &&
      previousHostPubHex !== hostPubKey &&
      sas.clientSasState === 'VERIFIED'
    )

    sas.clientHostEcdhPubHex = hostPubKey

    // 检查本地 localStorage 显式核验记录（赛事 + 公钥）
    let isLocallyApproved = false
    try {
      const storedSas = localStorage.getItem(`scoutingpro_verified_sas_${currentInviteCode}_${hostPubKey}`)
      if (storedSas && storedSas === sas.clientSecurityFingerprint) {
        isLocallyApproved = true
      }
    } catch {}

    const trustEval = await evaluatePeerKeyTrust({
      eventId: currentInviteCode || 'default_event',
      userId: effectiveHostUserId,
      username: effectiveHostUsername,
      deviceId: sas.clientHostDeviceId,
      publicKeyHex: hostPubKey,
      isInSessionFlapping: isFlapping
    })

    if (trustEval.status === 'TRUSTED_MATCH' || trustEval.status === 'TOFU_FIRST_SEEN' || isLocallyApproved) {
      log.info(
        `Establishing baseline trust for Host device ${sas.clientHostDeviceId} (${effectiveHostUsername}). Auto-approving SAS. Status: ${trustEval.status} (localApproved: ${isLocallyApproved})`
      )
      if (trustEval.status === 'TOFU_FIRST_SEEN' || isLocallyApproved) {
        await savePeerTrustRecord({
          eventId: currentInviteCode || 'default_event',
          userId: effectiveHostUserId,
          username: effectiveHostUsername,
          deviceId: sas.clientHostDeviceId,
          publicKeyHex: hostPubKey,
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
          trustedAt: Date.now(),
          trustLevel: isLocallyApproved ? 'MANUAL_VERIFIED' : 'TOFU_TRUSTED'
        })
      }
      sas.clientSasState = 'VERIFIED'
      const pendingOut = [...sas.clientPendingOutgoing]
      sas.clientPendingOutgoing = []
      for (const item of pendingOut) {
        ctx.sendMessage(item.msg, item.targetId)
      }
      const pendingIn = [...sas.clientPendingIncoming]
      sas.clientPendingIncoming = []
      for (const item of pendingIn) {
        ctx.handleChannelMessage(item.ev, item.senderId)
      }
      ctx.callbacks.onSasVerified?.('host')
    } else if (trustEval.status === 'KEY_ROTATION_ALERT') {
      // 当已建立信任的设备公钥发生变动时，挂起通信并弹出安全核验，由用户核对安全码后决定同意还是拒绝
      log.warn(`Security Notice [${trustEval.level}]: ${trustEval.message}. Gating client verification.`)
      sas.clientSasState = 'PENDING_VERIFICATION'
      if (sas.sasTimeoutTimers.has('host')) {
        clearTimeout(sas.sasTimeoutTimers.get('host'))
        sas.sasTimeoutTimers.delete('host')
      }

      ctx.callbacks.onSasVerificationRequired?.(
        {
          peerId: 'host',
          username: effectiveHostUsername,
          ecdhPublicKey: hostPubKey
        },
        sas.clientSecurityFingerprint
      )
    }
  }

  async function handleClientSignalingMessage(data: any) {
    const localEcdhKeyPair = ctx.getLocalEcdhKeyPair()
    const sas = ctx.sas
    const clientPc = ctx.getClientPc()

    if (data.type === 'host_hello') {
      log.info(`Received host_hello: hostSessionId=${data.hostSessionId}, deviceId=${data.deviceId}, sender=${data.sender}`)
      const previousHostSessionId = ctx.getCurrentHostSessionId()
      const isSameHostSession = Boolean(data.hostSessionId && data.hostSessionId === previousHostSessionId)
      const hostSessionChanged = Boolean(
        data.hostSessionId &&
        previousHostSessionId &&
        data.hostSessionId !== previousHostSessionId
      )
      if (data.hostSessionId) {
        ctx.setCurrentHostSessionId(data.hostSessionId)
      }
      if (data.ecdhPublicKey && localEcdhKeyPair) {
        try {
          const hostPub = await importEcdhPublicKey(data.ecdhPublicKey)
          sas.clientSharedAesKey = await deriveSharedAesKey(localEcdhKeyPair.privateKey, hostPub)
          await evaluateAndApplyClientTrust(data.ecdhPublicKey, data.deviceId, data.username, data.userId)
        } catch (e) {
          log.warn('Failed to derive shared AES key or evaluate trust from host_hello:', e)
        }
      }
      ctx.setClientHostSenderId(data.sender)

      const curPc = ctx.getClientPc()
      const curDc = ctx.getClientDc()
      const isAlreadyConnected = Boolean(
        curPc &&
        curPc.connectionState === 'connected' &&
        curDc &&
        curDc.readyState === 'open'
      )
      const isOfferInFlight = Boolean(
        curPc &&
        curPc.signalingState === 'have-local-offer' &&
        Date.now() - lastOfferTimestamp < 3000
      )

      if (hostSessionChanged || (!isAlreadyConnected && !isOfferInFlight)) {
        log.info(`Setting up client connection on host_hello (isAlreadyConnected: ${isAlreadyConnected}, isOfferInFlight: ${isOfferInFlight}, hostSessionChanged: ${hostSessionChanged})`)
        clearReconnectTimer()
        reconnectAttempts = 0
        await setupClientConnection()
      } else {
        log.info(`Preserving existing peer connection on host_hello (alreadyConnected: ${isAlreadyConnected}, offerInFlight: ${isOfferInFlight})`)
      }
    } else if (data.type === 'host_takeover') {
      log.info(`Received host_takeover by new host session: ${data.newHostSessionId} (from ${data.sender})`)
      if (data.newHostSessionId) {
        ctx.setCurrentHostSessionId(data.newHostSessionId)
      }
      if (data.sender) {
        ctx.setClientHostSenderId(data.sender)
      }
      if (data.userId) {
        sas.clientHostUserId = data.userId
      }
      if (data.username) {
        sas.clientHostUsername = data.username
      }
      clearReconnectTimer()
      reconnectAttempts = 0
      await setupClientConnection()
    } else if (data.type === 'HOST_LEAVING') {
      log.warn(`Host explicitly left the room: hostSessionId=${data.hostSessionId}`)
      clearReconnectTimer()
      const curPc = ctx.getClientPc()
      const curDc = ctx.getClientDc()
      if (curDc) {
        curDc.onmessage = null
        curDc.onopen = null
        curDc.onclose = null
        curDc.onerror = null
        try { curDc.close() } catch (_) {}
      }
      if (curPc) {
        curPc.onicecandidate = null
        curPc.oniceconnectionstatechange = null
        curPc.onconnectionstatechange = null
        curPc.ondatachannel = null
        try { curPc.close() } catch (_) {}
      }
      ctx.setStatus('offline')
      ctx.callbacks.onActiveHostLeft?.()
    } else if (data.answer && clientPc) {
      try {
        log.info(`Processing Host Answer from ${data.sender || 'Active Host'}`)
        ctx.setClientHostSenderId(data.sender)
        if (data.hostSessionId) {
          ctx.setCurrentHostSessionId(data.hostSessionId)
        }

        if (data.ecdhPublicKey && !sas.clientSharedAesKey && localEcdhKeyPair) {
          try {
            const hostPub = await importEcdhPublicKey(data.ecdhPublicKey)
            sas.clientSharedAesKey = await deriveSharedAesKey(localEcdhKeyPair.privateKey, hostPub)
          } catch {}
        }
        if (data.ecdhPublicKey) {
          await evaluateAndApplyClientTrust(data.ecdhPublicKey, data.deviceId, data.username, data.userId)
        }

        let answerData = data.answer
        if (data.answer && data.answer.ciphertext && sas.clientSharedAesKey) {
          try {
            const decStr = await decryptSignalingData(sas.clientSharedAesKey, data.answer)
            answerData = JSON.parse(decStr)
            log.info('Decrypted encrypted Answer payload successfully.')
          } catch (err) {
            log.warn('Error decrypting answer SDP:', err)
          }
        }

        await clientPc.setRemoteDescription(toSessionDescription(answerData))
        log.info('Applied remote Host Answer to client PeerConnection.')
        const sortedPending = sortCandidatesPreferIpv6(ctx.getClientPendingCandidates())
        for (const c of sortedPending) {
          try {
            let candidateObj: any = c
            if (candidateObj && candidateObj.ciphertext && sas.clientSharedAesKey) {
              try {
                const decStr = await decryptSignalingData(sas.clientSharedAesKey, candidateObj)
                candidateObj = JSON.parse(decStr)
              } catch (err) {
                log.warn('Error decrypting pending candidate:', err)
                continue
              }
            }
            if (candidateObj && candidateObj.candidate) {
              candidateObj.candidate = optimizeCandidatePriority(candidateObj.candidate)
            }
            await clientPc.addIceCandidate(toIceCandidate(candidateObj))
          } catch (candidateErr) {
            log.warn('Failed to add pending candidate:', candidateErr)
          }
        }
        ctx.setClientPendingCandidates([])
      } catch (err) {
        log.error('Error setting remote description for Host Answer:', err)
      }
    } else if (data.candidate && clientPc) {
      const clientHostSenderId = ctx.getClientHostSenderId()
      if (clientHostSenderId && data.sender !== clientHostSenderId) {
        return
      }

      let candidateData = data.candidate
      if (data.candidate && data.candidate.ciphertext && sas.clientSharedAesKey) {
        try {
          const decStr = await decryptSignalingData(sas.clientSharedAesKey, data.candidate)
          candidateData = JSON.parse(decStr)
        } catch (err) {
          log.warn('Error decrypting candidate:', err)
        }
      }

      if (candidateData && candidateData.candidate) {
        candidateData.candidate = optimizeCandidatePriority(candidateData.candidate)
      }

      try {
        await clientPc.addIceCandidate(toIceCandidate(candidateData))
      } catch {
        const pending = ctx.getClientPendingCandidates()
        pending.push(candidateData)
        ctx.setClientPendingCandidates(pending)
      }
    } else if (data.type === 'sas_challenge') {
      log.warn(`Host issued SAS security challenge. Fingerprint: ${data.fingerprint}`)
      if (sas.clientSasState === 'VERIFIED') {
        log.info('Host issued SAS challenge but client is already verified; ignoring.')
        return
      }
      sas.clientSasState = 'PENDING_VERIFICATION'
      sas.clientSecurityFingerprint = data.fingerprint
      clearReconnectTimer()

      ctx.callbacks.onSasVerificationRequired?.(
        {
          peerId: 'host',
          username: data.username || sas.clientHostUsername || 'Node',
          ecdhPublicKey: sas.clientHostEcdhPubHex || ''
        },
        data.fingerprint
      )
    } else if (data.type === 'sas_verified') {
      log.info('Host verified SAS code. Client trust active.')
      if (sas.clientSasState === 'PENDING_VERIFICATION') {
        if (ctx.confirmSas) {
          ctx.confirmSas('host')
        } else {
          sas.confirmSas('host', false, ctx.getCurrentInviteCode(), ctx.callbacks, ctx.sendMessage, ctx.handleChannelMessage)
        }
      }
    } else if (data.type === 'sas_rejected') {
      log.warn(`Host rejected SAS verification. Reason: ${data.reason}`)
    }
  }

  const pendingPings = new Map<number, (ok: boolean) => void>()

  function handlePong(timestamp: number) {
    if (pendingPings.has(timestamp)) {
      const resolve = pendingPings.get(timestamp)
      pendingPings.delete(timestamp)
      resolve?.(true)
    }
  }

  async function pingHost(timeoutMs = 800): Promise<boolean> {
    const dc = ctx.getClientDc()
    const pc = ctx.getClientPc()
    if (!dc || dc.readyState !== 'open' || !pc || pc.connectionState !== 'connected') {
      return false
    }
    const ts = Date.now()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPings.delete(ts)
        resolve(false)
      }, timeoutMs)

      pendingPings.set(ts, (ok) => {
        clearTimeout(timer)
        resolve(ok)
      })

      try {
        ctx.sendMessage({ type: 'PING' as any, timestamp: ts })
      } catch {
        clearTimeout(timer)
        pendingPings.delete(ts)
        resolve(false)
      }
    })
  }

  let dataChannelHeartbeatTimer: any = null
  let consecutiveFailedPings = 0

  function startDataChannelHeartbeat() {
    stopDataChannelHeartbeat()
    consecutiveFailedPings = 0
    const intervalMs = (globalThis as any).__TEST_HEARTBEAT_INTERVAL_MS__ ?? 2000
    const pingTimeoutMs = (globalThis as any).__TEST_PING_TIMEOUT_MS__ ?? 1000

    dataChannelHeartbeatTimer = setInterval(async () => {
      const dc = ctx.getClientDc()
      const pc = ctx.getClientPc()
      if (!dc || dc.readyState !== 'open' || !pc || pc.connectionState !== 'connected') {
        return
      }
      const isAlive = await pingHost(pingTimeoutMs)
      if (!isAlive) {
        consecutiveFailedPings++
        log.warn(`DataChannel heartbeat ping timeout (${consecutiveFailedPings}/2 missed)`)
        if (consecutiveFailedPings >= 2) {
          log.warn('Active host unresponsiveness confirmed via DataChannel heartbeat. Autonomous degradation triggered.')
          stopDataChannelHeartbeat()
          ctx.peerMgr.resetTransportInfo()
          ctx.setStatus('degraded')
          ctx.callbacks.onHostDisconnected?.()
          ctx.callbacks.onActiveHostLeft?.()
        }
      } else {
        if (consecutiveFailedPings > 0 && ctx.getStatus() === 'degraded') {
          log.info('DataChannel heartbeat restored, updating status to connected.')
          ctx.setStatus('connected')
        }
        consecutiveFailedPings = 0
      }
    }, intervalMs)
  }

  function stopDataChannelHeartbeat() {
    if (dataChannelHeartbeatTimer) {
      clearInterval(dataChannelHeartbeatTimer)
      dataChannelHeartbeatTimer = null
    }
    consecutiveFailedPings = 0
  }

  return {
    setupClientConnection,
    handleClientSignalingMessage,
    triggerClientReconnect,
    clearReconnectTimer,
    resetReconnectAttempts,
    pingHost,
    handlePong,
    startDataChannelHeartbeat,
    stopDataChannelHeartbeat,
    resetOfferTimestamp
  }
}

