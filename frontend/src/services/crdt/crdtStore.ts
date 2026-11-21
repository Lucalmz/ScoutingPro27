import { createMergeableStore, type MergeableStore } from 'tinybase'
import { getCalibratedClockForEvent, migrateClockAnchor, type CalibratedMonotonicClock } from '@/services/clock'
import { getHighestSeenEpoch, isPlaceholderEventId } from '@/services/webrtc/epochStore'
import { registerBeforeLogoutHook } from '@/stores/user'
import type { CrdtHttpTransport, CrdtSaveStateResponse } from './crdtApi'
import {
  createCrdtPersistenceController,
  type CrdtHydrateResult,
  type CrdtPersistenceController,
  type FlushOptions
} from './crdtPersistence'

export interface EventCrdtHandle {
  eventId: string
  inviteCode?: string
  deviceId: string
  store: MergeableStore
  clock: CalibratedMonotonicClock
  persistence: CrdtPersistenceController
  flushNow: (opts?: FlushOptions) => Promise<CrdtSaveStateResponse | null>
  hydrateFromH2: () => Promise<CrdtHydrateResult>
  setInviteCode: (inviteCode: string) => void
  destroy: () => Promise<void>
}

export interface CreateEventCrdtOptions {
  inviteCode?: string
  deviceId?: string
  getHostEpoch?: () => number
  debounceMs?: number
  maxWaitMs?: number
  transport?: CrdtHttpTransport
  enableHttp?: boolean
  enableIndexedDb?: boolean
}

const handles = new Map<string, EventCrdtHandle>()
const activeTransports = new Set<string>()
let activeDeviceId = ''
let unregisterLogoutHook: (() => void) | null = null
let beforeUnloadAttached = false

export function setCrdtTransportActive(eventId: string, active: boolean): void {
  const cleanId = (eventId || '').trim()
  if (!cleanId) return
  if (active) {
    activeTransports.add(cleanId)
  } else {
    activeTransports.delete(cleanId)
  }
}

export function isCrdtTransportActive(eventId?: string | null): boolean {
  const cleanId = (eventId || '').trim()
  if (!cleanId) return false
  return activeTransports.has(cleanId)
}

function handleWindowBeforeUnload(): void {
  void flushAllCrdtToH2({ keepalive: true })
}

async function disposeAllHandles(): Promise<void> {
  const all = Array.from(handles.values())
  handles.clear()
  activeTransports.clear()
  await Promise.allSettled(all.map((h) => h.persistence.destroy()))
  detachLifecycleHooksIfEmpty()
}

function ensureLifecycleHooksAttached(): void {
  if (!unregisterLogoutHook) {
    unregisterLogoutHook = registerBeforeLogoutHook(async () => {
      await flushAllCrdtToH2({ keepalive: false })
      await disposeAllHandles()
    })
  }
  if (!beforeUnloadAttached && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleWindowBeforeUnload)
    beforeUnloadAttached = true
  }
}

function detachLifecycleHooksIfEmpty(): void {
  if (handles.size > 0) return
  if (unregisterLogoutHook) {
    unregisterLogoutHook()
    unregisterLogoutHook = null
  }
  if (beforeUnloadAttached && typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', handleWindowBeforeUnload)
    beforeUnloadAttached = false
  }
}

export function setCrdtDeviceId(deviceId: string): void {
  if (deviceId && deviceId.trim()) {
    activeDeviceId = deviceId.trim()
  }
}

export function getCrdtDeviceId(): string {
  if (activeDeviceId) return activeDeviceId
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem('sp27_device_identity')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (typeof parsed?.deviceId === 'string' && parsed.deviceId) {
          activeDeviceId = parsed.deviceId
          return activeDeviceId
        }
      }
    } catch {}
  }
  activeDeviceId = `crdt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return activeDeviceId
}

export function getOrCreateEventCrdt(eventId: string, opts?: CreateEventCrdtOptions): EventCrdtHandle {
  const cleanId = (eventId || '').trim()
  const existing = handles.get(cleanId)
  if (existing) {
    if (opts?.inviteCode) {
      existing.setInviteCode(opts.inviteCode)
    }
    if (opts?.getHostEpoch) {
      existing.persistence.setHostEpochResolver(opts.getHostEpoch)
    }
    return existing
  }

  let currentInviteCode = (opts?.inviteCode || '').trim().toUpperCase()
  const deviceId = opts?.deviceId?.trim() || getCrdtDeviceId()
  const clock = getCalibratedClockForEvent(cleanId)
  const store = createMergeableStore(deviceId, () => clock.now(), 300)

  const resolveEpoch = opts?.getHostEpoch ?? (() => (currentInviteCode ? Math.max(1, getHighestSeenEpoch(currentInviteCode)) : 1))

  const persistence = createCrdtPersistenceController({
    eventId: cleanId,
    store,
    clock,
    getHostEpoch: resolveEpoch,
    debounceMs: opts?.debounceMs,
    maxWaitMs: opts?.maxWaitMs,
    transport: opts?.transport,
    enableHttp: opts?.enableHttp,
    enableIndexedDb: opts?.enableIndexedDb
  })

  const handle: EventCrdtHandle = {
    eventId: cleanId,
    get inviteCode() {
      return currentInviteCode || undefined
    },
    deviceId,
    store,
    clock,
    persistence,
    flushNow: (flushOpts) => persistence.flushNow(flushOpts),
    hydrateFromH2: () => persistence.hydrateFromH2(),
    setInviteCode: (code: string) => {
      if (code && code.trim()) {
        currentInviteCode = code.trim().toUpperCase()
      }
    },
    destroy: async () => {
      handles.delete(cleanId)
      activeTransports.delete(cleanId)
      await persistence.destroy()
      detachLifecycleHooksIfEmpty()
    }
  }

  handles.set(cleanId, handle)
  ensureLifecycleHooksAttached()
  return handle
}

export function getExistingEventCrdt(eventId: string): EventCrdtHandle | undefined {
  return handles.get((eventId || '').trim())
}

export async function migrateEventCrdtId(
  oldEventId: string,
  newEventId: string,
  opts?: CreateEventCrdtOptions
): Promise<EventCrdtHandle> {
  const cleanOld = (oldEventId || '').trim()
  const cleanNew = (newEventId || '').trim()
  migrateClockAnchor(cleanOld, cleanNew)

  const oldHandle = cleanOld && cleanOld !== cleanNew ? handles.get(cleanOld) : undefined
  const nextHandle = getOrCreateEventCrdt(cleanNew, {
    ...opts,
    inviteCode: opts?.inviteCode || oldHandle?.inviteCode
  })

  if (oldHandle) {
    if (activeTransports.has(cleanOld)) {
      activeTransports.delete(cleanOld)
      activeTransports.add(cleanNew)
    }
    const content = oldHandle.store.getMergeableContent()
    nextHandle.persistence.applyMergeableSnapshot(content, true)
    nextHandle.store.transaction(() => {
      const tables = nextHandle.store.getTables()
      for (const [tableId, rows] of Object.entries(tables)) {
        if (!rows || typeof rows !== 'object') continue
        for (const [rowId, row] of Object.entries(rows)) {
          if (!row || typeof row !== 'object') continue
          const cellEventId = typeof row.eventId === 'string' ? row.eventId.trim() : ''
          if (cellEventId && (cellEventId === cleanOld || isPlaceholderEventId(cellEventId))) {
            nextHandle.store.setCell(tableId, rowId, 'eventId', cleanNew)
          }
        }
      }
    })
    nextHandle.persistence.markAllRowsDirty()
    await oldHandle.destroy()
  }
  return nextHandle
}

export async function flushAllCrdtToH2(flushOpts?: FlushOptions): Promise<void> {
  const all = Array.from(handles.values())
  await Promise.allSettled(all.map((h) => h.flushNow(flushOpts)))
}

export async function disposeEventCrdt(eventId: string): Promise<void> {
  const h = handles.get((eventId || '').trim())
  if (h) {
    await h.destroy()
  }
}

export async function resetCrdtRegistryForTesting(): Promise<void> {
  activeDeviceId = ''
  await disposeAllHandles()
}
