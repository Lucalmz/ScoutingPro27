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
}

/**
 * Client 侧就地静默升级管理器（in-place ICE restart，不中断 DataChannel）
 */
export function createClientSilentUpgradeManager(deps: ClientSilentUpgradeDeps) {
  const { ctx, getAttemptEpoch, getProbeCount, incrementProbeCount } = deps
  let silentUpgradeTimer: ReturnType<typeof setTimeout> | null = null
  let silentUpgradeSettleTimer: ReturnType<typeof setTimeout> | null = null
  let silentUpgradeSettlePollTimer: ReturnType<typeof setInterval> | null = null
  let isSilentUpgradeInFlight = false

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

    isSilentUpgradeInFlight = true
    const probeSeq = incrementProbeCount()
    log.info(
      `[WebRTC Client] Executing silent in-place ICE restart probe #${probeSeq} (baseline transport: ${curInfo?.type || 'unknown'})`
    )

    ctx.peerMgr.beginSilentUpgrade(pc)
    ctx.peerMgr.holdLocalCandidates(pc)

    const epoch = getAttemptEpoch()
    const currentSessionId = ctx.getClientSessionId()

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
