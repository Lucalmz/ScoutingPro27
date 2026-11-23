import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import HistoryList from '../components/history/HistoryList.vue'
import * as api from '../services/api'
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

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>()
  return {
    ...actual,
    markRecordsSynced: vi.fn().mockResolvedValue(undefined)
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
    isConflict: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rawData: '{}',
    ...overrides
  } as ScoutingRecord
}

describe('HistoryList.vue Component & Animations', () => {
  const mountedWrappers: any[] = []
  const mountHistory = (options: any) => {
    const w = mount(HistoryList, options)
    mountedWrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    mockRoute.query = {}
    vi.clearAllMocks()
    vi.mocked(api.markRecordsSynced).mockResolvedValue(undefined)
  })

  afterEach(() => {
    while (mountedWrappers.length > 0) {
      mountedWrappers.pop()?.unmount()
    }
    vi.restoreAllMocks()
  })

  it('renders loading state when loading prop is true', () => {
    const wrapper = mountHistory({
      props: {
        records: [],
        loading: true
      }
    })
    expect(wrapper.find('.loading-msg').exists()).toBe(true)
    expect(wrapper.find('.loading-msg').text()).toBe('history.loading')
  })

  it('renders empty state when there are no records and not loading', () => {
    const wrapper = mountHistory({
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
    const wrapper = mountHistory({
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
    const wrapper = mountHistory({
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
    const wrapper = mountHistory({
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
    const wrapper = mountHistory({
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
    const wrapper = mountHistory({
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
    const wrapper = mountHistory({
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

  it('updates hover-highlight position on card mouseenter and hides on list mouseleave', async () => {
    const wrapper = mountHistory({
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

  it('correctly distinguishes synced records and pending records without legacy hostSeq', async () => {
    const { useEventStore } = await import('../stores/events')
    const { useUserStore } = await import('../stores/user')
    const eventStore = useEventStore()
    const userStore = useUserStore()

    // Non-host scout viewing their own records (neither has hostSeq!)
    eventStore.currentEvent = { id: 'evt-1', hostId: 'host-user' } as any
    userStore.user = { id: 'scout-1', username: 'Tester', token: 'tok' } as any

    const records = [
      createRecord({ id: 'r-synced', scoutId: 'scout-1', syncStatus: 'SYNCED' }),
      createRecord({ id: 'r-pending', scoutId: 'scout-1', syncStatus: 'PENDING' })
    ]
    const wrapper = mountHistory({
      props: {
        records,
        loading: false
      }
    })

    const cards = wrapper.findAll('.history-card')
    // First card is own SYNCED record without hostSeq -> MUST NOT show Resync button!
    expect(cards[0].find('.sync-badge').text()).toBe('check_circle')
    expect(cards[0].find('.sync-badge').classes()).toContain('is-synced')
    expect(cards[0].find('.btn-edit').exists()).toBe(true)
    expect(cards[0].find('.btn-resync').exists()).toBe(false)

    // Second card is own PENDING record -> rendered with pending icon, editable AND resyncable
    expect(cards[1].find('.sync-badge').text()).toBe('hourglass_empty')
    expect(cards[1].find('.sync-badge').classes()).toContain('is-pending')
    expect(cards[1].find('.btn-edit').exists()).toBe(true)
    expect(cards[1].find('.btn-resync').exists()).toBe(true)
  })

  it('triggers CRDT sync, marks SYNCED, and removes resync button when clicked online', async () => {
    const { useEventStore } = await import('../stores/events')
    const { useUserStore } = await import('../stores/user')
    const { useConnectionStore } = await import('../stores/connection')
    const { useToastStore } = await import('../stores/toast')
    const { useRecordStore } = await import('../stores/records')
    const crdtMod = await import('../services/crdt')
    await crdtMod.resetCrdtRegistryForTesting()

    const eventStore = useEventStore()
    const userStore = useUserStore()
    const recordStore = useRecordStore()
    eventStore.currentEvent = { id: 'evt-1', hostId: 'host-user' } as any
    userStore.user = { id: 'scout-1', username: 'Tester', token: 'tok' } as any

    const handle = crdtMod.getOrCreateEventCrdt('evt-1', {
      deviceId: 'dev-scout-1',
      enableHttp: false,
      enableIndexedDb: false
    })

    const connStore = useConnectionStore()
    connStore.status = 'connected'
    const crdtSyncSpy = vi.fn().mockResolvedValue(true)
    connStore.setCrdtSyncTrigger(crdtSyncSpy)

    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    const unconfirmed = createRecord({ id: 'r-unconfirmed', scoutId: 'scout-1', syncStatus: 'PENDING' })
    recordStore.records = [unconfirmed]
    const wrapper = mountHistory({
      props: {
        records: [unconfirmed],
        loading: false
      }
    })

    const resyncBtn = wrapper.find('.btn-resync')
    expect(resyncBtn.exists()).toBe(true)
    await resyncBtn.trigger('click')
    await vi.waitFor(async () => {
      await nextTick()
      expect(crdtSyncSpy).toHaveBeenCalledWith('host')
      const crdtRec = crdtMod.readScoutingRecordsFromCrdt(handle.store, 'evt-1').find((r) => r.id === 'r-unconfirmed')
      expect(crdtRec).toBeDefined()
      expect(crdtRec?.authorPubKey).toBeTruthy()
      expect(crdtRec?.authorSig).toBeTruthy()
      expect(await crdtMod.verifyScoutingRecordSignature(crdtRec!)).toBe(true)
      expect(unconfirmed.syncStatus).toBe('SYNCED')
      expect(toastSpy).toHaveBeenCalledWith('history.resync_triggered', 'info')
      expect(wrapper.find('.btn-resync').exists()).toBe(false)
    }, { timeout: 1500 })

    await crdtMod.resetCrdtRegistryForTesting()
  })

  it('refuses to mark SYNCED and keeps resync button when device ECDSA signing fails online', async () => {
    const { useEventStore } = await import('../stores/events')
    const { useUserStore } = await import('../stores/user')
    const { useConnectionStore } = await import('../stores/connection')
    const { useToastStore } = await import('../stores/toast')

    const eventStore = useEventStore()
    const userStore = useUserStore()
    eventStore.currentEvent = { id: 'evt-1', hostId: 'host-user' } as any
    userStore.user = { id: 'scout-1', username: 'Tester', token: 'tok' } as any

    const connStore = useConnectionStore()
    connStore.status = 'connected'
    const crdtSyncSpy = vi.fn().mockResolvedValue(true)
    connStore.setCrdtSyncTrigger(crdtSyncSpy)

    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')
    vi.spyOn(globalThis.crypto.subtle, 'sign').mockRejectedValue(new Error('WebCrypto disabled'))

    const unconfirmed = createRecord({ id: 'r-unsigned-fail', scoutId: 'scout-1', syncStatus: 'PENDING' })
    const wrapper = mountHistory({
      props: {
        records: [unconfirmed],
        loading: false
      }
    })

    const resyncBtn = wrapper.find('.btn-resync')
    expect(resyncBtn.exists()).toBe(true)
    await resyncBtn.trigger('click')

    await vi.waitFor(async () => {
      await nextTick()
      expect(toastSpy).toHaveBeenCalledWith('history.resync_offline_queued', 'warning')
    }, { timeout: 1500 })

    expect(crdtSyncSpy).not.toHaveBeenCalled()
    expect(unconfirmed.syncStatus).toBe('PENDING')
    expect(wrapper.find('.btn-resync').exists()).toBe(true)
  })

  it('keeps PENDING status and shows warning toast when CRDT sync trigger fails online', async () => {
    const { useEventStore } = await import('../stores/events')
    const { useUserStore } = await import('../stores/user')
    const { useConnectionStore } = await import('../stores/connection')
    const { useToastStore } = await import('../stores/toast')

    const eventStore = useEventStore()
    const userStore = useUserStore()
    eventStore.currentEvent = { id: 'evt-1', hostId: 'host-user' } as any
    userStore.user = { id: 'scout-1', username: 'Tester', token: 'tok' } as any

    const connStore = useConnectionStore()
    connStore.status = 'connected'
    connStore.setCrdtSyncTrigger(vi.fn().mockResolvedValue(false))

    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    const unconfirmed = createRecord({ id: 'r-unconfirmed-fail', scoutId: 'scout-1', syncStatus: 'PENDING' })
    const wrapper = mountHistory({
      props: {
        records: [unconfirmed],
        loading: false
      }
    })

    await wrapper.find('.btn-resync').trigger('click')
    await vi.waitFor(async () => {
      await nextTick()
      expect(unconfirmed.syncStatus).toBe('PENDING')
      expect(toastSpy).toHaveBeenCalledWith('history.resync_offline_queued', 'warning')
      expect(wrapper.find('.btn-resync').exists()).toBe(true)
    }, { timeout: 1500 })
  })

  it('shows offline queued toast when re-sync button is clicked while offline', async () => {
    const { useEventStore } = await import('../stores/events')
    const { useUserStore } = await import('../stores/user')
    const { useConnectionStore } = await import('../stores/connection')
    const { useToastStore } = await import('../stores/toast')

    const eventStore = useEventStore()
    const userStore = useUserStore()
    eventStore.currentEvent = { id: 'evt-1', hostId: 'host-user' } as any
    userStore.user = { id: 'scout-1', username: 'Tester', token: 'tok' } as any

    const connStore = useConnectionStore()
    connStore.status = 'offline'
    const crdtSyncSpy = vi.fn().mockResolvedValue(true)
    connStore.setCrdtSyncTrigger(crdtSyncSpy)

    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    const unconfirmed = createRecord({ id: 'r-unconfirmed-off', scoutId: 'scout-1', syncStatus: 'PENDING' })
    const wrapper = mountHistory({
      props: {
        records: [unconfirmed],
        loading: false
      }
    })

    const resyncBtn = wrapper.find('.btn-resync')
    expect(resyncBtn.exists()).toBe(true)
    await resyncBtn.trigger('click')
    await vi.waitFor(async () => {
      await nextTick()
      expect(crdtSyncSpy).not.toHaveBeenCalled()
      expect(unconfirmed.syncStatus).toBe('PENDING')
      expect(toastSpy).toHaveBeenCalledWith('history.resync_offline_queued', 'warning')
    }, { timeout: 1500 })
  })

  it('never renders resync button for active Host even if record is PENDING, but allows Standby Host for own PENDING records', async () => {
    const { useEventStore } = await import('../stores/events')
    const { useUserStore } = await import('../stores/user')
    const { useConnectionStore } = await import('../stores/connection')
    const photoStorage = await import('../services/photoStorage')
    const mobileMod = await import('../composables/useIsMobile')
    vi.spyOn(photoStorage, 'isDesktopHost').mockReturnValue(true)
    vi.spyOn(mobileMod, 'isMobileDevice').mockReturnValue(false)

    const eventStore = useEventStore()
    const userStore = useUserStore()
    const connStore = useConnectionStore()
    userStore.user = { id: 'host-user', username: 'Host', token: 'tok' } as any
    eventStore.currentEvent = { id: 'evt-1', hostId: 'host-user' } as any

    const pendingOwn = createRecord({ id: 'r-host-pending', scoutId: 'host-user', syncStatus: 'PENDING' })
    const syncedOwn = createRecord({ id: 'r-host-synced', scoutId: 'host-user', syncStatus: 'SYNCED' })

    // 1. Active Host: cards & edit buttons render, but no resync button
    connStore.setStandbyHost(false)
    expect(eventStore.isHost).toBe(true)
    const activeHostWrapper = mountHistory({
      props: { records: [pendingOwn, syncedOwn], loading: false }
    })
    expect(activeHostWrapper.findAll('.history-card')).toHaveLength(2)
    expect(activeHostWrapper.findAll('.btn-edit')).toHaveLength(2)
    expect(activeHostWrapper.findAll('.btn-resync')).toHaveLength(0)

    // 2. Standby Host: resync button shown ONLY for own PENDING record, not SYNCED
    connStore.setStandbyHost(true, { hostSessionId: 'other-host-sess' })
    const standbyWrapper = mountHistory({
      props: { records: [pendingOwn, syncedOwn], loading: false }
    })
    const standbyCards = standbyWrapper.findAll('.history-card')
    expect(standbyCards[0].find('.btn-resync').exists()).toBe(true)
    expect(standbyCards[1].find('.btn-resync').exists()).toBe(false)
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
      isConflict: false
    })

    const wrapper = mountHistory({
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

  it('allows normal scout to edit their own synced record without rendering resync button', async () => {
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
      isConflict: false
    })
    const otherRecord = createRecord({
      id: 'r-bob-synced',
      scoutId: 'scout-bob',
      syncStatus: 'SYNCED',
      isConflict: false
    })

    const wrapper = mountHistory({
      props: {
        records: [myRecord, otherRecord],
        loading: false
      }
    })

    const cards = wrapper.findAll('.history-card')
    // Alice can edit her own synced record and sees NO resync button
    expect(cards[0].find('.btn-edit').exists()).toBe(true)
    expect(cards[0].find('.btn-resync').exists()).toBe(false)
    // Alice cannot edit Bob's synced record and sees NO resync button
    expect(cards[1].find('.btn-edit').exists()).toBe(false)
    expect(cards[1].find('.btn-resync').exists()).toBe(false)
  })

  it('renders BIOBUZZ endgame summary pills and predict cycle badge when present in rawData', () => {
    const rec = createRecord({
      id: 'r-biobuzz',
      rawData: JSON.stringify({
        teleopPark: true,
        flowerNectars: 4,
        flowerBottomBonusCount: 2,
        flowerPollens: 3,
        gardenBalls: 1,
        flowerDescore: true,
        g410EarlyFlowerFoul: true,
        predictCycleTimeSec: 10.5
      })
    })
    const wrapper = mountHistory({
      props: {
        records: [rec],
        loading: false
      }
    })

    const strip = wrapper.find('.card-biobuzz-pills')
    expect(strip.exists()).toBe(true)
    expect(strip.find('.biobuzz-pill.is-park').exists()).toBe(true)
    expect(strip.find('.biobuzz-pill.is-descore').exists()).toBe(true)
    expect(strip.find('.biobuzz-pill.is-foul').exists()).toBe(true)
    expect(strip.find('.biobuzz-pill.is-cycle').text()).toContain('10.5s')
  })
})
