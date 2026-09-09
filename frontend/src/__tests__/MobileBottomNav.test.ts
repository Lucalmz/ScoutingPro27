import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileBottomNav from '../components/common/MobileBottomNav.vue'
import { useEventStore } from '../stores/events'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => {
        const dict: Record<string, string> = {
          'bottom_nav.scout': 'Scout',
          'bottom_nav.pit': 'Pit',
          'bottom_nav.schedule': 'Schedule',
          'bottom_nav.rankings': 'Rankings',
          'bottom_nav.history': 'History',
          'bottom_nav.scouts': 'Scouts'
        }
        return dict[key] || key
      }
    })
  }
})

describe('MobileBottomNav.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  it('renders and teleports nav to document.body with activeTab highlighted', () => {
    const eventStore = useEventStore()
    eventStore.currentEvent = { id: 'evt_1', name: 'Test Event', hostId: 'other_user' } as any

    const wrapper = mount(MobileBottomNav, {
      props: {
        activeTab: 'scout'
      }
    })

    const teleportedNav = document.body.querySelector('.mobile-bottom-nav')
    expect(teleportedNav).not.toBeNull()

    const buttons = teleportedNav!.querySelectorAll('.nav-item-btn')
    expect(buttons.length).toBe(5) // scout, pit, schedule, rankings, history

    // First button (scout) should have is-active class
    expect(buttons[0].classList.contains('is-active')).toBe(true)
    expect(buttons[1].classList.contains('is-active')).toBe(false)
  })

  it('emits update:activeTab when button is clicked', async () => {
    const eventStore = useEventStore()
    eventStore.currentEvent = { id: 'evt_1', name: 'Test Event', hostId: 'other_user' } as any

    const wrapper = mount(MobileBottomNav, {
      props: {
        activeTab: 'scout'
      }
    })

    const teleportedNav = document.body.querySelector('.mobile-bottom-nav')
    const buttons = teleportedNav!.querySelectorAll('.nav-item-btn')

    // Click on schedule button (index 2)
    await (buttons[2] as HTMLButtonElement).click()

    expect(wrapper.emitted('update:activeTab')).toBeTruthy()
    expect(wrapper.emitted('update:activeTab')![0]).toEqual(['schedule'])
  })

  it('displays scouts button instead of history when isHost is true', () => {
    const eventStore = useEventStore()
    eventStore.currentEvent = { id: 'evt_1', name: 'Test Event', hostId: 'u1' } as any
    // Mock isHost getter
    Object.defineProperty(eventStore, 'isHost', { get: () => true })

    mount(MobileBottomNav, {
      props: {
        activeTab: 'rankings'
      }
    })

    const teleportedNav = document.body.querySelector('.mobile-bottom-nav')
    const buttons = teleportedNav!.querySelectorAll('.nav-item-btn')
    expect(buttons.length).toBe(5)

    const lastButton = buttons[4]
    expect(lastButton.textContent).toContain('Scouts')
  })
})
