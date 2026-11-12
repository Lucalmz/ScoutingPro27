import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import ScheduleManager from '../components/schedule/ScheduleManager.vue'
import { useScheduleStore } from '../stores/schedule'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      schedule: {
        search_placeholder: 'Search match or team...',
        filter_all: 'All',
        filter_mine: 'Mine',
        filter_pending: 'Pending',
        col_match: 'Match',
        red_alliance: 'Red Alliance',
        blue_alliance: 'Blue Alliance',
        col_official_score: 'Official Score',
        unassigned: 'Unassigned',
        btn_go_scout: 'Go Scout',
        scouted: 'Scouted'
      }
    }
  }
})

describe('ScheduleManager UI and Animation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders schedule-table-wrapper and hover-highlight bar', () => {
    const scheduleStore = useScheduleStore()
    scheduleStore.schedules = [
      {
        matchNumber: 1,
        red1: 27570,
        red2: 1234,
        blue1: 5678,
        blue2: 9999,
        assignments: {}
      }
    ]

    const wrapper = mount(ScheduleManager, {
      props: {
        event: { id: 'evt-1', name: 'Test', inviteCode: 'ABC', hostId: 'h1' } as any,
        isHost: true
      },
      global: {
        plugins: [i18n]
      }
    })

    expect(wrapper.find('.schedule-table-wrapper').exists()).toBe(true)
    const highlight = wrapper.find('.hover-highlight')
    expect(highlight.exists()).toBe(true)
    expect((highlight.element as HTMLElement).style.opacity).toBe('0')
  })

  it('updates hover-highlight position on row mouseenter and resets on mouseleave', async () => {
    const scheduleStore = useScheduleStore()
    scheduleStore.schedules = [
      {
        matchNumber: 1,
        red1: 27570,
        red2: 1234,
        blue1: 5678,
        blue2: 9999,
        assignments: {}
      }
    ]

    const wrapper = mount(ScheduleManager, {
      props: {
        event: { id: 'evt-1', name: 'Test', inviteCode: 'ABC', hostId: 'h1' } as any,
        isHost: true
      },
      global: {
        plugins: [i18n]
      }
    })

    const highlightEl = wrapper.find('.hover-highlight')
    const row = wrapper.find('.match-row')
    expect(row.exists()).toBe(true)

    Object.defineProperty(row.element, 'offsetTop', { value: 64, configurable: true })
    Object.defineProperty(row.element, 'offsetHeight', { value: 58, configurable: true })

    await row.trigger('mouseenter')
    expect((highlightEl.element as HTMLElement).style.opacity).toBe('1')
    expect((highlightEl.element as HTMLElement).style.top).toBe('64px')
    expect((highlightEl.element as HTMLElement).style.height).toBe('58px')

    // Mouse leave table wrapper
    const tableWrapper = wrapper.find('.schedule-table-wrapper')
    await tableWrapper.trigger('mouseleave')
    expect((highlightEl.element as HTMLElement).style.opacity).toBe('0')

    // Re-enter row then hover thead
    await row.trigger('mouseenter')
    expect((highlightEl.element as HTMLElement).style.opacity).toBe('1')

    const thead = wrapper.find('thead')
    await thead.trigger('mouseenter')
    expect((highlightEl.element as HTMLElement).style.opacity).toBe('0')
  })

  it('executes staggered entrance animation hooks (beforeEnter & enter)', () => {
    vi.useFakeTimers()
    const wrapper = mount(ScheduleManager, {
      props: {
        event: { id: 'evt-1', name: 'Test', inviteCode: 'ABC', hostId: 'h1' } as any,
        isHost: true
      },
      global: {
        plugins: [i18n]
      }
    })

    const vm = wrapper.vm as any
    const dummyEl = document.createElement('tr')
    dummyEl.dataset.index = '2'
    document.body.appendChild(dummyEl)

    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })

    vm.beforeEnter(dummyEl)
    expect(dummyEl.style.opacity).toBe('0')
    expect(dummyEl.style.transform).toBe('translateY(20px)')

    let doneCalled = false
    vm.enter(dummyEl, () => {
      doneCalled = true
    })

    // Advance timers for 2 * 40ms delay + 360ms
    vi.advanceTimersByTime(500)
    expect(doneCalled).toBe(true)
    expect(dummyEl.style.opacity).toBe('')
    expect(dummyEl.style.transform).toBe('')
    expect(dummyEl.style.transition).toBe('')

    rafSpy.mockRestore()
    document.body.removeChild(dummyEl)
    vi.useRealTimers()
  })
})
