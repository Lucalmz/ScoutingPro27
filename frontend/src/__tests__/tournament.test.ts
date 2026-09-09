import { describe, it, expect } from 'vitest'
import {
  getRecordTournamentLevel,
  getTournamentLevelOrder,
  sortRecordsChronologically,
  getMatchLevelPrefix,
  isAssignmentCompleted
} from '@/utils/tournament'
import type { ScoutingRecord } from '@/types'

describe('Tournament Utilities', () => {
  it('correctly extracts tournament level and defaults to QUALIFICATION', () => {
    const r1 = { rawData: '{"tournamentLevel":"playoff"}' } as ScoutingRecord
    const r2 = { rawData: '{"tournamentLevel":"QUALIFICATION"}' } as ScoutingRecord
    const r3 = { rawData: '{}' } as ScoutingRecord
    const r4 = { rawData: '' } as ScoutingRecord
    const r5 = { rawData: 'invalid json' } as ScoutingRecord

    expect(getRecordTournamentLevel(r1)).toBe('PLAYOFF')
    expect(getRecordTournamentLevel(r2)).toBe('QUALIFICATION')
    expect(getRecordTournamentLevel(r3)).toBe('QUALIFICATION')
    expect(getRecordTournamentLevel(r4)).toBe('QUALIFICATION')
    expect(getRecordTournamentLevel(r5)).toBe('QUALIFICATION')
  })

  it('orders tournament levels: QUALIFICATION (1) -> PLAYOFF (2) -> OTHER (3)', () => {
    expect(getTournamentLevelOrder('QUALIFICATION')).toBe(1)
    expect(getTournamentLevelOrder('qualification')).toBe(1)
    expect(getTournamentLevelOrder('PLAYOFF')).toBe(2)
    expect(getTournamentLevelOrder('playoff')).toBe(2)
    expect(getTournamentLevelOrder('FINALS')).toBe(3)
    expect(getTournamentLevelOrder()).toBe(1)
  })

  it('sorts records chronologically: qualification matches before playoff matches, then by matchNumber', () => {
    const q1 = { id: 'q1', matchNumber: 1, rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION' }) } as ScoutingRecord
    const q2 = { id: 'q2', matchNumber: 2, rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION' }) } as ScoutingRecord
    const q3 = { id: 'q3', matchNumber: 3, rawData: '' } as ScoutingRecord // defaults to qualification
    const p1 = { id: 'p1', matchNumber: 1, rawData: JSON.stringify({ tournamentLevel: 'PLAYOFF' }) } as ScoutingRecord
    const p2 = { id: 'p2', matchNumber: 2, rawData: JSON.stringify({ tournamentLevel: 'PLAYOFF' }) } as ScoutingRecord

    // Input unsorted / mixed
    const input = [p2, q3, p1, q1, q2]
    const sorted = sortRecordsChronologically(input)

    expect(sorted.map(r => r.id)).toEqual(['q1', 'q2', 'q3', 'p1', 'p2'])
  })

  it('getMatchLevelPrefix returns Q for qualification and P for playoff', () => {
    const qualRec = { rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION' }) } as ScoutingRecord
    const playoffRec = { rawData: JSON.stringify({ tournamentLevel: 'PLAYOFF' }) } as ScoutingRecord
    const defaultRec = { rawData: '{}' } as ScoutingRecord

    expect(getMatchLevelPrefix(qualRec)).toBe('Q')
    expect(getMatchLevelPrefix(playoffRec)).toBe('P')
    expect(getMatchLevelPrefix(defaultRec)).toBe('Q')
    expect(getMatchLevelPrefix('PLAYOFF')).toBe('P')
    expect(getMatchLevelPrefix('QUALIFICATION')).toBe('Q')
  })

  it('isAssignmentCompleted strictly isolates assignments by tournament level without false collisions', () => {
    const scoutId = 'scout_alice'
    const qual1Rec = {
      id: 'r_q1',
      matchNumber: 1,
      teamNumber: 27570,
      scoutId,
      rawData: '{}', // defaults to QUALIFICATION
      isDeleted: false
    } as ScoutingRecord

    const playoff1Rec = {
      id: 'r_p1',
      matchNumber: 1,
      teamNumber: 27570,
      scoutId,
      rawData: JSON.stringify({ tournamentLevel: 'PLAYOFF' }),
      isDeleted: false
    } as ScoutingRecord

    // 1. Scout assigned to Playoff Match 1, but only Qualification Match 1 has been scouted
    const playoffTask = { matchNumber: 1, teamNumber: 27570, tournamentLevel: 'PLAYOFF' }
    expect(isAssignmentCompleted(playoffTask, scoutId, [qual1Rec])).toBe(false)

    // 2. Scout assigned to Qualification Match 1 (no tournamentLevel explicit), but only Playoff Match 1 scouted
    const qualTaskDefault = { matchNumber: 1, teamNumber: 27570 }
    expect(isAssignmentCompleted(qualTaskDefault, scoutId, [playoff1Rec])).toBe(false)

    // 3. Scout assigned to Playoff Match 1, and Playoff Match 1 is recorded
    expect(isAssignmentCompleted(playoffTask, scoutId, [playoff1Rec])).toBe(true)

    // 4. Scout assigned to Qualification Match 1, and Qualification Match 1 is recorded
    expect(isAssignmentCompleted(qualTaskDefault, scoutId, [qual1Rec])).toBe(true)

    // 5. Deleted record should not count as completed
    const deletedQualRec = { ...qual1Rec, isDeleted: true }
    expect(isAssignmentCompleted(qualTaskDefault, scoutId, [deletedQualRec])).toBe(false)
  })

  it('isAssignmentCompleted supports matchAnyScout option to dismiss tasks covered by teammates', () => {
    const aliceId = 'scout_alice'
    const bobId = 'scout_bob'
    const bobRecord = {
      id: 'r_bob_1',
      matchNumber: 1,
      teamNumber: 27570,
      scoutId: bobId,
      rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION' }),
      isDeleted: false
    } as ScoutingRecord

    const aliceTask = { matchNumber: 1, teamNumber: 27570, tournamentLevel: 'QUALIFICATION' }

    // By default without matchAnyScout: checks only Alice's own records -> false
    expect(isAssignmentCompleted(aliceTask, aliceId, [bobRecord])).toBe(false)

    // With matchAnyScout: true: Bob's valid record satisfies the task -> true!
    expect(isAssignmentCompleted(aliceTask, aliceId, [bobRecord], { matchAnyScout: true })).toBe(true)

    // Deleted record by teammate should NOT satisfy the task
    const bobDeletedRecord = { ...bobRecord, isDeleted: true }
    expect(isAssignmentCompleted(aliceTask, aliceId, [bobDeletedRecord], { matchAnyScout: true })).toBe(false)

    // Record for different match/team/level should NOT satisfy the task
    const bobPlayoffRecord = { ...bobRecord, rawData: JSON.stringify({ tournamentLevel: 'PLAYOFF' }) }
    expect(isAssignmentCompleted(aliceTask, aliceId, [bobPlayoffRecord], { matchAnyScout: true })).toBe(false)
  })
})
