import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import MobileStatusPill from '../components/common/MobileStatusPill.vue'
import { useConnectionStore } from '../stores/connection'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => {
        const dict: Record<string, string> = {
          'connection.connected': 'Connected',
          'connection.connecting': 'Connecting',
          'connection.offline': 'Offline',
          'connection.congested': 'Congested',
          'event.code': 'Event Code',
          'connection.status': 'Connection Status',
          'event.role': 'Role',
          'event.host': 'Host',
          'event.client': 'Scout Client',
          'event.takeover_as_host': 'Takeover as Host',
          'event.standby_banner_desc': 'Standby Host Active'
        }
        return dict[key] || key
      }
    })
  }
})

describe('MobileStatusPill.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  it('renders minimal floating pill with invite code and connection color', () => {
    const connStore = useConnectionStore()
    connStore.status = 'connected'

    const wrapper = mount(MobileStatusPill, {
      props: {
        eventName: 'FTC Qualifying 2026',
        inviteCode: 'ABCD12',
        isHost: false
      }
    })

    const pill = wrapper.find('.status-pill')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toContain('ABCD12')

    const dot = wrapper.find('.status-indicator-dot')
    expect(dot.exists()).toBe(true)
  })

  it('opens HUD popover modal when pill is clicked', async () => {
    const connStore = useConnectionStore()
    connStore.status = 'connected'

    const wrapper = mount(MobileStatusPill, {
      props: {
        eventName: 'Championship Event',
        inviteCode: 'CHAMP1',
        isHost: true
      }
    })

    // Initially HUD is not mounted in body
    expect(document.body.querySelector('.hud-popover')).toBeNull()

    // Click pill
    await wrapper.find('.status-pill').trigger('click')

    // HUD is now visible
    const popover = document.body.querySelector('.hud-popover')
    expect(popover).not.toBeNull()
    expect(popover!.textContent).toContain('Championship Event')
    expect(popover!.textContent).toContain('CHAMP1')
    expect(popover!.textContent).toContain('Host')

    // Close HUD
    const closeBtn = popover!.querySelector('.btn-close-hud') as HTMLButtonElement
    await closeBtn.click()
    expect(document.body.querySelector('.hud-popover')).toBeNull()
  })

  it('shows standby takeover banner and emits takeoverHost when standby host', async () => {
    const connStore = useConnectionStore()
    connStore.status = 'connected'
    connStore.isStandbyHost = true

    const wrapper = mount(MobileStatusPill, {
      props: {
        eventName: 'Standby Event',
        inviteCode: 'STAND1',
        isHost: false
      }
    })

    // Pill shows standby badge
    expect(wrapper.find('.pill-standby-badge').exists()).toBe(true)

    // Open HUD
    await wrapper.find('.status-pill').trigger('click')

    const takeoverBtn = document.body.querySelector('.btn-hud-takeover') as HTMLButtonElement
    expect(takeoverBtn).not.toBeNull()

    // Click takeover
    await takeoverBtn.click()
    expect(wrapper.emitted('takeoverHost')).toBeTruthy()
  })
})
