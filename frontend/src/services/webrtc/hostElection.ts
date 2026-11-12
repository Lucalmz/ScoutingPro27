import type { ConnectionStatus } from '@/types'
import type { DataChannelSender } from '@/services/dataChannelSender'
import type { ClientEntry, WebRtcCallbacks } from './types'
import type { SignalingChannel } from './signaling'
import type { PeerConnectionManager } from './peerManager'
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
 * 主备选举、心跳看门狗、Takeover 交接对账门禁与信令仲裁控制器
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
  try {
    const savedEpoch = localStorage.getItem('scoutingpro_host_epoch')
    if (savedEpoch) localEpoch = parseInt(savedEpoch, 10) || 0
  } catch (_) {}

  function setLocalEpoch(ep: number) {
    localEpoch = ep
    try {
      localStorage.setItem('scoutingpro_host_epoch', String(ep))
    } catch (_) {}
  }

  let inTakeoverReconciliation = false
  let takeoverReconciliationResolvers: Array<() => void> = []
  let takeoverReconciliationTimer: any = null

  function startTakeoverReconciliation(timeoutMs = 2000) {
    inTakeoverReconciliation = true
    if (takeoverReconciliationTimer) clearTimeout(takeoverReconciliationTimer)
    takeoverReconciliationTimer = setTimeout(() => {
      finishTakeoverReconciliation('timeout')
    }, timeoutMs)
  }

  function finishTakeoverReconciliation(reason = 'completed') {
    if (!inTakeoverReconciliation) return
    console.log(`[WebRTC Host] Takeover reconciliation finished (${reason})`)
    inTakeoverReconciliation = false
    if (takeoverReconciliationTimer) {
      clearTimeout(takeoverReconciliationTimer)
      takeoverReconciliationTimer = null
    }
    const resolvers = [...takeoverReconciliationResolvers]
    takeoverReconciliationResolvers = []
    for (const resolve of resolvers) {
      try {
        resolve()
      } catch (e) {
        console.error(e)
      }
    }
  }

  function waitForTakeoverReconciliation(): Promise<void> {
    if (!inTakeoverReconciliation) return Promise.resolve()
    return new Promise((resolve) => {
      takeoverReconciliationResolvers.push(resolve)
    })
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
    deps.setIsHostMode(false)
    isStandbyHostMode = true
    activeHostSessionId = newHostSessionId
    deps.setCurrentHostSessionId(newHostSessionId)
    activeHostDeviceId = newDeviceId || ''

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
    const nextEpoch = localEpoch + 1
    setLocalEpoch(nextEpoch)
    startTakeoverReconciliation(2000)

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
    startHostHeartbeat()
    deps.callbacks.onHostPromoted?.()
    deps.updateHostStatus()
  }

  function createHostSignalingMessageHandler(sessionStartTime: number) {
    return async (data: any) => {
      if (!data) return
      const signaling = deps.getSignaling()
      const hostSessionId = deps.getHostSessionId()
      const localDeviceId = deps.getLocalDeviceId()
      const localEcdhPubHex = deps.getLocalEcdhPubHex()

      // When another device is actively probing, if this device is the Active Host, reply immediately!
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
            activeHostSessionId = incomingSessionId
            activeHostDeviceId = incomingDeviceId
            if (hasIncomingEpoch) {
              setLocalEpoch(Math.max(localEpoch, incomingEpoch))
            }
            lastActiveHostHeartbeat = Date.now()
            if (data.type === 'host_hello') {
              await deps.clientSession.handleClientSignalingMessage(data)
            }
            return
          }
          if (deps.getIsHostMode()) {
            // 使用严格全序比较器判定胜负，杜绝低 Epoch 旧心跳错误降级新任期主机！
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
                setLocalEpoch(incomingEpoch)
              }
              await demoteToStandby(incomingSessionId, incomingDeviceId)
              return
            } else if (cmp > 0) {
              // 本地主机权威更高，压制低权威对端并重发心跳通知其降级
              log.warn(
                `Suppressed lower-authority heartbeat/hello (epoch: ${incomingEpoch} vs local ${localEpoch}, sender: ${incomingSessionId})`
              )
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
            setLocalEpoch(Math.max(localEpoch, incomingEpoch))
            await demoteToStandby(incomingSessionId, incomingDeviceId)
            return
          } else {
            log.warn(
              `Suppressed lower-authority takeover (epoch: ${incomingEpoch} vs local ${localEpoch}, deviceId: ${incomingDeviceId} vs ${localDeviceId})`
            )
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
            setLocalEpoch(Math.max(localEpoch, incomingEpoch))
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
    const probeMs = (globalThis as any).__TEST_PROBE_MS__ ?? 1200
    isProbing = true
    signaling.send({
      type: 'host_probe',
      hostSessionId: deps.getHostSessionId(),
      deviceId: deps.getLocalDeviceId()
    })
    probeTimer = setTimeout(() => {
      if (isProbing) {
        isProbing = false
        probeTimer = null
        isStandbyHostMode = false
        deps.setIsHostMode(true)
        deps.updateHostStatus()
        deps.getSignaling()?.send({
          type: 'host_hello',
          hostSessionId: deps.getHostSessionId(),
          hostIpv6: deps.getHostIpv6() || undefined,
          ecdhPublicKey: deps.getLocalEcdhPubHex(),
          deviceId: deps.getLocalDeviceId(),
          hostEpoch: localEpoch,
          username: deps.resolveCurrentUsername(),
          userId: deps.resolveCurrentUserId()
        })
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
    setLocalEpoch(Math.max(localEpoch, 1))
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
    get isTakeoverReconciling() {
      return inTakeoverReconciliation
    },
    waitForTakeoverReconciliation,
    finishTakeoverReconciliation,
    takeoverHost,
    createHostSignalingMessageHandler,
    startHostProbeWindow,
    prepareForHostStart,
    stopAllElectionTimers
  }
}
