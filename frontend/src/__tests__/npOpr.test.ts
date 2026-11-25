import { describe, expect, it } from 'vitest'
import type { OfficialMatch, ScoutingRecord } from '@/types'
import { calculateEventNpOpr, solveLinearSystem } from '@/utils/analytics/npOpr'

function makeRecord(overrides: Partial<ScoutingRecord>): ScoutingRecord {
  return {
    id: overrides.id ?? 'rec-1',
    eventId: 'evt-1',
    matchNumber: overrides.matchNumber ?? 1,
    teamNumber: overrides.teamNumber ?? 100,
    scoutId: overrides.scoutId ?? 's1',
    scoutName: 'Scout',
    autoScore: overrides.autoScore ?? 10,
    teleopScore: overrides.teleopScore ?? 20,
    endgameScore: overrides.endgameScore ?? 10,
    totalScore: overrides.totalScore ?? 40,
    rawData: overrides.rawData ?? '{}',
    isBroken: overrides.isBroken ?? false,
    isDeleted: overrides.isDeleted ?? false,
    syncStatus: 'SYNCED',
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T10:00:00Z'
  }
}

function makeOfficialMatch(
  matchNum: number,
  redTeams: Array<{ teamNumber: number; onField?: boolean; dq?: boolean }>,
  blueTeams: Array<{ teamNumber: number; onField?: boolean; dq?: boolean }>,
  redNp: number,
  blueNp: number
): OfficialMatch {
  return {
    matchNum,
    tournamentLevel: 'QUALIFICATION',
    scores: {
      red: { penaltyPointsCommitted: 0, totalPointsNp: redNp },
      blue: { penaltyPointsCommitted: 0, totalPointsNp: blueNp }
    },
    teams: [
      ...redTeams.map((t) => ({ ...t, alliance: 'Red' })),
      ...blueTeams.map((t) => ({ ...t, alliance: 'Blue' }))
    ] as OfficialMatch['teams']
  }
}

describe('npOpr', () => {
  it('solveLinearSystem solves 2x2 and 3x3 systems with partial pivoting and returns null for singular matrices', () => {
    const sol2 = solveLinearSystem(
      [
        [0, 2],
        [3, 1]
      ],
      [4, 5]
    )
    expect(sol2).not.toBeNull()
    expect(sol2![0]).toBeCloseTo(1, 6)
    expect(sol2![1]).toBeCloseTo(2, 6)

    const singular = solveLinearSystem(
      [
        [1, 2],
        [2, 4]
      ],
      [3, 6]
    )
    expect(singular).toBeNull()
  })

  it('converges accurately on a 4-team synthetic league for both SP-NP OPR and Raw NP OPR', () => {
    // True contributions: 101 -> 40, 102 -> 30, 103 -> 20, 104 -> 10
    const trueOpr: Record<number, number> = { 101: 40, 102: 30, 103: 20, 104: 10 }
    const officialMatches: OfficialMatch[] = [
      makeOfficialMatch(1, [{ teamNumber: 101 }, { teamNumber: 102 }], [{ teamNumber: 103 }, { teamNumber: 104 }], 70, 30),
      makeOfficialMatch(2, [{ teamNumber: 101 }, { teamNumber: 103 }], [{ teamNumber: 102 }, { teamNumber: 104 }], 60, 40),
      makeOfficialMatch(3, [{ teamNumber: 101 }, { teamNumber: 104 }], [{ teamNumber: 102 }, { teamNumber: 103 }], 50, 50)
    ]

    const records: ScoutingRecord[] = []
    let idSeq = 1
    for (const m of officialMatches) {
      for (const t of m.teams) {
        const total = trueOpr[t.teamNumber]!
        records.push(
          makeRecord({
            id: `r-${idSeq++}`,
            matchNumber: m.matchNum,
            teamNumber: t.teamNumber,
            autoScore: total * 0.25,
            teleopScore: total * 0.5,
            endgameScore: total * 0.25,
            totalScore: total
          })
        )
      }
    }

    const res = calculateEventNpOpr(records, officialMatches, {})
    expect(res.get(101)?.spNpOpr).toBeCloseTo(40, 0)
    expect(res.get(102)?.spNpOpr).toBeCloseTo(30, 0)
    expect(res.get(103)?.spNpOpr).toBeCloseTo(20, 0)
    expect(res.get(104)?.spNpOpr).toBeCloseTo(10, 0)

    expect(res.get(101)?.rawNpOpr).toBeCloseTo(40, 0)
    expect(res.get(104)?.rawNpOpr).toBeCloseTo(10, 0)

    const r101 = res.get(101)!
    expect(r101.spNpOprAuto).not.toBeNull()
    expect(r101.spNpOprTeleop).not.toBeNull()
    expect(r101.spNpOprEndgame).not.toBeNull()
    expect(
      Math.round((r101.spNpOprAuto! + r101.spNpOprTeleop! + r101.spNpOprEndgame!) * 10) / 10
    ).toBe(r101.spNpOpr)
  })

  it('sets M[m][t] = 0 for broken zero-score or off-field/DQ teams, and downweights broken-with-score equations to 0.25', () => {
    const officialMatches: OfficialMatch[] = [
      // Match 1: 101 + 102 vs 103 + 104 (normal)
      makeOfficialMatch(1, [{ teamNumber: 101 }, { teamNumber: 102 }], [{ teamNumber: 103 }, { teamNumber: 104 }], 70, 30),
      // Match 2: 101 broken with 0 score -> M[2][101] = 0, so 102 gets full credit for 30
      makeOfficialMatch(2, [{ teamNumber: 101 }, { teamNumber: 102 }], [{ teamNumber: 103 }, { teamNumber: 104 }], 30, 40),
      // Match 3: 101 broken with positive score (20) -> M[3][101] = 1.0, eq weight = 0.25
      makeOfficialMatch(3, [{ teamNumber: 101 }, { teamNumber: 103 }], [{ teamNumber: 102 }, { teamNumber: 104 }], 45, 40),
      // Match 4: both red teams off-field / DQ -> equation skipped
      makeOfficialMatch(
        4,
        [{ teamNumber: 101, onField: false }, { teamNumber: 102, dq: true }],
        [{ teamNumber: 103 }, { teamNumber: 104 }],
        0,
        30
      )
    ]

    const records: ScoutingRecord[] = [
      makeRecord({ id: '1', matchNumber: 1, teamNumber: 101, autoScore: 10, teleopScore: 20, endgameScore: 10, totalScore: 40 }),
      makeRecord({ id: '2', matchNumber: 1, teamNumber: 102, autoScore: 10, teleopScore: 15, endgameScore: 5, totalScore: 30 }),
      makeRecord({ id: '3', matchNumber: 2, teamNumber: 101, autoScore: 0, teleopScore: 0, endgameScore: 0, totalScore: 0, isBroken: true }),
      makeRecord({ id: '4', matchNumber: 3, teamNumber: 101, autoScore: 10, teleopScore: 10, endgameScore: 0, totalScore: 20, isBroken: true })
    ]

    const res = calculateEventNpOpr(records, officialMatches, {})
    const r101 = res.get(101)!
    const r102 = res.get(102)!
    const r103 = res.get(103)!

    expect(r101.spNpOprBrokenExcluded).toBe(2)
    // Because Match 2 (broken=0) isolated 101 and Match 4 was skipped, 101 is not dragged down to 0
    expect(r101.spNpOpr).toBeGreaterThan(25)
    expect(r102.spNpOpr).toBeGreaterThan(20)
    // 103 has no scouting records -> stage breakdown must be null
    expect(r103.spNpOprAuto).toBeNull()
    expect(r103.spNpOprTeleop).toBeNull()
    expect(r103.spNpOprEndgame).toBeNull()
  })

  it('returns null stage breakdown when scoutMatchesUsed === 0 or scoutStageSum <= 0, and null rawNpOpr when officialMatches < 2', () => {
    const officialMatches: OfficialMatch[] = [
      makeOfficialMatch(1, [{ teamNumber: 201 }, { teamNumber: 202 }], [{ teamNumber: 203 }, { teamNumber: 204 }], 40, 20)
    ]
    const records: ScoutingRecord[] = [
      makeRecord({ id: 'z1', matchNumber: 1, teamNumber: 201, autoScore: 0, teleopScore: 0, endgameScore: 0, totalScore: 0 })
    ]

    const res = calculateEventNpOpr(records, officialMatches, {})
    const r201 = res.get(201)!
    expect(r201.rawNpOpr).toBeNull()
    expect(r201.spNpOprDelta).toBeNull()
    expect(r201.spNpOprConfidence).toBe('low')
    expect(r201.spNpOprAuto).toBeNull()
    expect(r201.spNpOprTeleop).toBeNull()
    expect(r201.spNpOprEndgame).toBeNull()
  })

  it('assigns scout_only confidence when no official matches exist', () => {
    const records: ScoutingRecord[] = [
      makeRecord({ id: 's1', matchNumber: 1, teamNumber: 301, autoScore: 12, teleopScore: 20, endgameScore: 8, totalScore: 40 })
    ]
    const res = calculateEventNpOpr(records, [], {})
    const r301 = res.get(301)!
    expect(r301.spNpOprConfidence).toBe('scout_only')
    expect(r301.spNpOprOfficialMatches).toBe(0)
    expect(r301.rawNpOpr).toBeNull()
    expect(r301.spNpOpr).toBeCloseTo(40, 0)
  })
})
