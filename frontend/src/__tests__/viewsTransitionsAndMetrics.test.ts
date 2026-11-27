import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'
import { i18n } from '@/i18n'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useNavigationStore } from '@/stores/navigation'
import { useConnectionStore } from '@/stores/connection'
import { useAiStore } from '@/stores/ai'
import { useEventTransitions } from '@/views/useEventTransitions'
import {
  buildMatchCustomBadges,
  computeTeamFormulaMetrics,
  computeTeamMatchCustomMetrics,
  computeTeamPitCustomSpecs
} from '@/views/composables/useTeamCustomMetrics'
import DashboardView from '@/views/DashboardView.vue'
import TeamDetailView from '@/views/TeamDetailView.vue'
import LoginView from '@/views/LoginView.vue'
import { isDesktopHost } from '@/services/photoStorage'
import * as api from '@/services/api'
import * as isMobileComposable from '@/composables/useIsMobile'
import * as confirmComposable from '@/composables/useConfirm'
import type { CustomFieldDefinition, ScoutingRecord } from '@/types'

const mockPush = vi.fn()
const mockReplace = vi.fn()
const mockRouteState = {
  params: { eventId: 'evt-v1', teamNumber: '27570' } as Record<string, string>,
  query: {} as Record<string, string>
}

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace
  }),
  useRoute: () => mockRouteState,
  onBeforeRouteLeave: vi.fn()
}))

vi.mock('@/services/photoStorage', () => ({
  isDesktopHost: vi.fn(() => true),
  getPhotoUrl: vi.fn((k: string) => `/photos/${k}`)
}))

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
    apiFetchBannedTeams: vi.fn().mockResolvedValue([]),
    fetchCustomFields: vi.fn().mockResolvedValue([]),
    checkUserExists: vi.fn().mockResolvedValue({ exists: true })
  }
})

describe('Views Transitions, Custom Metrics, DashboardView & TeamDetailView', () => {
  const originalLocale = i18n.global.locale.value
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    mockPush.mockClear()
    mockReplace.mockClear()
    mockRouteState.params = { eventId: 'evt-v1', teamNumber: '27570' }
    mockRouteState.query = {}
    i18n.global.locale.value = 'en'
    vi.mocked(isDesktopHost).mockReturnValue(true)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('[]', { status: 200 })))
  })

  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    i18n.global.locale.value = originalLocale
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('manages useEventTransitions tabs, desktop AI dock intercept, position save & restore', async () => {
    vi.useFakeTimers()
    try {
      const userStore = useUserStore()
      userStore.$patch({ user: { id: 'host-1', username: 'Host', token: 'tok' } })
      const eventStore = useEventStore()
      eventStore.setCurrentEvent({ id: 'evt-v1', name: 'Event', inviteCode: 'CODE', hostId: 'host-1' })

      const contentEl = document.createElement('div')
      contentEl.scrollTop = 120
      const contentRef = ref<HTMLElement | null>(contentEl)
      const isMobileRef = ref(false)
      const routerMock = { replace: vi.fn() } as any

      // Desktop query ?tab=ai opens AI dock and lands on rankings
      mockRouteState.query = { tab: 'ai' }
      const trans = useEventTransitions({
        route: mockRouteState as any,
        router: routerMock,
        eventId: ref('evt-v1'),
        contentRef,
        isMobile: isMobileRef,
        t: (k: string) => k
      })
      const aiStore = useAiStore()
      expect(trans.activeTab.value).toBe('rankings')
      expect(aiStore.isDockOpen).toBe(true)
      expect(trans.tabs.value.some(t => t.key === 'scouts')).toBe(true)
      expect(trans.tabs.value.some(t => t.key === 'ai')).toBe(false)

      // Desktop switchTab('ai') opens dock without changing activeTab
      aiStore.setDockOpen(false)
      trans.switchTab('ai')
      expect(aiStore.isDockOpen).toBe(true)
      expect(trans.activeTab.value).toBe('rankings')

      // Normal switchTab updates route & saves nav position
      trans.switchTab('history')
      expect(trans.activeTab.value).toBe('history')
      expect(routerMock.replace).toHaveBeenCalledWith({ query: expect.objectContaining({ tab: 'history' }) })

      trans.saveLeavePosition(27570)
      const saved = useNavigationStore().getEventPosition('evt-v1')
      expect(saved?.teamNumber).toBe(27570)

      // Mobile view includes 'ai' tab and restorePosition scrolls
      isMobileRef.value = true
      expect(trans.tabs.value.some(t => t.key === 'ai')).toBe(true)
      trans.restorePosition({
        eventId: 'evt-v1',
        fromTab: 'rankings',
        contentScrollTop: 250,
        contentScrollLeft: 0,
        tableScrollLeft: 40,
        aiChatScrollTop: null,
        teamNumber: null,
        timestamp: Date.now()
      })
      await nextTick()
      vi.advanceTimersByTime(30)
      expect(contentEl.scrollTop).toBe(250)
    } finally {
      vi.useRealTimers()
    }
  })

  it('computes match/pit/team custom metrics & badges including formulas, timers, multi-select & cycle errors', () => {
    const fields: CustomFieldDefinition[] = [
      { id: 'f1', eventId: 'e1', name: 'Cycle Timer', fieldKey: 'cycle_timer', target: 'MATCH', phase: 'teleop', fieldType: 'timer', unit: 's', required: false, isActive: true, orderSeq: 0 },
      { id: 'f2', eventId: 'e1', name: 'Tier Lvl', fieldKey: 'tier_lvl', target: 'MATCH', phase: 'endgame', fieldType: 'level', required: false, isActive: true, orderSeq: 1 },
      {
        id: 'f3',
        eventId: 'e1',
        name: 'Capabilities',
        fieldKey: 'caps',
        target: 'MATCH',
        phase: 'overall',
        fieldType: 'multi_select',
        options: [{ label: 'Vision', value: 'vis', color: 'cyan' }],
        required: false,
        isActive: true,
        orderSeq: 2
      },
      { id: 'f4', eventId: 'e1', name: 'Double Auto', fieldKey: 'dbl_auto', target: 'MATCH', phase: 'auto', fieldType: 'formula', formulaExpr: 'match.autoScore * 2', required: false, isActive: true, orderSeq: 3 },
      { id: 'f5', eventId: 'e1', name: 'Cycle A', fieldKey: 'cyc_a', target: 'MATCH', phase: 'overall', fieldType: 'formula', formulaExpr: 'formula.cyc_b + 1', required: false, isActive: true, orderSeq: 4 },
      { id: 'f6', eventId: 'e1', name: 'Cycle B', fieldKey: 'cyc_b', target: 'MATCH', phase: 'overall', fieldType: 'formula', formulaExpr: 'formula.cyc_a + 1', required: false, isActive: true, orderSeq: 5 },
      { id: 'f7', eventId: 'e1', name: 'Pit Weight', fieldKey: 'pit_w', target: 'PIT', phase: 'hardware', fieldType: 'timer', unit: 's', required: false, isActive: true, orderSeq: 6 },
      { id: 'f8', eventId: 'e1', name: 'Pit Formula', fieldKey: 'pit_f', target: 'PIT', phase: 'hardware', fieldType: 'formula', formulaExpr: 'cf.pit_w * 2', required: false, isActive: true, orderSeq: 7 },
      { id: 'f9', eventId: 'e1', name: 'Team Power', fieldKey: 'team_pwr', target: 'TEAM', phase: 'overall', fieldType: 'formula', formulaExpr: 'formula.dbl_auto + formula.pit_f', required: false, isActive: true, orderSeq: 8 }
    ]

    const matches: ScoutingRecord[] = [
      {
        id: 'm1',
        eventId: 'e1',
        scoutId: 's1',
        scoutName: 'S1',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 10,
        teleopScore: 20,
        endgameScore: 5,
        totalScore: 35,
        notes: '',
        rawData: JSON.stringify({
          customFields: { cycle_timer: 4.5, tier_lvl: 4, caps: ['vis', 'custom_extra'] }
        }),
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: '',
        isBroken: false,
        version: 1
      }
    ]

    const deletedMatch: ScoutingRecord = {
      ...matches[0]!,
      id: 'm-deleted',
      matchNumber: 2,
      autoScore: 99,
      rawData: JSON.stringify({
        customFields: { cycle_timer: 99.5, tier_lvl: 1, caps: ['deleted_opt'] }
      }),
      isDeleted: true
    }

    const matchMetrics = computeTeamMatchCustomMetrics(fields.slice(0, 6), [...matches, deletedMatch], fields)
    expect(matchMetrics.find(m => m.definition.fieldKey === 'cycle_timer')?.avg).toBe(4.5)
    expect(matchMetrics.find(m => m.definition.fieldKey === 'dbl_auto')?.aggregatedValue).toBe(20)
    expect(matchMetrics.find(m => m.definition.fieldKey === 'cyc_a')?.error).toBe('CIRCULAR_DEPENDENCY')
    const capsDist = matchMetrics.find(m => m.definition.fieldKey === 'caps')?.distribution || []
    expect(capsDist.some(d => d.label === 'Vision')).toBe(true)
    expect(capsDist.some(d => d.label === 'custom_extra')).toBe(true)
    expect(capsDist.some(d => d.label === 'deleted_opt')).toBe(false)

    const pitSpecs = computeTeamPitCustomSpecs(
      fields.filter(f => f.target === 'PIT'),
      { customFields: { pit_w: 3.5 } },
      k => k,
      fields
    )
    expect(pitSpecs.find(s => s.field.fieldKey === 'pit_w')?.displayValue).toBe('3.5 s')
    expect(pitSpecs.find(s => s.field.fieldKey === 'pit_f')?.displayValue).toBe('7.0')

    const teamMetrics = computeTeamFormulaMetrics(
      fields.filter(f => f.target === 'TEAM'),
      { matchRecords: matches, pitRecord: { customFields: { pit_w: 3.5 } } as any, allFields: fields }
    )
    expect(teamMetrics[0]?.aggregatedValue).toBe(27)

    const badges = buildMatchCustomBadges(fields.slice(0, 6), matches[0]!, k => k, fields)
    expect(badges.find(b => b.key === 'cyc_a')?.value).toBe('⚠')
    expect(badges.find(b => b.key === 'dbl_auto')?.value).toBe('20.0')
    expect(badges.find(b => b.key === 'tier_lvl')?.color).toBe('green')
  })

  it('handles DashboardView mobile actions, delete event, clear cache & logout', async () => {
    vi.mocked(isDesktopHost).mockReturnValue(false)
    vi.spyOn(isMobileComposable, 'useIsMobile').mockReturnValue({ isMobile: ref(true) } as any)
    vi.spyOn(confirmComposable, 'useConfirm').mockReturnValue({
      showConfirm: vi.fn().mockResolvedValue(true)
    } as any)

    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'u1', username: 'MobileScout', token: 'tok' } })
    const logoutSpy = vi.spyOn(userStore, 'logout').mockResolvedValue(undefined)

    const eventStore = useEventStore()
    eventStore.events = [{ id: 'evt-del', name: 'Delete Me', inviteCode: 'DEL1', hostId: 'u-other' }]
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)
    const delSpy = vi.spyOn(eventStore, 'deleteEvent').mockResolvedValue(undefined as any)
    const clearSpy = vi.spyOn(eventStore, 'clearAllLocalCache').mockImplementation(() => {})

    const wrapper = track(mount(DashboardView, { global: { plugins: [i18n] } }))
    await flushPromises()

    expect(wrapper.find('.scan-btn').exists()).toBe(true)
    expect(wrapper.find('.clear-cache-btn').exists()).toBe(true)

    await wrapper.find('.btn-card-delete').trigger('click')
    await flushPromises()
    expect(delSpy).toHaveBeenCalledWith('evt-del')

    await wrapper.find('.clear-cache-btn').trigger('click')
    await flushPromises()
    expect(clearSpy).toHaveBeenCalled()

    await wrapper.find('.btn-logout').trigger('click')
    await flushPromises()
    expect(logoutSpy).toHaveBeenCalled()
    expect(mockReplace).toHaveBeenCalledWith('/')
  })

  it('renders TeamDetailView SP-NP OPR card, BIOBUZZ badges, Escape navigation & askAiAboutTeam', async () => {
    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'host-1', username: 'Host', token: 'tok' } })
    const eventStore = useEventStore()
    eventStore.setCurrentEvent({ id: 'evt-v1', name: 'Regionals', inviteCode: 'REG1', hostId: 'host-1' })

    const recordStore = useRecordStore()
    recordStore.records = [
      {
        id: 'rec-td-1',
        eventId: 'evt-v1',
        scoutId: 'host-1',
        scoutName: 'Host',
        matchNumber: 3,
        teamNumber: 27570,
        autoScore: 14,
        teleopScore: 26,
        endgameScore: 15,
        totalScore: 55,
        notes: 'Great climb',
        rawData: JSON.stringify({
          autoLeave: true,
          autoBalls: 2,
          autoCycles: [2],
          autoCycleTimestamps: [1000, 3000],
          teleopCycles: [2, 2, 2, 2, 2, 2],
          teleopCycleTimestamps: [10000, 14000, 18000, 22000, 26000, 30000],
          teleopPark: true,
          flowerNectars: 2,
          flowerBottomBonusCount: 1,
          flowerPollens: 1,
          gardenBalls: 2,
          flowerDescore: true,
          g410EarlyFlowerFoul: false
        }),
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: '',
        isBroken: false,
        version: 1
      }
    ]
    const updateSpy = vi.spyOn(recordStore, 'updateRecord').mockResolvedValue({ success: true, recordsToPush: [] })
    const pitStore = usePitScoutStore()
    pitStore.currentEventId = 'evt-v1'
    vi.spyOn(useCustomFieldsStore(), 'fetchFields').mockResolvedValue(undefined as any)

    const wrapper = track(
      mount(TeamDetailView, {
        props: { eventId: 'evt-v1', teamNumber: '27570' },
        global: { plugins: [i18n] }
      })
    )
    await flushPromises()

    expect(wrapper.find('.sp-np-opr-card').exists()).toBe(true)
    expect(wrapper.find('.sp-np-opr-card').text()).toContain('NP OPR')
    expect(wrapper.find('.sp-np-opr-card').text()).toContain('55.0')
    expect(wrapper.find('.sp-np-opr-card').text()).toContain('Auto: 14.0')
    expect(wrapper.text()).toContain('Nectar:')
    expect(wrapper.text()).toContain('Bottom Bonus:')
    expect(wrapper.text()).toContain('Descore')

    // Edit comment & save
    await wrapper.find('.comments-label .btn-icon').trigger('click')
    const textarea = wrapper.find('.edit-textarea')
    await textarea.setValue('Updated scout evaluation')
    await wrapper.find('.edit-actions .btn-save').trigger('click')
    await flushPromises()
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ notes: 'Updated scout evaluation' }))

    // Ask AI navigates back to event with dock open
    await wrapper.find('.btn-ask-ai-detail').trigger('click')
    await flushPromises()
    expect(useAiStore().isDockOpen).toBe(true)
    expect(mockPush).toHaveBeenCalledWith('/event/evt-v1')

    // Escape key triggers handleBack
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(mockPush).toHaveBeenCalledTimes(2)
    expect(useConnectionStore().status).toBe('offline')
  })

  it('enforces Host-or-author permission on TeamDetailView comment editing (BUG #4) & preserves raw password in LoginView (BUG #6)', async () => {
    vi.mocked(isDesktopHost).mockReturnValue(false)
    const userStore = useUserStore()
    userStore.$patch({ user: { id: 'scout-1', username: 'ScoutOne', token: 'tok' } })
    const eventStore = useEventStore()
    eventStore.setCurrentEvent({ id: 'evt-v1', name: 'Regionals', inviteCode: 'REG1', hostId: 'host-real' })

    const recordStore = useRecordStore()
    recordStore.records = [
      {
        id: 'rec-own',
        eventId: 'evt-v1',
        scoutId: 'scout-1',
        scoutName: 'ScoutOne',
        matchNumber: 1,
        teamNumber: 27570,
        autoScore: 10,
        teleopScore: 20,
        endgameScore: 5,
        totalScore: 35,
        notes: 'Own note',
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: '',
        isBroken: false,
        version: 1
      },
      {
        id: 'rec-other',
        eventId: 'evt-v1',
        scoutId: 'scout-2',
        scoutName: 'ScoutTwo',
        matchNumber: 2,
        teamNumber: 27570,
        autoScore: 12,
        teleopScore: 22,
        endgameScore: 5,
        totalScore: 39,
        notes: 'Other note',
        rawData: '{}',
        syncStatus: 'SYNCED',
        createdAt: '',
        updatedAt: '',
        isBroken: false,
        version: 1
      }
    ]
    const updateSpy = vi.spyOn(recordStore, 'updateRecord').mockResolvedValue({ success: true, recordsToPush: [] })
    vi.spyOn(useCustomFieldsStore(), 'fetchFields').mockResolvedValue(undefined as any)

    const wrapper = track(
      mount(TeamDetailView, {
        props: { eventId: 'evt-v1', teamNumber: '27570' },
        global: { plugins: [i18n] }
      })
    )
    await flushPromises()

    const cards = wrapper.findAll('.match-card')
    expect(cards).toHaveLength(2)
    // Positive precondition: own match card exposes edit button; other scout's card does NOT
    expect(cards[0]!.find('.comments-label .btn-icon').exists()).toBe(true)
    expect(cards[1]!.find('.comments-label .btn-icon').exists()).toBe(false)
    expect(updateSpy).not.toHaveBeenCalled()

    // BUG #6: LoginView preserves leading/trailing whitespace in passwords per CONTRACT §1
    vi.mocked(api.checkUserExists).mockResolvedValue({ exists: true })
    const loginSpy = vi.spyOn(userStore, 'login').mockResolvedValue(true)
    const loginWrapper = track(mount(LoginView, { global: { plugins: [i18n] } }))
    await loginWrapper.find('#username').setValue('alice')
    await loginWrapper.find('#password').setValue('  my Pass  ')
    await loginWrapper.find('form').trigger('submit')
    await flushPromises()
    expect(loginSpy).toHaveBeenCalledWith('alice', '  my Pass  ')
  })
})
