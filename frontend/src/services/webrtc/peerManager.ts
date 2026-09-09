import type { ConnectionTransportInfo, ConnectionStatus } from '@/types'
import { encryptSignalingData } from '@/utils/crypto'
import { STUN_SERVERS, isIpv6Address, optimizeCandidatePriority, optimizeSdpCandidates, classifyCandidatePair } from './connectivity'
import type { SignalingChannel } from './signaling'
import type { WebRtcCallbacks } from './types'

export interface PeerConnectionFactoryOptions {
  getSignaling: () => SignalingChannel | null
  isHostMode: () => boolean
  callbacks: WebRtcCallbacks
  setStatus: (s: ConnectionStatus) => void
  onHostDisconnected?: () => void
  onClientRebuildRelay?: () => void
  getLocalEcdhPubHex: () => string
  getCurrentHostSessionId: () => string
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
      stats.forEach((report: any) => {
        if (
          report.type === 'candidate-pair' &&
          (report.state === 'succeeded' || report.nominated === true || report.selected === true)
        ) {
          if (!activePair || report.nominated || report.state === 'succeeded') {
            activePair = report
          }
        }
      })
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
          securityFingerprint: fingerprint || undefined
        }
        this.currentTransportInfo = info
        console.log(
          `[WebRTC] Active Transport: ${info.type} (${info.protocol}, RTT: ${info.rttMs}ms, SAS: ${info.securityFingerprint}) Local: ${info.localAddress}(${info.localCandidateType}) <-> Remote: ${info.remoteAddress}(${info.remoteCandidateType})`
        )
        this.options.callbacks.onTransportInfoChanged?.(info)
      }
    } catch (e) {
      console.warn('[WebRTC] Failed to inspect stats for transport info:', e)
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
      iceTransportPolicy: forceRelay ? 'relay' : 'all'
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
        console.log(
          `[WebRTC] ICE Candidate: type=${ev.candidate.type}, protocol=${ev.candidate.protocol}, address=${ev.candidate.address}, isIPv6=${isIpv6Address(
            ev.candidate.address || ''
          )}`
        )
        const signaling = this.options.getSignaling()
        if (signaling) {
          const target = isHost ? targetSender : clientHostSenderId
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
            console.warn('[WebRTC] Failed to encrypt candidate, sending plaintext fallback:', err)
          }
          signaling.send({ candidate: candPayload }, target)
        }
      } else {
        console.log(`[WebRTC] ICE Gathering Complete (null candidate)`)
      }
    }

    let iceTimeout: NodeJS.Timeout | null = null
    let checkingWatchdog: NodeJS.Timeout | null = null
    let stallRestartWatchdog: NodeJS.Timeout | null = null

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
      console.log(`[WebRTC] Connection state changed: ${peer.connectionState}`)
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
      console.log(`[WebRTC] ICE Connection state: ${peer.iceConnectionState}`)

      if (peer.iceConnectionState === 'checking') {
        if (!checkingWatchdog) {
          checkingWatchdog = setTimeout(() => {
            checkingWatchdog = null
            if (peer.iceConnectionState === 'checking') {
              console.warn(
                '[WebRTC Watchdog] ICE check taking longer than 3500ms (possible IPv6 blackhole / middlebox UDP drop).'
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
                console.warn(
                  `[WebRTC Watchdog] ICE checking stalled at 5500ms. Triggering restartIce (Attempt ${nextAttempts}/2)`
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
                        clientSessionId: `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        hostSessionId: this.options.getCurrentHostSessionId()
                      })
                    }
                  }
                } catch (restartErr) {
                  console.warn('[WebRTC Watchdog] Failed to restart ICE:', restartErr)
                }
                // 递归重试调度：若网络持续停滞在 checking，确保自动调度下一轮检查直至达到上限
                if (peer.iceConnectionState === 'checking') {
                  scheduleStallRestart()
                }
              } else {
                console.warn(
                  '[WebRTC Watchdog] Max restartIce attempts (2) exceeded. Actively triggering relay-only fallback with iceTransportPolicy: "relay".'
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
