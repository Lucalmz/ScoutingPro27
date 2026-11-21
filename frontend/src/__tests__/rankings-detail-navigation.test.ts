import { ref, nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import RankingsTable from '../components/rankings/RankingsTable.vue'
import TeamDetailDrawer from '../components/common/TeamDetailDrawer.vue'
import TeamDetailView from '../views/TeamDetailView.vue'
import RenameModal from '../components/common/RenameModal.vue'
import { useUserProfileTransition } from '../composables/useUserProfileTransition'
import { useNavigationStore } from '../stores/navigation'
import { useEventStore } from '../stores/events'
import { useRecordStore } from '../stores/records'
import { useUserStore } from '../stores/user'
import { useConnectionStore } from '../stores/connection'
import { useEventWebRtcBridge } from '../views/useEventWebRtcBridge'
import { createI18n } from 'vue-i18n'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      rankings: {
        advancement_points: 'Advancement Pts',
        advancement_points_desc: 'Advancement Points',
        team: 'Team',
        matches: 'Matches',
        breakdown: 'Breakdown',
        avg_auto: 'Avg Auto',
        avg_tele: 'Avg Tele',
        avg_endgame: 'Avg Endgame',
        max: 'Max',
        rating: 'Rating',
        trend: 'Trend',
        details: 'Details',
        actions: 'Actions',
        loading: 'Loading rankings...',
        no_data: 'No data available'
      },
      tags: {
        filter_by_tag: 'Filter by Tag',
        all: 'All',
        section_title: 'Tags',
        add_tag: 'Add Tag'
      },
      team_drawer: {
        title: 'Team {team}',
        full_detail: 'Full Detail',
        close: 'Close',
        rank: 'Rank',
        avg_score: 'Avg Score',
        max_score: 'Max Score',
        trend: 'Trend',
        auto: 'Auto',
        teleop: 'Teleop',
        endgame: 'Endgame',
        match_history: 'Match History ({count})',
        no_matches: 'No matches',
        loading: 'Loading...',
        no_data: 'No data',
        no_data_hint: 'No data hint'
      },
      team_detail: {
        back: 'Back',
        title: 'Team {team} Details',
        no_records: 'No records found'
      },
      user: {
        rename_title: 'Edit Profile & Password',
        rename_desc: 'Your credentials will update automatically.',
        nickname_label: 'Username',
        nickname_placeholder: 'Enter username',
        change_password_toggle: 'Change Password',
        old_password_label: 'Old Password',
        old_password_placeholder: 'Enter old password',
        new_password_label: 'New Password',
        new_password_placeholder: 'Enter new password',
        confirm_password_label: 'Confirm New Password',
        confirm_password_placeholder: 'Confirm new password',
        btn_save: 'Save Changes',
        btn_cancel: 'Cancel'
      },
      common: {
        cancel: 'Cancel'
      }
    }
  }
})

const mockRouterPush = vi.fn()
const mockRouterBack = vi.fn()
const { webrtcFactoryHook } = vi.hoisted(() => ({
  webrtcFactoryHook: { fn: null as null | ((cb: any) => any) }
}))

vi.mock('@/services/webrtc', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/services/webrtc')>()
  return {
    ...mod,
    createWebRtcService: vi.fn((cb: any) =>
      webrtcFactoryHook.fn ? webrtcFactoryHook.fn(cb) : mod.createWebRtcService(cb)
    )
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

describe('Rankings & Detail Navigation Integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    webrtcFactoryHook.fn = null
    mockRouterPush.mockClear()
    mockRouterBack.mockClear()
    document.body.innerHTML = ''
  })

  it('RankingsTable viewTeamDetails records position in navStore and pushes to team detail', async () => {
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

    const wrapper = mount(RankingsTable, {
      props: {
        rankings: sampleRankings,
        loading: false
      },
      global: {
        plugins: [i18n]
      }
    })

    expect(wrapper.find('.rankings-panel').exists()).toBe(true)
    expect(wrapper.find('table').exists()).toBe(true)
    expect(wrapper.find('[data-team-row="27570"]').exists()).toBe(true)

    // Click details button
    const detailsBtn = wrapper.find('.details-btn')
    expect(detailsBtn.exists()).toBe(true)
    await detailsBtn.trigger('click')

    // Verify position recorded in navStore
    const saved = navStore.getEventPosition('evt-123')
    expect(saved).not.toBeNull()
    expect(saved?.fromTab).toBe('rankings')
    expect(saved?.teamNumber).toBe(27570)

    // Verify router navigation
    expect(mockRouterPush).toHaveBeenCalledWith('/event/evt-123/team/27570')
  })

  it('TeamDetailDrawer goFullDetail records AI tab position in navStore', async () => {
    const navStore = useNavigationStore()
    mount(TeamDetailDrawer, {
      props: {
        teamNumber: 27570,
        eventId: 'evt-ai-test'
      },
      global: {
        plugins: [i18n]
      },
      attachTo: document.body
    })

    // Click full detail button in teleported drawer
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
    const wrapper = mount(TeamDetailView, {
      props: {
        eventId: 'evt-123',
        teamNumber: '27570'
      },
      global: {
        plugins: [i18n]
      }
    })

    const backBtn = wrapper.find('.btn-back')
    expect(backBtn.exists()).toBe(true)
    await backBtn.trigger('click')

    // Since in mock environment history has push or back
    expect(mockRouterBack.mock.calls.length + mockRouterPush.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('RenameModal exposes panel, backdrop, and unstretched text viewTransitionNames while active', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'tok' }

    const docAny = document as Document & { startViewTransition?: any }
    const origStartVT = docAny.startViewTransition
    let resolveFinished!: () => void
    docAny.startViewTransition = vi.fn((cb: () => Promise<void> | void) => {
      void Promise.resolve(cb())
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: new Promise<void>((resolve) => {
          resolveFinished = resolve
        })
      }
    })

    const { openProfileModal, resetProfileTransition } = useUserProfileTransition()
    const wrapper = mount(RenameModal, {
      props: {
        visible: false,
        eventId: 'evt_1'
      },
      global: {
        plugins: [i18n]
      }
    })

    try {
      openProfileModal((val) => {
        void wrapper.setProps({ visible: val })
      })
      await nextTick()
      await nextTick()

      const overlay = wrapper.find('.modal-overlay')
      const card = wrapper.find('.modal-card')
      const textMorph = wrapper.find('.input-text-morph')
      const inputWrapper = wrapper.find('.username-input-wrapper')

      expect(overlay.exists()).toBe(true)
      expect(card.exists()).toBe(true)
      expect(textMorph.exists()).toBe(true)
      expect((overlay.element as HTMLElement).style.viewTransitionName).toBe('user-profile-backdrop')
      expect((card.element as HTMLElement).style.viewTransitionName).toBe('user-profile-panel')
      expect((textMorph.element as HTMLElement).style.viewTransitionName).toBe('user-profile-text')
      expect((inputWrapper.element as HTMLElement).style.viewTransitionName || '').toBe('')

      resolveFinished()
      await nextTick()
    } finally {
      wrapper.unmount()
      resetProfileTransition()
      if (origStartVT === undefined) {
        delete docAny.startViewTransition
      } else {
        docAny.startViewTransition = origStartVT
      }
    }
  })

  it('useEventWebRtcBridge preserves waiting/host_online status without flashing connecting when returning from details', async () => {
    const eventStore = useEventStore()
    const connStore = useConnectionStore()
    const userStore = useUserStore()

    userStore.user = { id: 'host-1', username: 'HostUser', token: 'valid-token' }
    eventStore.setCurrentEvent({
      id: 'evt-123',
      name: 'Championship 2026',
      inviteCode: 'TEST26',
      hostId: 'host-1'
    })

    const mockRtc: any = {
      host: vi.fn(),
      join: vi.fn(),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      getStatus: () => 'waiting'
    }

    connStore.setRtcService(mockRtc)
    connStore.setStatus('waiting')

    const { setupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-123'),
      event: ref(eventStore.currentEvent),
      router: { replace: vi.fn() } as any,
      t: (k: string) => k
    })

    // Simulate returning from details: setupWebRTC is called on remounted EventView
    await setupWebRTC()

    // Status must remain 'waiting', not flipped to 'connecting'
    expect(connStore.status).toBe('waiting')
    // mockRtc.updateCallbacks must have been called to hot-update callbacks
    expect(mockRtc.updateCallbacks).toHaveBeenCalled()
    // mockRtc.host should not be called again
    expect(mockRtc.host).not.toHaveBeenCalled()
  })

  it('useEventWebRtcBridge preserves connected status without flashing connecting when returning from details', async () => {
    const eventStore = useEventStore()
    const connStore = useConnectionStore()
    const userStore = useUserStore()

    userStore.user = { id: 'scout-1', username: 'ScoutUser', token: 'valid-token' }
    eventStore.setCurrentEvent({
      id: 'evt-123',
      name: 'Championship 2026',
      inviteCode: 'TEST26',
      hostId: 'host-1'
    })

    const mockRtc: any = {
      host: vi.fn(),
      join: vi.fn(),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      getStatus: () => 'connected'
    }

    connStore.setRtcService(mockRtc)
    connStore.setStatus('connected')

    const { setupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-123'),
      event: ref(eventStore.currentEvent),
      router: { replace: vi.fn() } as any,
      t: (k: string) => k
    })

    await setupWebRTC()

    expect(connStore.status).toBe('connected')
    expect(mockRtc.updateCallbacks).toHaveBeenCalled()
    expect(mockRtc.join).not.toHaveBeenCalled()
  })

  it('useEventWebRtcBridge tears down old WebRTC service when navigating to a different event', async () => {
    const eventStore = useEventStore()
    const connStore = useConnectionStore()
    const userStore = useUserStore()

    userStore.user = { id: 'host-1', username: 'HostUser', token: 'valid-token' }
    eventStore.setCurrentEvent({
      id: 'evt-456',
      name: 'Event 456',
      inviteCode: 'NEW456',
      hostId: 'host-1'
    })

    const mockOldRtc: any = {
      host: vi.fn(),
      join: vi.fn(),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      getStatus: () => 'waiting'
    }

    connStore.setRtcService(mockOldRtc)
    connStore.setStatus('waiting')

    // Bridging with a different eventId ('evt-456' while old service was from another event)
    // Here eventStore.currentEvent.id is 'evt-456' but eventId ref passed is 'evt-789' (mismatch)
    const { setupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-789'),
      event: ref(eventStore.currentEvent),
      router: { replace: vi.fn() } as any,
      t: (k: string) => k
    })

    await setupWebRTC()

    // Old service must have been disconnected
    expect(mockOldRtc.disconnect).toHaveBeenCalled()
    expect(mockOldRtc.updateCallbacks).not.toHaveBeenCalled()
  })

  it('cleanupWebRTC resets connStore status to offline and clears service', () => {
    const eventStore = useEventStore()
    const connStore = useConnectionStore()

    const mockRtc: any = {
      disconnect: vi.fn()
    }
    connStore.setRtcService(mockRtc)
    connStore.setStatus('connected')

    const { cleanupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-123'),
      event: ref(eventStore.currentEvent),
      router: { replace: vi.fn() } as any,
      t: (k: string) => k
    })

    cleanupWebRTC()

    expect(mockRtc.disconnect).toHaveBeenCalled()
    expect(connStore.rtcService).toBeNull()
    expect(connStore.status).toBe('offline')
  })

  it('RankingsTable removes tags from rows but preserves tag filtering', async () => {
    const recordStore = useRecordStore()
    recordStore.teamTags = [
      { id: 't1', teamNumber: 27570, tag: 'Fast', color: 'green', isPreset: false, eventId: 'evt-123' },
      { id: 't2', teamNumber: 9999, tag: 'Defense', color: 'red', isPreset: false, eventId: 'evt-123' }
    ]

    const wrapper = mount(RankingsTable, {
      props: {
        rankings: [
          { teamNumber: 27570, matchCount: 5, brokenCount: 0, avgAutoScore: 30, avgTeleopScore: 50, avgEndgameScore: 20, maxScore: 100, avgRating: 90, trend: 'up' },
          { teamNumber: 9999, matchCount: 4, brokenCount: 1, avgAutoScore: 20, avgTeleopScore: 40, avgEndgameScore: 10, maxScore: 80, avgRating: 70, trend: 'down' }
        ],
        loading: false
      },
      global: {
        plugins: [i18n]
      }
    })

    // 1. Tags must NOT be rendered in the table rows
    expect(wrapper.find('.row-tags-list').exists()).toBe(false)
    expect(wrapper.find('.row-tag-badge').exists()).toBe(false)

    // 2. Tag filter bar MUST be present
    const filterBar = wrapper.find('.tag-filter-bar')
    expect(filterBar.exists()).toBe(true)

    const chips = wrapper.findAll('.filter-chip')
    expect(chips.length).toBe(3) // All, Fast, Defense

    // Both rows initially visible
    expect(wrapper.find('[data-team-row="27570"]').exists()).toBe(true)
    expect(wrapper.find('[data-team-row="9999"]').exists()).toBe(true)

    // Click Fast chip
    const fastChip = chips.find(c => c.text().includes('Fast'))
    expect(fastChip).toBeDefined()
    await fastChip!.trigger('click')

    // Only 27570 is displayed
    expect(wrapper.find('[data-team-row="27570"]').exists()).toBe(true)
    expect(wrapper.find('[data-team-row="9999"]').exists()).toBe(false)

    // Click All chip
    const allChip = chips.find(c => c.text().includes('All'))
    await allChip!.trigger('click')
    expect(wrapper.find('[data-team-row="27570"]').exists()).toBe(true)
    expect(wrapper.find('[data-team-row="9999"]').exists()).toBe(true)
  })

  it('RankingsTable executes staggered entrance animation hooks (beforeEnter & enter)', () => {
    vi.useFakeTimers()
    const wrapper = mount(RankingsTable, {
      props: {
        rankings: [
          { teamNumber: 27570, matchCount: 5, brokenCount: 0, avgAutoScore: 30, avgTeleopScore: 50, avgEndgameScore: 20, maxScore: 100, avgRating: 90, trend: 'up' }
        ],
        loading: false
      },
      global: {
        plugins: [i18n]
      }
    })

    const vm = wrapper.vm as any
    const dummyEl = document.createElement('tr')
    dummyEl.dataset.index = '1'
    document.body.appendChild(dummyEl)

    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })

    // 1. beforeEnter sets opacity 0 and translateY(20px)
    vm.beforeEnter(dummyEl)
    expect(dummyEl.style.opacity).toBe('0')
    expect(dummyEl.style.transform).toBe('translateY(20px)')

    // 2. enter applies staggered transition and clears inline properties on completion
    let doneCalled = false
    vm.enter(dummyEl, () => {
      doneCalled = true
    })

    // Fast-forward 1 * 40ms delay + 360ms
    vi.advanceTimersByTime(500)
    expect(doneCalled).toBe(true)
    expect(dummyEl.style.opacity).toBe('')
    expect(dummyEl.style.transform).toBe('')
    expect(dummyEl.style.transition).toBe('')

    rafSpy.mockRestore()
    document.body.removeChild(dummyEl)
    vi.useRealTimers()
  })

  it('RankingsTable updates hover-highlight on row mouseenter and hides on list mouseleave', async () => {
    const wrapper = mount(RankingsTable, {
      props: {
        rankings: [
          { teamNumber: 27570, matchCount: 5, brokenCount: 0, avgAutoScore: 30, avgTeleopScore: 50, avgEndgameScore: 20, maxScore: 100, avgRating: 90, trend: 'up' }
        ],
        loading: false
      },
      global: {
        plugins: [i18n]
      }
    })

    const highlightEl = wrapper.find('.hover-highlight')
    expect(highlightEl.exists()).toBe(true)
    expect((highlightEl.element as HTMLElement).style.opacity).toBe('0')

    const row = wrapper.find('.ranking-row')
    expect(row.exists()).toBe(true)

    Object.defineProperty(row.element, 'offsetTop', { value: 48, configurable: true })
    Object.defineProperty(row.element, 'offsetHeight', { value: 52, configurable: true })

    await row.trigger('mouseenter')
    expect((highlightEl.element as HTMLElement).style.opacity).toBe('1')
    expect((highlightEl.element as HTMLElement).style.top).toBe('48px')
    expect((highlightEl.element as HTMLElement).style.height).toBe('52px')

    // Mouse leave table container
    const tableContainer = wrapper.find('.table-container')
    await tableContainer.trigger('mouseleave')
    expect((highlightEl.element as HTMLElement).style.opacity).toBe('0')

    // Mouse enter row again then hover thead
    await row.trigger('mouseenter')
    expect((highlightEl.element as HTMLElement).style.opacity).toBe('1')

    const thead = wrapper.find('thead')
    await thead.trigger('mouseenter')
    expect((highlightEl.element as HTMLElement).style.opacity).toBe('0')
  })

  it('RankingsTable clicking .team-cell navigates to team detail view', async () => {
    const eventStore = useEventStore()
    eventStore.setCurrentEvent({
      id: 'evt-123',
      name: 'Championship 2026',
      inviteCode: 'TEST26',
      hostId: 'host-1'
    })

    const wrapper = mount(RankingsTable, {
      props: {
        rankings: [
          { teamNumber: 27570, matchCount: 5, brokenCount: 0, avgAutoScore: 30, avgTeleopScore: 50, avgEndgameScore: 20, maxScore: 100, avgRating: 90, trend: 'up' }
        ],
        loading: false
      },
      global: {
        plugins: [i18n]
      }
    })

    mockRouterPush.mockClear()
    const teamCell = wrapper.find('.team-cell')
    expect(teamCell.exists()).toBe(true)
    await teamCell.trigger('click')

    expect(mockRouterPush).toHaveBeenCalledWith('/event/evt-123/team/27570')
  })

  it('useEventWebRtcBridge does not tear down or restart WebRTC when a fenced Standby host receives epoch_witness updates', async () => {
    const { createWebRtcService } = await import('@/services/webrtc')
    vi.mocked(createWebRtcService).mockClear()

    const eventStore = useEventStore()
    const connStore = useConnectionStore()
    const userStore = useUserStore()

    userStore.user = { id: 'host-1', username: 'HostUser', token: 'valid-token' }
    const evt = {
      id: 'evt-auth-1',
      name: 'Epoch Fencing Event',
      inviteCode: 'EP01',
      hostId: 'host-1'
    }
    eventStore.setCurrentEvent(evt)

    let capturedCallbacks: any = null
    let hostModeFlag = true
    let standbyFlag = false
    const mockRtc: any = {
      host: vi.fn(async () => {}),
      join: vi.fn(async () => {}),
      disconnect: vi.fn(),
      updateCallbacks: vi.fn(),
      setEventMetadata: vi.fn(),
      getStatus: () => 'connecting',
      isHostMode: () => hostModeFlag,
      isStandbyHost: () => standbyFlag,
      getHostEpoch: () => 2
    }
    webrtcFactoryHook.fn = (cb) => {
      capturedCallbacks = cb
      return mockRtc
    }

    const { setupWebRTC } = useEventWebRtcBridge({
      eventId: ref('evt-auth-1'),
      event: ref(evt),
      router: {
        replace: vi.fn(async () => {}),
        currentRoute: ref({ params: { eventId: 'evt-auth-1' }, query: {} })
      } as any,
      t: (k: string) => k
    })

    await setupWebRTC()
    expect(vi.mocked(createWebRtcService)).toHaveBeenCalledTimes(1)
    expect(mockRtc.host).toHaveBeenCalledTimes(1)
    expect(capturedCallbacks).toBeTruthy()

    // Simulate Epoch-2 fencing into Standby while ICE/TURN connection is still in flight
    hostModeFlag = false
    standbyFlag = true
    connStore.setStatus('connecting')
    capturedCallbacks.onHostStandby?.({ hostSessionId: 'host-b', hostDeviceId: 'dev-b' })

    const witnessPayload = {
      inviteCode: 'EP01',
      authoritativeEventId: 'evt-auth-1',
      eventName: 'Epoch Fencing Event',
      hostUserId: 'host-1',
      highestSeenEpoch: 2,
      activeHostSessionId: 'host-b',
      activeHostDeviceId: 'dev-b',
      updatedAt: Date.now()
    }
    capturedCallbacks.onEpochWitnessUpdated?.(witnessPayload)
    await capturedCallbacks.onWitnessMetadataDiscovered?.(witnessPayload)

    expect(mockRtc.disconnect).not.toHaveBeenCalled()
    expect(vi.mocked(createWebRtcService)).toHaveBeenCalledTimes(1)
    expect(connStore.isStandbyHost).toBe(true)
  })
})
