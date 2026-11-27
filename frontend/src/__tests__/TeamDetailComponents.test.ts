import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import TeamPitProfileCard from '@/views/components/TeamPitProfileCard.vue'
import TeamRosterCard from '@/components/pit/TeamRosterCard.vue'
import TeamCustomMetricsCard from '@/views/components/TeamCustomMetricsCard.vue'
import RankingsTableToolbar from '@/components/rankings/RankingsTableToolbar.vue'
import TeamDetailDrawer from '@/components/common/TeamDetailDrawer.vue'
import TeamDetailView from '@/views/TeamDetailView.vue'
import {
  computeTeamMatchCustomMetrics,
  computeTeamFormulaMetrics,
  computeTeamPitCustomSpecs,
  buildMatchCustomBadges
} from '@/views/composables/useTeamCustomMetrics'
import {
  parseCustomFields,
  computeTeamCustomStatsMap,
  useRankingsCustomColumns
} from '@/components/rankings/useRankingsCustomColumns'
import { useEventStore } from '@/stores/events'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useNavigationStore } from '@/stores/navigation'
import zh from '@/locales/zh.json'
import en from '@/locales/en.json'
import type { CustomFieldDefinition, ScoutingRecord, UnifiedTeamItem } from '@/types'

const mockRouterPush = vi.fn()
const mockRouterBack = vi.fn()

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    listRecords: vi.fn().mockResolvedValue([]),
    fetchPitRecords: vi.fn().mockResolvedValue({ records: [], officialTeams: [] }),
    fetchEventTags: vi.fn().mockResolvedValue([]),
    fetchFtcMatches: vi.fn().mockResolvedValue([]),
    fetchFtcRankings: vi.fn().mockResolvedValue([]),
    fetchFtcAdvancement: vi.fn().mockResolvedValue([]),
    apiFetchBannedTeams: vi.fn().mockResolvedValue([])
  }
})

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    back: mockRouterBack
  }),
  useRoute: () => ({
    params: { eventId: 'evt-123', teamNumber: '27570' },
    query: {}
  }),
  onBeforeRouteLeave: vi.fn()
}))

function createTestI18n(locale: 'zh' | 'en' = 'zh') {
  return createI18n({
    legacy: false,
    locale,
    messages: { zh, en }
  })
}

describe('TeamDetail & Rankings Decoupled Sub-components and Composables', () => {
  let mountedWrappers: VueWrapper<any>[] = []

  function track<T extends VueWrapper<any>>(wrapper: T): T {
    mountedWrappers.push(wrapper)
    return wrapper
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    mockRouterPush.mockClear()
    mockRouterBack.mockClear()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    while (mountedWrappers.length > 0) {
      mountedWrappers.pop()?.unmount()
    }
    localStorage.clear()
    sessionStorage.clear()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  const matchFields: CustomFieldDefinition[] = [
    {
      id: 'f-num',
      eventId: 'evt-1',
      target: 'MATCH',
      phase: 'teleop',
      name: '防守拦截次数',
      fieldKey: 'def_blocks',
      fieldType: 'number',
      required: false,
      unit: '次',
      orderSeq: 0,
      isActive: true
    },
    {
      id: 'f-bool',
      eventId: 'evt-1',
      target: 'MATCH',
      phase: 'auto',
      name: '自动避障',
      fieldKey: 'auto_avoid',
      fieldType: 'boolean',
      required: false,
      orderSeq: 1,
      isActive: true
    },
    {
      id: 'f-sel',
      eventId: 'evt-1',
      target: 'MATCH',
      phase: 'endgame',
      name: '挂架位置',
      fieldKey: 'hang_pos',
      fieldType: 'select',
      required: false,
      options: [
        { label: '中心区', value: 'center', color: 'green' },
        { label: '边缘区', value: 'edge', color: 'blue' }
      ],
      orderSeq: 2,
      isActive: true
    },
    {
      id: 'f-txt',
      eventId: 'evt-1',
      target: 'MATCH',
      phase: 'overall',
      name: '观察随笔',
      fieldKey: 'obs_note',
      fieldType: 'text',
      required: false,
      orderSeq: 3,
      isActive: true
    }
  ]

  const records: ScoutingRecord[] = [
    {
      id: 'r1',
      eventId: 'evt-1',
      scoutId: 's1',
      scoutName: 'Scout 1',
      matchNumber: 1,
      teamNumber: 27570,
      autoScore: 10,
      teleopScore: 20,
      endgameScore: 10,
      totalScore: 40,
      notes: '',
      rawData: JSON.stringify({
        customFields: {
          def_blocks: 4,
          auto_avoid: true,
          hang_pos: 'center',
          obs_note: '首局表现极佳'
        }
      }),
      syncStatus: 'SYNCED',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      isBroken: false,
      version: 1
    },
    {
      id: 'r2',
      eventId: 'evt-1',
      scoutId: 's1',
      scoutName: 'Scout 1',
      matchNumber: 2,
      teamNumber: 27570,
      autoScore: 12,
      teleopScore: 24,
      endgameScore: 15,
      totalScore: 51,
      notes: '',
      rawData: JSON.stringify({
        customFields: {
          def_blocks: 8,
          auto_avoid: false,
          hang_pos: 'edge',
          obs_note: '二局稳定输出'
        }
      }),
      syncStatus: 'SYNCED',
      createdAt: '2026-01-01T00:10:00Z',
      updatedAt: '2026-01-01T00:10:00Z',
      isBroken: false,
      version: 1
    }
  ]

  it('computes match custom metrics and renders TeamCustomMetricsCard accurately', () => {
    const metrics = computeTeamMatchCustomMetrics(matchFields, records)
    expect(metrics).toHaveLength(4)

    const numMetric = metrics.find(m => m.definition.fieldKey === 'def_blocks')!
    expect(numMetric.avg).toBe(6)
    expect(numMetric.max).toBe(8)
    expect(numMetric.totalCount).toBe(2)

    const boolMetric = metrics.find(m => m.definition.fieldKey === 'auto_avoid')!
    expect(boolMetric.rate).toBe(50)
    expect(boolMetric.trueCount).toBe(1)

    const wrapper = track(mount(TeamCustomMetricsCard, {
      props: { metrics },
      global: { plugins: [createTestI18n()] }
    }))

    expect(wrapper.find('.custom-metrics-card').exists()).toBe(true)
    expect(wrapper.findAll('.metric-box')).toHaveLength(4)
    expect(wrapper.text()).toContain('6.0')
    expect(wrapper.text()).toContain('50%')
    expect(wrapper.text()).toContain('中心区')
    expect(wrapper.text()).toContain('首局表现极佳')
  })

  it('formats match custom badges and pit custom specs and renders TeamPitProfileCard', async () => {
    const mockT = (key: string) => key
    const badges = buildMatchCustomBadges(matchFields, records[0]!, mockT)
    expect(badges).toHaveLength(4)
    expect(badges[0]!.value).toBe('4 次')
    expect(badges[1]!.value).toBe('✓')
    expect(badges[2]!.value).toBe('中心区')

    const pitFields: CustomFieldDefinition[] = [
      {
        id: 'pf-1',
        eventId: 'evt-1',
        target: 'PIT',
        phase: 'hardware',
        name: '底盘电机数',
        fieldKey: 'motor_count',
        fieldType: 'number',
        required: false,
        unit: '个',
        orderSeq: 0,
        isActive: true
      }
    ]

    const unifiedTeam: UnifiedTeamItem = {
      teamNumber: 27570,
      name: 'CyberBear',
      hasPitRecord: true,
       matchCount: 2,
      avgTotalScore: 45.5,
      maxTotalScore: 51,
      tags: [],
      pitRecord: {
        id: 'pit-1',
        eventId: 'evt-1',
        teamNumber: 27570,
        scoutId: 's1',
        scoutName: 'Scout 1',
        drivetrainType: 'swerve',
        weightLbs: 38,
        chassisSize: '紧凑小车 (≤15")',
        ballCompatibility: 'specialized' as any,
        launcherType: '差速双飞轮',
        flowerMechanism: '垂直级联高抬升',
        hasColorSensor: true,
        hasDescoreMech: true,
        hasApriltagVision: true,
        odometryType: 'three_wheel',
        claimedAutoScore: 15,
        claimedTeleopScore: 30,
        claimedTeleopCycles: 8,
        claimedEndgameScore: 10,
        claimedTotalScore: 55,
        customFields: { motor_count: 4 },
        version: 1,
        syncStatus: 'SYNCED',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z'
      },
      bragInfo: {
        tier: 'realistic',
        label: '1.08x Realistic',
        overallRatio: 1.08,
        autoRatio: 1.1,
        teleopRatio: 1.1,
        endgameRatio: 1.0,
        endgameUnfulfilled: false,
        flowerVerified: true,
        flowerPending: false,
        parkVerified: true,
        parkPending: false
      }
    }

    const pitSpecs = computeTeamPitCustomSpecs(pitFields, unifiedTeam.pitRecord, mockT)
    expect(pitSpecs).toHaveLength(1)
    expect(pitSpecs[0]!.displayValue).toBe('4 个')

    const enI18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: { zh, en }
    })

    const wrapper = track(mount(TeamPitProfileCard, {
      props: {
        unifiedTeam,
        teamPitCustomSpecs: pitSpecs
      },
      global: { plugins: [enI18n] }
    }))

    expect(wrapper.find('.pit-profile-card').exists()).toBe(true)
    expect(wrapper.find('.custom-spec-badge').text()).toContain('底盘电机数: 4 个')
    expect(wrapper.text()).toContain('55')
    expect(wrapper.text()).toContain('51')
    expect(wrapper.text()).toContain('Compact Small (≤15")')
    expect(wrapper.text()).toContain('Specialized Intake / Sorting')
    expect(wrapper.text()).toContain('Dual Flywheel')
    expect(wrapper.text()).toContain('Vertical Cascading Lift')
    expect(wrapper.text()).toContain('Descore: Equipped')
    expect(wrapper.text()).toContain('AprilTag: Equipped')
    expect(wrapper.text()).toContain('End 10')
    expect(wrapper.text()).toContain('Flower Verified')
    expect(wrapper.text()).toContain('Park Verified')

    await wrapper.find('.btn-edit-pit').trigger('click')
    expect(wrapper.emitted('openPitDrawer')).toHaveLength(1)

    // Verify TeamRosterCard V6 fields, te() fallback, and claimed_cycles_unit number interpolation
    const rosterCard = track(mount(TeamRosterCard, {
      props: {
        team: unifiedTeam,
        cardIndex: 0
      },
      global: { plugins: [enI18n] }
    }))
    expect(rosterCard.text()).toContain('Compact Small (≤15")')
    expect(rosterCard.text()).toContain('38 lbs')
    expect(rosterCard.text()).toContain('Specialized Intake / Sorting')
    expect(rosterCard.text()).toContain('Vertical Cascading Lift')
    expect(rosterCard.text()).toContain('Bottom Descore')
    expect(rosterCard.text()).toContain('AprilTag Vision')
    expect(rosterCard.text()).toContain('8 cycles')
    expect(rosterCard.text()).toContain('10 pts')
    expect(rosterCard.text()).toContain('Flower Verified')
    expect(rosterCard.text()).toContain('Park Verified')
  })

  it('manages custom column visibility and persistence via useRankingsCustomColumns & RankingsTableToolbar', async () => {
    expect(parseCustomFields(records[0]!)).toEqual({
      def_blocks: 4,
      auto_avoid: true,
      hang_pos: 'center',
      obs_note: '首局表现极佳'
    })

    const statsMap = computeTeamCustomStatsMap(records, matchFields)
    const teamStats = statsMap.get(27570)!
    expect(teamStats.def_blocks.display).toBe('6.0')
    expect(teamStats.auto_avoid.display).toBe('50%')

    const eventStore = useEventStore()
    eventStore.currentEvent = { id: 'evt-1', name: 'Test Event', inviteCode: 'EVT1', hostId: 'u-host' }
    const cfStore = useCustomFieldsStore()
    cfStore.fieldsByEvent['evt-1'] = matchFields

    const {
      availableCustomFields,
      selectedCustomKeys,
      visibleCustomFields,
      showCustomColsDropdown,
      toggleCustomCol,
      selectAllCustomCols,
      clearAllCustomCols
    } = useRankingsCustomColumns()

    // Numeric, level, and boolean fields are available for table columns
    expect(availableCustomFields.value).toHaveLength(2)

    selectAllCustomCols()
    expect(selectedCustomKeys.value).toEqual(['def_blocks', 'auto_avoid'])
    expect(visibleCustomFields.value).toHaveLength(2)

    toggleCustomCol('def_blocks')
    expect(selectedCustomKeys.value).toEqual(['auto_avoid'])

    clearAllCustomCols()
    expect(selectedCustomKeys.value).toHaveLength(0)

    const toolbar = track(mount(RankingsTableToolbar, {
      props: {
        availableFilterTags: ['高频得分', '铁壁防守'],
        selectedTagFilter: '高频得分',
        availableCustomFields: availableCustomFields.value,
        visibleCustomFields: visibleCustomFields.value,
        selectedCustomKeys: selectedCustomKeys.value,
        showCustomColsDropdown: true
      },
      global: { plugins: [createTestI18n()] }
    }))

    const filterChips = toolbar.findAll('.filter-chip')
    // 0 = All, 1 = 高频得分, 2 = 铁壁防守
    expect(filterChips).toHaveLength(3)
    await filterChips[2]!.trigger('click')
    expect(toolbar.emitted('update:selectedTagFilter')?.[0]).toEqual(['铁壁防守'])

    const headerLinks = toolbar.findAll('.btn-link')
    await headerLinks[0]!.trigger('click')
    expect(toolbar.emitted('selectAllCustomCols')).toHaveLength(1)
    await headerLinks[1]!.trigger('click')
    expect(toolbar.emitted('clearAllCustomCols')).toHaveLength(1)

    showCustomColsDropdown.value = false
  })

  it('TeamDetailDrawer goFullDetail records AI tab position in navStore', () => {
    const navStore = useNavigationStore()
    track(
      mount(TeamDetailDrawer, {
        props: {
          teamNumber: 27570,
          eventId: 'evt-ai-test'
        },
        global: {
          plugins: [createTestI18n('en')]
        },
        attachTo: document.body
      })
    )

    const fullDetailBtn = document.body.querySelector('.btn-full-detail') as HTMLElement | null
    expect(fullDetailBtn).not.toBeNull()
    fullDetailBtn?.click()

    const saved = navStore.getEventPosition('evt-ai-test')
    expect(saved).not.toBeNull()
    expect(saved?.fromTab).toBe('ai')
    expect(saved?.teamNumber).toBe(27570)
    expect(mockRouterPush).toHaveBeenCalledWith('/event/evt-ai-test/team/27570')
  })

  it('TeamDetailView back button triggers back navigation', async () => {
    const wrapper = track(
      mount(TeamDetailView, {
        props: {
          eventId: 'evt-123',
          teamNumber: '27570'
        },
        global: {
          plugins: [createTestI18n('en')]
        }
      })
    )

    const backBtn = wrapper.find('.btn-back')
    expect(backBtn.exists()).toBe(true)
    await backBtn.trigger('click')

    expect(mockRouterBack.mock.calls.length + mockRouterPush.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('computeTeamCustomStatsMap supports timer, weighted select, aggregationMode, MATCH/PIT/TEAM formulas, and tierThresholds', () => {
    const fields: CustomFieldDefinition[] = [
      {
        id: 'f-timer',
        eventId: 'evt-1',
        target: 'MATCH',
        phase: 'teleop',
        name: 'Cycle Stopwatch',
        fieldKey: 'cycle_sw',
        fieldType: 'timer',
        aggregationMode: 'median',
        displayFormat: 'number',
        unit: 's',
        required: false,
        orderSeq: 0,
        isActive: true
      },
      {
        id: 'f-weighted-sel',
        eventId: 'evt-1',
        target: 'MATCH',
        phase: 'endgame',
        name: 'Climb Tier',
        fieldKey: 'climb_tier',
        fieldType: 'select',
        aggregationMode: 'max',
        options: [
          { label: 'Low', value: 'low', numericValue: 5 },
          { label: 'High', value: 'high', numericValue: 20 }
        ],
        required: false,
        orderSeq: 1,
        isActive: true
      },
      {
        id: 'f-match-fx',
        eventId: 'evt-1',
        target: 'MATCH',
        phase: 'overall',
        name: 'Net Efficiency',
        fieldKey: 'net_eff',
        fieldType: 'formula',
        formulaExpr: 'match.totalScore + cf.climb_tier',
        aggregationMode: 'avg',
        displayFormat: 'number',
        required: false,
        orderSeq: 2,
        isActive: true
      },
      {
        id: 'f-team-fx',
        eventId: 'evt-1',
        target: 'TEAM',
        phase: 'overall',
        name: 'OPR Power',
        fieldKey: 'opr_power',
        fieldType: 'formula',
        formulaExpr: 'opr.np + formula.net_eff * 0.1',
        displayFormat: 'number',
        config: { tierThresholds: { high: 50, mid: 30, direction: 'higher_better' } },
        required: false,
        orderSeq: 3,
        isActive: true
      }
    ]

    const testRecords: ScoutingRecord[] = [
      {
        id: 'r1',
        eventId: 'evt-1',
        scoutId: 's1',
        scoutName: 'Scout1',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 10,
        teleopScore: 20,
        endgameScore: 10,
        totalScore: 40,
        notes: '',
        rawData: JSON.stringify({ customFields: { cycle_sw: 4.0, climb_tier: 'low' } }),
        syncStatus: 'SYNCED',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        isBroken: false,
        version: 1
      },
      {
        id: 'r2',
        eventId: 'evt-1',
        scoutId: 's1',
        scoutName: 'Scout1',
        matchNumber: 2,
        teamNumber: 27570,
        autoScore: 10,
        teleopScore: 30,
        endgameScore: 20,
        totalScore: 60,
        notes: '',
        rawData: JSON.stringify({ customFields: { cycle_sw: 6.0, climb_tier: 'high' } }),
        syncStatus: 'SYNCED',
        createdAt: '2026-01-01T00:01:00Z',
        updatedAt: '2026-01-01T00:01:00Z',
        isBroken: false,
        version: 1
      },
      {
        id: 'r3',
        eventId: 'evt-1',
        scoutId: 's1',
        scoutName: 'Scout1',
        matchNumber: 3,
        teamNumber: 27570,
        autoScore: 10,
        teleopScore: 30,
        endgameScore: 10,
        totalScore: 50,
        notes: '',
        rawData: JSON.stringify({ customFields: { cycle_sw: 10.0, climb_tier: 'low' } }),
        syncStatus: 'SYNCED',
        createdAt: '2026-01-01T00:02:00Z',
        updatedAt: '2026-01-01T00:02:00Z',
        isBroken: false,
        version: 1
      }
    ]

    const map = computeTeamCustomStatsMap(testRecords, fields, {
      rankings: [
        {
          teamNumber: 27570,
          matchCount: 3,
          avgAutoScore: 10,
          avgTeleopScore: 26.7,
          avgEndgameScore: 13.3,
          spNpOpr: 45,
          maxScore: 60,
          avgRating: 50,
          brokenCount: 0,
          trend: 'stable'
        }
      ]
    })

    const teamStats = map.get(27570)!
    expect(teamStats.cycle_sw?.value).toBeCloseTo(6.0, 5) // median of [4, 6, 10]
    expect(teamStats.climb_tier?.value).toBeCloseTo(20, 5) // max of [5, 20, 5]
    // net_eff per match: [40+5=45, 60+20=80, 50+5=55] -> avg = 60
    expect(teamStats.net_eff?.value).toBeCloseTo(60, 5)
    // opr_power: 45 + 60 * 0.1 = 51 -> tier high (>= 50)
    expect(teamStats.opr_power?.value).toBeCloseTo(51, 5)
    expect(teamStats.opr_power?.tier).toBe('high')
  })

  it('TeamCustomMetricsCard renders TEAM formula metrics and cyclic error indicator', () => {
    const teamFormulaField: CustomFieldDefinition = {
      id: 'f-team-1',
      eventId: 'evt-1',
      target: 'TEAM',
      phase: 'overall',
      name: 'Combined Index',
      fieldKey: 'combined_idx',
      fieldType: 'formula',
      formulaExpr: 'opr.np * 2',
      displayFormat: 'number',
      required: false,
      orderSeq: 0,
      isActive: true
    }
    const cyclicField: CustomFieldDefinition = {
      id: 'f-team-cyc',
      eventId: 'evt-1',
      target: 'TEAM',
      phase: 'overall',
      name: 'Cyclic Metric',
      fieldKey: 'cyc_a',
      fieldType: 'formula',
      formulaExpr: 'formula.cyc_a + 1',
      displayFormat: 'number',
      required: false,
      orderSeq: 1,
      isActive: true
    }

    const metrics = computeTeamFormulaMetrics([teamFormulaField, cyclicField], {
      rankingRow: { teamNumber: 27570, spNpOpr: 32.5, matchCount: 2, avgAutoScore: 10, avgTeleopScore: 20, avgEndgameScore: 5, maxScore: 40, avgRating: 35, brokenCount: 0, trend: 'stable' },
      matchRecords: []
    })

    const card = track(mount(TeamCustomMetricsCard, {
      props: { metrics },
      global: { plugins: [createTestI18n('en')] }
    }))

    expect(card.text()).toContain('Combined Index')
    expect(card.text()).toContain('65.0')
    expect(card.text()).toContain('Cyclic Metric')
    expect(card.text()).toContain('Circular Dependency')
  })
})
