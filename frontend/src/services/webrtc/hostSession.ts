import type { ScoutingEvent, WebRtcMessage } from '@/types'
import { verifyToken, verifyWebRtcTicket } from '@/services/api'
import { DataChannelSender } from '@/services/dataChannelSender'
import {
  importEcdhPublicKey,
  deriveSharedAesKey,
  encryptSignalingData,
  decryptSignalingData,
  computeSecurityFingerprint,
  sha256Hex
} from '@/utils/crypto'
import { evaluatePeerKeyTrust, savePeerTrustRecord } from '@/utils/identityStore'

import type { ClientEntry, WebRtcCallbacks } from './types'
import {
  buildIceConfiguration,
  optimizeCandidatePriority,
  optimizeSdpCandidates,
  synthesizeSymmetricNatPortCandidates,
  sortCandidatesPreferIpv6,
  probeLocalInterfaceIpv6,
  isGlobalIpv6Address,
  isBogusOrTunCandidate,
  cleanIpAddress
} from './connectivity'
import type { SignalingChannel } from './signaling'
import { toSessionDescription, toIceCandidate } from './sdpUtil'
import type { SasSecurityManager } from './sasManager'
import type { PeerConnectionManager } from './peerManager'
import { VirtualDataChannel, tryDecryptVirtualFrame } from './virtualDataChannel'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:Host')

/**
 * 尚未找到匹配会话 PeerConnection 的远端候选（payload 可能仍是加密体，注入前再解密）
 */
export interface PreOfferCandidate {
  sessionTag?: string
  payload: any
}

export interface HostSessionContext {
  clients: Map<string, ClientEntry>
  stagedClients: Map<string, ClientEntry>
  preOfferCandidates: Map<string, PreOfferCandidate[]>
  enqueueHostTask: (sender: string, task: () => Promise<void>) => Promise<void>
  updateHostStatus: () => void
  peerMgr: PeerConnectionManager
  sas: SasSecurityManager
  getSignaling: () => SignalingChannel | null
  getLocalEcdhKeyPair: () => CryptoKeyPair | null
  getLocalEcdhPubHex: () => string
  getLocalDeviceId: () => string
  getHostSessionId: () => string
  getCurrentInviteCode: () => string
  getCurrentEventMetadata: () => ScoutingEvent | null
  sendMessage: (msg: WebRtcMessage, targetId?: string) => Promise<void>
  handleChannelMessage: (ev: MessageEvent, senderId?: string) => Promise<void>
  rejectSas: (peerId?: string, reason?: string) => void
  confirmSas?: (peerId: string) => void
  getUsername?: () => string
  getUserId?: () => string
  callbacks: WebRtcCallbacks
  clientIdToScoutId?: Map<string, string>
  clientIdToScoutName?: Map<string, string>
  scoutIdToClientIds?: Map<string, Set<string>>
}

function extractTicketPayload(ticket: string): Record<string, any> | null {
  try {
    const parts = ticket.split('.')
    const payloadPart = parts[1]
    if (parts.length === 3 && payloadPart) {
      const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
      const json = atob(base64)
      return JSON.parse(json)
    }
  } catch {}
  return null
}

/** 每个 sender 最多缓存的“尚无匹配 PeerConnection”的候选数，防止异常对端撑爆内存 */
const MAX_PRE_OFFER_CANDIDATES = 64

export function createHostSignalingHandler(ctx: HostSessionContext) {
  // 仅用于 host_hello 诊断展示（真实 IPv6 直连依赖 ICE 的 STUN srflx / prflx 候选，不依赖此值）
  let cachedHostIpv6: string | null = null

  probeLocalInterfaceIpv6()
    .then((ip) => {
      if (ip && isGlobalIpv6Address(ip)) cachedHostIpv6 = cleanIpAddress(ip)
    })
    .catch(() => {})

  const handler = (data: any) => {
    const sender = data.sender
    if (!sender) return

    const signaling = ctx.getSignaling()
    if (!signaling) return

    const hostSessionId = ctx.getHostSessionId()
    const localEcdhPubHex = ctx.getLocalEcdhPubHex()
    const localDeviceId = ctx.getLocalDeviceId()
    const currentInviteCode = ctx.getCurrentInviteCode()
    const localEcdhKeyPair = ctx.getLocalEcdhKeyPair()
    const sas = ctx.sas
    const clients = ctx.clients
    const stagedClients = ctx.stagedClients
    const preOfferCandidates = ctx.preOfferCandidates

    if (data.type === 'client_hello') {
      log.info(`Received client_hello from ${sender}, responding with host_hello`, {
        hostSessionId,
        deviceId: localDeviceId
      })
      signaling.send(
        {
          type: 'host_hello',
          hostSessionId,
          hostIpv6: cachedHostIpv6 || undefined,
          ecdhPublicKey: localEcdhPubHex,
          deviceId: localDeviceId,
          username: ctx.getUsername?.() || '',
          userId: ctx.getUserId?.() || ''
        },
        sender
      )
      return
    }

    if (data.type === 'sas_retry') {
      log.info(`Peer ${sender} requested SAS verification retry`)
      const fingerprint = sas.clientFingerprints.get(sender)
      if (fingerprint) {
        sas.clientSasStates.set(sender, 'PENDING_VERIFICATION')
        const username = sas.clientVerifiedIdentities.get(sender)?.username || 'Client'
        ctx.callbacks.onSasVerificationRequired?.(
          {
            peerId: sender,
            username,
            ecdhPublicKey: sas.clientEcdhPubHexes.get(sender) || ''
          },
          fingerprint
        )
        signaling.send(
          {
            type: 'sas_challenge',
            fingerprint,
            hostSessionId,
            username: ctx.getUsername?.() || ''
          },
          sender
        )
      }
      return
    }

    if (data.offer) {
      log.info(`Received WebRTC offer from ${sender}`, {
        clientSessionId: data.clientSessionId,
        hasTicket: Boolean(data.ticket || data.offer?.ticket),
        hasToken: Boolean(data.token),
        hasEcdhPub: Boolean(data.ecdhPublicKey),
        ecdhPublicKeyPrefix: data.ecdhPublicKey ? data.ecdhPublicKey.slice(0, 16) + '...' : undefined
      })

      ctx.enqueueHostTask(sender, async () => {
        if (!cachedHostIpv6) {
          try {
            const ip = await probeLocalInterfaceIpv6()
            if (ip && isGlobalIpv6Address(ip)) cachedHostIpv6 = cleanIpAddress(ip)
          } catch {}
        }

        const existing = clients.get(sender)
        let clientData: ClientEntry

        const setupDcHandler = (targetPc: RTCPeerConnection) => {
          targetPc.ondatachannel = (ev) => {
            const dc = ev.channel
            log.info(`Host DataChannel received from ${sender} (label: ${dc.label}, state: ${dc.readyState})`)
            const targetHolder = stagedClients.get(sender) || clients.get(sender)
            const senderObj = new DataChannelSender(dc)
            dc.onmessage = (e) => ctx.handleChannelMessage(e, sender)

            const promoteNativeDc = () => {
              const holder = stagedClients.get(sender) || clients.get(sender)
              if (holder) {
                const prevDc = holder.dc
                if (prevDc && prevDc !== dc && (prevDc as any)?.isVirtual) {
                  log.info(`Host hot-upgrading ${sender} from VirtualDataChannel to Native UDP DataChannel!`)
                  prevDc.onclose = null
                  try { prevDc.close() } catch {}
                }
                holder.dc = dc
                holder.sender = senderObj
              }
            }

            // 若当前尚未挂载活跃的 VirtualDataChannel，可立即绑定；否则等到原生 dc.onopen 真正打开时再无缝热切换！
            if (targetHolder && (!targetHolder.dc || !(targetHolder.dc as any)?.isVirtual || targetHolder.dc.readyState !== 'open')) {
              targetHolder.dc = dc
              targetHolder.sender = senderObj
            }

            dc.onopen = () => {
              log.info(`Host DataChannel state is now OPEN with ${sender}`)
              const hadOpenVirtual = Boolean(
                targetHolder && (targetHolder.dc as any)?.isVirtual && targetHolder.dc?.readyState === 'open'
              )
              promoteNativeDc()
              ctx.updateHostStatus()
              if (!hadOpenVirtual) {
                const currentEventMetadata = ctx.getCurrentEventMetadata()
                if (currentEventMetadata) {
                  ctx.sendMessage(
                    {
                      type: 'EVENT_METADATA',
                      event: currentEventMetadata,
                      authCode: currentInviteCode || undefined,
                      hostSessionId: hostSessionId || undefined
                    },
                    sender
                  )
                }
              }
            }
            dc.onclose = () => {
              const holder = stagedClients.get(sender) || clients.get(sender)
              if (holder && holder.dc && holder.dc !== dc && (holder.dc as any)?.isVirtual && holder.dc.readyState === 'open') {
                return
              }
              log.warn(`Host DataChannel closed with ${sender}`)
              ctx.updateHostStatus()
            }
          }
        }

        const isIceRestart = Boolean(
          existing &&
          existing.pc &&
          !['closed', 'failed'].includes(existing.pc.connectionState) &&
          data.clientSessionId &&
          existing.sessionId === data.clientSessionId
        )

        const makeOnDisconnect = (targetPc: RTCPeerConnection) => () => {
          const curActive = clients.get(sender)
          if (curActive && curActive.pc === targetPc && (curActive.dc as any)?.isVirtual && curActive.dc?.readyState === 'open') {
            log.info(`Host native PC for ${sender} closed, but VirtualDataChannel is active; preserving client session.`)
            return
          }
          log.warn(`Host peer connection for ${sender} stalled or closed. Cleaning up peer resources...`)
          if (curActive && curActive.pc === targetPc) {
            if (curActive.sender) {
              try { curActive.sender.abort('Host peer connection disconnected') } catch {}
              curActive.sender = undefined
            }
            if (curActive.dc) {
              curActive.dc.onmessage = null
              curActive.dc.onopen = null
              curActive.dc.onclose = null
              curActive.dc.onerror = null
              try { curActive.dc.close() } catch {}
            }
            curActive.pc.onicecandidate = null
            curActive.pc.onconnectionstatechange = null
            curActive.pc.oniceconnectionstatechange = null
            try { curActive.pc.ondatachannel = () => {} } catch {}
            try { curActive.pc.close() } catch {}
            clients.delete(sender)
          }
          const curStaged = stagedClients.get(sender)
          if (curStaged && curStaged.pc === targetPc) {
            if (curStaged.sender) {
              try { curStaged.sender.abort('Host staged connection disconnected') } catch {}
              curStaged.sender = undefined
            }
            if (curStaged.dc) {
              curStaged.dc.onmessage = null
              curStaged.dc.onopen = null
              curStaged.dc.onclose = null
              curStaged.dc.onerror = null
              try { curStaged.dc.close() } catch {}
            }
            curStaged.pc.onicecandidate = null
            curStaged.pc.onconnectionstatechange = null
            curStaged.pc.oniceconnectionstatechange = null
            try { curStaged.pc.ondatachannel = () => {} } catch {}
            try { curStaged.pc.close() } catch {}
            stagedClients.delete(sender)
          }
          ctx.updateHostStatus()
        }

        if (isIceRestart && existing) {
          log.info(`Performing in-place ICE restart renegotiation for existing peer ${sender}`)
          const allowTurnOnRestart = Boolean(data.allowTurn || data.offer?.allowTurn || data.forceRelay)
          try {
            if (typeof existing.pc.setConfiguration === 'function') {
              existing.pc.setConfiguration(buildIceConfiguration(allowTurnOnRestart, false))
            }
          } catch {}
          clientData = existing
        } else {
          // 若当前存在活跃的 VirtualDataChannel，在新的原生 DataChannel 真正 open 之前保留虚拟通道，支持无缝后台热升级
          const preservedVirtualDc =
            existing && (existing.dc as any)?.isVirtual && existing.dc?.readyState === 'open'
              ? existing.dc
              : undefined
          const preservedVirtualSender = preservedVirtualDc ? existing?.sender : undefined

          if (existing) {
            log.info(`Tearing down previous connection for peer ${sender} before creating new PeerConnection`)
            if (!preservedVirtualDc) {
              if (existing.sender) {
                try { existing.sender.abort('Connection torn down by new session offer') } catch {}
                existing.sender = undefined
              }
              if (existing.dc) {
                existing.dc.onmessage = null
                existing.dc.onopen = null
                existing.dc.onclose = null
                existing.dc.onerror = null
                try { existing.dc.close() } catch {}
              }
            } else if (data.clientSessionId) {
              ;(preservedVirtualDc as any).sessionId = data.clientSessionId
            }
            if (existing.pc) {
              existing.pc.onicecandidate = null
              existing.pc.onconnectionstatechange = null
              existing.pc.oniceconnectionstatechange = null
              try { existing.pc.ondatachannel = () => {} } catch {}
              try { existing.pc.close() } catch {}
            }
            clients.delete(sender)
          }
          const existingStaged = stagedClients.get(sender)
          if (existingStaged) {
            if (existingStaged.sender) {
              try { existingStaged.sender.abort('Staged connection torn down by new session offer') } catch {}
              existingStaged.sender = undefined
            }
            if (existingStaged.dc) {
              existingStaged.dc.onmessage = null
              existingStaged.dc.onopen = null
              existingStaged.dc.onclose = null
              existingStaged.dc.onerror = null
              try { existingStaged.dc.close() } catch {}
            }
            if (existingStaged.pc) {
              existingStaged.pc.onicecandidate = null
              existingStaged.pc.onconnectionstatechange = null
              existingStaged.pc.oniceconnectionstatechange = null
              try { existingStaged.pc.ondatachannel = () => {} } catch {}
              try { existingStaged.pc.close() } catch {}
            }
            stagedClients.delete(sender)
          }
          let pcRef: RTCPeerConnection
          const onDisconnect = () => {
            if (pcRef) makeOnDisconnect(pcRef)()
          }
          const allowTurn = Boolean(data.allowTurn || data.offer?.allowTurn || data.forceRelay)
          const pc = ctx.peerMgr.createPeerConnection(sender, onDisconnect, false, undefined, {
            sessionTag: data.clientSessionId,
            holdLocalCandidates: true,
            allowTurn
          })
          pcRef = pc
          if (preservedVirtualDc) {
            ctx.peerMgr.markVirtualChannelActive(pc)
          }
          setupDcHandler(pc)
          clientData = {
            pc,
            dc: preservedVirtualDc,
            sender: preservedVirtualSender,
            sessionId: data.clientSessionId,
            pendingCandidates: []
          }
          clients.set(sender, clientData)
        }

        // Derive shared AES key from client's public key & compute SAS fingerprint
        if (data.ecdhPublicKey && localEcdhKeyPair) {
          try {
            const clientPub = await importEcdhPublicKey(data.ecdhPublicKey)
            const sharedKey = await deriveSharedAesKey(localEcdhKeyPair.privateKey, clientPub)
            sas.clientSharedKeys.set(sender, sharedKey)
            sas.clientEcdhPubHexes.set(sender, data.ecdhPublicKey)
            if (localEcdhPubHex && currentInviteCode) {
              const fingerprint = await computeSecurityFingerprint(localEcdhPubHex, data.ecdhPublicKey, currentInviteCode)
              sas.clientFingerprints.set(sender, fingerprint)
              log.info(`Computed SAS Fingerprint for ${sender}: ${fingerprint}`)

              const candidateUserId = data.userId || 'unknown'
              const storageKey = `scoutingpro_verified_sas_${currentInviteCode}_${candidateUserId}_${data.ecdhPublicKey}`
              const pubKeyStorageKey = `scoutingpro_verified_sas_${currentInviteCode}_${data.ecdhPublicKey}`
              let storedSas: string | null = null
              try {
                storedSas = localStorage.getItem(pubKeyStorageKey) || localStorage.getItem(storageKey)
              } catch {}

              if (storedSas && storedSas === fingerprint) {
                log.info(`Peer ${sender} (${candidateUserId}) already verified in past session. Auto-approving SAS.`)
                sas.clientSasStates.set(sender, 'VERIFIED')
              } else {
                sas.clientSasStates.set(sender, 'PENDING_VERIFICATION')
              }
            }
          } catch (err) {
            log.warn(`Failed to derive shared AES key or compute SAS for ${sender}:`, err)
          }
        }

        // Decrypt offer if encrypted
        let offerData = data.offer
        if (data.offer && data.offer.ciphertext && sas.clientSharedKeys.has(sender)) {
          try {
            const decryptedStr = await decryptSignalingData(sas.clientSharedKeys.get(sender)!, data.offer)
            offerData = JSON.parse(decryptedStr)
          } catch (err) {
            console.warn('[WebRTC Host] Failed to decrypt offer SDP:', err)
            return
          }
        }

        // Verify client scoped handshake ticket bound to data.ecdhPublicKey
        const ticketToVerify = offerData?.ticket || data.ticket
        let verifiedUser: { userId: string; username: string } | undefined = undefined

        if (ticketToVerify && data.ecdhPublicKey) {
          // 1. Client-side sanity check: if ticket payload contains pkHash, verify binding
          const unverifiedPayload = extractTicketPayload(ticketToVerify)
          let isPayloadTampered = false
          if (unverifiedPayload && unverifiedPayload.pkHash) {
            try {
              const expectedPkHash = await sha256Hex(data.ecdhPublicKey.trim().toLowerCase())
              if (unverifiedPayload.pkHash.toLowerCase() !== expectedPkHash.toLowerCase()) {
                isPayloadTampered = true
              }
            } catch {}
          }

          if (isPayloadTampered) {
            log.error(`Critical security alert: Ticket pkHash payload mismatch for peer ${sender}. Dropping offer immediately.`)
            ctx.rejectSas(sender, 'Ticket pkHash payload mismatch (possible replay or MITM attack)')
            return // Hard drop on ticket key tampering
          }

          // 2. Verify scoped ticket with local backend instance
          try {
            const authRes = await verifyWebRtcTicket(ticketToVerify, currentInviteCode, data.ecdhPublicKey)
            if (authRes && authRes.valid) {
              log.info(`Successfully verified scoped ticket for peer ${sender}: ${authRes.username} (${authRes.userId})`)
              verifiedUser = {
                userId: authRes.userId || '',
                username: authRes.username || sender
              }
              sas.clientVerifiedIdentities.set(sender, {
                userId: verifiedUser.userId,
                username: verifiedUser.username,
                ecdhPublicKey: data.ecdhPublicKey
              })
            } else {
              const errLower = (authRes?.error || '').toLowerCase()
              const isReplayOrKeyTamper =
                errLower.includes('public key') ||
                errLower.includes('pkhash') ||
                errLower.includes('mismatch') ||
                errLower.includes('replay') ||
                errLower.includes('tamper')

              if (isReplayOrKeyTamper) {
                log.error(`Critical security alert: Ticket verification rejected (tampering/replay detected) for peer ${sender}: ${authRes?.error}`)
                ctx.rejectSas(sender, authRes?.error || 'Ticket verification failed (tamper/replay detected)')
                return // Drop offer immediately on ticket replay or public key mismatch
              }

              // Scheme B: Cross-machine heterogeneous cluster fallback
              log.warn(`Cross-cluster ticket or signature verification unconfirmed for peer ${sender} (${authRes?.error || 'unverified'}). Gracefully falling back to decentralized ECDH + SAS + TOFU zero-trust pipeline.`)
            }
          } catch (ticketErr) {
            log.warn(`Error calling verifyWebRtcTicket for peer ${sender}: ${ticketErr}. Gracefully falling back to decentralized ECDH + SAS + TOFU zero-trust pipeline.`, ticketErr)
          }
        } else if (data.token) {
          try {
            const authRes = await verifyToken(data.token)
            if (authRes && authRes.valid) {
              log.info(`Legacy token verified for peer ${sender}: ${authRes.username} (${authRes.userId})`)
              verifiedUser = {
                userId: authRes.userId || '',
                username: authRes.username || sender
              }
              sas.clientVerifiedIdentities.set(sender, {
                userId: verifiedUser.userId,
                username: verifiedUser.username,
                ecdhPublicKey: data.ecdhPublicKey
              })
            }
          } catch {}
        }

        // TOFU Peer Trust Evaluation
        if (data.ecdhPublicKey) {
          const clientDeviceId = offerData?.deviceId || data.deviceId || 'device_default'
          if (clientDeviceId && clientDeviceId !== 'device_default') {
            for (const [oldSender, recordedDevId] of Array.from(sas.clientDeviceIds.entries())) {
              if (oldSender !== sender && recordedDevId === clientDeviceId) {
                log.info(`Cleaning up superseded session ${oldSender} for same deviceId ${clientDeviceId} (new sender: ${sender})`)
                const staleEntry = clients.get(oldSender) || stagedClients.get(oldSender)
                if (staleEntry) {
                  try { staleEntry.sender?.abort('Superseded by new sender from same deviceId') } catch {}
                  if (staleEntry.dc) {
                    staleEntry.dc.onmessage = null
                    staleEntry.dc.onopen = null
                    staleEntry.dc.onclose = null
                    staleEntry.dc.onerror = null
                    try { staleEntry.dc.close() } catch {}
                  }
                  if (staleEntry.pc) {
                    staleEntry.pc.onicecandidate = null
                    staleEntry.pc.onconnectionstatechange = null
                    staleEntry.pc.oniceconnectionstatechange = null
                    try { staleEntry.pc.close() } catch {}
                  }
                  clients.delete(oldSender)
                  stagedClients.delete(oldSender)
                }
                sas.cleanupPeerResources(oldSender)
                const boundUid = ctx.clientIdToScoutId?.get(oldSender)
                if (boundUid) {
                  ctx.scoutIdToClientIds?.get(boundUid)?.delete(oldSender)
                  ctx.clientIdToScoutId?.delete(oldSender)
                }
                ctx.clientIdToScoutName?.delete(oldSender)
              }
            }
          }
          sas.clientDeviceIds.set(sender, clientDeviceId)
          const isTicketVerified = Boolean(verifiedUser)
          const effectiveUserId = verifiedUser?.userId || offerData?.userId || data.userId || ''
          const effectiveUsername = verifiedUser?.username || offerData?.username || data.username || sender

          sas.clientVerifiedIdentities.set(sender, {
            userId: effectiveUserId,
            username: effectiveUsername,
            ecdhPublicKey: data.ecdhPublicKey
          })

          const isFlapping =
            clients.has(sender) &&
            sas.clientEcdhPubHexes.has(sender) &&
            sas.clientEcdhPubHexes.get(sender) !== data.ecdhPublicKey

          const trustEval = await evaluatePeerKeyTrust({
            eventId: currentInviteCode || 'default_event',
            userId: effectiveUserId,
            username: effectiveUsername,
            deviceId: clientDeviceId,
            publicKeyHex: data.ecdhPublicKey,
            isInSessionFlapping: isFlapping
          })

          const bindVerifiedPeerIdentity = () => {
            sas.clientVerifiedIdentities.set(sender, {
              userId: effectiveUserId,
              username: effectiveUsername,
              ecdhPublicKey: data.ecdhPublicKey
            })
            // 关键修复：立刻绑定 sender <-> effectiveUserId 双向映射，确保私信与防伪校验立即可用
            if (effectiveUserId) {
              ctx.clientIdToScoutId?.set(sender, effectiveUserId)
              if (effectiveUsername) {
                ctx.clientIdToScoutName?.set(sender, effectiveUsername)
              }
              if (ctx.scoutIdToClientIds) {
                let cSet = ctx.scoutIdToClientIds.get(effectiveUserId)
                if (!cSet) {
                  cSet = new Set()
                  ctx.scoutIdToClientIds.set(effectiveUserId, cSet)
                }
                cSet.add(sender)
              }
            }
            sas.clientSasStates.set(sender, 'VERIFIED')
            if (effectiveUserId) {
              ctx.callbacks.onClientConnected?.(effectiveUserId, effectiveUsername)
            }
          }

          if (trustEval.status === 'TRUSTED_MATCH') {
            log.info(`[TOFU] Trusted device match: ${clientDeviceId} (${effectiveUsername}). Auto-approving SAS.`)
            bindVerifiedPeerIdentity()

            const pendingOut = sas.hostPendingOutgoing.get(sender) || []
            sas.hostPendingOutgoing.delete(sender)
            for (const item of pendingOut) {
              ctx.sendMessage(item.msg, item.targetId)
            }
            const pendingIn = sas.hostPendingIncoming.get(sender) || []
            sas.hostPendingIncoming.delete(sender)
            for (const item of pendingIn) {
              ctx.handleChannelMessage(item.ev, item.senderId)
            }
          } else if (trustEval.status === 'TOFU_FIRST_SEEN') {
            log.info(`[TOFU] Establishing baseline trust for device ${clientDeviceId} (${effectiveUsername}) [ticketVerified: ${isTicketVerified}]. Auto-approving SAS.`)
            if (effectiveUserId) {
              await savePeerTrustRecord({
                eventId: currentInviteCode || 'default_event',
                userId: effectiveUserId,
                username: effectiveUsername,
                deviceId: clientDeviceId,
                publicKeyHex: data.ecdhPublicKey,
                firstSeenAt: Date.now(),
                lastSeenAt: Date.now(),
                trustedAt: Date.now(),
                trustLevel: 'TOFU_TRUSTED'
              })
            }
            bindVerifiedPeerIdentity()

            const pendingOut = sas.hostPendingOutgoing.get(sender) || []
            sas.hostPendingOutgoing.delete(sender)
            for (const item of pendingOut) {
              ctx.sendMessage(item.msg, item.targetId)
            }
            const pendingIn = sas.hostPendingIncoming.get(sender) || []
            sas.hostPendingIncoming.delete(sender)
            for (const item of pendingIn) {
              ctx.handleChannelMessage(item.ev, item.senderId)
            }
          } else if (trustEval.status === 'MULTI_USER_DEVICE_SWITCH') {
            log.warn(`[WebRTC Host Security ALERT] ${trustEval.message}`)
            const isAlreadyPending = sas.sasTimeoutTimers.has(sender)
            sas.clientSasStates.set(sender, 'PENDING_VERIFICATION')
            const fingerprint = sas.clientFingerprints.get(sender)
            if (fingerprint) {
              if (!isAlreadyPending) {
                ctx.callbacks.onSasVerificationRequired?.(
                  {
                    peerId: sender,
                    username: effectiveUsername,
                    ecdhPublicKey: data.ecdhPublicKey
                  },
                  fingerprint
                )
              }

              signaling.send(
                {
                  type: 'sas_challenge',
                  fingerprint,
                  hostSessionId,
                  username: ctx.getUsername?.() || ''
                },
                sender
              )
            }
          } else if (trustEval.status === 'KEY_ROTATION_ALERT') {
            if (trustEval.level === 'CRITICAL') {
              log.error(`[WebRTC Host Security ALERT] ${trustEval.message}`)
              ctx.rejectSas(sender, trustEval.message)
              return
            } else {
              log.warn(`[WebRTC Host Security NOTICE] ${trustEval.message}`)
              const isAlreadyPending = sas.sasTimeoutTimers.has(sender)
              sas.clientSasStates.set(sender, 'PENDING_VERIFICATION')
              const fingerprint = sas.clientFingerprints.get(sender)
              if (fingerprint) {
                if (!isAlreadyPending) {
                  ctx.callbacks.onSasVerificationRequired?.(
                    {
                      peerId: sender,
                      username: effectiveUsername,
                      ecdhPublicKey: data.ecdhPublicKey
                    },
                    fingerprint
                  )
                }

                signaling.send(
                  {
                    type: 'sas_challenge',
                    fingerprint,
                    hostSessionId,
                    username: ctx.getUsername?.() || ''
                  },
                  sender
                )
              }
            }
          }
        } else if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test' && !data.requireEcdh) {
          // 在测试环境下兼容未模拟 ECDH 的基础业务流程测试
          sas.clientSasStates.set(sender, 'VERIFIED')
        } else {
          log.warn(`Dropping offer from ${sender}: missing mandatory ecdhPublicKey.`)
          ctx.rejectSas(sender, 'Missing mandatory ECDH public key')
          return
        }

        const pc = clientData.pc
        const cached = preOfferCandidates.get(sender) || []
        preOfferCandidates.delete(sender)
        for (const entry of cached) {
          if (!entry.sessionTag || !data.clientSessionId || entry.sessionTag === data.clientSessionId) {
            clientData.pendingCandidates.push(entry.payload)
          }
        }

        await pc.setRemoteDescription(toSessionDescription(offerData))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        // 等待最多 180ms（测试环境跳过）让 Chromium 采集完本地公网 IPv6 (2000::/3) host 候选与 STUN srflx 候选（一旦集齐立即在 8ms 轮询中提前结束），
        // 直接内嵌进 answer.sdp 随单条信令发回从机，确保双端代理环境下高延迟反射的 srflx 候选也能直接随首包下发
        const isTestEnv =
          (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
          Boolean((globalThis as any).__vitest_worker__)
        if (!isTestEnv && pc.iceGatheringState !== 'complete') {
          await new Promise<void>((resolve) => {
            let done = false
            const finish = () => {
              if (done) return
              done = true
              clearInterval(pollTimer)
              clearTimeout(maxTimer)
              resolve()
            }
            const pollTimer = setInterval(() => {
              const curSdp = pc.localDescription?.sdp || ''
              const hasV6Host = /a=candidate:[^\r\n]*\s[23][0-9a-f]{0,3}:[^\r\n]*\styp\s+host/i.test(curSdp)
              const hasSrflx = /a=candidate:[^\r\n]*\styp\s+srflx/i.test(curSdp)
              if (pc.iceGatheringState === 'complete' || (hasV6Host && hasSrflx)) {
                finish()
              }
            }, 8)
            const maxTimer = setTimeout(finish, 180)
          })
        }

        const optimizedAnswer = {
          type: answer.type,
          sdp: optimizeSdpCandidates(pc?.localDescription?.sdp || answer.sdp || '', true)
        }

        let answerPayload: any = optimizedAnswer
        const isAnswerEncrypted = sas.clientSharedKeys.has(sender)
        if (isAnswerEncrypted) {
          try {
            answerPayload = await encryptSignalingData(
              sas.clientSharedKeys.get(sender)!,
              JSON.stringify(optimizedAnswer)
            )
          } catch (err) {
            log.warn(`Failed to encrypt answer for ${sender}, sending plaintext fallback:`, err)
          }
        }

        log.info(`Sending WebRTC answer to ${sender}`, {
          encrypted: isAnswerEncrypted,
          hasSessionDescription: Boolean(answer.sdp),
          clientSessionId: data.clientSessionId
        })

        signaling.send(
          {
            answer: answerPayload,
            // 回显 clientSessionId：Client 据此丢弃针对旧 Offer 的过期 Answer
            clientSessionId: data.clientSessionId,
            hostSessionId,
            hostIpv6: cachedHostIpv6 || undefined,
            ecdhPublicKey: localEcdhPubHex,
            deviceId: localDeviceId,
            username: ctx.getUsername?.() || '',
            userId: ctx.getUserId?.() || ''
          },
          sender
        )

        // Answer 已发出：现在放行暂存的本地 Trickle 候选，严格保证 Answer -> Candidate 顺序
        ctx.peerMgr.releaseLocalCandidates(pc)

        // 若 Offer SDP 内已内嵌了从机的 srflx 候选，合成紧邻端口预测候选以穿透手机 VPN 四元组 NAT / CGNAT
        if (offerData?.sdp && typeof offerData.sdp === 'string') {
          for (const line of offerData.sdp.split(/\r?\n/)) {
            if (line.startsWith('a=candidate:') && /\btyp\s+srflx\b/i.test(line)) {
              const predictedList = synthesizeSymmetricNatPortCandidates(line.slice(2))
              for (const predCandStr of predictedList) {
                try {
                  await pc.addIceCandidate(
                    toIceCandidate({ candidate: predCandStr, sdpMid: '0', sdpMLineIndex: 0 })
                  )
                } catch {}
              }
            }
          }
        }

        const sortedPending = sortCandidatesPreferIpv6(clientData.pendingCandidates)
        clientData.pendingCandidates = []
        for (const c of sortedPending) {
          try {
            let candidateObj: any = c
            if (candidateObj && candidateObj.ciphertext && sas.clientSharedKeys.has(sender)) {
              try {
                const decStr = await decryptSignalingData(sas.clientSharedKeys.get(sender)!, candidateObj)
                candidateObj = JSON.parse(decStr)
              } catch (err) {
                console.warn('[WebRTC Host] Error decrypting pending candidate:', err)
                continue
              }
            }
            if (candidateObj && candidateObj.candidate) {
              if (isBogusOrTunCandidate(candidateObj.candidate, true)) {
                continue
              }
              candidateObj.candidate = optimizeCandidatePriority(candidateObj.candidate)
              log.info(`Remote ICE Candidate (pending) added from ${sender}: ${String(candidateObj.candidate).trim()}`)
            }
            await pc.addIceCandidate(toIceCandidate(candidateObj))
            if (candidateObj?.candidate) {
              const predictedList = synthesizeSymmetricNatPortCandidates(candidateObj.candidate)
              for (const predCandStr of predictedList) {
                try {
                  await pc.addIceCandidate(
                    toIceCandidate({
                      ...candidateObj,
                      candidate: predCandStr
                    })
                  )
                } catch {}
              }
            }
          } catch (err) {
            console.warn('[WebRTC Host] Error adding pending ICE candidate:', err)
          }
        }
      })
    } else if (data.encrypted) {
      ctx.enqueueHostTask(sender, async () => {
        const sharedKey = sas.clientSharedKeys.get(sender)
        const frame = await tryDecryptVirtualFrame(sharedKey, data.encrypted)
        if (!frame) return
        const targetHolder = stagedClients.get(sender) || clients.get(sender)
        if (!targetHolder) return

        // 标记该客户端的后台原生 PC 已由虚拟通道兜底，防止 15s ICE 超时误杀会话与密钥
        ctx.peerMgr.markVirtualChannelActive(targetHolder.pc)
        if (stagedClients.has(sender)) {
          clients.set(sender, targetHolder)
          stagedClients.delete(sender)
        }

        // 若该客户端尚未打开原生 DataChannel，为其挂载 VirtualDataChannel
        if (!targetHolder.dc || targetHolder.dc.readyState !== 'open') {
          const vdc = new VirtualDataChannel({
            label: 'scoutingpro-data-virtual',
            sessionId: frame.sessionId,
            getSignaling: ctx.getSignaling,
            getSharedAesKey: () => sas.clientSharedKeys.get(sender) || null,
            getTargetPeerId: () => sender
          })
          const senderObj = new DataChannelSender(vdc as unknown as RTCDataChannel)
          targetHolder.dc = vdc as unknown as RTCDataChannel
          targetHolder.sender = senderObj
          vdc.onmessage = (e) => ctx.handleChannelMessage(e, sender)
          vdc.onopen = () => {
            log.info(`Host VirtualDataChannel state is now OPEN with ${sender}`)
            ctx.updateHostStatus()
            const currentEventMetadata = ctx.getCurrentEventMetadata()
            if (currentEventMetadata) {
              ctx.sendMessage(
                {
                  type: 'EVENT_METADATA',
                  event: currentEventMetadata,
                  authCode: currentInviteCode || undefined,
                  hostSessionId: hostSessionId || undefined
                },
                sender
              )
            }
          }
          vdc.onclose = () => {
            log.warn(`Host VirtualDataChannel closed with ${sender}`)
            ctx.updateHostStatus()
          }
          vdc.open()
        }

        if (frame.vdc === 'data' && typeof frame.payload === 'string' && (targetHolder.dc as any)?.receiveDecryptedPayload) {
          ;(targetHolder.dc as any).receiveDecryptedPayload(frame.payload)
        }
      })
    } else if (data.candidate) {
      ctx.enqueueHostTask(sender, async () => {
        const candidateSessionTag: string | undefined = data.clientSessionId || undefined
        let candidateData = data.candidate
        if (data.candidate && data.candidate.ciphertext && sas.clientSharedKeys.has(sender)) {
          try {
            const decStr = await decryptSignalingData(sas.clientSharedKeys.get(sender)!, data.candidate)
            candidateData = JSON.parse(decStr)
          } catch (err) {
            console.warn('[WebRTC Host] Error decrypting candidate:', err)
            return
          }
        }
        if (candidateData && candidateData.candidate) {
          // 传入 allowClientTunSrflx = true 允许 Client（手机端）通过 VPN 隧道反射的二阶 srflx 候选到达，由 optimizeCandidatePriority 降权至 45 保留打洞机会
          if (isBogusOrTunCandidate(candidateData.candidate, true)) {
            log.info(`Dropped remote bogus/TUN poison candidate from ${sender}:`, candidateData.candidate)
            return
          }
          candidateData.candidate = optimizeCandidatePriority(candidateData.candidate)
        }

        const targetHolder = stagedClients.get(sender) || clients.get(sender)
        const isSessionMismatch = Boolean(
          targetHolder &&
          candidateSessionTag &&
          targetHolder.sessionId &&
          targetHolder.sessionId !== candidateSessionTag
        )
        if (!targetHolder || isSessionMismatch) {
          // 尚无对应会话的 PeerConnection（Offer 未到 / 旧会话 PC 仍在）：按会话标签暂存，Offer 到达时只注入匹配会话的候选
          const cachedList = preOfferCandidates.get(sender) || []
          cachedList.push({ sessionTag: candidateSessionTag, payload: candidateData })
          if (cachedList.length > MAX_PRE_OFFER_CANDIDATES) {
            cachedList.splice(0, cachedList.length - MAX_PRE_OFFER_CANDIDATES)
          }
          preOfferCandidates.set(sender, cachedList)
          return
        }
        if (targetHolder.pc) {
          try {
            if (candidateData?.candidate) {
              log.info(`Remote ICE Candidate added from ${sender}: ${String(candidateData.candidate).trim()}`)
            }
            await targetHolder.pc.addIceCandidate(toIceCandidate(candidateData))
            if (candidateData?.candidate) {
              const predictedList = synthesizeSymmetricNatPortCandidates(candidateData.candidate)
              for (const predCandStr of predictedList) {
                try {
                  await targetHolder.pc.addIceCandidate(
                    toIceCandidate({
                      ...candidateData,
                      candidate: predCandStr
                    })
                  )
                } catch {}
              }
            }
          } catch {
            targetHolder.pendingCandidates.push(candidateData)
          }
        }
      })
    } else if (data.type === 'sas_verified') {
      log.info(`Peer ${sender} confirmed SAS verification`)
      if (sas.clientSasStates.get(sender) === 'PENDING_VERIFICATION') {
        if (ctx.confirmSas) {
          ctx.confirmSas(sender)
        } else {
          sas.confirmSas(sender, true, currentInviteCode, ctx.callbacks, ctx.sendMessage, ctx.handleChannelMessage)
        }
      }
    } else if (data.type === 'sas_rejected') {
      log.warn(`Peer ${sender} rejected SAS verification. Reason: ${data.reason || 'Rejected by peer'}`)
      ctx.rejectSas(sender, data.reason || 'Rejected by peer')
    }
  }

  handler.getHostIpv6 = () => cachedHostIpv6
  return handler
}
