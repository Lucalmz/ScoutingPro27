import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import HistoryList from '../components/history/HistoryList.vue'
import { useRecordStore } from '../stores/records'
import type { ScoutingRecord } from '../types'

const mockRoute = {
  params: { id: 'evt-1' },
  query: {} as Record<string, string>
}

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn()
  })
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => key
    })
  }
})

function createRecord(overrides: Partial<ScoutingRecord> = {}): ScoutingRecord {
  return {
    id: 'rec-' + Math.random().toString(36).slice(2, 7),
    eventId: 'evt-1',
    scoutId: 'scout-1',
    scoutName: 'Tester',
    teamNumber: 27570,
    matchNumber: 1,
    autoScore: 30,
    teleopScore: 50,
    endgameScore: 20,
    totalScore: 100,
    syncStatus: 'SYNCED',
    hostSeq: 1,
    isConflict: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rawData: '{}',
    ...overrides
  } as ScoutingRecord
}

describe('HistoryList.vue Component & Animations', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockRoute.query = {}
    vi.clearAllMocks()
  })

  it('renders loading state when loading prop is true', () => {
    const wrapper = mount(HistoryList, {
      props: {
        records: [],
        loading: true
      }
    })
    expect(wrapper.find('.loading-msg').exists()).toBe(true)
    expect(wrapper.find('.loading-msg').text()).toBe('history.loading')
  })

  it('renders empty state when there are no records and not loading', () => {
    const wrapper = mount(HistoryList, {
      props: {
        records: [],
        loading: false
      }
    })
    expect(wrapper.find('.empty-state').exists()).toBe(true)
    expect(wrapper.find('.empty-state').text()).toContain('history.no_data')
  })

  it('renders record list with scores and match information', () => {
    const records = [
      createRecord({ id: 'r1', matchNumber: 3, teamNumber: 27570, totalScore: 120 }),
      createRecord({ id: 'r2', matchNumber: 4, teamNumber: 27570, totalScore: 140 })
    ]
    const wrapper = mount(HistoryList, {
      props: {
        records,
        loading: false
      }
    })

    const cards = wrapper.findAll('.history-card')
    expect(cards.length).toBe(2)
    expect(wrapper.text()).toContain('120 history.pts')
    expect(wrapper.text()).toContain('140 history.pts')
    expect(wrapper.text()).toContain('Tester')
    expect(wrapper.text()).not.toContain('scout-1')
  })

  it('displays fallback username and never exposes raw scoutId when scoutName is absent', () => {
    const records = [
      createRecord({ id: 'r1', scoutId: 'usr_xyz999', scoutName: '' })
    ]
    const wrapper = mount(HistoryList, {
      props: {
        records,
        loading: false
      }
    })

    const scoutBadge = wrapper.find('.card-scout-id')
    expect(scoutBadge.exists()).toBe(true)
    expect(scoutBadge.text()).toContain('history.anonymous_scout')
    expect(scoutBadge.text()).not.toContain('usr_xyz999')
  })

  it('resolves current user username when scoutName is absent but scoutId matches currentUser', async () => {
    const { useUserStore } = await import('../stores/user')
    const userStore = useUserStore()
    userStore.user = { id: 'usr_me', username: 'MySpecialUsername', token: 'tok' } as any

    const records = [
      createRecord({ id: 'r1', scoutId: 'usr_me', scoutName: '' })
    ]
    const wrapper = mount(HistoryList, {
      props: {
        records,
        loading: false
      }
    })

    const scoutBadge = wrapper.find('.card-scout-id')
    expect(scoutBadge.exists()).toBe(true)
    expect(scoutBadge.text()).toContain('MySpecialUsername')
    expect(scoutBadge.text()).not.toContain('usr_me')
  })

  it('applies is-conflict-card class and displays conflict badge when isConflict is true', () => {
    const records = [
      createRecord({ id: 'r-normal', isConflict: false }),
      createRecord({ id: 'r-conflict', isConflict: true, syncStatus: 'SYNCED' })
    ]
    const wrapper = mount(HistoryList, {
      props: {
        records,
        loading: false
      }
    })

    const cards = wrapper.findAll('.history-card')
    expect(cards[0].classes()).not.toContain('is-conflict-card')
    expect(cards[1].classes()).toContain('is-conflict-card')

    const badge = cards[1].find('.conflict-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('toast.conflict_badge')

    // Conflicted records allow editing even if syncStatus is SYNCED
    const editBtn = cards[1].find('.btn-edit')
    expect(editBtn.exists()).toBe(true)
    expect(editBtn.classes()).toContain('btn-edit-conflict')
  })

  it('highlights conflict when matching route query parameters', () => {
    mockRoute.query = { highlightMatch: '5', highlightTeam: '27570' }
    const records = [
      createRecord({ id: 'r-other', matchNumber: 2, teamNumber: 27570 }),
      createRecord({ id: 'r-target', matchNumber: 5, teamNumber: 27570 })
    ]
    const wrapper = mount(HistoryList, {
      props: {
        records,
        loading: false
      }
    })

    const cards = wrapper.findAll('.history-card')
    expect(cards[0].classes()).not.toContain('highlight-conflict')
    expect(cards[1].classes()).toContain('highlight-conflict')
  })

  it('emits editRecord event when edit button is clicked', async () => {
    const conflictRecord = createRecord({ id: 'r-edit', isConflict: true })
    const wrapper = mount(HistoryList, {
      props: {
        records: [conflictRecord],
        loading: false
      }
    })

    const editBtn = wrapper.find('.btn-edit')
    expect(editBtn.exists()).toBe(true)
    await editBtn.trigger('click')

    expect(wrapper.emitted('editRecord')).toBeTruthy()
    expect(wrapper.emitted('editRecord')![0]).toEqual([conflictRecord])
  })

  it('cleans up inline transition, opacity, and transform in enter hook so pulse-conflict animation is not overridden', async () => {
    vi.useFakeTimers()
    const wrapper = mount(HistoryList, {
      props: {
        records: [createRecord({ id: 'r-anim', isConflict: true })],
        loading: false
      }
    })

    const dummyEl = document.createElement('div')
    dummyEl.dataset.index = '0'
    document.body.appendChild(dummyEl)

    // Access vm methods
    const vm = wrapper.vm as any

    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })

    // 1. Test beforeEnter
    vm.beforeEnter(dummyEl)
    expect(dummyEl.style.opacity).toBe('0')
    expect(dummyEl.style.transform).toBe('translateY(20px)')

    // 2. Test enter
    let doneCalled = false
    vm.enter(dummyEl, () => {
      doneCalled = true
    })

    // Advance timers for delay + transition duration (40ms + 360ms)
    vi.advanceTimersByTime(500)

    // Assert done was invoked
    expect(doneCalled).toBe(true)

    // Verify inline styles are cleanly removed (vital so @keyframes pulse-conflict takes over)
    expect(dummyEl.style.opacity).toBe('')
    expect(dummyEl.style.transform).toBe('')
    expect(dummyEl.style.transition).toBe('')

    rafSpy.mockRestore()
    document.body.removeChild(dummyEl)
    vi.useRealTimers()
  })

  it('updates hover-highlight position on card mouseenter and hides on list mouseleave', async () => {
    const wrapper = mount(HistoryList, {
      props: {
        records: [createRecord({ id: 'r-hover' })],
        loading: false
      }
    })

    const highlightEl = wrapper.find('.hover-highlight')
    expect(highlightEl.exists()).toBe(true)
    expect((highlightEl.element as HTMLElement).style.opacity).toBe('0')

    const card = wrapper.find('.history-card')
    // Trigger mouseenter with mock offset properties
    Object.defineProperty(card.element, 'offsetTop', { value: 45, configurable: true })
    Object.defineProperty(card.element, 'offsetHeight', { value: 60, configurable: true })

    await card.trigger('mouseenter')

    expect((highlightEl.element as HTMLElement).style.opacity).toBe('1')
    expect((highlightEl.element as HTMLElement).style.top).toBe('45px')
    expect((highlightEl.element as HTMLElement).style.height).toBe('60px')

    // Trigger mouseleave on list
    const list = wrapper.find('.history-list')
    await list.trigger('mouseleave')

    expect((highlightEl.element as HTMLElement).style.opacity).toBe('0')
  })

  it('correctly distinguishes authoritative synced records and unstamped pending records', () => {
    const records = [
      createRecord({ id: 'r-synced', hostSeq: 42, syncStatus: 'SYNCED' }),
      createRecord({ id: 'r-unstamped', hostSeq: undefined, syncStatus: 'SYNCED' })
    ]
    const wrapper = mount(HistoryList, {
      props: {
        records,
        loading: false
      }
    })

    const cards = wrapper.findAll('.history-card')
    // First card is stamped and synced
    expect(cards[0].find('.sync-badge').text()).toBe('check_circle')
    expect(cards[0].find('.btn-edit').exists()).toBe(false)
    expect(cards[0].find('.btn-resync').exists()).toBe(false)

    // Second card lacks hostSeq -> rendered as pending and editable/resyncable
    expect(cards[1].find('.sync-badge').text()).toBe('hourglass_empty')
    expect(cards[1].find('.btn-edit').exists()).toBe(true)
  })

  it('triggers pushRecords and toast when re-sync button is clicked online', async () => {
    const { useUserStore } = await import('../stores/user')
    const { useConnectionStore } = await import('../stores/connection')
    const { useToastStore } = await import('../stores/toast')

    const userStore = useUserStore()
    userStore.user = { id: 'scout-1', username: 'Tester', token: 'tok' } as any

    const connStore = useConnectionStore()
    connStore.status = 'connected'
    const pushSpy = vi.spyOn(connStore, 'pushRecords').mockImplementation(() => {})

    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    const unconfirmed = createRecord({ id: 'r-unconfirmed', scoutId: 'scout-1', hostSeq: undefined, syncStatus: 'PENDING' })
    const wrapper = mount(HistoryList, {
      props: {
        records: [unconfirmed],
        loading: false
      }
    })

    const resyncBtn = wrapper.find('.btn-resync')
    expect(resyncBtn.exists()).toBe(true)
    await resyncBtn.trigger('click')

    expect(pushSpy).toHaveBeenCalledWith([unconfirmed])
    expect(toastSpy).toHaveBeenCalledWith('history.resync_triggered', 'info')
  })

  it('shows offline queued toast when re-sync button is clicked while offline', async () => {
    const { useUserStore } = await import('../stores/user')
    const { useConnectionStore } = await import('../stores/connection')
    const { useToastStore } = await import('../stores/toast')

    const userStore = useUserStore()
    userStore.user = { id: 'scout-1', username: 'Tester', token: 'tok' } as any

    const connStore = useConnectionStore()
    connStore.status = 'offline'
    const pushSpy = vi.spyOn(connStore, 'pushRecords').mockImplementation(() => {})

    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    const unconfirmed = createRecord({ id: 'r-unconfirmed-off', scoutId: 'scout-1', hostSeq: undefined, syncStatus: 'SYNCED' })
    const wrapper = mount(HistoryList, {
      props: {
        records: [unconfirmed],
        loading: false
      }
    })

    const resyncBtn = wrapper.find('.btn-resync')
    expect(resyncBtn.exists()).toBe(true)
    await resyncBtn.trigger('click')

    expect(pushSpy).not.toHaveBeenCalled()
    expect(unconfirmed.syncStatus).toBe('PENDING')
    expect(toastSpy).toHaveBeenCalledWith('history.resync_offline_queued', 'warning')
  })

  it('allows Host to edit any synced record regardless of ownership', async () => {
    const { useEventStore } = await import('../stores/events')
    const { useUserStore } = await import('../stores/user')
    const photoStorage = await import('../services/photoStorage')
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)

    const eventStore = useEventStore()
    const userStore = useUserStore()
    userStore.user = { id: 'host-user', username: 'Host', token: 'tok' } as any
    eventStore.currentEvent = { id: 'evt-1', hostId: 'host-user' } as any

    const otherScoutRecord = createRecord({
      id: 'r-other-scout',
      scoutId: 'scout-different-user',
      syncStatus: 'SYNCED',
      hostSeq: 10,
      isConflict: false
    })

    const wrapper = mount(HistoryList, {
      props: {
        records: [otherScoutRecord],
        loading: false
      }
    })

    const editBtn = wrapper.find('.btn-edit')
    expect(editBtn.exists()).toBe(true)
    await editBtn.trigger('click')
    expect(wrapper.emitted('editRecord')).toBeTruthy()
    expect(wrapper.emitted('editRecord')![0]).toEqual([otherScoutRecord])
  })

  it('allows normal scout to edit their own synced record but not others', async () => {
    const { useEventStore } = await import('../stores/events')
    const { useUserStore } = await import('../stores/user')
    const eventStore = useEventStore()
    const userStore = useUserStore()

    eventStore.currentEvent = { id: 'evt-1', hostId: 'someone-else' } as any
    userStore.user = { id: 'scout-alice', username: 'Alice', token: 'tok' } as any

    const myRecord = createRecord({
      id: 'r-my-synced',
      scoutId: 'scout-alice',
      syncStatus: 'SYNCED',
      hostSeq: 11,
      isConflict: false
    })
    const otherRecord = createRecord({
      id: 'r-bob-synced',
      scoutId: 'scout-bob',
      syncStatus: 'SYNCED',
      hostSeq: 12,
      isConflict: false
    })

    const wrapper = mount(HistoryList, {
      props: {
        records: [myRecord, otherRecord],
        loading: false
      }
    })

    const cards = wrapper.findAll('.history-card')
    // Alice can edit her own synced record
    expect(cards[0].find('.btn-edit').exists()).toBe(true)
    // Alice cannot edit Bob's synced record
    expect(cards[1].find('.btn-edit').exists()).toBe(false)
  })
})
