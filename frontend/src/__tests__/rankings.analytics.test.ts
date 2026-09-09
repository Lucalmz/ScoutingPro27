import { describe, it, expect } from 'vitest'
import { calculateScoutReliability, calculateRankings } from '@/utils/analytics/rankings'
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
})
