import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useScheduleStore } from '../stores/schedule'
import type { OfficialMatch } from '../types'
import * as api from '../services/api'

vi.mock('../services/api', () => ({
  fetchEventSchedule: vi.fn(),
  saveScheduleBatch: vi.fn().mockResolvedValue({ count: 2 }),
  clearEventSchedule: vi.fn().mockResolvedValue({ success: true }),
  saveScoutAssignments: vi.fn().mockResolvedValue({ count: 1 })
}))

describe('Schedule Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  describe('CSV Parsing', () => {
    it('parses standard comma-separated lines and skips headers', () => {
      const store = useScheduleStore()
      const csv = `
        Match, Red 1, Red 2, Blue 1, Blue 2
        1, 11223, 22334, 33445, 44556
        2, 10001, 10002, 10003, 10004
      `
      const items = store.parseCsvSchedule('evt-test', csv)
      expect(items).toHaveLength(2)
      expect(items[0]).toEqual({
        id: 'evt-test_M1',
        eventId: 'evt-test',
        matchNumber: 1,
        tournamentLevel: 'QUALIFICATION',
        red1: 11223,
        red2: 22334,
        blue1: 33445,
        blue2: 44556,
        scoreRedFinal: null,
        scoreBlueFinal: null
      })
      expect(items[1].matchNumber).toBe(2)
      expect(items[1].red1).toBe(10001)
    })

    it('parses tab and semicolon separated values with "Q" prefixes', () => {
      const store = useScheduleStore()
      const csv = `
        Q1\t5001\t5002\t5003\t5004
        Q2;6001;6002;6003;6004
      `
      const items = store.parseCsvSchedule('evt-test', csv)
      expect(items).toHaveLength(2)
      expect(items[0].matchNumber).toBe(1)
      expect(items[0].red1).toBe(5001)
      expect(items[1].matchNumber).toBe(2)
      expect(items[1].blue2).toBe(6004)
    })

    it('ignores invalid rows', () => {
      const store = useScheduleStore()
      const csv = `
        Invalid Header
        1, 2, 3
        foo, bar, baz, qux, quux
      `
      const items = store.parseCsvSchedule('evt-test', csv)
      expect(items).toHaveLength(0)
    })
  })

  describe('FTC Official Schedule Mapping', () => {
    it('converts OfficialMatch list into MatchScheduleItems with scores', async () => {
      const store = useScheduleStore()
      const mockOfficialMatches: OfficialMatch[] = [
        {
          matchNum: 1,
          scores: {
            red: { penaltyPointsCommitted: 0, totalPointsNp: 120, finalScore: 120 },
            blue: { penaltyPointsCommitted: 0, totalPointsNp: 95, finalScore: 95 }
          },
          teams: [
            { teamNumber: 111, alliance: 'Red' },
            { teamNumber: 222, alliance: 'Red' },
            { teamNumber: 333, alliance: 'Blue' },
            { teamNumber: 444, alliance: 'Blue' }
          ]
        },
        {
          matchNum: 2,
          scores: null,
          teams: [
            { teamNumber: 555, alliance: 'Red' },
            { teamNumber: 666, alliance: 'Red' },
            { teamNumber: 777, alliance: 'Blue' },
            { teamNumber: 888, alliance: 'Blue' }
          ]
        }
      ]

      const res = await store.importFromFtcOfficial('evt-test', mockOfficialMatches, true)
      expect(res.count).toBe(2)
      expect(store.schedules).toHaveLength(2)
      expect(store.schedules[0].matchNumber).toBe(1)
      expect(store.schedules[0].red1).toBe(111)
      expect(store.schedules[0].blue2).toBe(444)
      expect(store.schedules[0].scoreRedFinal).toBe(120)
      expect(store.schedules[0].scoreBlueFinal).toBe(95)
      expect(store.schedules[1].scoreRedFinal).toBeNull()
    })
  })

  describe('Selection State (Mouse Drag & Wheel Multi-select)', () => {
    beforeEach(() => {
      const store = useScheduleStore()
      store.schedules = [
        { eventId: 'e1', matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 1, red2: 2, blue1: 3, blue2: 4 },
        { eventId: 'e1', matchNumber: 2, tournamentLevel: 'QUALIFICATION', red1: 5, red2: 6, blue1: 7, blue2: 8 },
        { eventId: 'e1', matchNumber: 3, tournamentLevel: 'QUALIFICATION', red1: 9, red2: 10, blue1: 11, blue2: 12 },
        { eventId: 'e1', matchNumber: 4, tournamentLevel: 'QUALIFICATION', red1: 13, red2: 14, blue1: 15, blue2: 16 }
      ]
    })

    it('supports drag/wheel range selection', () => {
      const store = useScheduleStore()
      expect(store.selectedCount).toBe(0)

      // Start drag at match 2
      store.startDragSelection(2)
      expect(store.isMatchSelected(2)).toBe(true)
      expect(store.selectedCount).toBe(1)

      // Drag / wheel down to match 4
      store.dragSelectMatch(4)
      expect(store.selectedCount).toBe(3)
      expect(store.isMatchSelected(2)).toBe(true)
      expect(store.isMatchSelected(3)).toBe(true)
      expect(store.isMatchSelected(4)).toBe(true)
      expect(store.isMatchSelected(1)).toBe(false)

      store.endDragSelection()
      expect(store.isDraggingSelection).toBe(false)
    })

    it('toggle, selectAll and clearSelection works', () => {
      const store = useScheduleStore()
      store.toggleMatchSelection(1)
      expect(store.isMatchSelected(1)).toBe(true)
      store.toggleMatchSelection(1)
      expect(store.isMatchSelected(1)).toBe(false)

      store.selectAllMatches()
      expect(store.selectedCount).toBe(4)

      store.clearSelection()
      expect(store.selectedCount).toBe(0)
    })
  })

  describe('Assignments & Always Support Leaving Unassigned', () => {
    beforeEach(() => {
      const store = useScheduleStore()
      store.schedules = [
        { eventId: 'e1', matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 100, red2: 200, blue1: 300, blue2: 400 },
        { eventId: 'e1', matchNumber: 2, tournamentLevel: 'QUALIFICATION', red1: 500, red2: 600, blue1: 700, blue2: 800 }
      ]
    })

    it('assigns scout to a station and unassigns by passing null', async () => {
      const store = useScheduleStore()
      await store.assignStation('e1', 1, 'red1', 'scout-1', 'Alice', 100)

      const assign1 = store.getStationAssignment(1, 'red1')
      expect(assign1?.scoutId).toBe('scout-1')
      expect(assign1?.scoutName).toBe('Alice')

      // Always support unassigned (leave blank)
      await store.assignStation('e1', 1, 'red1', null, null, 100)
      const assignAfter = store.getStationAssignment(1, 'red1')
      expect(assignAfter?.scoutId).toBeNull()
      expect(assignAfter?.scoutName).toBeNull()
    })

    it('batch assigns selected matches to all stations or specific station', async () => {
      const store = useScheduleStore()
      store.selectedMatches.add(1)
      store.selectedMatches.add(2)

      // Batch assign all 4 stations in matches 1 and 2 to Bob
      await store.batchAssignSelected('e1', 'all', 'scout-2', 'Bob')
      expect(store.getStationAssignment(1, 'red1')?.scoutName).toBe('Bob')
      expect(store.getStationAssignment(1, 'blue2')?.scoutName).toBe('Bob')
      expect(store.getStationAssignment(2, 'red2')?.scoutName).toBe('Bob')

      // Batch unassign (leave blank) for station red1 in selected matches
      await store.batchAssignSelected('e1', 'red1', null, null)
      expect(store.getStationAssignment(1, 'red1')?.scoutId).toBeNull()
      // Other stations retain Bob
      expect(store.getStationAssignment(1, 'red2')?.scoutName).toBe('Bob')
      expect(store.getStationAssignment(2, 'red1')?.scoutId).toBeNull()
    })
  })

  describe('Full Sync and Delta WebRTC synchronization', () => {
    it('applies schedule full sync and single assignment update correctly', () => {
      const store = useScheduleStore()
      const remoteSchedules = [
        { eventId: 'e1', matchNumber: 1, tournamentLevel: 'QUALIFICATION' as const, red1: 1, red2: 2, blue1: 3, blue2: 4 }
      ]
      const remoteAssignments = [
        {
          eventId: 'e1',
          matchNumber: 1,
          tournamentLevel: 'QUALIFICATION' as const,
          station: 'red1' as const,
          teamNumber: 1,
          scoutId: 's-remote',
          scoutName: 'Charlie'
        }
      ]

      store.applyScheduleFullSync(remoteSchedules, remoteAssignments)
      expect(store.schedules).toHaveLength(1)
      expect(store.getStationAssignment(1, 'red1')?.scoutName).toBe('Charlie')

      // Delta update
      store.applyAssignmentUpdate({
        eventId: 'e1',
        matchNumber: 1,
        tournamentLevel: 'QUALIFICATION',
        station: 'red2',
        teamNumber: 2,
        scoutId: 's-delta',
        scoutName: 'Diana'
      })
      expect(store.getStationAssignment(1, 'red2')?.scoutName).toBe('Diana')
    })
  })

  describe('Deduplication and Type Resilience', () => {
    it('deduplicates schedule items with mixed string and number match numbers', async () => {
      const store = useScheduleStore()
      // Simulate initial schedule
      await store.importSchedules('e1', [
        { eventId: 'e1', matchNumber: 1, red1: 101, red2: 102, blue1: 103, blue2: 104 },
        { eventId: 'e1', matchNumber: 2, red1: 201, red2: 202, blue1: 203, blue2: 204 }
      ], true, false)

      // Append with duplicates, some with string matchNumber
      await store.importSchedules('e1', [
        { eventId: 'e1', matchNumber: '2' as any, red1: 201, red2: 202, blue1: 203, blue2: 204, scoreRedFinal: 80, scoreBlueFinal: 90 },
        { eventId: 'e1', matchNumber: 3, red1: 301, red2: 302, blue1: 303, blue2: 304 }
      ], false, false)

      // Match 2 must NOT be duplicated!
      expect(store.schedules).toHaveLength(3)
      expect(store.sortedSchedules).toHaveLength(3)
      expect(store.sortedSchedules.map((s) => s.matchNumber)).toEqual([1, 2, 3])
      expect(store.sortedSchedules[1].scoreRedFinal).toBe(80)

      // Selection toggle works with numeric or string matchNumber
      store.toggleMatchSelection(2)
      expect(store.isMatchSelected(2)).toBe(true)
      expect(store.isMatchSelected('2' as any)).toBe(true)

      store.toggleMatchSelection('2' as any)
      expect(store.isMatchSelected(2)).toBe(false)
    })
  })
})
