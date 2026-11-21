/**
 * Per-Event Host Epoch & Witness Metadata Store (`sp27_epoch_${inviteCode}`)
 *
 * Replaces the legacy global `scoutingpro_host_epoch` key with strictly
 * invite-code-bucketed persistence so concurrent/multiple events never collide,
 * and ensures stale placeholders (`evt-*` / `ext_*`) never overwrite authoritative UUIDs.
 */

export const EPOCH_STORAGE_PREFIX = 'sp27_epoch_'

export interface EventEpochWitnessRecord {
  inviteCode: string
  authoritativeEventId: string
  eventName: string
  hostUserId: string
  ftcYear?: number
  ftcEventCode?: string
  highestSeenEpoch: number
  activeHostSessionId?: string
  activeHostDeviceId?: string
  updatedAt: number
}

export function isPlaceholderEventId(id?: string | null): boolean {
  if (!id || !id.trim()) return true
  const trimmed = id.trim()
  const lower = trimmed.toLowerCase()
  return lower.startsWith('evt-') || lower.startsWith('ext_')
}

export function isPlaceholderHostUserId(hostUserId?: string | null): boolean {
  if (!hostUserId || !hostUserId.trim()) return true
  const lower = hostUserId.trim().toLowerCase()
  return lower === 'external_host' || lower === 'remote-host' || lower === 'unknown'
}

export function getEpochStorageKey(inviteCode: string): string {
  const normalized = (inviteCode || '').trim().toUpperCase() || 'DEFAULT'
  return `${EPOCH_STORAGE_PREFIX}${normalized}`
}

export function getEpochWitnessRecord(inviteCode: string): EventEpochWitnessRecord | null {
  if (!inviteCode || !inviteCode.trim() || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(getEpochStorageKey(inviteCode))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<EventEpochWitnessRecord>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      inviteCode: (parsed.inviteCode || inviteCode).trim().toUpperCase(),
      authoritativeEventId: typeof parsed.authoritativeEventId === 'string' ? parsed.authoritativeEventId : '',
      eventName: typeof parsed.eventName === 'string' ? parsed.eventName : '',
      hostUserId: typeof parsed.hostUserId === 'string' ? parsed.hostUserId : '',
      ftcYear: typeof parsed.ftcYear === 'number' ? parsed.ftcYear : undefined,
      ftcEventCode: typeof parsed.ftcEventCode === 'string' ? parsed.ftcEventCode : undefined,
      highestSeenEpoch:
        typeof parsed.highestSeenEpoch === 'number' && Number.isFinite(parsed.highestSeenEpoch)
          ? Math.max(0, Math.floor(parsed.highestSeenEpoch))
          : 0,
      activeHostSessionId: typeof parsed.activeHostSessionId === 'string' ? parsed.activeHostSessionId : undefined,
      activeHostDeviceId: typeof parsed.activeHostDeviceId === 'string' ? parsed.activeHostDeviceId : undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
    }
  } catch {
    return null
  }
}

export function getHighestSeenEpoch(inviteCode: string): number {
  return getEpochWitnessRecord(inviteCode)?.highestSeenEpoch ?? 0
}

export function saveEpochWitnessRecord(
  incoming: Partial<EventEpochWitnessRecord> & { inviteCode: string }
): EventEpochWitnessRecord {
  const normalizedCode = (incoming.inviteCode || '').trim().toUpperCase()
  const prev = getEpochWitnessRecord(normalizedCode)

  const incomingEpoch =
    typeof incoming.highestSeenEpoch === 'number' && Number.isFinite(incoming.highestSeenEpoch)
      ? Math.max(0, Math.floor(incoming.highestSeenEpoch))
      : 0
  const prevEpoch = prev?.highestSeenEpoch ?? 0
  const highestSeenEpoch = Math.max(prevEpoch, incomingEpoch)

  let authoritativeEventId = prev?.authoritativeEventId || ''
  if (incoming.authoritativeEventId && !isPlaceholderEventId(incoming.authoritativeEventId)) {
    authoritativeEventId = incoming.authoritativeEventId.trim()
  } else if (!authoritativeEventId && incoming.authoritativeEventId) {
    authoritativeEventId = incoming.authoritativeEventId.trim()
  }

  let hostUserId = prev?.hostUserId || ''
  if (incoming.hostUserId && !isPlaceholderHostUserId(incoming.hostUserId)) {
    hostUserId = incoming.hostUserId.trim()
  } else if (!hostUserId && incoming.hostUserId) {
    hostUserId = incoming.hostUserId.trim()
  }

  const eventName =
    (incoming.eventName && incoming.eventName.trim()) ||
    prev?.eventName ||
    ''

  const shouldUpdateActiveHost = incomingEpoch >= prevEpoch || !prev?.activeHostSessionId
  const activeHostSessionId = shouldUpdateActiveHost
    ? incoming.activeHostSessionId || prev?.activeHostSessionId
    : prev?.activeHostSessionId
  const activeHostDeviceId = shouldUpdateActiveHost
    ? incoming.activeHostDeviceId || prev?.activeHostDeviceId
    : prev?.activeHostDeviceId

  const merged: EventEpochWitnessRecord = {
    inviteCode: normalizedCode,
    authoritativeEventId,
    eventName,
    hostUserId,
    ftcYear: typeof incoming.ftcYear === 'number' ? incoming.ftcYear : prev?.ftcYear,
    ftcEventCode: incoming.ftcEventCode || prev?.ftcEventCode,
    highestSeenEpoch,
    activeHostSessionId,
    activeHostDeviceId,
    updatedAt: Date.now()
  }

  if (normalizedCode && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(getEpochStorageKey(normalizedCode), JSON.stringify(merged))
    } catch {
      // Ignore storage quota errors
    }
  }
  return merged
}
