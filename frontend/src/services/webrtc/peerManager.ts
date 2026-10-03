import type { ConnectionTransportInfo, ConnectionStatus } from '@/types'
import { encryptSignalingData } from '@/utils/crypto'
import {
  buildIceConfiguration,
  optimizeCandidatePriority,
  classifyCandidatePair,
  CONNECTION_TIMING
} from './connectivity'
import type { SignalingChannel } from './signaling'
import type { WebRtcCallbacks } from './types'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:Peer')

export interface PeerConnectionFactoryOptions {
  getSignaling: () => SignalingChannel | null
  isHostMode: () => boolean
  callbacks: WebRtcCallbacks & {
    onIceStalled?: (isStalled: boolean) => void
    onTransportSelected?: (info: ConnectionTransportInfo) => void
  }
  setStatus: (s: ConnectionStatus) => void
  onHostDisconnected?: () => void
  getClientSharedAesKey: () => CryptoKey | null
  getClientSharedKey: (senderId: string) => CryptoKey | null
  getClientFingerprint: (senderId?: string) => string | undefined
  getClientSecurityFingerprint: () => string
  /** 动态解析 Client 侧候选的发送目标（Host 的信令 clientId），避免捕获建连瞬间的旧值 */
  getClientHostSenderId?: () => string | undefined
  /** Host 侧：某个 Client 的 PeerConnection 已终止。附带 peer 用于身份校验，防止误删已被替换的新连接 */
  onHostClientClosed?: (targetSender: string, peer?: RTCPeerConnection) => void
  updateHostStatus?: () => void
  getClientDcState?: () => RTCDataChannelState | undefined
  isExplicitlyClosed?: () => boolean
}

/**
 * 创建 PeerConnection 的附加参数
 */
export interface CreatePeerConnectionExtras {
  /**
   * 会话标签（= clientSessionId）。随每个本地候选一起发送，对端据此丢弃过期会话的候选，
   * 杜绝“旧会话候选被注入新连接 / 新会话候选被挂到旧连接”导致的打洞失败。
   */
  sessionTag?: string
  /**
   * 是否在 Offer 发出前暂存本地候选。Client 必须开启：Offer 需等待 ticket 请求，
   * 若候选先于 Offer 到达 Host，会被挂到 Host 侧仍存在的旧 PeerConnection 上而丢失。
   */
  holdLocalCandidates?: boolean
}

interface CandidateGate {
  open: boolean
  queue: RTCIceCandidateInit[]
  release: () => void
}

export class PeerConnectionManager {
  private options: PeerConnectionFactoryOptions
  currentTransportInfo: ConnectionTransportInfo | null = null
  private readonly candidateGates = new WeakMap<RTCPeerConnection, CandidateGate>()

  constructor(options: PeerConnectionFactoryOptions) {
    this.options = options
  }

  async updateTransportInfo(peer: RTCPeerConnection, targetSender?: string): Promise<void> {
    try {
      if (typeof peer.getStats !== 'function') return
      const stats = await peer.getStats()
      let activePair: any = null

      // 1. 尝试直接从 transport report 读取 selectedCandidatePairId
      let selectedPairId: string | null = null
      stats.forEach((report: any) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId
        }
      })

      // 2. 综合评估所有 candidate-pair，结合 selected、nominated、bytesSent/Received 与链路类型评分选优
      let bestPair: any = null
      let bestScore = -1
      stats.forEach((report: any) => {
        if (report.type === 'candidate-pair') {
          const local = stats.get(report.localCandidateId) as any
          const remote = stats.get(report.remoteCandidateId) as any
          const localIp = local?.address || local?.ip || ''
          const remoteIp = remote?.address || remote?.ip || ''
          const localType = (local?.candidateType || '').toLowerCase()
          const remoteType = (remote?.candidateType || '').toLowerCase()
          const totalBytes = (report.bytesSent || 0) + (report.bytesReceived || 0)

          let score = 0
          if (report.id === selectedPairId) score += 100000
          if (report.selected === true) score += 100000
          if (report.nominated === true) score += 50000
          if (report.state === 'succeeded') score += 20000
          if (totalBytes > 0) score += 10000 + Math.min(totalBytes, 5000)

          // 链路类型客观打分：IPv6直连 > 局域网直连 > 公网NAT直连 > Relay中继
          const tType = classifyCandidatePair(localType, remoteType, localIp, remoteIp)
          if (tType === 'ipv6_p2p') score += 400
          else if (tType === 'lan_p2p') score += 300
          else if (tType === 'nat_p2p') score += 200
          else if (tType === 'relay') score += 100

          if (score > bestScore) {
            bestScore = score
            bestPair = report
          }
        }
      })

      activePair = bestPair || (selectedPairId && stats.has(selectedPairId) ? stats.get(selectedPairId) : null)
      if (activePair) {
        const local = stats.get(activePair.localCandidateId) as any
        const remote = stats.get(activePair.remoteCandidateId) as any
        const localType = (local?.candidateType || '').toLowerCase()
        const remoteType = (remote?.candidateType || '').toLowerCase()
        const localIp = local?.address || local?.ip || ''
        const remoteIp = remote?.address || remote?.ip || ''
        const protocol = (local?.protocol || activePair.protocol || 'udp').toUpperCase()
        const rttMs =
          typeof activePair.currentRoundTripTime === 'number'
            ? Math.round(activePair.currentRoundTripTime * 1000)
            : typeof activePair.totalRoundTripTime === 'number' && activePair.responsesReceived
            ? Math.round((activePair.totalRoundTripTime / activePair.responsesReceived) * 1000)
            : null

        const transportType = classifyCandidatePair(localType, remoteType, localIp, remoteIp)
        const fingerprint = this.options.isHostMode()
          ? this.options.getClientFingerprint(targetSender)
          : this.options.getClientSecurityFingerprint()

        const info: ConnectionTransportInfo = {
          type: transportType,
          localCandidateType: localType || 'unknown',
          remoteCandidateType: remoteType || 'unknown',
          localAddress: localIp || 'unknown',
          remoteAddress: remoteIp || 'unknown',
          protocol,
          rttMs,
          securityFingerprint: fingerprint || undefined,
          selectedCandidatePair: `${localIp || 'unknown'} (${localType || 'unknown'}) <-> ${remoteIp || 'unknown'} (${remoteType || 'unknown'}) [${protocol}]`
        }
        this.currentTransportInfo = info
        log.info(
          `Active Transport: ${info.type} (${info.protocol}, RTT: ${info.rttMs}ms, SAS: ${info.securityFingerprint}) ${info.localAddress}(${info.localCandidateType}) <-> ${info.remoteAddress}(${info.remoteCandidateType})`,
          info
        )
        this.options.callbacks.onTransportInfoChanged?.(info)
      }
    } catch (e) {
      log.warn('Failed to inspect stats for transport info:', e)
    }
  }

  resetTransportInfo(): void {
    this.currentTransportInfo = null
    this.options.callbacks.onTransportInfoChanged?.({
      type: 'unknown',
      localCandidateType: '',
      remoteCandidateType: '',
      localAddress: '',
      remoteAddress: '',
      protocol: '',
      rttMs: null
    })
  }

  /**
   * 放行此前暂存的本地候选（Client 在 Offer 发出后调用），保证对端收到的顺序为 Offer → Candidates。
   */
  releaseLocalCandidates(peer: RTCPeerConnection | null | undefined): void {
    if (!peer) return
    this.candidateGates.get(peer)?.release()
  }

  /**
   * 创建 PeerConnection（单一配置、并行打洞）。
   * 设计约束（防止逻辑自锁）：
   * 1. 不再存在“免 STUN 直连 → 超时拆除 → STUN 重建”的串行升级链；IPv6 / LAN / IPv4 NAT / TURN 在同一个 ICE 会话内并行检查。
   * 2. PeerConnection 层不做 restartIce、不做 relay 重建、不发送任何重连指令；只负责“一次性”上报失败。
   *    重试与升级策略由 Client 会话层（唯一决策者）统一调度。
   * 3. Host 侧对从未连通的连接执行兜底回收，时限（HOST_PENDING_GC_MS）严格大于 Client 建联超时，避免双方抢拆。
   */
  createPeerConnection(
    targetSender?: string,
    onDisconnect?: (reason?: string) => void,
    forceRelay = false,
    clientHostSenderId?: string,
    extras: CreatePeerConnectionExtras = {}
  ): RTCPeerConnection {
    const isHost = this.options.isHostMode()
    const callbacks = this.options.callbacks
    const sessionTag = extras.sessionTag
    const config = buildIceConfiguration(forceRelay)
    log.info(
      `Creating RTCPeerConnection (isHost: ${isHost}, targetSender: ${targetSender || 'default'}, forceRelay: ${forceRelay}, icePolicy: ${config.iceTransportPolicy}, sessionTag: ${sessionTag || 'none'})`
    )
    const peer = new RTCPeerConnection(config)

    // ---------------- 本地候选发送（顺序化 + 会话标签 + 可选暂存闸门） ----------------
    let sendChain: Promise<void> = Promise.resolve()
    const sendLocalCandidate = (candObj: RTCIceCandidateInit) => {
      sendChain = sendChain
        .then(async () => {
          const sharedKey = isHost ? this.options.getClientSharedKey(targetSender || '') : this.options.getClientSharedAesKey()
          let candPayload: any = candObj
          if (sharedKey) {
            try {
              candPayload = await encryptSignalingData(sharedKey, JSON.stringify(candObj))
            } catch {}
          }
          const signaling = this.options.getSignaling()
          if (signaling) {
            const target = isHost
              ? targetSender
              : this.options.getClientHostSenderId?.() || clientHostSenderId || targetSender || undefined
            const envelope: Record<string, unknown> = { candidate: candPayload }
            if (sessionTag) envelope.clientSessionId = sessionTag
            signaling.send(envelope, target)
          }
        })
        .catch((err) => {
          log.warn('Failed to send local ICE candidate:', err)
        })
    }

    const gate: CandidateGate = {
      open: !extras.holdLocalCandidates,
      queue: [],
      release: () => {
        if (gate.open) return
        gate.open = true
        const queued = gate.queue.splice(0)
        if (queued.length > 0) {
          log.info(`Releasing ${queued.length} held local ICE candidates after offer dispatch (target: ${targetSender || 'host'})`)
        }
        for (const c of queued) sendLocalCandidate(c)
      }
    }
    this.candidateGates.set(peer, gate)

    peer.onicecandidate = (ev) => {
      if (ev.candidate) {
        const candObj: RTCIceCandidateInit = ev.candidate.toJSON
          ? ev.candidate.toJSON()
          : {
              candidate: ev.candidate.candidate,
              sdpMid: ev.candidate.sdpMid,
              sdpMLineIndex: ev.candidate.sdpMLineIndex,
              usernameFragment: ev.candidate.usernameFragment
            }
        if (candObj.candidate) {
          candObj.candidate = optimizeCandidatePriority(candObj.candidate)
        }
        log.info(
          `Local ICE Candidate generated: ${candObj.candidate ? candObj.candidate.trim() : 'null'} (target: ${targetSender || 'host'}, held: ${!gate.open})`
        )
        if (gate.open) {
          sendLocalCandidate(candObj)
        } else {
          gate.queue.push(candObj)
        }
      } else {
        log.info(`ICE Gathering Complete (null candidate received)`)
      }
    }

    // ---------------- 生命周期与计时器 ----------------
    const createTime = Date.now()
    let hasConnected = false
    let failureReported = false
    let stallNoticeTimer: ReturnType<typeof setTimeout> | null = null
    let disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null
    let hostPendingGcTimer: ReturnType<typeof setTimeout> | null = null

    const clearTimers = () => {
      if (stallNoticeTimer) {
        clearTimeout(stallNoticeTimer)
        stallNoticeTimer = null
      }
      if (disconnectGraceTimer) {
        clearTimeout(disconnectGraceTimer)
        disconnectGraceTimer = null
      }
      if (hostPendingGcTimer) {
        clearTimeout(hostPendingGcTimer)
        hostPendingGcTimer = null
      }
    }

    const origClose = peer.close.bind(peer)
    peer.close = () => {
      clearTimers()
      gate.open = true
      gate.queue.length = 0
      try {
        peer.onicecandidate = null
        peer.oniceconnectionstatechange = null
        peer.onconnectionstatechange = null
        peer.ondatachannel = () => {}
      } catch {}
      origClose()
    }

    /**
     * 一次性失败上报：同一个 PeerConnection 无论经由 connectionState / iceConnectionState / 计时器
     * 哪条路径判定失败，都只会触发一次后续动作，杜绝重复重连风暴。
     */
    const reportFailure = (reason: string) => {
      if (failureReported) return
      failureReported = true
      clearTimers()
      log.warn(`PeerConnection failure reported (reason: ${reason}, target: ${targetSender || 'host'}, connectedBefore: ${hasConnected})`)
      if (isHost) {
        try { peer.close() } catch {}
        if (targetSender) {
          this.options.onHostClientClosed?.(targetSender, peer)
        }
        if (onDisconnect) onDisconnect(reason)
        this.options.updateHostStatus?.()
      } else {
        this.options.setStatus('unstable')
        if (onDisconnect) {
          onDisconnect(reason)
        } else {
          this.options.setStatus('offline')
        }
      }
    }

    if (isHost) {
      // Host 兜底回收：从未连通的 PeerConnection 在 HOST_PENDING_GC_MS 后释放（Client 早已在 15s 时自行重建）
      hostPendingGcTimer = setTimeout(() => {
        hostPendingGcTimer = null
        if (!hasConnected && peer.connectionState !== 'connected') {
          reportFailure('host_handshake_gc')
        }
      }, CONNECTION_TIMING.HOST_PENDING_GC_MS)
    }

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState
      log.info(`PeerConnection state changed: ${state} (targetSender: ${targetSender || 'host'})`)

      if (state === 'connected') {
        hasConnected = true
        if (disconnectGraceTimer) {
          clearTimeout(disconnectGraceTimer)
          disconnectGraceTimer = null
        }
        if (hostPendingGcTimer) {
          clearTimeout(hostPendingGcTimer)
          hostPendingGcTimer = null
        }
        log.info(`[WebRTC Metric] Successfully connected in ${Date.now() - createTime}ms (policy: ${config.iceTransportPolicy})`)
      }

      if (isHost) {
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          reportFailure(`connection_${state}`)
          return
        }
        this.options.updateHostStatus?.()
        return
      }

      switch (state) {
        case 'connected':
          if (this.options.getClientDcState?.() === 'open') {
            this.options.setStatus('connected')
          }
          break
        case 'disconnected':
          // 给 ICE 一个短暂自愈窗口（如 Wi-Fi 漫游），超时仍未恢复再判定失败
          this.options.setStatus('unstable')
          if (!disconnectGraceTimer) {
            disconnectGraceTimer = setTimeout(() => {
              disconnectGraceTimer = null
              if (peer.connectionState !== 'connected') {
                reportFailure('connection_disconnected')
              }
            }, CONNECTION_TIMING.CLIENT_DISCONNECT_GRACE_MS)
          }
          break
        case 'failed':
          reportFailure('connection_failed')
          break
        case 'closed':
          if (this.options.isExplicitlyClosed?.()) {
            this.options.setStatus('offline')
          } else {
            reportFailure('connection_closed')
          }
          break
        default:
          this.options.setStatus('connecting')
      }
    }

    peer.oniceconnectionstatechange = () => {
      const iceState = peer.iceConnectionState
      log.info(`ICE Connection state changed: ${iceState} (targetSender: ${targetSender || 'host'})`)

      if (iceState === 'checking') {
        // 仅做 UI 提示：ICE 检查在 IPv6 黑洞 / UDP 丢弃时可能较慢，但绝不在此拆除连接
        if (!stallNoticeTimer) {
          stallNoticeTimer = setTimeout(() => {
            stallNoticeTimer = null
            if (peer.iceConnectionState === 'checking') {
              log.warn(`[Watchdog] ICE check taking longer than ${CONNECTION_TIMING.ICE_STALL_NOTICE_MS}ms (possible IPv6 blackhole / middlebox UDP drop). Waiting for parallel srflx/relay pairs.`)
              callbacks.onIceStalled?.(true)
            }
          }, CONNECTION_TIMING.ICE_STALL_NOTICE_MS)
        }
        return
      }

      if (stallNoticeTimer) {
        clearTimeout(stallNoticeTimer)
        stallNoticeTimer = null
      }

      if (iceState === 'connected' || iceState === 'completed') {
        callbacks.onIceStalled?.(false)
        if (isHost) {
          this.options.updateHostStatus?.()
        } else if (this.options.getClientDcState?.() === 'open') {
          this.options.setStatus('connected')
        }
        this.updateTransportInfo(peer, targetSender)
        setTimeout(() => this.updateTransportInfo(peer, targetSender), 1200)
        setTimeout(() => this.updateTransportInfo(peer, targetSender), 3000)
      } else if (iceState === 'disconnected') {
        callbacks.onIceStalled?.(false)
        this.options.setStatus('unstable')
      } else if (iceState === 'failed') {
        callbacks.onIceStalled?.(false)
        reportFailure('ice_failed')
      }
    }

    peer.onicegatheringstatechange = () => {
      log.info(`ICE Gathering state: ${peer.iceGatheringState} (targetSender: ${targetSender || 'host'})`)
    }

    return peer
  }
}
