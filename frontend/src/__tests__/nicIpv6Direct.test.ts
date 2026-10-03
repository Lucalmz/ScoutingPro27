import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  probeLocalInterfaceIpv6,
  resetLocalIpv6ProbeCache,
  buildIceConfiguration,
  STUN_SERVERS,
  isGlobalIpv6Address,
  CONNECTION_TIMING,
  shouldForceRelayForAttempt
} from '@/services/webrtc/connectivity'
import { PeerConnectionManager, type PeerConnectionFactoryOptions } from '@/services/webrtc/peerManager'
import * as api from '@/services/api'

vi.mock('@/services/api', () => ({
  getNetworkInfo: vi.fn().mockResolvedValue(null)
}))

describe('Parallel Dual-Stack ICE & Non-Locking Hole Punching Architecture', () => {
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

  describe('buildIceConfiguration specification', () => {
    it('initializes single-PC with all STUN/TURN servers under iceTransportPolicy: "all" by default', () => {
      const config = buildIceConfiguration(false)
      expect(config.iceServers).toEqual(STUN_SERVERS.iceServers)
      expect(config.iceTransportPolicy).toBe('all')
      expect(config.iceCandidatePoolSize).toBe(2)
    })

    it('builds relay-only config when forceRelay is specified for escalation attempts', () => {
      const config = buildIceConfiguration(true)
      expect(config.iceServers).toEqual(STUN_SERVERS.iceServers)
      expect(config.iceTransportPolicy).toBe('relay')
    })

    it('shouldForceRelayForAttempt implements escalation ladder: all -> all -> relay -> all -> relay', () => {
      expect(shouldForceRelayForAttempt(1)).toBe(false)
      expect(shouldForceRelayForAttempt(2)).toBe(true)
      expect(shouldForceRelayForAttempt(3)).toBe(false)
      expect(shouldForceRelayForAttempt(4)).toBe(true)
      expect(shouldForceRelayForAttempt(5)).toBe(false)
      expect(shouldForceRelayForAttempt(6)).toBe(true)
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

  describe('PeerConnectionManager Parallel ICE Architecture', () => {
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

    function createMockOptions(): PeerConnectionFactoryOptions {
      return {
        getSignaling: () => null,
        isHostMode: () => false,
        callbacks: {
          onStatusChange: vi.fn(),
          onRecordsReceived: vi.fn(),
          onAckReceived: vi.fn(),
          onRequestSync: vi.fn(),
          onIceStalled: vi.fn()
        },
        setStatus: vi.fn(),
        getClientSharedAesKey: () => null,
        getClientSharedKey: () => null,
        getClientFingerprint: () => 'fp-1',
        getClientSecurityFingerprint: () => 'sec-fp-1'
      }
    }

    it('initializes with parallel "all" ICE configuration without pool size mismatch', () => {
      let passedConfig: any = null
      global.RTCPeerConnection = vi.fn().mockImplementation((cfg) => {
        passedConfig = cfg
        return createMockPeer()
      }) as any

      const manager = new PeerConnectionManager(createMockOptions())
      manager.createPeerConnection()

      expect(passedConfig).toBeDefined()
      expect(passedConfig.iceServers).toEqual(STUN_SERVERS.iceServers)
      expect(passedConfig.iceTransportPolicy).toBe('all')
      expect(passedConfig.iceCandidatePoolSize).toBe(2)
    })

    it('does NOT prematurely tear down connection at 1500ms (eliminates NAT/firewall premature teardown deadlock)', async () => {
      const mockPeer = createMockPeer()
      global.RTCPeerConnection = vi.fn().mockImplementation(() => mockPeer) as any

      const mockOptions = createMockOptions()
      const manager = new PeerConnectionManager(mockOptions)
      manager.createPeerConnection('target-client')

      // Advance past 1500ms and 5000ms: connection must NOT be closed by any premature watchdog
      await vi.advanceTimersByTimeAsync(1500)
      expect(mockPeer.closeSpy).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(5000)
      expect(mockPeer.closeSpy).not.toHaveBeenCalled()
    })

    it('holds local candidates until releaseLocalCandidates is called, preserving Offer -> Candidate order', async () => {
      const mockPeer = createMockPeer()
      global.RTCPeerConnection = vi.fn().mockImplementation(() => mockPeer) as any

      const mockSignaling = { send: vi.fn() }
      const mockOptions = createMockOptions()
      mockOptions.getSignaling = () => mockSignaling as any

      const manager = new PeerConnectionManager(mockOptions)
      const pc = manager.createPeerConnection('host-target', undefined, false, undefined, {
        sessionTag: 'sess-abc',
        holdLocalCandidates: true
      })

      // Simulate local ICE candidate generated before Offer is sent
      mockPeer.onicecandidate({
        candidate: {
          candidate: 'candidate:1 1 UDP 2122260223 2409:8a00:abcd::1 54321 typ host',
          toJSON: () => ({ candidate: 'candidate:1 1 UDP 2122260223 2409:8a00:abcd::1 54321 typ host' })
        }
      })

      // Candidate must be held (not sent over signaling yet)
      expect(mockSignaling.send).not.toHaveBeenCalled()

      // Release gate (e.g. after Offer was dispatched)
      manager.releaseLocalCandidates(pc)
      await Promise.resolve()

      // Candidate is now dispatched with sessionTag
      expect(mockSignaling.send).toHaveBeenCalledTimes(1)
      expect(mockSignaling.send).toHaveBeenCalledWith(
        expect.objectContaining({
          clientSessionId: 'sess-abc',
          candidate: expect.anything()
        }),
        'host-target'
      )
    })

    it('notifies onIceStalled(true) at 3000ms checking without tearing down parallel ICE checking', async () => {
      const mockPeer = createMockPeer()
      global.RTCPeerConnection = vi.fn().mockImplementation(() => mockPeer) as any

      const mockOptions = createMockOptions()
      const manager = new PeerConnectionManager(mockOptions)
      manager.createPeerConnection('target')

      mockPeer.iceConnectionState = 'checking'
      mockPeer.oniceconnectionstatechange()

      await vi.advanceTimersByTimeAsync(3000)
      expect(mockOptions.callbacks.onIceStalled).toHaveBeenCalledWith(true)
      // PC is not torn down
      expect(mockPeer.closeSpy).not.toHaveBeenCalled()

      // When state becomes connected, stall notification is cleared
      mockPeer.iceConnectionState = 'connected'
      mockPeer.oniceconnectionstatechange()
      expect(mockOptions.callbacks.onIceStalled).toHaveBeenCalledWith(false)
    })

    it('reports failure once on connection failure without infinite retry loops', () => {
      const mockPeer = createMockPeer()
      global.RTCPeerConnection = vi.fn().mockImplementation(() => mockPeer) as any

      const mockOptions = createMockOptions()
      const onDisconnect = vi.fn()
      const manager = new PeerConnectionManager(mockOptions)
      manager.createPeerConnection('target-client', onDisconnect)

      mockPeer.connectionState = 'failed'
      mockPeer.onconnectionstatechange()

      expect(onDisconnect).toHaveBeenCalledTimes(1)
      expect(mockOptions.setStatus).toHaveBeenCalledWith('unstable')

      // Further state changes on the same peer do not duplicate failure calls
      mockPeer.connectionState = 'closed'
      mockPeer.onconnectionstatechange()
      expect(onDisconnect).toHaveBeenCalledTimes(1)
    })
  })
})
