import { describe, it, expect } from 'vitest'
import {
  sanitizeFileSegment,
  formatDateTag,
  generateEventFileName,
  generateSyncFileName,
  createEventPackage,
  parseEventPackage,
  createSyncPackage,
  parseSyncPackage,
  validateSyncPackageSecurity,
  scanFilesAndFolders,
  executeBatchSyncImport
} from '@/utils/offlineSync'
import type { ScoutingEvent, ScoutingRecord } from '@/types'

describe('offlineSync Utility', () => {
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
    version: 1,
    hostSeq: 5
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
      fromSeq: 0,
      toSeq: 35,
      recordCount: 35,
      exportedAt: fixedDate
    })
    expect(hostToAllFileName).toMatch(/^CNCMPLB_HOST_to_ALL_v0_to_v35_20260906_/)
    expect(hostToAllFileName.endsWith('.info')).toBe(true)

    // Host -> Specific Scout
    const hostToScoutFileName = generateSyncFileName({
      eventName: 'CNCMPLB',
      senderName: 'HostAdmin',
      isHost: true,
      targetName: 'Bob',
      fromSeq: 12,
      toSeq: 35,
      recordCount: 23,
      exportedAt: fixedDate
    })
    expect(hostToScoutFileName).toMatch(/^CNCMPLB_HOST_to_Bob_v12_to_v35_20260906_/)
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
      records: [dummyRecord1],
      fromHostSeq: 0,
      toHostSeq: 0
    })

    const parsed = parseSyncPackage(jsonStr)
    expect(parsed.format).toBe('SCOUTING_PRO_27_SYNC')
    expect(parsed.packetType).toBe('CLIENT_PUSH')
    expect(parsed.syncRange.recordCount).toBe(1)
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

  it('executes batch import for Host (merges, stamps hostSeq, persists to DB, handles events)', async () => {
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
    let stampedCalled = false
    let dbPersistedCalled = false

    const importRes = await executeBatchSyncImport({
      scanResult: scanRes,
      targetEventId: dummyEvent.id,
      isHost: true,
      events: eventsList,
      bulkSync: async (recs) => {
        syncedRecords.push(...recs)
        return recs
      },
      stampHostSeq: (recs) => {
        stampedCalled = true
        recs.forEach((r, idx) => { r.hostSeq = idx + 1 })
      },
      persistRecordsToDb: async (recs) => {
        dbPersistedCalled = true
      }
    })

    expect(importRes.totalFiles).toBe(2)
    expect(importRes.totalAccepted).toBe(1)
    expect(importRes.totalDropped).toBe(0)
    expect(importRes.importedEventId).toBe(dummyEvent.id)
    expect(eventsList).toHaveLength(1)
    expect(syncedRecords).toHaveLength(1)
    expect(stampedCalled).toBe(true)
    expect(dbPersistedCalled).toBe(true)
  })

  it('executes batch import for Client (marks confirmed records as SYNCED, applies tags)', async () => {
    const hostRecord: ScoutingRecord = {
      ...dummyRecord2,
      hostSeq: 10
    }
    const hostSyncJson = createSyncPackage({
      packetType: 'HOST_BROADCAST',
      eventId: dummyEvent.id,
      eventName: dummyEvent.name,
      sender: { userId: 'usr_host', username: 'HostAdmin', role: 'HOST' },
      target: { recipientType: 'ALL_SCOUTS' },
      records: [hostRecord],
      teamTags: [{ teamNumber: 27570, tags: ['AutoHigh'], lastUpdated: new Date().toISOString() }],
      fromHostSeq: 0,
      toHostSeq: 10
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
})


