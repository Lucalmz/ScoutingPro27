import { DataChannelSender } from '@/services/dataChannelSender'
import { encryptSignalingData } from '@/utils/crypto'
import { createLogger } from '@/utils/logger'
import { CONNECTION_TIMING, SILENT_UPGRADE } from './connectivity'
import { VirtualDataChannel, tryDecryptVirtualFrame } from './virtualDataChannel'
import type { ClientSessionContext } from './clientSession'

const log = createLogger('WebRTC:VirtualFallback')

type MaybeVirtualChannel = RTCDataChannel & { isVirtual?: boolean }

export interface ClientVirtualFallbackDeps {
  ctx: ClientSessionContext
  getAttemptEpoch: () => number
  clearFailedEpochIfMatch: (epoch: number) => void
  clearConnectWatchdog: () => void
  clearReconnectTimer: () => void
  resetReconnectAttempts?: () => void
  resetSilentUpgradeProbeCount?: () => void
  startDataChannelHeartbeat: () => void
  checkAndScheduleSilentUpgrade: (immediate?: boolean) => Promise<void>
  getSilentUpgradeProbeCount: () => number
  incrementSilentUpgradeProbeCount: () => number
  failAttempt?: (epoch: number, reason: string) => void
}

const MAX_BG_PROBE_CONSECUTIVE_ERRORS = 8

/**
 * Client 侧 ECDH 加密 VirtualDataChannel 兜底激活、后台原生 UDP 热升级与帧解密控制器
 */
export function createClientVirtualFallbackController(deps: ClientVirtualFallbackDeps) {
  const {
    ctx,
    getAttemptEpoch,
    clearFailedEpochIfMatch,
    clearConnectWatchdog,
    clearReconnectTimer,
    resetReconnectAttempts,
    resetSilentUpgradeProbeCount,
    startDataChannelHeartbeat,
    checkAndScheduleSilentUpgrade,
    getSilentUpgradeProbeCount,
    incrementSilentUpgradeProbeCount,
    failAttempt
  } = deps

  let activeVirtualDc: VirtualDataChannel | null = null
  let virtualNativeUpgradeTimer: ReturnType<typeof setTimeout> | null = null
  let bgProbeTimeoutTimer: ReturnType<typeof setTimeout> | null = null

  let drainingVirtualDc: VirtualDataChannel | null = null
  let consecutiveBgProbeErrors = 0

  function clearBgProbeTimeoutTimer() {
    if (bgProbeTimeoutTimer) {
      clearTimeout(bgProbeTimeoutTimer)
      bgProbeTimeoutTimer = null
    }
  }

  function clearVirtualNativeUpgradeTimer() {
    clearBgProbeTimeoutTimer()
    if (virtualNativeUpgradeTimer) {
      clearTimeout(virtualNativeUpgradeTimer)
      virtualNativeUpgradeTimer = null
    }
  }

  function closeActiveVirtualDc(detachCloseHandler = false, isUpgrade = false) {
    clearVirtualNativeUpgradeTimer()
    if (isUpgrade && activeVirtualDc) {
      log.info('Transitioning active VirtualDataChannel to draining mode for smooth hot-upgrade handover')
      if (drainingVirtualDc && drainingVirtualDc !== activeVirtualDc) {
        try { drainingVirtualDc.close() } catch (_) {}
      }
      const oldVdc = activeVirtualDc
      drainingVirtualDc = oldVdc
      activeVirtualDc = null
      oldVdc.onclose = null
      oldVdc.startDrain(5000, 1000, () => {
        if (drainingVirtualDc === oldVdc) {
          drainingVirtualDc = null
        }
      })
      return
    }

    consecutiveBgProbeErrors = 0
    // Teardown / hard reset: clean up draining channel first even if activeVirtualDc is already null
    if (drainingVirtualDc) {
      try { drainingVirtualDc.close() } catch (_) {}
      drainingVirtualDc = null
    }

    if (activeVirtualDc) {
      activeVirtualDc.onmessage = null
      activeVirtualDc.onopen = null
      activeVirtualDc.onerror = null
      activeVirtualDc.onclose = null
      try {
        activeVirtualDc.close()
      } catch (_) {}
      activeVirtualDc = null
    }
  }

  function isVirtualDcOpen(): boolean {
    return Boolean(activeVirtualDc && activeVirtualDc.readyState === 'open')
  }

  function isVirtualDcActivating(): boolean {
    return Boolean(activeVirtualDc && activeVirtualDc.readyState === 'connecting')
  }

  function isVirtualDcActiveOnClient(): boolean {
    return Boolean(
      activeVirtualDc &&
      activeVirtualDc.readyState === 'open' &&
      ctx.getClientDc() === (activeVirtualDc as any)
    )
  }

  function scheduleBackgroundNativeP2pRetry(epoch: number) {
    clearVirtualNativeUpgradeTimer()
    const probeIdx = getSilentUpgradeProbeCount()
    const delayMs =
      SILENT_UPGRADE.RELAY_PROBE_DELAYS_MS[Math.min(probeIdx, SILENT_UPGRADE.RELAY_PROBE_DELAYS_MS.length - 1)] ||
      20000
    incrementSilentUpgradeProbeCount()
    virtualNativeUpgradeTimer = setTimeout(async () => {
      virtualNativeUpgradeTimer = null
      if (epoch !== getAttemptEpoch() || ctx.isHostMode?.() || ctx.isExplicitlyClosed()) return
      if (!activeVirtualDc || activeVirtualDc.readyState !== 'open') return

      const currentSessionId = ctx.getClientSessionId()
      const allowTurn = false
      log.info(
        `[WebRTC Client] Launching background native P2P upgrade probe while VirtualDataChannel is active (sessionId: ${currentSessionId}, allowTurn: ${allowTurn})`
      )
      const bgPc = ctx.peerMgr.createPeerConnection(
        undefined,
        (reason?: string) => {
          clearBgProbeTimeoutTimer()
          if (epoch !== getAttemptEpoch()) return
          if (activeVirtualDc && activeVirtualDc.readyState === 'open') {
            scheduleBackgroundNativeP2pRetry(epoch)
          } else if (!isVirtualDcOpen()) {
            failAttempt?.(epoch, reason || 'bg_peer_failure')
          }
        },
        false,
        ctx.getClientHostSenderId(),
        { sessionTag: currentSessionId, holdLocalCandidates: true, allowTurn }
      )
      ctx.peerMgr.markVirtualChannelActive(bgPc)
      const prevPc = ctx.getClientPc?.()
      if (prevPc && prevPc !== bgPc) {
        try {
          prevPc.onicecandidate = null
          prevPc.oniceconnectionstatechange = null
          prevPc.onconnectionstatechange = null
          prevPc.ondatachannel = () => {}
          prevPc.close()
        } catch {}
      }
      ctx.setClientPc(bgPc)

      const bgDc = bgPc.createDataChannel('scoutingpro-data')
      const bgSender = new DataChannelSender(bgDc)
      bgDc.onmessage = (e) => ctx.handleChannelMessage(e)
      bgDc.onopen = async () => {
        clearBgProbeTimeoutTimer()
        if (epoch !== getAttemptEpoch()) return
        consecutiveBgProbeErrors = 0
        resetReconnectAttempts?.()
        resetSilentUpgradeProbeCount?.()
        log.info('Hot-upgrading active session from VirtualDataChannel to Native DataChannel!')
        closeActiveVirtualDc(true, true)
        ctx.peerMgr.unmarkVirtualChannelActive?.(bgPc)
        ctx.setClientDc(bgDc)
        ctx.setClientSender(bgSender)
        await ctx.peerMgr.updateTransportInfo(bgPc)
        void checkAndScheduleSilentUpgrade()
      }
      bgDc.onclose = () => {
        clearBgProbeTimeoutTimer()
        if (epoch !== getAttemptEpoch()) return
        if (isVirtualDcActiveOnClient()) return
        if (ctx.isExplicitlyClosed() || ctx.getStatus() === 'long_offline') return
        failAttempt?.(epoch, 'bg_datachannel_closed')
      }

      try {
        const offer = await bgPc.createOffer()
        if (epoch !== getAttemptEpoch()) return
        await bgPc.setLocalDescription(offer)
        if (epoch !== getAttemptEpoch()) return
        const finalizedBgSdp = await ctx.peerMgr.finalizeLocalSdp(
          bgPc,
          bgPc?.localDescription?.sdp || offer.sdp || ''
        )
        if (epoch !== getAttemptEpoch()) return
        const rawOffer = {
          type: offer.type,
          sdp: finalizedBgSdp,
          deviceId: ctx.getLocalDeviceId(),
          username: ctx.getUsername?.() || '',
          userId: ctx.getUserId?.() || '',
          allowTurn,
          forceRelay: false
        }
        let offerPayload: any = rawOffer
        if (ctx.sas.clientSharedAesKey) {
          try {
            offerPayload = await encryptSignalingData(ctx.sas.clientSharedAesKey, JSON.stringify(rawOffer))
          } catch {}
        }
        ctx.getSignaling()?.send(
          {
            offer: offerPayload,
            ecdhPublicKey: ctx.getLocalEcdhPubHex(),
            deviceId: ctx.getLocalDeviceId(),
            clientSessionId: currentSessionId,
            hostSessionId: ctx.getCurrentHostSessionId(),
            username: ctx.getUsername?.() || '',
            userId: ctx.getUserId?.() || '',
            allowTurn,
            forceRelay: false
          },
          ctx.getClientHostSenderId()
        )
        ctx.peerMgr.releaseLocalCandidates(bgPc)
        consecutiveBgProbeErrors = 0
        clearBgProbeTimeoutTimer()
        bgProbeTimeoutTimer = setTimeout(() => {
          bgProbeTimeoutTimer = null
          if (epoch !== getAttemptEpoch() || ctx.isHostMode?.() || ctx.isExplicitlyClosed()) return
          if (ctx.getClientPc?.() !== bgPc || bgDc.readyState === 'open') return
          log.warn(
            `[WebRTC Client] Background native P2P probe timed out after ${CONNECTION_TIMING.CLIENT_CONNECT_TIMEOUT_MS}ms; closing stalled bgPc and rescheduling.`
          )
          try {
            bgPc.onicecandidate = null
            bgPc.oniceconnectionstatechange = null
            bgPc.onconnectionstatechange = null
            bgPc.ondatachannel = () => {}
            bgPc.close()
          } catch {}
          if (ctx.getClientPc?.() === bgPc) {
            ctx.setClientPc(null)
          }
          if (activeVirtualDc && activeVirtualDc.readyState === 'open') {
            scheduleBackgroundNativeP2pRetry(epoch)
          }
        }, CONNECTION_TIMING.CLIENT_CONNECT_TIMEOUT_MS)
      } catch (err) {
        clearBgProbeTimeoutTimer()
        log.warn('[WebRTC Client] Background native P2P/TURN upgrade probe failed:', err)
        try {
          bgPc.close()
        } catch {}
        if (ctx.getClientPc?.() === bgPc) {
          ctx.setClientPc(null)
        }
        if (
          epoch === getAttemptEpoch() &&
          !ctx.isHostMode?.() &&
          !ctx.isExplicitlyClosed() &&
          activeVirtualDc &&
          activeVirtualDc.readyState === 'open'
        ) {
          consecutiveBgProbeErrors++
          if (consecutiveBgProbeErrors <= MAX_BG_PROBE_CONSECUTIVE_ERRORS) {
            scheduleBackgroundNativeP2pRetry(epoch)
          } else {
            log.warn(
              `[WebRTC Client] Stopping background P2P/TURN retry after ${MAX_BG_PROBE_CONSECUTIVE_ERRORS} consecutive probe errors.`
            )
          }
        }
      }
    }, delayMs)
  }

  function activateVirtualFallbackChannel(epoch: number, sessionId: string): boolean {
    if (epoch !== getAttemptEpoch()) return false
    const curDc = ctx.getClientDc() as MaybeVirtualChannel | null
    if (curDc && curDc.readyState === 'open' && !curDc.isVirtual) return false
    if (activeVirtualDc) return true
    if (!ctx.sas.clientSharedAesKey || !ctx.getClientHostSenderId()) return false

    consecutiveBgProbeErrors = 0
    log.info(
      `[WebRTC Client] Native UDP ICE blocked or slow (<3.8s ice_failed or >3.8s timeout, e.g. mobile VPN blocking IPv6/UDP). Activating ECDH-encrypted VirtualDataChannel for session ${sessionId} while scheduling background native/TURN upgrade!`
    )
    ctx.peerMgr.markVirtualChannelActive(ctx.getClientPc())
    const vdc = new VirtualDataChannel({
      label: 'scoutingpro-data-virtual',
      sessionId,
      getSignaling: ctx.getSignaling,
      getSharedAesKey: () => ctx.sas.clientSharedAesKey,
      getTargetPeerId: ctx.getClientHostSenderId
    })
    activeVirtualDc = vdc
    vdc.onmessage = (e) => ctx.handleChannelMessage(e)
    vdc.onopen = () => {
      if (epoch !== getAttemptEpoch()) return
      clearFailedEpochIfMatch(epoch)
      clearConnectWatchdog()
      clearReconnectTimer()
      resetReconnectAttempts?.()
      ctx.callbacks.onIceStalled?.(false)
      ctx.setClientDc(vdc as unknown as RTCDataChannel)
      ctx.setClientSender(new DataChannelSender(vdc as unknown as RTCDataChannel))
      const vdcTransportInfo = {
        type: 'relay' as const,
        label: 'ECDH Tunnel (TLS)',
        isVirtualTunnel: true,
        localAddress: 'virtual-e2ee',
        remoteAddress: 'wss-broker:8084',
        localCandidateType: 'virtual',
        remoteCandidateType: 'virtual',
        protocol: 'wss/tls',
        isIpv6: false,
        rttMs: null as number | null,
        securityFingerprint: ctx.sas.clientSecurityFingerprint || undefined
      }
      ctx.peerMgr.currentTransportInfo = vdcTransportInfo
      ;(ctx.callbacks.onTransportInfoChanged || ctx.callbacks.onTransportChange)?.(vdcTransportInfo)
      ctx.setStatus('connected')
      startDataChannelHeartbeat()
      if (!virtualNativeUpgradeTimer) {
        scheduleBackgroundNativeP2pRetry(epoch)
      }
    }

    // 通知 Host 激活对应会话的虚拟通道，并立即打开本地通道
    void encryptSignalingData(
      ctx.sas.clientSharedAesKey,
      JSON.stringify({ vdc: 'open', sessionId })
    )
      .then((encrypted) => {
        if (epoch !== getAttemptEpoch() || activeVirtualDc !== vdc) return
        ctx.getSignaling()?.send(
          { encrypted, clientSessionId: sessionId },
          ctx.getClientHostSenderId()
        )
        vdc.open()
      })
      .catch((err) => {
        log.warn('[WebRTC Client] Failed to encrypt VirtualDataChannel open frame; cleaning up:', err)
        if (activeVirtualDc === vdc) {
          activeVirtualDc = null
        }
        try { vdc.close() } catch {}
        const curPc = ctx.getClientPc()
        const pcDead = !curPc || curPc.connectionState === 'failed' || curPc.connectionState === 'closed' || curPc.iceConnectionState === 'failed'
        if (epoch === getAttemptEpoch() && !isVirtualDcOpen() && pcDead) {
          failAttempt?.(epoch, 'virtual_dc_encrypt_failed')
        }
      })
    return true
  }

  async function handleIncomingEncryptedVirtualFrame(encryptedPayload: any): Promise<void> {
    const frame = await tryDecryptVirtualFrame(ctx.sas.clientSharedAesKey, encryptedPayload)
    if (frame && frame.sessionId === ctx.getClientSessionId()) {
      if (!activeVirtualDc && !drainingVirtualDc) {
        activateVirtualFallbackChannel(getAttemptEpoch(), frame.sessionId)
      }
      if (frame.vdc === 'data' && typeof frame.payload === 'string') {
        const targetDc = activeVirtualDc || drainingVirtualDc
        targetDc?.receiveDecryptedPayload(frame.payload)
      }
    }
  }

  return {
    getActiveVirtualDc: () => activeVirtualDc,
    isVirtualDcOpen,
    isVirtualDcActivating,
    isVirtualDcActiveOnClient,
    clearVirtualNativeUpgradeTimer,
    closeActiveVirtualDc,
    scheduleBackgroundNativeP2pRetry,
    activateVirtualFallbackChannel,
    handleIncomingEncryptedVirtualFrame
  }
}
