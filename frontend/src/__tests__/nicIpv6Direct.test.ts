import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  probeLocalInterfaceIpv6,
  resetLocalIpv6ProbeCache,
  DIRECT_NIC_CONFIG,
  STUN_SERVERS,
  isGlobalIpv6Address
} from '@/services/webrtc/connectivity'
import { PeerConnectionManager, type PeerConnectionFactoryOptions } from '@/services/webrtc/peerManager'
import * as api from '@/services/api'

vi.mock('@/services/api', () => ({
  getNetworkInfo: vi.fn().mockResolvedValue(null)
}))

describe('Direct NIC IPv6 & STUN NAT Fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLocalIpv6ProbeCache()
    ;(globalThis as any).__TEST_ALLOW_NIC_PROBE__ = true
    vi.useFakeTimers()
  })

  afterEach(() => {
    delete (globalThis as any).__TEST_ALLOW_NIC_PROBE__
    vi.useRealTimers()
  })

  describe('DIRECT_NIC_CONFIG specification', () => {
    it('defines zero iceServers for zero-STUN direct connection without pool size mismatch', () => {
      expect(DIRECT_NIC_CONFIG.iceServers).toBeDefined()
      expect(DIRECT_NIC_CONFIG.iceServers).toEqual([])
      expect(DIRECT_NIC_CONFIG.iceCandidatePoolSize).toBeUndefined()
    })
  })

  describe('isGlobalIpv6Address (GUA 2000::/3)', () => {
    it('accurately classifies Global Unicast IPv6 vs Link-Local/ULA/IPv4', () => {
      // Valid Global Unicast Addresses (2000::/3 -> starts with 2xxx or 3xxx)
      expect(isGlobalIpv6Address('2409:8a00:1234::1')).toBe(true)
      expect(isGlobalIpv6Address('2001:da8:200::1')).toBe(true)
      expect(isGlobalIpv6Address('3ffe:ffff::1')).toBe(true)
      expect(isGlobalIpv6Address('[2409:8a00:1234::1]')).toBe(true)

      // Link-local / ULA / Multicast / Loopback / Unspecified (NOT GUA)
      expect(isGlobalIpv6Address('fe80::1')).toBe(false)
      expect(isGlobalIpv6Address('fc00::1')).toBe(false)
      expect(isGlobalIpv6Address('fd00::1234')).toBe(false)
      expect(isGlobalIpv6Address('ff02::1')).toBe(false)
      expect(isGlobalIpv6Address('::1')).toBe(false)
      expect(isGlobalIpv6Address('::')).toBe(false)
      expect(isGlobalIpv6Address('192.168.1.100')).toBe(false)
    })
  })

  describe('probeLocalInterfaceIpv6', () => {
    it('reads and cleans GUA IPv6 from backend getNetworkInfo', async () => {
      vi.mocked(api.getNetworkInfo).mockResolvedValueOnce({
        primaryIp: '192.168.1.50',
        allIps: ['192.168.1.50'],
        primaryIpv6: '2409:8a00:6789::1',
        allIpv6s: ['2409:8a00:6789::1'],
        port: 8080,
        joinBaseUrl: 'http://192.168.1.50:8080'
      })

      const ip = await probeLocalInterfaceIpv6()
      expect(ip).toBe('2409:8a00:6789::1')
      expect(api.getNetworkInfo).toHaveBeenCalledTimes(1)

      // Within 30s cache, subsequent call uses cached value without another API call
      const cachedIp = await probeLocalInterfaceIpv6()
      expect(cachedIp).toBe('2409:8a00:6789::1')
      expect(api.getNetworkInfo).toHaveBeenCalledTimes(1)

      // After resetLocalIpv6ProbeCache, cache is evicted
      resetLocalIpv6ProbeCache()
      vi.mocked(api.getNetworkInfo).mockResolvedValueOnce({
        primaryIp: '192.168.1.50',
        allIps: ['192.168.1.50'],
        primaryIpv6: '2409:8a00:6789::2',
        allIpv6s: ['2409:8a00:6789::2'],
        port: 8080,
        joinBaseUrl: 'http://192.168.1.50:8080'
      })
      const renewedIp = await probeLocalInterfaceIpv6()
      expect(renewedIp).toBe('2409:8a00:6789::2')
      expect(api.getNetworkInfo).toHaveBeenCalledTimes(2)
    })

    it('ignores link-local IPv6 from backend and falls back to WebRTC host probe', async () => {
      vi.mocked(api.getNetworkInfo).mockResolvedValueOnce({
        primaryIp: '192.168.1.50',
        allIps: ['192.168.1.50'],
        primaryIpv6: 'fe80::1a2b:3c4d:5e6f',
        allIpv6s: ['fe80::1a2b:3c4d:5e6f'],
        port: 8080,
        joinBaseUrl: 'http://192.168.1.50:8080'
      })

      let mockOnIceCandidate: ((ev: any) => void) | null = null
      const mockPc = {
        createDataChannel: vi.fn(),
        createOffer: vi.fn().mockResolvedValue({}),
        setLocalDescription: vi.fn().mockImplementation(() => {
          setTimeout(() => {
            if (mockOnIceCandidate) {
              mockOnIceCandidate({
                candidate: {
                  candidate: 'candidate:1 1 UDP 2122260223 2409:8a00:abcd::1 54321 typ host'
                }
              })
            }
          }, 10)
        }),
        close: vi.fn(),
        set onicecandidate(fn: any) {
          mockOnIceCandidate = fn
        }
      }

      global.RTCPeerConnection = vi.fn().mockImplementation(() => mockPc) as any
      ;(globalThis as any).__TEST_ALLOW_NIC_PROBE__ = true

      try {
        const probePromise = probeLocalInterfaceIpv6()
        await vi.advanceTimersByTimeAsync(20)
        const ip = await probePromise
        expect(ip).toBe('2409:8a00:abcd::1')
      } finally {
        delete (globalThis as any).__TEST_ALLOW_NIC_PROBE__
      }
    })
  })

  describe('PeerConnectionManager NIC Direct Mode & Watchdog', () => {
    function createMockPeer() {
      const listeners: Record<string, Function[]> = {}
      const closeSpy = vi.fn()
      const peer: any = {
        connectionState: 'new',
        iceConnectionState: 'new',
        signalingState: 'stable',
        setConfiguration: vi.fn(),
        restartIce: vi.fn(),
        close: closeSpy,
        closeSpy,
        createDataChannel: vi.fn().mockReturnValue({ readyState: 'connecting' }),
        addEventListener: vi.fn((event: string, fn: Function) => {
          if (!listeners[event]) listeners[event] = []
          listeners[event].push(fn)
        }),
        removeEventListener: vi.fn()
      }
      return peer
    }

    function createMockOptions(directEligible: boolean): PeerConnectionFactoryOptions {
      return {
        getSignaling: () => null,
        isHostMode: () => false,
        callbacks: {},
        setStatus: vi.fn(),
        getLocalEcdhPubHex: () => 'deadbeef',
        getCurrentHostSessionId: () => 'sess-1',
        getClientSharedAesKey: () => null,
        getClientSharedKey: () => null,
        getClientFingerprint: () => 'fp-1',
        getClientSecurityFingerprint: () => 'sec-fp-1',
        isDirectIpv6Eligible: () => directEligible
      }
    }

    it('initializes with DIRECT_NIC_CONFIG (empty iceServers) when direct IPv6 is eligible', () => {
      let passedConfig: any = null
      global.RTCPeerConnection = vi.fn().mockImplementation((cfg) => {
        passedConfig = cfg
        return createMockPeer()
      }) as any

      const manager = new PeerConnectionManager(createMockOptions(true))
      manager.createPeerConnection()

      expect(passedConfig).toBeDefined()
      expect(passedConfig.iceServers).toEqual([])
      expect(passedConfig.iceCandidatePoolSize).toBeUndefined()
    })

    it('initializes with STUN_SERVERS when direct IPv6 is not eligible', () => {
      let passedConfig: any = null
      global.RTCPeerConnection = vi.fn().mockImplementation((cfg) => {
        passedConfig = cfg
        return createMockPeer()
      }) as any

      const manager = new PeerConnectionManager(createMockOptions(false))
      manager.createPeerConnection()

      expect(passedConfig).toBeDefined()
      expect(passedConfig.iceServers).toEqual(STUN_SERVERS.iceServers)
    })

    it('forcefully tears down direct-NIC connection and calls onDirectNicFallback after 1500ms when direct connection is blocked by NAT/firewall', async () => {
      const mockPeer = createMockPeer()
      global.RTCPeerConnection = vi.fn().mockImplementation(() => mockPeer) as any

      const mockOptions = createMockOptions(true)
      mockOptions.onDirectNicFallback = vi.fn()
      const manager = new PeerConnectionManager(mockOptions)
      const pc = manager.createPeerConnection('target-client')

      // Before 1500ms, no fallback
      await vi.advanceTimersByTimeAsync(1400)
      expect(mockPeer.closeSpy).not.toHaveBeenCalled()
      expect(mockOptions.onDirectNicFallback).not.toHaveBeenCalled()

      // At 1500ms, watchdog fires
      await vi.advanceTimersByTimeAsync(150)
      expect(mockPeer.closeSpy).toHaveBeenCalledTimes(1)
      expect(mockOptions.onDirectNicFallback).toHaveBeenCalledWith('target-client')
    })

    it('race protection: cancels watchdog when connected within 1500ms without triggering fallback', async () => {
      const mockPeer = createMockPeer()
      global.RTCPeerConnection = vi.fn().mockImplementation(() => mockPeer) as any

      const mockOptions = createMockOptions(true)
      mockOptions.onDirectNicFallback = vi.fn()
      const manager = new PeerConnectionManager(mockOptions)
      manager.createPeerConnection()

      // Connects at 400ms via direct IPv6
      await vi.advanceTimersByTimeAsync(400)
      mockPeer.connectionState = 'connected'
      mockPeer.onconnectionstatechange()

      // Advance past 1500ms
      await vi.advanceTimersByTimeAsync(2000)

      // Crucial: fallback must NOT have been called
      expect(mockPeer.closeSpy).not.toHaveBeenCalled()
      expect(mockOptions.onDirectNicFallback).not.toHaveBeenCalled()
    })

    it('cancels watchdog cleanly when peer connection is closed before 1500ms', async () => {
      const mockPeer = createMockPeer()
      global.RTCPeerConnection = vi.fn().mockImplementation(() => mockPeer) as any

      const mockOptions = createMockOptions(true)
      mockOptions.onDirectNicFallback = vi.fn()
      const manager = new PeerConnectionManager(mockOptions)
      const pc = manager.createPeerConnection()

      // Peer closed at 500ms (e.g., user navigates away or host disconnects)
      await vi.advanceTimersByTimeAsync(500)
      pc.close()

      // Advance past 1500ms
      await vi.advanceTimersByTimeAsync(2000)

      expect(mockOptions.onDirectNicFallback).not.toHaveBeenCalled()
    })

    it('immediately triggers onDirectNicFallback and closes peer when connection fails before connected', () => {
      const mockPeer = createMockPeer()
      global.RTCPeerConnection = vi.fn().mockImplementation(() => mockPeer) as any

      const mockOptions = createMockOptions(true)
      mockOptions.onDirectNicFallback = vi.fn()
      const manager = new PeerConnectionManager(mockOptions)
      manager.createPeerConnection('target-client')

      mockPeer.connectionState = 'failed'
      mockPeer.onconnectionstatechange()

      expect(mockPeer.closeSpy).toHaveBeenCalledTimes(1)
      expect(mockOptions.onDirectNicFallback).toHaveBeenCalledWith('target-client')
    })
  })
})
