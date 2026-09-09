import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUserStore } from '../stores/user'
import { useEventStore } from '../stores/events'
import { usePitScoutStore } from '../stores/pitScout'
import { useScheduleStore } from '../stores/schedule'
import { useRecordStore } from '../stores/records'
import { calculateBragIndex } from '../utils/bragIndex'
import * as api from '../services/api'
import type { ScoutingRecord, PitScoutingRecord } from '../types'

vi.mock('../services/api', () => ({
  createEvent: vi.fn(),
  joinEvent: vi.fn(),
  saveRecord: vi.fn().mockResolvedValue(undefined),
  saveScheduleBatch: vi.fn().mockResolvedValue({ success: true, count: 1 }),
  saveScoutAssignments: vi.fn().mockResolvedValue({ success: true, count: 1 }),
  savePitRecord: vi.fn().mockImplementation((_e, rec) => Promise.resolve({ success: true, record: rec })),
  fetchPitRecords: vi.fn().mockResolvedValue({ records: [], officialTeams: [] }),
  fetchEventSchedule: vi.fn().mockResolvedValue({ schedules: [], assignments: [] }),
  listRecords: vi.fn().mockResolvedValue([])
}))

describe('End-to-End Scouting Workflow Integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('completes the entire scouting lifecycle: login -> event -> pit scout -> schedule assignment -> match scout -> brag index analysis', async () => {
    // 1. User authentication
    const userStore = useUserStore()
    userStore.user = { id: 'scout_alice_id', username: 'Alice', token: 'mock_jwt_token' }
    expect(userStore.isLoggedIn).toBe(true)
    expect(userStore.userId).toBe('scout_alice_id')

    // 2. Create and initialize event
    const eventStore = useEventStore()
    vi.mocked(api.createEvent).mockResolvedValue({
      id: 'evt_ftc_championship',
      inviteCode: 'CHAMP1',
      name: 'FTC World Championship'
    })
    const event = await eventStore.create('FTC World Championship')
    expect(event?.id).toBe('evt_ftc_championship')

    const eventId = event!.id
    const recordStore = useRecordStore()
    const pitStore = usePitScoutStore()
    const scheduleStore = useScheduleStore()

    recordStore.currentEventId = eventId
    pitStore.currentEventId = eventId
    scheduleStore.currentEventId = eventId

    // 3. Scout performs Pit Scouting for Team 27570
    const pitRecord: PitScoutingRecord = {
      id: 'pit_27570_001',
      eventId,
      teamNumber: 27570,
      scoutId: userStore.userId,
      scoutName: userStore.username,
      robotName: 'Titanium Bear',
      drivetrainType: 'swerve',
      weightLbs: 41.2,
      sizingPassed: true,
      mechanismType: 'linkage_arm',
      hangType: 'telescoping',
      odometryType: 'sparkfun_otos',
      claimedAutoScore: 60,
      claimedAutoPieces: 3,
      claimedAutoHangLevel: 1,
      claimedTeleopScore: 90,
      claimedTeleopCycleSec: 10.5,
      claimedEndgameHangLevel: 3, // Claims Level 3 high hang
      claimedEndgameTimeSec: 6.0,
      claimedTotalScore: 180, // Total claimed: 60 + 90 + 30 = 180
      photoKeys: ['photo_titanium_front'],
      version: 1,
      hostSeq: 1,
      isDeleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    await pitStore.saveRecord(pitRecord)
    expect(pitStore.records).toHaveLength(1)
    const storedPit = pitStore.getUnifiedTeam(27570)?.pitRecord
    expect(storedPit?.claimedTotalScore).toBe(180)

    // Initially, before any match is played, brag index is 'pending'
    const initialBrag = calculateBragIndex(storedPit, [])
    expect(initialBrag?.tier).toBe('pending')
    expect(initialBrag?.label).toContain('待实测')

    // 4. Host sets up schedule and assigns Alice to Match 1 Red1 (Team 27570)
    await scheduleStore.importSchedules(
      eventId,
      [
        {
          id: `${eventId}_QUALIFICATION_1`,
          eventId,
          matchNumber: 1,
          tournamentLevel: 'QUALIFICATION',
          red1: 27570,
          red2: 11111,
          blue1: 22222,
          blue2: 33333
        }
      ],
      true,
      false
    )

    await scheduleStore.assignStation(
      eventId,
      1,
      'red1',
      userStore.userId,
      userStore.username,
      false,
      'QUALIFICATION'
    )

    // Alice checks her assignments
    const aliceTasks = scheduleStore.myAssignments(userStore.userId)
    expect(aliceTasks).toHaveLength(1)
    expect(aliceTasks[0].matchNumber).toBe(1)
    expect(aliceTasks[0].station).toBe('red1')
    expect(aliceTasks[0].teamNumber).toBe(27570)
    expect(aliceTasks[0].schedule?.red2).toBe(11111)

    // 5. Alice scouts Match 1 on the field: Team 27570 scores 100 (Auto: 35, Teleop: 50, Endgame: 15)
    const match1Record: ScoutingRecord = {
      id: 'rec_match1_27570',
      eventId,
      scoutId: userStore.userId,
      scoutName: userStore.username,
      matchNumber: 1,
      teamNumber: 27570,
      autoScore: 35,
      teleopScore: 50,
      endgameScore: 15, // Only Level 2 hang achieved, not Level 3
      totalScore: 100,
      notes: 'Good intake, missed high hang, settled for low hang.',
      rawData: JSON.stringify({ allianceColor: 'red' }),
      syncStatus: 'PENDING',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    const { success } = await recordStore.addRecord(match1Record)
    expect(success).toBe(true)
    expect(recordStore.activeRecords).toHaveLength(1)
    expect(recordStore.rankings).toHaveLength(1)
    expect(recordStore.rankings[0].teamNumber).toBe(27570)
    expect(recordStore.rankings[0].maxScore).toBe(100)
    expect(recordStore.rankings[0].avgAutoScore).toBe(35)

    // 6. Cross-reference Pit Claim vs Actual Performance via Brag Index
    const claimedRecord = pitStore.getUnifiedTeam(27570)?.pitRecord
    const teamMatches = recordStore.activeRecords.filter((r) => r.teamNumber === 27570)
    const bragInfo = calculateBragIndex(claimedRecord, teamMatches)

    expect(bragInfo).toBeDefined()
    // baseline = max(100, 100 * 1.05) = 105. 180 / 105 = 1.71x
    expect(bragInfo?.overallRatio).toBeGreaterThan(1.5)
    expect(bragInfo?.overallRatio).toBeLessThan(2.0)
    expect(bragInfo?.tier).toBe('overclaimed')
    expect(bragInfo?.label).toContain('夸大其词')

    // 7. Second match: Team 27570 achieves 125 points with Level 3 hang (28 pts)
    const match2Record: ScoutingRecord = {
      id: 'rec_match2_27570',
      eventId,
      scoutId: userStore.userId,
      scoutName: userStore.username,
      matchNumber: 2,
      teamNumber: 27570,
      autoScore: 45,
      teleopScore: 52,
      endgameScore: 28, // Level 3 verified!
      totalScore: 125,
      notes: 'Flawless match, high hang verified.',
      rawData: JSON.stringify({ allianceColor: 'blue' }),
      syncStatus: 'PENDING',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    await recordStore.addRecord(match2Record)
    expect(recordStore.activeRecords).toHaveLength(2)

    // Updated rankings
    const updatedRanking = recordStore.rankings.find((r) => r.teamNumber === 27570)
    expect(updatedRanking?.maxScore).toBe(125)
    expect(updatedRanking?.avgAutoScore).toBe(40) // (35 + 45) / 2

    // Updated brag index
    const updatedMatches = recordStore.activeRecords.filter((r) => r.teamNumber === 27570)
    const updatedBrag = calculateBragIndex(claimedRecord, updatedMatches)

    expect(updatedBrag).toBeDefined()
    // Max endgame score is now 28, confirming the claimed Level 3 high hang!
    expect(updatedBrag?.label).toContain('高杠已证实')
  })
})
