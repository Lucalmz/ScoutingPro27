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

  describe('Composite Keys and Multi-Level Isolation', () => {
    it('toggleMatchSelection and isMatchSelected isolate by tournamentLevel', () => {
      const store = useScheduleStore()

      store.toggleMatchSelection(1, 'QUALIFICATION')
      store.toggleMatchSelection(1, 'PLAYOFF')

      expect(store.isMatchSelected(1, 'QUALIFICATION')).toBe(true)
      expect(store.isMatchSelected(1, 'PLAYOFF')).toBe(true)
      expect(store.selectedCount).toBe(2)

      // Toggle off QUALIFICATION_1
      store.toggleMatchSelection(1, 'QUALIFICATION')
      expect(store.isMatchSelected(1, 'QUALIFICATION')).toBe(false)
      expect(store.isMatchSelected(1, 'PLAYOFF')).toBe(true)
      expect(store.selectedCount).toBe(1)
    })

    it('batchAssignSelected isolates playoff and qualification matches on identical match numbers', async () => {
      const store = useScheduleStore()
      store.schedules = [
        { id: 'q1', eventId: 'e1', matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 111, red2: 112, blue1: 113, blue2: 114 },
        { id: 'p1', eventId: 'e1', matchNumber: 1, tournamentLevel: 'PLAYOFF', red1: 991, red2: 992, blue1: 993, blue2: 994 }
      ]

      store.selectedMatches.clear()
      store.toggleMatchSelection(1, 'PLAYOFF')

      await store.batchAssignSelected('e1', 'red1', 'scout_playoff', 'Playoff Scout', 'PLAYOFF')

      const playoffAssign = store.getStationAssignment(1, 'red1', 'PLAYOFF')
      expect(playoffAssign).toBeDefined()
      expect(playoffAssign?.scoutId).toBe('scout_playoff')
      expect(playoffAssign?.teamNumber).toBe(991)

      const qualAssign = store.getStationAssignment(1, 'red1', 'QUALIFICATION')
      expect(qualAssign?.scoutId).toBeUndefined()
    })

    it('myAssignments correctly associates match schedules across different tournament levels', () => {
      const store = useScheduleStore()
      store.schedules = [
        { id: 'q1', eventId: 'e1', matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 111, red2: 112, blue1: 113, blue2: 114 },
        { id: 'p1', eventId: 'e1', matchNumber: 1, tournamentLevel: 'PLAYOFF', red1: 991, red2: 992, blue1: 993, blue2: 994 }
      ]

      store.assignments = {
        'QUALIFICATION_1_red1': {
          id: 'a1',
          eventId: 'e1',
          matchNumber: 1,
          tournamentLevel: 'QUALIFICATION',
          station: 'red1',
          teamNumber: 111,
          scoutId: 'scout_multi',
          scoutName: 'Multi Scout'
        },
        'PLAYOFF_1_blue2': {
          id: 'a2',
          eventId: 'e1',
          matchNumber: 1,
          tournamentLevel: 'PLAYOFF',
          station: 'blue2',
          teamNumber: 994,
          scoutId: 'scout_multi',
          scoutName: 'Multi Scout'
        }
      }

      const assigned = store.myAssignments('scout_multi')
      expect(assigned).toHaveLength(2)

      const qualItem = assigned.find((a) => a.assignment.tournamentLevel === 'QUALIFICATION')
      expect(qualItem).toBeDefined()
      expect(qualItem?.schedule?.red1).toBe(111)

      const playoffItem = assigned.find((a) => a.assignment.tournamentLevel === 'PLAYOFF')
      expect(playoffItem).toBeDefined()
      expect(playoffItem?.schedule?.blue2).toBe(994)
    })

    it('myAssignments sorts qualification matches before playoff matches chronologically', () => {
      const store = useScheduleStore()
      store.schedules = [
        { id: 'q1', eventId: 'e1', matchNumber: 1, tournamentLevel: 'QUALIFICATION', red1: 111, red2: 112, blue1: 113, blue2: 114 },
        { id: 'q2', eventId: 'e1', matchNumber: 2, tournamentLevel: 'QUALIFICATION', red1: 211, red2: 212, blue1: 213, blue2: 214 },
        { id: 'p1', eventId: 'e1', matchNumber: 1, tournamentLevel: 'PLAYOFF', red1: 991, red2: 992, blue1: 993, blue2: 994 }
      ]

      store.assignments = {
        'QUALIFICATION_1_red1': {
          id: 'a_q1',
          eventId: 'e1',
          matchNumber: 1,
          tournamentLevel: 'QUALIFICATION',
          station: 'red1',
          teamNumber: 111,
          scoutId: 'scout_order',
          scoutName: 'Order Scout'
        },
        'QUALIFICATION_2_red1': {
          id: 'a_q2',
          eventId: 'e1',
          matchNumber: 2,
          tournamentLevel: 'QUALIFICATION',
          station: 'red1',
          teamNumber: 211,
          scoutId: 'scout_order',
          scoutName: 'Order Scout'
        },
        'PLAYOFF_1_red1': {
          id: 'a_p1',
          eventId: 'e1',
          matchNumber: 1,
          tournamentLevel: 'PLAYOFF',
          station: 'red1',
          teamNumber: 991,
          scoutId: 'scout_order',
          scoutName: 'Order Scout'
        }
      }

      const assigned = store.myAssignments('scout_order')
      expect(assigned).toHaveLength(3)
      // Chronological order MUST be: Q1, Q2, then P1 (not Q1, P1, Q2)
      expect(assigned.map(a => `${a.assignment.tournamentLevel}_${a.matchNumber}`)).toEqual([
        'QUALIFICATION_1',
        'QUALIFICATION_2',
        'PLAYOFF_1'
      ])
    })
  })
})
