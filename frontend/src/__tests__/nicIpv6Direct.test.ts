import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  probeLocalInterfaceIpv6,
  resetLocalIpv6ProbeCache,
  buildIceConfiguration,
  selectStunUrls,
  extractStunUrlHost,
  classifyStunUrlOrigin,
  warmUpDoHStunIpv6,
  waitForDoHStunIpv6Bounded,
  resetDoHStunCache,
  applyProxyExitDemotionToBatch,
  demoteProxyExitCandidatePriority,
  DOMESTIC_LITERAL_STUN_URLS,
  OVERSEAS_LITERAL_STUN_URLS,
  PURE_STUN_SERVERS,
  STUN_SERVERS,
  TURN_SERVERS,
  isGlobalIpv6Address,
  isBogusOrTunCandidate,
  isTunVirtualAddress,
  optimizeCandidatePriority,
  sortCandidatesPreferIpv6,
  synthesizeSymmetricNatPortCandidates,
  CONNECTION_TIMING,
  shouldAllowTurnForAttempt,
  shouldForceRelayForAttempt,
  SILENT_UPGRADE,
  getSilentUpgradeDelayMs
} from '@/services/webrtc/connectivity'
import { PeerConnectionManager, type PeerConnectionFactoryOptions } from '@/services/webrtc/peerManager'
import { createClientSession } from '@/services/webrtc/clientSession'
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

  describe('buildIceConfiguration & Zero-TURN specification', () => {
    it('initializes default config with 100% pure STUN and zero TURN servers', () => {
      const config = buildIceConfiguration(false)
      expect(config.iceServers).toEqual(PURE_STUN_SERVERS.iceServers)
      expect(config.iceTransportPolicy).toBe('all')
      expect(config.iceCandidatePoolSize).toBe(2)

      // 验证绝不包含任何 turn: 或 turns: 条目
      const serialized = JSON.stringify(config.iceServers)
      expect(serialized.includes('turn:')).toBe(false)
      expect(serialized.includes('turns:')).toBe(false)
    })

    it('includes TURN servers only when allowTurn is explicitly true', () => {
      const config = buildIceConfiguration(true, false)
      expect(config.iceServers.length).toBe(
        (PURE_STUN_SERVERS.iceServers?.length || 0) + TURN_SERVERS.length
      )
      expect(config.iceTransportPolicy).toBe('all')
      const serialized = JSON.stringify(config.iceServers)
      expect(serialized.includes('turn:global.relay.metered.ca')).toBe(true)
    })

    it('builds relay-only config when forceRelay is true', () => {
      const config = buildIceConfiguration(true, true)
      expect(config.iceTransportPolicy).toBe('relay')
      const serialized = JSON.stringify(config.iceServers)
      expect(serialized.includes('turn:global.relay.metered.ca')).toBe(true)
    })

    it('shouldAllowTurnForAttempt permits TURN only at attempt >= 3 (Zero-TURN by default)', () => {
      expect(shouldAllowTurnForAttempt(0)).toBe(false)
      expect(shouldAllowTurnForAttempt(1)).toBe(false)
      expect(shouldAllowTurnForAttempt(2)).toBe(false)
      expect(shouldAllowTurnForAttempt(3)).toBe(true)
      expect(shouldAllowTurnForAttempt(4)).toBe(true)
    })

    it('shouldForceRelayForAttempt implements escalation ladder after attempt 3: attempt 4/6 relay', () => {
      expect(shouldForceRelayForAttempt(1)).toBe(false)
      expect(shouldForceRelayForAttempt(2)).toBe(false)
      expect(shouldForceRelayForAttempt(3)).toBe(false)
      expect(shouldForceRelayForAttempt(4)).toBe(true)
      expect(shouldForceRelayForAttempt(5)).toBe(false)
      expect(shouldForceRelayForAttempt(6)).toBe(true)
    })

    it('calculates silent upgrade exponential backoff delay correctly capped at 300s', () => {
      // Relay tier: backoff 20s -> 40s -> 80s -> 160s -> 300s (cap)
      expect(getSilentUpgradeDelayMs('relay', 0, false)).toBe(20000)
      expect(getSilentUpgradeDelayMs('relay', 1, false)).toBe(40000)
      expect(getSilentUpgradeDelayMs('relay', 2, false)).toBe(80000)
      expect(getSilentUpgradeDelayMs('relay', 3, false)).toBe(160000)
      expect(getSilentUpgradeDelayMs('relay', 4, false)).toBe(300000)
      expect(getSilentUpgradeDelayMs('relay', 5, false)).toBe(300000)

      // NAT P2P with IPv6 available: 60s -> 180s -> 600s -> null (max 3 probes)
      expect(getSilentUpgradeDelayMs('nat_p2p', 0, true)).toBe(60000)
      expect(getSilentUpgradeDelayMs('nat_p2p', 1, true)).toBe(180000)
      expect(getSilentUpgradeDelayMs('nat_p2p', 2, true)).toBe(600000)
      expect(getSilentUpgradeDelayMs('nat_p2p', 3, true)).toBe(null)

      // NAT P2P without IPv6: null
      expect(getSilentUpgradeDelayMs('nat_p2p', 0, false)).toBe(null)

      // Optimal direct tier (LAN / IPv6): null
      expect(getSilentUpgradeDelayMs('lan_p2p', 0, true)).toBe(null)
      expect(getSilentUpgradeDelayMs('ipv6_p2p', 0, true)).toBe(null)
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

    it('preserves and sanitizes TUN-derived public srflx candidates while synthesizing sequential ports for 4-tuple VPN/CGNAT', () => {
      const tunHost = 'candidate:1 1 udp 2122260223 198.18.0.1 60488 typ host generation 0 ufrag BAjQ network-id 2 network-cost 50'
      const tunSrflx = 'candidate:2 1 udp 1686052607 39.157.118.113 31081 typ srflx raddr 198.18.0.1 rport 60488 generation 0 ufrag BAjQ network-id 2 network-cost 50'

      // TUN host must be filtered, but TUN public srflx MUST be preserved on both Host and Client
      expect(isBogusOrTunCandidate(tunHost, false)).toBe(true)
      expect(isBogusOrTunCandidate(tunSrflx, false)).toBe(false)
      expect(isBogusOrTunCandidate(tunSrflx, true)).toBe(false)

      // raddr 198.18.0.1 must be sanitized to 0.0.0.0 and network-cost 50 normalized to 10
      const optimized = optimizeCandidatePriority(tunSrflx)
      expect(optimized).toContain('raddr 0.0.0.0')
      expect(optimized).toContain('network-cost 10')

      // Verify sequential port prediction (+1..+5, -1) for traversing 4-tuple VPN / Symmetric CGNAT without TURN
      ;(globalThis as any).__TEST_ENABLE_PORT_PREDICTION__ = true
      try {
        const predicted = synthesizeSymmetricNatPortCandidates(tunSrflx)
        expect(predicted.length).toBe(6)
        expect(predicted[0]).toContain('39.157.118.113 31082 typ srflx')
        expect(predicted[1]).toContain('39.157.118.113 31083 typ srflx')
        expect(predicted[5]).toContain('39.157.118.113 31080 typ srflx')
      } finally {
        delete (globalThis as any).__TEST_ENABLE_PORT_PREDICTION__
      }
    })

    it('ranks VPN/TUN-reflected Global Unicast IPv6 srflx candidates above IPv4 srflx and demotes TCP active port 9', () => {
      const tunV6Srflx =
        'candidate:321820268 1 udp 1686055167 2404:c140:2103:11f4:7a71:35ec:cc:35ec 32463 typ srflx raddr fdfe:dcba:9876::1 rport 49266 generation 0 ufrag vVL1 network-id 4 network-cost 50'
      const tunV4Srflx =
        'candidate:3241306507 1 udp 1686052607 39.157.118.113 31081 typ srflx raddr 198.18.0.1 rport 60488 generation 0 ufrag BAjQ network-id 2 network-cost 50'
      const physV4Srflx =
        'candidate:1617423965 1 udp 1518212863 39.157.118.113 31080 typ srflx raddr 192.168.1.9 rport 60489 generation 0 ufrag BAjQ network-id 1 network-cost 10'
      const tcpPort9V6 =
        'candidate:1481299846 1 tcp 1518283007 2409:8a00:1852:2f10:3dfe:c0b8:9799:b044 9 typ host tcptype active generation 0 ufrag RP/N network-id 2 network-cost 10'

      expect(isBogusOrTunCandidate(tunV6Srflx, true)).toBe(false)
      const optV6 = optimizeCandidatePriority(tunV6Srflx)
      const optTunV4 = optimizeCandidatePriority(tunV4Srflx)
      const optPhysV4 = optimizeCandidatePriority(physV4Srflx)

      expect(optV6).toContain('raddr ::')
      expect(optV6).toContain('network-cost 10')

      const prioV6 = parseInt(optV6.split(/\s+/)[3] || '0', 10)
      const prioPhysV4 = parseInt(optPhysV4.split(/\s+/)[3] || '0', 10)
      const prioTunV4 = parseInt(optTunV4.split(/\s+/)[3] || '0', 10)

      // TUN-reflected GUA IPv6 srflx must have strictly higher priority than both physical and TUN IPv4 srflx
      expect(prioV6).toBeGreaterThan(prioPhysV4)
      expect(prioPhysV4).toBeGreaterThan(prioTunV4)

      // sortCandidatesPreferIpv6 must place TCP port 9 active candidate below UDP srflx
      const sorted = sortCandidatesPreferIpv6([
        { candidate: tcpPort9V6 },
        { candidate: physV4Srflx },
        { candidate: tunV6Srflx }
      ])
      expect(sorted[0]?.candidate).toBe(tunV6Srflx)
      expect(sorted[1]?.candidate).toBe(physV4Srflx)
      expect(sorted[2]?.candidate).toBe(tcpPort9V6)

      // Verify mobile VPN virtual subnets (v2rayNG / NekoBox) are recognized as TUN addresses
      expect(isTunVirtualAddress('10.10.14.1')).toBe(true)
      expect(isTunVirtualAddress('26.26.26.1')).toBe(true)
      expect(isTunVirtualAddress('172.19.0.1')).toBe(true)

      // Verify DNS-free IPv6 literals include both domestic and overseas Google/Cloudflare STUN
      const allUrls = (PURE_STUN_SERVERS.iceServers || []).flatMap((s) =>
        Array.isArray(s.urls) ? s.urls : [s.urls]
      )
      expect(allUrls).toContain('stun:[2409:8c50:e00::3]:3478')
      expect(allUrls).toContain('stun:[2606:4700:49::]:3478')
      expect(allUrls).toContain('stun:[2001:4860:4864:5:8000::1]:19302')
      expect(allUrls).toContain('stun:74.125.250.129:19302')
    })

    it('selectStunUrls merges domestic, overseas, and DoH IPv6 literals with deduplication', () => {
      const urls = selectStunUrls({
        dohUrls: ['stun:[2409:8c50:e00::1]:3478', 'stun:[240e:928:1400::1]:3478']
      })
      for (const u of DOMESTIC_LITERAL_STUN_URLS) {
        expect(urls).toContain(u)
      }
      for (const u of OVERSEAS_LITERAL_STUN_URLS) {
        expect(urls).toContain(u)
      }
      expect(urls).toContain('stun:[240e:928:1400::1]:3478')
      expect(new Set(urls).size).toBe(urls.length)
    })

    it('warmUpDoHStunIpv6 retries after total failure instead of permanently caching empty result', async () => {
      resetDoHStunCache()
      const origFetch = globalThis.fetch
      ;(globalThis as any).__TEST_ALLOW_DOH_WARMUP__ = true
      try {
        // 1st attempt: all DoH requests fail
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any
        const firstRes = await warmUpDoHStunIpv6()
        expect(firstRes).toEqual([])

        // Advance past cooldown (5000ms) and succeed on 2nd attempt
        await vi.advanceTimersByTimeAsync(6000)
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            Answer: [{ type: 28, data: '2409:8c50:e00::99' }]
          })
        }) as any

        const secondRes = await warmUpDoHStunIpv6()
        expect(secondRes).toContain('stun:[2409:8c50:e00::99]:3478')

        // Bounded wait returns immediately once cached
        const boundedRes = await waitForDoHStunIpv6Bounded(100)
        expect(boundedRes).toContain('stun:[2409:8c50:e00::99]:3478')
      } finally {
        globalThis.fetch = origFetch
        delete (globalThis as any).__TEST_ALLOW_DOH_WARMUP__
        resetDoHStunCache()
      }
    })

    it('waitForDoHStunIpv6Bounded respects maxWaitMs timeout when DoH is slow', async () => {
      resetDoHStunCache()
      const origFetch = globalThis.fetch
      ;(globalThis as any).__TEST_ALLOW_DOH_WARMUP__ = true
      try {
        globalThis.fetch = vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(
                () =>
                  resolve({
                    ok: true,
                    json: async () => ({ Answer: [{ type: 28, data: '2409:8c50:e00::88' }] })
                  }),
                1000
              )
            })
        ) as any

        const p = waitForDoHStunIpv6Bounded(300)
        await vi.advanceTimersByTimeAsync(310)
        const earlyRes = await p
        expect(earlyRes).toEqual([])

        // After 1000ms total, background DoH finishes and populates cache
        await vi.advanceTimersByTimeAsync(750)
        expect(selectStunUrls()).toContain('stun:[2409:8c50:e00::88]:3478')
      } finally {
        globalThis.fetch = origFetch
        delete (globalThis as any).__TEST_ALLOW_DOH_WARMUP__
        resetDoHStunCache()
      }
    })

    it('applyProxyExitDemotionToBatch demotes overseas proxy-exit srflx only when domestic srflx differs on same family', () => {
      expect(classifyStunUrlOrigin('stun:111.8.3.78:3478')).toBe('domestic')
      expect(classifyStunUrlOrigin('stun:[2409:8c50:e00::3]:3478')).toBe('domestic')
      expect(classifyStunUrlOrigin('stun:74.125.250.129:19302')).toBe('overseas')
      expect(classifyStunUrlOrigin('stun:[2606:4700:49::]:3478')).toBe('overseas')

      const directSrflx = optimizeCandidatePriority(
        'candidate:1 1 udp 1686052607 39.157.118.113 41000 typ srflx raddr 192.168.1.9 rport 55000 generation 0 ufrag abcd network-id 1 network-cost 10'
      )
      const proxySrflx = optimizeCandidatePriority(
        'candidate:2 1 udp 1686052607 103.152.112.88 52000 typ srflx raddr 192.168.1.9 rport 55000 generation 0 ufrag abcd network-id 1 network-cost 10'
      )

      // Case 1: Split-tunnel VPN/TUN (domestic STUN -> 39.157.118.113, overseas STUN -> 103.152.112.88)
      const batchSplit = applyProxyExitDemotionToBatch([
        {
          candObj: { candidate: directSrflx },
          stunUrl: 'stun:111.8.3.78:3478',
          rawRaddr: '192.168.1.9',
          rawRport: '55000',
          rawNetId: '1'
        },
        {
          candObj: { candidate: proxySrflx },
          stunUrl: 'stun:74.125.250.129:19302',
          rawRaddr: '192.168.1.9',
          rawRport: '55000',
          rawNetId: '1'
        }
      ])
      const prioDirect = parseInt(batchSplit[0]!.candidate!.split(/\s+/)[3] || '0', 10)
      const prioProxy = parseInt(batchSplit[1]!.candidate!.split(/\s+/)[3] || '0', 10)
      expect(prioDirect).toBeGreaterThan(prioProxy)
      // Proxy exit is demoted to typePref 80 (80 * 16777216 = 1342177280..1350565887)
      expect(Math.floor(prioProxy / 16777216)).toBe(80)

      // Case 2: Overseas user or Global VPN (only overseas STUN responded, or same IP) -> NO demotion
      const batchOverseasOnly = applyProxyExitDemotionToBatch([
        {
          candObj: { candidate: proxySrflx },
          stunUrl: 'stun:74.125.250.129:19302',
          rawRaddr: '192.168.1.9',
          rawRport: '55000',
          rawNetId: '1'
        }
      ])
      const prioOverseasOnly = parseInt(batchOverseasOnly[0]!.candidate!.split(/\s+/)[3] || '0', 10)
      expect(Math.floor(prioOverseasOnly / 16777216)).toBe(90)

      // Case 3: Browser did not provide event.url -> NO demotion
      const batchNoUrl = applyProxyExitDemotionToBatch([
        { candObj: { candidate: directSrflx } },
        { candObj: { candidate: proxySrflx } }
      ])
      const prioNoUrl = parseInt(batchNoUrl[1]!.candidate!.split(/\s+/)[3] || '0', 10)
      expect(Math.floor(prioNoUrl / 16777216)).toBe(90)

      // Verify libwebrtc unbracketed IPv6 STUN URL format (stun_port.cc: "stun:" << hostname << ":" << port)
      expect(extractStunUrlHost('stun:2409:8c50:e00::3:3478')).toBe('2409:8c50:e00::3')
      expect(extractStunUrlHost('stun:2606:4700:49:::3478')).toBe('2606:4700:49::')
      expect(classifyStunUrlOrigin('stun:2409:8c50:e00::3:3478')).toBe('domestic')
      expect(classifyStunUrlOrigin('stun:2606:4700:49:::3478')).toBe('overseas')
      expect(classifyStunUrlOrigin('stun:2001:4860:4864:5:8000::1:19302')).toBe('overseas')
    })

    it('finalizeLocalSdp demotes split-tunnel proxy-exit srflx embedded in Offer/Answer SDP (via RTCIceCandidate.url and getStats fallback)', async () => {
      const mockPeer = createMockPeer()
      global.RTCPeerConnection = vi.fn().mockImplementation(() => mockPeer) as any

      const mockOptions = createMockOptions()
      const manager = new PeerConnectionManager(mockOptions)
      const pc = manager.createPeerConnection('host-target', undefined, false, undefined, {
        sessionTag: 'sess-sdp',
        holdLocalCandidates: true
      })

      const directLine =
        'candidate:1 1 udp 1686052607 39.157.118.113 41000 typ srflx raddr 198.18.0.1 rport 55000 generation 0 ufrag abcd network-id 2 network-cost 50'
      const proxyLine =
        'candidate:2 1 udp 1686052607 103.152.112.88 52000 typ srflx raddr 198.18.0.1 rport 55000 generation 0 ufrag abcd network-id 2 network-cost 50'

      // 1. Simulate Chromium 123+ RTCIceCandidate.url recorded during onicecandidate
      mockPeer.onicecandidate({
        candidate: {
          candidate: directLine,
          url: 'stun:111.8.3.78:3478',
          toJSON: () => ({ candidate: directLine })
        }
      })
      mockPeer.onicecandidate({
        candidate: {
          candidate: proxyLine,
          url: 'stun:74.125.250.129:19302',
          toJSON: () => ({ candidate: proxyLine })
        }
      })

      const rawSdp = ['v=0', `a=${directLine}`, `a=${proxyLine}`].join('\r\n')
      const finalized = await manager.finalizeLocalSdp(pc, rawSdp)
      const outLines = finalized.split(/\r\n/)
      const outDirectPrio = parseInt(outLines[1]!.split(/\s+/)[3] || '0', 10)
      const outProxyPrio = parseInt(outLines[2]!.split(/\s+/)[3] || '0', 10)
      // Direct TUN-reflected srflx stays at typePref 88, while proxy-exit srflx in SDP is demoted to typePref 80
      expect(Math.floor(outDirectPrio / 16777216)).toBe(88)
      expect(Math.floor(outProxyPrio / 16777216)).toBe(80)

      // 2. Simulate legacy browser without candidate.url, falling back to getStats() local-candidate.url
      const mockPeerLegacy = createMockPeer()
      const v6DirectLine =
        'candidate:3 1 udp 1686055167 2409:8a00:1234::10 61000 typ srflx raddr fdfe:dcba:9876::1 rport 56000 generation 0 ufrag abcd network-id 4 network-cost 50'
      const v6ProxyLine =
        'candidate:4 1 udp 1686055167 2404:c140:2103::99 62000 typ srflx raddr fdfe:dcba:9876::1 rport 56000 generation 0 ufrag abcd network-id 4 network-cost 50'

      mockPeerLegacy.getStats = vi.fn().mockResolvedValue([
        {
          type: 'local-candidate',
          candidateType: 'srflx',
          address: '2409:8a00:1234::10',
          port: 61000,
          relatedAddress: 'fdfe:dcba:9876::1',
          relatedPort: 56000,
          // Unbracketed libwebrtc format from stun_port.cc
          url: 'stun:2409:8c50:e00::3:3478'
        },
        {
          type: 'local-candidate',
          candidateType: 'srflx',
          address: '2404:c140:2103::99',
          port: 62000,
          relatedAddress: 'fdfe:dcba:9876::1',
          relatedPort: 56000,
          url: 'stun:2606:4700:49:::3478'
        }
      ])

      global.RTCPeerConnection = vi.fn().mockImplementation(() => mockPeerLegacy) as any
      const pcLegacy = manager.createPeerConnection('host-target-2')
      const legacySdp = ['v=0', `a=${v6DirectLine}`, `a=${v6ProxyLine}`].join('\r\n')
      const finalizedLegacy = await manager.finalizeLocalSdp(pcLegacy, legacySdp)
      const legacyLines = finalizedLegacy.split(/\r\n/)
      const v6DirectPrio = parseInt(legacyLines[1]!.split(/\s+/)[3] || '0', 10)
      const v6ProxyPrio = parseInt(legacyLines[2]!.split(/\s+/)[3] || '0', 10)
      expect(v6DirectPrio).toBeGreaterThan(v6ProxyPrio)
      expect(Math.floor(v6DirectPrio / 16777216)).toBe(98)
      expect(Math.floor(v6ProxyPrio / 16777216)).toBe(95)
    })

    it('triggers 1800ms late SLAAC GUA IPv6 reconnect when initial offer lacked IPv6 and DC is still connecting', async () => {
      resetLocalIpv6ProbeCache()
      ;(globalThis as any).__TEST_ENABLE_LATE_SLAAC__ = true

      // 1st probe during initial setup returns no IPv6
      vi.mocked(api.getNetworkInfo).mockResolvedValueOnce({
        primaryIp: '192.168.1.50',
        allIps: ['192.168.1.50'],
        primaryIpv6: '',
        allIpv6s: [],
        port: 8080,
        joinBaseUrl: 'http://192.168.1.50:8080'
      })

      let createdPeers = 0
      global.RTCPeerConnection = vi.fn().mockImplementation(() => {
        createdPeers++
        const peer = createMockPeer()
        peer.localDescription = { type: 'offer', sdp: 'v=0\r\na=candidate:1 1 udp 2113937151 192.168.1.50 50000 typ host\r\n' }
        peer.createOffer = vi.fn().mockResolvedValue(peer.localDescription)
        peer.setLocalDescription = vi.fn().mockResolvedValue(undefined)
        return peer
      }) as any

      let curPc: any = null
      let curDc: any = null
      const mockSignaling = { send: vi.fn(), isConnected: () => true }
      const mockOptions = createMockOptions()
      mockOptions.getSignaling = () => mockSignaling as any
      const peerMgr = new PeerConnectionManager(mockOptions)

      const session = createClientSession({
        peerMgr,
        sas: {
          clientSasState: 'VERIFIED',
          clientSharedAesKey: null,
          clientHostEcdhPubHex: '',
          clientHostDeviceId: '',
          clientSecurityFingerprint: ''
        } as any,
        getSignaling: () => mockSignaling as any,
        getLocalEcdhKeyPair: () => null,
        getLocalEcdhPubHex: () => '',
        getLocalDeviceId: () => 'dev-1',
        getCurrentInviteCode: () => 'INV1',
        getCurrentHostSessionId: () => 'host-1',
        setCurrentHostSessionId: () => {},
        getClientSessionId: () => 'sess-1',
        setClientSessionId: () => {},
        getClientHostSenderId: () => 'host-sender',
        setClientHostSenderId: () => {},
        getClientPc: () => curPc,
        setClientPc: (pc) => {
          curPc = pc
        },
        getClientDc: () => curDc,
        setClientDc: (dc) => {
          curDc = dc
        },
        setClientSender: () => {},
        getClientPendingCandidates: () => [],
        setClientPendingCandidates: () => {},
        getClientForceRelay: () => false,
        setClientForceRelay: () => {},
        isExplicitlyClosed: () => false,
        isHostMode: () => false,
        getStatus: () => 'connecting',
        setStatus: () => {},
        handleChannelMessage: async () => {},
        rejectSas: () => {},
        callbacks: mockOptions.callbacks
      })

      try {
        await session.setupClientConnection()
        expect(createdPeers).toBe(1)

        // Now SLAAC finishes at 1800ms and assigns a GUA IPv6 address
        vi.mocked(api.getNetworkInfo).mockResolvedValue({
          primaryIp: '192.168.1.50',
          allIps: ['192.168.1.50'],
          primaryIpv6: '2409:8a00:1234::88',
          allIpv6s: ['2409:8a00:1234::88'],
          port: 8080,
          joinBaseUrl: 'http://192.168.1.50:8080'
        })

        await vi.advanceTimersByTimeAsync(1900)
        // Must have triggered a new handshake (2nd PeerConnection created)
        expect(createdPeers).toBe(2)
      } finally {
        delete (globalThis as any).__TEST_ENABLE_LATE_SLAAC__
      }
    })
  })
})
