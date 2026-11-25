import { describe, it, expect } from 'vitest'
import { buildEventDataContext } from '@/components/ai/contextBuilder'
import type { ScoutingRecord, RankingRow, ScoutingEvent, PitScoutingRecord } from '@/types'

describe('buildEventDataContext', () => {
  it('returns empty notice when there are no records and no rankings', () => {
    const res = buildEventDataContext({
      event: null,
      rankings: [],
      records: [],
      bannedTeams: []
    })
    expect(res).toContain('No scouting records or match data have been recorded yet')
  })

  it('formats rankings and active match records into structured markdown tables', () => {
    const mockEvent: ScoutingEvent = {
      id: 'evt_1',
      name: 'FTC China Championship',
      inviteCode: 'INV123',
      hostId: 'host_1',
      ftcYear: 2026,
      ftcEventCode: 'CNCMP'
    }

    const mockRankings: RankingRow[] = [
      {
        teamNumber: 27570,
        matchCount: 3,
        avgAutoScore: 60.5,
        avgTeleopScore: 85.0,
        avgEndgameScore: 30.0,
        maxScore: 180,
        avgRating: 175.5,
        brokenCount: 0,
        trend: 'up'
      },
      {
        teamNumber: 19600,
        matchCount: 2,
        avgAutoScore: 40.0,
        avgTeleopScore: 70.0,
        avgEndgameScore: 20.0,
        maxScore: 135,
        avgRating: 130.0,
        brokenCount: 1,
        trend: 'stable'
      }
    ]

    const mockRecords: ScoutingRecord[] = [
      {
        id: 'rec_1',
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Alice',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 60,
        teleopScore: 80,
        endgameScore: 30,
        totalScore: 170,
        notes: 'Fast intake, excellent auto cycle',
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '2026-08-20T10:00:00Z',
        updatedAt: '2026-08-20T10:00:00Z',
        isBroken: false,
        version: 1
      },
      {
        id: 'rec_2',
        eventId: 'evt_1',
        scoutId: 'scout_2',
        scoutName: 'Bob',
        matchNumber: 2,
        teamNumber: 19600,
        autoScore: 30,
        teleopScore: 50,
        endgameScore: 10,
        totalScore: 90,
        notes: 'Chain disconnected in teleop',
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '2026-08-20T10:30:00Z',
        updatedAt: '2026-08-20T10:30:00Z',
        isBroken: true,
        version: 1
      },
      {
        id: 'rec_deleted',
        eventId: 'evt_1',
        scoutId: 'scout_1',
        scoutName: 'Alice',
        matchNumber: 3,
        teamNumber: 99999,
        autoScore: 0,
        teleopScore: 0,
        endgameScore: 0,
        totalScore: 0,
        notes: 'Mistakenly entered',
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '2026-08-20T11:00:00Z',
        updatedAt: '2026-08-20T11:00:00Z',
        isBroken: false,
        isDeleted: true,
        version: 2
      }
    ]

    const result = buildEventDataContext({
      event: mockEvent,
      rankings: mockRankings,
      records: mockRecords,
      bannedTeams: [19600]
    })

    expect(result).toContain('=== CURRENT FTC EVENT SCOUTING DATA ===')
    expect(result).toContain('Event Name: FTC China Championship')
    expect(result).toContain('Event Code: CNCMP (Year: 2026)')
    expect(result).toContain('Total Active Records: 2 | Total Tracked Teams: 2')
    expect(result).toContain('Banned / Marked Weak Teams: 19600')
    expect(result).toContain('27570 | 3 | 60.5 | 85 | 30 | 175.5 | 180 | 0 | up')
    expect(result).toContain('Match 1 | Team 27570 | Alice | 170 | 60 | 80 | 30 | NO | Fast intake, excellent auto cycle')
    expect(result).toContain('Match 2 | Team 19600 | Bob | 90 | 30 | 50 | 10 | YES (Broken) | Chain disconnected in teleop')
    // Deleted records must be excluded
    expect(result).not.toContain('99999')
    expect(result).not.toContain('Mistakenly entered')
    expect(result).toContain('=== END OF EVENT DATA ===')
  })

  it('includes tactical observation tags grouped by team (V11, V18, V20)', () => {
    const result = buildEventDataContext({
      event: null,
      rankings: [{ teamNumber: 27570, matchCount: 1, avgAutoScore: 10, avgTeleopScore: 10, avgEndgameScore: 10, maxScore: 30, avgRating: 30, brokenCount: 0, trend: 'stable' }],
      records: [],
      tags: [
        { id: '1', eventId: 'e1', teamNumber: 27570, tag: 'dual_motor_hang', color: 'green', isPreset: false },
        { id: '2', eventId: 'e1', teamNumber: 27570, tag: 'aluminum_lift', color: 'blue', isPreset: false },
        { id: '3', eventId: 'e1', teamNumber: 19600, tag: 'defense_specialist', color: 'red', isPreset: false }
      ]
    })

    expect(result).toContain('[Scouter Tactical Observation Tags (Subjective Field Notes - Cross-Validate with Match Stats)]')
    expect(result).toContain('Team 19600: defense_specialist')
    expect(result).toContain('Team 27570: dual_motor_hang, aluminum_lift')
  })

  it('truncates tags safely at line boundary when exceeding 1500 chars (V19, V29)', () => {
    // Generate many teams to exceed 1500 chars
    const largeTagList = []
    for (let i = 1000; i < 1100; i++) {
      largeTagList.push({
        id: `t_${i}`,
        eventId: 'e1',
        teamNumber: i,
        tag: `super_long_custom_tactical_observation_tag_for_robot_subsystem_verification_${i}`,
        color: 'blue' as const,
        isPreset: false
      })
    }

    const result = buildEventDataContext({
      event: null,
      rankings: [],
      records: [],
      tags: largeTagList
    })

    expect(result).toContain('[Scouter Tactical Observation Tags')
    expect(result).toContain('[... Remaining team observation tags truncated for length limits ...]')
    // Must not be truncated in the middle of a line
    const tagSection = result.split('[Scouter Tactical Observation Tags')[1].split('=== END OF EVENT DATA ===')[0]
    expect(tagSection.length).toBeLessThan(1700)
  })

  it('includes pit scouting robot hardware profiles and brag audit', () => {
    const mockPitRecords: PitScoutingRecord[] = [
      {
        id: 'pit_1',
        eventId: 'evt_1',
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Alice',
        drivetrainType: 'swerve',
        weightLbs: 38.5,
        ballCompatibility: 'universal',
        launcherType: 'dual_flywheel',
        flowerMechanism: 'cascade_lift',
        hasColorSensor: true,
        odometryType: 'pinpoint_otos',
        claimedAutoStrategy: '3 balls',
        claimedAutoScore: 40,
        claimedTeleopCycles: 8,
        claimedTeleopScore: 80,
        claimedEndgameScore: 30,
        claimedTotalScore: 150,
        syncStatus: 'SYNCED',
        createdAt: '2026-08-20T10:00:00Z',
        updatedAt: '2026-08-20T10:00:00Z',
        version: 1
      },
      {
        id: 'pit_deleted',
        eventId: 'evt_1',
        teamNumber: 99999,
        scoutId: 's2',
        scoutName: 'Bob',
        drivetrainType: 'tank',
        weightLbs: 35,
        ballCompatibility: 'pollen_only',
        launcherType: '',
        flowerMechanism: '',
        hasColorSensor: false,
        odometryType: 'none',
        claimedAutoScore: 0,
        claimedTeleopCycles: 0,
        claimedTeleopScore: 0,
        claimedEndgameScore: 0,
        claimedTotalScore: 0,
        syncStatus: 'SYNCED',
        createdAt: '2026-08-20T10:00:00Z',
        updatedAt: '2026-08-20T10:00:00Z',
        isDeleted: true,
        version: 2
      }
    ]

    const mockMatchRecords: ScoutingRecord[] = [
      {
        id: 'rec_1',
        eventId: 'evt_1',
        scoutId: 's1',
        scoutName: 'Bob',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 35,
        teleopScore: 75,
        endgameScore: 30,
        totalScore: 140,
        notes: 'Great match',
        rawData: JSON.stringify({
          flowerNectars: 4,
          flowerBottomBonusCount: 2,
          flowerPollens: 4,
          gardenBalls: 4
        }),
        syncStatus: 'SYNCED',
        createdAt: '2026-08-20T10:00:00Z',
        updatedAt: '2026-08-20T10:00:00Z',
        isBroken: false,
        version: 1
      }
    ]

    const result = buildEventDataContext({
      event: null,
      rankings: [],
      records: mockMatchRecords,
      pitRecords: mockPitRecords
    })

    expect(result).toContain('Pit Profiles: 1')
    expect(result).toContain('[Pit Scouting & Robot Hardware Profiles (Self-Reported Specs & Brag Audit)]')
    expect(result).toContain('Team # | Drivetrain | Ball Compat | Launcher | Flower Mech | Sensor | Odom | Claimed Auto | Claimed TeleOp | Claimed Endgame | Claimed Total | Brag Index (Audit)')
    expect(result).toContain('27570 | swerve | universal | dual_flywheel | cascade_lift | Yes | pinpoint_otos | 40 pts (3 balls) | 80 pts (8 cycles) | 30 pts | 150 pts')
    expect(result).toContain('1.02x (realistic, Flower Verified)')
    // Deleted pit record must not appear
    expect(result).not.toContain('99999')
  })

  it('handles pit scouting profiles when no match records have been played yet', () => {
    const mockPitRecords: PitScoutingRecord[] = [
      {
        id: 'pit_1',
        eventId: 'evt_1',
        teamNumber: 19600,
        scoutId: 's3',
        scoutName: 'Charlie',
        drivetrainType: 'mecanum',
        weightLbs: 32,
        ballCompatibility: 'universal',
        launcherType: 'slide_roller',
        flowerMechanism: 'passive',
        hasColorSensor: false,
        odometryType: 'two_wheel',
        claimedAutoStrategy: '2 pcs',
        claimedAutoScore: 30,
        claimedTeleopCycles: 6,
        claimedTeleopScore: 60,
        claimedEndgameScore: 10,
        claimedTotalScore: 100,
        syncStatus: 'SYNCED',
        createdAt: '2026-08-20T10:00:00Z',
        updatedAt: '2026-08-20T10:00:00Z',
        version: 1
      }
    ]

    const result = buildEventDataContext({
      event: null,
      rankings: [],
      records: [],
      pitRecords: mockPitRecords
    })

    expect(result).toContain('Pit Profiles: 1')
    expect(result).toContain('19600 | mecanum | universal | slide_roller | passive | No | two_wheel | 30 pts (2 pcs) | 60 pts (6 cycles) | 10 pts | 100 pts | Pending (No Matches)')
  })

  it('sorts detailed match records chronologically and distinguishes playoff matches from qualification matches', () => {
    const records: ScoutingRecord[] = [
      {
        id: 'rec_p1',
        eventId: 'evt_1',
        scoutId: 's1',
        scoutName: 'Alice',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 70,
        teleopScore: 90,
        endgameScore: 30,
        totalScore: 190,
        notes: 'Playoff finals win',
        rawData: JSON.stringify({ tournamentLevel: 'PLAYOFF' }),
        syncStatus: 'SYNCED',
        createdAt: '2026-08-20T16:00:00Z',
        updatedAt: '2026-08-20T16:00:00Z',
        version: 1
      },
      {
        id: 'rec_q2',
        eventId: 'evt_1',
        scoutId: 's1',
        scoutName: 'Alice',
        matchNumber: 2,
        teamNumber: 27570,
        autoScore: 50,
        teleopScore: 70,
        endgameScore: 20,
        totalScore: 140,
        notes: 'Qual 2',
        rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION' }),
        syncStatus: 'SYNCED',
        createdAt: '2026-08-20T11:00:00Z',
        updatedAt: '2026-08-20T11:00:00Z',
        version: 1
      },
      {
        id: 'rec_q1',
        eventId: 'evt_1',
        scoutId: 's1',
        scoutName: 'Alice',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 40,
        teleopScore: 60,
        endgameScore: 20,
        totalScore: 120,
        notes: 'Qual 1',
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '2026-08-20T10:00:00Z',
        updatedAt: '2026-08-20T10:00:00Z',
        version: 1
      }
    ]

    const result = buildEventDataContext({
      event: null,
      rankings: [],
      records
    })

    const q1Idx = result.indexOf('Match 1 | Team 27570 | Alice | 120')
    const q2Idx = result.indexOf('Match 2 | Team 27570 | Alice | 140')
    const p1Idx = result.indexOf('Playoff Match 1 | Team 27570 | Alice | 190')

    expect(q1Idx).toBeGreaterThan(-1)
    expect(q2Idx).toBeGreaterThan(-1)
    expect(p1Idx).toBeGreaterThan(-1)
    // Chronological order: Qual 1 < Qual 2 < Playoff 1
    expect(q1Idx).toBeLessThan(q2Idx)
    expect(q2Idx).toBeLessThan(p1Idx)
  })

  it('formats BIOBUZZ pit scouting profiles with ball compatibility and cycle count', () => {
    const mockBiobuzzPit: PitScoutingRecord = {
      id: 'pit_bb_1',
      eventId: 'evt_1',
      teamNumber: 27570,
      scoutId: 's1',
      scoutName: 'Alice',
      drivetrainType: 'swerve',
      weightLbs: 38.5,
      ballCompatibility: 'universal',
      launcherType: 'dual_flywheel',
      flowerMechanism: 'cascade_lift',
      hasColorSensor: true,
      odometryType: 'pinpoint_otos',
      claimedAutoStrategy: 'preload + 2 garden + park',
      claimedAutoScore: 45,
      claimedTeleopCycles: 7,
      claimedTeleopScore: 70,
      claimedEndgameScore: 25,
      claimedTotalScore: 140,
      syncStatus: 'SYNCED',
      createdAt: '2026-08-20T10:00:00Z',
      updatedAt: '2026-08-20T10:00:00Z',
      version: 1
    }

    const mockMatchRecord: ScoutingRecord = {
      id: 'rec_bb_1',
      eventId: 'evt_1',
      scoutId: 's1',
      scoutName: 'Alice',
      matchNumber: 1,
      teamNumber: 27570,
      autoScore: 40,
      teleopScore: 70,
      endgameScore: 25,
      totalScore: 135,
      notes: 'Solid cycle performance',
      rawData: JSON.stringify({
        flowerNectars: 4,
        flowerBottomBonusCount: 3,
        gardenBalls: 2
      }),
      syncStatus: 'SYNCED',
      createdAt: '2026-08-20T10:00:00Z',
      updatedAt: '2026-08-20T10:00:00Z',
      isBroken: false,
      version: 1
    }

    const result = buildEventDataContext({
      event: null,
      rankings: [{ teamNumber: 27570, matchCount: 1, avgAutoScore: 40, avgTeleopScore: 70, avgEndgameScore: 25, avgTipsPerMatch: 3.2, maxScore: 135, avgRating: 135, brokenCount: 0, trend: 'new' }],
      records: [mockMatchRecord],
      pitRecords: [mockBiobuzzPit]
    })

    expect(result).toContain('Team # | Drivetrain | Ball Compat | Launcher | Flower Mech | Sensor | Odom | Claimed Auto | Claimed TeleOp | Claimed Endgame | Claimed Total | Brag Index (Audit) | Chassis Size')
    expect(result).toContain('27570 | swerve | universal | dual_flywheel | cascade_lift | Yes | pinpoint_otos | 45 pts (preload + 2 garden + park) | 70 pts (7 cycles) | 25 pts | 140 pts | 0.99x (realistic, Flower Verified)')
    expect(result).toContain('Avg Tips')
  })

  it('includes BIOBUZZ Mobility RP, TeleOp Park %, Predict Cycle Time, and Chassis Size in AI context', () => {
    const baseMs = 1_700_000_000_000
    const ts = [0, 8, 9, 10, 11, 12].reduce<number[]>((acc, g, idx) => {
      acc.push(idx === 0 ? baseMs : acc[idx - 1]! + g * 1000)
      return acc
    }, [])

    const result = buildEventDataContext({
      event: null,
      rankings: [
        {
          teamNumber: 27570,
          matchCount: 2,
          avgAutoScore: 24,
          avgTeleopScore: 54,
          avgEndgameScore: 28,
          maxScore: 112,
          avgRating: 106,
          brokenCount: 0,
          trend: 'up',
          teleopParkRate: 0.75,
          avgMobilityRpPts: 8.5,
          avgFlowerNectars: 4.5,
          avgFlowerBottomBonus: 2.0,
          avgFlowerPollens: 2.0,
          avgGardenBalls: 3.0,
          g410FoulRate: 0.5,
          predictCycleTime: 10.5,
          predictCycleMatches: 1,
          predictCycleSpread: 1.1,
          estimatedMaxCycles: 8.6
        }
      ],
      records: [
        {
          id: 'rec_bb_ctx',
          eventId: 'evt_1',
          scoutId: 's1',
          scoutName: 'Alice',
          matchNumber: 1,
          teamNumber: 27570,
          autoScore: 24,
          teleopScore: 54,
          endgameScore: 28,
          totalScore: 106,
          notes: 'Quick nectar cap',
          rawData: JSON.stringify({
            teleopPark: true,
            flowerNectars: 4,
            flowerBottomBonusCount: 2,
            flowerPollens: 2,
            gardenBalls: 1,
            g410EarlyFlowerFoul: true,
            teleopCycles: [2, 2, 2, 2, 2, 2],
            teleopCycleTimestamps: ts
          }),
          syncStatus: 'SYNCED',
          createdAt: '2026-08-20T10:00:00Z',
          updatedAt: '2026-08-20T10:00:00Z',
          isBroken: false,
          version: 1
        }
      ],
      pitRecords: [
        {
          id: 'pit_bb_ctx',
          eventId: 'evt_1',
          teamNumber: 27570,
          scoutId: 's1',
          scoutName: 'Alice',
          drivetrainType: 'swerve',
          chassisSize: 'compact_small',
          weightLbs: 36,
          ballCompatibility: 'universal',
          launcherType: 'dual_flywheel',
          flowerMechanism: 'vertical_lift',
          hasColorSensor: true,
          odometryType: 'pinpoint',
          claimedAutoScore: 24,
          claimedTeleopCycles: 8,
          claimedTeleopScore: 56,
          claimedTeleopPark: true,
          claimedEndgameScore: 24,
          claimedTotalScore: 104,
          syncStatus: 'SYNCED',
          createdAt: '2026-08-20T09:00:00Z',
          updatedAt: '2026-08-20T09:00:00Z',
          version: 1
        }
      ]
    })

    expect(result).toContain('TeleOp Park % | Mobility RP (/13) | BIOBUZZ Endgame (N/B/P/G) | G410 % | Predict Cycle | Est. Max Cycles')
    expect(result).toContain('75% | 8.5 | N:4.5 B:2 P:2 G:3 | 50% | 10.5s (1m) | 8.6')
    expect(result).toContain('compact_small')
    expect(result).toContain('EndPark N:4 B:2 P:2 G:1 G410! | 10.5s')
  })
})



describe('buildEventDataContext v2 enhancements', () => {
  it('renders Perspective & Focus, Match Schedule, Spread/Descore, Advancement, and Custom Metrics when supplied', async () => {
    const { buildContextPreviewStats, estimateTokenCount } = await import('../components/ai/contextBuilder')

    const opts: Parameters<typeof buildEventDataContext>[0] = {
      event: {
        id: 'evt-v2',
        name: 'BIOBUZZ Regional',
        inviteCode: 'BIO27',
        hostId: 'u1',
        ftcYear: 2026,
        ftcEventCode: 'CNREG'
      },
      myTeamNumber: 27570,
      focusTeams: [12345],
      focusMatch: { matchNumber: 12, tournamentLevel: 'QUALIFICATION' },
      rankings: [
        {
          teamNumber: 27570,
          matchCount: 4,
          avgAutoScore: 30,
          avgTeleopScore: 95,
          avgEndgameScore: 22,
          maxScore: 168,
          avgRating: 147,
          brokenCount: 0,
          trend: 'up',
          teleopParkRate: 0.75,
          avgMobilityRpPts: 11.5,
          avgFlowerNectars: 4.5,
          avgFlowerBottomBonus: 2.0,
          avgFlowerPollens: 5.0,
          avgGardenBalls: 3.0,
          descoreRate: 0.5,
          g410FoulRate: 0,
          predictCycleTime: 7.4,
          predictCycleMatches: 3,
          predictCycleSpread: 1.2,
          estimatedMaxCycles: 10,
          advancementPoints: 58,
          advancementStatus: 'ADVANCING',
          advancementRolledDown: true
        }
      ],
      schedules: [
        {
          eventId: 'evt-v2',
          matchNumber: 12,
          tournamentLevel: 'QUALIFICATION',
          red1: 27570,
          red2: 12345,
          blue1: 8888,
          blue2: 9999,
          scoreRedFinal: null,
          scoreBlueFinal: null
        },
        {
          eventId: 'evt-v2',
          matchNumber: 2,
          tournamentLevel: 'PLAYOFF',
          red1: 27570,
          red2: 8888,
          blue1: 12345,
          blue2: 9999,
          scoreRedFinal: 175,
          scoreBlueFinal: 162
        }
      ],
      customFields: [
        {
          id: 'cf1',
          eventId: 'evt-v2',
          target: 'MATCH',
          phase: 'teleop',
          name: 'Intake Jam',
          fieldKey: 'intakeJam',
          fieldType: 'boolean',
          required: false,
          orderSeq: 1,
          isActive: true
        },
        {
          id: 'cf2',
          eventId: 'evt-v2',
          target: 'MATCH',
          phase: 'auto',
          name: 'Sort Speed',
          fieldKey: 'sortSpeed',
          fieldType: 'number',
          required: false,
          unit: 's',
          orderSeq: 2,
          isActive: true
        }
      ],
      records: [
        {
          id: 'rec-1',
          eventId: 'evt-v2',
          scoutId: 's1',
          scoutName: 'Alex',
          matchNumber: 12,
          teamNumber: 27570,
          autoScore: 30,
          teleopScore: 98,
          endgameScore: 24,
          totalScore: 152,
          notes: 'Smooth cycle',
          rawData: JSON.stringify({
            customFields: { intakeJam: true, sortSpeed: 2.5 }
          }),
          syncStatus: 'SYNCED',
          createdAt: '2026-11-21T10:00:00Z',
          updatedAt: '2026-11-21T10:00:00Z',
          isBroken: false,
          version: 1
        }
      ],
      pitRecords: [
        {
          id: 'pit-1',
          eventId: 'evt-v2',
          teamNumber: 27570,
          scoutId: 's1',
          scoutName: 'Alex',
          drivetrainType: 'swerve',
          weightLbs: 31,
          ballCompatibility: 'universal',
          launcherType: 'turret',
          flowerMechanism: 'elevator',
          hasColorSensor: true,
          hasDescoreMech: true,
          hasApriltagVision: true,
          odometryType: 'pinpoint',
          claimedAutoScore: 32,
          claimedTeleopCycles: 10,
          claimedTeleopScore: 100,
          claimedTeleopPark: true,
          claimedEndgameScore: 24,
          claimedTotalScore: 156,
          version: 1
        }
      ]
    }

    const stats = buildContextPreviewStats(opts)
    expect(stats.text).toContain('[Perspective & Focus]')
    expect(stats.text).toContain('My Team: #27570')
    expect(stats.text).toContain('Focused Teams: #12345')
    expect(stats.text).toContain('Focused Match: Qual Match 12')
    expect(stats.text).toContain('Cycle Spread | Descore %')
    expect(stats.text).toContain('Advancement Pts | Advancement Status')
    expect(stats.text).toContain('1.2s | 50% | 58 | ADVANCING (Rolled Down)')
    expect(stats.text).toContain('[Match Schedule]')
    expect(stats.text).toContain('Q12 | #27570, #12345 | #8888, #9999 | Upcoming')
    expect(stats.text).toContain('P2 | #27570, #8888 | #12345, #9999 | 175 - 162')
    expect(stats.text).toContain('Weight & Capabilities')
    expect(stats.text).toContain('31lbs, DescoreMech, AprilTag, ClaimsTeleOpPark')
    expect(stats.text).toContain('[Custom Metrics]')
    expect(stats.text).toContain('Team 27570: Intake Jam: 100% · Sort Speed: 2.5s')
    expect(stats.scheduleCount).toBe(2)
    expect(stats.focusTeamsCount).toBe(1)
    expect(stats.estimatedTokens).toBe(estimateTokenCount(stats.text))
    expect(estimateTokenCount('你好FTC')).toBeGreaterThan(0)
  })

  it('respects section toggles and preserves focus teams across strict line-boundary truncation', async () => {
    const { buildContextPreviewStats } = await import('../components/ai/contextBuilder')

    const manyRecords: Parameters<typeof buildEventDataContext>[0]['records'] = []
    manyRecords.push({
      id: 'focus-rec-1',
      eventId: 'evt-trunc',
      scoutId: 's1',
      scoutName: 'FocusScout',
      matchNumber: 1,
      teamNumber: 27570,
      autoScore: 25,
      teleopScore: 90,
      endgameScore: 20,
      totalScore: 135,
      notes: 'Focused early match MUST survive truncation',
      rawData: '{}',
      syncStatus: 'SYNCED',
      createdAt: '2026-11-21T08:00:00Z',
      updatedAt: '2026-11-21T08:00:00Z',
      isBroken: false,
      version: 1
    })

    for (let i = 2; i <= 40; i++) {
      manyRecords.push({
        id: `rec-${i}`,
        eventId: 'evt-trunc',
        scoutId: 's2',
        scoutName: 'OtherScout',
        matchNumber: i,
        teamNumber: 9000 + i,
        autoScore: 10,
        teleopScore: 50,
        endgameScore: 10,
        totalScore: 70,
        notes: 'Long padding note to consume context budget cleanly on line boundary '.repeat(2),
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '2026-11-21T09:00:00Z',
        updatedAt: '2026-11-21T09:00:00Z',
        isBroken: false,
        version: 1
      })
    }

    const stats = buildContextPreviewStats({
      rankings: [
        {
          teamNumber: 27570,
          matchCount: 1,
          avgAutoScore: 25,
          avgTeleopScore: 90,
          avgEndgameScore: 20,
          maxScore: 135,
          avgRating: 135,
          brokenCount: 0,
          trend: 'stable'
        }
      ],
      schedules: [
        {
          eventId: 'evt-trunc',
          matchNumber: 1,
          tournamentLevel: 'QUALIFICATION',
          red1: 27570,
          red2: 1111,
          blue1: 2222,
          blue2: 3333
        }
      ],
      focusTeams: [27570],
      sections: {
        rankings: false,
        schedule: false,
        pit: false,
        tags: false,
        matches: true
      },
      records: manyRecords,
      maxCharsBudget: 2400
    })

    expect(stats.text).not.toContain('[Teams Overall Rankings')
    expect(stats.text).not.toContain('[Match Schedule]')
    expect(stats.truncatedMatchesCount).toBeGreaterThan(0)
    expect(stats.text).toContain('Match 1 | Team 27570 | FocusScout')
    expect(stats.text).toContain('omitted to stay within')
  })

  it('includes SP-NP OPR, Auto/TeleOp Cycle Time, and active TEAM/MATCH custom formulas in AI context', () => {
    const context = buildEventDataContext({
      event: null,
      rankings: [
        {
          teamNumber: 27570,
          matchCount: 3,
          avgAutoScore: 20,
          avgTeleopScore: 50,
          avgEndgameScore: 15,
          maxScore: 95,
          avgRating: 85,
          brokenCount: 0,
          trend: 'up',
          spNpOpr: 78.4,
          rawNpOpr: 72.1,
          spNpOprAuto: 19.6,
          spNpOprTeleop: 45.2,
          spNpOprEndgame: 13.6,
          spNpOprConfidence: 'high',
          autoCycleTime: 3.2,
          autoCycleMatches: 2,
          teleopCycleTime: 5.4,
          predictCycleTime: 5.4,
          predictCycleMatches: 3
        }
      ],
      records: [
        {
          id: 'r-ctx-1',
          eventId: 'evt-ctx',
          scoutId: 's1',
          scoutName: 'Scout1',
          matchNumber: 1,
          teamNumber: 27570,
          autoScore: 20,
          teleopScore: 50,
          endgameScore: 15,
          totalScore: 85,
          notes: '',
          rawData: JSON.stringify({ customFields: { bonus_pts: 5 } }),
          syncStatus: 'SYNCED',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          isBroken: false,
          version: 1
        }
      ],
      customFields: [
        {
          id: 'cf-m1',
          eventId: 'evt-ctx',
          target: 'MATCH',
          phase: 'overall',
          name: 'Match Plus Bonus',
          fieldKey: 'match_plus',
          fieldType: 'formula',
          formulaExpr: 'match.totalScore + cf.bonus_pts',
          aggregationMode: 'avg',
          displayFormat: 'number',
          required: false,
          orderSeq: 0,
          isActive: true
        },
        {
          id: 'cf-t1',
          eventId: 'evt-ctx',
          target: 'TEAM',
          phase: 'overall',
          name: 'Tactical OPR Index',
          fieldKey: 'tactical_opr',
          fieldType: 'formula',
          formulaExpr: 'opr.np * 1.1',
          displayFormat: 'number',
          required: false,
          orderSeq: 1,
          isActive: true
        }
      ]
    })

    expect(context).toContain('SP-NP OPR')
    expect(context).toContain('78.4 (high)')
    expect(context).toContain('72.1')
    expect(context).toContain('19.6/45.2/13.6')
    expect(context).toContain('3.2s (2m)')
    expect(context).toContain('5.4s (3m)')
    expect(context).toContain('[Custom Metrics]')
    expect(context).toContain('Match Plus Bonus: 90.0')
    expect(context).toContain('Tactical OPR Index: 86.2')
  })
})
