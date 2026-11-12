import type { WebRtcMessage } from '@/types'
import { createWebRtcTicket } from '@/services/api'
import { DataChannelSender } from '@/services/dataChannelSender'
import {
  importEcdhPublicKey,
  deriveSharedAesKey,
  encryptSignalingData,
  decryptSignalingData
} from '@/utils/crypto'

import type { WebRtcCallbacks } from './types'
import {
  optimizeCandidatePriority,
  synthesizeSymmetricNatPortCandidates,
  sortCandidatesPreferIpv6,
  isGlobalIpv6Address,
  isBogusOrTunCandidate,
  cleanIpAddress,
  shouldAllowTurnForAttempt,
  shouldForceRelayForAttempt,
  probeLocalInterfaceIpv6,
  resetLocalIpv6ProbeCache,
  getCachedPhysicalAddresses,
  waitForDoHStunIpv6Bounded,
  CONNECTION_TIMING
} from './connectivity'
import type { SignalingChannel } from './signaling'
import { toSessionDescription, toIceCandidate } from './sdpUtil'
import type { SasSecurityManager } from './sasManager'
import type { PeerConnectionManager } from './peerManager'
import { evaluateAndApplyClientTrust } from './clientTrustHelper'
import { createClientSilentUpgradeManager } from './clientSilentUpgrade'
import { createClientHeartbeatManager } from './clientHeartbeat'
import { createClientVirtualFallbackController } from './clientVirtualFallback'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:Client')

/** 连续失败多少次后进入 long_offline（之后仅由 Host 心跳 / 自愈事件唤醒） */
const MAX_RECONNECT_ATTEMPTS = 6

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
  getClientSender?: () => DataChannelSender | null
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
  let lateSlaacTimer: ReturnType<typeof setTimeout> | null = null
  let virtualFallbackTimer: ReturnType<typeof setTimeout> | null = null
  let lastOfferTimestamp = 0
  let lastHostIpv6: string | null = null
  let attemptEpoch = 0
  let failedEpoch = -1
  let activeSetupPromise: Promise<void> | null = null
  let lastPresenceRecoveryAt = 0
  let signalingQueue: Promise<void> = Promise.resolve()
  let silentUpgradeProbeCount = 0

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
    if (lateSlaacTimer) {
      clearTimeout(lateSlaacTimer)
      lateSlaacTimer = null
    }
    if (virtualFallbackTimer) {
      clearTimeout(virtualFallbackTimer)
      virtualFallbackTimer = null
    }
    clearVirtualNativeUpgradeTimer()
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

  const silentUpgradeMgr = createClientSilentUpgradeManager({
    ctx,
    getAttemptEpoch: () => attemptEpoch,
    getProbeCount: () => silentUpgradeProbeCount,
    incrementProbeCount: () => ++silentUpgradeProbeCount
  })

  const { checkAndScheduleSilentUpgrade, clearSilentUpgradeTimers, resetSilentUpgradeState } = silentUpgradeMgr

  const heartbeatMgr = createClientHeartbeatManager({
    ctx,
    getAttemptEpoch: () => attemptEpoch,
    getActiveVirtualDc: () => getActiveVirtualDc(),
    failAttempt
  })

  const {
    handlePong,
    pingHost,
    startDataChannelHeartbeat,
    stopDataChannelHeartbeat,
    abortPendingPings
  } = heartbeatMgr

  const virtualFallbackCtrl = createClientVirtualFallbackController({
    ctx,
    getAttemptEpoch: () => attemptEpoch,
    clearFailedEpochIfMatch: (epoch) => {
      if (failedEpoch === epoch) failedEpoch = -1
    },
    clearConnectWatchdog,
    clearReconnectTimer,
    startDataChannelHeartbeat,
    checkAndScheduleSilentUpgrade,
    getSilentUpgradeProbeCount: () => silentUpgradeProbeCount,
    incrementSilentUpgradeProbeCount: () => ++silentUpgradeProbeCount
  })

  const {
    getActiveVirtualDc,
    isVirtualDcOpen,
    isVirtualDcActiveOnClient,
    clearVirtualNativeUpgradeTimer,
    closeActiveVirtualDc,
    scheduleBackgroundNativeP2pRetry,
    activateVirtualFallbackChannel,
    handleIncomingEncryptedVirtualFrame
  } = virtualFallbackCtrl

  function hardResetChannels() {
    // 递增纪元：所有旧尝试的异步续体与回调从此刻起全部失效
    attemptEpoch++
    clearReconnectTimer()
    clearConnectWatchdog()
    resetSilentUpgradeState()
    stopDataChannelHeartbeat()
    silentUpgradeProbeCount = 0

    const oldSender = ctx.getClientSender?.()
    if (oldSender) {
      try { oldSender.abort('Client channels hard-reset') } catch (_) {}
    }

    abortPendingPings()
    closeActiveVirtualDc()

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

  function armConnectWatchdog(epoch: number, dc: RTCDataChannel, sessionId?: string) {
    clearConnectWatchdog()
    const isTestEnv =
      (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
      Boolean((globalThis as any).__vitest_worker__) ||
      (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ !== undefined

    if ((!isTestEnv || (globalThis as any).__TEST_ENABLE_LATE_SLAAC__) && sessionId) {
      // 记录首包发出瞬间网卡是否已探测到公网 GUA IPv6（兼顾 mDNS 混淆下 SDP 不含明文 IPv6 host 的情况）
      const initialPhysV6s = getCachedPhysicalAddresses().ipv6s
      const hadInitialNicV6 = initialPhysV6s.some((ip) => isGlobalIpv6Address(ip))

      // 1. 针对手机刚切换 Wi-Fi 时 Android IPv6 SLAAC DAD (1.5s) 晚于 IPv4 DHCP (100ms) 就绪的场景（如日志 18:10:36 会话 #5）：
      // 若发出的首包 Offer 未包含本地公网 IPv6 且首包时刻网卡尚未分配 GUA IPv6，在 1800ms 时重新探测网卡，一旦发现新分配了 GUA IPv6 则立即触发新握手！
      lateSlaacTimer = setTimeout(async () => {
        lateSlaacTimer = null
        const isDcOpen = () => dc.readyState === 'open' || ctx.getClientDc()?.readyState === 'open'
        if (epoch !== attemptEpoch || isDcOpen()) return
        if (isVirtualDcOpen()) return
        const curPc = ctx.getClientPc()
        if (!curPc || curPc.connectionState === 'connected') return
        const localSdp = curPc.localDescription?.sdp || ''
        const hadInitialSdpV6 = /a=candidate:[^\r\n]*\s[23][0-9a-f]{0,3}:/i.test(localSdp)
        if (!hadInitialSdpV6 && !hadInitialNicV6) {
          resetLocalIpv6ProbeCache()
          const freshV6 = await probeLocalInterfaceIpv6()
          if (
            freshV6 &&
            isGlobalIpv6Address(freshV6) &&
            epoch === attemptEpoch &&
            !isDcOpen() &&
            !isVirtualDcOpen()
          ) {
            log.info(`[WebRTC Client] Late SLAAC GUA IPv6 (${freshV6}) became ready after Wi-Fi switch; restarting handshake to inject IPv6!`)
            void restartClientConnection(ctx.getClientForceRelay())
          }
        }
      }, 1800)

      if (!isTestEnv) {
        // 2. 给足零 TURN 原生双栈 (IPv6 + IPv4 srflx + 序列端口预测打洞) 3.8 秒黄金窗口；
        // 若移动端 VPN 彻底封死所有 IPv6/UDP 报文，在 3.8 秒时极速启用基于 WSS TLS 的 VirtualDataChannel，同时后台继续尝试静默升级原生 P2P
        virtualFallbackTimer = setTimeout(() => {
          virtualFallbackTimer = null
          if (epoch === attemptEpoch && dc.readyState !== 'open') {
            activateVirtualFallbackChannel(epoch, sessionId)
          }
        }, 3800)
      }
    }

    connectWatchdog = setTimeout(() => {
      connectWatchdog = null
      if (epoch !== attemptEpoch) return
      const currentDc = ctx.getClientDc()
      if (dc.readyState === 'open' || (currentDc && currentDc.readyState === 'open')) return
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

    const isTestEnv =
      (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
      Boolean((globalThis as any).__vitest_worker__) ||
      (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ !== undefined

    if (!isTestEnv || (globalThis as any).__TEST_ALLOW_DOH_WARMUP__) {
      void probeLocalInterfaceIpv6().catch(() => {})
      await waitForDoHStunIpv6Bounded(300)
      if (epoch !== attemptEpoch) return
    }

    const turnDisabledByUser =
      typeof localStorage !== 'undefined' && localStorage.getItem('sp27-disable-turn') === 'true'
    const allowTurn = !turnDisabledByUser && (shouldAllowTurnForAttempt(reconnectAttempts) || forceRelay)

    log.info(
      `Initiating setupClientConnection (sessionId: ${newClientSessionId}, epoch: ${epoch}, allowTurn: ${allowTurn}, icePolicy: ${forceRelay ? 'relay' : 'all'}, hostSenderId: ${ctx.getClientHostSenderId() || 'none'}, hostIpv6: ${lastHostIpv6 || 'unknown'})`
    )

    const pc = ctx.peerMgr.createPeerConnection(
      undefined,
      (reason?: string) => {
        if (isVirtualDcActiveOnClient()) {
          log.info(`Native PC reported ${reason}, but VirtualDataChannel is active and healthy; scheduling background native P2P retry.`)
          scheduleBackgroundNativeP2pRetry(epoch)
          return
        }
        failAttempt(epoch, reason || 'peer_failure')
      },
      forceRelay,
      ctx.getClientHostSenderId(),
      { sessionTag: newClientSessionId, holdLocalCandidates: true, allowTurn }
    )
    ctx.setClientPc(pc)

    const dc = pc.createDataChannel('scoutingpro-data')
    ctx.setClientDc(dc)

    const sender = new DataChannelSender(dc, (isCongested) => {
      if (isCongested) {
        log.info('DataChannel backpressure active; queuing outgoing chunks smoothly.')
      }
    })
    ctx.setClientSender(sender)

    dc.onmessage = (e) => ctx.handleChannelMessage(e)
    dc.onopen = () => {
      if (epoch !== attemptEpoch) return
      log.info(`Native DataChannel 'scoutingpro-data' OPENED! Client connected via direct WebRTC (epoch: ${epoch}).`)
      if (failedEpoch === epoch) failedEpoch = -1
      // 若此前已激活了虚拟通道，无缝热切换升级到原生 UDP DataChannel！
      if (getActiveVirtualDc()) {
        log.info('Hot-upgrading active session from VirtualDataChannel to Native UDP DataChannel!')
        closeActiveVirtualDc(true, true)
      }
      ctx.setClientDc(dc)
      ctx.setClientSender(sender)
      clearConnectWatchdog()
      clearReconnectTimer()
      reconnectAttempts = 0
      ctx.setStatus('connected')
      startDataChannelHeartbeat()
      void checkAndScheduleSilentUpgrade()
    }
    dc.onclose = () => {
      if (epoch !== attemptEpoch) return
      if (isVirtualDcActiveOnClient()) {
        return
      }
      log.warn(`DataChannel 'scoutingpro-data' CLOSED (epoch: ${epoch}, sasState: ${ctx.sas.clientSasState})`)
      stopDataChannelHeartbeat()
      resetSilentUpgradeState()
      const curSender = ctx.getClientSender?.()
      curSender?.abort('DataChannel closed')
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
        let ticketTimer: ReturnType<typeof setTimeout> | null = null
        try {
          const ticketRes = await Promise.race([
            createWebRtcTicket(currentInviteCode, localEcdhPubHex),
            new Promise<null>((resolve) => {
              ticketTimer = setTimeout(() => resolve(null), 1500)
            })
          ])
          if (ticketRes && ticketRes.ticket) {
            handshakeTicket = ticketRes.ticket
            log.info('Acquired scoped handshake ticket with pkHash binding.')
          }
        } catch (ticketErr) {
          log.warn('Failed to obtain handshake ticket:', ticketErr)
        } finally {
          if (ticketTimer) clearTimeout(ticketTimer)
        }
        if (epoch !== attemptEpoch) return
      }

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
        if (epoch !== attemptEpoch) return
      }

      const finalizedOfferSdp = await ctx.peerMgr.finalizeLocalSdp(
        pc,
        pc?.localDescription?.sdp || offer.sdp || ''
      )
      if (epoch !== attemptEpoch) return

      const rawOffer = {
        type: offer.type,
        // 读取 localDescription 以携带已收集到的公网 IPv6 与 VPN/STUN srflx 候选（与后续 trickle 候选互为冗余）
        sdp: finalizedOfferSdp,
        ticket: handshakeTicket,
        deviceId: localDeviceId,
        username: ctx.getUsername?.() || '',
        userId: ctx.getUserId?.() || '',
        allowTurn,
        forceRelay
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
        userId: ctx.getUserId?.() || '',
        allowTurn,
        forceRelay
      }, ctx.getClientHostSenderId())

      // Offer 已发出：放行暂存的本地候选（保证 Host 先建 PeerConnection 再收候选），并启动建联超时
      ctx.peerMgr.releaseLocalCandidates(pc)
      armConnectWatchdog(epoch, dc, newClientSessionId)
    } catch (err) {
      if (epoch !== attemptEpoch) {
        log.info('Offer creation aborted by a newer connection attempt.')
        return
      }
      log.error('Error creating offer:', err)
      failAttempt(epoch, 'offer_failed')
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
      if (data.hostIpv6 && isGlobalIpv6Address(data.hostIpv6)) {
        lastHostIpv6 = cleanIpAddress(data.hostIpv6)
      }
      if (data.hostSessionId && !ctx.getCurrentHostSessionId()) {
        ctx.setCurrentHostSessionId(data.hostSessionId)
      }
      if (data.sender && !ctx.getClientHostSenderId()) {
        ctx.setClientHostSenderId(data.sender)
      }
      if (data.ecdhPublicKey && !sas.clientSharedAesKey && localEcdhKeyPair) {
        try {
          const hostPub = await importEcdhPublicKey(data.ecdhPublicKey)
          sas.clientSharedAesKey = await deriveSharedAesKey(localEcdhKeyPair.privateKey, hostPub)
          await evaluateAndApplyClientTrust(ctx, data.ecdhPublicKey, data.deviceId, data.username, data.userId)
        } catch {}
      }
      // 若从机发出的首包 Offer 因订阅时序或无线丢包未被主机收到（卡在 have-local-offer 超过 3.5s），借主机心跳立即重发握手
      const curPc = ctx.getClientPc()
      const curDc = ctx.getClientDc()
      if (
        ctx.getStatus() === 'connecting' &&
        !activeSetupPromise &&
        (!curDc || curDc.readyState !== 'open') &&
        curPc &&
        curPc.signalingState === 'have-local-offer' &&
        lastOfferTimestamp > 0 &&
        Date.now() - lastOfferTimestamp >= 3500
      ) {
        log.info('Host heartbeat received while Offer has been unacknowledged for >3.5s; re-initiating handshake immediately.')
        void restartClientConnection(ctx.getClientForceRelay())
        return
      }
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
          await evaluateAndApplyClientTrust(ctx, data.ecdhPublicKey, data.deviceId, data.username, data.userId)
        } catch (e) {
          log.warn('Failed to derive shared AES key or evaluate trust from host_hello:', e)
        }
      }
      ctx.setClientHostSenderId(data.sender)

      const curPc = ctx.getClientPc()
      const curDc = ctx.getClientDc()
      const isAlreadyConnected = Boolean(
        curDc &&
        curDc.readyState === 'open' &&
        ((curDc as any)?.isVirtual || (curPc && curPc.connectionState === 'connected'))
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
        if (data.hostIpv6 && isGlobalIpv6Address(data.hostIpv6)) {
          lastHostIpv6 = cleanIpAddress(data.hostIpv6)
        }

        if (data.ecdhPublicKey && !sas.clientSharedAesKey && localEcdhKeyPair) {
          try {
            const hostPub = await importEcdhPublicKey(data.ecdhPublicKey)
            sas.clientSharedAesKey = await deriveSharedAesKey(localEcdhKeyPair.privateKey, hostPub)
          } catch {}
        }
        if (data.ecdhPublicKey) {
          await evaluateAndApplyClientTrust(ctx, data.ecdhPublicKey, data.deviceId, data.username, data.userId)
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

        // 若 Host Answer SDP 内已内嵌了 srflx 候选，合成紧邻端口预测候选以穿透电脑 TUN / 移动对称 CGNAT
        if (answerData?.sdp && typeof answerData.sdp === 'string') {
          for (const line of answerData.sdp.split(/\r?\n/)) {
            if (line.startsWith('a=candidate:') && /\btyp\s+srflx\b/i.test(line)) {
              const predictedList = synthesizeSymmetricNatPortCandidates(line.slice(2))
              for (const predCandStr of predictedList) {
                try {
                  await clientPc.addIceCandidate(
                    toIceCandidate({ candidate: predCandStr, sdpMid: '0', sdpMLineIndex: 0 })
                  )
                } catch {}
              }
            }
          }
        }

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
              if (isBogusOrTunCandidate(candidateObj.candidate, true)) {
                continue
              }
              candidateObj.candidate = optimizeCandidatePriority(candidateObj.candidate)
              log.info(`Remote ICE Candidate (pending) added from Host: ${candidateObj.candidate.trim()}`)
            }
            await clientPc.addIceCandidate(toIceCandidate(candidateObj))
            if (candidateObj?.candidate) {
              const predictedList = synthesizeSymmetricNatPortCandidates(candidateObj.candidate)
              for (const predCandStr of predictedList) {
                try {
                  await clientPc.addIceCandidate(
                    toIceCandidate({
                      ...candidateObj,
                      candidate: predCandStr
                    })
                  )
                } catch {}
              }
            }
          } catch (candidateErr) {
            log.warn('Failed to add pending candidate:', candidateErr)
          }
        }
      } catch (err) {
        log.error('Error processing Host Answer:', err)
      }
      return
    }

    if (data.encrypted) {
      await handleIncomingEncryptedVirtualFrame(data.encrypted)
      return
    }

    if (data.candidate) {
      const clientPc = ctx.getClientPc()
      if (!clientPc) return
      const currentSessionId = ctx.getClientSessionId()
      if (data.clientSessionId && currentSessionId && data.clientSessionId !== currentSessionId) {
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
        // 传入 true 确保电脑端开启 TUN 时发来的合法公网 srflx 绝不被误判丢弃
        if (isBogusOrTunCandidate(candidateData.candidate, true)) {
          log.info('Dropped remote bogus/TUN poison candidate on Client:', candidateData.candidate)
          return
        }
        candidateData.candidate = optimizeCandidatePriority(candidateData.candidate)
      }

      if (ctx.getClientPc() !== clientPc) return
      try {
        if (candidateData?.candidate) {
          log.info(`Remote ICE Candidate added from Host: ${String(candidateData.candidate).trim()}`)
        }
        await clientPc.addIceCandidate(toIceCandidate(candidateData))
        if (candidateData?.candidate) {
          const predictedList = synthesizeSymmetricNatPortCandidates(candidateData.candidate)
          for (const predCandStr of predictedList) {
            try {
              await clientPc.addIceCandidate(
                toIceCandidate({
                  ...candidateData,
                  candidate: predCandStr
                })
              )
            } catch {}
          }
        }
      } catch (addErr) {
        if (!clientPc.remoteDescription) {
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

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      if (ctx.isHostMode?.() || ctx.isExplicitlyClosed()) return
      log.info('[WebRTC Client] Network online detected; re-evaluating silent upgrade')
      silentUpgradeProbeCount = 0
      void checkAndScheduleSilentUpgrade(true)
    })
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
    hardResetChannels,
    checkAndScheduleSilentUpgrade,
    clearSilentUpgradeTimers
  }
}
