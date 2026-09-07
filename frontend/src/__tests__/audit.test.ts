import { describe, it, expect } from 'vitest'
import { calculateMatchDiscrepancies } from '@/utils/analytics/audit'
import type { ScoutingRecord, OfficialMatch } from '@/types'

describe('Match Score Discrepancy & Audit', () => {
  it('identifies top 5 discrepancy matches and ranks them accurately', () => {
    const officialMatches: OfficialMatch[] = [
      {
        matchNum: 1,
        scores: {
          red: { penaltyPointsCommitted: 0, totalPointsNp: 100, finalScore: 100 },
          blue: { penaltyPointsCommitted: 0, totalPointsNp: 150, finalScore: 150 }
        },
        teams: [
          { teamNumber: 11, alliance: 'Red' },
          { teamNumber: 12, alliance: 'Red' },
          { teamNumber: 13, alliance: 'Blue' },
          { teamNumber: 14, alliance: 'Blue' }
        ]
      },
      {
        matchNum: 2,
        scores: {
          red: { penaltyPointsCommitted: 0, totalPointsNp: 80, finalScore: 80 },
          blue: { penaltyPointsCommitted: 0, totalPointsNp: 200, finalScore: 200 }
        },
        teams: [
          { teamNumber: 21, alliance: 'Red' },
          { teamNumber: 22, alliance: 'Red' },
          { teamNumber: 23, alliance: 'Blue' },
          { teamNumber: 24, alliance: 'Blue' }
        ]
      }
    ]

    const records: ScoutingRecord[] = [
      // Match 1: Red scouts sum = 105 (diff = 5 pts)
      { id: 'r1', eventId: 'e1', scoutId: 's1', scoutName: 'Alice', teamNumber: 11, matchNumber: 1, autoScore: 20, teleopScore: 30, endgameScore: 10, totalScore: 60, updatedAt: '2026-09-06T10:00:00Z' },
      { id: 'r2', eventId: 'e1', scoutId: 's2', scoutName: 'Bob', teamNumber: 12, matchNumber: 1, autoScore: 15, teleopScore: 20, endgameScore: 10, totalScore: 45, updatedAt: '2026-09-06T10:00:00Z' },
      // Match 2: Red scouts sum = 140 (diff = |140 - 80| = 60 pts! High discrepancy!)
      { id: 'r3', eventId: 'e1', scoutId: 's1', scoutName: 'Alice', teamNumber: 21, matchNumber: 2, autoScore: 30, teleopScore: 40, endgameScore: 10, totalScore: 80, updatedAt: '2026-09-06T10:00:00Z' },
      { id: 'r4', eventId: 'e1', scoutId: 's3', scoutName: 'Charlie', teamNumber: 22, matchNumber: 2, autoScore: 20, teleopScore: 30, endgameScore: 10, totalScore: 60, updatedAt: '2026-09-06T10:00:00Z' }
    ]

    const discrepancies = calculateMatchDiscrepancies(records, officialMatches)

    expect(discrepancies).toHaveLength(2)
    // Match 2 has 60 pts diff, Match 1 has 5 pts diff
    expect(discrepancies[0].matchNumber).toBe(2)
    expect(discrepancies[0].rank).toBe(1)
    expect(discrepancies[0].isTop5).toBe(true)
    expect(discrepancies[0].hasWarning).toBe(true)
    expect(discrepancies[0].maxDiff).toBe(60)

    expect(discrepancies[1].matchNumber).toBe(1)
    expect(discrepancies[1].rank).toBe(2)
    expect(discrepancies[1].isTop5).toBe(true)
    expect(discrepancies[1].maxDiff).toBe(5)
    // Match 1 diff is only 5 pts (< 20 pts threshold), but isTop5 is true
    expect(discrepancies[1].hasWarning).toBe(true)
  })

  it('handles empty records or matches gracefully', () => {
    expect(calculateMatchDiscrepancies([], [])).toEqual([])
  })
})
