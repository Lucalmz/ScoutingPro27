import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ScheduleManager from '../components/schedule/ScheduleManager.vue'
import { useScheduleStore } from '../stores/schedule'
import { useRecordStore } from '../stores/records'
import { useConnectionStore } from '../stores/connection'
import { useUserStore } from '../stores/user'
import { saveKnownScout, clearKnownScouts } from '@/services/scoutStorage'

const mockShowConfirm = vi.fn()
const mockRouterReplace = vi.fn()

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mockShowConfirm
  })
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
  useRoute: () => ({ query: {} })
}))

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  missingWarn: false,
  fallbackWarn: false,
  messages: {
    en: {
      schedule: {
        search_placeholder: 'Search match or team...',
        filter_all: 'All',
        filter_mine: 'Mine',
        filter_pending: 'Pending',
        filter_discrepancy: 'Discrepancy',
        col_match: 'Match',
        red_alliance: 'Red Alliance',
        blue_alliance: 'Blue Alliance',
        col_official_score: 'Official Score',
        unassigned: 'Unassigned',
        btn_go_scout: 'Go Scout',
        btn_scouted_again: 'Scout Again',
        scouted: 'Scouted',
        btn_import_schedule: 'Import Schedule',
        btn_clear_schedule: 'Clear Schedule',
        btn_set_unassigned: 'Unassign',
        selected_count: '{count} selected',
        bulk_target_label: 'Target',
        target_all_stations: 'All Stations'
      },
      event: {
        status_online: 'Online',
        status_offline: 'Offline'
      },
      confirm_dialog: {
        title: 'Confirm',
        danger_confirm: 'Delete',
        cancel: 'Cancel'
      }
    }
  }
})

describe('ScheduleManager business logic & UI flows', () => {
  const wrappers: VueWrapper[] = []
  const track = (w: VueWrapper) => {
    wrappers.push(w)
    return w
  }

  const baseEvent = { id: 'evt-1', name: 'Test Regional', inviteCode: 'ABC123', hostId: 'host-1' } as any

  const seedSchedules = () => {
    const scheduleStore = useScheduleStore()
    scheduleStore.loadSchedule = vi.fn().mockResolvedValue(undefined)
    scheduleStore.assignStation = vi.fn().mockResolvedValue(undefined)
    scheduleStore.batchAssignSelected = vi.fn().mockResolvedValue(undefined)
    scheduleStore.clearSchedule = vi.fn().mockResolvedValue(undefined)
    scheduleStore.schedules = [
      {
        eventId: 'evt-1',
        matchNumber: 1,
        tournamentLevel: 'QUALIFICATION',
        red1: 27570,
        red2: 1111,
        blue1: 2222,
        blue2: 3333
      },
      {
        eventId: 'evt-1',
        matchNumber: 2,
        tournamentLevel: 'PLAYOFF',
        red1: 4444,
        red2: 5555,
        blue1: 6666,
        blue2: 7777
      }
    ]
    scheduleStore.assignments = {
      QUALIFICATION_1_red1: {
        eventId: 'evt-1',
        matchNumber: 1,
        tournamentLevel: 'QUALIFICATION',
        station: 'red1',
        teamNumber: 27570,
        scoutId: 'scout-me',
        scoutName: 'MeScout'
      }
    }
    return scheduleStore
  }

  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    const userStore = useUserStore()
    userStore.user = { id: 'scout-me', username: 'MeScout', token: 'tok' } as any
  })

  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    clearKnownScouts('evt-1')
    localStorage.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('filters displayed matches via searchQuery (match badge/number and team number) and filterMode pills', async () => {
    seedSchedules()
    const recordStore = useRecordStore()
    recordStore.currentEventId = 'evt-1'
    // Mark all 4 teams of Q1 as scouted so Q1 is NOT pending while P2 remains pending,
    // and create a genuine score discrepancy against official Q1 results so the 4th pill activates.
    recordStore.records = [
      { id: 'r1', eventId: 'evt-1', matchNumber: 1, teamNumber: 27570, totalScore: 100, rawData: '{"tournamentLevel":"QUALIFICATION"}', scoutId: 's1' } as any,
      { id: 'r2', eventId: 'evt-1', matchNumber: 1, teamNumber: 1111, totalScore: 100, rawData: '{"tournamentLevel":"QUALIFICATION"}', scoutId: 's1' } as any,
      { id: 'r3', eventId: 'evt-1', matchNumber: 1, teamNumber: 2222, totalScore: 25, rawData: '{"tournamentLevel":"QUALIFICATION"}', scoutId: 's1' } as any,
      { id: 'r4', eventId: 'evt-1', matchNumber: 1, teamNumber: 3333, totalScore: 25, rawData: '{"tournamentLevel":"QUALIFICATION"}', scoutId: 's1' } as any
    ]
    recordStore.officialMatches = [
      {
        matchNum: 1,
        tournamentLevel: 'QUALIFICATION',
        scores: { red: { totalPointsNp: 50 }, blue: { totalPointsNp: 50 } },
        teams: [
          { alliance: 'Red1', teamNumber: 27570 },
          { alliance: 'Red2', teamNumber: 1111 },
          { alliance: 'Blue1', teamNumber: 2222 },
          { alliance: 'Blue2', teamNumber: 3333 }
        ]
      } as any
    ]

    const wrapper = track(mount(ScheduleManager, {
      props: { event: baseEvent, isHost: true },
      global: { plugins: [i18n], stubs: { PitStatusIndicator: true, ScheduleImportModal: true, ScheduleAuditModal: true } }
    }))

    expect(wrapper.findAll('tr.match-row')).toHaveLength(2)

    // Search by team number
    const searchInput = wrapper.find('.search-input')
    await searchInput.setValue('27570')
    expect(wrapper.findAll('tr.match-row')).toHaveLength(1)
    expect(wrapper.find('.match-badge').text()).toBe('Q1')

    // Search by playoff prefix
    await searchInput.setValue('p2')
    expect(wrapper.findAll('tr.match-row')).toHaveLength(1)
    expect(wrapper.find('.match-badge').text()).toBe('P2')

    // Clear search and test filterMode pills: All / Mine / Pending / Discrepancy
    await searchInput.setValue('')
    expect(wrapper.findAll('tr.match-row')).toHaveLength(2)

    const pills = wrapper.findAll('.filter-pills .pill-btn')
    expect(pills).toHaveLength(4)

    await pills[1].trigger('click') // Mine -> only Q1 assigned to scout-me
    expect(wrapper.findAll('tr.match-row')).toHaveLength(1)
    expect(wrapper.find('.match-badge').text()).toBe('Q1')

    await pills[2].trigger('click') // Pending -> only P2 unscouted
    expect(wrapper.findAll('tr.match-row')).toHaveLength(1)
    expect(wrapper.find('.match-badge').text()).toBe('P2')

    await pills[3].trigger('click') // Discrepancy -> only Q1 with warning
    expect(wrapper.findAll('tr.match-row')).toHaveLength(1)
    expect(wrapper.find('.match-badge').text()).toBe('Q1')
  })

  it('deduplicates availableScouts and sorts online scouts before offline scouts', async () => {
    seedSchedules()
    saveKnownScout('evt-1', { id: 'offline-z', name: 'ZedOffline', lastSeen: 1000 })
    saveKnownScout('evt-1', { id: 'online-b', name: 'BobOnline', lastSeen: 1000 })

    const connStore = useConnectionStore()
    connStore.connectedScouts = [
      { id: 'online-b', name: 'BobOnline', transport: null } as any,
      { id: 'online-a', name: 'AliceOnline', transport: null } as any
    ]

    const wrapper = track(mount(ScheduleManager, {
      props: { event: baseEvent, isHost: true },
      global: { plugins: [i18n], stubs: { PitStatusIndicator: true, ScheduleImportModal: true, ScheduleAuditModal: true } }
    }))

    const firstSelect = wrapper.find('select.scout-select')
    expect(firstSelect.exists()).toBe(true)
    const optionTexts = firstSelect.findAll('option').slice(1).map((o) => o.text())

    // Deduplicated (online-b appears once) and sorted: online alphabetically (AliceOnline, BobOnline, MeScout), then offline (ZedOffline)
    expect(optionTexts).toEqual([
      'AliceOnline (Online)',
      'BobOnline (Online)',
      'MeScout (Online)',
      'ZedOffline (Offline)'
    ])
  })

  it('assigns single station via select change and batch assigns selected rows', async () => {
    const scheduleStore = seedSchedules()
    const connStore = useConnectionStore()
    connStore.connectedScouts = [{ id: 'scout-2', name: 'ScoutTwo', transport: null } as any]

    const wrapper = track(mount(ScheduleManager, {
      props: { event: baseEvent, isHost: true },
      global: { plugins: [i18n], stubs: { PitStatusIndicator: true, ScheduleImportModal: true, ScheduleAuditModal: true } }
    }))

    // Single station assignment on first select
    const firstSelect = wrapper.find('select.scout-select')
    await firstSelect.setValue('scout-2')
    expect(scheduleStore.assignStation).toHaveBeenCalledWith(
      'evt-1',
      1,
      'red1',
      'scout-2',
      'ScoutTwo',
      true,
      'QUALIFICATION'
    )

    // Select first row by clicking it and verify bulk action bar appears
    expect(wrapper.find('.bulk-action-bar').exists()).toBe(false)
    await wrapper.find('tr.match-row').trigger('click')
    expect(scheduleStore.selectedCount).toBe(1)

    const bulkBar = wrapper.find('.bulk-action-bar')
    expect(bulkBar.exists()).toBe(true)
    const scoutChips = bulkBar.findAll('.scout-assign-chip:not(.unassign-chip)')
    const targetChip = scoutChips.find((c) => c.text().includes('ScoutTwo'))
    expect(targetChip).toBeDefined()
    await targetChip!.trigger('click')

    expect(scheduleStore.batchAssignSelected).toHaveBeenCalledWith('evt-1', 'all', 'scout-2', 'ScoutTwo')
  })

  it('gates host-only toolbar actions and emits startScouting for assigned scout', async () => {
    seedSchedules()
    const wrapper = track(mount(ScheduleManager, {
      props: { event: baseEvent, isHost: true },
      global: { plugins: [i18n], stubs: { PitStatusIndicator: true, ScheduleImportModal: true, ScheduleAuditModal: true } }
    }))

    // Positive control: toolbar container & host buttons visible when isHost=true
    expect(wrapper.find('.schedule-toolbar').exists()).toBe(true)
    expect(wrapper.find('.btn-tool.primary').exists()).toBe(true)
    expect(wrapper.find('.btn-tool.danger').exists()).toBe(true)
    expect(wrapper.find('select.scout-select').exists()).toBe(true)

    // Flip to scout mode: host buttons and select controls hidden, Go Scout button visible for assigned station
    await wrapper.setProps({ isHost: false })
    expect(wrapper.find('.schedule-toolbar').exists()).toBe(true)
    expect(wrapper.find('.btn-tool.primary').exists()).toBe(false)
    expect(wrapper.find('.btn-tool.danger').exists()).toBe(false)
    expect(wrapper.find('select.scout-select').exists()).toBe(false)

    const goScoutBtn = wrapper.find('.btn-go-scout.red')
    expect(goScoutBtn.exists()).toBe(true)
    await goScoutBtn.trigger('click')
    expect(wrapper.emitted('startScouting')?.[0]).toEqual([
      { matchNumber: 1, teamNumber: 27570, allianceColor: 'red', tournamentLevel: 'QUALIFICATION' }
    ])
  })

  it('clears schedule only after confirmation dialog resolves true', async () => {
    const scheduleStore = seedSchedules()
    const wrapper = track(mount(ScheduleManager, {
      props: { event: baseEvent, isHost: true },
      global: { plugins: [i18n], stubs: { PitStatusIndicator: true, ScheduleImportModal: true, ScheduleAuditModal: true } }
    }))

    const clearBtn = wrapper.find('.btn-tool.danger')
    expect(clearBtn.exists()).toBe(true)

    mockShowConfirm.mockResolvedValueOnce(false)
    await clearBtn.trigger('click')
    expect(mockShowConfirm).toHaveBeenCalledTimes(1)
    expect(scheduleStore.clearSchedule).not.toHaveBeenCalled()

    mockShowConfirm.mockResolvedValueOnce(true)
    await clearBtn.trigger('click')
    expect(mockShowConfirm).toHaveBeenCalledTimes(2)
    expect(scheduleStore.clearSchedule).toHaveBeenCalledWith('evt-1')
  })
})
