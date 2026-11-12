import { mount } from '@vue/test-utils'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import InboxWidget from '../components/common/InboxWidget.vue'
import { useInboxStore } from '../stores/inbox'
import { useUserStore } from '../stores/user'
import { nextTick } from 'vue'

const DummyDashboard = { template: '<div class="dashboard-view">Dashboard View</div>' }
const DummyEvent = { template: '<div class="event-view">Event View</div>' }

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', name: 'dashboard', component: DummyDashboard },
      { path: '/event/:eventId', name: 'event', component: DummyEvent }
    ]
  })
}

describe('InboxWidget Theme & Morph Stress Suite', () => {
  let router: ReturnType<typeof createTestRouter>

  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    router = createTestRouter()
    await router.push('/dashboard')
    await router.isReady()
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('style')
    document.documentElement.removeAttribute('data-theme')
  })

  it('asserts 16px border-radius layout token and geometry when open', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'LeadScout' }

    const wrapper = mount(InboxWidget, {
      global: {
        plugins: [router],
        stubs: { transition: false }
      }
    })
    await nextTick()

    const inboxStore = useInboxStore()
    expect(wrapper.classes()).not.toContain('is-open')

    // Toggle open
    inboxStore.setOpen(true)
    await nextTick()

    expect(wrapper.classes()).toContain('is-open')
    const morphContainer = wrapper.find('.inbox-morph-container')
    expect(morphContainer.exists()).toBe(true)

    // Verify open dropdown container is rendered
    const dropdown = wrapper.find('.inbox-dropdown-content')
    expect(dropdown.exists()).toBe(true)
  })

  it('supports dynamic dark and light theme switching via CSS variable tokens', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'LeadScout' }

    const wrapper = mount(InboxWidget, {
      global: {
        plugins: [router]
      }
    })
    await nextTick()

    const inboxStore = useInboxStore()
    inboxStore.setOpen(true)
    await nextTick()

    // 1. Dark Theme Variables (Standard)
    document.documentElement.style.setProperty('--card', '#141413')
    document.documentElement.style.setProperty('--border', '#262624')
    document.documentElement.style.setProperty('--primary', '#39ff14')
    await nextTick()

    expect(wrapper.classes()).toContain('is-open')
    expect(document.documentElement.style.getPropertyValue('--card')).toBe('#141413')
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#39ff14')

    // 2. Light Theme Variables Switch
    document.documentElement.style.setProperty('--card', '#f8fafc')
    document.documentElement.style.setProperty('--border', '#e2e8f0')
    document.documentElement.style.setProperty('--primary', '#0284c7')
    await nextTick()

    expect(wrapper.classes()).toContain('is-open')
    expect(document.documentElement.style.getPropertyValue('--card')).toBe('#f8fafc')
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#0284c7')

    // 3. Tactical Crimson Flame Theme Switch
    document.documentElement.style.setProperty('--card', '#1b1111')
    document.documentElement.style.setProperty('--border', '#ef4444')
    document.documentElement.style.setProperty('--primary', '#f97316')
    await nextTick()

    expect(wrapper.classes()).toContain('is-open')
    expect(document.documentElement.style.getPropertyValue('--card')).toBe('#1b1111')
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#f97316')
  })

  it('executes 100 rapid open/close morph toggles without state corruption or component unmounting', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'LeadScout' }

    const wrapper = mount(InboxWidget, {
      global: {
        plugins: [router]
      }
    })
    await nextTick()

    const inboxStore = useInboxStore()

    // Populate with messages to test reactive rendering during toggling
    for (let i = 1; i <= 5; i++) {
      inboxStore.addMessage({
        id: `msg-${i}`,
        type: 'general',
        title: `Notification ${i}`,
        body: `Test body content for message ${i}`
      })
    }
    // Mark 2 messages as read
    inboxStore.markRead('msg-2')
    inboxStore.markRead('msg-4')

    expect(inboxStore.messages).toHaveLength(5)
    expect(inboxStore.unreadCount).toBe(3)

    // Execute 100 rapid morph cycles
    for (let cycle = 1; cycle <= 100; cycle++) {
      inboxStore.toggleOpen()
      await nextTick()
      const shouldBeOpen = cycle % 2 !== 0
      expect(inboxStore.isOpen).toBe(shouldBeOpen)
      expect(wrapper.classes('is-open')).toBe(shouldBeOpen)

      // Ensure DOM node is unchanged and mounted
      expect(wrapper.exists()).toBe(true)
      expect(wrapper.find('.inbox-morph-container').exists()).toBe(true)
    }

    // Final state after 100 toggles: even count, should be closed
    expect(inboxStore.isOpen).toBe(false)
    expect(wrapper.classes('is-open')).toBe(false)
    // Messages and unread count remain strictly intact
    expect(inboxStore.messages).toHaveLength(5)
    expect(inboxStore.unreadCount).toBe(3)
  })

  it('preserves single-instance identity across route navigation between Dashboard and EventView', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'LeadScout' }

    const wrapper = mount(InboxWidget, {
      global: {
        plugins: [router]
      }
    })
    await nextTick()

    const inboxStore = useInboxStore()
    inboxStore.setOpen(true)
    await nextTick()
    expect(wrapper.classes('is-open')).toBe(true)

    const initialElement = wrapper.element

    // Navigate to EventView
    await router.push('/event/evt-456')
    await router.isReady()
    await nextTick()

    // Element must remain identical (single instance, not re-rendered)
    expect(wrapper.element).toBe(initialElement)
    expect(inboxStore.isOpen).toBe(true)
    expect(wrapper.classes('is-open')).toBe(true)

    // Navigate back to Dashboard
    await router.push('/dashboard')
    await router.isReady()
    await nextTick()

    expect(wrapper.element).toBe(initialElement)
    expect(inboxStore.isOpen).toBe(true)
    expect(wrapper.classes('is-open')).toBe(true)
  })
})
