import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMergeableStore } from 'tinybase'
import {
  hydrateAndBindEventCrdt,
  readAssignmentsFromCrdt,
  readCustomFieldsFromCrdt,
  readMemberIdentitiesFromCrdt,
  readPitRecordsFromCrdt,
  readSchedulesFromCrdt,
  readScoutingRecordsFromCrdt,
  readTeamTagsFromCrdt,
  resetCrdtRegistryForTesting,
  setPitPhotoKeyActive,
  signScoutingRecordWithDeviceKey,
  writeAssignmentToCrdt,
  writeCustomFieldToCrdt,
  writeMemberIdentityToCrdt,
  writePitRecordToCrdt,
  writeScheduleToCrdt,
  writeScoutingRecordToCrdt,
  writeTeamTagToCrdt
} from '@/services/crdt'
import { useCustomFieldsStore } from '@/stores/customFields'
import { usePitScoutStore } from '@/stores/pitScout'
import { useRecordStore } from '@/stores/records'
import { useScheduleStore } from '@/stores/schedule'
import {
  sanitizeFileSegment,
  formatDateTag,
  generateEventFileName,
  generateSyncFileName,
  createEventPackage,
  parseEventPackage,
  createSyncPackage,
  parseSyncPackage,
  buildClientExportCrdtSnapshot,
  validateSyncPackageSecurity,
  scanFilesAndFolders,
  executeBatchSyncImport
} from '@/utils/offlineSync'
import type { PitScoutingRecord, ScoutingEvent, ScoutingRecord } from '@/types'

describe('offlineSync Utility', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    await resetCrdtRegistryForTesting()
  })

  afterEach(async () => {
    await resetCrdtRegistryForTesting()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  const dummyEvent: ScoutingEvent = {
    id: 'evt_2025_cnc',
    name: '2025 FTC China Championship',
    inviteCode: 'CHAMP25',
    season: 2025,
    ftcYear: 2025,
    ftcEventCode: 'CNCMPLB',
    createdAt: '2026-09-06T10:00:00.000Z'
  }

  const dummyRecord1: ScoutingRecord = {
    id: 'rec_1',
    eventId: 'evt_2025_cnc',
    scoutId: 'usr_alice',
    scoutName: 'Alice',
    matchNumber: 1,
    teamNumber: 27570,
    autoScore: 20,
    teleopScore: 30,
    endgameScore: 15,
    totalScore: 65,
    notes: 'Good match',
    rawData: '{}',
    syncStatus: 'PENDING',
    createdAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-06T10:05:00.000Z',
    isBroken: false,
    version: 1
  }

  const dummyRecord2: ScoutingRecord = {
    id: 'rec_2',
    eventId: 'evt_2025_cnc',
    scoutId: 'usr_bob',
    scoutName: 'Bob',
    matchNumber: 1,
    teamNumber: 118,
    autoScore: 10,
    teleopScore: 25,
    endgameScore: 10,
    totalScore: 45,
    notes: 'Solid teleop',
    rawData: '{}',
    syncStatus: 'SYNCED',
    createdAt: '2026-09-06T10:02:00.000Z',
    updatedAt: '2026-09-06T10:06:00.000Z',
    isBroken: false,
    version: 1
  }

  it('sanitizes filename segments safely', () => {
    expect(sanitizeFileSegment('2025 FTC/China:Champ*')).toBe('2025_FTC_China_Champ_')
    expect(sanitizeFileSegment('  Alice  ')).toBe('Alice')
    expect(sanitizeFileSegment('')).toBe('unknown')
  })

  it('formats dates consistently', () => {
    const fixedDate = new Date('2026-09-06T10:15:00Z')
    const tagFull = formatDateTag(fixedDate, true)
    expect(tagFull).toContain('20260906_')
    const tagDateOnly = formatDateTag(fixedDate, false)
    expect(tagDateOnly).toBe('20260906')
  })

  it('generates event file names according to specification', () => {
    const fixedDate = new Date('2026-09-06T10:15:00Z')
    const filename = generateEventFileName(dummyEvent, fixedDate)
    expect(filename).toBe('CNCMPLB_CHAMP25_20260906.event')
  })

  it('generates sync file names with clear version ranges and recipient', () => {
    const fixedDate = new Date('2026-09-06T10:15:00Z')

    // Client -> Host
    const clientFileName = generateSyncFileName({
      eventName: 'CNCMPLB',
      senderName: 'Alice',
      isHost: false,
      recordCount: 4,
      exportedAt: fixedDate
    })
    expect(clientFileName).toMatch(/^CNCMPLB_Alice_to_HOST_r4_20260906_/)
    expect(clientFileName.endsWith('.info')).toBe(true)

    // Host -> All Scouts
    const hostToAllFileName = generateSyncFileName({
      eventName: 'CNCMPLB',
      senderName: 'HostAdmin',
      isHost: true,
      targetName: 'ALL',
      recordCount: 35,
      exportedAt: fixedDate
    })
    expect(hostToAllFileName).toMatch(/^CNCMPLB_HOST_to_ALL_r35_20260906_/)
    expect(hostToAllFileName.endsWith('.info')).toBe(true)

    // Host -> Specific Scout
    const hostToScoutFileName = generateSyncFileName({
      eventName: 'CNCMPLB',
      senderName: 'HostAdmin',
      isHost: true,
      targetName: 'Bob',
      recordCount: 23,
      exportedAt: fixedDate
    })
    expect(hostToScoutFileName).toMatch(/^CNCMPLB_HOST_to_Bob_r23_20260906_/)
    expect(hostToScoutFileName.endsWith('.info')).toBe(true)
  })

  it('creates and parses valid .event packages', () => {
    const jsonStr = createEventPackage(dummyEvent, {
      userId: 'usr_host',
      username: 'Lucalmz',
      role: 'HOST'
    })
    const parsed = parseEventPackage(jsonStr)
    expect(parsed.format).toBe('SCOUTING_PRO_27_EVENT')
    expect(parsed.event.id).toBe(dummyEvent.id)
    expect(parsed.event.inviteCode).toBe('CHAMP25')
    expect(parsed.exportedBy.username).toBe('Lucalmz')

    // Invalid json or format tag throws
    expect(() => parseEventPackage('invalid json')).toThrow()
    expect(() => parseEventPackage(JSON.stringify({ format: 'WRONG' }))).toThrow()
  })

  it('creates and parses valid .info packages', () => {
    const jsonStr = createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: dummyEvent.id,
      eventName: dummyEvent.name,
      sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [dummyRecord1]
    })

    const parsed = parseSyncPackage(jsonStr)
    expect(parsed.format).toBe('SCOUTING_PRO_27_SYNC')
    expect(parsed.packetType).toBe('CLIENT_PUSH')
    expect(parsed.syncRange.recordCount).toBe(1)
    expect((parsed.syncRange as any).fromHostSeq).toBeUndefined()
    expect(parsed.payload.records).toHaveLength(1)
    expect(parsed.payload.records[0].id).toBe('rec_1')

    // Invalid json or format tag throws
    expect(() => parseSyncPackage('invalid')).toThrow()
    expect(() => parseSyncPackage(JSON.stringify({ format: 'WRONG' }))).toThrow()
  })

  it('validates sync package security and drops forged records during Host import', () => {
    // 1. Event ID mismatch
    const pkgMismatch = JSON.parse(createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: 'other_evt',
      eventName: 'Other',
      sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [dummyRecord1]
    }))
    const res1 = validateSyncPackageSecurity(pkgMismatch, 'evt_2025_cnc', true)
    expect(res1.valid).toBe(false)
    expect(res1.error).toContain('赛事不匹配')

    // 2. Host imports Client Push containing forged record (scoutId mismatch)
    const forgedRecord: ScoutingRecord = {
      ...dummyRecord1,
      id: 'rec_forged',
      scoutId: 'usr_eve' // does not match Alice!
    }
    const pkgWithForged = JSON.parse(createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: 'evt_2025_cnc',
      eventName: 'CNCMPLB',
      sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [dummyRecord1, forgedRecord]
    }))

    const res2 = validateSyncPackageSecurity(pkgWithForged, 'evt_2025_cnc', true)
    expect(res2.valid).toBe(true)
    expect(res2.legitimateRecords).toHaveLength(1)
    expect(res2.legitimateRecords[0].id).toBe('rec_1')
    expect(res2.droppedRecordIds).toEqual(['rec_forged'])
  })

  it('scans mixed files and folders, automatically filtering irrelevant files and matching valid packages', async () => {
    // 1. Valid event file
    const eventJson = createEventPackage(dummyEvent, {
      userId: 'usr_host',
      username: 'Lucalmz',
      role: 'HOST'
    })
    const eventFile = new File([eventJson], 'CNCMPLB_CHAMP25_20260906.event', { type: 'application/json' })

    // 2. Valid sync file matching current event
    const syncJson = createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: dummyEvent.id,
      eventName: dummyEvent.name,
      sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [dummyRecord1]
    })
    const syncFile = new File([syncJson], 'CNCMPLB_Alice_to_HOST_r1_20260906.info', { type: 'application/json' })

    // 3. Valid sync file from a different event
    const otherSyncJson = createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: 'other_event_id',
      eventName: 'Other Event',
      sender: { userId: 'usr_bob', username: 'Bob', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [dummyRecord2]
    })
    const otherSyncFile = new File([otherSyncJson], 'OTHER_Bob_to_HOST_r1_20260906.info', { type: 'application/json' })

    // 4. Image file (should be fast-skipped)
    const imgFile = new File(['fake binary content'], 'robot_photo.png', { type: 'image/png' })

    // 5. Irrelevant text file
    const txtFile = new File(['Hello World this is random notes'], 'notes.txt', { type: 'text/plain' })

    const files = [eventFile, syncFile, otherSyncFile, imgFile, txtFile]
    const result = await scanFilesAndFolders(files, dummyEvent.id)

    expect(result.totalScannedFiles).toBe(5)
    expect(result.ignoredFiles).toBe(3) // otherSyncFile (different event), imgFile (.png), txtFile (not a package)
    expect(result.matchedEventFiles).toHaveLength(1)
    expect(result.matchedEventFiles[0].eventPkg?.event.id).toBe(dummyEvent.id)
    expect(result.matchedSyncFiles).toHaveLength(1)
    expect(result.matchedSyncFiles[0].syncPkg?.sender.username).toBe('Alice')
    expect(result.totalRecords).toBe(1)
  })

  it('executes batch import for Host (merges CRDT/records, blocks forged snapshots, persists to DB, handles events)', async () => {
    const eventJson = createEventPackage(dummyEvent, {
      userId: 'usr_host',
      username: 'Lucalmz',
      role: 'HOST'
    })
    const eventFile = new File([eventJson], 'event.event')

    const syncAlice = createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: dummyEvent.id,
      eventName: dummyEvent.name,
      sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [dummyRecord1]
    })
    const fileAlice = new File([syncAlice], 'alice.info')

    const scanRes = await scanFilesAndFolders([eventFile, fileAlice], dummyEvent.id)
    const eventsList: ScoutingEvent[] = []
    const syncedRecords: ScoutingRecord[] = []
    let dbPersistedCalled = false
    let externalSyncedEvt: ScoutingEvent | null = null

    const importRes = await executeBatchSyncImport({
      scanResult: scanRes,
      targetEventId: dummyEvent.id,
      isHost: true,
      events: eventsList,
      bulkSync: async (recs) => {
        syncedRecords.push(...recs)
        return recs
      },
      persistRecordsToDb: async () => {
        dbPersistedCalled = true
      },
      syncExternalEvent: async (evt) => {
        externalSyncedEvt = evt
      }
    })

    expect(importRes.totalFiles).toBe(2)
    expect(importRes.totalAccepted).toBe(1)
    expect(importRes.totalDropped).toBe(0)
    expect(importRes.importedEventId).toBe(dummyEvent.id)
    expect(eventsList).toHaveLength(1)
    expect(syncedRecords).toHaveLength(1)
    expect(dbPersistedCalled).toBe(true)
    expect(externalSyncedEvt).toEqual(dummyEvent)

    // 1. Malformed crdtSnapshot attached to an otherwise valid CLIENT_PUSH (only Alice's own record!) must be rejected
    const malformedSnapSync = createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: dummyEvent.id,
      eventName: dummyEvent.name,
      sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [dummyRecord1],
      crdtSnapshot: [{}, '', 1]
    })
    const malformedScan = await scanFilesAndFolders([new File([malformedSnapSync], 'malformed.info')], dummyEvent.id)
    let snapshotApplied = false
    const malformedRes = await executeBatchSyncImport({
      scanResult: malformedScan,
      targetEventId: dummyEvent.id,
      isHost: true,
      events: eventsList,
      bulkSync: async (recs) => recs,
      applyCrdtSnapshot: () => {
        snapshotApplied = true
        return true
      }
    })
    expect(malformedRes.totalDropped).toBe(1)
    expect(snapshotApplied).toBe(false)

    // 2. Forged TinyBase crdtSnapshot containing another scout's row (even with records: []!) must be rejected
    const evilStore = createMergeableStore('dev-alice')
    writeScoutingRecordToCrdt(evilStore, {
      ...dummyRecord2,
      id: 'rec_forged_in_crdt_only',
      scoutId: 'usr_eve'
    })
    const crdtOnlyForgedSync = createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: dummyEvent.id,
      eventName: dummyEvent.name,
      sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [],
      crdtSnapshot: evilStore.getMergeableContent()
    })
    const crdtOnlyForgedScan = await scanFilesAndFolders([new File([crdtOnlyForgedSync], 'forged_crdt.info')], dummyEvent.id)
    const crdtOnlyForgedRes = await executeBatchSyncImport({
      scanResult: crdtOnlyForgedScan,
      targetEventId: dummyEvent.id,
      isHost: true,
      events: eventsList,
      bulkSync: async (recs) => recs,
      applyCrdtSnapshot: () => {
        snapshotApplied = true
        return true
      }
    })
    expect(crdtOnlyForgedRes.totalDropped).toBe(1)
    expect(snapshotApplied).toBe(false)

    // 3. Valid TinyBase crdtSnapshot containing ONLY Alice's own record IS applied on Host
    const legitimateClientStore = createMergeableStore('dev-alice')
    writeScoutingRecordToCrdt(legitimateClientStore, dummyRecord1)
    const validSnapSync = createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: dummyEvent.id,
      eventName: dummyEvent.name,
      sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [dummyRecord1],
      crdtSnapshot: legitimateClientStore.getMergeableContent()
    })
    const validSnapScan = await scanFilesAndFolders([new File([validSnapSync], 'valid_crdt.info')], dummyEvent.id)
    const validSnapRes = await executeBatchSyncImport({
      scanResult: validSnapScan,
      targetEventId: dummyEvent.id,
      isHost: true,
      events: eventsList,
      bulkSync: async (recs) => recs,
      applyCrdtSnapshot: () => {
        snapshotApplied = true
        return true
      }
    })
    expect(validSnapRes.totalDropped).toBe(0)
    expect(snapshotApplied).toBe(true)
  })

  it('executes batch import for Client (marks HOST_BROADCAST records as SYNCED without hostSeq, applies tags)', async () => {
    const hostRecord: ScoutingRecord = {
      ...dummyRecord2
    }
    const hostSyncJson = createSyncPackage({
      packetType: 'HOST_BROADCAST',
      eventId: dummyEvent.id,
      eventName: dummyEvent.name,
      sender: { userId: 'usr_host', username: 'HostAdmin', role: 'HOST' },
      target: { recipientType: 'ALL_SCOUTS' },
      records: [hostRecord],
      teamTags: [{ id: 'tag-1', eventId: dummyEvent.id, teamNumber: 27570, tag: 'AutoHigh', color: 'blue', isPreset: false }]
    })
    const hostFile = new File([hostSyncJson], 'host.info')
    const scanRes = await scanFilesAndFolders([hostFile], dummyEvent.id)

    const markedSyncedIds: string[] = []
    let appliedTags: any[] = []

    const importRes = await executeBatchSyncImport({
      scanResult: scanRes,
      targetEventId: dummyEvent.id,
      isHost: false,
      events: [],
      bulkSync: async (recs) => recs,
      markSynced: (ids) => { markedSyncedIds.push(...ids) },
      applyTagsFullSync: (tags) => { appliedTags = tags }
    })

    expect(importRes.totalFiles).toBe(1)
    expect(importRes.totalAccepted).toBe(1)
    expect(markedSyncedIds).toContain('rec_2')
    expect(appliedTags).toHaveLength(1)
    expect(appliedTags[0].teamNumber).toBe(27570)
  })

  it('buildClientExportCrdtSnapshot strips teammate rows & host-only tables so legitimate client push imports cleanly with totalDropped === 0', async () => {
    const clientStore = createMergeableStore('dev-alice')
    const aliceRec = { ...dummyRecord1 }
    const bobRec = { ...dummyRecord2 }
    const pitRec: PitScoutingRecord = {
      id: 'evt_2025_cnc_pit_27570',
      eventId: dummyEvent.id,
      teamNumber: 27570,
      scoutId: 'usr_alice',
      scoutName: 'Alice',
      robotName: 'Polaris',
      drivetrainType: 'mecanum',
      weightLbs: 32,
      ballCompatibility: 'universal',
      launcherType: 'Flywheel',
      flowerMechanism: 'Arm',
      hasColorSensor: false,
      hasDescoreMech: false,
      hasApriltagVision: false,
      odometryType: 'none',
      claimedAutoStrategy: '',
      claimedAutoScore: 10,
      claimedTeleopCycles: 5,
      claimedTeleopScore: 20,
      claimedTeleopPark: false,
      claimedFlowerNectars: 0,
      claimedFlowerBottomBonus: 0,
      claimedFlowerPollens: 0,
      claimedGardenBalls: 0,
      claimedEndgameScore: 0,
      claimedTotalScore: 30,
      photoKeys: ['photo_alice_1'],
      version: 1,
      isDeleted: false,
      syncStatus: 'PENDING'
    }

    writeScoutingRecordToCrdt(clientStore, aliceRec)
    writeScoutingRecordToCrdt(clientStore, bobRec)
    writeMemberIdentityToCrdt(clientStore, {
      eventId: dummyEvent.id,
      userId: 'usr_alice',
      deviceId: 'dev-alice',
      signingPubKeyHex: 'pub_alice',
      trustedAt: 1000
    })
    writeMemberIdentityToCrdt(clientStore, {
      eventId: dummyEvent.id,
      userId: 'usr_host',
      deviceId: 'dev-host',
      signingPubKeyHex: 'pub_host',
      trustedAt: 900
    })
    writePitRecordToCrdt(clientStore, pitRec)
    setPitPhotoKeyActive(clientStore, 27570, 'photo_alice_1', true, 'usr_alice')
    writeTeamTagToCrdt(
      clientStore,
      { id: 'tag-a', eventId: dummyEvent.id, teamNumber: 27570, tag: 'fast', color: 'green', isPreset: false },
      true
    )
    writeScheduleToCrdt(clientStore, {
      id: 'sched-1',
      eventId: dummyEvent.id,
      matchNumber: 1,
      tournamentLevel: 'QUALIFICATION',
      red1: 27570,
      red2: 118,
      blue1: 254,
      blue2: 1678
    })
    writeCustomFieldToCrdt(clientStore, {
      id: 'cf-1',
      eventId: dummyEvent.id,
      target: 'MATCH',
      phase: 'teleop',
      name: 'Defense',
      fieldKey: 'defense',
      fieldType: 'number',
      required: false,
      orderSeq: 1,
      isActive: true
    })
    writeAssignmentToCrdt(clientStore, {
      id: 'assign-1',
      eventId: dummyEvent.id,
      matchNumber: 1,
      tournamentLevel: 'QUALIFICATION',
      station: 'red1',
      teamNumber: 27570,
      scoutId: 'usr_alice',
      scoutName: 'Alice'
    })

    const filteredSnapshot = buildClientExportCrdtSnapshot(clientStore.getMergeableContent(), 'usr_alice', dummyEvent.id)
    expect(filteredSnapshot).toBeDefined()

    const pkgJson = createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: dummyEvent.id,
      eventName: dummyEvent.name,
      sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [aliceRec],
      crdtSnapshot: filteredSnapshot
    })

    const hostStore = createMergeableStore('dev-host')
    writeScheduleToCrdt(hostStore, {
      id: 'sched-host',
      eventId: dummyEvent.id,
      matchNumber: 2,
      tournamentLevel: 'QUALIFICATION',
      red1: 111,
      red2: 222,
      blue1: 333,
      blue2: 444
    })

    const scanRes = await scanFilesAndFolders([new File([pkgJson], 'alice_clean.info')], dummyEvent.id)
    let appliedToHost = false
    const importRes = await executeBatchSyncImport({
      scanResult: scanRes,
      targetEventId: dummyEvent.id,
      isHost: true,
      events: [],
      expectedHostUserId: 'usr_host',
      bulkSync: async (recs) => recs,
      applyCrdtSnapshot: (snap) => {
        hostStore.applyMergeableChanges([
          (snap as any)[0],
          (snap as any)[1],
          1
        ] as any)
        appliedToHost = true
        return true
      }
    })

    expect(importRes.totalDropped).toBe(0)
    expect(importRes.totalAccepted).toBe(1)
    expect(appliedToHost).toBe(true)
    expect(readScoutingRecordsFromCrdt(hostStore, dummyEvent.id).map((r) => r.id)).toEqual(['rec_1'])
    expect(readMemberIdentitiesFromCrdt(hostStore, dummyEvent.id).map((m) => m.userId)).toEqual(['usr_alice'])
    expect(readPitRecordsFromCrdt(hostStore, dummyEvent.id).map((p) => p.teamNumber)).toEqual([27570])
    expect(readTeamTagsFromCrdt(hostStore, dummyEvent.id).map((t) => t.tag)).toEqual(['fast'])
    expect(readSchedulesFromCrdt(hostStore, dummyEvent.id).map((s) => s.matchNumber)).toEqual([2])
    expect(readCustomFieldsFromCrdt(hostStore, dummyEvent.id)).toEqual([])
    expect(readAssignmentsFromCrdt(hostStore, dummyEvent.id)).toEqual({})
  })

  it('blocks spoofed HOST_BROADCAST, HLC downgrade record hijacking, and forbidden client CRDT tables/values', async () => {
    const existingOwners = new Map<string, string>([['rec_bob_existing', 'usr_bob']])

    // Bypass A: Spoofed packetType=HOST_BROADCAST + role=HOST without expectedHostUserId (and with forged other-scout record)
    const spoofedBroadcast = JSON.parse(
      createSyncPackage({
        packetType: 'HOST_BROADCAST',
        eventId: dummyEvent.id,
        eventName: dummyEvent.name,
        sender: { userId: 'usr_eve', username: 'FakeHost', role: 'HOST' },
        target: { recipientType: 'ALL_SCOUTS' },
        records: [{ ...dummyRecord2, id: 'rec_bob_forged' }]
      })
    )
    const secA1 = validateSyncPackageSecurity(spoofedBroadcast, dummyEvent.id, true, {
      expectedHostUserId: 'usr_real_host',
      existingRecordOwners: existingOwners
    })
    expect(secA1.legitimateRecords).toHaveLength(0)
    expect(secA1.droppedRecordIds).toContain('rec_bob_forged')

    // Even if sender.userId claims real hostId, unsigned other-scout record in HOST_BROADCAST is rejected by executeBatchSyncImport
    const spoofedSenderHost = createSyncPackage({
      packetType: 'HOST_BROADCAST',
      eventId: dummyEvent.id,
      eventName: dummyEvent.name,
      sender: { userId: 'usr_real_host', username: 'RealHost', role: 'HOST' },
      target: { recipientType: 'ALL_SCOUTS' },
      records: [{ ...dummyRecord2, id: 'rec_unsigned_bob' }]
    })
    const scanA2 = await scanFilesAndFolders([new File([spoofedSenderHost], 'spoof_host.info')], dummyEvent.id)
    const resA2 = await executeBatchSyncImport({
      scanResult: scanA2,
      targetEventId: dummyEvent.id,
      isHost: true,
      events: [],
      expectedHostUserId: 'usr_real_host',
      bulkSync: async (recs) => recs
    })
    expect(resA2.totalAccepted).toBe(0)
    expect(resA2.totalDropped).toBe(1)

    // Bypass B: Cell-level HLC downgrade / ownership hijack on existing Bob record rec_bob_existing
    const hijackStore = createMergeableStore('dev-alice')
    writeScoutingRecordToCrdt(hijackStore, {
      ...dummyRecord2,
      id: 'rec_bob_existing',
      scoutId: 'usr_alice',
      totalScore: 999
    })
    const hijackPkg = JSON.parse(
      createSyncPackage({
        packetType: 'CLIENT_PUSH',
        eventId: dummyEvent.id,
        eventName: dummyEvent.name,
        sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
        target: { recipientType: 'HOST' },
        records: [{ ...dummyRecord2, id: 'rec_bob_existing', scoutId: 'usr_alice', version: 99 }],
        crdtSnapshot: hijackStore.getMergeableContent()
      })
    )
    const secB = validateSyncPackageSecurity(hijackPkg, dummyEvent.id, true, {
      expectedHostUserId: 'usr_real_host',
      existingRecordOwners: existingOwners
    })
    expect(secB.legitimateRecords).toHaveLength(0)
    expect(secB.droppedRecordIds).toContain('rec_bob_existing')

    // Bypass C: Forbidden tables (schedules/custom_fields/assignments), non-empty valuesStamp, cross-event rows, and table tombstone
    const crossEventStore = createMergeableStore('dev-alice')
    writeScoutingRecordToCrdt(crossEventStore, { ...dummyRecord1, eventId: 'other_event_id' })
    const rawCrossSnap = crossEventStore.getMergeableContent() as any

    const forbiddenSnapshots: unknown[] = [
      // Forbidden schedule table
      [
        [{ schedules: [{ m1: [{ matchNumber: [1, 'H1'] }, 'H1'] }, 'H1'] }, 'H1'],
        [{}, '']
      ],
      // Non-empty valuesStamp
      [
        [{}, ''],
        [{ rogueVal: [1, 'H1'] }, 'H1']
      ],
      // Cross-event row inside CRDT
      rawCrossSnap,
      // Empty table deletion tombstone with HLC
      [
        [{ scouting_records: [{}, 'FutureHlcTombstone1'] }, ''],
        [{}, '']
      ]
    ]

    for (let i = 0; i < forbiddenSnapshots.length; i++) {
      const pkg = JSON.parse(
        createSyncPackage({
          packetType: 'CLIENT_PUSH',
          eventId: dummyEvent.id,
          eventName: dummyEvent.name,
          sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
          target: { recipientType: 'HOST' },
          records: [],
          crdtSnapshot: forbiddenSnapshots[i]
        })
      )
      const secC = validateSyncPackageSecurity(pkg, dummyEvent.id, true, {
        expectedHostUserId: 'usr_real_host'
      })
      expect(secC.droppedRecordIds.length).toBeGreaterThan(0)
    }
  })

  it('persists new records to DB and updates pitStore even when CLIENT_PUSH also carries crdtSnapshot with live CRDT bridge (Bug 2 regression)', async () => {
    const pitStore = usePitScoutStore()
    const scheduleStore = useScheduleStore()
    const customFieldsStore = useCustomFieldsStore()
    const recordStore = useRecordStore()

    const session = await hydrateAndBindEventCrdt({
      eventId: dummyEvent.id,
      deviceId: 'dev-host-bridge',
      enableHttp: false,
      enableIndexedDb: false,
      stores: { pitStore, scheduleStore, customFieldsStore, recordStore }
    })

    const clientStore = createMergeableStore('dev-alice-bridge')
    const aliceRec: ScoutingRecord = { ...dummyRecord1 }
    await signScoutingRecordWithDeviceKey(aliceRec)
    writeScoutingRecordToCrdt(clientStore, aliceRec)
    writePitRecordToCrdt(clientStore, {
      id: `${dummyEvent.id}_pit_27570`,
      eventId: dummyEvent.id,
      teamNumber: 27570,
      scoutId: 'usr_alice',
      scoutName: 'Alice',
      robotName: 'BridgeBot',
      drivetrainType: 'swerve',
      weightLbs: 29.5,
      ballCompatibility: 'universal',
      launcherType: 'Turret',
      flowerMechanism: 'Lift',
      hasColorSensor: true,
      hasDescoreMech: false,
      hasApriltagVision: true,
      odometryType: 'pinpoint',
      claimedAutoStrategy: '',
      claimedAutoScore: 20,
      claimedTeleopCycles: 5,
      claimedTeleopScore: 40,
      claimedTeleopPark: true,
      claimedFlowerNectars: 2,
      claimedFlowerBottomBonus: 1,
      claimedFlowerPollens: 2,
      claimedGardenBalls: 1,
      claimedEndgameScore: 15,
      claimedTotalScore: 75,
      photoKeys: [],
      version: 1,
      isDeleted: false,
      syncStatus: 'PENDING'
    })

    const pkgJson = createSyncPackage({
      packetType: 'CLIENT_PUSH',
      eventId: dummyEvent.id,
      eventName: dummyEvent.name,
      sender: { userId: 'usr_alice', username: 'Alice', role: 'SCOUT' },
      target: { recipientType: 'HOST' },
      records: [aliceRec],
      crdtSnapshot: buildClientExportCrdtSnapshot(clientStore.getMergeableContent(), 'usr_alice', dummyEvent.id)
    })

    const persistedToDb: ScoutingRecord[] = []
    const scanRes = await scanFilesAndFolders([new File([pkgJson], 'bridge.info')], dummyEvent.id)
    const importRes = await executeBatchSyncImport({
      scanResult: scanRes,
      targetEventId: dummyEvent.id,
      isHost: true,
      events: [],
      expectedHostUserId: 'usr_host',
      bulkSync: recordStore.bulkSync,
      persistRecordsToDb: async (recs) => {
        persistedToDb.push(...recs)
      },
      applyCrdtSnapshot: (snap) => session.handle.persistence.applyMergeableSnapshot(snap, true)
    })

    expect(importRes.totalDropped).toBe(0)
    expect(importRes.totalAccepted).toBe(1)
    expect(persistedToDb.map((r) => r.id)).toEqual(['rec_1'])
    expect(recordStore.records.find((r) => r.id === 'rec_1')?.totalScore).toBe(65)
    expect(pitStore.records.find((p) => p.teamNumber === 27570)?.robotName).toBe('BridgeBot')

    session.unbind()
  })
})


