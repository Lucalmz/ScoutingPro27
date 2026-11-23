import type { ConnectionStatus, ScoutingEvent } from '@/types'
import type { DataChannelSender } from '@/services/dataChannelSender'
import type { ClientEntry, WebRtcCallbacks } from './types'
import type { EpochBeaconPayload, SignalingChannel } from './signaling'
import type { PeerConnectionManager } from './peerManager'
import {
  getEpochWitnessRecord,
  getHighestSeenEpoch,
  saveEpochWitnessRecord,
  type EventEpochWitnessRecord
} from './epochStore'
import { createLogger } from '@/utils/logger'
import { isMobileDevice } from '@/composables/useIsMobile'

const log = createLogger('WebRTC:Election')

/**
 * 确定性全序主机权威比较器 (Deterministic Total-Order Host Authority Comparator)
 * 返回值:
 *   > 0: A 的权威高于 B (A 胜出保持/当选主机，B 必须降级从机)
 *   < 0: B 的权威高于 A (B 胜出，A 必须降级从机)
 *   = 0: 同一会话
 */
export function compareHostAuthority(
  epochA: number,
  deviceIdA: string,
  sessionIdA: string,
  epochB: number,
  deviceIdB: string,
  sessionIdB: string
): number {
  // 1. 任期号优先：高任期号绝对压制低任期号
  if (epochA !== epochB) {
    return epochA - epochB
  }
  // 2. 仲裁第一平局项：SessionId 字典序 (更小更早创设的先占会话权威更高)
  const sessionCmp = sessionIdB.localeCompare(sessionIdA)
  if (sessionCmp !== 0) {
    return sessionCmp
  }
  // 3. 仲裁第二平局项：设备 ID 字典序
  return deviceIdB.localeCompare(deviceIdA)
}

export interface HostElectionControllerDeps {
  getSignaling: () => SignalingChannel | null
  getIsHostMode: () => boolean
  setIsHostMode: (val: boolean) => void
  getHostSessionId: () => string
  setHostSessionId: (id: string) => void
  setCurrentHostSessionId: (id: string) => void
  getLocalDeviceId: () => string
  getLocalEcdhPubHex: () => string
  getHostIpv6: () => string | null | undefined
  getCurrentInviteCode: () => string
  getCurrentEventMetadata: () => ScoutingEvent | null
  getMaxKnownHlcPt?: () => number
  onWitnessMetadataDiscovered?: (witness: EventEpochWitnessRecord) => void | Promise<void>
  onHostClockAlignWithWitnesses?: (witnessPts: number[]) => void
  resolveCurrentUsername: () => string
  resolveCurrentUserId: () => string
  getClientPc: () => RTCPeerConnection | null
  getClientDc: () => RTCDataChannel | null
  setClientSender: (sender: DataChannelSender | null) => void
  clients: Map<string, ClientEntry>
  stagedClients: Map<string, ClientEntry>
  scoutIdToClientIds: Map<string, Set<string>>
  clientIdToScoutId: Map<string, string>
  clientIdToScoutName: Map<string, string>
  hostQueues: Map<string, Promise<void>>
  preOfferCandidates: Map<string, any[]>
  peerMgr: PeerConnectionManager
  setStatus: (s: ConnectionStatus) => void
  updateHostStatus: () => void
  callbacks: WebRtcCallbacks
  clientSession: {
    setupClientConnection: (forceRelay?: boolean) => Promise<void>
    handleClientSignalingMessage: (data: any) => Promise<void>
    stopDataChannelHeartbeat: () => void
    hardResetChannels: () => void
  }
  hostSignalingHandler: (data: any) => void
}

/**
 * 主备选举、分赛事 Epoch Fencing 控制面、Witness 发现与信令仲裁控制器
 */
export function createHostElectionController(deps: HostElectionControllerDeps) {
  let isStandbyHostMode = false
  let isProbing = false
  let probeTimer: any = null
  let hostHeartbeatTimer: any = null
  let standbyWatchdogTimer: any = null
  let lastActiveHostHeartbeat = 0
  let activeHostSessionId = ''
  let activeHostDeviceId = ''

  let localEpoch = 0
  let priorStoredHostDeviceId = ''
  let maxDiscoveredEpoch = 0
  let discoveredDifferentHostDevice = false
  let collectedWitnessPts: number[] = []

  function currentInviteCode(): string {
    return (deps.getCurrentInviteCode() || '').trim().toUpperCase()
  }

  function persistEpochToStore(ep: number, extra?: Partial<EventEpochWitnessRecord>) {
    const code = currentInviteCode()
    if (!code) return
    const meta = deps.getCurrentEventMetadata()
    saveEpochWitnessRecord({
      inviteCode: code,
      authoritativeEventId: extra?.authoritativeEventId ?? meta?.id ?? '',
      eventName: extra?.eventName ?? meta?.name ?? '',
      hostUserId: extra?.hostUserId ?? meta?.hostId ?? '',
      ftcYear: extra?.ftcYear ?? meta?.ftcYear,
      ftcEventCode: extra?.ftcEventCode ?? meta?.ftcEventCode,
      highestSeenEpoch: ep,
      activeHostSessionId: extra?.activeHostSessionId,
      activeHostDeviceId: extra?.activeHostDeviceId
    })
  }

  function setLocalEpoch(ep: number, extra?: Partial<EventEpochWitnessRecord>) {
    localEpoch = Math.max(0, Math.floor(ep))
    persistEpochToStore(localEpoch, extra)
  }

  function effectiveHighestSeenEpoch(): number {
    const code = currentInviteCode()
    const storedMax = code ? getHighestSeenEpoch(code) : 0
    return Math.max(localEpoch, maxDiscoveredEpoch, storedMax)
  }

  function publishRetainedEpochBeacon(ep: number) {
    const signaling = deps.getSignaling()
    const code = currentInviteCode()
    if (!signaling || !code) return
    const meta = deps.getCurrentEventMetadata()
    void signaling
      .publishEpochBeacon({
        inviteCode: code,
        hostEpoch: ep,
        hostSessionId: deps.getHostSessionId(),
        hostDeviceId: deps.getLocalDeviceId(),
        hostUserId: meta?.hostId || deps.resolveCurrentUserId(),
        authoritativeEventId: meta?.id || '',
        eventName: meta?.name || '',
        ftcYear: meta?.ftcYear,
        ftcEventCode: meta?.ftcEventCode
      })
      .catch((err) => log.warn('Failed to publish retained epoch beacon:', err))
  }

  function sendSupersededNotice(targetSenderId: string | undefined, currentEp: number, activeSess?: string, activeDev?: string) {
    const signaling = deps.getSignaling()
    if (!signaling || !targetSenderId) return
    void signaling
      .send(
        {
          type: 'epoch_superseded',
          currentEpoch: currentEp,
          activeHostSessionId: activeSess ?? deps.getHostSessionId(),
          activeHostDeviceId: activeDev ?? deps.getLocalDeviceId()
        },
        targetSenderId
      )
      .catch(() => {})
  }

  function buildEpochWitnessPayload() {
    const code = currentInviteCode()
    const stored = code ? getEpochWitnessRecord(code) : null
    const meta = deps.getCurrentEventMetadata()
    const effectiveMaxEpoch = Math.max(localEpoch, stored?.highestSeenEpoch ?? 0)
    return {
      type: 'epoch_witness',
      inviteCode: code,
      highestEpoch: effectiveMaxEpoch,
      authoritativeEventId: stored?.authoritativeEventId || meta?.id || '',
      eventName: stored?.eventName || meta?.name || '',
      hostUserId: stored?.hostUserId || meta?.hostId || '',
      ftcYear: stored?.ftcYear ?? meta?.ftcYear,
      ftcEventCode: stored?.ftcEventCode ?? meta?.ftcEventCode,
      activeHostSessionId: stored?.activeHostSessionId || activeHostSessionId || '',
      activeHostDeviceId: stored?.activeHostDeviceId || activeHostDeviceId || '',
      maxKnownHlcPt: deps.getMaxKnownHlcPt?.() ?? 0,
      deviceId: deps.getLocalDeviceId()
    }
  }

  function startHostHeartbeat() {
    stopHostHeartbeat()
    const payload = {
      type: 'host_heartbeat',
      hostSessionId: deps.getHostSessionId(),
      deviceId: deps.getLocalDeviceId(),
      ecdhPublicKey: deps.getLocalEcdhPubHex(),
      timestamp: Date.now(),
      hostEpoch: localEpoch,
      username: deps.resolveCurrentUsername(),
      userId: deps.resolveCurrentUserId()
    }
    const signaling = deps.getSignaling()
    if (deps.getIsHostMode() && signaling) {
      signaling.send(payload)
    }
    hostHeartbeatTimer = setInterval(() => {
      const curSignaling = deps.getSignaling()
      if (deps.getIsHostMode() && curSignaling) {
        curSignaling.send({
          ...payload,
          hostSessionId: deps.getHostSessionId(),
          deviceId: deps.getLocalDeviceId(),
          ecdhPublicKey: deps.getLocalEcdhPubHex(),
          timestamp: Date.now(),
          hostEpoch: localEpoch,
          username: deps.resolveCurrentUsername(),
          userId: deps.resolveCurrentUserId()
        })
      }
    }, 3000)
  }

  function stopHostHeartbeat() {
    if (hostHeartbeatTimer) {
      clearInterval(hostHeartbeatTimer)
      hostHeartbeatTimer = null
    }
  }

  function startStandbyWatchdog() {
    lastActiveHostHeartbeat = Date.now()
    if (!standbyWatchdogTimer) {
      const timeoutMs = (globalThis as any).__TEST_WATCHDOG_TIMEOUT_MS__ ?? 5000
      const checkIntervalMs = (globalThis as any).__TEST_WATCHDOG_INTERVAL_MS__ ?? 2000
      standbyWatchdogTimer = setInterval(() => {
        if (isStandbyHostMode && lastActiveHostHeartbeat > 0 && Date.now() - lastActiveHostHeartbeat > timeoutMs) {
          log.warn(`[Standby Watchdog] Active host heartbeat missing for >${timeoutMs}ms, notifying active host left`)
          deps.peerMgr.resetTransportInfo()
          deps.setStatus('degraded')
          deps.callbacks.onActiveHostLeft?.()
        }
      }, checkIntervalMs)
    }
  }

  function stopStandbyWatchdog() {
    if (standbyWatchdogTimer) {
      clearInterval(standbyWatchdogTimer)
      standbyWatchdogTimer = null
    }
    lastActiveHostHeartbeat = 0
  }

  function clearProbeTimer() {
    if (probeTimer) {
      clearTimeout(probeTimer)
      probeTimer = null
    }
  }

  async function enterStandbyMode(existingHostSessionId: string, existingDeviceId?: string) {
    if (isMobileDevice()) {
      log.info('Mobile device ignored enterStandbyMode; strictly acting as scout client.')
      return
    }
    log.info(`Entering standby mode. Existing active host: ${existingHostSessionId}`)
    stopHostHeartbeat()
    startStandbyWatchdog()
    clearProbeTimer()
    isProbing = false
    deps.setIsHostMode(false)
    isStandbyHostMode = true
    activeHostSessionId = existingHostSessionId
    deps.setCurrentHostSessionId(existingHostSessionId)
    activeHostDeviceId = existingDeviceId || ''
    if (localEpoch > 0) {
      persistEpochToStore(localEpoch, {
        activeHostSessionId: existingHostSessionId,
        activeHostDeviceId: existingDeviceId
      })
    }
    deps.callbacks.onHostStandby?.({ hostSessionId: existingHostSessionId, hostDeviceId: existingDeviceId })

    const localEcdhPubHex = deps.getLocalEcdhPubHex()
    if (localEcdhPubHex) {
      deps.getSignaling()?.send({ type: 'client_hello', ecdhPublicKey: localEcdhPubHex, deviceId: deps.getLocalDeviceId() })
    }
    const clientPc = deps.getClientPc()
    const clientDc = deps.getClientDc()
    const isConnectedAndOpen = clientPc && clientPc.connectionState === 'connected' && clientDc && clientDc.readyState === 'open'
    if (!isConnectedAndOpen) {
      await deps.clientSession.setupClientConnection()
    }
  }

  async function demoteToStandby(newHostSessionId: string, newDeviceId?: string) {
    if (isMobileDevice()) {
      log.info('Mobile device ignored demoteToStandby.')
      return
    }
    log.info(`Demoted to Standby by new host: ${newHostSessionId}`)
    stopHostHeartbeat()
    startStandbyWatchdog()
    clearProbeTimer()
    isProbing = false
    deps.setIsHostMode(false)
    isStandbyHostMode = true
    activeHostSessionId = newHostSessionId
    deps.setCurrentHostSessionId(newHostSessionId)
    activeHostDeviceId = newDeviceId || ''
    if (localEpoch > 0) {
      persistEpochToStore(localEpoch, {
        activeHostSessionId: newHostSessionId,
        activeHostDeviceId: newDeviceId
      })
    }

    deps.clients.forEach((c) => {
      if (c.dc) c.dc.onclose = null
      c.pc.onconnectionstatechange = null
      c.pc.oniceconnectionstatechange = null
      c.dc?.close()
      c.pc.close()
    })
    deps.clients.clear()
    deps.stagedClients.forEach((c) => {
      if (c.dc) c.dc.onclose = null
      c.pc.onconnectionstatechange = null
      c.pc.oniceconnectionstatechange = null
      c.dc?.close()
      c.pc.close()
    })
    deps.stagedClients.clear()
    deps.scoutIdToClientIds.clear()
    deps.clientIdToScoutId.clear()
    deps.clientIdToScoutName.clear()
    deps.hostQueues.clear()
    deps.preOfferCandidates.clear()

    deps.callbacks.onHostDemoted?.({ hostSessionId: newHostSessionId, hostDeviceId: newDeviceId })

    const localEcdhPubHex = deps.getLocalEcdhPubHex()
    if (localEcdhPubHex) {
      deps.getSignaling()?.send({ type: 'client_hello', ecdhPublicKey: localEcdhPubHex, deviceId: deps.getLocalDeviceId() })
    }
    await deps.clientSession.setupClientConnection()
  }

  async function takeoverHost(): Promise<void> {
    if (isMobileDevice()) {
      log.warn('Mobile devices are strictly prohibited from acting as host or taking over host.')
      return
    }
    log.info('Standby device initiating takeover to become Active Host!')
    stopStandbyWatchdog()
    deps.clientSession.stopDataChannelHeartbeat()
    deps.peerMgr.resetTransportInfo()
    deps.setStatus('waiting')
    const newHostSessionId = `host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    deps.setHostSessionId(newHostSessionId)
    const nextEpoch = effectiveHighestSeenEpoch() + 1
    setLocalEpoch(nextEpoch, {
      activeHostSessionId: newHostSessionId,
      activeHostDeviceId: deps.getLocalDeviceId()
    })

    const signaling = deps.getSignaling()
    await signaling?.send({
      type: 'host_takeover',
      oldHostSessionId: activeHostSessionId,
      newHostSessionId,
      deviceId: deps.getLocalDeviceId(),
      hostEpoch: nextEpoch,
      username: deps.resolveCurrentUsername(),
      userId: deps.resolveCurrentUserId()
    })

    deps.clientSession.hardResetChannels()
    deps.setClientSender(null)

    deps.scoutIdToClientIds.clear()
    deps.clientIdToScoutId.clear()
    deps.clientIdToScoutName.clear()
    deps.hostQueues.clear()
    deps.preOfferCandidates.clear()

    isStandbyHostMode = false
    deps.setIsHostMode(true)

    await signaling?.send({
      type: 'host_hello',
      hostSessionId: newHostSessionId,
      hostIpv6: deps.getHostIpv6() || undefined,
      ecdhPublicKey: deps.getLocalEcdhPubHex(),
      deviceId: deps.getLocalDeviceId(),
      hostEpoch: nextEpoch,
      username: deps.resolveCurrentUsername(),
      userId: deps.resolveCurrentUserId()
    })
    publishRetainedEpochBeacon(nextEpoch)
    startHostHeartbeat()
    deps.callbacks.onHostPromoted?.()
    deps.updateHostStatus()
  }

  async function handleEpochBeacon(beacon: EpochBeaconPayload): Promise<void> {
    if (!beacon || typeof beacon.hostEpoch !== 'number') return
    const code = currentInviteCode()
    const merged = saveEpochWitnessRecord({
      inviteCode: beacon.inviteCode || code,
      authoritativeEventId: beacon.authoritativeEventId,
      eventName: beacon.eventName,
      hostUserId: beacon.hostUserId,
      ftcYear: beacon.ftcYear,
      ftcEventCode: beacon.ftcEventCode,
      highestSeenEpoch: beacon.hostEpoch,
      activeHostSessionId: beacon.hostSessionId,
      activeHostDeviceId: beacon.hostDeviceId
    })
    if (beacon.authoritativeEventId) {
      await deps.onWitnessMetadataDiscovered?.(merged)
    }

    maxDiscoveredEpoch = Math.max(maxDiscoveredEpoch, beacon.hostEpoch)
    if (beacon.hostDeviceId && beacon.hostDeviceId !== deps.getLocalDeviceId()) {
      discoveredDifferentHostDevice = true
    }

    if (
      deps.getIsHostMode() &&
      !isProbing &&
      beacon.hostEpoch > localEpoch &&
      beacon.hostSessionId &&
      beacon.hostSessionId !== deps.getHostSessionId()
    ) {
      log.warn(
        `Fenced by retained epoch_beacon (${beacon.hostEpoch} > local ${localEpoch}); demoting to Standby behind ${beacon.hostSessionId}`
      )
      setLocalEpoch(beacon.hostEpoch, {
        activeHostSessionId: beacon.hostSessionId,
        activeHostDeviceId: beacon.hostDeviceId
      })
      await demoteToStandby(beacon.hostSessionId, beacon.hostDeviceId)
    }
  }

  function createHostSignalingMessageHandler(sessionStartTime: number) {
    return async (data: any) => {
      if (!data) return
      const signaling = deps.getSignaling()
      const hostSessionId = deps.getHostSessionId()
      const localDeviceId = deps.getLocalDeviceId()
      const localEcdhPubHex = deps.getLocalEcdhPubHex()

      // 0. Handle HOST_DISCOVERY (both active host reaffirmation/fencing & standby witness reply)
      if (data.type === 'host_discovery') {
        if (data.sender === signaling?.clientId || data.hostSessionId === hostSessionId) {
          return
        }
        if (deps.getIsHostMode() && !isStandbyHostMode && !isProbing) {
          const reqKnownEpoch = Number(data.knownEpoch ?? 0) || 0
          if (reqKnownEpoch > 0 && reqKnownEpoch < localEpoch) {
            sendSupersededNotice(data.sender, localEpoch, hostSessionId, localDeviceId)
          }
          await signaling?.send(buildEpochWitnessPayload(), data.sender)
          await signaling?.send(
            {
              type: 'host_heartbeat',
              hostSessionId,
              deviceId: localDeviceId,
              ecdhPublicKey: localEcdhPubHex,
              timestamp: Date.now(),
              hostEpoch: localEpoch,
              username: deps.resolveCurrentUsername(),
              userId: deps.resolveCurrentUserId()
            },
            data.sender
          )
        } else if (isStandbyHostMode) {
          await signaling?.send(buildEpochWitnessPayload(), data.sender)
        }
        return
      }

      // 0b. Handle EPOCH_WITNESS
      if (data.type === 'epoch_witness') {
        if (data.sender === signaling?.clientId) return
        const incomingEpoch = Number(data.highestEpoch ?? data.hostEpoch ?? 0) || 0
        const code = currentInviteCode()
        if (code && incomingEpoch > 0) {
          const merged = saveEpochWitnessRecord({
            inviteCode: code,
            authoritativeEventId: data.authoritativeEventId,
            eventName: data.eventName,
            hostUserId: data.hostUserId,
            ftcYear: data.ftcYear,
            ftcEventCode: data.ftcEventCode,
            highestSeenEpoch: incomingEpoch,
            activeHostSessionId: data.activeHostSessionId,
            activeHostDeviceId: data.activeHostDeviceId
          })
          if (data.authoritativeEventId || data.hostUserId) {
            await deps.onWitnessMetadataDiscovered?.(merged)
          }
        }
        if (incomingEpoch > maxDiscoveredEpoch) {
          maxDiscoveredEpoch = incomingEpoch
        }
        if (data.activeHostDeviceId && data.activeHostDeviceId !== localDeviceId) {
          discoveredDifferentHostDevice = true
        }
        const maxPt = Number(data.maxKnownHlcPt ?? 0)
        if (Number.isFinite(maxPt) && maxPt > 0) {
          collectedWitnessPts.push(maxPt)
        }

        if (
          deps.getIsHostMode() &&
          !isProbing &&
          !isStandbyHostMode &&
          incomingEpoch > localEpoch &&
          data.activeHostSessionId &&
          data.activeHostSessionId !== hostSessionId
        ) {
          log.warn(`Witness reported newer host epoch (${incomingEpoch} > local ${localEpoch}); demoting to Standby`)
          setLocalEpoch(incomingEpoch, {
            activeHostSessionId: data.activeHostSessionId,
            activeHostDeviceId: data.activeHostDeviceId
          })
          await demoteToStandby(data.activeHostSessionId, data.activeHostDeviceId)
        }
        return
      }

      // 0c. Handle EPOCH_SUPERSEDED (Fencing Suppression)
      if (data.type === 'epoch_superseded') {
        if (data.sender === signaling?.clientId) return
        const supersededEpoch = Number(data.currentEpoch ?? data.hostEpoch ?? 0) || 0
        const activeSess = String(data.activeHostSessionId || data.sender || '')
        const activeDev = data.activeHostDeviceId ? String(data.activeHostDeviceId) : undefined
        if (supersededEpoch <= 0) return

        const shouldYield =
          supersededEpoch > localEpoch || (isProbing && supersededEpoch >= localEpoch)
        if (shouldYield && activeSess && activeSess !== hostSessionId) {
          log.warn(
            `Received EPOCH_SUPERSEDED (${supersededEpoch} >= local ${localEpoch}) from ${data.sender}; yielding to ${activeSess}`
          )
          setLocalEpoch(supersededEpoch, {
            activeHostSessionId: activeSess,
            activeHostDeviceId: activeDev
          })
          if (isProbing) {
            clearProbeTimer()
            isProbing = false
            await enterStandbyMode(activeSess, activeDev)
          } else if (deps.getIsHostMode() && !isStandbyHostMode) {
            await demoteToStandby(activeSess, activeDev)
          }
        }
        return
      }

      // 1. When another device is actively probing, if this device is the Active Host, reply immediately!
      if (data.type === 'host_probe') {
        if (data.sender === signaling?.clientId || data.hostSessionId === hostSessionId) {
          return
        }
        if (deps.getIsHostMode() && !isStandbyHostMode && data.hostSessionId !== hostSessionId) {
          await signaling?.send({
            type: 'host_heartbeat',
            hostSessionId,
            deviceId: localDeviceId,
            ecdhPublicKey: localEcdhPubHex,
            timestamp: Date.now(),
            hostEpoch: localEpoch,
            username: deps.resolveCurrentUsername(),
            userId: deps.resolveCurrentUserId()
          })
        }
        return
      }

      if (isProbing) {
        if (
          (data.type === 'host_heartbeat' || data.type === 'host_hello') &&
          data.hostSessionId !== hostSessionId
        ) {
          if (data.sender === signaling?.clientId) {
            return
          }
          // Stale messages from own device's prior session (e.g. before page reload) must NOT trigger standby demotion
          if (data.deviceId && data.deviceId === localDeviceId) {
            const msgTs = Number(data.timestamp || 0)
            if (msgTs && msgTs < sessionStartTime - 100) {
              log.info(`Ignoring stale host message from same device prior session during probe: ${data.hostSessionId}`)
              return
            }
          }
          // Fencing check even during probe: if a zombie host speaks with epoch strictly lower than known epoch, reject and supersede it!
          const hasProbeIncomingEpoch = data.hostEpoch !== undefined && data.hostEpoch !== null
          const incomingEpoch = hasProbeIncomingEpoch ? Number(data.hostEpoch) : 0
          const highestKnown = effectiveHighestSeenEpoch()
          if (hasProbeIncomingEpoch && incomingEpoch > 0 && incomingEpoch < highestKnown) {
            log.warn(
              `Fenced stale host during probe (incoming epoch=${incomingEpoch} < known=${highestKnown}, sender=${data.hostSessionId})`
            )
            sendSupersededNotice(data.sender, highestKnown)
            return
          }

          if (incomingEpoch > 0) {
            setLocalEpoch(Math.max(localEpoch, incomingEpoch), {
              activeHostSessionId: data.hostSessionId,
              activeHostDeviceId: data.deviceId
            })
          }
          log.info(`Discovered existing host during probe: ${data.hostSessionId} (sender: ${data.sender})`)
          clearProbeTimer()
          isProbing = false
          await enterStandbyMode(data.hostSessionId, data.deviceId)
          return
        }
      }

      if (data.type === 'host_heartbeat' || data.type === 'host_hello') {
        const hasIncomingEpoch = data.hostEpoch !== undefined && data.hostEpoch !== null
        const incomingEpoch = hasIncomingEpoch ? Number(data.hostEpoch) : localEpoch
        const incomingDeviceId = String(data.deviceId ?? '')
        const incomingSessionId = String(data.hostSessionId ?? '')

        if (incomingSessionId && incomingSessionId !== hostSessionId) {
          if (data.sender === signaling?.clientId) {
            return
          }
          if (isStandbyHostMode) {
            const highestKnown = effectiveHighestSeenEpoch()
            if (hasIncomingEpoch && incomingEpoch > 0 && incomingEpoch < highestKnown) {
              log.warn(
                `Standby fenced obsolete host ${incomingSessionId} (epoch ${incomingEpoch} < known ${highestKnown})`
              )
              sendSupersededNotice(data.sender, highestKnown, activeHostSessionId, activeHostDeviceId)
              return
            }
            activeHostSessionId = incomingSessionId
            activeHostDeviceId = incomingDeviceId
            if (hasIncomingEpoch && incomingEpoch > 0) {
              setLocalEpoch(Math.max(localEpoch, incomingEpoch), {
                activeHostSessionId: incomingSessionId,
                activeHostDeviceId: incomingDeviceId
              })
            }
            lastActiveHostHeartbeat = Date.now()
            if (data.type === 'host_hello') {
              await deps.clientSession.handleClientSignalingMessage(data)
            }
            return
          }
          if (deps.getIsHostMode()) {
            const cmp = compareHostAuthority(
              localEpoch,
              localDeviceId,
              hostSessionId,
              incomingEpoch,
              incomingDeviceId,
              incomingSessionId
            )
            if (cmp < 0) {
              log.info(
                `Local host session yields to higher-authority host: ${incomingSessionId} (epoch ${incomingEpoch} vs local ${localEpoch})`
              )
              if (hasIncomingEpoch) {
                setLocalEpoch(incomingEpoch, {
                  activeHostSessionId: incomingSessionId,
                  activeHostDeviceId: incomingDeviceId
                })
              }
              await demoteToStandby(incomingSessionId, incomingDeviceId)
              return
            } else if (cmp > 0) {
              // Same-epoch split-brain tie-breaker winner bumps epoch by +1 to permanently fence loser
              if (hasIncomingEpoch && incomingEpoch === localEpoch && localEpoch > 0) {
                const bumped = localEpoch + 1
                log.info(
                  `Same-epoch tie-break won against ${incomingSessionId} at epoch ${localEpoch}; bumping to epoch ${bumped}`
                )
                setLocalEpoch(bumped, {
                  activeHostSessionId: hostSessionId,
                  activeHostDeviceId: localDeviceId
                })
                publishRetainedEpochBeacon(bumped)
              } else {
                log.warn(
                  `Suppressed lower-authority heartbeat/hello (epoch: ${incomingEpoch} vs local ${localEpoch}, sender: ${incomingSessionId})`
                )
              }
              sendSupersededNotice(data.sender, localEpoch, hostSessionId, localDeviceId)
              await signaling?.send({
                type: 'host_heartbeat',
                hostSessionId,
                deviceId: localDeviceId,
                ecdhPublicKey: localEcdhPubHex,
                timestamp: Date.now(),
                hostEpoch: localEpoch,
                username: deps.resolveCurrentUsername(),
                userId: deps.resolveCurrentUserId()
              })
              return
            }
          }
        }
        return
      }

      if (data.type === 'host_takeover') {
        if (data.sender === signaling?.clientId || data.newHostSessionId === hostSessionId) {
          return
        }
        const hasIncomingEpoch = data.hostEpoch !== undefined && data.hostEpoch !== null
        const incomingEpoch = Number(data.hostEpoch ?? 0)
        const incomingDeviceId = String(data.deviceId ?? '')
        const incomingSessionId = String(data.newHostSessionId ?? '')

        if (deps.getIsHostMode() && data.sender !== signaling?.clientId) {
          const cmp = compareHostAuthority(
            localEpoch,
            localDeviceId,
            hostSessionId,
            incomingEpoch,
            incomingDeviceId,
            incomingSessionId
          )

          const incomingWins = !hasIncomingEpoch || cmp < 0

          if (incomingWins) {
            log.info(
              `Yielding to higher-authority takeover: ${incomingSessionId} (epoch ${incomingEpoch} vs local ${localEpoch})`
            )
            setLocalEpoch(Math.max(localEpoch, incomingEpoch), {
              activeHostSessionId: incomingSessionId,
              activeHostDeviceId: incomingDeviceId
            })
            await demoteToStandby(incomingSessionId, incomingDeviceId)
            return
          } else {
            log.warn(
              `Suppressed lower-authority takeover (epoch: ${incomingEpoch} vs local ${localEpoch}, deviceId: ${incomingDeviceId} vs ${localDeviceId})`
            )
            sendSupersededNotice(data.sender, localEpoch, hostSessionId, localDeviceId)
            signaling?.send({
              type: 'host_hello',
              hostSessionId,
              ecdhPublicKey: localEcdhPubHex,
              deviceId: localDeviceId,
              hostEpoch: localEpoch,
              username: deps.resolveCurrentUsername(),
              userId: deps.resolveCurrentUserId()
            })
            return
          }
        } else {
          activeHostSessionId = incomingSessionId
          activeHostDeviceId = incomingDeviceId
          if (hasIncomingEpoch) {
            setLocalEpoch(Math.max(localEpoch, incomingEpoch), {
              activeHostSessionId: incomingSessionId,
              activeHostDeviceId: incomingDeviceId
            })
          }
          lastActiveHostHeartbeat = Date.now()
        }
        return
      }

      if (data.type === 'HOST_LEAVING') {
        if (data.sender === signaling?.clientId || data.hostSessionId === hostSessionId) {
          return
        }
        if (isStandbyHostMode && data.hostSessionId === activeHostSessionId) {
          deps.callbacks.onActiveHostLeft?.()
        }
        return
      }

      if (deps.getIsHostMode()) {
        deps.hostSignalingHandler(data)
      } else {
        await deps.clientSession.handleClientSignalingMessage(data)
      }
    }
  }

  function startHostProbeWindow() {
    const signaling = deps.getSignaling()
    if (!signaling) return
    const probeMs = (globalThis as any).__TEST_PROBE_MS__ ?? 1500
    isProbing = true

    const lastBeacon = signaling.getLastReceivedBeacon?.()
    if (lastBeacon && typeof lastBeacon.hostEpoch === 'number') {
      maxDiscoveredEpoch = Math.max(maxDiscoveredEpoch, lastBeacon.hostEpoch)
      if (lastBeacon.hostDeviceId && lastBeacon.hostDeviceId !== deps.getLocalDeviceId()) {
        discoveredDifferentHostDevice = true
      }
    }

    signaling.send({
      type: 'host_probe',
      hostSessionId: deps.getHostSessionId(),
      deviceId: deps.getLocalDeviceId(),
      hostEpoch: localEpoch
    })
    signaling.send({
      type: 'host_discovery',
      hostSessionId: deps.getHostSessionId(),
      deviceId: deps.getLocalDeviceId(),
      userId: deps.resolveCurrentUserId(),
      username: deps.resolveCurrentUsername(),
      knownEpoch: effectiveHighestSeenEpoch()
    })

    probeTimer = setTimeout(() => {
      if (isProbing) {
        isProbing = false
        probeTimer = null
        isStandbyHostMode = false
        deps.setIsHostMode(true)

        const code = currentInviteCode()
        const stored = code ? getEpochWitnessRecord(code) : null
        const priorMax = Math.max(localEpoch, maxDiscoveredEpoch, stored?.highestSeenEpoch ?? 0)
        const localDev = deps.getLocalDeviceId()
        const wasDifferentDevice =
          discoveredDifferentHostDevice ||
          Boolean(priorStoredHostDeviceId && localDev && priorStoredHostDeviceId !== localDev) ||
          Boolean(stored?.activeHostDeviceId && localDev && stored.activeHostDeviceId !== localDev)

        let promotedEpoch = 1
        if (priorMax === 0) {
          promotedEpoch = 1
        } else if (wasDifferentDevice || maxDiscoveredEpoch > localEpoch) {
          promotedEpoch = priorMax + 1
        } else {
          promotedEpoch = priorMax
        }

        if (collectedWitnessPts.length > 0) {
          deps.onHostClockAlignWithWitnesses?.(collectedWitnessPts)
        }

        setLocalEpoch(promotedEpoch, {
          activeHostSessionId: deps.getHostSessionId(),
          activeHostDeviceId: localDev
        })

        deps.updateHostStatus()
        deps.getSignaling()?.send({
          type: 'host_hello',
          hostSessionId: deps.getHostSessionId(),
          hostIpv6: deps.getHostIpv6() || undefined,
          ecdhPublicKey: deps.getLocalEcdhPubHex(),
          deviceId: localDev,
          hostEpoch: promotedEpoch,
          username: deps.resolveCurrentUsername(),
          userId: deps.resolveCurrentUserId()
        })
        publishRetainedEpochBeacon(promotedEpoch)
        startHostHeartbeat()
        deps.callbacks.onHostPromoted?.()
      }
    }, probeMs)
  }

  function prepareForHostStart() {
    clearProbeTimer()
    stopHostHeartbeat()
    stopStandbyWatchdog()
    isStandbyHostMode = false
    isProbing = true
    maxDiscoveredEpoch = 0
    discoveredDifferentHostDevice = false
    collectedWitnessPts = []
    const code = currentInviteCode()
    const stored = code ? getEpochWitnessRecord(code) : null
    priorStoredHostDeviceId = stored?.activeHostDeviceId || ''
    localEpoch = stored?.highestSeenEpoch ?? 0
  }

  function stopAllElectionTimers() {
    clearProbeTimer()
    isProbing = false
    stopHostHeartbeat()
    stopStandbyWatchdog()
    isStandbyHostMode = false
  }

  return {
    get isStandbyHostMode() {
      return isStandbyHostMode
    },
    getLocalEpoch: () => localEpoch,
    handleEpochBeacon,
    takeoverHost,
    createHostSignalingMessageHandler,
    startHostProbeWindow,
    prepareForHostStart,
    stopAllElectionTimers
  }
}
