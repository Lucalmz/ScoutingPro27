import { mount, flushPromises, VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import DashboardView from '../views/DashboardView.vue'
import { useUserStore } from '../stores/user'
import { useEventStore } from '../stores/events'
import { useToastStore } from '../stores/toast'
import { isDesktopHost } from '@/services/photoStorage'
import * as isMobileComposable from '@/composables/useIsMobile'
import { hasDesktopTitleBar } from '@/utils/desktopShell'

const mockPush = vi.fn()
const mockReplace = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace
  })
}))

const mockSwitchLanguage = vi.fn()
vi.mock('@/i18n', () => ({
  switchLanguage: (...args: any[]) => mockSwitchLanguage(...args),
  i18n: {
    global: {
      t: (key: string) => key,
      locale: { value: 'zh' }
    }
  }
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: { value: 'zh' }
  }),
  createI18n: () => ({
    global: {
      t: (key: string) => key
    }
  })
}))

vi.mock('@/services/photoStorage', () => ({
  isDesktopHost: vi.fn(() => true)
}))

import { transitionState } from '@/utils/transitionState'

describe('DashboardView.vue & desktopShell', () => {
  const wrappers: VueWrapper[] = []
  const track = (w: VueWrapper) => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    transitionState.sharedElementId = null
    transitionState.activeToken = null
    mockPush.mockClear()
    mockReplace.mockClear()
    vi.clearAllMocks()
    vi.mocked(isDesktopHost).mockReturnValue(true)
  })

  afterEach(() => {
    while (wrappers.length > 0) {
      wrappers.pop()!.unmount()
    }
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/')
  })

  it('hasDesktopTitleBar detects ?shell=desktop accurately', () => {
    window.history.replaceState({}, '', '/index.html?shell=desktop#/dashboard')
    expect(hasDesktopTitleBar()).toBe(true)

    window.history.replaceState({}, '', '/index.html#/dashboard')
    expect(hasDesktopTitleBar()).toBe(false)

    window.history.replaceState({}, '', '/index.html?join=ABC123&shell=web#/')
    expect(hasDesktopTitleBar()).toBe(false)
  })

  it('redirects to / when user is not logged in', async () => {
    const userStore = useUserStore()
    userStore.user = null

    track(mount(DashboardView))
    await flushPromises()

    expect(mockReplace).toHaveBeenCalledWith('/')
  })

  it('renders empty state when user is logged in but has no events', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }

    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    expect(wrapper.text()).toContain('dashboard.no_events')
  })

  it('renders event list and navigates on event card click', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }

    const eventStore = useEventStore()
    eventStore.events = [
      { id: 'evt-1', name: 'FTC Championship', inviteCode: 'ABCDEF', hostId: 'u1', ftcEventCode: 'CMP2026' }
    ]
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    expect(wrapper.text()).toContain('FTC Championship')
    expect(wrapper.text()).toContain('ABCDEF')
    expect(wrapper.text()).toContain('CMP2026')

    const card = wrapper.find('.event-card')
    expect(card.exists()).toBe(true)
    await card.trigger('click')
    expect(card.classes()).toContain('slide-out-right')
    await flushPromises()

    expect(mockPush).toHaveBeenCalledWith('/event/evt-1')
  })

  it('creates an event and navigates to the new event view', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'HostUser', token: 'token' }

    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)
    vi.spyOn(eventStore, 'create').mockResolvedValue({
      id: 'new-evt-123',
      name: 'Super Regional',
      inviteCode: 'SUPER1',
      hostId: 'u1'
    })

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    const createBtn = wrapper.findAll('.action-btn').find((b) => b.text().includes('dashboard.create_event'))
    expect(createBtn).toBeDefined()
    await createBtn!.trigger('click')

    const input = wrapper.find('.modal-card input')
    expect(input.exists()).toBe(true)
    await input.setValue('Super Regional')

    await wrapper.find('.btn-confirm').trigger('click')
    await flushPromises()

    expect(eventStore.create).toHaveBeenCalledWith('Super Regional')
    expect(mockPush).toHaveBeenCalledWith('/event/new-evt-123')
  })

  it('joins an event with uppercase normalized invite code and navigates', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u2', username: 'ScoutUser', token: 'token' }

    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)
    vi.spyOn(eventStore, 'join').mockResolvedValue({
      id: 'joined-evt-456',
      name: 'Joined Event',
      inviteCode: 'JOIN99',
      hostId: 'host-1'
    })

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    const joinBtn = wrapper.findAll('.action-btn').find((b) => b.text().includes('dashboard.join_event'))
    expect(joinBtn).toBeDefined()
    await joinBtn!.trigger('click')

    const input = wrapper.find('.modal-card input')
    expect(input.exists()).toBe(true)
    await input.setValue('join99')

    await wrapper.find('.btn-confirm').trigger('click')
    await flushPromises()

    expect(eventStore.join).toHaveBeenCalledWith('JOIN99', 'Joined Event')
    expect(mockPush).toHaveBeenCalledWith('/event/joined-evt-456')
  })

  it('imports offline event package and navigates into imported event', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'HostUser', token: 'token' }

    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)
    const syncExternalSpy = vi.spyOn(eventStore, 'syncExternal').mockImplementation(async (evt) => {
      eventStore.events.push(evt)
      return evt
    })

    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    const samplePackage = JSON.stringify({
      format: 'SCOUTING_PRO_27_EVENT',
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: { userId: 'u1', username: 'HostUser', role: 'HOST' },
      event: {
        id: 'pkg-evt-789',
        name: 'Offline Championship',
        inviteCode: 'OFFPKG',
        hostId: 'u1'
      }
    })

    const file = new File([samplePackage], 'event.json', { type: 'application/json' })
    file.text = vi.fn().mockResolvedValue(samplePackage)
    const fileInput = wrapper.find('input[type="file"]')
    expect(fileInput.exists()).toBe(true)

    Object.defineProperty(fileInput.element, 'files', {
      value: [file],
      writable: true
    })
    await fileInput.trigger('change')
    await flushPromises()

    expect(syncExternalSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'pkg-evt-789' }))
    expect(eventStore.events.some((e) => e.id === 'pkg-evt-789')).toBe(true)
    expect(toastSpy).toHaveBeenCalledWith('offline_sync.import_success_event', 'info')
    expect(mockPush).toHaveBeenCalledWith('/event/pkg-evt-789')
  })

  it('does NOT render persistent account-merge-btn in topbar', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }
    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    expect(wrapper.find('.dashboard').exists()).toBe(true)
    expect(wrapper.find('.btn-logout').exists()).toBe(true)
    expect(wrapper.find('.account-merge-btn').exists()).toBe(false)
  })

  it('renders delete button on event card and deletes event upon confirmation', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }
    const eventStore = useEventStore()
    eventStore.events = [
      { id: 'evt-ghost-1', name: 'Ghost Event', inviteCode: 'SPWNSH', hostId: 'u1' }
    ]
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)
    const deleteSpy = vi.spyOn(eventStore, 'deleteEvent').mockResolvedValue(undefined)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    const deleteBtn = wrapper.find('.btn-card-delete')
    expect(deleteBtn.exists()).toBe(true)

    await deleteBtn.trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalled()
    expect(deleteSpy).toHaveBeenCalledWith('evt-ghost-1')
  })

  it('does NOT render clear cache button on desktop host', async () => {
    vi.mocked(isDesktopHost).mockReturnValue(true)

    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }
    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    expect(wrapper.find('.dashboard').exists()).toBe(true)
    expect(wrapper.find('.btn-logout').exists()).toBe(true)
    expect(wrapper.find('.clear-cache-btn').exists()).toBe(false)
  })

  it('renders clear cache button on mobile client and clears all offline cache upon confirmation', async () => {
    vi.mocked(isDesktopHost).mockReturnValue(false)

    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }
    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)
    const clearSpy = vi.spyOn(eventStore, 'clearAllLocalCache')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    const clearBtn = wrapper.find('.clear-cache-btn')
    expect(clearBtn.exists()).toBe(true)

    await clearBtn.trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalled()
    expect(clearSpy).toHaveBeenCalled()
  })

  it('does NOT render scan-to-join button or modal scan icon on desktop host even on narrow viewport', async () => {
    vi.mocked(isDesktopHost).mockReturnValue(true)
    vi.spyOn(isMobileComposable, 'useIsMobile').mockReturnValue({ isMobile: ref(true) } as any)

    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }
    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    expect(wrapper.find('.dashboard').exists()).toBe(true)
    expect(wrapper.find('.action-buttons').exists()).toBe(true)
    expect(wrapper.find('.btn-logout').exists()).toBe(true)
    expect(wrapper.find('.scan-btn').exists()).toBe(false)

    const joinBtn = wrapper.findAll('.action-btn').find((b) => b.text().includes('dashboard.join_event'))
    expect(joinBtn).toBeDefined()
    await joinBtn!.trigger('click')
    expect(wrapper.find('.modal-card .join-input-group input').exists()).toBe(true)
    expect(wrapper.find('.btn-scan-input').exists()).toBe(false)
  })

  it('renders scan-to-join button and modal scan icon on mobile client', async () => {
    vi.mocked(isDesktopHost).mockReturnValue(false)
    vi.spyOn(isMobileComposable, 'useIsMobile').mockReturnValue({ isMobile: ref(true) } as any)

    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }
    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    expect(wrapper.find('.scan-btn').exists()).toBe(true)
    const joinBtn = wrapper.findAll('.action-btn').find((b) => b.text().includes('dashboard.join_event'))
    expect(joinBtn).toBeDefined()
    await joinBtn!.trigger('click')
    expect(wrapper.find('.modal-card .join-input-group input').exists()).toBe(true)
    expect(wrapper.find('.btn-scan-input').exists()).toBe(true)
  })

  it('renders language toggle button and toggles language on click', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }
    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    const langBtn = wrapper.find('.lang-topbar-btn')
    expect(langBtn.exists()).toBe(true)
    await langBtn.trigger('click')
    expect(mockSwitchLanguage).toHaveBeenCalledWith('en')
  })

  it('renders contextual page heading instead of duplicate brand inside desktop titlebar shell', async () => {
    window.history.replaceState({}, '', '/index.html?shell=desktop#/dashboard')

    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }
    const eventStore = useEventStore()
    eventStore.events = [
      { id: 'evt-1', name: 'FTC Championship', inviteCode: 'ABCDEF', hostId: 'u1' },
      { id: 'evt-2', name: 'Scrimmage', inviteCode: 'SCRIM2', hostId: 'u1' }
    ]
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    expect(wrapper.find('.topbar').classes()).toContain('is-desktop-shell')
    expect(wrapper.find('.page-heading').exists()).toBe(true)
    expect(wrapper.find('.page-heading-title').text()).toBe('dashboard.title')
    expect(wrapper.find('.page-heading-count').text()).toBe('2')
    expect(wrapper.find('.brand').exists()).toBe(false)
    expect(wrapper.find('.brand-logo').exists()).toBe(false)
  })

  it('renders ScoutingPro 27 brand logo and title in standalone web/browser mode', async () => {
    window.history.replaceState({}, '', '/index.html#/dashboard')

    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }
    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)

    const wrapper = track(mount(DashboardView))
    await flushPromises()

    expect(wrapper.find('.topbar').classes()).not.toContain('is-desktop-shell')
    expect(wrapper.find('.brand').exists()).toBe(true)
    expect(wrapper.find('.brand-logo').exists()).toBe(true)
    expect(wrapper.find('.brand').text()).toContain('ScoutingPro 27')
    expect(wrapper.find('.page-heading').exists()).toBe(false)
  })
})
