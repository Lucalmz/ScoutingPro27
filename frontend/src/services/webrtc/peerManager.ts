import type { ConnectionTransportInfo, ConnectionStatus } from '@/types'
import { encryptSignalingData } from '@/utils/crypto'
import {
  buildIceConfiguration,
  optimizeCandidatePriority,
  optimizeSdpCandidates,
  applyProxyExitDemotionToBatch,
  demoteProxyExitCandidatePriority,
  classifyStunUrlOrigin,
  type TaggedIceCandidateItem,
  classifyCandidatePair,
  isBogusOrTunCandidate,
  isTunReflectedSrflxCandidate,
  isTunVirtualAddress,
  cleanIpAddress,
  isGlobalIpv6Address,
  getCachedPhysicalAddresses,
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
  /**
   * 是否允许在 ICE 配置中携带 TURN。默认 false（纯 STUN / 纯 P2P，绝不产生 relay 候选）；
   * 仅当多次重试确认无法直连时由 Client 会话层置 true，Host 依据 Offer 中的 allowTurn 对称配置。
   */
  allowTurn?: boolean
}

interface CandidateGate {
  open: boolean
  queue: TaggedIceCandidateItem[]
  release: () => void
}

/** 本地候选的来源元数据（采集它的 STUN URL 与清洗前的原始 raddr/rport/network-id） */
interface CandidateOriginMeta {
  stunUrl?: string
  rawRaddr?: string
  rawRport?: string
  rawNetId?: string
}

/**
 * 候选唯一键：地址:端口:类型（与 libwebrtc 远端去重口径一致——同一地址端口的重复候选只有第一次生效）
 */
function candidateKeyOf(candidateStr: string | undefined | null): string {
  if (!candidateStr) return ''
  const trimmed = candidateStr.trim()
  const withoutAttr = trimmed.startsWith('a=') ? trimmed.slice(2).trim() : trimmed
  const cleanStr = withoutAttr.startsWith('candidate:') ? withoutAttr.slice('candidate:'.length).trim() : withoutAttr
  const parts = cleanStr.split(/\s+/)
  if (parts.length < 7) return ''
  const addr = cleanIpAddress(parts[4] || '').toLowerCase()
  const port = parts[5] || ''
  const typIdx = parts.indexOf('typ')
  const typ = typIdx !== -1 && parts[typIdx + 1] ? parts[typIdx + 1]!.toLowerCase() : ''
  if (!addr || !port || !typ) return ''
  return `${addr}:${port}:${typ}`
}

export class PeerConnectionManager {
  private options: PeerConnectionFactoryOptions
  currentTransportInfo: ConnectionTransportInfo | null = null
  tunEnvironmentDetected = false
  private readonly candidateGates = new WeakMap<RTCPeerConnection, CandidateGate>()
  private readonly silentUpgradePeers = new WeakSet<RTCPeerConnection>()
  private readonly virtualFallbackPeers = new WeakSet<RTCPeerConnection>()
  private readonly candidateOrigins = new WeakMap<RTCPeerConnection, Map<string, CandidateOriginMeta>>()

  constructor(options: PeerConnectionFactoryOptions) {
    this.options = options
  }

  /**
   * 标记某条原生 PeerConnection 已由 ECDH 加密 VirtualDataChannel 兜底接管：
   * 若后台原生 PC 随后打洞成功（connected），仍允许触发热升级；
   * 若后台原生 PC 超时失败（disconnected / failed / closed / GC），静默回收底层废套接字，绝不中断当前会话。
   */
  markVirtualChannelActive(peer: RTCPeerConnection | null | undefined): void {
    if (peer) {
      this.virtualFallbackPeers.add(peer)
      this.options.callbacks.onIceStalled?.(false)
    }
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

  private ensureOriginMeta(peer: RTCPeerConnection): Map<string, CandidateOriginMeta> {
    let meta = this.candidateOrigins.get(peer)
    if (!meta) {
      meta = new Map<string, CandidateOriginMeta>()
      this.candidateOrigins.set(peer, meta)
    }
    return meta
  }

  /** 用已记录的来源元数据（含 getStats 回填）补全候选条目缺失的 stunUrl / raddr 等字段 */
  private withOriginMeta(peer: RTCPeerConnection, item: TaggedIceCandidateItem): TaggedIceCandidateItem {
    const meta = this.candidateOrigins.get(peer)?.get(candidateKeyOf(item.candObj.candidate))
    if (!meta) return item
    return {
      candObj: item.candObj,
      stunUrl: item.stunUrl || meta.stunUrl,
      rawRaddr: item.rawRaddr || meta.rawRaddr,
      rawRport: item.rawRport || meta.rawRport,
      rawNetId: item.rawNetId || meta.rawNetId
    }
  }

  /** 同地址族下是否已有国内来源的 srflx，且其反射地址与 addr 不同（即 addr 为分流代理出口） */
  private isProxyExitAgainstKnownDomestic(meta: Map<string, CandidateOriginMeta>, addr: string): boolean {
    const target = cleanIpAddress(addr).toLowerCase()
    const isV6 = target.includes(':')
    let hasDomestic = false
    for (const [key, m] of meta) {
      if (!key.endsWith(':srflx')) continue
      if (classifyStunUrlOrigin(m.stunUrl) !== 'domestic') continue
      const domAddr = key.slice(0, key.lastIndexOf(':', key.length - ':srflx'.length - 1))
      if (domAddr.includes(':') !== isV6) continue
      if (domAddr === target) return false
      hasDomestic = true
    }
    return hasDomestic
  }

  /**
   * 回退通道：浏览器未在 RTCIceCandidate 上暴露 url 时（Chrome < 123 / 部分 WebKit），
   * 从 getStats() 的 local-candidate.url 回填 srflx 候选来源（libwebrtc rtc_stats_collector 对本地候选填充 url）。
   */
  private async refreshCandidateOriginsFromStats(peer: RTCPeerConnection): Promise<void> {
    if (typeof (peer as any).getStats !== 'function') return
    const meta = this.ensureOriginMeta(peer)
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const stats: any = await Promise.race([
        peer.getStats(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 150)
        })
      ])
      if (!stats || typeof stats.forEach !== 'function') return
      stats.forEach((r: any) => {
        if (r?.type !== 'local-candidate' || (r.candidateType || '').toLowerCase() !== 'srflx' || !r.url) return
        const addr = cleanIpAddress(r.address || r.ip || '').toLowerCase()
        if (!addr || r.port === undefined || r.port === null) return
        const key = `${addr}:${r.port}:srflx`
        const prev = meta.get(key)
        meta.set(key, {
          stunUrl: prev?.stunUrl || String(r.url),
          rawRaddr: prev?.rawRaddr || (r.relatedAddress ? cleanIpAddress(String(r.relatedAddress)) : undefined),
          rawRport: prev?.rawRport || (r.relatedPort !== undefined && r.relatedPort !== null ? String(r.relatedPort) : undefined),
          rawNetId: prev?.rawNetId
        })
      })
    } catch {
      // getStats 失败不影响建连，保持原优先级
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 生成随 Offer/Answer 一并发送的本地 SDP：在 optimizeSdpCandidates 的基础上，对内嵌的 srflx 候选执行分流代理出口降权。
   * 必须在 SDP 层降权的原因（libwebrtc p2p_transport_channel.cc）：远端收到与已有连接同地址的候选时
   * （GetConnection(remote_candidate.address()) 命中且 generation 未提升）不会新建连接，也不会更新已有远端候选的优先级，
   * 只记录 "Attempt to change a remote candidate" 日志；因此 SDP 内嵌候选的优先级“先到先得”，事后 trickle 的降权版本无效。
   */
  async finalizeLocalSdp(peer: RTCPeerConnection | null | undefined, sdp: string): Promise<string> {
    const optimized = optimizeSdpCandidates(sdp, true)
    if (!peer || !optimized) return optimized
    const meta = this.ensureOriginMeta(peer)
    const lines = optimized.split(/\r\n|\n/)
    const candIdx: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith('a=candidate:')) candIdx.push(i)
    }
    if (candIdx.length === 0) return optimized

    const missingSrflxOrigin = candIdx.some((i) => {
      const key = candidateKeyOf(lines[i])
      return key.endsWith(':srflx') && !meta.get(key)?.stunUrl
    })
    if (missingSrflxOrigin) {
      await this.refreshCandidateOriginsFromStats(peer)
    }

    const items: TaggedIceCandidateItem[] = candIdx.map((i) =>
      this.withOriginMeta(peer, { candObj: { candidate: lines[i]!.slice(2) } })
    )
    const evaluated = applyProxyExitDemotionToBatch(items)
    let demoted = 0
    candIdx.forEach((lineIdx, k) => {
      const next = evaluated[k]?.candidate
      if (next && next !== items[k]!.candObj.candidate) {
        demoted++
        lines[lineIdx] = `a=${next}`
      }
    })
    if (demoted > 0) {
      log.info(`Demoted ${demoted} split-tunnel proxy-exit srflx candidate(s) embedded in local SDP`)
    }
    return lines.join('\r\n')
  }

  /**
   * 重新关闭候选闸门（ICE restart 的 Offer 发出前调用）：restart 会产生带新 ufrag 的候选，
   * 若先于 Offer 抵达对端会因 ufrag 未知而被丢弃，因此与首次握手一样必须保证 Offer → Candidates 的顺序。
   */
  holdLocalCandidates(peer: RTCPeerConnection | null | undefined): void {
    if (!peer) return
    const gate = this.candidateGates.get(peer)
    if (gate) gate.open = false
  }

  /**
   * 标记该 PeerConnection 正在进行“静默升级”（in-place ICE restart）。
   * 静默期内：ICE restart 引起的 connectionState=connecting / iceConnectionState=checking 抖动
   * 不会把 UI 状态翻成 connecting，也不会触发 ICE 停滞提示；真正的 disconnected / failed 仍照常上报。
   */
  beginSilentUpgrade(peer: RTCPeerConnection | null | undefined): void {
    if (peer) this.silentUpgradePeers.add(peer)
  }

  endSilentUpgrade(peer: RTCPeerConnection | null | undefined): void {
    if (peer) this.silentUpgradePeers.delete(peer)
  }

  isSilentUpgrade(peer: RTCPeerConnection | null | undefined): boolean {
    return Boolean(peer && this.silentUpgradePeers.has(peer))
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
    const allowTurn = Boolean(extras.allowTurn) || forceRelay
    const config = buildIceConfiguration(allowTurn, forceRelay)
    const hasTurn = (config.iceServers || []).some((s) =>
      (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(u))
    )
    log.info(
      `Creating RTCPeerConnection (isHost: ${isHost}, targetSender: ${targetSender || 'default'}, allowTurn: ${allowTurn}, turnConfigured: ${hasTurn}, forceRelay: ${forceRelay}, icePolicy: ${config.iceTransportPolicy}, sessionTag: ${sessionTag || 'none'})`
    )
    const peer = new RTCPeerConnection(config)
    const emittedCandidateKeys = new Set<string>()
    const originMeta = this.ensureOriginMeta(peer)

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
        const queuedItems = gate.queue.splice(0).map((it) => this.withOriginMeta(peer, it))
        // 先基于来源 (RTCIceCandidate.url / getStats local-candidate.url) 识别分流代理出口 srflx 候选并降权（直连优先、VPN 出口兜底）
        const evaluated = applyProxyExitDemotionToBatch(queuedItems)
        // 将全球公网单播 IPv6 (2000::/3) UDP 候选排在最前发送，避免 tcp 端口 9 (tcptype active) 抢占前排
        evaluated.sort((a, b) => {
          const score = (c: RTCIceCandidateInit): number => {
            const s = c.candidate || ''
            if (s.includes('tcptype active') || s.includes(' tcp ')) return 5
            const parts = s.trim().split(/\s+/)
            const addr = cleanIpAddress(parts[4] || '')
            const typIdx = parts.indexOf('typ')
            const typ = typIdx !== -1 ? parts[typIdx + 1] : ''
            if (typ === 'host' && isGlobalIpv6Address(addr)) return 0
            if (typ === 'srflx' && isGlobalIpv6Address(addr)) return 1
            if (typ === 'host') return 2
            if (typ === 'srflx') return 3
            return 4
          }
          return score(a) - score(b)
        })
        if (evaluated.length > 0) {
          log.info(`Releasing ${evaluated.length} held local ICE candidates after offer dispatch (target: ${targetSender || 'host'})`)
        }
        for (const c of evaluated) sendLocalCandidate(c)
      }
    }
    this.candidateGates.set(peer, gate)

    const dispatchOrQueueCandidate = (item: TaggedIceCandidateItem) => {
      const candObj = item.candObj
      const cStr = candObj.candidate || ''
      let cAddr = ''
      let cType = ''
      if (cStr) {
        const p = cStr.trim().split(/\s+/)
        cAddr = cleanIpAddress(p[4] || '')
        const cPort = p[5] || ''
        const tIdx = p.indexOf('typ')
        cType = tIdx !== -1 && p[tIdx + 1] ? p[tIdx + 1]!.toLowerCase() : ''
        const dedupKey = `${cAddr}:${cPort}:${cType}`
        if (emittedCandidateKeys.has(dedupKey)) return
        emittedCandidateKeys.add(dedupKey)
      }

      if (gate.open && cType === 'srflx' && cAddr && candObj.candidate) {
        // 闸门已打开后才到达的 srflx：与已知的国内来源反射地址比对，命中分流代理出口则降权后再发送
        const tagged = this.withOriginMeta(peer, item)
        if (
          classifyStunUrlOrigin(tagged.stunUrl) === 'overseas' &&
          this.isProxyExitAgainstKnownDomestic(originMeta, cAddr)
        ) {
          candObj.candidate = demoteProxyExitCandidatePriority(candObj.candidate)
        }
      }

      log.info(
        `Local ICE Candidate generated${item.stunUrl ? ` [via ${item.stunUrl}]` : ''}: ${candObj.candidate ? candObj.candidate.trim() : 'null'} (target: ${targetSender || 'host'}, held: ${!gate.open})`
      )
      if (gate.open) {
        sendLocalCandidate(candObj)
      } else {
        gate.queue.push(item)
      }
    }

    let localIpv6Generated = false
    let hostIpv6MissingWarned = false

    // 仅诊断：Host 物理网卡有公网 IPv6 但 Chromium 未采集到 IPv6 候选（通常是 TUN 代理接管了 IPv6 路由）。
    // 绝不修改系统路由/网卡参数——那会破坏用户的 TUN 代理（历史教训）。
    const warnIfHostIpv6Missing = () => {
      if (!isHost || localIpv6Generated || hostIpv6MissingWarned) return
      const physV6s = getCachedPhysicalAddresses().ipv6s
      if (physV6s.length > 0) {
        hostIpv6MissingWarned = true
        log.warn(
          `[Diagnostic] Host physical NIC has GUA IPv6 (${physV6s.join(', ')}), but Chromium gathered 0 IPv6 candidates. A TUN proxy is likely capturing IPv6 routes; consider excluding 2000::/3 in the proxy's route-exclude-address. Falling back to IPv4 paths.`
        )
      }
    }

    peer.onicecandidate = (ev) => {
      if (ev.candidate) {
        const rawCandStr = ev.candidate.candidate || ''
        let rawRaddr = ''
        let rawRport = ''
        let rawNetId = ''
        if (rawCandStr) {
          const parts = rawCandStr.trim().split(/\s+/)
          const addr = cleanIpAddress(parts[4] || '')
          const raddrIdx = parts.indexOf('raddr')
          rawRaddr = raddrIdx !== -1 && parts[raddrIdx + 1] ? cleanIpAddress(parts[raddrIdx + 1] || '') : ''
          const rportIdx = parts.indexOf('rport')
          rawRport = rportIdx !== -1 && parts[rportIdx + 1] ? parts[rportIdx + 1] || '' : ''
          const netIdIdx = parts.indexOf('network-id')
          rawNetId = netIdIdx !== -1 && parts[netIdIdx + 1] ? parts[netIdIdx + 1] || '' : ''

          if (isGlobalIpv6Address(addr)) {
            localIpv6Generated = true
          }

          if (isTunVirtualAddress(addr) || isTunVirtualAddress(rawRaddr)) {
            this.tunEnvironmentDetected = true
          }

          // 无论 Host（电脑端开 TUN）还是 Client（手机端开 VPN），只丢弃虚拟内网 typ host 候选 (198.18.x.x / 172.19.0.x / fdfe:...)，
          // 100% 保留并净化双端通过 TUN/VPN 套接字反射出的公网 srflx 候选（由 optimizeCandidatePriority 清洗 raddr 为 0.0.0.0 并归一化 cost 为 10）
          if (isBogusOrTunCandidate(rawCandStr, true)) {
            log.info(`Filtered out bogus/TUN poison ICE candidate: ${rawCandStr.trim()}`)
            return
          }
        }
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
        // Chrome 123+ 在 RTCIceCandidate.url 上暴露采集该 srflx 的 STUN 服务器（旧规范为 event.url，Chromium 未实现）；
        // libwebrtc 拼接格式为 "stun:" + hostname + ":" + port，IPv6 字面量不带中括号，由 extractStunUrlHost 兼容解析。
        const stunUrl: string | undefined = (ev.candidate as any).url || (ev as any).url || undefined
        const key = candidateKeyOf(candObj.candidate || rawCandStr)
        if (key) {
          const prev = originMeta.get(key)
          originMeta.set(key, {
            stunUrl: stunUrl || prev?.stunUrl,
            rawRaddr: rawRaddr || prev?.rawRaddr,
            rawRport: rawRport || prev?.rawRport,
            rawNetId: rawNetId || prev?.rawNetId
          })
        }
        dispatchOrQueueCandidate({
          candObj,
          stunUrl,
          rawRaddr,
          rawRport,
          rawNetId
        })
      } else {
        log.info(`ICE Gathering Complete (null candidate received)`)
        warnIfHostIpv6Missing()
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
      if (this.virtualFallbackPeers.has(peer)) {
        log.info(
          `Background native PeerConnection (${reason}) closed while VirtualDataChannel is active (target: ${targetSender || 'host'}); keeping virtual session alive.`
        )
        try {
          peer.close()
        } catch {}
        if (!isHost && onDisconnect) {
          onDisconnect(reason)
        }
        return
      }
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
          if (this.virtualFallbackPeers.has(peer)) {
            break
          }
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
            if (!this.virtualFallbackPeers.has(peer)) {
              this.options.setStatus('offline')
            }
          } else {
            reportFailure('connection_closed')
          }
          break
        default:
          // 静默升级或虚拟通道承载期间数据通道仍在传输，不得把 UI 翻成 connecting
          if (!this.silentUpgradePeers.has(peer) && !this.virtualFallbackPeers.has(peer)) {
            this.options.setStatus('connecting')
          }
      }
    }

    peer.oniceconnectionstatechange = () => {
      const iceState = peer.iceConnectionState
      log.info(`ICE Connection state changed: ${iceState} (targetSender: ${targetSender || 'host'})`)

      if (iceState === 'checking') {
        // 静默升级或虚拟通道已激活期间不提示 ICE 停滞
        if (this.silentUpgradePeers.has(peer) || this.virtualFallbackPeers.has(peer)) return
        // 仅做 UI 提示：ICE 检查在 IPv6 黑洞 / UDP 丢弃时可能较慢，但绝不在此拆除连接
        if (!stallNoticeTimer) {
          stallNoticeTimer = setTimeout(() => {
            stallNoticeTimer = null
            if (peer.iceConnectionState === 'checking' && !this.virtualFallbackPeers.has(peer)) {
              warnIfHostIpv6Missing()
              if (localIpv6Generated) {
                log.warn(
                  `[Diagnostic] 检测到本端已生成公网 IPv6 候选但握手超过 ${CONNECTION_TIMING.ICE_STALL_NOTICE_MS}ms 未响应（可能原因：移动端 VPN 开启了 IPv6 路由劫持/阻断且未将浏览器加入分应用绕过白名单）。正在自动尝试 IPv4 穿透与信令加密通道兜底。`
                )
              } else {
                log.warn(`[Watchdog] ICE check taking longer than ${CONNECTION_TIMING.ICE_STALL_NOTICE_MS}ms (possible IPv6 blackhole / middlebox UDP drop). Waiting for parallel srflx/relay pairs.`)
              }
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
        if (!this.virtualFallbackPeers.has(peer)) {
          this.options.setStatus('unstable')
        }
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
