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
          'event.standby_banner_desc': 'Standby Host Active',
          'connection.transport_type': 'Connection Type',
          'connection.host_topology': 'Host Mesh Topology',
          'connection.transport_ipv6': 'IPv6 Direct',
          'connection.transport_lan': 'LAN Direct',
          'connection.transport_nat': 'IPv4 Hole-punch',
          'connection.transport_relay': 'Relay',
          'connection.transport_unknown': 'P2P'
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

  it('opens HUD popover modal when pill is clicked and shows Scout Client role', async () => {
    const connStore = useConnectionStore()
    connStore.status = 'connected'

    const wrapper = mount(MobileStatusPill, {
      props: {
        eventName: 'Championship Event',
        inviteCode: 'CHAMP1'
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
    expect(popover!.textContent).toContain('Scout Client')

    // Close HUD
    const closeBtn = popover!.querySelector('.btn-close-hud') as HTMLButtonElement
    await closeBtn.click()
    expect(document.body.querySelector('.hud-popover')).toBeNull()
  })

  it('does not render standby badge or takeover controls on mobile', async () => {
    const connStore = useConnectionStore()
    connStore.status = 'connected'

    const wrapper = mount(MobileStatusPill, {
      props: {
        eventName: 'Standby Event',
        inviteCode: 'STAND1'
      }
    })

    // Pill does not show standby badge
    expect(wrapper.find('.pill-standby-badge').exists()).toBe(false)

    // Open HUD
    await wrapper.find('.status-pill').trigger('click')

    const takeoverBtn = document.body.querySelector('.btn-hud-takeover')
    expect(takeoverBtn).toBeNull()
  })

  it('displays connection type line in HUD popover for client with transport and RTT', async () => {
    const connStore = useConnectionStore()
    connStore.status = 'connected'
    connStore.setTransportInfo({
      type: 'nat_p2p',
      localCandidateType: 'srflx',
      remoteCandidateType: 'srflx',
      localAddress: '216.195.192.84',
      remoteAddress: '39.157.117.55',
      protocol: 'UDP',
      rttMs: 303
    })

    const wrapper = mount(MobileStatusPill, {
      props: {
        eventName: 'Quals 26',
        inviteCode: 'BUZZ26'
      }
    })

    await wrapper.find('.status-pill').trigger('click')

    const popover = document.body.querySelector('.hud-popover')
    expect(popover).not.toBeNull()
    expect(popover!.textContent).toContain('Connection Type')
    expect(popover!.textContent).toContain('IPv4 Hole-punch')
    expect(popover!.textContent).toContain('(303ms)')
  })

  it('displays LAN connection type line in HUD popover for mobile client', async () => {
    const connStore = useConnectionStore()
    connStore.status = 'connected'
    connStore.setTransportInfo({
      type: 'lan_p2p',
      localCandidateType: 'host',
      remoteCandidateType: 'host',
      protocol: 'UDP',
      rttMs: 4
    })

    const wrapper = mount(MobileStatusPill, {
      props: {
        eventName: 'LAN Event',
        inviteCode: 'LAN001'
      }
    })

    await wrapper.find('.status-pill').trigger('click')

    const popover = document.body.querySelector('.hud-popover')
    expect(popover).not.toBeNull()
    expect(popover!.textContent).toContain('Connection Type')
    expect(popover!.textContent).toContain('LAN Direct')
  })
})
