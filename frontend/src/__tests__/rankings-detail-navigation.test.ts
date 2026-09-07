import { ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import RankingsTable from '../components/rankings/RankingsTable.vue'
import TeamDetailDrawer from '../components/common/TeamDetailDrawer.vue'
import TeamDetailView from '../views/TeamDetailView.vue'
import RenameModal from '../components/common/RenameModal.vue'
import { useNavigationStore } from '../stores/navigation'
import { useEventStore } from '../stores/events'
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

  it('RenameModal renders modal-card and preserves input-wrapper viewTransitionName', () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'tok' }

    const wrapper = mount(RenameModal, {
      props: {
        visible: true,
        eventId: 'evt_1'
      },
      global: {
        plugins: [i18n]
      }
    })

    // Verify modal-card exists for centered modal layout
    expect(wrapper.find('.modal-card').exists()).toBe(true)

    // Verify username input wrapper retains viewTransitionName
    const inputWrapper = wrapper.find('.input-wrapper')
    expect(inputWrapper.exists()).toBe(true)
    const el = inputWrapper.element as HTMLElement
    expect(el.style.viewTransitionName || el.getAttribute('style')).toBeTruthy()
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
})
