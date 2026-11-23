import { mount, type VueWrapper } from '@vue/test-utils'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import ConnectionStatus from '../components/common/ConnectionStatus.vue'
import { useConnectionStore } from '../stores/connection'
import { useEventStore } from '../stores/events'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, paramsOrDef?: any) => {
      if (typeof paramsOrDef === 'string') return paramsOrDef
      return key
    }
  }),
  createI18n: () => ({
    global: {
      t: (key: string) => key
    }
  })
}))

describe('ConnectionStatus.vue Badges Visibility', () => {
  const wrappers: VueWrapper<any>[] = []
  const track = <T extends VueWrapper<any>>(w: T): T => {
    wrappers.push(w)
    return w
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()!.unmount()
  })

  it('hides 1-to-1 transport and fingerprint badges on active Host view', () => {
    const connStore = useConnectionStore()
    const eventStore = useEventStore()

    connStore.status = 'connected'
    connStore.transportInfo = {
      type: 'ipv6_p2p',
      localCandidateType: 'host',
      remoteCandidateType: 'srflx',
      protocol: 'udp',
      localAddress: '2001:db8::1',
      remoteAddress: '2001:db8::2',
      rttMs: 12,
      securityFingerprint: 'A1B2-C3D4'
    }

    // Mock active host
    const mockRtc = { isHostMode: () => true } as any
    connStore.setRtcService(mockRtc)
    connStore.setStandbyHost(false)

    const wrapper = track(mount(ConnectionStatus))

    // Host status is displayed
    expect(wrapper.find('.connection-status').exists()).toBe(true)
    // 1-to-1 transport and fingerprint badges MUST NOT be rendered on Host
    expect(wrapper.find('.transport-badge').exists()).toBe(false)
    expect(wrapper.find('.fingerprint-badge').exists()).toBe(false)
  })

  it('renders 1-to-1 transport and fingerprint badges on Client and Standby Host view', () => {
    const connStore = useConnectionStore()
    const eventStore = useEventStore()

    connStore.status = 'connected'
    connStore.transportInfo = {
      type: 'ipv6_p2p',
      localCandidateType: 'host',
      remoteCandidateType: 'srflx',
      protocol: 'udp',
      localAddress: '2001:db8::1',
      remoteAddress: '2001:db8::2',
      rttMs: 12,
      securityFingerprint: 'A1B2-C3D4'
    }

    // Client mode
    const mockRtc = { isHostMode: () => false } as any
    connStore.setRtcService(mockRtc)
    connStore.setStandbyHost(false)

    const wrapper = track(mount(ConnectionStatus))

    // On Client, 1-to-1 transport and fingerprint badges MUST be rendered!
    expect(wrapper.find('.transport-badge').exists()).toBe(true)
    expect(wrapper.find('.fingerprint-badge').exists()).toBe(true)
    expect(wrapper.find('.fingerprint-text').text()).toBe('A1B2-C3D4')
  })

  it('distinguishes zero-quota ECDH Tunnel (TLS) from Metered TURN Relay in transport badge', () => {
    const connStore = useConnectionStore()
    const mockRtc = { isHostMode: () => false } as any
    connStore.setRtcService(mockRtc)
    connStore.setStandbyHost(false)
    connStore.status = 'connected'

    connStore.transportInfo = {
      type: 'relay',
      localCandidateType: 'virtual-e2ee',
      remoteCandidateType: 'wss-broker:8084',
      protocol: 'wss/tls',
      label: 'ECDH Tunnel (TLS)',
      isVirtualTunnel: true,
      rttMs: 42
    }
    const vdcWrapper = track(mount(ConnectionStatus))
    expect(vdcWrapper.find('.transport-text').text()).toBe('connection.transport_virtual_tunnel')

    connStore.transportInfo = {
      type: 'relay',
      localCandidateType: 'relay',
      remoteCandidateType: 'relay',
      protocol: 'TCP',
      rttMs: 110
    }
    const turnWrapper = track(mount(ConnectionStatus))
    expect(turnWrapper.find('.transport-text').text()).toBe('connection.transport_relay')
  })
})
