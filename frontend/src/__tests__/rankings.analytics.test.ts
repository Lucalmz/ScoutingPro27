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
})
