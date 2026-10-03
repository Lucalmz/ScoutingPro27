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
  sortCandidatesPreferIpv6,
  isGlobalIpv6Address,
  cleanIpAddress,
  shouldForceRelayForAttempt,
  CONNECTION_TIMING
} from './connectivity'
import type { SignalingChannel } from './signaling'
import { toSessionDescription, toIceCandidate } from './sdpUtil'
import type { SasSecurityManager } from './sasManager'
import type { PeerConnectionManager } from './peerManager'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:Client')

/** 连续失败多少次后进入 long_offline（之后仅由 Host 心跳 / 自愈事件唤醒） */
const MAX_RECONNECT_ATTEMPTS = 6
/** DataChannel 心跳：连续丢失多少次判定为“降级”（仅 UI 提示，持续观察） */
const HEARTBEAT_DEGRADE_MISSES = 2
/** DataChannel 心跳：连续丢失多少次判定为 SCTP 僵死，触发重建（ICE consent 仍存活但通道卡死的兜底） */
const HEARTBEAT_REBUILD_MISSES = 8

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
  /** 当前是否处于 Active Host 模式（Host 模式下绝不允许 Client 建连逻辑运行） */
  isHostMode?: () => boolean
  getStatus: () => string
  setStatus: (s: any) => void
  sendMessage: (msg: WebRtcMessage, targetId?: string) => Promise<void>
  handleChannelMessage: (ev: MessageEvent, senderId?: string) => Promise<void>
  rejectSas: (peerId?: string, reason?: string) => void
  confirmSas?: (peerId?: string) => void
  getUsername?: () => string
  getUserId?: () => string
  callbacks: WebRtcCallbacks
}

/**
 * Client 会话（建联状态机的唯一决策者）
 *
 * 防自锁设计要点：
 * 1. 尝试纪元（attemptEpoch）：每次重建都会递增纪元，所有异步续体、DataChannel/PeerConnection 回调、
 *    计时器都绑定创建时的纪元，过期回调一律静默丢弃，杜绝“旧尝试的失败回调拆掉新连接”的连锁反应。
 * 2. 每个纪元的失败只处理一次（failedEpoch），DataChannel close / PC failed / 建联超时同时触发也只调度一次重连。
 * 3. 信令消息串行处理（signalingQueue），Answer 与 Candidate 不再并发竞争，pending 候选不会丢失。
 * 4. Answer / Candidate 按 clientSessionId 校验，过期会话的应答与候选直接丢弃。
 * 5. 重试阶梯：'all'（IPv6 + LAN + IPv4 打洞 + TURN 并行）→ 'all' → 'relay' → 'all' → 'relay' …，指数退避，
 *    达到上限进入 long_offline；Host 心跳 / host_hello / 系统自愈事件会重新开启阶梯，不会永久卡死。
 */
export function createClientSession(ctx: ClientSessionContext) {
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let connectWatchdog: ReturnType<typeof setTimeout> | null = null
  let lastOfferTimestamp = 0
  let lastHostIpv6: string | null = null
  let attemptEpoch = 0
  let failedEpoch = -1
  let activeSetupPromise: Promise<void> | null = null
  let lastPresenceRecoveryAt = 0
  let signalingQueue: Promise<void> = Promise.resolve()

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function clearConnectWatchdog() {
    if (connectWatchdog) {
      clearTimeout(connectWatchdog)
      connectWatchdog = null
    }
  }

  function resetReconnectAttempts() {
    reconnectAttempts = 0
  }

  function resetOfferTimestamp() {
    lastOfferTimestamp = 0
  }

  /**
   * 是否允许自动重连（显式断开、会话冲突、SAS 待核验/已拒绝、Host 模式下一律禁止）
   */
  function canAutoReconnect(): boolean {
    if (ctx.isExplicitlyClosed()) return false
    if (ctx.isHostMode?.()) return false
    if (ctx.callbacks.isConflictActive?.()) {
      log.info('Session conflict is active; suppressing auto-reconnect.')
      return false
    }
    if (ctx.sas.clientSasState === 'PENDING_VERIFICATION') {
      log.info('SAS verification pending; pausing auto-reconnect.')
      return false
    }
    if (ctx.sas.clientSasState === 'REJECTED') {
      log.warn('SAS verification rejected; suppressing auto-reconnect.')
      return false
    }
    return true
  }

  function triggerClientReconnect(reason = 'unspecified') {
    if (ctx.getStatus() === 'long_offline') return
    if (!canAutoReconnect()) return

    clearReconnectTimer()

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.warn(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Moving to long_offline (will resume on host presence / app resume).`)
      clearConnectWatchdog()
      ctx.setStatus('long_offline')
      return
    }

    const delay = reconnectAttempts === 0 ? 1000 : Math.min(32000, Math.pow(2, reconnectAttempts) * 1000)
    reconnectAttempts++
    const attemptNumber = reconnectAttempts
    const forceRelay = shouldForceRelayForAttempt(attemptNumber)

    log.info(
      `Scheduling reconnect in ${delay}ms (Attempt ${attemptNumber}/${MAX_RECONNECT_ATTEMPTS}, reason: ${reason}, icePolicy: ${forceRelay ? 'relay' : 'all'})...`
    )
    ctx.setStatus('connecting')

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void restartClientConnection(forceRelay)
    }, delay)
  }

  /**
   * 一次性失败处理：仅当前纪元、且该纪元尚未处理过失败时才调度重连。
   */
  function failAttempt(epoch: number, reason: string) {
    if (epoch !== attemptEpoch) {
      log.info(`Ignoring stale failure signal (reason: ${reason}, epoch: ${epoch}, current: ${attemptEpoch})`)
      return
    }
    if (failedEpoch === epoch) return
    failedEpoch = epoch
    clearConnectWatchdog()
    log.warn(`Connection attempt failed (reason: ${reason}, epoch: ${epoch}, attempts so far: ${reconnectAttempts})`)
    triggerClientReconnect(reason)
  }

  function hardResetChannels() {
    // 递增纪元：所有旧尝试的异步续体与回调从此刻起全部失效
    attemptEpoch++
    clearReconnectTimer()
    clearConnectWatchdog()
    stopDataChannelHeartbeat()

    for (const [, resolve] of pendingPings.entries()) {
      resolve(false)
    }
    pendingPings.clear()

    const oldDc = ctx.getClientDc()
    if (oldDc) {
      oldDc.onmessage = null
      oldDc.onopen = null
      oldDc.onerror = null
      oldDc.onclose = null
      try { oldDc.close() } catch (_) {}
      ctx.setClientDc(null)
    }

    const oldPc = ctx.getClientPc()
    if (oldPc) {
      oldPc.onicecandidate = null
      oldPc.oniceconnectionstatechange = null
      oldPc.onconnectionstatechange = null
      try { oldPc.ondatachannel = () => {} } catch (_) {}
      try { oldPc.close() } catch (_) {}
      ctx.setClientPc(null)
    }

    ctx.setClientSender(null)
    ctx.setClientPendingCandidates([])
    resetOfferTimestamp()
    activeSetupPromise = null
  }

  function startSetup(forceRelay: boolean): Promise<void> {
    // doSetupClientConnection 的同步前缀会执行 hardResetChannels（递增纪元、清空 activeSetupPromise）
    const p = doSetupClientConnection(forceRelay)
    activeSetupPromise = p
    const clear = () => {
      if (activeSetupPromise === p) activeSetupPromise = null
    }
    p.then(clear, clear)
    return p
  }

  /**
   * 确保建连：若已有进行中的建连尝试则复用，不重复拆建。
   */
  function setupClientConnection(forceRelay = false): Promise<void> {
    if (activeSetupPromise) {
      log.info('setupClientConnection already in flight; awaiting active setup.')
      return activeSetupPromise
    }
    return startSetup(forceRelay)
  }

  /**
   * 强制重建：作废任何进行中的尝试（纪元递增），以新会话重新握手。用于重试阶梯、Host 会话切换等场景。
   */
  function restartClientConnection(forceRelay = false): Promise<void> {
    return startSetup(forceRelay)
  }

  function armConnectWatchdog(epoch: number, dc: RTCDataChannel) {
    clearConnectWatchdog()
    connectWatchdog = setTimeout(() => {
      connectWatchdog = null
      if (epoch !== attemptEpoch) return
      if (dc.readyState === 'open') return
      log.warn(
        `DataChannel not open within ${CONNECTION_TIMING.CLIENT_CONNECT_TIMEOUT_MS}ms after offer dispatch (offer lost / all ICE pairs blocked).`
      )
      failAttempt(epoch, 'connect_timeout')
    }, CONNECTION_TIMING.CLIENT_CONNECT_TIMEOUT_MS)
  }

  async function doSetupClientConnection(forceRelay = false) {
    hardResetChannels()
    const epoch = attemptEpoch
    if (ctx.isHostMode?.()) {
      log.info('Skipping client setup: service is in active host mode.')
      return
    }
    ctx.setClientForceRelay(forceRelay)
    const newClientSessionId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    ctx.setClientSessionId(newClientSessionId)
    if (ctx.getStatus() !== 'connected' && ctx.getStatus() !== 'connecting') {
      ctx.setStatus('connecting')
    }
    log.info(
      `Initiating setupClientConnection (sessionId: ${newClientSessionId}, epoch: ${epoch}, icePolicy: ${forceRelay ? 'relay' : 'all'}, hostSenderId: ${ctx.getClientHostSenderId() || 'none'}, hostIpv6: ${lastHostIpv6 || 'unknown'})`
    )

    const pc = ctx.peerMgr.createPeerConnection(
      undefined,
      (reason?: string) => failAttempt(epoch, reason || 'peer_failure'),
      forceRelay,
      ctx.getClientHostSenderId(),
      { sessionTag: newClientSessionId, holdLocalCandidates: true }
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
      if (epoch !== attemptEpoch) return
      log.info(`DataChannel 'scoutingpro-data' OPENED! Client successfully connected to Host (epoch: ${epoch}).`)
      // 若该纪元曾因超时被判失败但随后迟到连通，撤销失败标记，确保之后的真实断开仍能触发重连
      if (failedEpoch === epoch) failedEpoch = -1
      clearConnectWatchdog()
      clearReconnectTimer()
      reconnectAttempts = 0
      ctx.setStatus('connected')
      startDataChannelHeartbeat()
    }
    dc.onclose = () => {
      if (epoch !== attemptEpoch) return
      log.warn(`DataChannel 'scoutingpro-data' CLOSED (epoch: ${epoch}, sasState: ${ctx.sas.clientSasState})`)
      stopDataChannelHeartbeat()
      ctx.setClientSender(null)
      if (ctx.isExplicitlyClosed() || ctx.getStatus() === 'long_offline') return
      if (ctx.sas.clientSasState === 'PENDING_VERIFICATION' || ctx.sas.clientSasState === 'REJECTED') {
        return
      }
      failAttempt(epoch, 'datachannel_closed')
    }

    const localEcdhPubHex = ctx.getLocalEcdhPubHex()
    const currentInviteCode = ctx.getCurrentInviteCode()
    const localDeviceId = ctx.getLocalDeviceId()

    try {
      const offer = await pc.createOffer()
      if (epoch !== attemptEpoch) return
      await pc.setLocalDescription(offer)
      if (epoch !== attemptEpoch) return
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
        if (epoch !== attemptEpoch) return
      }

      const rawOffer = {
        type: offer.type,
        // 读取 localDescription 以携带 ticket 请求期间已收集到的候选（与后续 trickle 候选互为冗余）
        sdp: optimizeSdpCandidates(pc?.localDescription?.sdp || offer.sdp || ''),
        ticket: handshakeTicket,
        deviceId: localDeviceId,
        username: ctx.getUsername?.() || '',
        userId: ctx.getUserId?.() || ''
      }

      let offerPayload: any = rawOffer
      if (ctx.sas.clientSharedAesKey) {
        try {
          offerPayload = await encryptSignalingData(ctx.sas.clientSharedAesKey, JSON.stringify(rawOffer))
          log.info('Offer payload encrypted with shared AES key.')
        } catch (err) {
          log.warn('Failed to encrypt offer, sending plaintext fallback:', err)
        }
        if (epoch !== attemptEpoch) return
      }

      const signaling = ctx.getSignaling()
      lastOfferTimestamp = Date.now()
      log.info(`Dispatched Offer to Host via signaling (target: ${ctx.getClientHostSenderId() || 'broadcast'}, sessionId: ${newClientSessionId})`)
      signaling?.send({
        offer: offerPayload,
        ecdhPublicKey: localEcdhPubHex,
        deviceId: localDeviceId,
        clientSessionId: newClientSessionId,
        hostSessionId: ctx.getCurrentHostSessionId(),
        username: ctx.getUsername?.() || '',
        userId: ctx.getUserId?.() || ''
      }, ctx.getClientHostSenderId())

      // Offer 已发出：放行暂存的本地候选（保证 Host 先建 PeerConnection 再收候选），并启动建联超时
      ctx.peerMgr.releaseLocalCandidates(pc)
      armConnectWatchdog(epoch, dc)
    } catch (err) {
      if (epoch !== attemptEpoch) {
        log.info('Offer creation aborted by a newer connection attempt.')
        return
      }
      log.error('Error creating offer:', err)
      failAttempt(epoch, 'offer_failed')
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

    const effectiveHostUserId = hostUserId || sas.clientHostUserId || ''
    const effectiveHostUsername = hostUsername || sas.clientHostUsername || (effectiveHostUserId ? `User ${effectiveHostUserId.slice(0, 8)}` : 'Host')
    if (effectiveHostUserId) sas.clientHostUserId = effectiveHostUserId
    if (effectiveHostUsername) sas.clientHostUsername = effectiveHostUsername

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

  /**
   * 信令入口：所有 Client 侧信令严格串行处理，杜绝 Answer 与 Candidate 并发导致的 pending 候选丢失。
   */
  function handleClientSignalingMessage(data: any): Promise<void> {
    const run = signalingQueue.then(() => processClientSignalingMessage(data))
    signalingQueue = run.catch((err) => {
      log.error('Unhandled error while processing client signaling message:', err)
    })
    return signalingQueue
  }

  /**
   * Host 存在感知恢复：处于 long_offline / offline / degraded 且没有进行中的尝试时，
   * 收到 Host 心跳即重新开启重试阶梯（节流），解决“重试耗尽后永久离线”的自锁。
   */
  function maybeRecoverOnHostPresence(data: any) {
    const status = ctx.getStatus()
    if (status !== 'long_offline' && status !== 'offline' && status !== 'degraded') return
    if (activeSetupPromise || reconnectTimer) return
    if (!canAutoReconnect()) return
    const now = Date.now()
    if (now - lastPresenceRecoveryAt < CONNECTION_TIMING.HOST_PRESENCE_RECOVERY_THROTTLE_MS) return
    lastPresenceRecoveryAt = now

    log.info(`Host presence detected (hostSessionId: ${data.hostSessionId || 'unknown'}) while ${status}; restarting connection ladder.`)
    reconnectAttempts = 0
    const localEcdhPubHex = ctx.getLocalEcdhPubHex()
    if (localEcdhPubHex) {
      ctx.getSignaling()?.send({ type: 'client_hello', ecdhPublicKey: localEcdhPubHex, deviceId: ctx.getLocalDeviceId() })
    }
    ctx.setStatus('connecting')
    void restartClientConnection(false)
  }

  async function processClientSignalingMessage(data: any) {
    const localEcdhKeyPair = ctx.getLocalEcdhKeyPair()
    const sas = ctx.sas

    if (data.type === 'host_heartbeat') {
      maybeRecoverOnHostPresence(data)
      return
    }

    if (data.type === 'host_hello') {
      log.info(`Received host_hello: hostSessionId=${data.hostSessionId}, deviceId=${data.deviceId}, sender=${data.sender}, hostIpv6=${data.hostIpv6 || 'n/a'}`)
      if (data.hostIpv6 && isGlobalIpv6Address(data.hostIpv6)) {
        lastHostIpv6 = cleanIpAddress(data.hostIpv6)
      }
      const previousHostSessionId = ctx.getCurrentHostSessionId()
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
      const isConnectingOrChecking = Boolean(
        curPc &&
        (curPc.connectionState === 'connecting' || curPc.iceConnectionState === 'checking')
      )
      const isHandshakeInFlight = Boolean(
        activeSetupPromise ||
        (curPc &&
          curPc.connectionState !== 'closed' &&
          curPc.connectionState !== 'failed' &&
          lastOfferTimestamp > 0 &&
          Date.now() - lastOfferTimestamp < 8000)
      )

      if (hostSessionChanged) {
        log.info(`Host session changed (${previousHostSessionId} -> ${data.hostSessionId}); restarting handshake with new host.`)
        clearReconnectTimer()
        reconnectAttempts = 0
        void restartClientConnection(false)
      } else if (!isAlreadyConnected && !isConnectingOrChecking && !isHandshakeInFlight) {
        log.info(
          `Setting up client connection on host_hello (isAlreadyConnected: ${isAlreadyConnected}, isConnecting: ${isConnectingOrChecking}, isHandshakeInFlight: ${isHandshakeInFlight})`
        )
        clearReconnectTimer()
        reconnectAttempts = 0
        void setupClientConnection()
      } else {
        log.info(
          `Preserving existing peer connection on host_hello (alreadyConnected: ${isAlreadyConnected}, connecting: ${isConnectingOrChecking}, handshakeInFlight: ${isHandshakeInFlight})`
        )
      }
      return
    }

    if (data.type === 'host_takeover') {
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
      void restartClientConnection(false)
      return
    }

    if (data.type === 'HOST_LEAVING') {
      log.warn(`Host explicitly left the room: hostSessionId=${data.hostSessionId}`)
      // 彻底复位（递增纪元、清理所有计时器），等待 Host 心跳再次出现时由存在感知自动恢复
      hardResetChannels()
      ctx.setStatus('offline')
      ctx.callbacks.onActiveHostLeft?.()
      return
    }

    if (data.answer) {
      const clientPc = ctx.getClientPc()
      if (!clientPc) return
      const currentSessionId = ctx.getClientSessionId()
      if (data.clientSessionId && currentSessionId && data.clientSessionId !== currentSessionId) {
        log.info(`Dropping stale Answer for session ${data.clientSessionId} (current: ${currentSessionId})`)
        return
      }
      if (clientPc.signalingState === 'stable' || clientPc.signalingState === 'closed') {
        log.info(`Dropping duplicate/unsolicited Answer (signalingState: ${clientPc.signalingState})`)
        return
      }
      const epoch = attemptEpoch
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

        if (epoch !== attemptEpoch || ctx.getClientPc() !== clientPc) {
          log.info('Answer arrived for a superseded connection attempt; ignoring.')
          return
        }

        try {
          await clientPc.setRemoteDescription(toSessionDescription(answerData))
        } catch (sdpErr) {
          log.error('Host Answer rejected by PeerConnection; failing attempt for fast rebuild:', sdpErr)
          failAttempt(epoch, 'answer_rejected')
          return
        }
        log.info('Applied remote Host Answer to client PeerConnection.')
        const sortedPending = sortCandidatesPreferIpv6(ctx.getClientPendingCandidates())
        ctx.setClientPendingCandidates([])
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
      } catch (err) {
        log.error('Error processing Host Answer:', err)
      }
      return
    }

    if (data.candidate) {
      const clientPc = ctx.getClientPc()
      if (!clientPc) return
      const currentSessionId = ctx.getClientSessionId()
      if (data.clientSessionId && currentSessionId && data.clientSessionId !== currentSessionId) {
        // 过期会话候选，或其他 Client 在广播阶段发出的候选
        return
      }
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

      if (ctx.getClientPc() !== clientPc) return
      try {
        await clientPc.addIceCandidate(toIceCandidate(candidateData))
      } catch (addErr) {
        if (!clientPc.remoteDescription) {
          // Answer 尚未应用：暂存，待 Answer 应用后按优先级统一注入
          const pending = ctx.getClientPendingCandidates()
          pending.push(candidateData)
          ctx.setClientPendingCandidates(pending)
        } else {
          log.warn('Dropping remote candidate rejected by PeerConnection:', addErr)
        }
      }
      return
    }

    if (data.type === 'sas_challenge') {
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

  let dataChannelHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  let consecutiveFailedPings = 0

  function startDataChannelHeartbeat() {
    stopDataChannelHeartbeat()
    consecutiveFailedPings = 0
    const epoch = attemptEpoch
    const intervalMs = (globalThis as any).__TEST_HEARTBEAT_INTERVAL_MS__ ?? 2000
    const pingTimeoutMs = (globalThis as any).__TEST_PING_TIMEOUT_MS__ ?? 1000

    dataChannelHeartbeatTimer = setInterval(async () => {
      if (epoch !== attemptEpoch) {
        stopDataChannelHeartbeat()
        return
      }
      const dc = ctx.getClientDc()
      const pc = ctx.getClientPc()
      if (!dc || dc.readyState !== 'open' || !pc || pc.connectionState !== 'connected') {
        return
      }
      const isAlive = await pingHost(pingTimeoutMs)
      if (epoch !== attemptEpoch) return
      if (!isAlive) {
        consecutiveFailedPings++
        log.warn(`DataChannel heartbeat ping timeout (${consecutiveFailedPings} consecutive misses)`)
        if (consecutiveFailedPings === HEARTBEAT_DEGRADE_MISSES) {
          // 仅降级提示并持续观察：Host 主线程短暂繁忙时 PONG 恢复后自动回到 connected，避免重建风暴
          log.warn('Active host unresponsive via DataChannel heartbeat. Marking degraded and continuing to probe.')
          ctx.peerMgr.resetTransportInfo()
          ctx.setStatus('degraded')
          ctx.callbacks.onHostDisconnected?.()
          ctx.callbacks.onActiveHostLeft?.()
        } else if (consecutiveFailedPings >= HEARTBEAT_REBUILD_MISSES) {
          log.warn('DataChannel heartbeat dead for an extended period (SCTP wedged). Forcing connection rebuild.')
          stopDataChannelHeartbeat()
          failAttempt(epoch, 'heartbeat_timeout')
        }
      } else {
        if (consecutiveFailedPings > 0 && ctx.getStatus() === 'degraded') {
          log.info('DataChannel heartbeat restored, updating status to connected.')
          ctx.setStatus('connected')
          const pc2 = ctx.getClientPc()
          if (pc2) void ctx.peerMgr.updateTransportInfo(pc2)
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
    restartClientConnection,
    handleClientSignalingMessage,
    triggerClientReconnect,
    clearReconnectTimer,
    resetReconnectAttempts,
    pingHost,
    handlePong,
    startDataChannelHeartbeat,
    stopDataChannelHeartbeat,
    resetOfferTimestamp,
    hardResetChannels
  }
}
