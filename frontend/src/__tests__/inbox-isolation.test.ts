import { mount } from '@vue/test-utils'
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import App from '../App.vue'
import InboxWidget from '../components/common/InboxWidget.vue'
import { useUserStore } from '../stores/user'

const DummyLogin = { template: '<div class="login-view">Login View</div>' }
const DummyDashboard = { template: '<div class="dashboard-view">Dashboard View</div>' }
const DummyEvent = { template: '<div class="event-view">Event View</div>' }
const DummyTeam = { template: '<div class="team-detail-view">Team Detail View</div>' }

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'login', component: DummyLogin },
      { path: '/dashboard', name: 'dashboard', component: DummyDashboard },
      { path: '/event/:eventId', name: 'event', component: DummyEvent },
      { path: '/event/:eventId/team/:teamNumber', name: 'team-detail', component: DummyTeam }
    ]
  })
}

describe('Inbox View Independence & Lifecycle Isolation', () => {
  let router: ReturnType<typeof createTestRouter>

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    router = createTestRouter()
  })

  it('InboxWidget is always mounted (single instance), hidden on login page when not logged in', async () => {
    const userStore = useUserStore()
    userStore.user = null

    await router.push('/')
    await router.isReady()

    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: { ToastProvider: true }
      }
    })

    // Component always exists (v-show, not v-if) — single instance guarantee
    const inbox = wrapper.findComponent(InboxWidget)
    expect(inbox.exists()).toBe(true)
    expect(inbox.isVisible()).toBe(false)
  })

  it('InboxWidget stays hidden on login page even when logged in', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester' }

    await router.push('/')
    await router.isReady()

    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: { ToastProvider: true }
      }
    })

    const inbox = wrapper.findComponent(InboxWidget)
    expect(inbox.exists()).toBe(true)
    expect(inbox.isVisible()).toBe(false)
  })

  it('persists instance & open state across route switches without remounting', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester' }

    await router.push('/dashboard')
    await router.isReady()

    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: { ToastProvider: true }
      },
      attachTo: document.body
    })

    // 1. Initial: InboxWidget exists and visible on dashboard
    const inbox = wrapper.findComponent(InboxWidget)
    expect(inbox.exists()).toBe(true)
    expect(inbox.isVisible()).toBe(true)
    expect(inbox.find('.inbox-widget').classes()).not.toContain('is-open')

    // 2. Open it
    await inbox.find('.inbox-morph-container').trigger('click')
    expect(inbox.find('.inbox-widget').classes()).toContain('is-open')

    // 3. Navigate to /event/event-123
    await router.push('/event/event-123')
    await router.isReady()
    await wrapper.vm.$nextTick()

    // 4. Still mounted, still open (NOT re-rendered / re-created)
    const inboxAfterNav1 = wrapper.findComponent(InboxWidget)
    expect(inboxAfterNav1.exists()).toBe(true)
    expect(inboxAfterNav1.find('.inbox-widget').classes()).toContain('is-open')

    // 5. Navigate to team detail
    await router.push('/event/event-123/team/456')
    await router.isReady()
    await wrapper.vm.$nextTick()

    const inboxAfterNav2 = wrapper.findComponent(InboxWidget)
    expect(inboxAfterNav2.exists()).toBe(true)
    expect(inboxAfterNav2.find('.inbox-widget').classes()).toContain('is-open')

    // 6. Back to dashboard
    await router.push('/dashboard')
    await router.isReady()
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent(InboxWidget).exists()).toBe(true)
    expect(wrapper.findComponent(InboxWidget).find('.inbox-widget').classes()).toContain('is-open')

    wrapper.unmount()
  })

  it('InboxWidget is outside router-view-container (independent DOM tree)', async () => {
    const userStore = useUserStore()
    userStore.user = { id: 'u1', username: 'Tester' }

    await router.push('/dashboard')
    await router.isReady()

    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: { ToastProvider: true }
      }
    })

    const routerViewContainer = wrapper.find('.router-view-container')
    expect(routerViewContainer.exists()).toBe(true)

    // InboxWidget is NOT inside router-view-container
    expect(routerViewContainer.findComponent(InboxWidget).exists()).toBe(false)

    // But it exists at the App level
    expect(wrapper.findComponent(InboxWidget).exists()).toBe(true)
  })
})
