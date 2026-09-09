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
  callbacks: WebRtcCallbacks
}

export function createClientSession(ctx: ClientSessionContext) {
  let reconnectAttempts = 0
  let reconnectTimer: any = null
  let isRebuilding = false

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function resetReconnectAttempts() {
    reconnectAttempts = 0
  }

  function triggerClientReconnect() {
    if (ctx.isExplicitlyClosed() || ctx.getStatus() === 'long_offline') return

    clearReconnectTimer()

    if (reconnectAttempts >= 6) {
      console.log('[WebRTC] Max reconnect attempts reached. Moving to long_offline.')
      ctx.setStatus('long_offline')
      return
    }

    const delay = reconnectAttempts === 0 ? 1000 : Math.min(32000, Math.pow(2, reconnectAttempts) * 1000)
    reconnectAttempts++

    console.log(`[WebRTC] Attempting to reconnect in ${delay}ms (Attempt ${reconnectAttempts}/6)...`)
    ctx.setStatus('connecting')

    reconnectTimer = setTimeout(async () => {
      await setupClientConnection()
    }, delay)
  }

  async function setupClientConnection(forceRelay = false) {
    clearReconnectTimer()
    if (forceRelay) {
      ctx.setClientForceRelay(true)
    }
    ctx.setClientPendingCandidates([])

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
      if (isCongested) ctx.setStatus('unstable')
    })
    ctx.setClientSender(sender)

    dc.onmessage = (e) => ctx.handleChannelMessage(e)
    dc.onopen = () => {
      ctx.setStatus('connected')
      reconnectAttempts = 0
      clearReconnectTimer()
    }
    dc.onclose = () => {
      ctx.setClientSender(null)
      if (isRebuilding) return
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

      let handshakeTicket: string | undefined = undefined
      if (localEcdhPubHex && currentInviteCode) {
        try {
          const ticketRes = await createWebRtcTicket(currentInviteCode, localEcdhPubHex)
          if (ticketRes && ticketRes.ticket) {
            handshakeTicket = ticketRes.ticket
            console.log('[WebRTC Client Security] Acquired scoped handshake ticket with pkHash binding.')
          }
        } catch (ticketErr) {
          console.warn('[WebRTC Client Security] Failed to obtain handshake ticket:', ticketErr)
        }
      }

      const rawOffer = {
        type: offer.type,
        sdp: optimizeSdpCandidates(pc?.localDescription?.sdp || offer.sdp || ''),
        ticket: handshakeTicket,
        deviceId: localDeviceId
      }

      let offerPayload: any = rawOffer
      if (ctx.sas.clientSharedAesKey) {
        try {
          offerPayload = await encryptSignalingData(ctx.sas.clientSharedAesKey, JSON.stringify(rawOffer))
        } catch (err) {
          console.warn('[WebRTC Client] Failed to encrypt offer, sending plaintext fallback:', err)
        }
      }

      signaling?.send({
        offer: offerPayload,
        ecdhPublicKey: localEcdhPubHex,
        deviceId: localDeviceId,
        clientSessionId: `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        hostSessionId: ctx.getCurrentHostSessionId()
      })
    } catch (err) {
      console.error('Error creating offer:', err)
      triggerClientReconnect()
    }
  }

  async function evaluateAndApplyClientTrust(hostPubKey: string, hostDeviceId?: string) {
    const sas = ctx.sas
    sas.clientHostEcdhPubHex = hostPubKey
    sas.clientHostDeviceId = hostDeviceId || 'host_device_default'
    const localEcdhPubHex = ctx.getLocalEcdhPubHex()
    const currentInviteCode = ctx.getCurrentInviteCode()
    if (!localEcdhPubHex || !currentInviteCode) return

    sas.clientSecurityFingerprint = await computeSecurityFingerprint(localEcdhPubHex, hostPubKey, currentInviteCode)
    console.log(`[WebRTC Client Security] Computed SAS Fingerprint: ${sas.clientSecurityFingerprint}`)

    const isFlapping = Boolean(
      sas.clientHostEcdhPubHex && sas.clientHostEcdhPubHex !== hostPubKey && sas.clientSasState === 'VERIFIED'
    )

    const trustEval = await evaluatePeerKeyTrust({
      eventId: currentInviteCode || 'default_event',
      userId: 'host',
      username: 'Host',
      deviceId: sas.clientHostDeviceId,
      publicKeyHex: hostPubKey,
      isInSessionFlapping: isFlapping
    })

    if (trustEval.status === 'TRUSTED_MATCH') {
      console.log(`[WebRTC Client Security TOFU] Trusted Host match: ${sas.clientHostDeviceId}. Auto-approving SAS.`)
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
    } else if (trustEval.status === 'TOFU_FIRST_SEEN') {
      console.log(`[WebRTC Client Security TOFU] Establishing baseline trust for Host device ${sas.clientHostDeviceId}.`)
      await savePeerTrustRecord({
        eventId: currentInviteCode || 'default_event',
        userId: 'host',
        username: 'Host',
        deviceId: sas.clientHostDeviceId,
        publicKeyHex: hostPubKey,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        trustedAt: Date.now(),
        trustLevel: 'TOFU_TRUSTED'
      })
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
      if (trustEval.level === 'CRITICAL') {
        console.error(`[WebRTC Client Security ALERT] ${trustEval.message}`)
        ctx.rejectSas('host', trustEval.message)
      } else {
        console.warn(`[WebRTC Client Security NOTICE] ${trustEval.message}`)
        sas.clientSasState = 'PENDING_VERIFICATION'
        if (sas.sasTimeoutTimers.has('host')) {
          clearTimeout(sas.sasTimeoutTimers.get('host'))
        }
        sas.sasTimeoutTimers.set(
          'host',
          setTimeout(() => {
            if (sas.clientSasState === 'PENDING_VERIFICATION') {
              ctx.rejectSas('host', 'SAS verification timeout (60s)')
            }
          }, 60000)
        )

        ctx.callbacks.onSasVerificationRequired?.(
          {
            peerId: 'host',
            username: 'Host',
            ecdhPublicKey: hostPubKey
          },
          sas.clientSecurityFingerprint
        )
      }
    }
  }

  async function handleClientSignalingMessage(data: any) {
    const localEcdhKeyPair = ctx.getLocalEcdhKeyPair()
    const sas = ctx.sas
    const clientPc = ctx.getClientPc()

    if (data.type === 'host_hello') {
      console.log('[WebRTC] Received host_hello, checking session state.')
      const isSameHostSession = Boolean(data.hostSessionId && data.hostSessionId === ctx.getCurrentHostSessionId())
      if (data.hostSessionId) {
        ctx.setCurrentHostSessionId(data.hostSessionId)
      }
      if (data.ecdhPublicKey && localEcdhKeyPair) {
        try {
          const hostPub = await importEcdhPublicKey(data.ecdhPublicKey)
          sas.clientSharedAesKey = await deriveSharedAesKey(localEcdhKeyPair.privateKey, hostPub)
          await evaluateAndApplyClientTrust(data.ecdhPublicKey, data.deviceId)
        } catch (e) {
          console.warn('[WebRTC Client] Failed to derive shared AES key or evaluate trust from host_hello:', e)
        }
      }
      ctx.setClientHostSenderId(data.sender)

      const curPc = ctx.getClientPc()
      const curDc = ctx.getClientDc()
      const isActivelyConnectingOrOpen =
        curPc &&
        ['new', 'connecting', 'connected'].includes(curPc.connectionState) &&
        curDc &&
        curDc.readyState !== 'closed'

      const hostSessionChanged = Boolean(
        data.hostSessionId &&
        ctx.getCurrentHostSessionId() &&
        data.hostSessionId !== ctx.getCurrentHostSessionId()
      )

      if (!isActivelyConnectingOrOpen || hostSessionChanged) {
        clearReconnectTimer()
        reconnectAttempts = 0
        await setupClientConnection()
      } else {
        console.log('[WebRTC Client] Connection actively negotiating or open with host; preserving peer connection.')
      }
    } else if (data.type === 'HOST_LEAVING') {
      console.log('[WebRTC] Host explicitly left the room.')
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
    } else if (data.answer && clientPc) {
      try {
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
          await evaluateAndApplyClientTrust(data.ecdhPublicKey, data.deviceId)
        }

        let answerData = data.answer
        if (data.answer && data.answer.ciphertext && sas.clientSharedAesKey) {
          try {
            const decStr = await decryptSignalingData(sas.clientSharedAesKey, data.answer)
            answerData = JSON.parse(decStr)
          } catch (err) {
            console.warn('[WebRTC Client] Error decrypting answer SDP:', err)
          }
        }

        await clientPc.setRemoteDescription(toSessionDescription(answerData))
        const sortedPending = sortCandidatesPreferIpv6(ctx.getClientPendingCandidates())
        for (const c of sortedPending) {
          try {
            let candidateObj: any = c
            if (candidateObj && candidateObj.ciphertext && sas.clientSharedAesKey) {
              try {
                const decStr = await decryptSignalingData(sas.clientSharedAesKey, candidateObj)
                candidateObj = JSON.parse(decStr)
              } catch (err) {
                console.warn('[WebRTC Client] Error decrypting pending candidate:', err)
                continue
              }
            }
            if (candidateObj && candidateObj.candidate) {
              candidateObj.candidate = optimizeCandidatePriority(candidateObj.candidate)
            }
            await clientPc.addIceCandidate(toIceCandidate(candidateObj))
          } catch (candidateErr) {
            console.warn('[WebRTC Client] Failed to add pending candidate:', candidateErr)
          }
        }
        ctx.setClientPendingCandidates([])
      } catch (err) {
        console.error('Error setting remote description:', err)
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
          console.warn('[WebRTC Client] Error decrypting candidate:', err)
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
    }
  }

  return {
    setupClientConnection,
    handleClientSignalingMessage,
    triggerClientReconnect,
    clearReconnectTimer,
    resetReconnectAttempts
  }
}
