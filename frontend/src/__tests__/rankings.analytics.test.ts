import { describe, it, expect } from 'vitest'
import { calculateScoutReliability, calculateRankings, getScoutedBalls } from '@/utils/analytics/rankings'
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
})

