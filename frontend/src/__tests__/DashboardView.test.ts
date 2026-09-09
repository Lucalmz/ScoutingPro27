import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import DashboardView from '../views/DashboardView.vue'
import { useUserStore } from '../stores/user'
import { useEventStore } from '../stores/events'
import { useToastStore } from '../stores/toast'

const mockPush = vi.fn()
const mockReplace = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace
  })
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
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

describe('DashboardView.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockPush.mockClear()
    mockReplace.mockClear()
    vi.clearAllMocks()
  })

  it('redirects to / when user is not logged in', async () => {
    const userStore = useUserStore()
    userStore.user = null // not logged in

    mount(DashboardView)
    await new Promise((r) => setTimeout(r, 10))

    expect(mockReplace).toHaveBeenCalledWith('/')
  })

  it('renders empty state when user is logged in but has no events', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester', token: 'token' }

    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)

    const wrapper = mount(DashboardView)
    await new Promise((r) => setTimeout(r, 10))

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

    const wrapper = mount(DashboardView)
    await new Promise((r) => setTimeout(r, 10))

    expect(wrapper.text()).toContain('FTC Championship')
    expect(wrapper.text()).toContain('ABCDEF')
    expect(wrapper.text()).toContain('CMP2026')

    const card = wrapper.find('.event-card')
    expect(card.exists()).toBe(true)
    await card.trigger('click')
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 10))

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

    const wrapper = mount(DashboardView)
    await new Promise((r) => setTimeout(r, 10))

    // Open create modal
    const createBtn = wrapper.findAll('.action-btn').find((b) => b.text().includes('dashboard.create_event'))
    expect(createBtn).toBeDefined()
    await createBtn!.trigger('click')

    // Find input in modal and type event name
    const input = wrapper.find('.modal-card input')
    expect(input.exists()).toBe(true)
    await input.setValue('Super Regional')

    // Confirm creation
    const confirmBtn = wrapper.find('.btn-confirm')
    await confirmBtn.trigger('click')
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 10))

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

    const wrapper = mount(DashboardView)
    await new Promise((r) => setTimeout(r, 10))

    // Open join modal
    const joinBtn = wrapper.findAll('.action-btn').find((b) => b.text().includes('dashboard.join_event'))
    expect(joinBtn).toBeDefined()
    await joinBtn!.trigger('click')

    // Enter lowercase code
    const input = wrapper.find('.modal-card input')
    expect(input.exists()).toBe(true)
    await input.setValue('join99')

    // Confirm join
    const confirmBtn = wrapper.find('.btn-confirm')
    await confirmBtn.trigger('click')
    await wrapper.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 10))

    expect(eventStore.join).toHaveBeenCalledWith('JOIN99', 'Joined Event')
    expect(mockPush).toHaveBeenCalledWith('/event/joined-evt-456')
  })

  it('imports offline event package and navigates into imported event', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'HostUser', token: 'token' }

    const eventStore = useEventStore()
    eventStore.events = []
    vi.spyOn(eventStore, 'fetchEvents').mockResolvedValue(undefined)

    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    const wrapper = mount(DashboardView)
    await new Promise((r) => setTimeout(r, 10))

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

    // Trigger change event with file
    Object.defineProperty(fileInput.element, 'files', {
      value: [file],
      writable: true
    })
    await fileInput.trigger('change')
    await new Promise((r) => setTimeout(r, 50))

    expect(eventStore.events.some((e) => e.id === 'pkg-evt-789')).toBe(true)
    expect(toastSpy).toHaveBeenCalledWith('offline_sync.import_success_event', 'info')
    expect(mockPush).toHaveBeenCalledWith('/event/pkg-evt-789')
  })
})
