import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'
import RankingsTable from '@/components/rankings/RankingsTable.vue'
import { useRecordStore } from '@/stores/records'
import * as api from '@/services/api'
import zh from '@/locales/zh.json'
import en from '@/locales/en.json'
import type { OfficialMatch, OfficialRanking, AdvancementDetail } from '@/types'

vi.mock('@/services/api', () => ({
  listRecords: vi.fn(),
  syncRecords: vi.fn(),
  fetchFtcMatches: vi.fn(),
  fetchFtcRankings: vi.fn(),
  fetchFtcAdvancement: vi.fn(),
  apiFetchBannedTeams: vi.fn().mockResolvedValue([]),
  fetchEventTags: vi.fn().mockResolvedValue([])
}))

describe('Rankings Table Advancement Column E2E Integration', () => {
  let pinia: any
  let i18nInstance: any

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    localStorage.clear()

    i18nInstance = createI18n({
      legacy: false,
      locale: 'zh',
      messages: { zh, en }
    })
  })

  it('renders "晋级分" in the first column and displays real-time calculated advancement score', async () => {
    const store = useRecordStore()

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
    ])

    vi.mocked(api.fetchFtcMatches).mockResolvedValue([])
    vi.mocked(api.fetchFtcAdvancement).mockResolvedValue(mockAdvancement)

    // 1. Fetch records and advancement from FTC API
    await store.fetchRecords('evt-test', 2026, 'CNCMPLB')

    expect(api.fetchFtcAdvancement).toHaveBeenCalledWith(2026, 'CNCMPLB')
    expect(store.rankings.length).toBeGreaterThanOrEqual(2)

    const team27570 = store.rankings.find(r => r.teamNumber === 27570)
    expect(team27570?.advancementPoints).toBe(136)
    expect(team27570?.advancementStatus).toBe('ADVANCING')

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div></div>' } }]
    })

    // 2. Mount RankingsTable component
    const wrapper = mount(RankingsTable, {
      props: {
        rankings: store.rankings,
        loading: false
      },
      global: {
        plugins: [pinia, i18nInstance, router]
      }
    })

    // 3. Verify First Column Header is "晋级分"
    const firstHeader = wrapper.find('thead th:first-child')
    expect(firstHeader.exists()).toBe(true)
    expect(firstHeader.text()).toContain('晋级分')
    expect(firstHeader.classes()).toContain('advancement-col-th')

    // 4. Verify Second Column Header is "队伍"
    const secondHeader = wrapper.find('thead th:nth-child(2)')
    expect(secondHeader.exists()).toBe(true)
    expect(secondHeader.text()).toContain('队伍')

    // 5. Verify First Cell in Row displays Advancement Score and Status Badge
    const row27570 = wrapper.find('[data-team-row="27570"]')
    expect(row27570.exists()).toBe(true)

    const firstCell = row27570.find('td:first-child')
    expect(firstCell.classes()).toContain('advancement-cell')
    expect(firstCell.text()).toContain('136')
    expect(firstCell.text()).toContain('晋级区')

    // 6. Verify Sorting by Advancement Points: starts descending, toggles to ascending, then back
    const initialRows = wrapper.findAll('.ranking-row')
    expect(initialRows[0].find('.team-num').text()).toBe('27570')

    await firstHeader.trigger('click') // toggles to asc
    const rowsAsc = wrapper.findAll('.ranking-row')
    expect(rowsAsc[0].find('.team-num').text()).toBe('8417')

    await firstHeader.trigger('click') // toggles back to desc
    const rowsDesc = wrapper.findAll('.ranking-row')
    expect(rowsDesc[0].find('.team-num').text()).toBe('27570')

    // 7. Test Real-time Update: update advancement points and verify synchronous refresh
    const updatedAdvancement: AdvancementDetail[] = [
      {
        ...mockAdvancement[1],
        totalAdvancementPoints: 160 // Team 11115 jumps ahead
      },
      mockAdvancement[0],
      mockAdvancement[2]
    ]
    vi.mocked(api.fetchFtcAdvancement).mockResolvedValue(updatedAdvancement)
    await store.refreshAdvancement(2026, 'CNCMPLB')

    await wrapper.setProps({ rankings: store.rankings })

    const updatedRow11115 = wrapper.find('[data-team-row="11115"]')
    expect(updatedRow11115.find('td:first-child').text()).toContain('160')

    // 8. Test Table 4-2 tiebreaker: two teams tied at same advancement points
    const tiedAdvancement: AdvancementDetail[] = [
      {
        ...mockAdvancement[0],
        totalAdvancementPoints: 100,
        advancementRank: 1 // Team 27570 won Inspire Award (tiebreaker 1)
      },
      {
        ...mockAdvancement[1],
        totalAdvancementPoints: 100,
        advancementRank: 2
      }
    ]
    vi.mocked(api.fetchFtcAdvancement).mockResolvedValue(tiedAdvancement)
    await store.refreshAdvancement(2026, 'CNCMPLB')
    await wrapper.setProps({ rankings: store.rankings })

    const rowsTied = wrapper.findAll('.ranking-row')
    expect(rowsTied[0].find('.team-num').text()).toBe('27570')
    expect(rowsTied[1].find('.team-num').text()).toBe('11115')

    // 9. Verify persistence in localStorage
    expect(localStorage.getItem('scoutingpro_advancement')).toContain('27570')

    // 10. Verify team without official advancement has no badge
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

    // 11. Verify rolled-down & skipped statuses render distinct badges and tooltips
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

    // 12. Verify English locale header and roll-down labels
    i18nInstance.global.locale.value = 'en'
    await wrapper.vm.$nextTick()
    expect(firstHeader.text()).toContain('Adv. Pts')
    expect(wrapper.find('[data-team-row="27570"] td:first-child').text()).toContain('PRE-QUAL')
    expect(wrapper.find('[data-team-row="11115"] td:first-child').text()).toContain('ROLLED DOWN')
    expect(wrapper.find('[data-team-row="8417"] td:first-child').text()).toContain('DECLINED')
  })
})
