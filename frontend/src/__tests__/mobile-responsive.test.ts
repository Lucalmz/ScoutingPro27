import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileBottomNav from '../components/common/MobileBottomNav.vue'
import RankingsTable from '../components/rankings/RankingsTable.vue'
import { useEventStore } from '../stores/events'
import fs from 'fs'
import path from 'path'

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn()
  }),
  useRoute: () => ({
    params: {},
    query: {}
  })
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => key,
      te: () => false
    })
  }
})

describe('Mobile and Fold Screen Responsive Architecture', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  it('verifies index.html has viewport-fit=cover for full screen safe-area support', () => {
    const htmlPath = path.resolve(__dirname, '../../index.html')
    const htmlContent = fs.readFileSync(htmlPath, 'utf-8')
    expect(htmlContent).toContain('viewport-fit=cover')
    expect(htmlContent).toContain('interactive-widget=resizes-content')
  })

  it('verifies main.css exports safe area CSS variables (--sat, --sab, --sal, --sar)', () => {
    const cssPath = path.resolve(__dirname, '../assets/main.css')
    const cssContent = fs.readFileSync(cssPath, 'utf-8')
    expect(cssContent).toContain('--sat: env(safe-area-inset-top')
    expect(cssContent).toContain('--sab: env(safe-area-inset-bottom')
    expect(cssContent).toContain('--sal: env(safe-area-inset-left')
    expect(cssContent).toContain('--sar: env(safe-area-inset-right')
  })

  it('MobileBottomNav: 4+1 navigation renders 5 buttons and handles action sheet interactions', async () => {
    const eventStore = useEventStore()
    eventStore.currentEvent = { id: 'evt_test', name: 'Test', hostId: 'user_host' } as any
    Object.defineProperty(eventStore, 'isHost', { get: () => true })

    const wrapper = mount(MobileBottomNav, {
      props: {
        activeTab: 'scout'
      }
    })

    const nav = document.body.querySelector('.mobile-bottom-nav')
    expect(nav).not.toBeNull()
    const buttons = nav!.querySelectorAll('.nav-item-btn')
    expect(buttons.length).toBe(5)

    // Initially more sheet is not shown
    expect(document.body.querySelector('.more-sheet')).toBeNull()

    // Clicking 5th button (More) opens the bottom action sheet
    await (buttons[4] as HTMLButtonElement).click()
    const sheet = document.body.querySelector('.more-sheet')
    expect(sheet).not.toBeNull()

    // Action sheet contains history, ai, and scouts
    const sheetBtns = sheet!.querySelectorAll('.sheet-item-btn')
    expect(sheetBtns.length).toBe(3)

    // Clicking AI Chat in more sheet emits update:activeTab
    await (sheetBtns[1] as HTMLButtonElement).click()
    expect(wrapper.emitted('update:activeTab')?.[0]).toEqual(['ai'])

    // Sheet closes after selection
    expect(document.body.querySelector('.more-sheet')).toBeNull()
  })

  it('RankingsTable: renders table with sticky team cell for smooth horizontal scrolling', () => {
    const wrapper = mount(RankingsTable, {
      props: {
        rankings: [
          {
            teamNumber: 27570,
            matchCount: 5,
            brokenCount: 0,
            avgAutoScore: 30,
            avgTeleopScore: 60,
            avgEndgameScore: 20,
            maxScore: 120,
            avgRating: 95.5,
            trend: 'up'
          } as any
        ],
        loading: false
      }
    })

    const tableWrapper = wrapper.find('.table-wrapper')
    expect(tableWrapper.exists()).toBe(true)

    const teamHeader = wrapper.find('thead th:first-child')
    expect(teamHeader.exists()).toBe(true)

    const row = wrapper.find('[data-team-row="27570"]')
    expect(row.exists()).toBe(true)
    const teamCell = row.find('.team-cell')
    expect(teamCell.exists()).toBe(true)
    expect(teamCell.text()).toContain('27570')
  })
})
