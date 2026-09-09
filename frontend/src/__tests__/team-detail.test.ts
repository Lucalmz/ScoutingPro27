import { describe, it, expect } from 'vitest'
import { sortRecordsChronologically, getMatchLevelPrefix } from '@/utils/tournament'
import type { ScoutingRecord } from '@/types'

describe('Team Detail Match History Display', () => {
  it('chronologically sorts a team matches list: qualification matches before playoff matches', () => {
    const q1: ScoutingRecord = {
      id: 'rec_q1',
      eventId: 'evt_1',
      matchNumber: 1,
      teamNumber: 27570,
      scoutId: 's1',
      scoutName: 'Alice',
      autoScore: 30,
      teleopScore: 40,
      endgameScore: 20,
      totalScore: 90,
      rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION' }),
      syncStatus: 'SYNCED',
      createdAt: '2026-08-20T10:00:00Z',
      updatedAt: '2026-08-20T10:00:00Z',
      version: 1
    }

    const q2: ScoutingRecord = {
      id: 'rec_q2',
      eventId: 'evt_1',
      matchNumber: 2,
      teamNumber: 27570,
      scoutId: 's1',
      scoutName: 'Alice',
      autoScore: 35,
      teleopScore: 45,
      endgameScore: 20,
      totalScore: 100,
      rawData: JSON.stringify({ tournamentLevel: 'QUALIFICATION' }),
      syncStatus: 'SYNCED',
      createdAt: '2026-08-20T11:00:00Z',
      updatedAt: '2026-08-20T11:00:00Z',
      version: 1
    }

    const p1: ScoutingRecord = {
      id: 'rec_p1',
      eventId: 'evt_1',
      matchNumber: 1,
      teamNumber: 27570,
      scoutId: 's1',
      scoutName: 'Alice',
      autoScore: 50,
      teleopScore: 60,
      endgameScore: 30,
      totalScore: 140,
      rawData: JSON.stringify({ tournamentLevel: 'PLAYOFF' }),
      syncStatus: 'SYNCED',
      createdAt: '2026-08-20T15:00:00Z',
      updatedAt: '2026-08-20T15:00:00Z',
      version: 1
    }

    // When unsorted or sorted by matchNumber only: [p1, q1, q2] or [q1, p1, q2]
    const list = [p1, q2, q1]
    const sorted = sortRecordsChronologically(list)

    expect(sorted.map(r => r.id)).toEqual(['rec_q1', 'rec_q2', 'rec_p1'])

    // Formatted match badges
    const badges = sorted.map(r => `${getMatchLevelPrefix(r)}${r.matchNumber}`)
    expect(badges).toEqual(['Q1', 'Q2', 'P1'])
  })

  it('guarantees event isolation so matches from other events do not leak into activeRecords', async () => {
    const { setActivePinia, createPinia } = await import('pinia')
    const { useRecordStore } = await import('@/stores/records')
    setActivePinia(createPinia())
    const store = useRecordStore()

    const recEvt1: ScoutingRecord = {
      id: 'rec_e1',
      eventId: 'evt_current',
      matchNumber: 1,
      teamNumber: 27570,
      scoutId: 's1',
      scoutName: 'Alice',
      autoScore: 30,
      teleopScore: 40,
      endgameScore: 20,
      totalScore: 90,
      rawData: '{}',
      syncStatus: 'SYNCED',
      createdAt: '2026-08-20T10:00:00Z',
      updatedAt: '2026-08-20T10:00:00Z',
      version: 1
    }

    const recEvt2: ScoutingRecord = {
      id: 'rec_e2',
      eventId: 'evt_other_past_event',
      matchNumber: 1,
      teamNumber: 27570,
      scoutId: 's1',
      scoutName: 'Alice',
      autoScore: 50,
      teleopScore: 50,
      endgameScore: 50,
      totalScore: 150,
      rawData: '{}',
      syncStatus: 'SYNCED',
      createdAt: '2026-08-10T10:00:00Z',
      updatedAt: '2026-08-10T10:00:00Z',
      version: 1
    }

    store.records = [recEvt1, recEvt2]
    store.currentEventId = 'evt_current'

    // Active records for current event should contain only rec_e1
    const activeForTeam = store.activeRecords.filter(r => r.teamNumber === 27570)
    expect(activeForTeam).toHaveLength(1)
    expect(activeForTeam[0].id).toBe('rec_e1')
  })
})
