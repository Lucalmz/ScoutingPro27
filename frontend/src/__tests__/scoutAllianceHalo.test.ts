import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import App from '../App.vue'
import ScoutingForm from '../components/scouting/ScoutingForm.vue'
import { useScoutAllianceHalo } from '../composables/useScoutAllianceHalo'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    te: () => false
  }),
  createI18n: () => ({})
}))

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'login', component: { template: '<div />' } },
      { path: '/dashboard', name: 'dashboard', component: { template: '<div />' } }
    ]
  })
}

describe('Scout Alliance Ambient Halo', () => {
  const { scoutAllianceHalo, setScoutAllianceHalo, clearScoutAllianceHalo } = useScoutAllianceHalo()

  beforeEach(() => {
    setActivePinia(createPinia())
    clearScoutAllianceHalo()
  })

  afterEach(() => {
    clearScoutAllianceHalo()
  })

  it('tracks red/blue/none state, syncs html dataset attribute, and enforces owner isolation', () => {
    const ownerA = Symbol('owner-a')
    const ownerB = Symbol('owner-b')

    expect(scoutAllianceHalo.value).toBe('none')
    expect(document.documentElement.getAttribute('data-scout-alliance')).toBeNull()

    setScoutAllianceHalo('red', ownerA)
    expect(scoutAllianceHalo.value).toBe('red')
    expect(document.documentElement.dataset.scoutAlliance).toBe('red')

    // New owner takes ownership; stale owner unmount cannot wipe active halo
    setScoutAllianceHalo('blue', ownerB)
    clearScoutAllianceHalo(ownerA)
    expect(scoutAllianceHalo.value).toBe('blue')
    expect(document.documentElement.dataset.scoutAlliance).toBe('blue')

    clearScoutAllianceHalo(ownerB)
    expect(scoutAllianceHalo.value).toBe('none')
    expect(document.documentElement.getAttribute('data-scout-alliance')).toBeNull()
  })

  it('switches active ambient halo layer classes exclusively on App.vue', async () => {
    const router = createTestRouter()
    await router.push('/')
    await router.isReady()

    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          ToastProvider: true,
          ConfirmModal: true,
          InboxWidget: true
        }
      }
    })

    try {
      const defaultLayer = wrapper.find('.ambient-halo-layer.is-default')
      const redLayer = wrapper.find('.ambient-halo-layer.is-red')
      const blueLayer = wrapper.find('.ambient-halo-layer.is-blue')

      expect(defaultLayer.classes()).toContain('active')
      expect(redLayer.classes()).not.toContain('active')
      expect(blueLayer.classes()).not.toContain('active')

      setScoutAllianceHalo('red')
      await wrapper.vm.$nextTick()
      expect(defaultLayer.classes()).not.toContain('active')
      expect(redLayer.classes()).toContain('active')
      expect(blueLayer.classes()).not.toContain('active')

      setScoutAllianceHalo('blue')
      await wrapper.vm.$nextTick()
      expect(defaultLayer.classes()).not.toContain('active')
      expect(redLayer.classes()).not.toContain('active')
      expect(blueLayer.classes()).toContain('active')

      clearScoutAllianceHalo()
      await wrapper.vm.$nextTick()
      expect(defaultLayer.classes()).toContain('active')
      expect(redLayer.classes()).not.toContain('active')
      expect(blueLayer.classes()).not.toContain('active')
    } finally {
      wrapper.unmount()
    }
  })

  it('updates global halo when toggling ScoutingForm Red/Blue switch and resets on unmount', async () => {
    const wrapper = mount(ScoutingForm, {
      props: {
        eventId: 'evt-halo',
        scoutId: 'scout-1',
        scoutName: 'Tester'
      }
    })

    try {
      expect(scoutAllianceHalo.value).toBe('none')

      const redLabel = wrapper.find('.spdt-labels span:first-child')
      const blueLabel = wrapper.find('.spdt-labels span:last-child')

      await redLabel.trigger('click')
      await wrapper.vm.$nextTick()
      expect(scoutAllianceHalo.value).toBe('red')
      expect(document.documentElement.dataset.scoutAlliance).toBe('red')

      await blueLabel.trigger('click')
      await wrapper.vm.$nextTick()
      expect(scoutAllianceHalo.value).toBe('blue')
      expect(document.documentElement.dataset.scoutAlliance).toBe('blue')
    } finally {
      wrapper.unmount()
    }

    expect(scoutAllianceHalo.value).toBe('none')
    expect(document.documentElement.getAttribute('data-scout-alliance')).toBeNull()
  })
})
