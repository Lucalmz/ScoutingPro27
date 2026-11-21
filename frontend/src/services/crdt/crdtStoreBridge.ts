import type {
  CustomFieldDefinition,
  MatchScheduleItem,
  PitScoutingRecord,
  ScoutAssignment,
  ScoutingRecord,
  TeamTagItem
} from '@/types'
import {
  CRDT_TABLES,
  assignmentRowId,
  customFieldRowId,
  pitPhotoKeyRowId,
  pitRowId,
  scheduleRowId,
  scoutingRecordRowId,
  setPitPhotoKeyActive,
  teamTagRowId,
  writeAssignmentToCrdt,
  writeCustomFieldToCrdt,
  writePitRecordToCrdt,
  writeScheduleToCrdt,
  writeScoutingRecordToCrdt,
  writeTeamTagToCrdt
} from './schema'
import {
  countersignPendingMemberIdentities,
  registerLocalMemberIdentity,
  signScoutingRecordWithDeviceKey
} from './recordSignature'
import { getOrCreateEventCrdt, setCrdtDeviceId, type CreateEventCrdtOptions, type EventCrdtHandle } from './crdtStore'
import { getOrCreateDeviceIdentity } from '@/utils/identityStore'

const localWriteDepth = new Map<string, number>()

/**
 * Executes a local CRDT mutation while suppressing redundant full-table Pinia re-projections
 * from the store's reactive transaction listener.
 */
export function withLocalCrdtWrite<T>(eventId: string | null | undefined, fn: () => T): T {
  const cleanId = (eventId || '').trim()
  if (!cleanId) return fn()
  localWriteDepth.set(cleanId, (localWriteDepth.get(cleanId) ?? 0) + 1)
  try {
    return fn()
  } finally {
    const next = (localWriteDepth.get(cleanId) ?? 1) - 1
    if (next <= 0) {
      localWriteDepth.delete(cleanId)
    } else {
      localWriteDepth.set(cleanId, next)
    }
  }
}

export function getLocalCrdtWriteDepth(eventId: string): number {
  return localWriteDepth.get((eventId || '').trim()) ?? 0
}

export interface CrdtBoundStores {
  pitStore: {
    records: PitScoutingRecord[]
    syncFromCrdt: (eventId: string) => void
  }
  scheduleStore: {
    schedules: MatchScheduleItem[]
    assignments: Record<string, ScoutAssignment>
    syncFromCrdt: (eventId: string) => void
  }
  customFieldsStore: {
    getFields: (eventId: string) => CustomFieldDefinition[]
    syncFromCrdt: (eventId: string) => void
  }
  recordStore: {
    records?: ScoutingRecord[]
    teamTags: TeamTagItem[]
    syncTagsFromCrdt: (eventId: string) => void
    syncRecordsFromCrdt?: (eventId: string) => void
  }
}

export interface HydrateAndBindParams extends CreateEventCrdtOptions {
  eventId: string
  userId?: string
  eventHostId?: string
  isDesktopHost?: boolean
  stores: CrdtBoundStores
}

export interface BoundCrdtSession {
  handle: EventCrdtHandle
  unbind: () => void
}

function hasAnyRowInTable(handle: EventCrdtHandle, tableId: string): boolean {
  const table = handle.store.getTable(tableId)
  return Boolean(table && Object.keys(table).length > 0)
}

function seedLegacyRowsIfAbsent(
  handle: EventCrdtHandle,
  eventId: string,
  stores: CrdtBoundStores
): boolean {
  const store = handle.store
  let seeded = false

  withLocalCrdtWrite(eventId, () => {
    store.transaction(() => {
      for (const rec of stores.pitStore.records) {
        if (!rec || !rec.teamNumber) continue
        if (rec.eventId && rec.eventId !== eventId) continue
        const rId = pitRowId(rec.teamNumber)
        if (!store.hasRow(CRDT_TABLES.PIT_RECORDS, rId)) {
          writePitRecordToCrdt(
            store,
            { ...rec, eventId: rec.eventId || eventId },
            { syncPhotoKeys: false }
          )
          seeded = true
        }
        if (Array.isArray(rec.photoKeys)) {
          for (const rawKey of rec.photoKeys) {
            const key = (rawKey || '').trim()
            if (!key) continue
            const pRowId = pitPhotoKeyRowId(rec.teamNumber, key)
            if (!store.hasRow(CRDT_TABLES.PIT_PHOTO_KEYS, pRowId)) {
              setPitPhotoKeyActive(store, rec.teamNumber, key, true, rec.scoutId || '')
              seeded = true
            }
          }
        }
      }

      for (const sched of stores.scheduleStore.schedules) {
        if (!sched || !sched.matchNumber) continue
        if (sched.eventId && sched.eventId !== eventId) continue
        const rId = scheduleRowId(sched.matchNumber, sched.tournamentLevel || 'QUALIFICATION')
        if (!store.hasRow(CRDT_TABLES.SCHEDULES, rId)) {
          writeScheduleToCrdt(store, { ...sched, eventId: sched.eventId || eventId }, false)
          seeded = true
        }
      }

      for (const assign of Object.values(stores.scheduleStore.assignments)) {
        if (!assign || !assign.matchNumber || !assign.station) continue
        if (assign.eventId && assign.eventId !== eventId) continue
        const rId = assignmentRowId(
          assign.matchNumber,
          assign.station,
          assign.tournamentLevel || 'QUALIFICATION'
        )
        if (!store.hasRow(CRDT_TABLES.ASSIGNMENTS, rId)) {
          writeAssignmentToCrdt(store, { ...assign, eventId: assign.eventId || eventId }, false)
          seeded = true
        }
      }

      for (const field of stores.customFieldsStore.getFields(eventId)) {
        if (!field || !field.id) continue
        const rId = customFieldRowId(field.id)
        if (!store.hasRow(CRDT_TABLES.CUSTOM_FIELDS, rId)) {
          writeCustomFieldToCrdt(store, { ...field, eventId: field.eventId || eventId }, false)
          seeded = true
        }
      }

      for (const tag of stores.recordStore.teamTags) {
        if (!tag || !tag.teamNumber || !tag.tag) continue
        if (tag.eventId && tag.eventId !== eventId) continue
        const rId = teamTagRowId(tag.teamNumber, tag.tag)
        if (!store.hasRow(CRDT_TABLES.TEAM_TAGS, rId)) {
          writeTeamTagToCrdt(store, { ...tag, eventId: tag.eventId || eventId }, true)
          seeded = true
        }
      }

      for (const rec of stores.recordStore.records ?? []) {
        if (!rec || !rec.id || !rec.matchNumber || !rec.teamNumber) continue
        if (rec.eventId && rec.eventId !== eventId) continue
        const rId = scoutingRecordRowId(rec.id)
        if (!store.hasRow(CRDT_TABLES.SCOUTING_RECORDS, rId)) {
          writeScoutingRecordToCrdt(store, { ...rec, eventId: rec.eventId || eventId })
          seeded = true
        }
      }
    })
  })

  return seeded
}

/**
 * Hydrates the per-event MergeableStore from IndexedDB + Host H2, safely seeds any
 * legacy unmigrated rows without resurrecting local tombstones, registers device ECDSA
 * trust anchors in `member_identities`, projects CRDT state into Pinia stores, and binds
 * reactive incremental projections on remote merges.
 */
export async function hydrateAndBindEventCrdt(params: HydrateAndBindParams): Promise<BoundCrdtSession> {
  const cleanId = (params.eventId || '').trim()
  const { stores, isDesktopHost, userId, eventHostId, ...handleOpts } = params
  let resolvedDeviceId = handleOpts.deviceId?.trim() || ''
  if (!resolvedDeviceId) {
    try {
      const identity = await getOrCreateDeviceIdentity()
      if (identity?.deviceId) {
        resolvedDeviceId = identity.deviceId
        setCrdtDeviceId(identity.deviceId)
      }
    } catch {
      // Fallback to getCrdtDeviceId() in stripped unit contexts without IDB/WebCrypto
    }
  }
  const handle = getOrCreateEventCrdt(
    cleanId,
    resolvedDeviceId ? { ...handleOpts, deviceId: resolvedDeviceId } : handleOpts
  )

  await handle.persistence.initLocalPersistence()
  const hashesAfterIdb = handle.store.getMergeableContentHashes()
  const hadIdbData = hashesAfterIdb[0] !== 0 || hashesAfterIdb[1] !== 0

  const h2Res = await handle.hydrateFromH2()

  await registerLocalMemberIdentity({
    store: handle.store,
    eventId: cleanId,
    userId,
    eventHostId
  })
  if (userId && eventHostId && userId === eventHostId) {
    await countersignPendingMemberIdentities({
      store: handle.store,
      eventId: cleanId,
      eventHostId,
      currentUserId: userId
    })
  }

  let didSeed = false
  if (!h2Res.loaded) {
    if (stores.recordStore.records?.length && userId) {
      for (const rec of stores.recordStore.records) {
        if (
          rec &&
          !rec.authorSig &&
          (!rec.eventId || rec.eventId === cleanId) &&
          (rec.scoutId === userId || (eventHostId && userId === eventHostId))
        ) {
          await signScoutingRecordWithDeviceKey({ ...rec, eventId: rec.eventId || cleanId }).then((res) => {
            if (res.signed) {
              rec.authorPubKey = res.authorPubKey
              rec.authorSig = res.authorSig
            }
          })
        }
      }
    }
    didSeed = seedLegacyRowsIfAbsent(handle, cleanId, stores)
  }

  if (hasAnyRowInTable(handle, CRDT_TABLES.PIT_RECORDS) || hasAnyRowInTable(handle, CRDT_TABLES.PIT_PHOTO_KEYS)) {
    stores.pitStore.syncFromCrdt(cleanId)
  }
  if (hasAnyRowInTable(handle, CRDT_TABLES.SCHEDULES) || hasAnyRowInTable(handle, CRDT_TABLES.ASSIGNMENTS)) {
    stores.scheduleStore.syncFromCrdt(cleanId)
  }
  if (hasAnyRowInTable(handle, CRDT_TABLES.CUSTOM_FIELDS)) {
    stores.customFieldsStore.syncFromCrdt(cleanId)
  }
  if (hasAnyRowInTable(handle, CRDT_TABLES.TEAM_TAGS)) {
    stores.recordStore.syncTagsFromCrdt(cleanId)
  }
  if (hasAnyRowInTable(handle, CRDT_TABLES.SCOUTING_RECORDS)) {
    stores.recordStore.syncRecordsFromCrdt?.(cleanId)
  }

  if (isDesktopHost && (didSeed || h2Res.hasLocalDiff || (!h2Res.loaded && hadIdbData))) {
    handle.persistence.markAllRowsDirty()
    handle.persistence.scheduleFlush()
  }

  const listenerId = handle.store.addDidFinishTransactionListener(() => {
    if (getLocalCrdtWriteDepth(cleanId) > 0) return
    const [changedTables] = handle.store.getTransactionChanges()
    if (!changedTables || typeof changedTables !== 'object') return

    if (changedTables[CRDT_TABLES.PIT_RECORDS] || changedTables[CRDT_TABLES.PIT_PHOTO_KEYS]) {
      stores.pitStore.syncFromCrdt(cleanId)
    }
    if (changedTables[CRDT_TABLES.SCHEDULES] || changedTables[CRDT_TABLES.ASSIGNMENTS]) {
      stores.scheduleStore.syncFromCrdt(cleanId)
    }
    if (changedTables[CRDT_TABLES.CUSTOM_FIELDS]) {
      stores.customFieldsStore.syncFromCrdt(cleanId)
    }
    if (changedTables[CRDT_TABLES.TEAM_TAGS]) {
      stores.recordStore.syncTagsFromCrdt(cleanId)
    }
    if (changedTables[CRDT_TABLES.SCOUTING_RECORDS]) {
      stores.recordStore.syncRecordsFromCrdt?.(cleanId)
    }
  })

  return {
    handle,
    unbind: () => {
      try {
        handle.store.delListener(listenerId)
      } catch {}
    }
  }
}
