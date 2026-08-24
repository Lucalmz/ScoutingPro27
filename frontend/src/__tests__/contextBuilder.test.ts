import { describe, it, expect } from 'vitest'
import { buildEventDataContext } from '@/components/ai/contextBuilder'
import type { ScoutingRecord, RankingRow, ScoutingEvent } from '@/types'

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

  it('includes tactical observation tags grouped by team with preset formatting (V11, V18, V20)', () => {
    const result = buildEventDataContext({
      event: null,
      rankings: [{ teamNumber: 27570, matchCount: 1, avgAutoScore: 10, avgTeleopScore: 10, avgEndgameScore: 10, maxScore: 30, avgRating: 30, brokenCount: 0, trend: 'stable' }],
      records: [],
      tags: [
        { id: '1', eventId: 'e1', teamNumber: 27570, tag: 'preset.dual_motor_hang', color: 'green', isPreset: true },
        { id: '2', eventId: 'e1', teamNumber: 27570, tag: 'aluminum_lift', color: 'blue', isPreset: false },
        { id: '3', eventId: 'e1', teamNumber: 19600, tag: 'preset.defense_specialist', color: 'red', isPreset: true }
      ]
    })

    expect(result).toContain('[Scouter Tactical Observation Tags (Subjective Field Notes - Cross-Validate with Match Stats)]')
    expect(result).toContain('Team 19600: defense specialist')
    expect(result).toContain('Team 27570: dual motor hang, aluminum_lift')
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
})
