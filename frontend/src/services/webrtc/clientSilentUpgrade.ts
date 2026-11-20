import { DataChannelSender } from '@/services/dataChannelSender'
import { encryptSignalingData } from '@/utils/crypto'
import { createLogger } from '@/utils/logger'
import {
  buildIceConfiguration,
  getSilentUpgradeDelayMs,
  getTransportTier,
  isGlobalIpv6Address,
  probeLocalInterfaceIpv6,
  SILENT_UPGRADE
} from './connectivity'
import type { ClientSessionContext } from './clientSession'

const log = createLogger('WebRTC:SilentUpgrade')

export interface ClientSilentUpgradeDeps {
  ctx: ClientSessionContext
  getAttemptEpoch: () => number
  getProbeCount: () => number
  incrementProbeCount: () => number
  registerProbePeer?: (probeSessionId: string, probePc: RTCPeerConnection) => void
  unregisterProbePeer?: (probeSessionId: string) => void
  promoteProbeConnection?: (
    probePc: RTCPeerConnection,
    probeDc: RTCDataChannel,
    probeSender: DataChannelSender,
    probeSessionId: string
  ) => void
  failAttempt?: (epoch: number, reason: string) => void
}

/**
 * Client 侧就地静默升级管理器：
 * - nat_p2p -> ipv6_p2p（本就无 TURN）：使用同 PC 就地 ICE restart 探测 IPv6 直连；
 * - relay (Metered TURN) -> Direct P2P：创建独立非破坏性探针 RTCPeerConnection（allowTurn=false），
 *   保持当前 TURN 会话与 DataChannel 100% 在线不断流，仅当探针直连 DataChannel 真正 open 后才平滑热切换并关闭旧 TURN 连接！
 */
export function createClientSilentUpgradeManager(deps: ClientSilentUpgradeDeps) {
  const {
    ctx,
    getAttemptEpoch,
    getProbeCount,
    incrementProbeCount,
    registerProbePeer,
    unregisterProbePeer,
    promoteProbeConnection,
    failAttempt
  } = deps
  let silentUpgradeTimer: ReturnType<typeof setTimeout> | null = null
  let silentUpgradeSettleTimer: ReturnType<typeof setTimeout> | null = null
  let silentUpgradeSettlePollTimer: ReturnType<typeof setInterval> | null = null
  let isSilentUpgradeInFlight = false
  let activeProbePc: RTCPeerConnection | null = null
  let activeProbeSessionId: string | null = null

  function cleanupActiveProbePeer() {
    if (activeProbeSessionId) {
      unregisterProbePeer?.(activeProbeSessionId)
      activeProbeSessionId = null
    }
    if (activeProbePc) {
      const probePc = activeProbePc
      activeProbePc = null
      ctx.peerMgr.endSilentUpgrade(probePc)
      try {
        probePc.onicecandidate = null
        probePc.oniceconnectionstatechange = null
        probePc.onconnectionstatechange = null
        probePc.ondatachannel = () => {}
        probePc.close()
      } catch {}
    }
  }

  function clearSilentUpgradeTimers() {
    if (silentUpgradeTimer) {
      clearTimeout(silentUpgradeTimer)
      silentUpgradeTimer = null
    }
    if (silentUpgradeSettleTimer) {
      clearTimeout(silentUpgradeSettleTimer)
      silentUpgradeSettleTimer = null
    }
    if (silentUpgradeSettlePollTimer) {
      clearInterval(silentUpgradeSettlePollTimer)
      silentUpgradeSettlePollTimer = null
    }
  }

  function resetSilentUpgradeState() {
    clearSilentUpgradeTimers()
    cleanupActiveProbePeer()
    isSilentUpgradeInFlight = false
  }

  async function checkAndScheduleSilentUpgrade(immediate = false): Promise<void> {
    if (ctx.isHostMode?.() || ctx.isExplicitlyClosed()) return
    const pc = ctx.getClientPc()
    const dc = ctx.getClientDc()
    if (!pc || pc.connectionState !== 'connected' || !dc || dc.readyState !== 'open') return
    if (isSilentUpgradeInFlight) return

    const curInfo = ctx.peerMgr.currentTransportInfo
    const curType = curInfo?.type
    const curTier = getTransportTier(curType)
    // 已经处于最优直连链路（lan_p2p / ipv6_p2p），无需升级
    if (curTier >= 2) {
      clearSilentUpgradeTimers()
      return
    }
    // VirtualDataChannel (wss/tls) 由 clientVirtualFallback 的后台原生探针负责热升级，不与静默升级重复探测
    if ((dc as any)?.isVirtual || curInfo?.isVirtualTunnel || curInfo?.protocol === 'wss/tls') {
      return
    }

    let hasLocalIpv6 = false
    try {
      const localIpv6 = await probeLocalInterfaceIpv6()
      hasLocalIpv6 = Boolean(localIpv6 && isGlobalIpv6Address(localIpv6))
    } catch {}

    const probeCount = getProbeCount()
    const delayMs = immediate ? 0 : getSilentUpgradeDelayMs(curType, probeCount, hasLocalIpv6)
    if (delayMs === null) {
      return
    }

    if (silentUpgradeTimer) {
      clearTimeout(silentUpgradeTimer)
      silentUpgradeTimer = null
    }

    log.info(
      `[WebRTC Client] Scheduling silent upgrade probe #${probeCount + 1} in ${delayMs}ms (current: ${curType || 'unknown'})`
    )
    silentUpgradeTimer = setTimeout(() => {
      silentUpgradeTimer = null
      void executeSilentUpgrade()
    }, delayMs)
  }

  async function executeSilentUpgrade(): Promise<void> {
    if (isSilentUpgradeInFlight) return
    const pc = ctx.getClientPc()
    const dc = ctx.getClientDc()
    if (!pc || pc.connectionState !== 'connected' || !dc || dc.readyState !== 'open') return

    const curInfo = ctx.peerMgr.currentTransportInfo
    const baselineTier = getTransportTier(curInfo?.type)
    if (baselineTier >= 2) return
    if ((dc as any)?.isVirtual || curInfo?.isVirtualTunnel || curInfo?.protocol === 'wss/tls') return

    isSilentUpgradeInFlight = true
    const probeSeq = incrementProbeCount()
    const epoch = getAttemptEpoch()
    const currentSessionId = ctx.getClientSessionId()

    // 若当前活跃链路为 Metered TURN relay：严禁对活跃 PC 调用 setConfiguration(STUN-only)+iceRestart（会拆毁保底 TURN）！
    // 改为拉起独立非破坏性探针 PeerConnection（allowTurn=false），仅当直连探针 DataChannel open 后才热切并释放旧 TURN。
    if (curInfo?.type === 'relay') {
      const probeSessionId = `${currentSessionId}-probe-${probeSeq}`
      log.info(
        `[WebRTC Client] Launching non-destructive Direct P2P probe #${probeSeq} off active TURN (probeSessionId: ${probeSessionId}, allowTurn: false)`
      )

      let probeSettled = false
      let promoted = false
      let probePc: RTCPeerConnection | null = null
      let probeDcRef: RTCDataChannel | null = null
      const bufferedProbeMessages: MessageEvent[] = []

      const finishProbe = (succeeded: boolean, newType?: string) => {
        if (probeSettled) return
        probeSettled = true
        if (silentUpgradeSettleTimer) {
          clearTimeout(silentUpgradeSettleTimer)
          silentUpgradeSettleTimer = null
        }
        if (!succeeded) {
          bufferedProbeMessages.length = 0
          if (probeDcRef) {
            try { probeDcRef.onmessage = null } catch {}
          }
          cleanupActiveProbePeer()
        }
        isSilentUpgradeInFlight = false
        if (epoch !== getAttemptEpoch() || ctx.isExplicitlyClosed() || ctx.isHostMode?.()) return

        if (succeeded) {
          log.info(`[WebRTC Client] Non-destructive TURN-to-Direct upgrade SUCCEEDED! (${newType || 'direct'})`)
          if (getTransportTier(newType as any) >= 2) {
            clearSilentUpgradeTimers()
          } else {
            void checkAndScheduleSilentUpgrade()
          }
        } else {
          log.info(`[WebRTC Client] Non-destructive probe #${probeSeq} did not establish direct path; active TURN session preserved untouched.`)
          void checkAndScheduleSilentUpgrade()
        }
      }

      try {
        probePc = ctx.peerMgr.createPeerConnection(
          undefined,
          (reason?: string) => {
            if (promoted) {
              if (ctx.getClientPc() !== probePc) return
              if (failAttempt) {
                failAttempt(epoch, reason || 'peer_failure')
              } else {
                ctx.setStatus?.('unstable')
              }
              return
            }
            finishProbe(false)
          },
          false,
          ctx.getClientHostSenderId(),
          { sessionTag: probeSessionId, holdLocalCandidates: true, allowTurn: false }
        )
        activeProbePc = probePc
        activeProbeSessionId = probeSessionId
        ctx.peerMgr.beginSilentUpgrade(probePc)
        registerProbePeer?.(probeSessionId, probePc)

        const probeDc = probePc.createDataChannel('scoutingpro-data')
        probeDcRef = probeDc
        const probeSender = new DataChannelSender(probeDc)
        probeDc.onmessage = (e) => {
          if (probeSettled && !promoted) return
          if (promoted) {
            void ctx.handleChannelMessage?.(e)
          } else {
            bufferedProbeMessages.push(e)
          }
        }

        probeDc.onopen = async () => {
          if (silentUpgradeSettleTimer) {
            clearTimeout(silentUpgradeSettleTimer)
            silentUpgradeSettleTimer = null
          }
          if (probeSettled) {
            try { probeDc.close() } catch {}
            return
          }
          if (epoch !== getAttemptEpoch() || ctx.getClientPc() !== pc || ctx.isExplicitlyClosed()) {
            finishProbe(false)
            return
          }
          const prevTransportInfo = ctx.peerMgr.currentTransportInfo
          await ctx.peerMgr.updateTransportInfo(probePc!)
          if (
            probeSettled ||
            !probePc ||
            probePc.connectionState === 'closed' ||
            probeDc.readyState !== 'open' ||
            epoch !== getAttemptEpoch() ||
            ctx.getClientPc() !== pc ||
            ctx.isExplicitlyClosed()
          ) {
            bufferedProbeMessages.length = 0
            const stillCurrentAttempt =
              epoch === getAttemptEpoch() && ctx.getClientPc() === pc && !ctx.isExplicitlyClosed()
            if (stillCurrentAttempt) {
              ctx.peerMgr.currentTransportInfo = prevTransportInfo
              void ctx.peerMgr.updateTransportInfo(pc)
            }
            if (probeSettled) {
              try { probeDc.close() } catch {}
              if (stillCurrentAttempt) {
                void checkAndScheduleSilentUpgrade()
              }
            } else {
              finishProbe(false)
            }
            return
          }
          const upgradedType = ctx.peerMgr.currentTransportInfo?.type
          unregisterProbePeer?.(probeSessionId)
          activeProbeSessionId = null
          activeProbePc = null
          ctx.peerMgr.endSilentUpgrade(probePc)

          promoted = true
          if (promoteProbeConnection) {
            promoteProbeConnection(probePc!, probeDc, probeSender, probeSessionId)
          } else {
            try { dc.onclose = null; dc.close() } catch {}
            try {
              pc.onicecandidate = null
              pc.oniceconnectionstatechange = null
              pc.onconnectionstatechange = null
              pc.close()
            } catch {}
            probeDc.onmessage = (e) => ctx.handleChannelMessage?.(e)
            ctx.setClientPc?.(probePc!)
            ctx.setClientDc?.(probeDc)
            ctx.setClientSender?.(probeSender)
            ctx.setClientSessionId?.(probeSessionId)
          }
          const pendingMsgs = bufferedProbeMessages.splice(0)
          for (const msgEv of pendingMsgs) {
            void ctx.handleChannelMessage?.(msgEv)
          }
          finishProbe(true, upgradedType)
        }

        const offer = await probePc.createOffer()
        if (epoch !== getAttemptEpoch() || ctx.getClientPc() !== pc || probeSettled) {
          finishProbe(false)
          return
        }
        await probePc.setLocalDescription(offer)
        if (epoch !== getAttemptEpoch() || ctx.getClientPc() !== pc || probeSettled) {
          finishProbe(false)
          return
        }
        const finalizedProbeSdp = await ctx.peerMgr.finalizeLocalSdp(
          probePc,
          probePc?.localDescription?.sdp || offer.sdp || ''
        )
        if (epoch !== getAttemptEpoch() || ctx.getClientPc() !== pc || probeSettled) {
          finishProbe(false)
          return
        }

        const rawOffer = {
          type: offer.type,
          sdp: finalizedProbeSdp,
          deviceId: ctx.getLocalDeviceId(),
          username: ctx.getUsername?.() || '',
          userId: ctx.getUserId?.() || '',
          allowTurn: false,
          forceRelay: false,
          silentUpgradeProbe: true
        }
        let offerPayload: any = rawOffer
        if (ctx.sas.clientSharedAesKey) {
          try {
            offerPayload = await encryptSignalingData(ctx.sas.clientSharedAesKey, JSON.stringify(rawOffer))
          } catch (err) {
            log.warn('Failed to encrypt silent upgrade probe offer, sending plaintext fallback:', err)
          }
        }
        ctx.getSignaling()?.send(
          {
            offer: offerPayload,
            ecdhPublicKey: ctx.getLocalEcdhPubHex(),
            deviceId: ctx.getLocalDeviceId(),
            clientSessionId: probeSessionId,
            hostSessionId: ctx.getCurrentHostSessionId(),
            username: ctx.getUsername?.() || '',
            userId: ctx.getUserId?.() || '',
            allowTurn: false,
            forceRelay: false,
            silentUpgradeProbe: true
          },
          ctx.getClientHostSenderId()
        )
        ctx.peerMgr.releaseLocalCandidates(probePc)

        silentUpgradeSettleTimer = setTimeout(() => {
          finishProbe(false)
        }, SILENT_UPGRADE.SETTLE_MS)
      } catch (err) {
        log.warn('[WebRTC Client] Non-destructive TURN-to-Direct probe failed:', err)
        finishProbe(false)
      }
      return
    }

    log.info(
      `[WebRTC Client] Executing silent in-place ICE restart probe #${probeSeq} (baseline transport: ${curInfo?.type || 'unknown'})`
    )

    ctx.peerMgr.beginSilentUpgrade(pc)
    ctx.peerMgr.holdLocalCandidates(pc)

    try {
      try {
        if (typeof pc.setConfiguration === 'function') {
          pc.setConfiguration(buildIceConfiguration(false, false))
        }
      } catch {}

      const offer = await pc.createOffer({ iceRestart: true })
      if (epoch !== getAttemptEpoch() || ctx.getClientPc() !== pc) {
        ctx.peerMgr.endSilentUpgrade(pc)
        isSilentUpgradeInFlight = false
        return
      }

      await pc.setLocalDescription(offer)
      if (epoch !== getAttemptEpoch() || ctx.getClientPc() !== pc) {
        ctx.peerMgr.endSilentUpgrade(pc)
        isSilentUpgradeInFlight = false
        return
      }

      const finalizedRestartSdp = await ctx.peerMgr.finalizeLocalSdp(
        pc,
        pc?.localDescription?.sdp || offer.sdp || ''
      )
      if (epoch !== getAttemptEpoch() || ctx.getClientPc() !== pc) {
        ctx.peerMgr.endSilentUpgrade(pc)
        isSilentUpgradeInFlight = false
        return
      }

      const rawOffer = {
        type: offer.type,
        sdp: finalizedRestartSdp,
        deviceId: ctx.getLocalDeviceId(),
        username: ctx.getUsername?.() || '',
        userId: ctx.getUserId?.() || '',
        allowTurn: false,
        forceRelay: false,
        iceRestart: true
      }

      let offerPayload: any = rawOffer
      if (ctx.sas.clientSharedAesKey) {
        try {
          offerPayload = await encryptSignalingData(ctx.sas.clientSharedAesKey, JSON.stringify(rawOffer))
        } catch (err) {
          log.warn('Failed to encrypt silent upgrade offer, sending plaintext fallback:', err)
        }
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
          forceRelay: false,
          iceRestart: true
        },
        ctx.getClientHostSenderId()
      )

      ctx.peerMgr.releaseLocalCandidates(pc)

      const startTime = Date.now()
      let upgradeFinished = false

      const finishUpgrade = (succeeded: boolean, newType?: string) => {
        if (upgradeFinished) return
        upgradeFinished = true
        if (silentUpgradeSettleTimer) {
          clearTimeout(silentUpgradeSettleTimer)
          silentUpgradeSettleTimer = null
        }
        if (silentUpgradeSettlePollTimer) {
          clearInterval(silentUpgradeSettlePollTimer)
          silentUpgradeSettlePollTimer = null
        }
        ctx.peerMgr.endSilentUpgrade(pc)
        isSilentUpgradeInFlight = false

        if (succeeded) {
          log.info(`[WebRTC Client] Silent upgrade SUCCEEDED! Upgraded to ${newType} (in ${Date.now() - startTime}ms)`)
          if (getTransportTier(newType as any) >= 2) {
            clearSilentUpgradeTimers()
          } else {
            void checkAndScheduleSilentUpgrade()
          }
        } else {
          log.info(`[WebRTC Client] Silent upgrade #${probeSeq} finished without path improvement. Maintaining existing transport.`)
          void checkAndScheduleSilentUpgrade()
        }
      }

      silentUpgradeSettlePollTimer = setInterval(async () => {
        if (epoch !== getAttemptEpoch() || ctx.getClientPc() !== pc) {
          finishUpgrade(false)
          return
        }
        await ctx.peerMgr.updateTransportInfo(pc)
        const newInfo = ctx.peerMgr.currentTransportInfo
        const newTier = getTransportTier(newInfo?.type)
        if (newTier > baselineTier) {
          finishUpgrade(true, newInfo?.type)
        }
      }, SILENT_UPGRADE.SETTLE_POLL_MS)

      silentUpgradeSettleTimer = setTimeout(() => {
        finishUpgrade(false)
      }, SILENT_UPGRADE.SETTLE_MS)
    } catch (err) {
      log.warn(`[WebRTC Client] Silent upgrade offer creation failed:`, err)
      ctx.peerMgr.endSilentUpgrade(pc)
      isSilentUpgradeInFlight = false
      void checkAndScheduleSilentUpgrade()
    }
  }

  return {
    checkAndScheduleSilentUpgrade,
    clearSilentUpgradeTimers,
    resetSilentUpgradeState
  }
}
