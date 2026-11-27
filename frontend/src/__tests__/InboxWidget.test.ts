import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import InboxWidget from '../components/common/InboxWidget.vue'
import { useInboxStore } from '../stores/inbox'
import { useUserStore } from '../stores/user'
import { useToastStore } from '../stores/toast'

const pushMock = vi.fn()
const mockRoute: { name: string; params: Record<string, any> } = {
  name: 'dashboard',
  params: {}
}

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
  useRoute: () => mockRoute
}))

describe('InboxWidget.vue', () => {
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    pushMock.mockReset()
    mockRoute.name = 'dashboard'
    mockRoute.params = {}
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()!.unmount()
    localStorage.clear()
  })

  it('hides widget when logged out or on login route, and shows when logged in on dashboard', () => {
    const userStore = useUserStore()
    userStore.user = null
    const w = track(mount(InboxWidget))
    expect((w.find('.inbox-widget').element as HTMLElement).style.display).toBe('none')

    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }
    mockRoute.name = 'login'
    const wLogin = track(mount(InboxWidget))
    expect((wLogin.find('.inbox-widget').element as HTMLElement).style.display).toBe('none')

    mockRoute.name = 'dashboard'
    const wDash = track(mount(InboxWidget))
    expect((wDash.find('.inbox-widget').element as HTMLElement).style.display).not.toBe('none')
  })

  it('opens dropdown, marks individual/all messages read, deletes, and navigates on conflict click', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Alice', token: 'tok' }
    const inboxStore = useInboxStore()
    const toastStore = useToastStore()
    const toastSpy = vi.spyOn(toastStore, 'showToast')

    inboxStore.addMessage({
      id: 'm1',
      title: 'Conflict M1',
      body: 'Check match 1',
      type: 'conflict',
      conflictMatchNumber: 1,
      conflictTeamNumber: 27570,
      conflictTournamentLevel: 'QUALIFICATION',
      eventId: 'evt-99'
    })
    inboxStore.addMessage({
      id: 'm2',
      title: 'Conflict No Event',
      body: 'No eventId',
      type: 'conflict',
      conflictMatchNumber: 2,
      conflictTeamNumber: 118
    })

    const wrapper = track(mount(InboxWidget))
    expect(wrapper.find('.badge').text()).toBe('2')

    // Open dropdown
    await wrapper.find('.inbox-morph-container').trigger('click')
    expect(inboxStore.isOpen).toBe(true)
    expect(wrapper.findAll('.inbox-item')).toHaveLength(2)

    // Clicking conflict without eventId warns via toast
    const items = wrapper.findAll('.inbox-item')
    const noEventItem = items.find((item) => item.text().includes('Conflict No Event'))!
    await noEventItem.trigger('click')
    expect(toastSpy).toHaveBeenCalledWith(expect.any(String), 'warning')

    // Clicking conflict with eventId navigates and closes dropdown
    const eventItem = items.find((item) => item.text().includes('Conflict M1'))!
    await eventItem.trigger('click')
    expect(pushMock).toHaveBeenCalledWith('/event/evt-99?tab=history&highlightMatch=1&highlightTeam=27570&highlightLevel=QUALIFICATION')
    expect(inboxStore.isOpen).toBe(false)

    // Re-open, mark one read, mark all read, delete, clear all
    await wrapper.find('.inbox-morph-container').trigger('click')
    await wrapper.find('.mark-read').trigger('click')
    expect(inboxStore.unreadCount).toBe(1)

    await wrapper.find('.action-btn').trigger('click')
    expect(inboxStore.unreadCount).toBe(0)

    await wrapper.find('.delete-msg-btn').trigger('click')
    expect(inboxStore.messages).toHaveLength(1)

    await wrapper.find('.clear-all-btn').trigger('click')
    expect(inboxStore.messages).toHaveLength(0)
    expect(wrapper.find('.empty').exists()).toBe(true)
  })
})
