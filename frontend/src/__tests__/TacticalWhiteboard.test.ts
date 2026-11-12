import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zh from '@/locales/zh.json'
import en from '@/locales/en.json'
import {
  fieldToViewCoords,
  viewToFieldCoords,
  distanceToSegment,
  isStrokeHitByEraser,
  hitTestRobotToken,
  createDefaultPhaseRobots,
  useTacticalWhiteboard,
  type FieldRotation,
  type WhiteboardStroke
} from '@/components/whiteboard/useTacticalWhiteboard'
import TacticalWhiteboardView from '@/components/whiteboard/TacticalWhiteboardView.vue'
import { useScheduleStore } from '@/stores/schedule'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import type { MatchScheduleItem, OfficialMatch, ScoutingRecord, PitScoutingRecord } from '@/types'

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn()
  }),
  useRoute: () => ({
    params: { eventId: 'evt-wb-test' },
    query: {}
  })
}))

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh',
    fallbackLocale: 'en',
    messages: { zh, en }
  })
}

describe('Tactical Whiteboard Core Geometry & Hit-Testing', () => {
  it('accurately round-trips fieldToViewCoords and viewToFieldCoords across all rotations and flip states', () => {
    const rotations: FieldRotation[] = [0, 90, 180, 270]
    const flips = [false, true]
    const samplePoints = [
      { x: 0.12, y: 0.34 },
      { x: 0.85, y: 0.19 },
      { x: 0.5, y: 0.5 },
      { x: 0.0, y: 1.0 }
    ]

    for (const rot of rotations) {
      for (const flip of flips) {
        for (const pt of samplePoints) {
          const viewPt = fieldToViewCoords(pt.x, pt.y, rot, flip)
          const backPt = viewToFieldCoords(viewPt.x, viewPt.y, rot, flip)
          expect(backPt.x).toBeCloseTo(pt.x, 6)
          expect(backPt.y).toBeCloseTo(pt.y, 6)
        }
      }
    }
  })

  it('computes distanceToSegment and hit-tests pen, arrow, rect, circle, and text strokes with eraser', () => {
    expect(distanceToSegment(0.5, 0.2, 0.2, 0.2, 0.8, 0.2)).toBeCloseTo(0, 6)
    expect(distanceToSegment(0.5, 0.5, 0.2, 0.2, 0.8, 0.2)).toBeCloseTo(0.3, 6)

    const penStroke: WhiteboardStroke = {
      id: 's-pen',
      type: 'pen',
      color: '#ef4444',
      width: 5,
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.4, y: 0.2 },
        { x: 0.4, y: 0.6 }
      ],
      createdAt: Date.now()
    }
    expect(isStrokeHitByEraser(penStroke, { x: 0.25, y: 0.21 }, 0.03)).toBe(true)
    expect(isStrokeHitByEraser(penStroke, { x: 0.8, y: 0.8 }, 0.03)).toBe(false)

    const rectStroke: WhiteboardStroke = {
      id: 's-rect',
      type: 'rect',
      color: '#3b82f6',
      width: 4,
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.6, y: 0.6 }
      ],
      createdAt: Date.now()
    }
    // Hit top border of rect
    expect(isStrokeHitByEraser(rectStroke, { x: 0.4, y: 0.21 }, 0.03)).toBe(true)
    // Far inside center of hollow rect should not be hit
    expect(isStrokeHitByEraser(rectStroke, { x: 0.4, y: 0.4 }, 0.03)).toBe(false)

    const circleStroke: WhiteboardStroke = {
      id: 's-circle',
      type: 'circle',
      color: '#39ff14',
      width: 4,
      points: [
        { x: 0.5, y: 0.5 },
        { x: 0.7, y: 0.5 }
      ],
      createdAt: Date.now()
    }
    // Point on circumference (radius = 0.2)
    expect(isStrokeHitByEraser(circleStroke, { x: 0.5, y: 0.7 }, 0.03)).toBe(true)
    expect(isStrokeHitByEraser(circleStroke, { x: 0.5, y: 0.5 }, 0.03)).toBe(false)

    const textStroke: WhiteboardStroke = {
      id: 's-text',
      type: 'text',
      color: '#eab308',
      width: 4,
      points: [{ x: 0.3, y: 0.3 }],
      text: 'Block Corridor',
      createdAt: Date.now()
    }
    expect(isStrokeHitByEraser(textStroke, { x: 0.32, y: 0.31 }, 0.03)).toBe(true)
    expect(isStrokeHitByEraser(textStroke, { x: 0.9, y: 0.9 }, 0.03)).toBe(false)
  })

  it('hit-tests robot tokens in top-most render priority order', () => {
    const robots = createDefaultPhaseRobots('auto', {
      red1: 27001,
      red2: 27002,
      blue1: 27003,
      blue2: 27004
    })
    expect(hitTestRobotToken(robots, 0.14, 0.30)).toBe('red1')
    expect(hitTestRobotToken(robots, 0.86, 0.70)).toBe('blue2')
    expect(hitTestRobotToken(robots, 0.50, 0.50)).toBeNull()
  })
})

describe('useTacticalWhiteboard Composable State & Persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  it('automatically populates 4 teams on match selection, supports Undo/Redo, phase robot sync, and localStorage recovery', () => {
    const eventId = ref('evt-wb-1')
    const schedules = ref<MatchScheduleItem[]>([
      {
        eventId: 'evt-wb-1',
        matchNumber: 1,
        tournamentLevel: 'QUALIFICATION',
        red1: 11111,
        red2: 22222,
        blue1: 33333,
        blue2: 44444
      },
      {
        eventId: 'evt-wb-1',
        matchNumber: 2,
        tournamentLevel: 'QUALIFICATION',
        red1: 55555,
        red2: 66666,
        blue1: 77777,
        blue2: 88888
      }
    ])
    const officialMatches = ref<OfficialMatch[]>([])

    const wb = useTacticalWhiteboard({
      eventId,
      schedules,
      officialMatches
    })

    // Auto-selects first match Q1
    expect(wb.selectedMatchKey.value).toBe('QUALIFICATION_1')
    expect(wb.currentTeams.value).toEqual({
      red1: 11111,
      red2: 22222,
      blue1: 33333,
      blue2: 44444
    })

    // Add two strokes in Auto phase and verify Undo/Redo
    wb.addStroke({
      id: 'st-1',
      type: 'arrow',
      color: '#ef4444',
      width: 5,
      points: [
        { x: 0.14, y: 0.3 },
        { x: 0.45, y: 0.45 }
      ],
      createdAt: 1000
    })
    wb.addStroke({
      id: 'st-2',
      type: 'rect',
      color: '#3b82f6',
      width: 5,
      points: [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.6 }
      ],
      createdAt: 1001
    })

    expect(wb.currentPhaseBoard.value.strokes).toHaveLength(2)
    expect(wb.canUndo.value).toBe(true)

    wb.undo()
    expect(wb.currentPhaseBoard.value.strokes).toHaveLength(1)
    expect(wb.canRedo.value).toBe(true)

    wb.redo()
    expect(wb.currentPhaseBoard.value.strokes).toHaveLength(2)

    // Move Red 1 in Auto phase and sync into TeleOp phase
    wb.moveRobotToken('red1', 0.48, 0.52)
    expect(wb.currentPhaseBoard.value.robots.red1.x).toBeCloseTo(0.48, 5)
    expect(wb.currentPhaseBoard.value.robots.red1.y).toBeCloseTo(0.52, 5)

    wb.activePhase.value = 'teleop'
    expect(wb.syncRobotsFromPreviousPhase()).toBe(true)
    expect(wb.currentPhaseBoard.value.robots.red1.x).toBeCloseTo(0.48, 5)
    expect(wb.currentPhaseBoard.value.robots.red1.y).toBeCloseTo(0.52, 5)

    // Set role and verify cross-phase role propagation
    wb.setRobotRole('blue2', 'defense')
    expect(wb.currentPlan.value.phases.auto.robots.blue2.role).toBe('defense')
    expect(wb.currentPlan.value.phases.teleop.robots.blue2.role).toBe('defense')
    expect(wb.currentPlan.value.phases.endgame.robots.blue2.role).toBe('defense')

    // Step to next match Q2 and verify 4 teams update automatically
    wb.stepMatch(1)
    expect(wb.selectedMatchKey.value).toBe('QUALIFICATION_2')
    expect(wb.currentTeams.value).toEqual({
      red1: 55555,
      red2: 66666,
      blue1: 77777,
      blue2: 88888
    })

    // Flush debounced localStorage save and verify reload
    vi.advanceTimersByTime(400)
    const rawSaved = localStorage.getItem('sp27_whiteboard_v1_evt-wb-1')
    expect(rawSaved).toBeTruthy()

    const wbReloaded = useTacticalWhiteboard({
      eventId,
      schedules,
      officialMatches
    })
    expect(wbReloaded.currentPlan.value.phases.auto.strokes).toHaveLength(2)
    expect(wbReloaded.currentPlan.value.phases.auto.robots.blue2.role).toBe('defense')
    vi.useRealTimers()
  })

  it('gracefully recovers when localStorage contains corrupted JSON', () => {
    localStorage.setItem('sp27_whiteboard_v1_evt-corrupt', '{not-valid-json')
    const wb = useTacticalWhiteboard({
      eventId: ref('evt-corrupt'),
      schedules: ref([]),
      officialMatches: ref([])
    })
    expect(wb.selectedMatchKey.value).toBe('CUSTOM')
    expect(wb.currentPhaseBoard.value.strokes).toEqual([])
  })
})

describe('TacticalWhiteboardView Component Integration (Match -> 4 Teams -> Sidebar Detail)', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())

    // Mock HTMLCanvasElement.prototype.getContext for jsdom
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      save: vi.fn(),
      restore: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      arc: vi.fn(),
      rect: vi.fn(),
      roundRect: vi.fn(),
      fillText: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 48 }),
      createLinearGradient: vi.fn().mockReturnValue({
        addColorStop: vi.fn()
      })
    }) as any
  })

  it('renders 4 match teams, switches matches, and shows deep-dive team intel in the sidebar', async () => {
    const scheduleStore = useScheduleStore()
    const recordStore = useRecordStore()
    const pitStore = usePitScoutStore()

    scheduleStore.schedules = [
      {
        eventId: 'evt-wb-test',
        matchNumber: 1,
        tournamentLevel: 'QUALIFICATION',
        red1: 19234,
        red2: 19235,
        blue1: 20401,
        blue2: 20402
      },
      {
        eventId: 'evt-wb-test',
        matchNumber: 2,
        tournamentLevel: 'QUALIFICATION',
        red1: 28881,
        red2: 28882,
        blue1: 29991,
        blue2: 29992
      }
    ]

    const sampleRecord: ScoutingRecord = {
      id: 'rec-19234-q1',
      eventId: 'evt-wb-test',
      matchNumber: 1,
      teamNumber: 19234,
      scoutId: 's-1',
      scoutName: 'Alice',
      isBroken: false,
      notes: 'Fast cycle along left wall',
      rawData: JSON.stringify({
        tournamentLevel: 'QUALIFICATION',
        autoLeave: true,
        teleopPark: true,
        flowerPlaced: true
      }),
      autoScore: 22,
      teleopScore: 34,
      endgameScore: 15,
      totalScore: 71,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncStatus: 'SYNCED',
      version: 1
    }
    recordStore.records = [sampleRecord]

    const samplePit: PitScoutingRecord = {
      id: 'pit-19234',
      eventId: 'evt-wb-test',
      teamNumber: 19234,
      scoutId: 's-1',
      scoutName: 'Alice',
      robotName: 'ViperStrike',
      drivetrainType: 'swerve',
      odometryType: 'pinpoint',
      ballCompatibility: 'universal',
      claimedAutoStrategy: '4 classified + leave',
      claimedAutoScore: 24,
      claimedTeleopScore: 36,
      claimedEndgameScore: 15,
      claimedTotalScore: 75,
      notes: 'Dual intake roller',
      photos: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncStatus: 'SYNCED'
    }
    pitStore.records = [samplePit]

    const wrapper = mount(TacticalWhiteboardView, {
      props: {
        eventId: 'evt-wb-test',
        initialMatch: { matchNumber: 1, tournamentLevel: 'QUALIFICATION' }
      },
      global: {
        plugins: [createTestI18n()]
      }
    })

    await nextTick()

    // Verify all 4 teams from Q1 are automatically displayed
    const html = wrapper.text()
    expect(html).toContain('#19234')
    expect(html).toContain('#19235')
    expect(html).toContain('#20401')
    expect(html).toContain('#20402')

    // Click Red 1 chip in the 4-team quick strip to open Single-Team Deep-Dive in Sidebar
    const quickChips = wrapper.findAll('.wb-strip-pill')
    expect(quickChips.length).toBe(4)
    await quickChips[0]!.trigger('click')
    await nextTick()

    // Verify Sidebar switches to single-team detail mode and shows Pit specs + match stats
    const detailText = wrapper.text()
    expect(detailText).toContain('ViperStrike')
    expect(detailText).toContain('71')
    expect(detailText).toContain('Fast cycle along left wall')
    expect(detailText).toContain('4 classified + leave')

    // Switch to Match Q2 via Next Match button and verify 4 new teams populate automatically
    const nextMatchBtn = wrapper.find('[data-testid="wb-next-match"]')
    expect(nextMatchBtn.exists()).toBe(true)
    await nextMatchBtn.trigger('click')
    await nextTick()

    const q2Text = wrapper.text()
    expect(q2Text).toContain('#28881')
    expect(q2Text).toContain('#28882')
    expect(q2Text).toContain('#29991')
    expect(q2Text).toContain('#29992')
  })
})
