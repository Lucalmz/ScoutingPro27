import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMergeableStore } from 'tinybase'
import { resetClockRegistryForTesting } from '@/services/clock'
import {
  CRDT_TABLES,
  createWebRtcCrdtSynchronizerHub,
  getExistingEventCrdt,
  getOrCreateEventCrdt,
  hydrateAndBindEventCrdt,
  isCrdtTransportActive,
  readCustomFieldsFromCrdt,
  readPitRecordsFromCrdt,
  readScoutingRecordsFromCrdt,
  readSchedulesFromCrdt,
  readTeamTagsFromCrdt,
  resetCrdtRegistryForTesting,
  setCrdtTransportActive,
  setTeamTagActive,
  writeCustomFieldToCrdt,
  writePitRecordToCrdt,
  writeScoutingRecordToCrdt,
  writeTeamTagToCrdt,
  type CrdtHttpTransport
} from '@/services/crdt'
import * as api from '@/services/api'
import { useConnectionStore } from '@/stores/connection'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useEventStore } from '@/stores/events'
import { usePitScoutStore } from '@/stores/pitScout'
import { useRecordStore } from '@/stores/records'
import { useScheduleStore } from '@/stores/schedule'
import { clearBeforeLogoutHooksForTesting, useUserStore } from '@/stores/user'
import { createSyncPackage, executeBatchSyncImport, scanFilesAndFolders } from '@/utils/offlineSync'
import type { CustomFieldDefinition, MatchScheduleItem, PitScoutingRecord, ScoutingRecord, TeamTagItem } from '@/types'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return {
    ...actual,
    savePitRecord: vi.fn().mockResolvedValue({ success: true }),
    syncPitRecordsBatch: vi.fn().mockResolvedValue({ success: true }),
    saveScheduleBatch: vi.fn().mockResolvedValue({ count: 0 }),
    saveScoutAssignments: vi.fn().mockResolvedValue({ count: 0 }),
    clearEventSchedule: vi.fn().mockResolvedValue({ success: true }),
    addTeamTag: vi.fn(),
    deleteTeamTag: vi.fn(),
    createCustomField: vi.fn(),
    updateCustomField: vi.fn(),
    deleteCustomField: vi.fn()
  }
})

function makePit(overrides: Partial<PitScoutingRecord> = {}): PitScoutingRecord {
  return {
    id: 'evt-uuid-1_pit_27570',
    eventId: 'evt-uuid-1',
    teamNumber: 27570,
    scoutId: 'alice',
    scoutName: 'Alice',
    robotName: 'Polaris',
    drivetrainType: 'swerve',
    weightLbs: 28,
    ballCompatibility: 'universal',
    launcherType: 'Flywheel',
    flowerMechanism: 'Elevator',
    hasColorSensor: true,
    odometryType: 'pinpoint',
    claimedAutoScore: 30,
    claimedTeleopCycles: 8,
    claimedTeleopScore: 80,
    claimedEndgameScore: 20,
    claimedTotalScore: 130,
    photoKeys: [],
    version: 1,
    ...overrides
  }
}

function makeField(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 'cf-1',
    eventId: 'evt-uuid-1',
    target: 'MATCH',
    phase: 'teleop',
    name: 'Field 1',
    fieldKey: 'field_1',
    fieldType: 'boolean',
    required: false,
    orderSeq: 1,
    isActive: true,
    ...overrides
  }
}

function makeSchedule(overrides: Partial<MatchScheduleItem> = {}): MatchScheduleItem {
  return {
    id: 'evt-uuid-1_M1',
    eventId: 'evt-uuid-1',
    matchNumber: 1,
    tournamentLevel: 'QUALIFICATION',
    red1: 27570,
    red2: 1111,
    blue1: 2222,
    blue2: 3333,
    ...overrides
  }
}

describe('CRDT Store Bridge End-to-End Integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    clearBeforeLogoutHooksForTesting()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await resetCrdtRegistryForTesting()
    resetClockRegistryForTesting()
    clearBeforeLogoutHooksForTesting()
    localStorage.clear()
  })

  it('converges Pit field merge, Tag tombstones, Schedule/Assignments & CustomField order across Pinia <-> WebRTC Hub without legacy broadcasts', async () => {
    const pitStore = usePitScoutStore()
    const scheduleStore = useScheduleStore()
    const customFieldsStore = useCustomFieldsStore()
    const recordStore = useRecordStore()
    const connStore = useConnectionStore()

    pitStore.currentEventId = 'evt-uuid-1'
    scheduleStore.currentEventId = 'evt-uuid-1'
    recordStore.currentEventId = 'evt-uuid-1'

    const legacySendSpy = vi.fn().mockResolvedValue(undefined)
    connStore.rtcService = { sendMessage: legacySendSpy } as any

    const transport: CrdtHttpTransport = {
      loadState: vi.fn(async () => null),
      saveState: vi.fn(async (eventId, req) => ({
        saved: true,
        eventId,
        hostEpoch: req.hostEpoch,
        snapshotRevision: req.snapshotRevision
      }))
    }

    const session = await hydrateAndBindEventCrdt({
      eventId: 'evt-uuid-1',
      inviteCode: '27570',
      deviceId: 'host-dev',
      transport,
      enableHttp: true,
      enableIndexedDb: false,
      stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
    })
    setCrdtTransportActive('evt-uuid-1', true)

    let clockMs = session.handle.clock.now()
    const peerStore = createMergeableStore('tablet-peer', () => clockMs, 300)

    let hostHub!: ReturnType<typeof createWebRtcCrdtSynchronizerHub>
    let peerHub!: ReturnType<typeof createWebRtcCrdtSynchronizerHub>

    hostHub = createWebRtcCrdtSynchronizerHub({
      eventId: 'evt-uuid-1',
      store: session.handle.store,
      clientId: session.handle.deviceId,
      getNowMs: () => clockMs,
      sendToPeer: (_pid, frame) => queueMicrotask(() => peerHub.handleIncomingMessage('host', frame))
    })
    peerHub = createWebRtcCrdtSynchronizerHub({
      eventId: 'evt-uuid-1',
      store: peerStore,
      clientId: 'tablet-peer',
      getNowMs: () => clockMs,
      sendToPeer: (_pid, frame) => queueMicrotask(() => hostHub.handleIncomingMessage('tablet-peer', frame))
    })

    await Promise.all([hostHub.attachPeer('tablet-peer'), peerHub.attachPeer('host')])

    // 1. Offline-capable Tag add & soft-delete (mock HTTP offline failure -> succeeds via CRDT!)
    vi.mocked(api.addTeamTag).mockRejectedValueOnce(new Error('Offline'))
    vi.mocked(api.deleteTeamTag).mockRejectedValueOnce(new Error('Offline'))
    const tagRes = await recordStore.addTag('evt-uuid-1', 27570, 'fast_cycle', 'green', false)
    expect(tagRes.success).toBe(true)
    expect(recordStore.getTagsForTeam(27570, 'evt-uuid-1')).toHaveLength(1)

    vi.mocked(api.addTeamTag).mockResolvedValueOnce({
      id: 'tag-2',
      eventId: 'evt-uuid-1',
      teamNumber: 27570,
      tag: 'climber',
      color: 'blue',
      isPreset: false
    })
    await recordStore.addTag('evt-uuid-1', 27570, 'climber', 'blue', false)
    await recordStore.removeTag('evt-uuid-1', 27570, 'fast_cycle')

    // Soft delete held in CRDT as active: false (no delRow), and UI sees only 'climber'
    expect(session.handle.store.getCell(CRDT_TABLES.TEAM_TAGS, '27570::fast_cycle', 'active')).toBe(false)
    expect(recordStore.getTagsForTeam(27570, 'evt-uuid-1').map((t) => t.tag)).toEqual(['climber'])

    // 2. Pit initial baseline synced, then concurrent sibling field edits across Host & Peer
    await pitStore.saveRecord(makePit({ weightLbs: 28, launcherType: 'Flywheel', photoKeys: ['p1.jpg'] }))
    await vi.waitFor(() => {
      expect(readPitRecordsFromCrdt(peerStore, 'evt-uuid-1')[0]?.photoKeys).toEqual(['p1.jpg'])
    })

    // Simulate true concurrent edits on distinct fields before WebRTC microtask delivery completes
    clockMs += 1_000
    const concurrentSave = pitStore.saveRecord(makePit({ weightLbs: 32.5, launcherType: 'Flywheel', photoKeys: ['p1.jpg'] }))
    writePitRecordToCrdt(peerStore, makePit({ weightLbs: 28, launcherType: 'Turret', photoKeys: ['p1.jpg', 'p2.jpg'] }))
    await concurrentSave

    // Both sibling edits + union of photoKeys appear reactively inside Pinia pitStore!
    await vi.waitFor(() => {
      const reactivePit = pitStore.records.find((r) => r.teamNumber === 27570)
      expect(reactivePit?.weightLbs).toBe(32.5)
      expect(reactivePit?.launcherType).toBe('Turret')
      expect(reactivePit?.photoKeys).toEqual(['p1.jpg', 'p2.jpg'])
    })

    // 3. Schedule + Assignment updates flow cleanly through CRDT -> peerStore -> Pinia
    await scheduleStore.importSchedules('evt-uuid-1', [makeSchedule({ matchNumber: 1 }), makeSchedule({ matchNumber: 2 })], true, true)
    await scheduleStore.assignStation('evt-uuid-1', 1, 'red1', 'scout-bob', 'Bob', true, 'QUALIFICATION')
    await vi.waitFor(() => {
      expect(readSchedulesFromCrdt(peerStore, 'evt-uuid-1')).toHaveLength(2)
    })

    // 4. CustomFields fractional orderKey reorder + soft-delete converge reactively
    vi.mocked(api.createCustomField)
      .mockResolvedValueOnce(makeField({ id: 'cf-1', name: 'First', orderSeq: 1 }))
      .mockResolvedValueOnce(makeField({ id: 'cf-2', name: 'Second', orderSeq: 2 }))
      .mockResolvedValueOnce(makeField({ id: 'cf-3', name: 'Third', orderSeq: 3 }))
    await customFieldsStore.createField('evt-uuid-1', { name: 'First', fieldKey: 'f1' })
    await customFieldsStore.createField('evt-uuid-1', { name: 'Second', fieldKey: 'f2' })
    await customFieldsStore.createField('evt-uuid-1', { name: 'Third', fieldKey: 'f3' })

    vi.mocked(api.updateCustomField).mockImplementation(async (_eid, id, def) =>
      makeField({ id, name: def.name || id, orderSeq: Number(def.orderSeq || 1) })
    )
    await customFieldsStore.moveFieldOrder('evt-uuid-1', 'cf-3', 'up', 'MATCH')
    await vi.waitFor(() => {
      const peerOrdered = readCustomFieldsFromCrdt(peerStore, 'evt-uuid-1')
      expect(peerOrdered.map((f) => f.id)).toEqual(['cf-1', 'cf-3', 'cf-2'])
    })

    // Verify legacy broadcast suppression: NO legacy Pit/Tag/Schedule/CustomField WebRTC packets fired!
    expect(legacySendSpy).not.toHaveBeenCalled()

    // Deleting a custom field via remote CRDT propagates tombstone into customFieldsStore
    clockMs += 1_000
    writeCustomFieldToCrdt(peerStore, makeField({ id: 'cf-1' }), true)
    await vi.waitFor(() => {
      expect(customFieldsStore.getFields('evt-uuid-1').map((f) => f.id)).toEqual(['cf-3', 'cf-2'])
    })

    session.unbind()
    await Promise.all([hostHub.destroy(), peerHub.destroy()])
  })

  it('preserves CRDT soft-delete tombstones over stale legacy localStorage and triggers Desktop catch-up flush', async () => {
    const pitStore = usePitScoutStore()
    const scheduleStore = useScheduleStore()
    const customFieldsStore = useCustomFieldsStore()
    const recordStore = useRecordStore()

    // Seed stale legacy localStorage BEFORE hydrate (has a tag that was already tombstoned in H2!)
    const staleTag: TeamTagItem = {
      id: 't1',
      eventId: 'evt-h2',
      teamNumber: 27570,
      tag: 'stale_deleted_tag',
      color: 'red',
      isPreset: false
    }
    recordStore.teamTags = [staleTag]

    // Build an H2 snapshot carrying active: false tombstone for stale_deleted_tag + a pit record
    const serverOriginStore = createMergeableStore('srv', () => 1_700_001_000_000, 300)
    writeTeamTagToCrdt(serverOriginStore, staleTag, false)
    writePitRecordToCrdt(serverOriginStore, makePit({ eventId: 'evt-h2', teamNumber: 9999, weightLbs: 35 }))

    const savedFlushes: Array<{ dirtyRows: Record<string, string[]> }> = []
    const transport: CrdtHttpTransport = {
      loadState: vi.fn(async () => ({
        exists: true,
        eventId: 'evt-h2',
        hostEpoch: 2,
        snapshotRevision: 3,
        snapshot: serverOriginStore.getMergeableContent()
      })),
      saveState: vi.fn(async (eventId, payload) => {
        savedFlushes.push({ dirtyRows: payload.dirtyRows })
        return {
          saved: true,
          eventId,
          hostEpoch: payload.hostEpoch,
          snapshotRevision: payload.snapshotRevision
        }
      })
    }

    const session = await hydrateAndBindEventCrdt({
      eventId: 'evt-h2',
      deviceId: 'host-dev',
      transport,
      enableHttp: true,
      enableIndexedDb: false,
      isDesktopHost: true,
      stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
    })

    // H2 tombstone MUST NOT be resurrected by legacy localStorage, and pit record projects into pitStore
    expect(recordStore.getTagsForTeam(27570, 'evt-h2')).toEqual([])
    expect(session.handle.store.getCell(CRDT_TABLES.TEAM_TAGS, '27570::stale_deleted_tag', 'active')).toBe(false)
    expect(pitStore.records.find((r) => r.teamNumber === 9999)?.weightLbs).toBe(35)

    session.unbind()
  })

  it('seeds cold-start legacy data and schedules catch-up flush on Desktop Host when H2 has no snapshot yet', async () => {
    vi.useFakeTimers()
    try {
      const pitStore = usePitScoutStore()
      const scheduleStore = useScheduleStore()
      const customFieldsStore = useCustomFieldsStore()
      const recordStore = useRecordStore()

      pitStore.records = [makePit({ eventId: 'evt-cold', teamNumber: 4444, weightLbs: 26 })]
      recordStore.teamTags = [
        { id: 't-cold', eventId: 'evt-cold', teamNumber: 4444, tag: 'legacy_tag', color: 'blue', isPreset: false }
      ]

      const savedPayloads: Array<{ dirtyRows: Record<string, string[]> }> = []
      const transport: CrdtHttpTransport = {
        loadState: vi.fn(async () => ({
          exists: false,
          eventId: 'evt-cold',
          hostEpoch: 1,
          snapshotRevision: 0,
          snapshot: null
        })),
        saveState: vi.fn(async (eventId, payload) => {
          savedPayloads.push({ dirtyRows: payload.dirtyRows })
          return {
            saved: true,
            eventId,
            hostEpoch: payload.hostEpoch,
            snapshotRevision: payload.snapshotRevision
          }
        })
      }

      const session = await hydrateAndBindEventCrdt({
        eventId: 'evt-cold',
        deviceId: 'host-cold',
        transport,
        enableHttp: true,
        enableIndexedDb: false,
        isDesktopHost: true,
        debounceMs: 200,
        maxWaitMs: 500,
        stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
      })

      await vi.advanceTimersByTimeAsync(300)
      expect(savedPayloads.length).toBe(1)
      expect(savedPayloads[0]?.dirtyRows[CRDT_TABLES.PIT_RECORDS]).toEqual(['4444'])
      expect(savedPayloads[0]?.dirtyRows[CRDT_TABLES.TEAM_TAGS]).toEqual(['4444::legacy_tag'])

      session.unbind()
    } finally {
      vi.useRealTimers()
    }
  })

  it('roundtrips crdtSnapshot losslessly through offlineSync createSyncPackage & executeBatchSyncImport', async () => {
    const pitStore = usePitScoutStore()
    const scheduleStore = useScheduleStore()
    const customFieldsStore = useCustomFieldsStore()
    const recordStore = useRecordStore()
    const targetHandle = await hydrateAndBindEventCrdt({
      eventId: 'evt-usb',
      deviceId: 'host-usb',
      enableHttp: false,
      enableIndexedDb: false,
      stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
    })

    // Pre-populate active tag in target before exporter deletes it slightly later
    writeTeamTagToCrdt(
      targetHandle.handle.store,
      { id: 't-usb', eventId: 'evt-usb', teamNumber: 27570, tag: 'old_removed', color: 'blue', isPreset: false },
      true
    )
    expect(readTeamTagsFromCrdt(targetHandle.handle.store, 'evt-usb')).toHaveLength(1)

    let clockMs = targetHandle.handle.clock.now() + 2_000
    const exporterStore = createMergeableStore('usb-exporter', () => clockMs, 300)
    writePitRecordToCrdt(exporterStore, makePit({ eventId: 'evt-usb', teamNumber: 27570, weightLbs: 31.2 }))
    writeTeamTagToCrdt(
      exporterStore,
      { id: 't-usb', eventId: 'evt-usb', teamNumber: 27570, tag: 'old_removed', color: 'blue', isPreset: false },
      true
    )
    clockMs += 1_000
    setTeamTagActive(
      exporterStore,
      'evt-usb',
      { id: 't-usb', eventId: 'evt-usb', teamNumber: 27570, tag: 'old_removed', color: 'blue', isPreset: false },
      false
    )

    const infoJson = createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: 'evt-usb',
      eventName: 'USB Event',
      sender: { userId: 'bob', username: 'Bob', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [],
      crdtSnapshot: exporterStore.getMergeableContent()
    })

    const file = new File([infoJson], 'USB_Bob_to_HOST_r0.info', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => infoJson })
    const scanResult = await scanFilesAndFolders([file], 'evt-usb')
    expect(scanResult.matchedSyncFiles).toHaveLength(1)

    await executeBatchSyncImport({
      scanResult,
      targetEventId: 'evt-usb',
      isHost: true,
      events: [],
      bulkSync: async (recs) => recs,
      applyCrdtSnapshot: (snap) => targetHandle.handle.persistence.applyMergeableSnapshot(snap, true)
    })

    expect(pitStore.records.find((r) => r.teamNumber === 27570)?.weightLbs).toBe(31.2)
    expect(readTeamTagsFromCrdt(targetHandle.handle.store, 'evt-usb')).toEqual([])
    expect(recordStore.getTagsForTeam(27570, 'evt-usb')).toEqual([])

    targetHandle.unbind()
  })

  it('flushes dirty CRDT to H2 before JWT wipe on logout and rehydrates cleanly for next user (Bob -> Alice takeover)', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'bob', username: 'AssistantBob', token: 'bob-jwt-token' }
    localStorage.setItem('scoutingpro-user', JSON.stringify(userStore.user))

    // Simulated shared H2 table on Backup Computer B
    let h2Snapshot: unknown = null
    let h2Revision = 0
    let observedAuthTokenDuringFlush: string | null = null

    const sharedH2Transport: CrdtHttpTransport = {
      loadState: vi.fn(async (eventId) => ({
        exists: h2Snapshot !== null,
        eventId,
        hostEpoch: 1,
        snapshotRevision: h2Revision,
        snapshot: h2Snapshot
      })),
      saveState: vi.fn(async (eventId, payload) => {
        const rawUser = localStorage.getItem('scoutingpro-user')
        observedAuthTokenDuringFlush = rawUser ? JSON.parse(rawUser).token : null
        if (!observedAuthTokenDuringFlush) {
          throw new Error('401 Unauthorized: JWT already cleared')
        }
        h2Snapshot = JSON.parse(JSON.stringify(payload.snapshot))
        h2Revision = payload.snapshotRevision
        return {
          saved: true,
          eventId,
          hostEpoch: payload.hostEpoch,
          snapshotRevision: h2Revision
        }
      })
    }

    const pitStore = usePitScoutStore()
    const scheduleStore = useScheduleStore()
    const customFieldsStore = useCustomFieldsStore()
    const recordStore = useRecordStore()
    pitStore.currentEventId = 'evt-b'
    scheduleStore.currentEventId = 'evt-b'

    const bobSession = await hydrateAndBindEventCrdt({
      eventId: 'evt-b',
      deviceId: 'backup-laptop-b',
      transport: sharedH2Transport,
      enableHttp: true,
      enableIndexedDb: false,
      debounceMs: 10_000,
      stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
    })
    setCrdtTransportActive('evt-b', true)

    await scheduleStore.importSchedules('evt-b', [makeSchedule({ eventId: 'evt-b', matchNumber: 10 })], true, false)
    await scheduleStore.assignStation('evt-b', 10, 'blue2', 'scout-charlie', 'Charlie', false, 'QUALIFICATION')

    // Bob logs out cleanly before debounce fires -> beforeLogout hook flushes BEFORE JWT is wiped and disposes handle!
    await userStore.logout()
    expect(observedAuthTokenDuringFlush).toBe('bob-jwt-token')
    expect(h2Snapshot).not.toBeNull()
    expect(getExistingEventCrdt('evt-b')).toBeUndefined()
    expect(isCrdtTransportActive('evt-b')).toBe(false)
    bobSession.unbind()

    // LeadAlice logs into the same Computer B and opens evt-b -> hydrates Bob's offline assignment cleanly from H2!
    userStore.user = { id: 'alice', username: 'LeadAlice', token: 'alice-jwt-token' }
    localStorage.setItem('scoutingpro-user', JSON.stringify(userStore.user))

    const aliceSession = await hydrateAndBindEventCrdt({
      eventId: 'evt-b',
      deviceId: 'backup-laptop-b',
      transport: sharedH2Transport,
      enableHttp: true,
      enableIndexedDb: false,
      stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
    })

    expect(scheduleStore.schedules).toHaveLength(1)
    expect(scheduleStore.schedules[0]?.matchNumber).toBe(10)
    expect(scheduleStore.getStationAssignment(10, 'blue2', 'QUALIFICATION')?.scoutName).toBe('Charlie')

    aliceSession.unbind()
  })

  it('deletes record offline into CRDT tombstone and converges tombstone to Host upon reconnection', async () => {
    vi.spyOn(api, 'saveRecord').mockResolvedValue(undefined as any)
    vi.spyOn(api, 'isStaticCloudHost').mockReturnValue(false)

    const recordStore = useRecordStore()
    const userStore = useUserStore()
    const eventStore = useEventStore()
    userStore.user = { id: 'scout-1', username: 'ScoutOne' }
    eventStore.currentEvent = { id: 'evt-real-uuid', hostId: 'host-1' } as any

    const scoutHandle = getOrCreateEventCrdt('evt-real-uuid', {
      deviceId: 'dev-scout-1',
      enableHttp: false,
      enableIndexedDb: false
    })
    let hostNow = Date.now() - 5_000
    const hostStore = createMergeableStore('dev-host-1', () => hostNow, 300)

    const rec: ScoutingRecord = {
      id: 'rec-tomb-1',
      eventId: 'evt-real-uuid',
      scoutId: 'scout-1',
      scoutName: 'ScoutOne',
      matchNumber: 1,
      teamNumber: 27570,
      autoScore: 0,
      teleopScore: 0,
      endgameScore: 0,
      totalScore: 120,
      notes: '',
      rawData: '{}',
      version: 1,
      isDeleted: false,
      syncStatus: 'SYNCED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    recordStore.records.push(rec)
    writeScoutingRecordToCrdt(scoutHandle.store, rec)
    writeScoutingRecordToCrdt(hostStore, rec)

    await recordStore.deleteRecord('rec-tomb-1')

    expect(rec.isDeleted).toBe(true)
    expect(rec.syncStatus).toBe('PENDING')
    expect(rec.version).toBe(2)
    expect(recordStore.myRecords('scout-1')).toHaveLength(0)

    const scoutCrdtRec = readScoutingRecordsFromCrdt(scoutHandle.store, 'evt-real-uuid').find((r) => r.id === 'rec-tomb-1')
    expect(scoutCrdtRec?.isDeleted).toBe(true)
    expect(scoutCrdtRec?.version).toBe(2)

    hostNow = Math.max(Date.now(), scoutHandle.clock.now())
    let hostHub!: ReturnType<typeof createWebRtcCrdtSynchronizerHub>
    let scoutHub!: ReturnType<typeof createWebRtcCrdtSynchronizerHub>
    hostHub = createWebRtcCrdtSynchronizerHub({
      eventId: 'evt-real-uuid',
      store: hostStore,
      clientId: 'dev-host-1',
      getNowMs: () => hostNow,
      sendToPeer: (_peerId, msg) => queueMicrotask(() => scoutHub.handleIncomingMessage('host', msg))
    })
    scoutHub = createWebRtcCrdtSynchronizerHub({
      eventId: 'evt-real-uuid',
      store: scoutHandle.store,
      clientId: 'dev-scout-1',
      getNowMs: () => scoutHandle.clock.now(),
      sendToPeer: (_peerId, msg) => queueMicrotask(() => hostHub.handleIncomingMessage('scout-1', msg))
    })

    await Promise.all([hostHub.attachPeer('scout-1'), scoutHub.attachPeer('host')])

    await vi.waitFor(() => {
      const hostRec = readScoutingRecordsFromCrdt(hostStore, 'evt-real-uuid').find((r) => r.id === 'rec-tomb-1')
      expect(hostRec?.isDeleted).toBe(true)
      expect(hostRec?.version).toBe(2)
    }, { timeout: 2000 })

    await Promise.all([hostHub.destroy(), scoutHub.destroy()])
  })
})
