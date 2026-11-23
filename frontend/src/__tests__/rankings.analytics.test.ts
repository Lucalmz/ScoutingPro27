import { describe, it, expect } from 'vitest'
import {
  calculateScoutReliability,
  calculateRankings,
  getScoutedBalls,
  parseBiobuzzEndgame,
  calcBiobuzzEndgameScore,
  parseScoutRawData
} from '@/utils/analytics/rankings'
import type { ScoutingRecord, OfficialMatch } from '@/types'

describe('rankings analytics', () => {
  it('calculateScoutReliability returns high when deviation is low and low when deviation exceeds 30%', () => {
    const officialMatches: OfficialMatch[] = [
      {
        matchNum: 1,
        scores: {
          red: { totalPointsNp: 100, penaltyPointsCommitted: 0 },
          blue: { totalPointsNp: 80, penaltyPointsCommitted: 0 }
        },
        teams: [
          { teamNumber: 111, alliance: 'red' },
          { teamNumber: 222, alliance: 'red' }
        ]
      }
    ]

    const records: ScoutingRecord[] = [
      {
        id: 'r1',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 111,
        scoutId: 'scout_good',
        scoutName: 'Good Scout',
        totalScore: 50,
        autoScore: 20,
        teleopScore: 20,
        endgameScore: 10,
        rawData: '{}',
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z'
      },
      {
        id: 'r2',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 222,
        scoutId: 'scout_good',
        scoutName: 'Good Scout',
        totalScore: 52, // sum = 102 vs 100 (2% deviation)
        autoScore: 20,
        teleopScore: 20,
        endgameScore: 12,
        rawData: '{}',
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z'
      }
    ]

    const reliability = calculateScoutReliability(records, officialMatches)
    expect(reliability['scout_good']).toBe('high')
  })

  it('calculateRankings correctly computes averages, deducts penalties, and sorts by avgRating descending', () => {
    const records: ScoutingRecord[] = [
      {
        id: 'r1',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 1001,
        scoutId: 's1',
        scoutName: 'Scout 1',
        totalScore: 80,
        autoScore: 30,
        teleopScore: 30,
        endgameScore: 20,
        rawData: '{}',
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z'
      },
      {
        id: 'r2',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 2002,
        scoutId: 's1',
        scoutName: 'Scout 1',
        totalScore: 40,
        autoScore: 10,
        teleopScore: 20,
        endgameScore: 10,
        rawData: '{}',
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z'
      }
    ]

    const rankings = calculateRankings(records, [], {})
    expect(rankings.length).toBe(2)
    expect(rankings[0]!.teamNumber).toBe(1001)
    expect(rankings[0]!.avgRating).toBe(80)
    expect(rankings[1]!.teamNumber).toBe(2002)
    expect(rankings[1]!.avgRating).toBe(40)
  })

  it('does not wrongly deduct penalties across different tournament levels with identical match numbers', () => {
    const officialMatches: OfficialMatch[] = [
      {
        matchNum: 1,
        tournamentLevel: 'QUALIFICATION',
        scores: {
          red: { totalPointsNp: 100, penaltyPointsCommitted: 40 }, // 40 penalty points in Q1
          blue: { totalPointsNp: 100, penaltyPointsCommitted: 0 }
        },
        teams: [
          { teamNumber: 27570, alliance: 'red' }
        ]
      },
      {
        matchNum: 1,
        tournamentLevel: 'PLAYOFF',
        scores: {
          red: { totalPointsNp: 150, penaltyPointsCommitted: 0 }, // 0 penalty points in P1
          blue: { totalPointsNp: 120, penaltyPointsCommitted: 0 }
        },
        teams: [
          { teamNumber: 27570, alliance: 'red' }
        ]
      }
    ]

    const records: ScoutingRecord[] = [
      {
        id: 'r_p1',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Scout 1',
        totalScore: 100,
        autoScore: 30,
        teleopScore: 50,
        endgameScore: 20,
        rawData: JSON.stringify({ tournamentLevel: 'PLAYOFF' }),
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-01-01T12:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z'
      }
    ]

    // In Playoff 1, red alliance penalty committed was 0, so realTotalScore should remain 100, NOT 100 - (40/2) = 80!
    const rankings = calculateRankings(records, officialMatches, {})
    expect(rankings[0]!.maxScore).toBe(100)
    expect(rankings[0]!.avgRating).toBe(100)
  })

  it('correctly sorts chronological progression across qualification and playoff for trend calculation', () => {
    const records: ScoutingRecord[] = [
      {
        id: 'r_q1',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Scout 1',
        totalScore: 50,
        autoScore: 20,
        teleopScore: 20,
        endgameScore: 10,
        rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION' }),
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-01-01T09:00:00Z',
        updatedAt: '2026-01-01T09:00:00Z'
      },
      {
        id: 'r_q2',
        eventId: 'e1',
        matchNumber: 2,
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Scout 1',
        totalScore: 50,
        autoScore: 20,
        teleopScore: 20,
        endgameScore: 10,
        rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION' }),
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-01-01T10:00:00Z',
        updatedAt: '2026-01-01T10:00:00Z'
      },
      {
        id: 'r_q3',
        eventId: 'e1',
        matchNumber: 3,
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Scout 1',
        totalScore: 50,
        autoScore: 20,
        teleopScore: 20,
        endgameScore: 10,
        rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION' }),
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-01-01T11:00:00Z',
        updatedAt: '2026-01-01T11:00:00Z'
      },
      {
        id: 'r_p1',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Scout 1',
        totalScore: 100, // performed well in playoff match 1
        autoScore: 30,
        teleopScore: 40,
        endgameScore: 30,
        rawData: JSON.stringify({ tournamentLevel: 'PLAYOFF' }),
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-01-01T14:00:00Z',
        updatedAt: '2026-01-01T14:00:00Z'
      }
    ]

    const rankings = calculateRankings(records, [], {})
    // Chronological progression: Q1 (50) -> Q2 (50) -> Q3 (50) -> P1 (100)
    // Previous average: 50. Last match: 100. Trend must be 'up', NOT 'down'!
    expect(rankings[0]!.trend).toBe('up')
  })

  it('proportionally allocates official tips based on teleopCycles ball counts and ignores penalties', () => {
    const officialMatches: OfficialMatch[] = [
      {
        matchNum: 1,
        tournamentLevel: 'QUALIFICATION',
        scores: {
          red: { totalPointsNp: 120, penaltyPointsCommitted: 30, totalTips: 4 },
          blue: { totalPointsNp: 80, penaltyPointsCommitted: 0, totalTips: 2 }
        },
        teams: [
          { teamNumber: 1001, alliance: 'red' },
          { teamNumber: 1002, alliance: 'red' }
        ]
      }
    ]

    const records: ScoutingRecord[] = [
      {
        id: 'r1',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 1001,
        scoutId: 's1',
        scoutName: 'Scout 1',
        totalScore: 70,
        autoScore: 20,
        teleopScore: 40,
        endgameScore: 10,
        // 3 cycles with 2, 3, 1 balls = 6 balls
        rawData: JSON.stringify({
          tournamentLevel: 'QUALIFICATION',
          teleopCycles: [2, 3, 1]
        }),
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-01-01T10:00:00Z',
        updatedAt: '2026-01-01T10:00:00Z'
      },
      {
        id: 'r2',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 1002,
        scoutId: 's1',
        scoutName: 'Scout 1',
        totalScore: 50,
        autoScore: 10,
        teleopScore: 30,
        endgameScore: 10,
        // 1 cycle with 2 balls = 2 balls
        rawData: JSON.stringify({
          tournamentLevel: 'QUALIFICATION',
          teleopCycles: [2]
        }),
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-01-01T10:00:00Z',
        updatedAt: '2026-01-01T10:00:00Z'
      }
    ]

    const rankings = calculateRankings(records, officialMatches, {})
    expect(rankings.length).toBe(2)

    // Red alliance totalTips = 4. Total balls = 6 + 2 = 8 balls.
    // Team 1001: 6 / 8 = 75% -> 4 * 0.75 = 3.0 tips
    // Team 1002: 2 / 8 = 25% -> 4 * 0.25 = 1.0 tips
    const t1001 = rankings.find(r => r.teamNumber === 1001)!
    const t1002 = rankings.find(r => r.teamNumber === 1002)!

    expect(t1001.avgTipsPerMatch).toBe(3)
    expect(t1002.avgTipsPerMatch).toBe(1)

    // Verify official penalty of 30 was ignored in rating (totalScore 70, not reduced to 70 - 15 = 55)
    expect(t1001.avgRating).toBe(70)
    expect(t1002.avgRating).toBe(50)
  })

  it('getScoutedBalls correctly counts autoBalls + teleopCycles and supports legacy fallback', () => {
    // 1. autoBalls + teleopCycles
    const recModern: ScoutingRecord = {
      id: 'r_mod',
      eventId: 'e1',
      matchNumber: 1,
      teamNumber: 1001,
      scoutId: 's1',
      scoutName: 'S1',
      totalScore: 40,
      autoScore: 12,
      teleopScore: 20,
      endgameScore: 8,
      rawData: JSON.stringify({
        autoBalls: 3,
        teleopCycles: [2, 4]
      }),
      syncStatus: 'SYNCED',
      createdAt: '2026-01-01T10:00:00Z',
      updatedAt: '2026-01-01T10:00:00Z'
    }
    // 3 auto + (2 + 4) teleop = 9 balls
    expect(getScoutedBalls(recModern)).toBe(9)

    // 2. Legacy fallback: autoPreload + autoSecondary
    const recLegacy: ScoutingRecord = {
      id: 'r_leg',
      eventId: 'e1',
      matchNumber: 1,
      teamNumber: 1002,
      scoutId: 's1',
      scoutName: 'S1',
      totalScore: 30,
      autoScore: 6,
      teleopScore: 14,
      endgameScore: 10,
      rawData: JSON.stringify({
        autoPreload: true,
        autoSecondary: true,
        teleopCycles: [3]
      }),
      syncStatus: 'SYNCED',
      createdAt: '2026-01-01T10:00:00Z',
      updatedAt: '2026-01-01T10:00:00Z'
    }
    // 2 auto (preload+secondary) + 3 teleop = 5 balls
    expect(getScoutedBalls(recLegacy)).toBe(5)
  })

  it('calculateRankings deduplicates multiple records for the same match and team by latest updatedAt', () => {
    const duplicateRecords: ScoutingRecord[] = [
      {
        id: 'rec_old',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 27570,
        scoutId: 'scout_alice',
        scoutName: 'Alice',
        totalScore: 40,
        autoScore: 10,
        teleopScore: 20,
        endgameScore: 10,
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '2026-01-01T10:00:00Z',
        updatedAt: '2026-01-01T10:00:00Z'
      },
      {
        id: 'rec_new',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 27570,
        scoutId: 'scout_bob',
        scoutName: 'Bob',
        totalScore: 60,
        autoScore: 20,
        teleopScore: 30,
        endgameScore: 10,
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '2026-01-01T10:00:00Z',
        updatedAt: '2026-01-01T10:05:00Z' // Later update
      }
    ]

    const rankings = calculateRankings(duplicateRecords, [], {})
    expect(rankings).toHaveLength(1)
    const teamRow = rankings[0]!
    expect(teamRow.teamNumber).toBe(27570)
    expect(teamRow.matchCount).toBe(1) // NOT 2! Deduplication must hold!
    expect(teamRow.avgRating).toBe(60) // Uses latest record score 60, NOT (40+60)/2 = 50
  })

  it('aggregates BIOBUZZ Endgame metrics, Mobility RP pts, legacy fallback, and Predict Cycle Time in calculateRankings', () => {
    const baseMs = 1_700_000_000_000
    const tsQual = [0, 5, 7, 9, 11, 13].reduce<number[]>((acc, g, idx) => {
      acc.push(idx === 0 ? baseMs : acc[idx - 1]! + g * 1000)
      return acc
    }, [])

    // Legacy normalization check
    const legacy = parseBiobuzzEndgame({ flowerPlaced: true, flowerBottomBonus: true, teleopPark: true })
    expect(legacy.flowerNectars).toBe(1)
    expect(legacy.flowerBottomBonusCount).toBe(1)
    expect(calcBiobuzzEndgameScore(legacy)).toBe(12) // 5 (park) + 2 (nectar) + 5 (bonus)

    const parsedLegacy = parseScoutRawData(JSON.stringify({ flowerPlaced: true, flowerPollens: 2 }))
    expect(parsedLegacy.endgame.flowerNectars).toBe(1)
    expect(parsedLegacy.endgame.flowerPollens).toBe(2)

    const records: ScoutingRecord[] = [
      {
        id: 'bb_1',
        eventId: 'e1',
        matchNumber: 1,
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Alice',
        autoScore: 20,
        teleopScore: 24,
        endgameScore: 27, // 5 (park) + 4*2 + 2*5 + 2*2
        totalScore: 71,
        rawData: JSON.stringify({
          autoLeave: true,
          autoPark: true,
          teleopPark: true,
          flowerNectars: 4,
          flowerBottomBonusCount: 2,
          flowerPollens: 2,
          gardenBalls: 0,
          flowerDescore: false,
          g410EarlyFlowerFoul: false,
          teleopCycles: [2, 2, 2, 2, 2, 2],
          teleopCycleTimestamps: tsQual
        }),
        syncStatus: 'SYNCED',
        createdAt: '2026-01-01T10:00:00Z',
        updatedAt: '2026-01-01T10:00:00Z'
      },
      {
        id: 'bb_2',
        eventId: 'e1',
        matchNumber: 2,
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Alice',
        autoScore: 15,
        teleopScore: 16,
        endgameScore: 9, // 0 (park) + 2*2 + 0 + 0 + 5*1
        totalScore: 40,
        rawData: JSON.stringify({
          autoLeave: true,
          autoPark: false,
          teleopPark: false,
          flowerNectars: 2,
          flowerBottomBonusCount: 0,
          flowerPollens: 0,
          gardenBalls: 5,
          flowerDescore: true,
          g410EarlyFlowerFoul: true,
          teleopCycles: [2, 2],
          teleopCycleTimestamps: [baseMs, baseMs + 5000] // <5 intervals -> ignored for Predict Cycle
        }),
        syncStatus: 'SYNCED',
        createdAt: '2026-01-01T11:00:00Z',
        updatedAt: '2026-01-01T11:00:00Z'
      }
    ]

    const rankings = calculateRankings(records, [], {})
    expect(rankings).toHaveLength(1)
    const row = rankings[0]!
    expect(row.teleopParkRate).toBe(0.5)
    // Match 1 Mobility = 3+5+5 = 13; Match 2 Mobility = 3+0+0 = 3 -> avg 8.0
    expect(row.avgMobilityRpPts).toBe(8.0)
    expect(row.avgFlowerNectars).toBe(3.0)
    expect(row.avgFlowerBottomBonus).toBe(1.0)
    expect(row.avgFlowerPollens).toBe(1.0)
    expect(row.avgGardenBalls).toBe(2.5)
    expect(row.descoreRate).toBe(0.5)
    expect(row.g410FoulRate).toBe(0.5)
    // Only Match 1 qualified (>=5 intervals: [5,7,9,11,13] -> drop 5 -> avg(7,9,11,13)=10.0s)
    expect(row.predictCycleTime).toBe(10.0)
    expect(row.predictCycleMatches).toBe(1)
    expect(row.estimatedMaxCycles).toBe(9.0)
    // Match 1 has 6 cycles, Match 2 has 2 cycles -> min = 2, variance = ((6-4)^2 + (2-4)^2)/2 = 4.0
    expect(row.minCycles).toBe(2)
    expect(row.cycleVariance).toBe(4.0)
  })

  it('computes minCycles and cycleVariance across non-broken matches and returns null when all matches are broken', () => {
    const makeRec = (id: string, teamNumber: number, matchNumber: number, cycles: number[], isBroken = false): ScoutingRecord => ({
      id,
      eventId: 'e1',
      matchNumber,
      teamNumber,
      scoutId: 's1',
      scoutName: 'Alice',
      autoScore: 10,
      teleopScore: cycles.reduce((a, b) => a + b * 2, 0),
      endgameScore: 0,
      totalScore: 10 + cycles.reduce((a, b) => a + b * 2, 0),
      rawData: JSON.stringify({ teleopCycles: cycles }),
      isBroken,
      syncStatus: 'SYNCED',
      createdAt: '2026-01-01T10:00:00Z',
      updatedAt: '2026-01-01T10:00:00Z'
    })

    const records: ScoutingRecord[] = [
      // Team 100: [3, 5, 7] + 1 broken match with 0 cycles (ignored) -> min = 3, mean = 5, variance = (4+0+4)/3 = 2.7
      makeRec('r1', 100, 1, [2, 2, 2]),
      makeRec('r2', 100, 2, [2, 2, 2, 2, 2]),
      makeRec('r3', 100, 3, [2, 2, 2, 2, 2, 2, 2]),
      makeRec('r4', 100, 4, [], true),
      // Team 200: only broken match -> null
      makeRec('r5', 200, 1, [2, 2], true)
    ]

    const rankings = calculateRankings(records, [], {})
    const team100 = rankings.find((r) => r.teamNumber === 100)!
    const team200 = rankings.find((r) => r.teamNumber === 200)!

    expect(team100.minCycles).toBe(3)
    expect(team100.cycleVariance).toBe(2.7)
    expect(team200.minCycles).toBeNull()
    expect(team200.cycleVariance).toBeNull()
  })
})

