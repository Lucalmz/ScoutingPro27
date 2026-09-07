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
  fetchFtcTeams: vi.fn().mockResolvedValue([])
}))

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
      {
        id: 'p1',
        eventId: 'e1',
        teamNumber: 27570,
        scoutId: 'sc1',
        scoutName: 'Scout 1',
        drivetrainType: 'mecanum',
        weightLbs: 38,
        sizingPassed: true,
        mechanismType: 'slide_claw',
        hangType: 'winch',
        odometryType: 'two_wheel',
        claimedAutoScore: 80,
        claimedAutoPieces: 3,
        claimedAutoHangLevel: 1,
        claimedTeleopScore: 100,
        claimedTeleopCycleSec: 8.0,
        claimedEndgameHangLevel: 2,
        claimedEndgameTimeSec: 4.0,
        claimedTotalScore: 180,
        version: 1
      } as PitScoutingRecord
    ]

    const list = pitStore.unifiedTeamList
    // Unique teams should be: 25787, 27570, 33333 (total 3)
    expect(list).toHaveLength(3)

    const team27570 = list.find((t) => t.teamNumber === 27570)
    expect(team27570).toBeDefined()
    expect(team27570?.name).toBe('B.E.A.R. 27570')
    expect(team27570?.hasPitRecord).toBe(true)
    expect(team27570?.pitRecord?.drivetrainType).toBe('mecanum')

    const team25787 = list.find((t) => t.teamNumber === 25787)
    expect(team25787).toBeDefined()
    expect(team25787?.hasPitRecord).toBe(false)

    const team33333 = list.find((t) => t.teamNumber === 33333)
    expect(team33333).toBeDefined()
    expect(team33333?.hasPitRecord).toBe(false)
    expect(team33333?.matchCount).toBe(1)
  })

  it('updates records and applies LWW correctly', () => {
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'e1'

    const rec1: PitScoutingRecord = {
      id: 'p1',
      eventId: 'e1',
      teamNumber: 27570,
      scoutId: 's1',
      scoutName: 'Alice',
      drivetrainType: 'mecanum',
      weightLbs: 35,
      sizingPassed: true,
      mechanismType: 'slide_claw',
      hangType: 'winch',
      odometryType: 'none',
      claimedAutoScore: 50,
      claimedAutoPieces: 2,
      claimedAutoHangLevel: 0,
      claimedTeleopScore: 70,
      claimedTeleopCycleSec: 10,
      claimedEndgameHangLevel: 1,
      claimedEndgameTimeSec: 5,
      claimedTotalScore: 120,
      version: 1
    }

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
      {
        id: 'p1',
        eventId: 'e1',
        teamNumber: 1,
        scoutId: 's1',
        scoutName: 'Alice',
        drivetrainType: 'mecanum',
        weightLbs: 35,
        sizingPassed: true,
        mechanismType: '',
        hangType: '',
        odometryType: '',
        claimedAutoScore: 50,
        claimedAutoPieces: 2,
        claimedAutoHangLevel: 0,
        claimedTeleopScore: 70,
        claimedTeleopCycleSec: 10,
        claimedEndgameHangLevel: 1,
        claimedEndgameTimeSec: 5,
        claimedTotalScore: 120,
        version: 1
      } as PitScoutingRecord
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
})
