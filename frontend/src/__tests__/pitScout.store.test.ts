import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { usePitScoutStore } from '../stores/pitScout'
import { useScheduleStore } from '../stores/schedule'
import { useRecordStore } from '../stores/records'
import type { PitScoutingRecord, MatchScheduleItem, ScoutingRecord } from '../types'

vi.mock('../services/api', () => ({
  fetchPitRecords: vi.fn().mockResolvedValue({ records: [], officialTeams: [] }),
  savePitRecord: vi.fn().mockResolvedValue({ success: true }),
  syncPitRecordsBatch: vi.fn().mockResolvedValue({ success: true, count: 0 }),
  syncOfficialTeams: vi.fn().mockResolvedValue({ success: true, count: 0 }),
  fetchFtcTeams: vi.fn().mockResolvedValue([]),
  isStaticCloudHost: vi.fn(() => false)
}))

const createMockPitRecord = (overrides: Partial<PitScoutingRecord> = {}): PitScoutingRecord => ({
  id: 'p1',
  eventId: 'e1',
  teamNumber: 27570,
  scoutId: 's1',
  scoutName: 'Alice',
  drivetrainType: 'mecanum',
  weightLbs: 38,
  ballCompatibility: 'universal',
  launcherType: '差速双飞轮',
  flowerMechanism: '垂直级联高抬升',
  hasColorSensor: true,
  odometryType: 'two_wheel',
  claimedAutoStrategy: '',
  claimedAutoScore: 60,
  claimedTeleopCycles: 6,
  claimedTeleopScore: 80,
  claimedEndgameScore: 15,
  claimedTotalScore: 155,
  version: 1,
  ...overrides
})

describe('PitScout Store & Unified Team Roster', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('aggregates and deduplicates teams from official roster, schedule, records, and pit records', () => {
    const pitStore = usePitScoutStore()
    const scheduleStore = useScheduleStore()
    const recordStore = useRecordStore()

    // 1. Official roster has team 27570
    pitStore.officialTeams = [
      { teamNumber: 27570, nameFull: 'B.E.A.R. 27570', robotName: 'Polaris' }
    ]

    // 2. Schedule has match with 27570 and 25787
    scheduleStore.schedules = [
      {
        id: 's1',
        eventId: 'e1',
        matchNumber: 1,
        tournamentLevel: 'QUALIFICATION',
        red1: 27570,
        red2: 0,
        blue1: 25787,
        blue2: 0
      } as MatchScheduleItem
    ]

    // 3. Match record has team 33333
    recordStore.records = [
      {
        id: 'r1',
        eventId: 'e1',
        scoutId: 'sc1',
        matchNumber: 1,
        teamNumber: 33333,
        autoScore: 30,
        teleopScore: 50,
        endgameScore: 20,
        totalScore: 100,
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: ''
      } as ScoutingRecord
    ]

    // 4. Pit record has team 27570
    pitStore.records = [
      createMockPitRecord({
        id: 'p1',
        eventId: 'e1',
        teamNumber: 27570,
        scoutId: 'sc1',
        scoutName: 'Scout 1',
        drivetrainType: 'mecanum',
        claimedAutoScore: 80,
        claimedTeleopScore: 100,
        claimedTotalScore: 180,
        version: 1
      })
    ]

    const list = pitStore.unifiedTeamList
    // Unique teams should be: 25787 (schedule), 27570 (official+pit), 33333 (match scout)
    // Teams appearing in match records without pit record are auto-added as blank unscouted teams (total 3)
    expect(list).toHaveLength(3)

    const team27570 = list.find((t) => t.teamNumber === 27570)
    expect(team27570).toBeDefined()
    expect(team27570?.name).toBe('B.E.A.R. 27570')
    expect(team27570?.hasPitRecord).toBe(true)
    expect(team27570?.pitRecord?.drivetrainType).toBe('mecanum')

    const team25787 = list.find((t) => t.teamNumber === 25787)
    expect(team25787).toBeDefined()
    expect(team25787?.hasPitRecord).toBe(false)

    // Team 33333 is auto-added from match scouting as blank unscouted team (+1 to total, hasPitRecord: false)
    const team33333 = list.find((t) => t.teamNumber === 33333)
    expect(team33333).toBeDefined()
    expect(team33333?.hasPitRecord).toBe(false)
    expect(team33333?.matchCount).toBe(1)
  })

  it('keeps stats invariant regardless of UI search and filter criteria', () => {
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'e1'
    pitStore.officialTeams = [
      { teamNumber: 1001, nameFull: 'Team 1001' },
      { teamNumber: 1002, nameFull: 'Team 1002' }
    ]
    pitStore.records = [
      createMockPitRecord({
        id: 'p_1001',
        eventId: 'e1',
        teamNumber: 1001,
        drivetrainType: 'mecanum'
      })
    ]

    // Base stats: total = 2, recorded = 1, percentage = 50
    expect(pitStore.stats.total).toBe(2)
    expect(pitStore.stats.recorded).toBe(1)
    expect(pitStore.stats.percentage).toBe(50)

    // Filter by searchQuery to '1001'
    pitStore.searchQuery = '1001'
    expect(pitStore.unifiedTeamList).toHaveLength(1)
    // stats must remain based on allRosterTeams!
    expect(pitStore.stats.total).toBe(2)
    expect(pitStore.stats.recorded).toBe(1)
    expect(pitStore.stats.percentage).toBe(50)

    // Filter by record status 'unrecorded'
    pitStore.searchQuery = ''
    pitStore.filterRecordStatus = 'unrecorded'
    expect(pitStore.unifiedTeamList).toHaveLength(1)
    expect(pitStore.unifiedTeamList[0].teamNumber).toBe(1002)
    // stats must still remain 2 total, 1 recorded (50%)
    expect(pitStore.stats.total).toBe(2)
    expect(pitStore.stats.recorded).toBe(1)
    expect(pitStore.stats.percentage).toBe(50)
  })

  it('strictly isolates unifiedTeamList to currentEventId', () => {
    const pitStore = usePitScoutStore()
    const recordStore = useRecordStore()

    pitStore.currentEventId = 'event-current'

    // Add teams/records for another event
    pitStore.records = [
      { id: 'p-other', eventId: 'event-other', teamNumber: 99999, version: 1 } as PitScoutingRecord,
      { id: 'p-curr', eventId: 'event-current', teamNumber: 11111, version: 1 } as PitScoutingRecord
    ]
    recordStore.records = [
      { id: 'r-other', eventId: 'event-other', teamNumber: 88888, version: 1, isDeleted: false } as any,
      { id: 'r-curr', eventId: 'event-current', teamNumber: 11111, version: 1, isDeleted: false } as any
    ]
    recordStore.teamTags = [
      { id: 't-other', eventId: 'event-other', teamNumber: 77777, tag: 'foreign', color: 'red', isPreset: false }
    ]

    const list = pitStore.unifiedTeamList
    // Only team 11111 from event-current should appear
    expect(list.map(t => t.teamNumber)).toEqual([11111])
  })

  it('updates records and applies LWW correctly', () => {
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'e1'

    const rec1 = createMockPitRecord({
      id: 'p1',
      eventId: 'e1',
      teamNumber: 27570,
      scoutId: 's1',
      scoutName: 'Alice',
      drivetrainType: 'mecanum',
      claimedAutoScore: 50,
      claimedTeleopScore: 70,
      claimedEndgameScore: 10,
      claimedTotalScore: 130,
      version: 1
    })

    pitStore.applyRemoteUpdate(rec1)
    expect(pitStore.records).toHaveLength(1)
    expect(pitStore.records[0].claimedAutoScore).toBe(50)

    // Older remote update (version 0) should be ignored
    const older: PitScoutingRecord = { ...rec1, claimedAutoScore: 30, version: 0 }
    pitStore.applyRemoteUpdate(older)
    expect(pitStore.records[0].claimedAutoScore).toBe(50)

    // Newer remote update (version 2) should overwrite
    const newer: PitScoutingRecord = { ...rec1, claimedAutoScore: 85, version: 2 }
    pitStore.applyRemoteUpdate(newer)
    expect(pitStore.records[0].claimedAutoScore).toBe(85)
    expect(pitStore.records[0].version).toBe(2)
  })

  it('filters by status and drivetrain', () => {
    const pitStore = usePitScoutStore()
    pitStore.officialTeams = [
      { teamNumber: 1, nameFull: 'Team 1' },
      { teamNumber: 2, nameFull: 'Team 2' }
    ]
    pitStore.records = [
      createMockPitRecord({
        id: 'p1',
        eventId: 'e1',
        teamNumber: 1,
        scoutId: 's1',
        scoutName: 'Alice',
        drivetrainType: 'mecanum',
        claimedAutoScore: 50,
        claimedTeleopScore: 70,
        claimedEndgameScore: 10,
        claimedTotalScore: 130,
        version: 1
      })
    ]

    // Total: 2 teams (Team 1 has pit record, Team 2 does not)
    expect(pitStore.unifiedTeamList).toHaveLength(2)

    // Filter by recorded
    pitStore.filterRecordStatus = 'recorded'
    expect(pitStore.unifiedTeamList).toHaveLength(1)
    expect(pitStore.unifiedTeamList[0].teamNumber).toBe(1)

    // Filter by unrecorded
    pitStore.filterRecordStatus = 'unrecorded'
    expect(pitStore.unifiedTeamList).toHaveLength(1)
    expect(pitStore.unifiedTeamList[0].teamNumber).toBe(2)

    // Reset filter
    pitStore.filterRecordStatus = 'all'
    pitStore.filterDrivetrain = 'mecanum'
    expect(pitStore.unifiedTeamList).toHaveLength(1)
    expect(pitStore.unifiedTeamList[0].teamNumber).toBe(1)
  })

  it('marks syncStatus as SYNCED on successful save and PENDING on network error', async () => {
    const { savePitRecord } = await import('../services/api')
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'test-event-1'

    const rec = createMockPitRecord({
      id: 'p-online',
      eventId: 'test-event-1',
      teamNumber: 100,
      scoutId: 's1',
      scoutName: 'Alice',
      drivetrainType: 'mecanum',
      claimedAutoScore: 0,
      claimedTeleopScore: 0,
      claimedEndgameScore: 0,
      claimedTotalScore: 0,
      version: 0
    })

    // 1. Success case
    await pitStore.saveRecord({ ...rec })
    expect(pitStore.records[0].syncStatus).toBe('SYNCED')
    expect(pitStore.pendingPitRecords).toHaveLength(0)

    // 2. Offline / API error case
    vi.mocked(savePitRecord).mockRejectedValueOnce(new Error('Network offline'))
    const offlineRec: PitScoutingRecord = {
      ...rec,
      id: 'p-offline',
      teamNumber: 200
    }
    await pitStore.saveRecord(offlineRec)
    const rec200 = pitStore.records.find((r) => r.teamNumber === 200)
    expect(rec200).toBeDefined()
    expect(rec200?.syncStatus).toBe('PENDING')
    expect(pitStore.pendingPitRecords).toHaveLength(1)
    expect(pitStore.pendingPitRecords[0].teamNumber).toBe(200)
  })

  it('flushPendingPitRecords flushes pending items via batch API and marks them SYNCED', async () => {
    const { syncPitRecordsBatch } = await import('../services/api')
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'test-event-1'

    pitStore.records = [
      createMockPitRecord({
        id: 'p-pending-1',
        eventId: 'test-event-1',
        teamNumber: 300,
        scoutId: 's1',
        scoutName: 'Alice',
        drivetrainType: 'tank',
        version: 1,
        syncStatus: 'PENDING'
      })
    ]

    expect(pitStore.pendingPitRecords).toHaveLength(1)

    await pitStore.flushPendingPitRecords('test-event-1')

    expect(syncPitRecordsBatch).toHaveBeenCalledWith('test-event-1', expect.arrayContaining([
      expect.objectContaining({ teamNumber: 300 })
    ]))
    expect(pitStore.records[0].syncStatus).toBe('SYNCED')
    expect(pitStore.pendingPitRecords).toHaveLength(0)
  })

  it('applyFullSync preserves local PENDING record unless remote version is strictly higher, and merges photoKeys', () => {
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'test-event-1'

    // Local has pending changes for team 400 at version 2, with photo 'photo-local'
    pitStore.records = [
      createMockPitRecord({
        id: 'p-local',
        eventId: 'test-event-1',
        teamNumber: 400,
        scoutId: 's1',
        scoutName: 'Alice',
        drivetrainType: 'swerve',
        claimedAutoScore: 100,
        claimedTotalScore: 100,
        version: 2,
        photoKeys: ['photo-local'],
        syncStatus: 'PENDING'
      })
    ]

    // Incoming from Host is older (version 1) with photo 'photo-host'
    const incomingOlder: PitScoutingRecord[] = [
      createMockPitRecord({
        id: 'p-remote-old',
        eventId: 'test-event-1',
        teamNumber: 400,
        scoutId: 's2',
        scoutName: 'Bob',
        drivetrainType: 'mecanum',
        claimedAutoScore: 50,
        claimedTotalScore: 50,
        version: 1,
        photoKeys: ['photo-host'],
        syncStatus: 'SYNCED'
      })
    ]

    pitStore.applyFullSync(incomingOlder)

    // Local pending version 2 and swerve must NOT be overwritten!
    const rec400 = pitStore.records.find((r) => r.teamNumber === 400)
    expect(rec400?.version).toBe(2)
    expect(rec400?.drivetrainType).toBe('swerve')
    expect(rec400?.syncStatus).toBe('PENDING')
    // Photos should be merged
    expect(rec400?.photoKeys).toContain('photo-local')
    expect(rec400?.photoKeys).toContain('photo-host')

    // Now Host provides version 3 (strictly newer)
    const incomingNewer: PitScoutingRecord[] = [
      createMockPitRecord({
        id: 'p-remote-newer',
        eventId: 'test-event-1',
        teamNumber: 400,
        scoutId: 's2',
        scoutName: 'Bob',
        drivetrainType: 'tank',
        claimedAutoScore: 120,
        claimedTotalScore: 120,
        version: 3,
        photoKeys: ['photo-host-v3'],
        syncStatus: 'SYNCED'
      })
    ]

    pitStore.applyFullSync(incomingNewer)

    // Strictly newer remote is accepted, but local photos are preserved!
    const updated400 = pitStore.records.find((r) => r.teamNumber === 400)
    expect(updated400?.version).toBe(3)
    expect(updated400?.drivetrainType).toBe('tank')
    expect(updated400?.syncStatus).toBe('SYNCED')
    expect(updated400?.photoKeys).toContain('photo-local')
    expect(updated400?.photoKeys).toContain('photo-host-v3')
  })

  it('fetchPitData preserves local PENDING records and merges photoKeys', async () => {
    const { fetchPitRecords } = await import('../services/api')
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'test-event-1'

    pitStore.records = [
      createMockPitRecord({
        id: 'p-local-pending',
        eventId: 'test-event-1',
        teamNumber: 500,
        scoutId: 's1',
        scoutName: 'Alice',
        drivetrainType: 'swerve',
        claimedAutoScore: 90,
        claimedTeleopScore: 100,
        claimedTotalScore: 190,
        version: 2,
        photoKeys: ['photo-local-offline'],
        syncStatus: 'PENDING'
      })
    ]

    vi.mocked(fetchPitRecords).mockResolvedValueOnce({
      records: [
        createMockPitRecord({
          id: 'p-remote-server',
          eventId: 'test-event-1',
          teamNumber: 500,
          scoutId: 's2',
          scoutName: 'Bob',
          drivetrainType: 'mecanum',
          claimedAutoScore: 40,
          claimedTeleopScore: 50,
          claimedTotalScore: 90,
          version: 1,
          photoKeys: ['photo-remote-server'],
          syncStatus: 'SYNCED'
        })
      ],
      officialTeams: []
    })

    await pitStore.fetchPitData('test-event-1')

    const rec500 = pitStore.records.find((r) => r.teamNumber === 500)
    expect(rec500).toBeDefined()
    expect(rec500?.drivetrainType).toBe('swerve')
    expect(rec500?.syncStatus).toBe('PENDING')
    expect(rec500?.photoKeys).toContain('photo-local-offline')
    expect(rec500?.photoKeys).toContain('photo-remote-server')
  })

  it('applyRemoteUpdate rejects stale versions and does not persist to database', async () => {
    const { savePitRecord } = await import('../services/api')
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'test-event-1'

    pitStore.records = [
      createMockPitRecord({
        id: 'p-local-current',
        eventId: 'test-event-1',
        teamNumber: 600,
        scoutId: 's1',
        scoutName: 'Alice',
        drivetrainType: 'swerve',
        claimedAutoScore: 80,
        claimedTeleopScore: 80,
        claimedTotalScore: 160,
        version: 5,
        syncStatus: 'SYNCED'
      })
    ]

    vi.mocked(savePitRecord).mockClear()

    // Incoming stale update (version 3 < local version 5)
    const staleUpdate: PitScoutingRecord = createMockPitRecord({
      id: 'p-stale',
      eventId: 'test-event-1',
      teamNumber: 600,
      scoutId: 's3',
      scoutName: 'Charlie',
      drivetrainType: 'tank',
      claimedAutoScore: 10,
      claimedTeleopScore: 10,
      claimedTotalScore: 20,
      version: 3,
      syncStatus: 'SYNCED'
    })

    pitStore.applyRemoteUpdate(staleUpdate)

    // Local record must not be modified
    const rec600 = pitStore.records.find((r) => r.teamNumber === 600)
    expect(rec600?.version).toBe(5)
    expect(rec600?.drivetrainType).toBe('swerve')
    expect(rec600?.claimedTotalScore).toBe(160)
    // savePitRecord should NOT have been called
    expect(savePitRecord).not.toHaveBeenCalled()
  })

  it('migrateScoutId migrates scoutId and scoutName on local pit records, increments version, and marks PENDING', () => {
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'test-event-1'

    pitStore.records = [
      createMockPitRecord({
        id: 'p1',
        eventId: 'test-event-1',
        teamNumber: 100,
        scoutId: 'old_uuid_1',
        scoutName: 'OldScout',
        drivetrainType: 'mecanum',
        claimedAutoScore: 50,
        claimedTeleopScore: 50,
        claimedTotalScore: 100,
        version: 1,
        syncStatus: 'SYNCED'
      }),
      createMockPitRecord({
        id: 'p2',
        eventId: 'test-event-1',
        teamNumber: 200,
        scoutId: 'other_scout',
        scoutName: 'OtherScout',
        drivetrainType: 'tank',
        claimedAutoScore: 30,
        claimedTeleopScore: 40,
        claimedTotalScore: 70,
        version: 1,
        syncStatus: 'SYNCED'
      })
    ]

    pitStore.migrateScoutId('old_uuid_1', 'master_uuid_2', 'MasterScout')

    const rec1 = pitStore.records.find(r => r.teamNumber === 100)
    expect(rec1?.scoutId).toBe('master_uuid_2')
    expect(rec1?.scoutName).toBe('MasterScout')
    expect(rec1?.version).toBe(2)
    expect(rec1?.syncStatus).toBe('PENDING')

    const rec2 = pitStore.records.find(r => r.teamNumber === 200)
    expect(rec2?.scoutId).toBe('other_scout')
    expect(rec2?.scoutName).toBe('OtherScout')
    expect(rec2?.version).toBe(1)
  })
})

