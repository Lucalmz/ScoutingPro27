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
          'bottom_nav.scouts': 'Scouts',
          'bottom_nav.ai': 'AI Chat',
          'bottom_nav.more': 'More'
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
    expect(buttons.length).toBe(5) // scout, pit, schedule, rankings, more

    // First button (scout) should have is-active class
    expect(buttons[0].classList.contains('is-active')).toBe(true)
    expect(buttons[1].classList.contains('is-active')).toBe(false)
    expect(buttons[4].textContent).toContain('More')
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

  it('opens more sheet when more button is clicked and emits when option selected', async () => {
    const eventStore = useEventStore()
    eventStore.currentEvent = { id: 'evt_1', name: 'Test Event', hostId: 'u1' } as any
    Object.defineProperty(eventStore, 'isHost', { get: () => true })

    const wrapper = mount(MobileBottomNav, {
      props: {
        activeTab: 'rankings'
      }
    })

    const teleportedNav = document.body.querySelector('.mobile-bottom-nav')
    const buttons = teleportedNav!.querySelectorAll('.nav-item-btn')
    expect(buttons.length).toBe(5)
    expect(buttons[4].textContent).toContain('More')

    // Click the 5th "More" button
    await (buttons[4] as HTMLButtonElement).click()

    // More sheet should now be rendered
    const sheet = document.body.querySelector('.more-sheet')
    expect(sheet).not.toBeNull()

    const sheetBtns = sheet!.querySelectorAll('.sheet-item-btn')
    // Host has history, ai, scouts
    expect(sheetBtns.length).toBe(3)
    expect(sheetBtns[2].textContent).toContain('Scouts')

    // Click scouts button in sheet
    await (sheetBtns[2] as HTMLButtonElement).click()
    expect(wrapper.emitted('update:activeTab')).toBeTruthy()
    expect(wrapper.emitted('update:activeTab')![0]).toEqual(['scouts'])
  })

  it('dynamically displays active sub-tab on 5th button', () => {
    const eventStore = useEventStore()
    eventStore.currentEvent = { id: 'evt_1', name: 'Test Event', hostId: 'u1' } as any

    mount(MobileBottomNav, {
      props: {
        activeTab: 'ai'
      }
    })

    const teleportedNav = document.body.querySelector('.mobile-bottom-nav')
    const buttons = teleportedNav!.querySelectorAll('.nav-item-btn')
    expect(buttons.length).toBe(5)
    expect(buttons[4].textContent).toContain('AI Chat')
    expect(buttons[4].classList.contains('is-active')).toBe(true)
  })
})
