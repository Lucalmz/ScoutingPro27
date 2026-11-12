import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import TeamPitProfileCard from '@/views/components/TeamPitProfileCard.vue'
import TeamCustomMetricsCard from '@/views/components/TeamCustomMetricsCard.vue'
import RankingsTableToolbar from '@/components/rankings/RankingsTableToolbar.vue'
import {
  computeTeamMatchCustomMetrics,
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
import zh from '@/locales/zh.json'
import en from '@/locales/en.json'
import type { CustomFieldDefinition, ScoutingRecord, UnifiedTeamItem } from '@/types'

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh',
    messages: { zh, en }
  })
}

describe('TeamDetail & Rankings Decoupled Sub-components and Composables', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
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
      sortOrder: 0,
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
      sortOrder: 1,
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
      sortOrder: 2,
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
      sortOrder: 3,
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
      isBroken: false
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
      isBroken: false
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

    const wrapper = mount(TeamCustomMetricsCard, {
      props: { metrics },
      global: { plugins: [createTestI18n()] }
    })

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
        sortOrder: 0,
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
        ballCompatibility: 'universal',
        launcherType: '双飞轮',
        flowerMechanism: '独立机械臂',
        hasColorSensor: true,
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
        label: '1.08x 实事求是',
        overallRatio: 1.08,
        autoRatio: 1.1,
        teleopRatio: 1.1,
        endgameUnfulfilled: false
      }
    }

    const pitSpecs = computeTeamPitCustomSpecs(pitFields, unifiedTeam.pitRecord, mockT)
    expect(pitSpecs).toHaveLength(1)
    expect(pitSpecs[0]!.displayValue).toBe('4 个')

    const wrapper = mount(TeamPitProfileCard, {
      props: {
        unifiedTeam,
        teamPitCustomSpecs: pitSpecs
      },
      global: { plugins: [createTestI18n()] }
    })

    expect(wrapper.find('.pit-profile-card').exists()).toBe(true)
    expect(wrapper.find('.custom-spec-badge').text()).toContain('底盘电机数: 4 个')
    expect(wrapper.text()).toContain('55')
    expect(wrapper.text()).toContain('51')

    await wrapper.find('.btn-edit-pit').trigger('click')
    expect(wrapper.emitted('openPitDrawer')).toHaveLength(1)
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
    eventStore.currentEvent = { id: 'evt-1', name: 'Test Event', code: 'EVT1', date: '2026-01-01', createdAt: '' }
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

    const toolbar = mount(RankingsTableToolbar, {
      props: {
        availableFilterTags: ['高频得分', '铁壁防守'],
        selectedTagFilter: '高频得分',
        availableCustomFields: availableCustomFields.value,
        visibleCustomFields: visibleCustomFields.value,
        selectedCustomKeys: selectedCustomKeys.value,
        showCustomColsDropdown: true
      },
      global: { plugins: [createTestI18n()] }
    })

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
})
