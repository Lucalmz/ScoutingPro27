import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import RankingsTable from '@/components/rankings/RankingsTable.vue'
import { useEventStore } from '@/stores/events'
import { useNavigationStore } from '@/stores/navigation'
import { useRecordStore } from '@/stores/records'
import * as api from '@/services/api'
import zh from '@/locales/zh.json'
import en from '@/locales/en.json'
import type { AdvancementDetail } from '@/types'

const mockRouterPush = vi.fn()
const mockRouterBack = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    back: mockRouterBack
  }),
  useRoute: () => ({
    params: { eventId: 'evt-123' },
    query: {}
  }),
  onBeforeRouteLeave: vi.fn()
}))

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    listRecords: vi.fn().mockResolvedValue([]),
    syncRecords: vi.fn().mockResolvedValue(undefined),
    fetchFtcMatches: vi.fn().mockResolvedValue([]),
    fetchFtcRankings: vi.fn().mockResolvedValue([]),
    fetchFtcAdvancement: vi.fn().mockResolvedValue([]),
    apiFetchBannedTeams: vi.fn().mockResolvedValue([]),
    fetchEventTags: vi.fn().mockResolvedValue([])
  }
})

function createTestI18n(locale: 'zh' | 'en' = 'en') {
  return createI18n({
    legacy: false,
    locale,
    messages: { zh, en }
  })
}

describe('RankingsTable Integration', () => {
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
    vi.clearAllMocks()
    vi.mocked(api.listRecords).mockResolvedValue([])
    vi.mocked(api.fetchFtcMatches).mockResolvedValue([])
    vi.mocked(api.fetchFtcRankings).mockResolvedValue([])
    vi.mocked(api.fetchFtcAdvancement).mockResolvedValue([])
    vi.mocked(api.apiFetchBannedTeams).mockResolvedValue([])
    vi.mocked(api.fetchEventTags).mockResolvedValue([])
  })

  afterEach(() => {
    while (mountedWrappers.length > 0) {
      mountedWrappers.pop()?.unmount()
    }
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('viewTeamDetails records position in navStore and pushes to team detail', async () => {
    const navStore = useNavigationStore()
    const eventStore = useEventStore()
    eventStore.setCurrentEvent({
      id: 'evt-123',
      name: 'Championship 2026',
      inviteCode: 'TEST26',
      hostId: 'host-1'
    })

    const sampleRankings = [
      {
        teamNumber: 27570,
        matchCount: 5,
        brokenCount: 0,
        avgAutoScore: 30,
        avgTeleopScore: 50,
        avgEndgameScore: 20,
        maxScore: 110,
        avgRating: 100,
        trend: 'up' as const
      }
    ]

    const wrapper = track(
      mount(RankingsTable, {
        props: {
          rankings: sampleRankings,
          loading: false
        },
        global: {
          plugins: [createTestI18n('en')]
        }
      })
    )

    expect(wrapper.find('.rankings-panel').exists()).toBe(true)
    expect(wrapper.find('table').exists()).toBe(true)
    expect(wrapper.find('[data-team-row="27570"]').exists()).toBe(true)

    const detailsBtn = wrapper.find('.details-btn')
    expect(detailsBtn.exists()).toBe(true)
    await detailsBtn.trigger('click')

    const saved = navStore.getEventPosition('evt-123')
    expect(saved).not.toBeNull()
    expect(saved?.fromTab).toBe('rankings')
    expect(saved?.teamNumber).toBe(27570)
    expect(mockRouterPush).toHaveBeenCalledWith('/event/evt-123/team/27570')
  })

  it('clicking .team-cell navigates to team detail view', async () => {
    const eventStore = useEventStore()
    eventStore.setCurrentEvent({
      id: 'evt-123',
      name: 'Championship 2026',
      inviteCode: 'TEST26',
      hostId: 'host-1'
    })

    const wrapper = track(
      mount(RankingsTable, {
        props: {
          rankings: [
            {
              teamNumber: 27570,
              matchCount: 5,
              brokenCount: 0,
              avgAutoScore: 30,
              avgTeleopScore: 50,
              avgEndgameScore: 20,
              maxScore: 100,
              avgRating: 90,
              trend: 'up'
            }
          ],
          loading: false
        },
        global: {
          plugins: [createTestI18n('en')]
        }
      })
    )

    const teamCell = wrapper.find('.team-cell')
    expect(teamCell.exists()).toBe(true)
    await teamCell.trigger('click')

    expect(mockRouterPush).toHaveBeenCalledWith('/event/evt-123/team/27570')
  })

  it('removes tags from rows while preserving tag filtering bar', async () => {
    const recordStore = useRecordStore()
    recordStore.teamTags = [
      { id: 't1', teamNumber: 27570, tag: 'Fast', color: 'green', isPreset: false, eventId: 'evt-123' },
      { id: 't2', teamNumber: 9999, tag: 'Defense', color: 'red', isPreset: false, eventId: 'evt-123' }
    ] as any

    const i18nInstance = createTestI18n('en')
    const wrapper = track(
      mount(RankingsTable, {
        props: {
          rankings: [
            { teamNumber: 27570, matchCount: 5, brokenCount: 0, avgAutoScore: 30, avgTeleopScore: 50, avgEndgameScore: 20, maxScore: 100, avgRating: 90, trend: 'up' },
            { teamNumber: 9999, matchCount: 4, brokenCount: 1, avgAutoScore: 20, avgTeleopScore: 40, avgEndgameScore: 10, maxScore: 80, avgRating: 70, trend: 'down' }
          ],
          loading: false
        },
        global: {
          plugins: [i18nInstance]
        }
      })
    )

    expect(wrapper.find('.row-tags-list').exists()).toBe(false)
    expect(wrapper.find('.row-tag-badge').exists()).toBe(false)

    const filterBar = wrapper.find('.tag-filter-bar')
    expect(filterBar.exists()).toBe(true)

    const chips = wrapper.findAll('.filter-chip')
    expect(chips.length).toBe(3)

    expect(wrapper.find('[data-team-row="27570"]').exists()).toBe(true)
    expect(wrapper.find('[data-team-row="9999"]').exists()).toBe(true)

    const fastChip = chips.find((c) => c.text().includes('Fast'))
    expect(fastChip).toBeDefined()
    await fastChip!.trigger('click')

    expect(wrapper.find('[data-team-row="27570"]').exists()).toBe(true)
    expect(wrapper.find('[data-team-row="9999"]').exists()).toBe(false)

    const allChip = chips.find((c) => c.text().includes('All') || c.text().includes(en.tags.all))
    expect(allChip).toBeDefined()
    await allChip!.trigger('click')
    expect(wrapper.find('[data-team-row="27570"]').exists()).toBe(true)
    expect(wrapper.find('[data-team-row="9999"]').exists()).toBe(true)
  })

  it('renders advancement column, supports sorting/tiebreakers/roll-down badges, and updates across locales', async () => {
    const store = useRecordStore()
    const i18nInstance = createTestI18n('zh')

    const mockAdvancement: AdvancementDetail[] = [
      {
        teamNumber: 27570,
        advancementRank: 1,
        totalAdvancementPoints: 136,
        qualRank: 1,
        qualPoints: 16,
        alliancePoints: 20,
        playoffPoints: 40,
        awardPoints: 60,
        advancementStatus: 'ADVANCING',
        breakdown: { qualPoints: 16, alliancePoints: 20, playoffPoints: 40, awardPoints: 60 }
      },
      {
        teamNumber: 11115,
        advancementRank: 2,
        totalAdvancementPoints: 73,
        qualRank: 2,
        qualPoints: 13,
        alliancePoints: 20,
        playoffPoints: 40,
        awardPoints: 0,
        advancementStatus: 'ADVANCING',
        breakdown: { qualPoints: 13, alliancePoints: 20, playoffPoints: 40, awardPoints: 0 }
      },
      {
        teamNumber: 8417,
        advancementRank: 3,
        totalAdvancementPoints: 41,
        qualRank: 3,
        qualPoints: 10,
        alliancePoints: 19,
        playoffPoints: 0,
        awardPoints: 12,
        advancementStatus: 'BUBBLE',
        breakdown: { qualPoints: 10, alliancePoints: 19, playoffPoints: 0, awardPoints: 12 }
      }
    ]

    vi.mocked(api.listRecords).mockResolvedValue([
      {
        id: 'rec-1',
        eventId: 'evt-test',
        matchNumber: 1,
        teamNumber: 27570,
        scoutId: 'scout-1',
        scoutName: 'Lead Scout',
        autoScore: 35,
        teleopScore: 70,
        endgameScore: 25,
        totalScore: 130,
        rawData: JSON.stringify({ autoBalls: 2, teleopCycles: [4, 4] }),
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-11-15T00:00:00Z',
        updatedAt: '2026-11-15T00:00:00Z'
      },
      {
        id: 'rec-2',
        eventId: 'evt-test',
        matchNumber: 1,
        teamNumber: 11115,
        scoutId: 'scout-1',
        scoutName: 'Lead Scout',
        autoScore: 20,
        teleopScore: 50,
        endgameScore: 15,
        totalScore: 85,
        rawData: JSON.stringify({ autoBalls: 1, teleopCycles: [3, 3] }),
        syncStatus: 'SYNCED',
        version: 1,
        createdAt: '2026-11-15T00:00:00Z',
        updatedAt: '2026-11-15T00:00:00Z'
      }
    ] as any)

    vi.mocked(api.fetchFtcAdvancement).mockResolvedValue(mockAdvancement)

    await store.fetchRecords('evt-test', 2026, 'CNCMPLB')

    expect(api.fetchFtcAdvancement).toHaveBeenCalledWith(2026, 'CNCMPLB')
    expect(store.rankings.length).toBeGreaterThanOrEqual(2)

    const team27570 = store.rankings.find((r) => r.teamNumber === 27570)
    expect(team27570?.advancementPoints).toBe(136)
    expect(team27570?.advancementStatus).toBe('ADVANCING')

    const wrapper = track(
      mount(RankingsTable, {
        props: {
          rankings: store.rankings,
          loading: false
        },
        global: {
          plugins: [i18nInstance]
        }
      })
    )

    const firstHeader = wrapper.find('thead th:first-child')
    expect(firstHeader.exists()).toBe(true)
    expect(firstHeader.text()).toContain('晋级分')
    expect(firstHeader.classes()).toContain('advancement-col-th')

    const secondHeader = wrapper.find('thead th:nth-child(2)')
    expect(secondHeader.exists()).toBe(true)
    expect(secondHeader.text()).toContain('队伍')

    const row27570 = wrapper.find('[data-team-row="27570"]')
    expect(row27570.exists()).toBe(true)
    const firstCell = row27570.find('td:first-child')
    expect(firstCell.classes()).toContain('advancement-cell')
    expect(firstCell.text()).toContain('136')
    expect(firstCell.text()).toContain('晋级区')

    const initialRows = wrapper.findAll('.ranking-row')
    expect(initialRows[0].find('.team-num').text()).toBe('27570')

    await firstHeader.trigger('click')
    const rowsAsc = wrapper.findAll('.ranking-row')
    expect(rowsAsc[0].find('.team-num').text()).toBe('8417')

    await firstHeader.trigger('click')
    const rowsDesc = wrapper.findAll('.ranking-row')
    expect(rowsDesc[0].find('.team-num').text()).toBe('27570')

    const updatedAdvancement: AdvancementDetail[] = [
      { ...mockAdvancement[1], totalAdvancementPoints: 160 },
      mockAdvancement[0],
      mockAdvancement[2]
    ]
    vi.mocked(api.fetchFtcAdvancement).mockResolvedValue(updatedAdvancement)
    await store.refreshAdvancement(2026, 'CNCMPLB')
    await wrapper.setProps({ rankings: store.rankings })
    expect(wrapper.find('[data-team-row="11115"] td:first-child').text()).toContain('160')

    const tiedAdvancement: AdvancementDetail[] = [
      { ...mockAdvancement[0], totalAdvancementPoints: 100, advancementRank: 1 },
      { ...mockAdvancement[1], totalAdvancementPoints: 100, advancementRank: 2 }
    ]
    vi.mocked(api.fetchFtcAdvancement).mockResolvedValue(tiedAdvancement)
    await store.refreshAdvancement(2026, 'CNCMPLB')
    await wrapper.setProps({ rankings: store.rankings })

    const rowsTied = wrapper.findAll('.ranking-row')
    expect(rowsTied[0].find('.team-num').text()).toBe('27570')
    expect(rowsTied[1].find('.team-num').text()).toBe('11115')

    expect(localStorage.getItem('scoutingpro_advancement')).toContain('27570')

    const unrankedRow: any = {
      teamNumber: 9999,
      matchCount: 1,
      advancementPoints: 0,
      advancementStatus: 'NONE',
      avgAutoScore: 10,
      avgTeleopScore: 20,
      avgEndgameScore: 5,
      avgRating: 35
    }
    await wrapper.setProps({ rankings: [...store.rankings, unrankedRow] })
    const row9999 = wrapper.find('[data-team-row="9999"]')
    expect(row9999.exists()).toBe(true)
    expect(row9999.find('.advancement-status-badge').exists()).toBe(false)

    const rollDownAdvancement: AdvancementDetail[] = [
      {
        ...mockAdvancement[0],
        advancementStatus: 'ALREADY_ADVANCING',
        officialStatus: 'ALREADY_ADVANCING',
        rolledDown: false,
        advancementSlot: 1,
        advancesTo: 'AUCMP'
      },
      {
        ...mockAdvancement[1],
        advancementStatus: 'ADVANCING',
        officialStatus: 'FIRST',
        rolledDown: true,
        advancementSlot: 2,
        advancesTo: 'AUCMP'
      },
      {
        ...mockAdvancement[2],
        advancementStatus: 'DECLINED',
        declined: true,
        rolledDown: false,
        advancementSlot: 3
      }
    ]
    vi.mocked(api.fetchFtcAdvancement).mockResolvedValue(rollDownAdvancement)
    await store.refreshAdvancement(2026, 'CNCMPLB')
    await wrapper.setProps({ rankings: store.rankings })

    expect(wrapper.find('[data-team-row="27570"] td:first-child').text()).toContain('已保送')
    expect(wrapper.find('[data-team-row="27570"] .advancement-status-badge').classes()).toContain('status-already_advancing')
    expect(wrapper.find('[data-team-row="11115"] td:first-child').text()).toContain('顺延晋级')
    expect(wrapper.find('[data-team-row="11115"] .advancement-status-badge').classes()).toContain('is-rolled-down')
    expect(wrapper.find('[data-team-row="8417"] td:first-child').text()).toContain('已放弃')

    i18nInstance.global.locale.value = 'en'
    await nextTick()
    expect(firstHeader.text()).toContain('Adv. Pts')
    expect(wrapper.find('[data-team-row="27570"] td:first-child').text()).toContain('PRE-QUAL')
    expect(wrapper.find('[data-team-row="11115"] td:first-child').text()).toContain('ROLLED DOWN')
    expect(wrapper.find('[data-team-row="8417"] td:first-child').text()).toContain('DECLINED')
  })

  it('renders minCycles and cycleVariance columns, formats empty values, and supports sorting', async () => {
    const i18nInstance = createI18n({
      legacy: false,
      locale: 'zh',
      messages: { zh, en }
    })

    const rows: RankingRow[] = [
      {
        teamNumber: 101,
        matchCount: 3,
        avgAutoScore: 10,
        avgTeleopScore: 20,
        avgEndgameScore: 5,
        maxScore: 40,
        avgRating: 35,
        brokenCount: 0,
        trend: 'stable',
        minCycles: 3,
        cycleVariance: 2.7
      },
      {
        teamNumber: 102,
        matchCount: 3,
        avgAutoScore: 12,
        avgTeleopScore: 24,
        avgEndgameScore: 5,
        maxScore: 45,
        avgRating: 41,
        brokenCount: 0,
        trend: 'up',
        minCycles: 5,
        cycleVariance: 0.2
      },
      {
        teamNumber: 103,
        matchCount: 1,
        avgAutoScore: 0,
        avgTeleopScore: 0,
        avgEndgameScore: 0,
        maxScore: 0,
        avgRating: 0,
        brokenCount: 1,
        trend: 'new',
        minCycles: null,
        cycleVariance: null
      }
    ]

    const wrapper = track(
      mount(RankingsTable, {
        props: {
          rankings: rows,
          loading: false
        },
        global: {
          plugins: [i18nInstance]
        }
      })
    )

    const headers = wrapper.findAll('thead th')
    const minCyclesTh = headers.find((h) => h.text().includes('最低 Cycle 数'))
    const cycleVarianceTh = headers.find((h) => h.text().includes('Cycle 数方差'))
    expect(minCyclesTh).toBeDefined()
    expect(cycleVarianceTh).toBeDefined()

    const minCyclesIdx = headers.indexOf(minCyclesTh!)
    const cycleVarianceIdx = headers.indexOf(cycleVarianceTh!)

    const row101Cells = wrapper.find('[data-team-row="101"]').findAll('td')
    const row103Cells = wrapper.find('[data-team-row="103"]').findAll('td')
    expect(row101Cells[minCyclesIdx]?.text()).toBe('3')
    expect(row101Cells[cycleVarianceIdx]?.text()).toBe('2.7')
    expect(row103Cells[minCyclesIdx]?.text()).toBe('-')
    expect(row103Cells[cycleVarianceIdx]?.text()).toBe('-')

    // Sort by minCycles (first click -> desc: 102 (5), 101 (3), 103 (null at bottom))
    await minCyclesTh!.trigger('click')
    let orderedTeams = wrapper.findAll('tr[data-team-row]').map((tr) => tr.attributes('data-team-row'))
    expect(orderedTeams).toEqual(['102', '101', '103'])

    // Sort by cycleVariance (first click -> asc: 102 (0.2), 101 (2.7), 103 (null at bottom))
    await cycleVarianceTh!.trigger('click')
    orderedTeams = wrapper.findAll('tr[data-team-row]').map((tr) => tr.attributes('data-team-row'))
    expect(orderedTeams).toEqual(['102', '101', '103'])

    // Second click on cycleVariance -> desc: 101 (2.7), 102 (0.2), 103 (null at bottom)
    await cycleVarianceTh!.trigger('click')
    orderedTeams = wrapper.findAll('tr[data-team-row]').map((tr) => tr.attributes('data-team-row'))
    expect(orderedTeams).toEqual(['101', '102', '103'])

    // Locale switch check
    i18nInstance.global.locale.value = 'en'
    await nextTick()
    expect(minCyclesTh!.text()).toContain('Min Cycles')
    expect(cycleVarianceTh!.text()).toContain('Cycle Variance')
  })
})
