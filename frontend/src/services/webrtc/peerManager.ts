import type { ConnectionTransportInfo, ConnectionStatus } from '@/types'
import { encryptSignalingData } from '@/utils/crypto'
import { STUN_SERVERS, DIRECT_NIC_CONFIG, isIpv6Address, optimizeCandidatePriority, optimizeSdpCandidates, classifyCandidatePair } from './connectivity'
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
  onClientRebuildRelay?: () => void
  getLocalEcdhPubHex: () => string
  getCurrentHostSessionId: () => string
  getClientSessionId?: () => string
  getClientSharedAesKey: () => CryptoKey | null
  getClientSharedKey: (senderId: string) => CryptoKey | null
  getClientFingerprint: (senderId?: string) => string | undefined
  getClientSecurityFingerprint: () => string
  onCandidateEncrypted?: (target: string | undefined, payload: any) => void
  onHostClientClosed?: (targetSender: string) => void
  updateHostStatus?: () => void
  getClientDcState?: () => RTCDataChannelState | undefined
  getClientPc?: () => RTCPeerConnection | null
  isExplicitlyClosed?: () => boolean
  isDirectIpv6Eligible?: (targetSender?: string) => boolean
}

export class PeerConnectionManager {
  private options: PeerConnectionFactoryOptions
  currentTransportInfo: ConnectionTransportInfo | null = null
  clientIceRestartAttempts = 0
  readonly hostIceRestartAttempts = new Map<string, number>()

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

  createPeerConnection(
    targetSender?: string,
    onDisconnect?: () => void,
    forceRelay = false,
    clientHostSenderId?: string
  ): RTCPeerConnection {
    const isHost = this.options.isHostMode()
    const callbacks = this.options.callbacks
    const directIpv6Available = Boolean(this.options.isDirectIpv6Eligible?.(targetSender))
    const isDirectNicMode = directIpv6Available && !forceRelay

    const config: RTCConfiguration = isDirectNicMode
      ? { ...DIRECT_NIC_CONFIG }
      : {
          ...STUN_SERVERS,
          iceTransportPolicy: forceRelay ? 'relay' : 'all'
        }
    log.info(
      `Creating RTCPeerConnection (isHost: ${isHost}, targetSender: ${targetSender || 'default'}, forceRelay: ${forceRelay}, isDirectNicMode: ${isDirectNicMode}, icePolicy: ${config.iceTransportPolicy || 'all'})`
    )
    if (!isHost) {
      this.clientIceRestartAttempts = 0
    } else if (targetSender) {
      this.hostIceRestartAttempts.delete(targetSender)
    }
    const peer = new RTCPeerConnection(config)

    peer.onicecandidate = async (ev) => {
      if (ev.candidate) {
        let candObj = ev.candidate.toJSON
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
          `Local ICE Candidate generated: ${candObj.candidate ? candObj.candidate.trim() : 'null'} (target: ${targetSender || 'host'})`
        )

        const sharedKey = isHost ? this.options.getClientSharedKey(targetSender || '') : this.options.getClientSharedAesKey()
        let candPayload: any = candObj
        if (sharedKey) {
          try {
            candPayload = await encryptSignalingData(sharedKey, JSON.stringify(candObj))
          } catch {}
        }

        const signaling = this.options.getSignaling()
        if (signaling) {
          const target = isHost ? targetSender : clientHostSenderId || undefined
          signaling.send({ candidate: candPayload }, target)
        }
      } else {
        log.info(`ICE Gathering Complete (null candidate received)`)
      }
    }

    const createTime = Date.now()
    let iceTimeout: NodeJS.Timeout | null = null
    let checkingWatchdog: NodeJS.Timeout | null = null
    let stallRestartWatchdog: NodeJS.Timeout | null = null
    let natFallbackTimer: NodeJS.Timeout | null = null
    let isRestartingIce = false
    let hasConnected = false
    let isUpgradingToStun = false

    const cancelNatFallback = () => {
      if (natFallbackTimer) {
        clearTimeout(natFallbackTimer)
        natFallbackTimer = null
      }
    }

    // 若当前为免 STUN 网卡直连模式，启动 1500ms 看门狗；若因路由防火墙/NAT 阻断未能连通，静默降级为 STUN/TURN
    if (isDirectNicMode) {
      natFallbackTimer = setTimeout(() => {
        natFallbackTimer = null
        // 关键防竞态保护：若已连通、连接已关闭或已在升级，绝不打断正常连接
        if (
          hasConnected ||
          peer.connectionState === 'connected' ||
          peer.connectionState === 'closed' ||
          isUpgradingToStun
        ) {
          return
        }
        isUpgradingToStun = true
        log.warn(
          `[WebRTC Watchdog] Direct NIC connection did not reach connected within 1500ms (NAT/firewall detected). Upgrading to STUN/TURN fallback...`
        )
        try {
          if (typeof (peer as any).setConfiguration === 'function') {
            ;(peer as any).setConfiguration(STUN_SERVERS)
          }
          if (typeof (peer as any).restartIce === 'function') {
            ;(peer as any).restartIce()
          }
        } catch (err) {
          log.error('Failed to upgrade configuration for STUN fallback:', err)
        }
      }, 1500)
    }

    const origClose = peer.close.bind(peer)
    peer.close = () => {
      cancelNatFallback()
      if (iceTimeout) {
        clearTimeout(iceTimeout)
        iceTimeout = null
      }
      if (checkingWatchdog) {
        clearTimeout(checkingWatchdog)
        checkingWatchdog = null
      }
      if (stallRestartWatchdog) {
        clearTimeout(stallRestartWatchdog)
        stallRestartWatchdog = null
      }
      origClose()
    }

    peer.onconnectionstatechange = () => {
      log.info(`PeerConnection state changed: ${peer.connectionState} (targetSender: ${targetSender || 'host'})`)
      if (peer.connectionState === 'connected') {
        hasConnected = true
        cancelNatFallback()
        const duration = Date.now() - createTime
        const strategy = isUpgradingToStun ? 'stun_nat_fallback' : (isDirectNicMode ? 'direct_nic_ipv6' : 'stun_direct')
        log.info(`[WebRTC Metric] Successfully connected in ${duration}ms (Strategy: ${strategy})`)
      }
      if (['disconnected', 'failed', 'closed'].includes(peer.connectionState)) {
        cancelNatFallback()
        if (iceTimeout) {
          clearTimeout(iceTimeout)
          iceTimeout = null
        }
        if (checkingWatchdog) {
          clearTimeout(checkingWatchdog)
          checkingWatchdog = null
        }
        if (stallRestartWatchdog) {
          clearTimeout(stallRestartWatchdog)
          stallRestartWatchdog = null
        }
      }
      if (isHost) {
        if (['disconnected', 'failed', 'closed'].includes(peer.connectionState) && targetSender) {
          peer.close()
          this.options.onHostClientClosed?.(targetSender)
        }
        this.options.updateHostStatus?.()
      } else {
        switch (peer.connectionState) {
          case 'connected':
            if (this.options.getClientDcState?.() === 'open') {
              this.options.setStatus('connected')
            }
            break
          case 'disconnected':
          case 'failed':
            this.options.setStatus('unstable')
            if (onDisconnect) {
              onDisconnect()
            } else {
              this.options.setStatus('offline')
            }
            break
          case 'closed':
            if (this.options.isExplicitlyClosed?.()) {
              this.options.setStatus('offline')
            } else {
              this.options.setStatus('unstable')
              if (onDisconnect) onDisconnect()
            }
            break
          case 'new':
            this.options.setStatus('connecting')
            break
          default:
            this.options.setStatus('connecting')
        }
      }
    }

    peer.oniceconnectionstatechange = async () => {
      log.info(`ICE Connection state changed: ${peer.iceConnectionState} (targetSender: ${targetSender || 'host'})`)

      if (peer.iceConnectionState === 'checking') {
        if (!checkingWatchdog) {
          checkingWatchdog = setTimeout(() => {
            checkingWatchdog = null
            if (peer.iceConnectionState === 'checking') {
              log.warn(
                '[Watchdog] ICE check taking longer than 3000ms (possible IPv6 blackhole / middlebox UDP drop).'
              )
              callbacks.onIceStalled?.(true)
            }
          }, 3000)
        }
        const scheduleStallRestart = () => {
          if (stallRestartWatchdog) clearTimeout(stallRestartWatchdog)
          stallRestartWatchdog = setTimeout(async () => {
            stallRestartWatchdog = null
            if (peer.iceConnectionState === 'checking') {
              const currentAttempts = isHost
                ? targetSender
                  ? this.hostIceRestartAttempts.get(targetSender) || 0
                  : 0
                : this.clientIceRestartAttempts

              if (currentAttempts < 1) {
                if (isRestartingIce) {
                  log.info('[Watchdog] ICE restart already in progress, skipping duplicate trigger.')
                  return
                }
                const nextAttempts = currentAttempts + 1
                if (isHost && targetSender) {
                  this.hostIceRestartAttempts.set(targetSender, nextAttempts)
                } else {
                  this.clientIceRestartAttempts = nextAttempts
                }
                log.warn(
                  `[Watchdog] ICE checking stalled at 4000ms. Triggering restartIce (Attempt ${nextAttempts}/1, target: ${targetSender || 'host'})`
                )
                isRestartingIce = true
                try {
                  if (typeof (peer as any).restartIce === 'function') {
                    ;(peer as any).restartIce()
                  }
                  if (!isHost) {
                    const clientPc = this.options.getClientPc?.()
                    if (clientPc) {
                      const newOffer = await clientPc.createOffer({ iceRestart: true })
                      await clientPc.setLocalDescription(newOffer)
                      const optimizedOffer = {
                        type: newOffer.type,
                        sdp: optimizeSdpCandidates(clientPc?.localDescription?.sdp || newOffer.sdp || '')
                      }
                      let payload: any = optimizedOffer
                      const sharedKey = this.options.getClientSharedAesKey()
                      if (sharedKey) {
                        try {
                          payload = await encryptSignalingData(sharedKey, JSON.stringify(optimizedOffer))
                        } catch {}
                      }
                      this.options.getSignaling()?.send({
                        offer: payload,
                        ecdhPublicKey: this.options.getLocalEcdhPubHex(),
                        clientSessionId: this.options.getClientSessionId?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        hostSessionId: this.options.getCurrentHostSessionId()
                      })
                    }
                  }
                } catch (restartErr) {
                  log.error('[Watchdog] Failed to restart ICE:', restartErr)
                } finally {
                  isRestartingIce = false
                }
                // 递归重试调度：若网络持续停滞在 checking，4000ms 后再次触发进入 relay 降级 (总计 8s)
                if (peer.iceConnectionState === 'checking') {
                  scheduleStallRestart()
                }
              } else {
                log.warn(
                  '[Watchdog] ICE checking stalled after 8000ms. Actively triggering relay-only fallback with iceTransportPolicy: "relay".'
                )
                callbacks.onIceStalled?.(true)
                if (checkingWatchdog) {
                  clearTimeout(checkingWatchdog)
                  checkingWatchdog = null
                }
                if (stallRestartWatchdog) {
                  clearTimeout(stallRestartWatchdog)
                  stallRestartWatchdog = null
                }
                if (!isHost) {
                  this.options.onClientRebuildRelay?.()
                } else if (onDisconnect) {
                  onDisconnect()
                } else {
                  this.options.setStatus('degraded')
                }
              }
            }
          }, 4000)
        }

        if (!stallRestartWatchdog) {
          scheduleStallRestart()
        }
      } else if (peer.iceConnectionState === 'disconnected' || peer.iceConnectionState === 'failed') {
        if (checkingWatchdog) {
          clearTimeout(checkingWatchdog)
          checkingWatchdog = null
        }
        if (stallRestartWatchdog) {
          clearTimeout(stallRestartWatchdog)
          stallRestartWatchdog = null
        }
        callbacks.onIceStalled?.(false)
        this.options.setStatus('unstable')
        if (!iceTimeout) {
          iceTimeout = setTimeout(() => {
            if (peer.iceConnectionState === 'disconnected' || peer.iceConnectionState === 'failed') {
              if (onDisconnect) {
                onDisconnect()
              } else {
                console.log('[WebRTC] Connection degraded (timeout)')
                this.options.setStatus('degraded')
              }
            }
          }, 15000)
        }
      } else if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
        if (checkingWatchdog) {
          clearTimeout(checkingWatchdog)
          checkingWatchdog = null
        }
        if (stallRestartWatchdog) {
          clearTimeout(stallRestartWatchdog)
          stallRestartWatchdog = null
        }
        callbacks.onIceStalled?.(false)
        if (!isHost) {
          this.clientIceRestartAttempts = 0
        } else if (targetSender) {
          this.hostIceRestartAttempts.set(targetSender, 0)
        }
        if (iceTimeout) {
          clearTimeout(iceTimeout)
          iceTimeout = null
        }
        if (isHost) {
          this.options.updateHostStatus?.()
        } else {
          if (this.options.getClientDcState?.() === 'open') {
            this.options.setStatus('connected')
          }
        }

        this.updateTransportInfo(peer, targetSender)
        setTimeout(() => this.updateTransportInfo(peer, targetSender), 1200)
        setTimeout(() => this.updateTransportInfo(peer, targetSender), 3000)
      }
    }

    peer.onicegatheringstatechange = () => {
      console.log(`[WebRTC] ICE Gathering state: ${peer.iceGatheringState}`)
    }

    return peer
  }
}
