import { DataChannelSender } from '@/services/dataChannelSender'
import { encryptSignalingData } from '@/utils/crypto'
import { createLogger } from '@/utils/logger'
import { SILENT_UPGRADE } from './connectivity'
import { VirtualDataChannel, tryDecryptVirtualFrame } from './virtualDataChannel'
import type { ClientSessionContext } from './clientSession'

const log = createLogger('WebRTC:VirtualFallback')

export interface ClientVirtualFallbackDeps {
  ctx: ClientSessionContext
  getAttemptEpoch: () => number
  clearFailedEpochIfMatch: (epoch: number) => void
  clearConnectWatchdog: () => void
  clearReconnectTimer: () => void
  startDataChannelHeartbeat: () => void
  checkAndScheduleSilentUpgrade: (immediate?: boolean) => Promise<void>
  getSilentUpgradeProbeCount: () => number
  incrementSilentUpgradeProbeCount: () => number
}

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
    startDataChannelHeartbeat,
    checkAndScheduleSilentUpgrade,
    getSilentUpgradeProbeCount,
    incrementSilentUpgradeProbeCount
  } = deps

  let activeVirtualDc: VirtualDataChannel | null = null
  let virtualNativeUpgradeTimer: ReturnType<typeof setTimeout> | null = null

  let drainingVirtualDc: VirtualDataChannel | null = null

  function clearVirtualNativeUpgradeTimer() {
    if (virtualNativeUpgradeTimer) {
      clearTimeout(virtualNativeUpgradeTimer)
      virtualNativeUpgradeTimer = null
    }
  }

  function closeActiveVirtualDc(detachCloseHandler = false, isUpgrade = false) {
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
      log.info(
        `[WebRTC Client] Launching background native P2P upgrade probe while VirtualDataChannel is active (sessionId: ${currentSessionId})`
      )
      const bgPc = ctx.peerMgr.createPeerConnection(
        undefined,
        () => {
          if (epoch === getAttemptEpoch() && activeVirtualDc && activeVirtualDc.readyState === 'open') {
            scheduleBackgroundNativeP2pRetry(epoch)
          }
        },
        false,
        ctx.getClientHostSenderId(),
        { sessionTag: currentSessionId, holdLocalCandidates: true, allowTurn: false }
      )
      ctx.peerMgr.markVirtualChannelActive(bgPc)
      ctx.setClientPc(bgPc)

      const bgDc = bgPc.createDataChannel('scoutingpro-data')
      const bgSender = new DataChannelSender(bgDc)
      bgDc.onmessage = (e) => ctx.handleChannelMessage(e)
      bgDc.onopen = () => {
        if (epoch !== getAttemptEpoch()) return
        log.info('Hot-upgrading active session from VirtualDataChannel to Native UDP P2P DataChannel!')
        closeActiveVirtualDc(true, true)
        ctx.setClientDc(bgDc)
        ctx.setClientSender(bgSender)
        void ctx.peerMgr.updateTransportInfo(bgPc)
        void checkAndScheduleSilentUpgrade()
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
          allowTurn: false,
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
            allowTurn: false,
            forceRelay: false
          },
          ctx.getClientHostSenderId()
        )
        ctx.peerMgr.releaseLocalCandidates(bgPc)
      } catch {
        try {
          bgPc.close()
        } catch {}
      }
    }, delayMs)
  }

  function activateVirtualFallbackChannel(epoch: number, sessionId: string) {
    if (epoch !== getAttemptEpoch()) return
    const curDc = ctx.getClientDc()
    if (curDc && curDc.readyState === 'open') return
    if (!ctx.sas.clientSharedAesKey || !ctx.getClientHostSenderId()) return

    log.info(
      `[WebRTC Client] Native UDP ICE blocked or slow (>3.8s, e.g. mobile VPN blocking IPv6/UDP). Activating ECDH-encrypted VirtualDataChannel for session ${sessionId} while continuing native P2P in background!`
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
      ctx.callbacks.onIceStalled?.(false)
      ctx.setClientDc(vdc as unknown as RTCDataChannel)
      ctx.setClientSender(new DataChannelSender(vdc as unknown as RTCDataChannel))
      const vdcTransportInfo = {
        type: 'relay' as const,
        label: 'ECDH Tunnel (TLS)',
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
    }

    // 通知 Host 激活对应会话的虚拟通道，并立即打开本地通道
    void encryptSignalingData(
      ctx.sas.clientSharedAesKey,
      JSON.stringify({ vdc: 'open', sessionId })
    )
      .then((encrypted) => {
        ctx.getSignaling()?.send(
          { encrypted, clientSessionId: sessionId },
          ctx.getClientHostSenderId()
        )
        vdc.open()
      })
      .catch(() => {})
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
    isVirtualDcActiveOnClient,
    clearVirtualNativeUpgradeTimer,
    closeActiveVirtualDc,
    scheduleBackgroundNativeP2pRetry,
    activateVirtualFallbackChannel,
    handleIncomingEncryptedVirtualFrame
  }
}
