import type { ConnectionTransportInfo, ConnectionStatus } from '@/types'
import { encryptSignalingData } from '@/utils/crypto'
import { STUN_SERVERS, isIpv6Address, optimizeCandidatePriority, optimizeSdpCandidates, classifyCandidatePair } from './connectivity'
import type { SignalingChannel } from './signaling'
import type { WebRtcCallbacks } from './types'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:Peer')

export interface PeerConnectionFactoryOptions {
  getSignaling: () => SignalingChannel | null
  isHostMode: () => boolean
  callbacks: WebRtcCallbacks
  setStatus: (s: ConnectionStatus) => void
  onHostDisconnected?: () => void
  onClientRebuildRelay?: () => void
  getLocalEcdhPubHex: () => string
  getCurrentHostSessionId: () => string
  getClientSessionId?: () => string
  /** ICE 重启补发 Offer 时必须带上设备身份，否则 Host 侧 TOFU 绑定会退化成 device_default */
  getLocalDeviceId?: () => string
  getUsername?: () => string
  getUserId?: () => string
  /**
   * 动态读取当前 Host 的 signaling clientId。
   * 客户端首次 join() 时会在收到 host_hello 之前就建好 PeerConnection，
   * 若把 hostSenderId 固化在闭包里，之后收集到的 ICE 候选（含关键的 IPv6 host 候选）
   * 会一直被广播到整个房间，而不是定向发给 Host。
   */
  getClientHostSenderId?: () => string | undefined
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

      // 1. W3C 规范首选：查找 RTCTransportStats 的 selectedCandidatePairId
      let selectedPairId: string | null = null
      stats.forEach((report: any) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId
        }
      })

      if (selectedPairId && stats.has(selectedPairId)) {
        activePair = stats.get(selectedPairId)
      } else {
        // 2. 备选：严格评分选优，杜绝普通 succeeded 候选对覆盖已被协议选中的 nominated/selected 候选对
        let bestPair: any = null
        let bestScore = -1
        stats.forEach((report: any) => {
          if (report.type === 'candidate-pair') {
            let score = 0
            if (report.selected === true) {
              score = 3
            } else if (report.nominated === true && report.state === 'succeeded') {
              score = 2
            } else if (report.state === 'succeeded') {
              score = 1
            }

            if (score > bestScore) {
              bestScore = score
              bestPair = report
            }
          }
        })
        activePair = bestPair
      }
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
    const config: RTCConfiguration = {
      ...STUN_SERVERS,
      iceTransportPolicy: forceRelay ? 'relay' : 'all',
      // 候选池是按 PeerConnection 配置预热的全局资源：强制中继时若沿用池化的
      // 'all' 策略候选，可能把非 relay 候选泄漏进 relay-only 会话，故此处禁用池化。
      iceCandidatePoolSize: forceRelay ? 0 : (STUN_SERVERS.iceCandidatePoolSize ?? 0)
    }
    log.info(`Creating RTCPeerConnection (isHost: ${isHost}, targetSender: ${targetSender || 'default'}, forceRelay: ${forceRelay}, icePolicy: ${config.iceTransportPolicy})`)
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
          `Generated ICE Candidate: type=${ev.candidate.type}, protocol=${ev.candidate.protocol}, address=${ev.candidate.address}, isIPv6=${isIpv6Address(
            ev.candidate.address || ''
          )}`,
          { candidate: candObj.candidate }
        )
        const signaling = this.options.getSignaling()
        if (signaling) {
          // 优先使用实时的 Host senderId；建链早期尚未知悉时才退回构造期快照
          const target = isHost ? targetSender : (this.options.getClientHostSenderId?.() || clientHostSenderId)
          let candPayload: any = candObj
          try {
            if (isHost && targetSender) {
              const sharedKey = this.options.getClientSharedKey(targetSender)
              if (sharedKey) {
                candPayload = await encryptSignalingData(sharedKey, JSON.stringify(candObj))
              }
            } else if (!isHost) {
              const sharedKey = this.options.getClientSharedAesKey()
              if (sharedKey) {
                candPayload = await encryptSignalingData(sharedKey, JSON.stringify(candObj))
              }
            }
          } catch (err) {
            log.warn('Failed to encrypt candidate, sending plaintext fallback:', err)
          }
          signaling.send({ candidate: candPayload }, target)
        }
      } else {
        log.info(`ICE Gathering Complete (null candidate received)`)
      }
    }

    let iceTimeout: NodeJS.Timeout | null = null
    let checkingWatchdog: NodeJS.Timeout | null = null
    let stallRestartWatchdog: NodeJS.Timeout | null = null
    let gatheringGrace = 0
    const MAX_GATHERING_GRACE = 3

    const origClose = peer.close.bind(peer)
    peer.close = () => {
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
      if (['disconnected', 'failed', 'closed'].includes(peer.connectionState)) {
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
                '[Watchdog] ICE check taking longer than 3500ms (possible IPv6 blackhole / middlebox UDP drop).'
              )
              callbacks.onIceStalled?.(true)
            }
          }, 3500)
        }
        const scheduleStallRestart = () => {
          if (stallRestartWatchdog) clearTimeout(stallRestartWatchdog)
          stallRestartWatchdog = setTimeout(async () => {
            stallRestartWatchdog = null
            if (peer.iceConnectionState === 'checking') {
              // ICE 仍在收集候选（多 STUN + 4 个 TURN 的分配、IPv6 STUN 反射查询）时，
              // 'checking' 并不代表停滞。此时 restartIce() 会重置收集进度、越重启越慢，
              // 两次耗尽后还会把链路锁死成 relay-only，直接掐掉 IPv6/LAN 直连的可能。
              // 因此在收集未完成期间只做有限次宽限重排，不计入 restartIce 次数。
              if ((peer as any).iceGatheringState === 'gathering' && gatheringGrace < MAX_GATHERING_GRACE) {
                gatheringGrace++
                log.info(
                  `[Watchdog] ICE still gathering candidates; deferring stall restart (grace ${gatheringGrace}/${MAX_GATHERING_GRACE}).`
                )
                scheduleStallRestart()
                return
              }

              const currentAttempts = isHost
                ? targetSender
                  ? this.hostIceRestartAttempts.get(targetSender) || 0
                  : 0
                : this.clientIceRestartAttempts

              if (currentAttempts < 2) {
                const nextAttempts = currentAttempts + 1
                if (isHost && targetSender) {
                  this.hostIceRestartAttempts.set(targetSender, nextAttempts)
                } else {
                  this.clientIceRestartAttempts = nextAttempts
                }
                log.warn(
                  `[Watchdog] ICE checking stalled at 5500ms. Triggering restartIce (Attempt ${nextAttempts}/2, target: ${targetSender || 'host'})`
                )
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
                        // 必须携带设备身份：Host 侧 TOFU 记录以 (eventId,userId,deviceId) 为键，
                        // 缺失会被降级成 'device_default' + 'dev_pub_*'，写入垃圾信任记录并
                        // 让同一设备每次 ICE 重启都重新走一遍“首次信任”分支。
                        deviceId: this.options.getLocalDeviceId?.(),
                        username: this.options.getUsername?.(),
                        userId: this.options.getUserId?.(),
                        clientSessionId: this.options.getClientSessionId?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        hostSessionId: this.options.getCurrentHostSessionId()
                      })
                    }
                  }
                } catch (restartErr) {
                  log.error('[Watchdog] Failed to restart ICE:', restartErr)
                }
                // 递归重试调度：若网络持续停滞在 checking，确保自动调度下一轮检查直至达到上限
                if (peer.iceConnectionState === 'checking') {
                  scheduleStallRestart()
                }
              } else {
                log.warn(
                  '[Watchdog] Max restartIce attempts (2) exceeded. Actively triggering relay-only fallback with iceTransportPolicy: "relay".'
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
          }, 5500)
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
