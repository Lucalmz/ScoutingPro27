import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildIceConfiguration,
  selectStunUrls,
  shouldAllowTurnForAttempt,
  DOMESTIC_LITERAL_STUN_URLS,
  OVERSEAS_LITERAL_STUN_URLS,
  PURE_STUN_SERVERS,
  STUN_SERVERS,
  TURN_SERVERS,
  CONNECTION_TIMING
} from '@/services/webrtc/connectivity'
import { PeerConnectionManager } from '@/services/webrtc/peerManager'
import { createClientSession } from '@/services/webrtc/clientSession'
import { createClientVirtualFallbackController } from '@/services/webrtc/clientVirtualFallback'
import { VirtualDataChannel } from '@/services/webrtc/virtualDataChannel'
import { createClientSilentUpgradeManager } from '@/services/webrtc/clientSilentUpgrade'
import { createHostSignalingHandler } from '@/services/webrtc/hostSession'
import { SasSecurityManager } from '@/services/webrtc/sasManager'
import { encryptSignalingData } from '@/utils/crypto'
import { clearDiagnosticLogs, exportDiagnosticReport } from '@/utils/logger'
import * as api from '@/services/api'

const realSetTimeout = globalThis.setTimeout.bind(globalThis)

async function waitUntil(predicate: () => boolean, maxAttempts = 80): Promise<void> {
  for (let i = 0; i < maxAttempts && !predicate(); i++) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 2))
  }
}

vi.mock('@/services/api', () => ({
  getNetworkInfo: vi.fn().mockResolvedValue(null),
  createWebRtcTicket: vi.fn().mockResolvedValue({ ticket: 'test_ticket', expiresIn: 180 })
}))

function createMockPeer(overrides: Record<string, any> = {}) {
  const dcObj: any = {
    readyState: 'connecting',
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    onmessage: null,
    onopen: null,
    onclose: null,
    onerror: null
  }
  const closeSpy = vi.fn().mockImplementation(() => {
    peer.connectionState = 'closed'
    peer.iceConnectionState = 'closed'
    peer.signalingState = 'closed'
  })
  const peer: any = {
    connectionState: 'new',
    iceConnectionState: 'new',
    iceGatheringState: 'new',
    signalingState: 'have-local-offer',
    localDescription: { type: 'offer', sdp: 'v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host\r\n' },
    remoteDescription: null,
    createDataChannel: vi.fn().mockReturnValue(dcObj),
    createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'v=0\r\n' }),
    createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0\r\n' }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockImplementation(async () => {
      peer.remoteDescription = { type: 'answer', sdp: 'v=0\r\n' }
      peer.signalingState = 'stable'
    }),
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    setConfiguration: vi.fn(),
    getStats: vi.fn().mockResolvedValue(new Map()),
    close: closeSpy,
    _origClose: closeSpy,
    onicecandidate: null,
    oniceconnectionstatechange: null,
    onconnectionstatechange: null,
    onicegatheringstatechange: null,
    ondatachannel: null,
    _dc: dcObj,
    ...overrides
  }
  return peer
}

describe('WebRTC ICE Diagnostics & TURN Escalation Hardening', () => {
  let mockAesKey: CryptoKey
  const origRtcpc = global.RTCPeerConnection

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(api.getNetworkInfo).mockResolvedValue(null as any)
    vi.mocked(api.createWebRtcTicket).mockResolvedValue({ ticket: 'test_ticket', expiresIn: 180 })
    vi.useFakeTimers()
    clearDiagnosticLogs()
    mockAesKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  })

  afterEach(() => {
    global.RTCPeerConnection = origRtcpc
    delete (globalThis as any).__TEST_ENABLE_TURN_ESCALATION__
    delete (globalThis as any).__TEST_HEARTBEAT_INTERVAL_MS__
    delete (globalThis as any).__TEST_PING_TIMEOUT_MS__
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // =========================================================================
  // Requirement 1: Early (<3.8s) ice_failed -> VirtualDataChannel or failAttempt
  // =========================================================================
  it('2. keeps Attempt 0/1/2 STUN-only (no early TURN iceRestart), enables turns:443/tcp at attempt >= 3 or forceRelay', async () => {
    expect(shouldAllowTurnForAttempt(0)).toBe(false)
    expect(shouldAllowTurnForAttempt(1)).toBe(false)
    expect(shouldAllowTurnForAttempt(2)).toBe(false)
    expect(shouldAllowTurnForAttempt(3)).toBe(true)
    expect(TURN_SERVERS[0]?.urls).toBe('turns:global.relay.metered.ca:443?transport=tcp')

    const createdPeers: any[] = []
    const peerConfigs: any[] = []
    global.RTCPeerConnection = vi.fn().mockImplementation((cfg: any) => {
      peerConfigs.push(cfg)
      const p = createMockPeer({ signalingState: 'stable' })
      createdPeers.push(p)
      return p
    }) as any

    let curPc: any = null
    let curDc: any = null
    let status = 'connecting'
    const sentPayloads: any[] = []
    const mockSignaling = {
      send: vi.fn().mockImplementation((payload: any) => {
        sentPayloads.push(payload)
      }),
      isConnected: () => true
    }

    const callbacks: any = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const peerMgr = new PeerConnectionManager({
      getSignaling: () => mockSignaling as any,
      isHostMode: () => false,
      callbacks,
      setStatus: (s) => { status = s },
      getClientSharedAesKey: () => null,
      getClientSharedKey: () => null,
      getClientFingerprint: () => undefined,
      getClientSecurityFingerprint: () => '',
      getClientHostSenderId: () => 'host-peer-1',
      isExplicitlyClosed: () => false
    })

    const session = createClientSession({
      peerMgr,
      sas: { clientSasState: 'VERIFIED', clientSharedAesKey: null } as any,
      getSignaling: () => mockSignaling as any,
      getLocalEcdhKeyPair: () => null,
      getLocalEcdhPubHex: () => '',
      getLocalDeviceId: () => 'phone-dev-3',
      getCurrentInviteCode: () => 'INV123',
      getCurrentHostSessionId: () => 'host-sess-1',
      setCurrentHostSessionId: () => {},
      getClientSessionId: () => 'sess-direct-first',
      setClientSessionId: () => {},
      getClientHostSenderId: () => 'host-peer-1',
      setClientHostSenderId: () => {},
      getClientPc: () => curPc,
      setClientPc: (pc) => { curPc = pc },
      getClientDc: () => curDc,
      setClientDc: (dc) => { curDc = dc },
      setClientSender: () => {},
      getClientPendingCandidates: () => [],
      setClientPendingCandidates: () => {},
      getClientForceRelay: () => false,
      setClientForceRelay: () => {},
      isExplicitlyClosed: () => false,
      isHostMode: () => false,
      getStatus: () => status,
      setStatus: (s) => { status = s },
      sendMessage: async () => {},
      handleChannelMessage: async () => {},
      rejectSas: () => {},
      callbacks
    })

    await session.setupClientConnection()
    expect(createdPeers).toHaveLength(1)
    expect(JSON.stringify(peerConfigs[0]?.iceServers)).not.toContain('turn')
    expect(sentPayloads[0]?.allowTurn).toBe(false)

    // Even after 5s+ or 0-srflx gathering completion, must NOT interrupt healthy direct attempt with early TURN iceRestart
    createdPeers[0].onicecandidate?.({ candidate: null })
    await vi.advanceTimersByTimeAsync(6000)
    expect(createdPeers[0].setConfiguration).not.toHaveBeenCalled()
    expect(sentPayloads.some((p) => p.iceRestart === true)).toBe(false)

    session.hardResetChannels()
  })

  it('5. selectStunUrls stays compact while covering domestic + overseas IPv4/IPv6 and preserving exported contracts', () => {
    expect(DOMESTIC_LITERAL_STUN_URLS.length).toBe(2)
    expect(OVERSEAS_LITERAL_STUN_URLS.length).toBe(2)
    expect(STUN_SERVERS).toBe(PURE_STUN_SERVERS)

    const base = selectStunUrls({ dohUrls: [] })
    expect(base).toEqual([
      'stun:111.8.3.78:3478',
      'stun:[2409:8c50:e00::3]:3478',
      'stun:74.125.250.129:19302',
      'stun:[2606:4700:49::]:3478'
    ])

    // Caps extra DoH URLs at 2 and deduplicates
    const withDoh = selectStunUrls({
      dohUrls: [
        'stun:[2409:8c50:e00::3]:3478',
        'stun:[240e:928:1400::1]:3478',
        'stun:[2001:4860:4864:5:8000::1]:19302',
        'stun:[2a01:4f8:1c1e:d769::1]:3478'
      ]
    })
    expect(withDoh).toHaveLength(6)
    expect(new Set(withDoh).size).toBe(6)
    expect(withDoh).toContain('stun:[240e:928:1400::1]:3478')
    expect(withDoh).toContain('stun:[2001:4860:4864:5:8000::1]:19302')
    expect(withDoh).not.toContain('stun:[2a01:4f8:1c1e:d769::1]:3478')

    // Ensure buildIceConfiguration(false) in non-test env stays free of TURN
    const cfg = buildIceConfiguration(false, false)
    expect(JSON.stringify(cfg.iceServers)).not.toContain('turn:')
  })

  it('E1. PeerConnectionManager dumps all candidate-pair and remote-candidate (incl. prflx) stats into log & exportDiagnosticReport on ice_failed and VirtualDC takeover', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const statsMap = new Map<string, any>([
        [
          'local-cand-1',
          { id: 'local-cand-1', type: 'local-candidate', candidateType: 'host', address: '2409:8a00::1', port: 50001, protocol: 'udp' }
        ],
        [
          'remote-cand-prflx',
          { id: 'remote-cand-prflx', type: 'remote-candidate', candidateType: 'prflx', address: '39.157.1.2', port: 41234, protocol: 'udp' }
        ],
        [
          'pair-1',
          {
            id: 'pair-1',
            type: 'candidate-pair',
            state: 'in-progress',
            nominated: false,
            localCandidateId: 'local-cand-1',
            remoteCandidateId: 'remote-cand-prflx',
            requestsSent: 7,
            requestsReceived: 1,
            responsesReceived: 0,
            responsesSent: 1
          }
        ]
      ])

      const pc1 = createMockPeer({
        iceConnectionState: 'checking',
        getStats: vi.fn().mockResolvedValue(statsMap)
      })
      const pc2 = createMockPeer({
        iceConnectionState: 'checking',
        getStats: vi.fn().mockResolvedValue(statsMap)
      })
      let idx = 0
      global.RTCPeerConnection = vi.fn().mockImplementation(() => (idx++ === 0 ? pc1 : pc2)) as any

      const peerMgr = new PeerConnectionManager({
        getSignaling: () => ({ send: vi.fn() }) as any,
        isHostMode: () => true,
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
        getClientFingerprint: () => undefined,
        getClientSecurityFingerprint: () => ''
      })

      // 1) ice_failed trigger -> dumps stats into console & exportDiagnosticReport() even when ENABLE_DIAGNOSTICS=false
      const peerA = peerMgr.createPeerConnection('phone-peer-A', vi.fn())
      peerA.iceConnectionState = 'failed'
      peerA.oniceconnectionstatechange?.({} as any)
      await waitUntil(() => exportDiagnosticReport().includes('remote-cand-prflx'))

      const report = exportDiagnosticReport()
      expect(report).toContain('[WebRTC:IceStats]')
      expect(report).toContain('trigger=ice_failed')
      expect(report).toContain('hasPrflx=true')
      expect(report).toContain('"requestsSent":7')
      expect(report).toContain('"requestsReceived":1')
      expect(report).toContain('"responsesReceived":0')
      expect(report).toContain('"responsesSent":1')
      expect(report).toContain('"candidateType":"prflx"')
      expect(report).toContain('"address":"39.157.1.2"')
      expect(report).toContain('"port":41234')
      expect(warnSpy).toHaveBeenCalled()

      // 2) VirtualDC takeover trigger -> dumps stats
      const peerB = peerMgr.createPeerConnection('phone-peer-B', vi.fn())
      peerB.iceConnectionState = 'checking'
      peerMgr.markVirtualChannelActive(peerB)
      await waitUntil(() => exportDiagnosticReport().includes('trigger=virtual_dc_takeover'))
      expect(exportDiagnosticReport()).toContain('trigger=virtual_dc_takeover')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('M1-1. buildIceConfiguration({ primaryTurnOnly: true }) allocates only TURN_SERVERS[0] (turns:443/tcp) to conserve Metered quota', () => {
    const fullTurn = buildIceConfiguration(true, false)
    const primaryOnly = buildIceConfiguration(true, false, { primaryTurnOnly: true })
    const turnCountFull = (fullTurn.iceServers || []).filter((s) =>
      String(s.urls).startsWith('turn')
    ).length
    const primaryTurns = (primaryOnly.iceServers || []).filter((s) =>
      String(s.urls).startsWith('turn')
    )
    expect(turnCountFull).toBe(TURN_SERVERS.length)
    expect(primaryTurns).toHaveLength(1)
    expect(primaryTurns[0]!.urls).toBe(TURN_SERVERS[0]!.urls)
    expect(primaryTurns[0]!.urls).toContain('turns:')
    expect(primaryTurns[0]!.urls).toContain(':443?transport=tcp')
  })

  it('M1-2. PeerConnectionManager boosts late domestic trickle srflx after gate.release() and closes UDP socket immediately (0ms delay)', async () => {
    const pc = createMockPeer({ connectionState: 'new' })
    global.RTCPeerConnection = vi.fn().mockImplementation(() => pc) as any
    const sentCands: any[] = []
    const peerMgr = new PeerConnectionManager({
      getSignaling: () => ({
        send: vi.fn().mockImplementation((payload: any) => {
          if (payload?.candidate) sentCands.push(payload.candidate)
        })
      }) as any,
      isHostMode: () => false,
      callbacks: {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn(),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn()
      },
      setStatus: vi.fn(),
      getClientSharedAesKey: () => null,
      getClientSharedKey: () => null,
      getClientFingerprint: () => undefined,
      getClientSecurityFingerprint: () => '',
      getClientHostSenderId: () => 'host-peer-1'
    })

    const created = peerMgr.createPeerConnection('host-peer-1', vi.fn(), false, 'host-peer-1', {
      sessionTag: 'sess-late-dom',
      holdLocalCandidates: true
    })

    // First: overseas proxy-exit srflx released before domestic arrives
    created.onicecandidate?.({
      candidate: {
        candidate: 'candidate:1 1 udp 1509949439 103.152.112.88 52000 typ srflx raddr 0.0.0.0 rport 55000',
        sdpMid: '0',
        sdpMLineIndex: 0,
        url: 'stun:74.125.250.129:19302'
      }
    } as any)
    peerMgr.releaseLocalCandidates(created)
    await waitUntil(() => sentCands.length >= 1)
    expect(sentCands).toHaveLength(1)
    const overseasPrio = parseInt(sentCands[0].candidate.split(/\s+/)[3], 10)

    // Second: late domestic srflx trickles in AFTER gate.release() -> must be boosted strictly above overseasPrio
    created.onicecandidate?.({
      candidate: {
        candidate: 'candidate:2 1 udp 1509949439 39.157.118.113 41000 typ srflx raddr 0.0.0.0 rport 55000',
        sdpMid: '0',
        sdpMLineIndex: 0,
        url: 'stun:111.8.3.78:3478'
      }
    } as any)
    await waitUntil(() => sentCands.length >= 2)
    expect(sentCands).toHaveLength(2)
    const boostedDomesticPrio = parseInt(sentCands[1].candidate.split(/\s+/)[3], 10)
    expect(boostedDomesticPrio).toBeGreaterThan(overseasPrio)

    // Synchronous close must NOT defer origClose by 150ms
    created.close()
    expect(pc._origClose).toHaveBeenCalledTimes(1)
  })
})
