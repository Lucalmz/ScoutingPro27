import { SignalingChannel, type EpochBeaconPayload } from './signaling'
import {
  getEpochWitnessRecord,
  saveEpochWitnessRecord,
  isPlaceholderEventId,
  isPlaceholderHostUserId
} from './epochStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:Discovery')

export interface RoomDiscoveryParams {
  inviteCode: string
  localDeviceId?: string
  userId?: string
  username?: string
  preferredBroker?: string
  timeoutMs?: number
}

export interface RoomDiscoveryResult {
  found: boolean
  hasLiveHost: boolean
  authoritativeEventId: string
  eventName: string
  hostUserId: string
  ftcYear?: number
  ftcEventCode?: string
  highestSeenEpoch: number
  activeHostSessionId?: string
  activeHostDeviceId?: string
  witnessMaxHlcPts: number[]
}

/**
 * Queries MQTT retained epoch beacon & live peers (`host_discovery` -> `epoch_witness`)
 * to recover authoritative event UUID & highest known host epoch before creating any local stub.
 */
export async function discoverRoomWitness(params: RoomDiscoveryParams): Promise<RoomDiscoveryResult> {
  const cleanCode = (params.inviteCode || '').trim().toUpperCase()
  const existing = getEpochWitnessRecord(cleanCode)
  const timeoutMs = params.timeoutMs ?? (globalThis as any).__TEST_DISCOVERY_MS__ ?? 1500

  let authoritativeEventId = existing?.authoritativeEventId || ''
  let eventName = existing?.eventName || ''
  let hostUserId = existing?.hostUserId || ''
  let ftcYear = existing?.ftcYear
  let ftcEventCode = existing?.ftcEventCode
  let highestSeenEpoch = existing?.highestSeenEpoch ?? 0
  let activeHostSessionId = existing?.activeHostSessionId
  let activeHostDeviceId = existing?.activeHostDeviceId
  let hasLiveHost = false
  const witnessMaxHlcPts: number[] = []

  if (!cleanCode) {
    return {
      found: false,
      hasLiveHost: false,
      authoritativeEventId: '',
      eventName: '',
      hostUserId: '',
      highestSeenEpoch: 0,
      witnessMaxHlcPts: []
    }
  }

  const channel = new SignalingChannel(cleanCode, params.preferredBroker)
  await channel.initTopic()

  let finishDiscovery!: () => void
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null

  const absorbWitness = (data: {
    authoritativeEventId?: string
    eventName?: string
    hostUserId?: string
    ftcYear?: number
    ftcEventCode?: string
    highestEpoch?: number
    hostEpoch?: number
    activeHostSessionId?: string
    activeHostDeviceId?: string
    hostSessionId?: string
    deviceId?: string
    maxKnownHlcPt?: number
  }) => {
    const incomingEp = Number(data.highestEpoch ?? data.hostEpoch ?? 0) || 0
    if (incomingEp > highestSeenEpoch) {
      highestSeenEpoch = incomingEp
    }
    if (data.authoritativeEventId && !isPlaceholderEventId(data.authoritativeEventId)) {
      authoritativeEventId = data.authoritativeEventId.trim()
    }
    if (data.eventName && data.eventName.trim()) {
      eventName = data.eventName.trim()
    }
    if (data.hostUserId && !isPlaceholderHostUserId(data.hostUserId)) {
      hostUserId = data.hostUserId.trim()
    }
    if (typeof data.ftcYear === 'number') ftcYear = data.ftcYear
    if (data.ftcEventCode) ftcEventCode = data.ftcEventCode
    if (data.activeHostSessionId || data.hostSessionId) {
      activeHostSessionId = data.activeHostSessionId || data.hostSessionId
    }
    if (data.activeHostDeviceId || data.deviceId) {
      activeHostDeviceId = data.activeHostDeviceId || data.deviceId
    }
    const maxPt = Number(data.maxKnownHlcPt ?? 0)
    if (Number.isFinite(maxPt) && maxPt > 0) {
      witnessMaxHlcPts.push(maxPt)
    }

    if (authoritativeEventId && !isPlaceholderEventId(authoritativeEventId)) {
      saveEpochWitnessRecord({
        inviteCode: cleanCode,
        authoritativeEventId,
        eventName,
        hostUserId,
        ftcYear,
        ftcEventCode,
        highestSeenEpoch,
        activeHostSessionId,
        activeHostDeviceId
      })
    }
  }

  try {
    await new Promise<void>((resolve) => {
      let resolved = false
      finishDiscovery = () => {
        if (resolved) return
        resolved = true
        if (discoveryTimer) {
          clearTimeout(discoveryTimer)
          discoveryTimer = null
        }
        resolve()
      }

      const preConnectTimeoutMs = (globalThis as any).__TEST_DISCOVERY_MS__
        ? timeoutMs
        : Math.max(timeoutMs + 6000, 8000)
      discoveryTimer = setTimeout(finishDiscovery, preConnectTimeoutMs)

      channel.connect({
        onConnect: () => {
          if (discoveryTimer) {
            clearTimeout(discoveryTimer)
          }
          discoveryTimer = setTimeout(finishDiscovery, timeoutMs)
          void channel.send({
            type: 'host_discovery',
            deviceId: params.localDeviceId || '',
            userId: params.userId || '',
            username: params.username || '',
            knownEpoch: highestSeenEpoch
          })
          void channel.send({
            type: 'host_probe',
            deviceId: params.localDeviceId || '',
            hostEpoch: highestSeenEpoch
          })
        },
        onEpochBeacon: (beacon: EpochBeaconPayload) => {
          absorbWitness({
            authoritativeEventId: beacon.authoritativeEventId,
            eventName: beacon.eventName,
            hostUserId: beacon.hostUserId,
            ftcYear: beacon.ftcYear,
            ftcEventCode: beacon.ftcEventCode,
            hostEpoch: beacon.hostEpoch,
            hostSessionId: beacon.hostSessionId,
            deviceId: beacon.hostDeviceId
          })
        },
        onMessage: (rawData: any) => {
          if (!rawData || typeof rawData !== 'object') return
          if (rawData.type === 'epoch_witness') {
            absorbWitness(rawData)
            if (authoritativeEventId && !isPlaceholderEventId(authoritativeEventId) && hasLiveHost) {
              finishDiscovery()
            }
          } else if (rawData.type === 'host_heartbeat' || rawData.type === 'host_hello') {
            hasLiveHost = true
            absorbWitness({
              hostUserId: rawData.userId,
              hostEpoch: rawData.hostEpoch,
              hostSessionId: rawData.hostSessionId,
              deviceId: rawData.deviceId
            })
            if (authoritativeEventId && !isPlaceholderEventId(authoritativeEventId)) {
              finishDiscovery()
            }
          } else if (rawData.type === 'epoch_superseded') {
            hasLiveHost = true
            absorbWitness({
              hostEpoch: rawData.currentEpoch,
              activeHostSessionId: rawData.activeHostSessionId,
              activeHostDeviceId: rawData.activeHostDeviceId
            })
          }
        },
        onError: () => {
          finishDiscovery()
        }
      })
    })
  } catch (err) {
    log.warn(`Discovery failed for invite code ${cleanCode}:`, err)
  } finally {
    if (discoveryTimer) {
      clearTimeout(discoveryTimer)
      discoveryTimer = null
    }
    try {
      channel.close()
    } catch {}
  }

  return {
    found: Boolean(
      (authoritativeEventId && !isPlaceholderEventId(authoritativeEventId)) || highestSeenEpoch > 0
    ),
    hasLiveHost,
    authoritativeEventId,
    eventName,
    hostUserId,
    ftcYear,
    ftcEventCode,
    highestSeenEpoch,
    activeHostSessionId,
    activeHostDeviceId,
    witnessMaxHlcPts
  }
}
