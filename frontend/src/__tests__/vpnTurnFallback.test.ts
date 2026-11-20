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

describe('VPN & Mobile TURN / VirtualDataChannel Fallback Hardening', () => {
  let mockAesKey: CryptoKey
  const origRtcpc = global.RTCPeerConnection

  beforeEach(async () => {
    vi.clearAllMocks()
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
    vi.useRealTimers()
  })

  // =========================================================================
  // Requirement 1: Early (<3.8s) ice_failed -> VirtualDataChannel or failAttempt
  // =========================================================================
  it('1a. early (<3.8s) ice_failed immediately activates VirtualDataChannel without hardReset when AES key & hostSenderId exist', async () => {
    const createdPeers: any[] = []
    const peerConfigs: any[] = []
    global.RTCPeerConnection = vi.fn().mockImplementation((cfg: any) => {
      peerConfigs.push(cfg)
      const p = createMockPeer()
      createdPeers.push(p)
      return p
    }) as any

    let curPc: any = null
    let curDc: any = null
    let curSender: any = null
    let clientSessionId = ''
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
      onRequestSync: vi.fn(),
      onIceStalled: vi.fn(),
      onTransportInfoChanged: vi.fn()
    }
    const peerMgr = new PeerConnectionManager({
      getSignaling: () => mockSignaling as any,
      isHostMode: () => false,
      callbacks,
      setStatus: (s) => { status = s },
      getClientSharedAesKey: () => mockAesKey,
      getClientSharedKey: () => null,
      getClientFingerprint: () => undefined,
      getClientSecurityFingerprint: () => 'AABB-CCDD',
      getClientHostSenderId: () => 'host-peer-1',
      getClientDcState: () => curDc?.readyState,
      isExplicitlyClosed: () => false
    })

    const session = createClientSession({
      peerMgr,
      sas: {
        clientSasState: 'VERIFIED',
        clientSharedAesKey: mockAesKey,
        clientHostEcdhPubHex: '04abcd',
        clientHostDeviceId: 'host-dev',
        clientSecurityFingerprint: 'AABB-CCDD'
      } as any,
      getSignaling: () => mockSignaling as any,
      getLocalEcdhKeyPair: () => null,
      getLocalEcdhPubHex: () => '041122',
      getLocalDeviceId: () => 'phone-dev-1',
      getCurrentInviteCode: () => 'INV123',
      getCurrentHostSessionId: () => 'host-sess-1',
      setCurrentHostSessionId: () => {},
      getClientSessionId: () => clientSessionId,
      setClientSessionId: (id) => { clientSessionId = id },
      getClientHostSenderId: () => 'host-peer-1',
      setClientHostSenderId: () => {},
      getClientPc: () => curPc,
      setClientPc: (pc) => { curPc = pc },
      getClientDc: () => curDc,
      setClientDc: (dc) => { curDc = dc },
      setClientSender: (s) => { curSender = s },
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

    // Simulate early (<3.8s) ice_failed at 500ms under strict VPN
    await vi.advanceTimersByTimeAsync(500)
    const firstSessionId = clientSessionId
    createdPeers[0].iceConnectionState = 'failed'
    createdPeers[0].oniceconnectionstatechange?.({})

    // Wait deterministically for async crypto.subtle.encrypt -> vdc.open()
    await waitUntil(() => status === 'connected')

    // Must NOT have triggered hardReset/reconnect (only 1 PC created so far, same sessionId)
    expect(createdPeers).toHaveLength(1)
    expect(clientSessionId).toBe(firstSessionId)
    expect(status).toBe('connected')
    expect((curDc as any)?.isVirtual).toBe(true)
    expect(curDc?.readyState).toBe('open')
    expect(curSender).not.toBeNull()
    expect(callbacks.onTransportInfoChanged).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'relay', protocol: 'wss/tls', label: 'ECDH Tunnel (TLS)' })
    )

    session.hardResetChannels()
  })

  it('1b. early (<3.8s) ice_failed falls back to failAttempt when AES key or hostSenderId is absent, and escalates next attempt to allowTurn=true', async () => {
    const peerConfigs: any[] = []
    const createdPeers: any[] = []
    global.RTCPeerConnection = vi.fn().mockImplementation((cfg: any) => {
      peerConfigs.push(cfg)
      const p = createMockPeer()
      createdPeers.push(p)
      return p
    }) as any

    let curPc: any = null
    let curDc: any = null
    let status = 'connecting'
    const mockSignaling = { send: vi.fn(), isConnected: () => true }

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
      getClientHostSenderId: () => undefined,
      isExplicitlyClosed: () => false
    })

    const session = createClientSession({
      peerMgr,
      sas: {
        clientSasState: 'IDLE',
        clientSharedAesKey: null,
        clientHostEcdhPubHex: '',
        clientHostDeviceId: '',
        clientSecurityFingerprint: ''
      } as any,
      getSignaling: () => mockSignaling as any,
      getLocalEcdhKeyPair: () => null,
      getLocalEcdhPubHex: () => '',
      getLocalDeviceId: () => 'phone-dev-2',
      getCurrentInviteCode: () => 'INV123',
      getCurrentHostSessionId: () => 'host-sess-1',
      setCurrentHostSessionId: () => {},
      getClientSessionId: () => 'sess-no-key',
      setClientSessionId: () => {},
      getClientHostSenderId: () => undefined,
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

    // Trigger early ice_failed at 400ms without AES key -> must failAttempt and reconnect (Attempt 1) WITHOUT TURN (Direct -> VirtualDC -> TURN at attempt >= 3)
    await vi.advanceTimersByTimeAsync(400)
    createdPeers[0].iceConnectionState = 'failed'
    createdPeers[0].oniceconnectionstatechange?.({})

    // Attempt 1 reconnect backoff = 1000ms (still STUN-only)
    await vi.advanceTimersByTimeAsync(1100)
    expect(createdPeers).toHaveLength(2)
    expect(JSON.stringify(peerConfigs[1]?.iceServers)).not.toContain('turn')

    session.hardResetChannels()
  })

  // =========================================================================
  // Requirement 2 (Task A): Direct-first (Attempt 0/1/2 STUN-only), TURN only at attempt >= 3 or forceRelay
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

  // =========================================================================
  // Requirement 3 & 4: bg retry direct-first (allowTurn:false), old pc.close() leak fix, catch backoff retry;
  //                    clientSilentUpgrade direct-first (allowTurn:false)
  // =========================================================================
  it('3a & 4. clientVirtualFallback bg retry defaults allowTurn=false, closes previous PC (no leak), and reschedules after catch with capped backoff', async () => {
    const oldPc = createMockPeer()
    let curPc: any = oldPc
    let curDc: any = null
    let curSender: any = null
    let probeCount = 0
    const createdBgPcs: any[] = []
    const mockSignaling = { send: vi.fn() }

    const createOfferBehavior = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient offer failure 1'))
      .mockRejectedValueOnce(new Error('transient offer failure 2'))
      .mockResolvedValue({ type: 'offer', sdp: 'v=0\r\n' })

    global.RTCPeerConnection = vi.fn().mockImplementation((cfg: any) => {
      const p = createMockPeer({
        config: cfg,
        createOffer: createOfferBehavior
      })
      createdBgPcs.push({ peer: p, config: cfg })
      return p
    }) as any

    const peerMgr = new PeerConnectionManager({
      getSignaling: () => mockSignaling as any,
      isHostMode: () => false,
      callbacks: {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn(),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn(),
        onIceStalled: vi.fn()
      },
      setStatus: vi.fn(),
      getClientSharedAesKey: () => mockAesKey,
      getClientSharedKey: () => null,
      getClientFingerprint: () => undefined,
      getClientSecurityFingerprint: () => '',
      getClientHostSenderId: () => 'host-peer-1'
    })

    const ctx: any = {
      peerMgr,
      sas: { clientSharedAesKey: mockAesKey, clientSecurityFingerprint: '1111-2222' },
      getSignaling: () => mockSignaling,
      getLocalEcdhPubHex: () => '041122',
      getLocalDeviceId: () => 'dev-1',
      getClientSessionId: () => 'sess-bg-retry',
      getCurrentHostSessionId: () => 'host-1',
      getClientHostSenderId: () => 'host-peer-1',
      getClientPc: () => curPc,
      setClientPc: (pc: any) => { curPc = pc },
      getClientDc: () => curDc,
      setClientDc: (dc: any) => { curDc = dc },
      setClientSender: (s: any) => { curSender = s },
      getUsername: () => 'Scout',
      getUserId: () => 'u1',
      isExplicitlyClosed: () => false,
      isHostMode: () => false,
      getStatus: () => 'connected',
      setStatus: vi.fn(),
      handleChannelMessage: vi.fn(),
      callbacks: { onIceStalled: vi.fn(), onTransportInfoChanged: vi.fn() }
    }

    const ctrl = createClientVirtualFallbackController({
      ctx,
      getAttemptEpoch: () => 1,
      clearFailedEpochIfMatch: vi.fn(),
      clearConnectWatchdog: vi.fn(),
      clearReconnectTimer: vi.fn(),
      startDataChannelHeartbeat: vi.fn(),
      checkAndScheduleSilentUpgrade: vi.fn().mockResolvedValue(undefined),
      getSilentUpgradeProbeCount: () => probeCount,
      incrementSilentUpgradeProbeCount: () => ++probeCount,
      failAttempt: vi.fn()
    })

    ctrl.activateVirtualFallbackChannel(1, 'sess-bg-retry')
    await waitUntil(() => ctrl.isVirtualDcOpen())
    expect(ctrl.isVirtualDcOpen()).toBe(true)

    // Probe 1 scheduled at 20000ms -> throws in createOffer -> closes bgPc #1, closes oldPc, reschedules at 40000ms!
    await vi.advanceTimersByTimeAsync(20050)
    expect(oldPc._origClose).toHaveBeenCalledTimes(1)
    expect(createdBgPcs).toHaveLength(1)
    expect(JSON.stringify(createdBgPcs[0].config.iceServers)).not.toContain('turn')
    expect(createdBgPcs[0].peer._origClose).toHaveBeenCalledTimes(1)

    // Probe 2 scheduled at 40000ms -> throws again -> closes bgPc #2, reschedules at 80000ms!
    await vi.advanceTimersByTimeAsync(40050)
    expect(createdBgPcs).toHaveLength(2)
    expect(createdBgPcs[1].peer._origClose).toHaveBeenCalledTimes(1)

    // Probe 3 scheduled at 80000ms -> succeeds and sends direct-first Offer with allowTurn: false!
    await vi.advanceTimersByTimeAsync(80050)
    await waitUntil(() =>
      createdBgPcs.length === 3 &&
      mockSignaling.send.mock.calls.some(
        (c: any) => c[0]?.allowTurn === false && c[0]?.clientSessionId === 'sess-bg-retry'
      )
    )
    expect(createdBgPcs).toHaveLength(3)
    expect(curPc).toBe(createdBgPcs[2].peer)
    expect(mockSignaling.send).toHaveBeenCalledWith(
      expect.objectContaining({ allowTurn: false, clientSessionId: 'sess-bg-retry' }),
      'host-peer-1'
    )
    expect(curSender).not.toBeNull()

    ctrl.closeActiveVirtualDc()
  })

  it('4b. clientVirtualFallback caps consecutive catch retries at MAX_BG_PROBE_CONSECUTIVE_ERRORS with 300s backoff ceiling', async () => {
    let curPc: any = null
    let curDc: any = null
    let probeCount = 0
    const createdBgPcs: any[] = []
    const mockSignaling = { send: vi.fn() }

    global.RTCPeerConnection = vi.fn().mockImplementation((cfg: any) => {
      const p = createMockPeer({
        config: cfg,
        createOffer: vi.fn().mockRejectedValue(new Error('persistent offer error'))
      })
      createdBgPcs.push(p)
      return p
    }) as any

    const peerMgr = new PeerConnectionManager({
      getSignaling: () => mockSignaling as any,
      isHostMode: () => false,
      callbacks: {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn(),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn(),
        onIceStalled: vi.fn()
      },
      setStatus: vi.fn(),
      getClientSharedAesKey: () => mockAesKey,
      getClientSharedKey: () => null,
      getClientFingerprint: () => undefined,
      getClientSecurityFingerprint: () => '',
      getClientHostSenderId: () => 'host-peer-1'
    })

    const ctx: any = {
      peerMgr,
      sas: { clientSharedAesKey: mockAesKey, clientSecurityFingerprint: '1111-2222' },
      getSignaling: () => mockSignaling,
      getLocalEcdhPubHex: () => '041122',
      getLocalDeviceId: () => 'dev-1',
      getClientSessionId: () => 'sess-bg-cap',
      getCurrentHostSessionId: () => 'host-1',
      getClientHostSenderId: () => 'host-peer-1',
      getClientPc: () => curPc,
      setClientPc: (pc: any) => { curPc = pc },
      getClientDc: () => curDc,
      setClientDc: (dc: any) => { curDc = dc },
      setClientSender: vi.fn(),
      isExplicitlyClosed: () => false,
      isHostMode: () => false,
      getStatus: () => 'connected',
      setStatus: vi.fn(),
      handleChannelMessage: vi.fn(),
      callbacks: { onIceStalled: vi.fn(), onTransportInfoChanged: vi.fn() }
    }

    const ctrl = createClientVirtualFallbackController({
      ctx,
      getAttemptEpoch: () => 1,
      clearFailedEpochIfMatch: vi.fn(),
      clearConnectWatchdog: vi.fn(),
      clearReconnectTimer: vi.fn(),
      startDataChannelHeartbeat: vi.fn(),
      checkAndScheduleSilentUpgrade: vi.fn().mockResolvedValue(undefined),
      getSilentUpgradeProbeCount: () => probeCount,
      incrementSilentUpgradeProbeCount: () => ++probeCount,
      failAttempt: vi.fn()
    })

    ctrl.activateVirtualFallbackChannel(1, 'sess-bg-cap')
    await waitUntil(() => ctrl.isVirtualDcOpen())
    expect(ctrl.isVirtualDcOpen()).toBe(true)

    // Advance far enough for >10 probes (20s + 40s + 80s + 160s + 6*300s = 2100s)
    await vi.advanceTimersByTimeAsync(2_200_000)

    // Initial probe + 8 consecutive catch reschedules = 9 probes total, then stops
    expect(createdBgPcs).toHaveLength(9)
    for (const p of createdBgPcs) {
      expect(p._origClose).toHaveBeenCalled()
    }
    expect(curPc).toBeNull()

    ctrl.closeActiveVirtualDc()
  })

  it('3b. clientSilentUpgrade uses non-destructive allowTurn=false probe PC off TURN relay and keeps allowTurn=false on nat_p2p iceRestart', async () => {
    // 1) relay (Metered TURN) -> Direct: MUST create a separate non-destructive probe PC (allowTurn=false),
    // leaving the active TURN PC & DataChannel completely untouched until probeDc opens.
    const activeTurnPc = createMockPeer({
      connectionState: 'connected',
      signalingState: 'stable'
    })
    const activeTurnDc = { readyState: 'open', close: vi.fn() }
    const probePc = createMockPeer({
      connectionState: 'new',
      signalingState: 'stable'
    })
    const probeDc: any = { readyState: 'connecting', send: vi.fn(), close: vi.fn(), onopen: null, onclose: null }
    probePc.createDataChannel = vi.fn().mockReturnValue(probeDc)

    const sentPayloads: any[] = []
    let probeCount = 0
    const registerProbePeer = vi.fn()
    const unregisterProbePeer = vi.fn()
    const promoteProbeConnection = vi.fn()
    const createPeerConnection = vi.fn().mockReturnValue(probePc)

    const relayPeerMgr: any = {
      currentTransportInfo: {
        type: 'relay',
        localCandidateType: 'relay',
        remoteCandidateType: 'relay',
        localAddress: '1.2.3.4',
        remoteAddress: '5.6.7.8',
        protocol: 'TCP',
        rttMs: 120
      },
      createPeerConnection,
      beginSilentUpgrade: vi.fn(),
      endSilentUpgrade: vi.fn(),
      holdLocalCandidates: vi.fn(),
      releaseLocalCandidates: vi.fn(),
      finalizeLocalSdp: vi.fn().mockImplementation(async (_pc, sdp) => sdp),
      updateTransportInfo: vi.fn().mockImplementation(async () => {
        relayPeerMgr.currentTransportInfo = {
          type: 'ipv6_p2p',
          localCandidateType: 'srflx',
          remoteCandidateType: 'srflx',
          localAddress: '2409:8a00::1',
          remoteAddress: '2409:8a00::2',
          protocol: 'UDP',
          rttMs: 18
        }
      })
    }

    const relayMgr = createClientSilentUpgradeManager({
      ctx: {
        peerMgr: relayPeerMgr,
        sas: { clientSharedAesKey: null },
        getSignaling: () => ({
          send: vi.fn().mockImplementation((payload: any) => sentPayloads.push(payload))
        }),
        getLocalEcdhPubHex: () => '041122',
        getLocalDeviceId: () => 'dev-1',
        getClientSessionId: () => 'sess-silent',
        getCurrentHostSessionId: () => 'host-1',
        getClientHostSenderId: () => 'host-peer-1',
        getClientPc: () => activeTurnPc,
        getClientDc: () => activeTurnDc,
        isExplicitlyClosed: () => false,
        isHostMode: () => false
      } as any,
      getAttemptEpoch: () => 1,
      getProbeCount: () => probeCount,
      incrementProbeCount: () => ++probeCount,
      registerProbePeer,
      unregisterProbePeer,
      promoteProbeConnection
    })

    await relayMgr.checkAndScheduleSilentUpgrade(true)
    await vi.advanceTimersByTimeAsync(10)

    expect(activeTurnPc.setConfiguration).not.toHaveBeenCalled()
    expect(activeTurnPc.close).not.toHaveBeenCalled()
    expect(createPeerConnection).toHaveBeenCalledWith(
      undefined,
      expect.any(Function),
      false,
      'host-peer-1',
      expect.objectContaining({ sessionTag: 'sess-silent-probe-1', allowTurn: false })
    )
    expect(registerProbePeer).toHaveBeenCalledWith('sess-silent-probe-1', probePc)
    expect(sentPayloads[0]).toEqual(
      expect.objectContaining({
        allowTurn: false,
        forceRelay: false,
        silentUpgradeProbe: true,
        clientSessionId: 'sess-silent-probe-1'
      })
    )

    // Probe DataChannel opens -> hot-swaps via promoteProbeConnection
    probeDc.readyState = 'open'
    await probeDc.onopen()
    expect(unregisterProbePeer).toHaveBeenCalledWith('sess-silent-probe-1')
    expect(promoteProbeConnection).toHaveBeenCalledWith(
      probePc,
      probeDc,
      expect.any(Object),
      'sess-silent-probe-1'
    )
    relayMgr.resetSilentUpgradeState()

    // 2) nat_p2p -> ipv6_p2p (already non-TURN): performs in-place iceRestart with allowTurn=false
    const natPc = createMockPeer({
      connectionState: 'connected',
      signalingState: 'stable'
    })
    const natSent: any[] = []
    let natProbeCount = 0
    const natMgr = createClientSilentUpgradeManager({
      ctx: {
        peerMgr: {
          currentTransportInfo: {
            type: 'nat_p2p',
            localCandidateType: 'srflx',
            remoteCandidateType: 'srflx',
            localAddress: '1.2.3.4',
            remoteAddress: '5.6.7.8',
            protocol: 'UDP',
            rttMs: 35
          },
          beginSilentUpgrade: vi.fn(),
          endSilentUpgrade: vi.fn(),
          holdLocalCandidates: vi.fn(),
          releaseLocalCandidates: vi.fn(),
          finalizeLocalSdp: vi.fn().mockImplementation(async (_pc, sdp) => sdp),
          updateTransportInfo: vi.fn().mockResolvedValue(undefined)
        },
        sas: { clientSharedAesKey: null },
        getSignaling: () => ({
          send: vi.fn().mockImplementation((payload: any) => natSent.push(payload))
        }),
        getLocalEcdhPubHex: () => '041122',
        getLocalDeviceId: () => 'dev-1',
        getClientSessionId: () => 'sess-nat',
        getCurrentHostSessionId: () => 'host-1',
        getClientHostSenderId: () => 'host-peer-1',
        getClientPc: () => natPc,
        getClientDc: () => ({ readyState: 'open' }),
        isExplicitlyClosed: () => false,
        isHostMode: () => false
      } as any,
      getAttemptEpoch: () => 1,
      getProbeCount: () => natProbeCount,
      incrementProbeCount: () => ++natProbeCount
    })

    await natMgr.checkAndScheduleSilentUpgrade(true)
    await vi.advanceTimersByTimeAsync(10)

    expect(natPc.setConfiguration).toHaveBeenCalledTimes(1)
    const cfg = natPc.setConfiguration.mock.calls[0][0]
    expect(JSON.stringify(cfg.iceServers)).not.toContain('turn')
    expect(natSent[0]).toEqual(expect.objectContaining({ allowTurn: false, iceRestart: true }))

    natMgr.resetSilentUpgradeState()
  })

  // =========================================================================
  // Requirement 5: Trimmed selectStunUrls preserving domestic + overseas IPv4/IPv6 coverage
  // =========================================================================
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

  it('4c. activateVirtualFallbackChannel cleans up activeVirtualDc on encryption failure so retry is not permanently wedged', async () => {
    const encryptSpy = vi
      .spyOn(crypto.subtle, 'encrypt')
      .mockRejectedValueOnce(new Error('transient webcrypto error'))

    const mockSignaling = { send: vi.fn() }
    let curDc: any = null
    let curSender: any = null
    const ctx: any = {
      peerMgr: {
        currentTransportInfo: null,
        markVirtualChannelActive: vi.fn(),
        unmarkVirtualChannelActive: vi.fn()
      },
      sas: { clientSharedAesKey: mockAesKey, clientSecurityFingerprint: '1111-2222' },
      getSignaling: () => mockSignaling,
      getLocalEcdhPubHex: () => '041122',
      getLocalDeviceId: () => 'dev-1',
      getClientSessionId: () => 'sess-enc-err',
      getCurrentHostSessionId: () => 'host-1',
      getClientHostSenderId: () => 'host-peer-1',
      getClientPc: () => null,
      setClientPc: vi.fn(),
      getClientDc: () => curDc,
      setClientDc: (dc: any) => { curDc = dc },
      setClientSender: (s: any) => { curSender = s },
      getUsername: () => 'Scout',
      getUserId: () => 'u1',
      isExplicitlyClosed: () => false,
      isHostMode: () => false,
      getStatus: () => 'connecting',
      setStatus: vi.fn(),
      handleChannelMessage: vi.fn(),
      callbacks: { onIceStalled: vi.fn(), onTransportInfoChanged: vi.fn() }
    }

    const ctrl = createClientVirtualFallbackController({
      ctx,
      getAttemptEpoch: () => 1,
      clearFailedEpochIfMatch: vi.fn(),
      clearConnectWatchdog: vi.fn(),
      clearReconnectTimer: vi.fn(),
      startDataChannelHeartbeat: vi.fn(),
      checkAndScheduleSilentUpgrade: vi.fn().mockResolvedValue(undefined),
      getSilentUpgradeProbeCount: () => 0,
      incrementSilentUpgradeProbeCount: () => 1,
      failAttempt: vi.fn()
    })

    // First call rejects in encrypt -> must clean up activeVirtualDc so second call is NOT skipped as duplicate
    expect(ctrl.activateVirtualFallbackChannel(1, 'sess-enc-err')).toBe(true)
    await waitUntil(() => mockSignaling.send.mock.calls.length === 0 && ctrl.getActiveVirtualDc() === null)
    expect(ctrl.getActiveVirtualDc()).toBeNull()
    expect(ctrl.isVirtualDcOpen()).toBe(false)

    // Restore WebCrypto and retry -> must succeed now
    encryptSpy.mockRestore()
    expect(ctrl.activateVirtualFallbackChannel(1, 'sess-enc-err')).toBe(true)
    await waitUntil(() => ctrl.isVirtualDcOpen())
    expect(ctrl.isVirtualDcOpen()).toBe(true)
    expect(curSender).not.toBeNull()

    ctrl.closeActiveVirtualDc()
  })

  it('3c. Host treats fresh bgPc Offer (same clientSessionId, no iceRestart flag) as a new PC preserving VirtualDataChannel instead of isIceRestart', async () => {
    const createdHostPcs: any[] = []
    global.RTCPeerConnection = vi.fn().mockImplementation((cfg: any) => {
      const p = createMockPeer({ config: cfg, connectionState: 'new', signalingState: 'stable' })
      createdHostPcs.push(p)
      return p
    }) as any

    const mockSignaling = { send: vi.fn(), isConnected: () => true }
    const clients = new Map<string, any>()
    const stagedClients = new Map<string, any>()
    const preOfferCandidates = new Map<string, any[]>()
    const sas = new SasSecurityManager()
    const callbacks: any = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const peerMgr = new PeerConnectionManager({
      getSignaling: () => mockSignaling as any,
      isHostMode: () => true,
      callbacks,
      setStatus: vi.fn(),
      getClientSharedAesKey: () => null,
      getClientSharedKey: () => sas.clientSharedKeys.get('client-1') || null,
      getClientFingerprint: () => undefined,
      getClientSecurityFingerprint: () => '',
      isExplicitlyClosed: () => false,
      updateHostStatus: vi.fn()
    })

    const oldPc = createMockPeer({ connectionState: 'connecting', signalingState: 'stable' })
    const virtualDc: any = {
      readyState: 'open',
      isVirtual: true,
      close: vi.fn(),
      send: vi.fn(),
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null
    }
    clients.set('client-1', {
      pc: oldPc,
      dc: virtualDc,
      sessionId: 'sess-bg-retry'
    })

    const hostHandler = createHostSignalingHandler({
      clients,
      stagedClients,
      preOfferCandidates,
      enqueueHostTask: (_sender, task) => task(),
      updateHostStatus: vi.fn(),
      peerMgr,
      sas,
      getSignaling: () => mockSignaling as any,
      getLocalEcdhKeyPair: () => null,
      getLocalEcdhPubHex: () => '',
      getLocalDeviceId: () => 'host-dev',
      getHostSessionId: () => 'host-sess-1',
      getCurrentInviteCode: () => 'INV123',
      getCurrentEventMetadata: () => null,
      sendMessage: vi.fn(),
      handleChannelMessage: vi.fn(),
      rejectSas: vi.fn(),
      callbacks
    })

    hostHandler({
      sender: 'client-1',
      clientSessionId: 'sess-bg-retry',
      allowTurn: true,
      offer: { type: 'offer', sdp: 'v=0\r\n' }
    })

    // Advance fake timers so waitForDoHStunIpv6Bounded(300) / enqueueHostTask resolves deterministically
    await vi.advanceTimersByTimeAsync(350)
    await waitUntil(() => createdHostPcs.length === 1)

    // Must NOT treat as isIceRestart on oldPc; must create a fresh PC in clients preserving open VirtualDataChannel!
    expect(oldPc.setRemoteDescription).not.toHaveBeenCalled()
    expect(oldPc._origClose).toHaveBeenCalled()
    expect(createdHostPcs).toHaveLength(1)
    expect(clients.get('client-1')?.pc).toBe(createdHostPcs[0])
    expect(clients.get('client-1')?.dc).toBe(virtualDc)
    expect(virtualDc.close).not.toHaveBeenCalled()
  })

  // =========================================================================
  // Requirement E (#24): ICE stats dump on failed / VirtualDC takeover / before_close
  // =========================================================================
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

  it('M1-3. Host stages silentUpgradeProbe in stagedClients without closing active TURN PC until probe dc.onopen, and unmarks VirtualDC on native promotion', async () => {
    // Part A: Active Native TURN connection -> non-destructive silentUpgradeProbe staged in stagedClients
    const activeTurnPc = createMockPeer({ connectionState: 'connected', signalingState: 'stable' })
    const probePc = createMockPeer({ connectionState: 'new', signalingState: 'stable' })
    const bgUpgradePc = createMockPeer({ connectionState: 'new', signalingState: 'stable' })
    let nextPcIdx = 0
    global.RTCPeerConnection = vi.fn().mockImplementation((cfg: any) => {
      const target = nextPcIdx++ === 0 ? probePc : bgUpgradePc
      Object.assign(target, { config: cfg })
      return target
    }) as any

    const mockSignaling = { send: vi.fn(), isConnected: () => true }
    const clients = new Map<string, any>()
    const stagedClients = new Map<string, any>()
    const preOfferCandidates = new Map<string, any[]>()
    const sas = new SasSecurityManager()
    const callbacks: any = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const peerMgr = new PeerConnectionManager({
      getSignaling: () => mockSignaling as any,
      isHostMode: () => true,
      callbacks,
      setStatus: vi.fn(),
      getClientSharedAesKey: () => null,
      getClientSharedKey: () => sas.clientSharedKeys.get('client-turn') || null,
      getClientFingerprint: () => undefined,
      getClientSecurityFingerprint: () => '',
      isExplicitlyClosed: () => false,
      updateHostStatus: vi.fn()
    })
    const unmarkSpy = vi.spyOn(peerMgr, 'unmarkVirtualChannelActive')

    const activeTurnDc: any = {
      readyState: 'open',
      close: vi.fn(),
      send: vi.fn(),
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null
    }
    clients.set('client-turn', {
      pc: activeTurnPc,
      dc: activeTurnDc,
      sessionId: 'sess-turn-1'
    })

    const hostHandler = createHostSignalingHandler({
      clients,
      stagedClients,
      preOfferCandidates,
      enqueueHostTask: (_sender, task) => task(),
      updateHostStatus: vi.fn(),
      peerMgr,
      sas,
      getSignaling: () => mockSignaling as any,
      getLocalEcdhKeyPair: () => null,
      getLocalEcdhPubHex: () => '',
      getLocalDeviceId: () => 'host-dev',
      getHostSessionId: () => 'host-sess-1',
      getCurrentInviteCode: () => 'INV123',
      getCurrentEventMetadata: () => null,
      sendMessage: vi.fn(),
      handleChannelMessage: vi.fn(),
      rejectSas: vi.fn(),
      callbacks
    })

    hostHandler({
      sender: 'client-turn',
      offer: {
        type: 'offer',
        sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\n'
      },
      clientSessionId: 'sess-turn-1-probe-1',
      silentUpgradeProbe: true,
      allowTurn: false,
      forceRelay: false
    })

    await vi.advanceTimersByTimeAsync(10)
    await waitUntil(() => stagedClients.has('client-turn'))

    expect(activeTurnPc._origClose).not.toHaveBeenCalled()
    expect(stagedClients.get('client-turn')?.sessionId).toBe('sess-turn-1-probe-1')
    expect(clients.get('client-turn')?.pc).toBe(activeTurnPc)

    // When probe DataChannel opens, Host promotes probePc and closes old activeTurnPc
    const fakeProbeDc: any = {
      readyState: 'open',
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null
    }
    probePc.ondatachannel?.({ channel: fakeProbeDc })
    fakeProbeDc.onopen?.()

    expect(clients.get('client-turn')?.pc).toBe(probePc)
    expect(stagedClients.has('client-turn')).toBe(false)
    expect(activeTurnPc._origClose).toHaveBeenCalledTimes(1)

    // Part B: Active VirtualDataChannel -> native bgPc dc.onopen promotes & calls unmarkVirtualChannelActive
    const virtualDc: any = {
      readyState: 'open',
      isVirtual: true,
      close: vi.fn(),
      send: vi.fn(),
      startDrain: vi.fn((_d: number, _i: number, done?: () => void) => done?.()),
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null
    }
    clients.set('client-vdc', {
      pc: createMockPeer({ connectionState: 'connecting', signalingState: 'stable' }),
      dc: virtualDc,
      sessionId: 'sess-vdc-1'
    })
    hostHandler({
      sender: 'client-vdc',
      offer: {
        type: 'offer',
        sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\n'
      },
      clientSessionId: 'sess-vdc-1',
      allowTurn: false,
      forceRelay: false
    })
    await vi.advanceTimersByTimeAsync(10)
    await waitUntil(() => clients.get('client-vdc')?.pc === bgUpgradePc)

    const fakeNativeDc: any = {
      readyState: 'open',
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null
    }
    bgUpgradePc.ondatachannel?.({ channel: fakeNativeDc })
    fakeNativeDc.onopen?.()

    expect(clients.get('client-vdc')?.dc).toBe(fakeNativeDc)
    expect(unmarkSpy).toHaveBeenCalledWith(bgUpgradePc)
  })

  it('M1-4. clientVirtualFallback resets reconnect/probe counters on open and closes wedged bgPc after CLIENT_CONNECT_TIMEOUT_MS', async () => {
    let curPc: any = null
    let curDc: any = null
    let probeCount = 0
    let reconnectResetCalls = 0
    const createdBgPcs: any[] = []
    const mockSignaling = { send: vi.fn() }

    global.RTCPeerConnection = vi.fn().mockImplementation((cfg: any) => {
      const p = createMockPeer({ config: cfg })
      createdBgPcs.push(p)
      return p
    }) as any

    const peerMgr = new PeerConnectionManager({
      getSignaling: () => mockSignaling as any,
      isHostMode: () => false,
      callbacks: {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn(),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn(),
        onIceStalled: vi.fn()
      },
      setStatus: vi.fn(),
      getClientSharedAesKey: () => mockAesKey,
      getClientSharedKey: () => null,
      getClientFingerprint: () => undefined,
      getClientSecurityFingerprint: () => '',
      getClientHostSenderId: () => 'host-peer-1'
    })

    const transportSpy = vi.fn()
    const ctx: any = {
      peerMgr,
      sas: { clientSharedAesKey: mockAesKey, clientSecurityFingerprint: '1111-2222' },
      getSignaling: () => mockSignaling,
      getLocalEcdhPubHex: () => '041122',
      getLocalDeviceId: () => 'dev-1',
      getClientSessionId: () => 'sess-m1-4',
      getCurrentHostSessionId: () => 'host-1',
      getClientHostSenderId: () => 'host-peer-1',
      getClientPc: () => curPc,
      setClientPc: (pc: any) => { curPc = pc },
      getClientDc: () => curDc,
      setClientDc: (dc: any) => { curDc = dc },
      setClientSender: vi.fn(),
      isExplicitlyClosed: () => false,
      isHostMode: () => false,
      getStatus: () => 'connecting',
      setStatus: vi.fn(),
      handleChannelMessage: vi.fn(),
      callbacks: { onIceStalled: vi.fn(), onTransportInfoChanged: transportSpy }
    }

    const ctrl = createClientVirtualFallbackController({
      ctx,
      getAttemptEpoch: () => 1,
      clearFailedEpochIfMatch: vi.fn(),
      clearConnectWatchdog: vi.fn(),
      clearReconnectTimer: vi.fn(),
      startDataChannelHeartbeat: vi.fn(),
      checkAndScheduleSilentUpgrade: vi.fn().mockResolvedValue(undefined),
      getSilentUpgradeProbeCount: () => probeCount,
      incrementSilentUpgradeProbeCount: () => ++probeCount,
      resetSilentUpgradeProbeCount: () => { probeCount = 0 },
      resetReconnectAttempts: () => { reconnectResetCalls++ },
      failAttempt: vi.fn()
    })

    expect(ctrl.activateVirtualFallbackChannel(1, 'sess-m1-4')).toBe(true)
    await waitUntil(() => ctrl.isVirtualDcOpen())
    expect(reconnectResetCalls).toBe(1)
    expect(transportSpy).toHaveBeenCalledWith(expect.objectContaining({ isVirtualTunnel: true, protocol: 'wss/tls' }))

    // Trigger first bgPc probe (at 20_000ms) and let it wedge until CLIENT_CONNECT_TIMEOUT_MS -> must close & reschedule
    await vi.advanceTimersByTimeAsync(20_050)
    await waitUntil(() => createdBgPcs.length === 1 && mockSignaling.send.mock.calls.length >= 2)
    expect(createdBgPcs[0]._origClose).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CONNECTION_TIMING.CLIENT_CONNECT_TIMEOUT_MS + 50)
    expect(createdBgPcs[0]._origClose).toHaveBeenCalled()
    expect(probeCount).toBe(2)

    // Second bgPc opens (at 40_000ms) -> resets both reconnectAttempts and silentUpgradeProbeCount
    await vi.advanceTimersByTimeAsync(40_050)
    await waitUntil(() => createdBgPcs.length === 2)
    const bgDc2 = createdBgPcs[1].createDataChannel.mock.results[0]!.value
    bgDc2.readyState = 'open'
    createdBgPcs[1].connectionState = 'connected'
    await bgDc2.onopen()
    expect(reconnectResetCalls).toBe(2)
    expect(probeCount).toBe(0)

    ctrl.closeActiveVirtualDc()
  })

  it('M1-5. clientSession handles VirtualDC heartbeat_timeout by escalating cleanly to strict last-resort TURN (Attempt 3)', async () => {
    ;(globalThis as any).__TEST_HEARTBEAT_INTERVAL_MS__ = 100
    ;(globalThis as any).__TEST_PING_TIMEOUT_MS__ = 50
    let session: any = null
    try {
      const createdPcs: any[] = []
      global.RTCPeerConnection = vi.fn().mockImplementation((cfg: any) => {
        const p = createMockPeer({ config: cfg })
        createdPcs.push(p)
        return p
      }) as any

      const mockSignaling = {
        send: vi.fn(),
        isConnected: () => true
      }
      const sas = new SasSecurityManager()
      sas.clientSasState = 'VERIFIED'
      sas.clientSharedAesKey = mockAesKey
      sas.clientSecurityFingerprint = '1111-2222'

      let curPc: any = null
      let curDc: any = null
      let status: any = 'connecting'
      const peerMgr = new PeerConnectionManager({
        getSignaling: () => mockSignaling as any,
        isHostMode: () => false,
        callbacks: {
          onStatusChange: vi.fn(),
          onRecordsReceived: vi.fn(),
          onAckReceived: vi.fn(),
          onRequestSync: vi.fn(),
          onIceStalled: vi.fn()
        },
        setStatus: (s) => { status = s },
        getClientSharedAesKey: () => sas.clientSharedAesKey,
        getClientSharedKey: () => null,
        getClientFingerprint: () => undefined,
        getClientSecurityFingerprint: () => sas.clientSecurityFingerprint,
        getClientHostSenderId: () => 'host-peer-1'
      })

      session = createClientSession({
        peerMgr,
        sas,
        getSignaling: () => mockSignaling as any,
        getLocalEcdhKeyPair: () => null,
        getLocalEcdhPubHex: () => '041122',
        getLocalDeviceId: () => 'dev-1',
        getCurrentInviteCode: () => 'INV1',
        getCurrentHostSessionId: () => 'host-1',
        setCurrentHostSessionId: vi.fn(),
        getClientSessionId: () => 'sess-esc',
        setClientSessionId: vi.fn(),
        getClientHostSenderId: () => 'host-peer-1',
        setClientHostSenderId: vi.fn(),
        getClientPc: () => curPc,
        setClientPc: (pc) => { curPc = pc },
        getClientDc: () => curDc,
        setClientDc: (dc) => { curDc = dc },
        setClientSender: vi.fn(),
        getClientPendingCandidates: () => [],
        setClientPendingCandidates: vi.fn(),
        getClientForceRelay: () => false,
        setClientForceRelay: vi.fn(),
        isExplicitlyClosed: () => false,
        isHostMode: () => false,
        getStatus: () => status,
        setStatus: (s) => { status = s },
        sendMessage: async () => {},
        handleChannelMessage: vi.fn(),
        rejectSas: vi.fn(),
        callbacks: {
          onStatusChange: vi.fn(),
          onRecordsReceived: vi.fn(),
          onAckReceived: vi.fn(),
          onRequestSync: vi.fn(),
          onIceStalled: vi.fn()
        }
      })

      // Attempt 0: pure STUN -> early ice_failed at 500ms activates VirtualDC
      await session.setupClientConnection()
      expect(createdPcs).toHaveLength(1)
      expect(JSON.stringify(createdPcs[0].config.iceServers)).not.toContain('turn')

      await vi.advanceTimersByTimeAsync(500)
      createdPcs[0].iceConnectionState = 'failed'
      createdPcs[0].oniceconnectionstatechange?.({})
      await waitUntil(() => Boolean(curDc?.isVirtual && curDc?.readyState === 'open'))
      expect(curDc.isVirtual).toBe(true)

      // Trigger VirtualDC heartbeat_timeout (8 misses * 100ms = ~800-1200ms) -> failAttempt increments reconnectAttempts=1
      for (let tick = 0; tick < 15 && createdPcs.length < 2; tick++) {
        await vi.advanceTimersByTimeAsync(200)
      }
      // Wait for Attempt 1 (reconnect delay 1000ms)
      await vi.advanceTimersByTimeAsync(1500)
      await waitUntil(() => createdPcs.length >= 2)

      // Attempt 1 & Attempt 2 fail -> must remain STUN-only (NO TURN, NO re-entering VirtualDC)
      await vi.advanceTimersByTimeAsync(500)
      createdPcs[1].iceConnectionState = 'failed'
      createdPcs[1].oniceconnectionstatechange?.({})
      await vi.advanceTimersByTimeAsync(2500)
      await waitUntil(() => createdPcs.length >= 3)

      await vi.advanceTimersByTimeAsync(500)
      createdPcs[2].iceConnectionState = 'failed'
      createdPcs[2].oniceconnectionstatechange?.({})
      await vi.advanceTimersByTimeAsync(4500)
      await waitUntil(() => createdPcs.length >= 4)

      expect(JSON.stringify(createdPcs[1].config.iceServers)).not.toContain('turn')
      expect(JSON.stringify(createdPcs[2].config.iceServers)).not.toContain('turn')
      // Attempt 3 finally allows TURN!
      const lastTurnCfg = JSON.stringify(createdPcs[3].config.iceServers)
      expect(lastTurnCfg).toContain('turn')
    } finally {
      session?.hardResetChannels?.()
      delete (globalThis as any).__TEST_HEARTBEAT_INTERVAL_MS__
      delete (globalThis as any).__TEST_PING_TIMEOUT_MS__
    }
  })

  it('M1-6. clientSilentUpgrade clears settle timer on probeDc.onopen, buffers early messages, aborts promotion if probePc closes during getStats, and routes post-promotion disconnect to failAttempt', async () => {
    // Part A: probeDc.onopen clears settleTimer on entry, buffers early onmessage during getStats, and promotes safely past SETTLE_MS
    const activeTurnPc = createMockPeer({ connectionState: 'connected', signalingState: 'stable' })
    const activeTurnDc: any = { readyState: 'open', close: vi.fn() }
    const probePc = createMockPeer({ connectionState: 'connected', signalingState: 'stable' })
    const probeDc: any = { readyState: 'connecting', send: vi.fn(), close: vi.fn(), onopen: null, onclose: null, onmessage: null }
    probePc.createDataChannel = vi.fn().mockReturnValue(probeDc)

    global.RTCPeerConnection = vi.fn().mockImplementation(() => probePc) as any

    let resolveStats!: () => void
    const peerMgr: any = {
      currentTransportInfo: { type: 'relay', localCandidateType: 'relay', remoteCandidateType: 'relay', localAddress: '1.2.3.4', remoteAddress: '5.6.7.8', protocol: 'TCP', rttMs: 100 },
      createPeerConnection: vi.fn().mockImplementation((_t, onDisconnect) => {
        probePc._onDisconnect = onDisconnect
        return probePc
      }),
      beginSilentUpgrade: vi.fn(),
      endSilentUpgrade: vi.fn(),
      holdLocalCandidates: vi.fn(),
      releaseLocalCandidates: vi.fn(),
      finalizeLocalSdp: vi.fn().mockImplementation(async (_pc, sdp) => sdp),
      updateTransportInfo: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveStats = () => {
              peerMgr.currentTransportInfo = { type: 'ipv6_p2p', localCandidateType: 'host', remoteCandidateType: 'host', localAddress: '2409::1', remoteAddress: '2409::2', protocol: 'UDP', rttMs: 15 }
              resolve()
            }
          })
      )
    }

    let curPc: any = activeTurnPc
    let curDc: any = activeTurnDc
    const handleChannelMessage = vi.fn().mockResolvedValue(undefined)
    const promoteSpy = vi.fn().mockImplementation((pPc, pDc) => {
      curPc = pPc
      curDc = pDc
    })
    const failAttemptSpy = vi.fn()
    let probeCount = 0

    const mgr = createClientSilentUpgradeManager({
      ctx: {
        peerMgr,
        sas: { clientSharedAesKey: null },
        getSignaling: () => ({ send: vi.fn() }),
        getLocalEcdhPubHex: () => '041122',
        getLocalDeviceId: () => 'dev-1',
        getClientSessionId: () => 'sess-race',
        getCurrentHostSessionId: () => 'host-1',
        getClientHostSenderId: () => 'host-peer-1',
        getClientPc: () => curPc,
        setClientPc: (p: any) => { curPc = p },
        getClientDc: () => curDc,
        setClientDc: (d: any) => { curDc = d },
        setClientSender: vi.fn(),
        setClientSessionId: vi.fn(),
        isExplicitlyClosed: () => false,
        isHostMode: () => false,
        setStatus: vi.fn(),
        handleChannelMessage
      } as any,
      getAttemptEpoch: () => 1,
      getProbeCount: () => probeCount,
      incrementProbeCount: () => ++probeCount,
      promoteProbeConnection: promoteSpy,
      failAttempt: failAttemptSpy
    })

    await mgr.checkAndScheduleSilentUpgrade(true)
    await vi.advanceTimersByTimeAsync(10)

    // probeDc opens right before SETTLE_MS, receives early EVENT_METADATA while getStats() is still pending past SETTLE_MS
    await vi.advanceTimersByTimeAsync(CONNECTION_TIMING.CLIENT_CONNECT_TIMEOUT_MS > 0 ? 11900 : 100)
    probeDc.readyState = 'open'
    const openPromise = probeDc.onopen()
    probeDc.onmessage?.({ data: JSON.stringify({ type: 'EVENT_METADATA' }) })
    await vi.advanceTimersByTimeAsync(500) // crosses 12000ms SETTLE_MS while getStats() is pending

    // settleTimer was cleared on entry -> probePc was NOT closed, resolveStats completes promotion and replays buffered message
    expect(probePc._origClose).not.toHaveBeenCalled()
    resolveStats()
    await openPromise

    expect(promoteSpy).toHaveBeenCalledTimes(1)
    expect(handleChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ data: JSON.stringify({ type: 'EVENT_METADATA' }) }))

    // Post-promotion disconnect on probePc must escalate via failAttempt instead of no-oping
    probePc._onDisconnect('ice_failed')
    expect(failAttemptSpy).toHaveBeenCalledWith(1, 'ice_failed')
    mgr.resetSilentUpgradeState()

    // Part B: If probePc closes mid-await updateTransportInfo(), promotion MUST abort and activeTurnPc remains untouched
    const activeTurnPc2 = createMockPeer({ connectionState: 'connected', signalingState: 'stable' })
    const activeTurnDc2: any = { readyState: 'open', close: vi.fn() }
    const probePc2 = createMockPeer({ connectionState: 'connected', signalingState: 'stable' })
    const probeDc2: any = { readyState: 'connecting', send: vi.fn(), close: vi.fn(), onopen: null, onclose: null, onmessage: null }
    probePc2.createDataChannel = vi.fn().mockReturnValue(probeDc2)
    let resolveStats2!: () => void
    const promoteSpy2 = vi.fn()
    const peerMgr2: any = {
      ...peerMgr,
      currentTransportInfo: { type: 'relay', localCandidateType: 'relay', remoteCandidateType: 'relay', localAddress: '1.2.3.4', remoteAddress: '5.6.7.8', protocol: 'TCP', rttMs: 100 },
      createPeerConnection: vi.fn().mockReturnValue(probePc2),
      updateTransportInfo: vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveStats2 = resolve }))
    }
    let probeCount2 = 0
    const mgr2 = createClientSilentUpgradeManager({
      ctx: {
        peerMgr: peerMgr2,
        sas: { clientSharedAesKey: null },
        getSignaling: () => ({ send: vi.fn() }),
        getLocalEcdhPubHex: () => '041122',
        getLocalDeviceId: () => 'dev-1',
        getClientSessionId: () => 'sess-race-2',
        getCurrentHostSessionId: () => 'host-1',
        getClientHostSenderId: () => 'host-peer-1',
        getClientPc: () => activeTurnPc2,
        getClientDc: () => activeTurnDc2,
        isExplicitlyClosed: () => false,
        isHostMode: () => false,
        handleChannelMessage: vi.fn()
      } as any,
      getAttemptEpoch: () => 1,
      getProbeCount: () => probeCount2,
      incrementProbeCount: () => ++probeCount2,
      promoteProbeConnection: promoteSpy2
    })

    await mgr2.checkAndScheduleSilentUpgrade(true)
    await vi.advanceTimersByTimeAsync(10)
    probeDc2.readyState = 'open'
    const openPromise2 = probeDc2.onopen()
    probePc2.connectionState = 'closed'
    resolveStats2()
    await openPromise2

    expect(promoteSpy2).not.toHaveBeenCalled()
    expect(activeTurnPc2._origClose).not.toHaveBeenCalled()
    expect(activeTurnDc2.close).not.toHaveBeenCalled()
    mgr2.resetSilentUpgradeState()
  })

  it('M1-7. Host data.encrypted keeps active clients TURN PC over stagedClients probePc, post-promoteNativeDc disconnect closes nativeDc, and Host honors primaryTurnOnly & trust cleanup on stagedClients', async () => {
    const activeTurnPc = createMockPeer({ connectionState: 'connected', signalingState: 'stable' })
    const probePc = createMockPeer({ connectionState: 'new', signalingState: 'stable' })
    const turnSymPc = createMockPeer({ connectionState: 'new', signalingState: 'stable' })
    const bgPc = createMockPeer({ connectionState: 'new', signalingState: 'stable' })
    const createdConfigs: any[] = []
    let idx = 0
    const pcPool = [probePc, turnSymPc, bgPc]
    global.RTCPeerConnection = vi.fn().mockImplementation((cfg: any) => {
      createdConfigs.push(cfg)
      return pcPool[idx++] || createMockPeer({ config: cfg })
    }) as any

    const mockSignaling = { send: vi.fn(), isConnected: () => true }
    const clients = new Map<string, any>()
    const stagedClients = new Map<string, any>()
    const preOfferCandidates = new Map<string, any[]>()
    const sas = new SasSecurityManager()
    sas.clientSharedKeys.set('client-turn', mockAesKey)

    const callbacks: any = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const peerMgr = new PeerConnectionManager({
      getSignaling: () => mockSignaling as any,
      isHostMode: () => true,
      callbacks,
      setStatus: vi.fn(),
      getClientSharedAesKey: () => null,
      getClientSharedKey: (id) => sas.clientSharedKeys.get(id) || null,
      getClientFingerprint: () => undefined,
      getClientSecurityFingerprint: () => '',
      onHostClientClosed: (targetSender, peer) => {
        const cur = clients.get(targetSender) || stagedClients.get(targetSender)
        if (peer && cur && cur.pc !== peer) return
        clients.delete(targetSender)
        sas.cleanupPeerResources(targetSender)
      },
      isExplicitlyClosed: () => false,
      updateHostStatus: vi.fn()
    })

    const activeTurnDc: any = { readyState: 'open', send: vi.fn(), close: vi.fn(), onmessage: null, onopen: null, onclose: null, onerror: null }
    clients.set('client-turn', { pc: activeTurnPc, dc: activeTurnDc, sessionId: 'sess-turn' })
    stagedClients.set('client-turn', { pc: probePc, dc: undefined, sessionId: 'sess-turn-probe-1' })

    const hostHandler = createHostSignalingHandler({
      clients,
      stagedClients,
      preOfferCandidates,
      enqueueHostTask: (_sender, task) => task(),
      updateHostStatus: vi.fn(),
      peerMgr,
      sas,
      getSignaling: () => mockSignaling as any,
      getLocalEcdhKeyPair: () => null,
      getLocalEcdhPubHex: () => '',
      getLocalDeviceId: () => 'host-dev',
      getHostSessionId: () => 'host-sess-1',
      getCurrentInviteCode: () => 'INV123',
      getCurrentEventMetadata: () => null,
      sendMessage: vi.fn(),
      handleChannelMessage: vi.fn(),
      rejectSas: vi.fn(),
      callbacks
    })

    // 1) Incoming encrypted virtual frame must resolve active clients.get('client-turn') instead of staged probePc
    const encFrame = await encryptSignalingData(mockAesKey, JSON.stringify({ vdc: 'data', sessionId: 'sess-turn', payload: 'hello' }))
    hostHandler({ sender: 'client-turn', encrypted: encFrame })
    await waitUntil(() => !activeTurnDc.onmessage || clients.get('client-turn')?.pc === activeTurnPc)
    expect(clients.get('client-turn')?.pc).toBe(activeTurnPc)
    expect(stagedClients.get('client-turn')?.pc).toBe(probePc)

    // 2) silentUpgradeProbe offer failing trust (missing ecdhPublicKey with requireEcdh: true) must clean up stagedClients immediately
    hostHandler({
      sender: 'client-turn',
      offer: { type: 'offer', sdp: 'v=0\r\n' },
      clientSessionId: 'sess-turn-probe-2',
      silentUpgradeProbe: true,
      requireEcdh: true
    })
    await waitUntil(() => !stagedClients.has('client-turn'))
    expect(stagedClients.has('client-turn')).toBe(false)
    expect(clients.get('client-turn')?.pc).toBe(activeTurnPc)

    // 3) Offer with primaryTurnOnly: true -> Host configures only TURN_SERVERS[0]
    hostHandler({
      sender: 'client-turn-sym',
      offer: { type: 'offer', sdp: 'v=0\r\n' },
      clientSessionId: 'sess-turn-sym',
      allowTurn: true,
      primaryTurnOnly: true
    })
    await waitUntil(() => clients.has('client-turn-sym'))
    const turnServersConfigured = (createdConfigs[1].iceServers || []).filter((s: any) => String(s.urls).startsWith('turn'))
    expect(turnServersConfigured).toHaveLength(1)
    expect(turnServersConfigured[0].urls).toBe(TURN_SERVERS[0]!.urls)

    // 4) VirtualDC -> promoteNativeDc() -> subsequent native PC disconnect must close nativeDc and abort sender
    const virtualDc: any = {
      readyState: 'open',
      isVirtual: true,
      close: vi.fn(),
      send: vi.fn(),
      startDrain: vi.fn((_d: number, _i: number, done?: () => void) => done?.()),
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null
    }
    clients.set('client-vdc', { pc: createMockPeer({ connectionState: 'connecting', signalingState: 'stable' }), dc: virtualDc, sessionId: 'sess-vdc' })
    hostHandler({
      sender: 'client-vdc',
      offer: { type: 'offer', sdp: 'v=0\r\n' },
      clientSessionId: 'sess-vdc',
      allowTurn: false
    })
    await waitUntil(() => clients.get('client-vdc')?.pc === bgPc)
    const nativeDc: any = { readyState: 'open', send: vi.fn(), close: vi.fn(), onmessage: null, onopen: null, onclose: null, onerror: null }
    bgPc.ondatachannel?.({ channel: nativeDc })
    nativeDc.onopen?.()
    expect(clients.get('client-vdc')?.dc).toBe(nativeDc)

    bgPc.connectionState = 'failed'
    bgPc.onconnectionstatechange?.()
    expect(nativeDc.close).toHaveBeenCalledTimes(1)
    expect(clients.has('client-vdc')).toBe(false)
  })

  it('M1-8. Client preserves open VirtualDataChannel when host_heartbeat arrives in degraded status, and wakes waitForHostHello on host_heartbeat', async () => {
    const createdPcs: any[] = []
    global.RTCPeerConnection = vi.fn().mockImplementation((cfg: any) => {
      const p = createMockPeer({ config: cfg })
      createdPcs.push(p)
      return p
    }) as any

    const mockSignaling = { send: vi.fn(), isConnected: () => true }
    const sas = new SasSecurityManager()
    sas.clientSasState = 'VERIFIED'
    sas.clientSharedAesKey = mockAesKey
    sas.clientSecurityFingerprint = '1111-2222'

    let curPc: any = null
    let curDc: any = null
    let hostSenderId = 'host-peer-1'
    let status: any = 'connecting'
    const peerMgr = new PeerConnectionManager({
      getSignaling: () => mockSignaling as any,
      isHostMode: () => false,
      callbacks: { onStatusChange: vi.fn(), onRecordsReceived: vi.fn(), onAckReceived: vi.fn(), onRequestSync: vi.fn(), onIceStalled: vi.fn() },
      setStatus: (s) => { status = s },
      getClientSharedAesKey: () => sas.clientSharedAesKey,
      getClientSharedKey: () => null,
      getClientFingerprint: () => undefined,
      getClientSecurityFingerprint: () => sas.clientSecurityFingerprint,
      getClientHostSenderId: () => hostSenderId
    })

    const session = createClientSession({
      peerMgr,
      sas,
      getSignaling: () => mockSignaling as any,
      getLocalEcdhKeyPair: () => null,
      getLocalEcdhPubHex: () => '041122',
      getLocalDeviceId: () => 'dev-1',
      getCurrentInviteCode: () => 'INV1',
      getCurrentHostSessionId: () => 'host-1',
      setCurrentHostSessionId: vi.fn(),
      getClientSessionId: () => 'sess-deg',
      setClientSessionId: vi.fn(),
      getClientHostSenderId: () => hostSenderId,
      setClientHostSenderId: (id) => { hostSenderId = id },
      getClientPc: () => curPc,
      setClientPc: (pc) => { curPc = pc },
      getClientDc: () => curDc,
      setClientDc: (dc) => { curDc = dc },
      setClientSender: vi.fn(),
      getClientPendingCandidates: () => [],
      setClientPendingCandidates: vi.fn(),
      getClientForceRelay: () => false,
      setClientForceRelay: vi.fn(),
      isExplicitlyClosed: () => false,
      isHostMode: () => false,
      getStatus: () => status,
      setStatus: (s) => { status = s },
      sendMessage: async () => {},
      handleChannelMessage: vi.fn(),
      rejectSas: vi.fn(),
      callbacks: { onStatusChange: vi.fn(), onRecordsReceived: vi.fn(), onAckReceived: vi.fn(), onRequestSync: vi.fn(), onIceStalled: vi.fn() }
    })

    await session.setupClientConnection()
    await vi.advanceTimersByTimeAsync(500)
    createdPcs[0].iceConnectionState = 'failed'
    createdPcs[0].oniceconnectionstatechange?.({})
    await waitUntil(() => Boolean(curDc?.isVirtual && curDc?.readyState === 'open'))

    const activeVdc = curDc
    // Simulate 2 missed heartbeat pings setting status = 'degraded'
    status = 'degraded'
    await session.handleClientSignalingMessage({ type: 'host_heartbeat', sender: 'host-peer-1', hostSessionId: 'host-1' })

    // Active VirtualDataChannel must NOT be closed or restarted while degraded
    expect(activeVdc.readyState).toBe('open')
    expect(createdPcs).toHaveLength(1)

    // waitForHostHello resolves immediately when host_heartbeat provides sender + shared key
    hostSenderId = ''
    let resolvedEarly = false
    const waitPromise = session.waitForHostHello(400).then(() => {
      resolvedEarly = true
    })
    await session.handleClientSignalingMessage({ type: 'host_heartbeat', sender: 'host-peer-1', hostSessionId: 'host-1' })
    await waitPromise
    expect(resolvedEarly).toBe(true)

    session.hardResetChannels()
  })

  it('M1-9. Probe 4.1A & 4.1B: Host data.encrypted never poisons open native/TURN PC or promotes stagedClients, while still delivering to drainingVirtualDc', async () => {
    const mockSignaling = { send: vi.fn(), isConnected: () => true }
    const clients = new Map<string, any>()
    const stagedClients = new Map<string, any>()
    const preOfferCandidates = new Map<string, any[]>()
    const sas = new SasSecurityManager()
    sas.clientSharedKeys.set('client-drain', mockAesKey)
    sas.clientSharedKeys.set('client-turn', mockAesKey)

    const bgPc = createMockPeer({ connectionState: 'new', signalingState: 'stable' })
    const activeTurnPc = createMockPeer({ connectionState: 'connected', signalingState: 'stable' })
    const probePc = createMockPeer({ connectionState: 'new', signalingState: 'stable' })

    global.RTCPeerConnection = vi.fn().mockImplementation(() => bgPc) as any

    const callbacks: any = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const onHostClientClosedSpy = vi.fn((targetSender: string, peer?: RTCPeerConnection) => {
      const cur = clients.get(targetSender) || stagedClients.get(targetSender)
      if (peer && cur && cur.pc !== peer) return
      if (cur?.drainingVirtualDc) {
        try { cur.drainingVirtualDc.close() } catch {}
        cur.drainingVirtualDc = undefined
      }
      if (cur?.sender) {
        try { cur.sender.abort('Host client closed') } catch {}
        cur.sender = undefined
      }
      if (cur?.dc) {
        try { cur.dc.close() } catch {}
      }
      if (stagedClients.get(targetSender) === cur) {
        stagedClients.delete(targetSender)
      }
      clients.delete(targetSender)
      sas.cleanupPeerResources(targetSender)
    })

    const peerMgr = new PeerConnectionManager({
      getSignaling: () => mockSignaling as any,
      isHostMode: () => true,
      callbacks,
      setStatus: vi.fn(),
      getClientSharedAesKey: () => null,
      getClientSharedKey: (id) => sas.clientSharedKeys.get(id) || null,
      getClientFingerprint: () => undefined,
      getClientSecurityFingerprint: () => '',
      onHostClientClosed: onHostClientClosedSpy,
      isExplicitlyClosed: () => false,
      updateHostStatus: vi.fn()
    })
    const markSpy = vi.spyOn(peerMgr, 'markVirtualChannelActive')

    const hostHandler = createHostSignalingHandler({
      clients,
      stagedClients,
      preOfferCandidates,
      enqueueHostTask: (_sender, task) => task(),
      updateHostStatus: vi.fn(),
      peerMgr,
      sas,
      getSignaling: () => mockSignaling as any,
      getLocalEcdhKeyPair: () => null,
      getLocalEcdhPubHex: () => '',
      getLocalDeviceId: () => 'host-dev',
      getHostSessionId: () => 'host-sess-drain',
      getCurrentInviteCode: () => 'INV41',
      getCurrentEventMetadata: () => null,
      sendMessage: vi.fn(),
      handleChannelMessage: vi.fn(),
      rejectSas: vi.fn(),
      callbacks
    })

    // Probe 4.1A: VirtualDC -> promoteNativeDc() -> drainingVirtualDc active for 5s
    const virtualDc: any = {
      readyState: 'open',
      isVirtual: true,
      close: vi.fn(),
      send: vi.fn(),
      receiveDecryptedPayload: vi.fn(),
      startDrain: vi.fn(),
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null
    }
    clients.set('client-drain', {
      pc: createMockPeer({ connectionState: 'connecting', signalingState: 'stable' }),
      dc: virtualDc,
      sessionId: 'sess-drain'
    })
    hostHandler({
      sender: 'client-drain',
      offer: { type: 'offer', sdp: 'v=0\r\n' },
      clientSessionId: 'sess-drain',
      allowTurn: false
    })
    await waitUntil(() => clients.get('client-drain')?.pc === bgPc)
    const nativeDc: any = {
      readyState: 'open',
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null
    }
    bgPc.ondatachannel?.({ channel: nativeDc })
    nativeDc.onopen?.()
    expect(clients.get('client-drain')?.dc).toBe(nativeDc)
    expect(clients.get('client-drain')?.drainingVirtualDc).toBe(virtualDc)

    const senderAbortSpy = vi.spyOn(clients.get('client-drain').sender, 'abort')
    markSpy.mockClear()

    // In-flight data.encrypted arrives during 5s drainingVirtualDc window
    const drainOpenFrame = await encryptSignalingData(mockAesKey, JSON.stringify({ vdc: 'open', sessionId: 'sess-drain' }))
    const drainDataFrame = await encryptSignalingData(mockAesKey, JSON.stringify({ vdc: 'data', sessionId: 'sess-drain', payload: 'drain-msg-1' }))
    hostHandler({ sender: 'client-drain', encrypted: drainOpenFrame })
    hostHandler({ sender: 'client-drain', encrypted: drainDataFrame })
    await waitUntil(() => virtualDc.receiveDecryptedPayload.mock.calls.length > 0)

    expect(virtualDc.receiveDecryptedPayload).toHaveBeenCalledWith('drain-msg-1')
    expect(markSpy).not.toHaveBeenCalled()

    // Subsequent bgPc failure must NOT be suppressed by virtualFallbackPeers
    bgPc.connectionState = 'failed'
    bgPc.onconnectionstatechange?.()
    expect(onHostClientClosedSpy).toHaveBeenCalledTimes(1)
    expect(onHostClientClosedSpy).toHaveBeenCalledWith('client-drain', bgPc)
    expect(nativeDc.close).toHaveBeenCalledTimes(1)
    expect(senderAbortSpy).toHaveBeenCalledTimes(1)
    expect(clients.has('client-drain')).toBe(false)

    // Probe 4.1B: Active TURN PC + stagedClients probe -> late data.encrypted must NOT poison activeTurnPc or promote stagedClients
    const activeTurnDc: any = {
      readyState: 'open',
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onopen: null,
      onclose: null,
      onerror: null
    }
    global.RTCPeerConnection = vi.fn().mockImplementation(() => activeTurnPc) as any
    const wiredTurnPc = peerMgr.createPeerConnection('client-turn', undefined, false, undefined, {
      sessionTag: 'sess-turn-real',
      allowTurn: true
    })
    clients.set('client-turn', { pc: wiredTurnPc, dc: activeTurnDc, sessionId: 'sess-turn-real' })
    stagedClients.set('client-turn', { pc: probePc, dc: undefined, sessionId: 'sess-turn-probe' })
    markSpy.mockClear()

    const lateTurnFrame = await encryptSignalingData(mockAesKey, JSON.stringify({ vdc: 'data', sessionId: 'sess-turn-real', payload: 'late-msg' }))
    hostHandler({ sender: 'client-turn', encrypted: lateTurnFrame })
    await waitUntil(() => false, 15)
    expect(markSpy).not.toHaveBeenCalled()

    // Active TURN PC disconnects -> must clean up normally
    wiredTurnPc.connectionState = 'failed'
    wiredTurnPc.onconnectionstatechange?.()
    expect(activeTurnDc.close).toHaveBeenCalledTimes(1)
    expect(clients.has('client-turn')).toBe(false)
    expect(onHostClientClosedSpy).toHaveBeenCalledWith('client-turn', wiredTurnPc)

    // If clients.get('client-turn') is absent while stagedClients still holds probePc, late data.encrypted must NOT promote stagedClients
    sas.clientSharedKeys.set('client-turn', mockAesKey)
    stagedClients.set('client-turn', { pc: probePc, dc: undefined, sessionId: 'sess-turn-probe' })
    const strayAfterDelete = await encryptSignalingData(mockAesKey, JSON.stringify({ vdc: 'open', sessionId: 'sess-turn-probe' }))
    hostHandler({ sender: 'client-turn', encrypted: strayAfterDelete })
    await waitUntil(() => false, 15)
    expect(clients.has('client-turn')).toBe(false)
    expect(stagedClients.get('client-turn')?.pc).toBe(probePc)
    expect(markSpy).not.toHaveBeenCalled()
  })

  it('M1-10. clientSilentUpgrade restores currentTransportInfo to relay when probe aborts post-await updateTransportInfo so silent upgrade keeps scheduling', async () => {
    const activeTurnPc = createMockPeer({ connectionState: 'connected', signalingState: 'stable' })
    const activeTurnDc: any = { readyState: 'open', close: vi.fn() }
    const probePc = createMockPeer({ connectionState: 'connected', signalingState: 'stable' })
    const probeDc: any = { readyState: 'connecting', send: vi.fn(), close: vi.fn(), onopen: null, onclose: null, onmessage: null }
    probePc.createDataChannel = vi.fn().mockReturnValue(probeDc)
    global.RTCPeerConnection = vi.fn().mockImplementation(() => probePc) as any

    const relayInfo = {
      type: 'relay' as const,
      localCandidateType: 'relay',
      remoteCandidateType: 'relay',
      localAddress: '1.2.3.4',
      remoteAddress: '5.6.7.8',
      protocol: 'TCP',
      rttMs: 110
    }
    let resolveProbeStats!: () => void
    const promoteSpy = vi.fn()
    const peerMgr: any = {
      currentTransportInfo: relayInfo,
      createPeerConnection: vi.fn().mockReturnValue(probePc),
      beginSilentUpgrade: vi.fn(),
      endSilentUpgrade: vi.fn(),
      holdLocalCandidates: vi.fn(),
      releaseLocalCandidates: vi.fn(),
      finalizeLocalSdp: vi.fn().mockImplementation(async (_pc, sdp) => sdp),
      updateTransportInfo: vi.fn().mockImplementation((targetPc: RTCPeerConnection) => {
        if (targetPc === probePc) {
          return new Promise<void>((resolve) => {
            resolveProbeStats = () => {
              peerMgr.currentTransportInfo = {
                type: 'ipv6_p2p',
                localCandidateType: 'host',
                remoteCandidateType: 'host',
                localAddress: '2409::1',
                remoteAddress: '2409::2',
                protocol: 'UDP',
                rttMs: 15
              }
              resolve()
            }
          })
        }
        peerMgr.currentTransportInfo = relayInfo
        return Promise.resolve()
      })
    }

    let probeCount = 0
    const mgr = createClientSilentUpgradeManager({
      ctx: {
        peerMgr,
        sas: { clientSharedAesKey: null },
        getSignaling: () => ({ send: vi.fn() }),
        getLocalEcdhPubHex: () => '041122',
        getLocalDeviceId: () => 'dev-1',
        getClientSessionId: () => 'sess-abort-restore',
        getCurrentHostSessionId: () => 'host-1',
        getClientHostSenderId: () => 'host-peer-1',
        getClientPc: () => activeTurnPc,
        getClientDc: () => activeTurnDc,
        isExplicitlyClosed: () => false,
        isHostMode: () => false,
        handleChannelMessage: vi.fn()
      } as any,
      getAttemptEpoch: () => 1,
      getProbeCount: () => probeCount,
      incrementProbeCount: () => ++probeCount,
      promoteProbeConnection: promoteSpy
    })

    await mgr.checkAndScheduleSilentUpgrade(true)
    await vi.advanceTimersByTimeAsync(10)

    probeDc.readyState = 'open'
    const openPromise = probeDc.onopen()
    // Simulate probePc closing mid-await updateTransportInfo(probePc)
    probePc.connectionState = 'closed'
    resolveProbeStats()
    await openPromise

    expect(promoteSpy).not.toHaveBeenCalled()
    expect(peerMgr.currentTransportInfo).toEqual(relayInfo)
    expect(peerMgr.updateTransportInfo).toHaveBeenCalledWith(activeTurnPc)

    // Next silent upgrade probe MUST still be scheduled (probeCount advances from 1 to 2 after delay)
    await vi.advanceTimersByTimeAsync(120000)
    expect(probeCount).toBe(2)

    mgr.resetSilentUpgradeState()
  })

  it('M1-11. Probe 4.6c: clientSilentUpgrade re-runs checkAndScheduleSilentUpgrade when probeSettled turns true after updateTransportInfo mutates currentTransportInfo to ipv6_p2p', async () => {
    const activeTurnPc = createMockPeer({ connectionState: 'connected', signalingState: 'stable' })
    const activeTurnDc: any = { readyState: 'open', close: vi.fn() }
    const probePc = createMockPeer({ connectionState: 'connected', signalingState: 'stable' })
    const probeDc: any = { readyState: 'connecting', send: vi.fn(), close: vi.fn(), onopen: null, onclose: null, onmessage: null }
    probePc.createDataChannel = vi.fn().mockReturnValue(probeDc)
    global.RTCPeerConnection = vi.fn().mockImplementation(() => probePc) as any

    const relayInfo = {
      type: 'relay' as const,
      localCandidateType: 'relay',
      remoteCandidateType: 'relay',
      localAddress: '1.2.3.4',
      remoteAddress: '5.6.7.8',
      protocol: 'TCP',
      rttMs: 110
    }
    let capturedOnDisconnect: ((reason?: string) => void) | undefined
    let resolveProbeStats!: () => void
    const promoteSpy = vi.fn()
    const peerMgr: any = {
      currentTransportInfo: relayInfo,
      createPeerConnection: vi.fn().mockImplementation((_target: any, onDisconnect?: (reason?: string) => void) => {
        capturedOnDisconnect = onDisconnect
        return probePc
      }),
      beginSilentUpgrade: vi.fn(),
      endSilentUpgrade: vi.fn(),
      holdLocalCandidates: vi.fn(),
      releaseLocalCandidates: vi.fn(),
      finalizeLocalSdp: vi.fn().mockImplementation(async (_pc, sdp) => sdp),
      updateTransportInfo: vi.fn().mockImplementation((targetPc: RTCPeerConnection) => {
        if (targetPc === probePc) {
          return new Promise<void>((resolve) => {
            resolveProbeStats = () => {
              peerMgr.currentTransportInfo = {
                type: 'ipv6_p2p',
                localCandidateType: 'host',
                remoteCandidateType: 'host',
                localAddress: '2409::1',
                remoteAddress: '2409::2',
                protocol: 'UDP',
                rttMs: 15
              }
              // Simulate probeSettled becoming true AFTER currentTransportInfo is mutated to ipv6_p2p
              // and BEFORE probeDc.onopen resumes past await updateTransportInfo(probePc).
              capturedOnDisconnect?.('connection_failed')
              resolve()
            }
          })
        }
        peerMgr.currentTransportInfo = relayInfo
        return Promise.resolve()
      })
    }

    let probeCount = 0
    const mgr = createClientSilentUpgradeManager({
      ctx: {
        peerMgr,
        sas: { clientSharedAesKey: null },
        getSignaling: () => ({ send: vi.fn() }),
        getLocalEcdhPubHex: () => '041122',
        getLocalDeviceId: () => 'dev-1',
        getClientSessionId: () => 'sess-46c',
        getCurrentHostSessionId: () => 'host-1',
        getClientHostSenderId: () => 'host-peer-1',
        getClientPc: () => activeTurnPc,
        getClientDc: () => activeTurnDc,
        isExplicitlyClosed: () => false,
        isHostMode: () => false,
        handleChannelMessage: vi.fn()
      } as any,
      getAttemptEpoch: () => 1,
      getProbeCount: () => probeCount,
      incrementProbeCount: () => ++probeCount,
      promoteProbeConnection: promoteSpy
    })

    await mgr.checkAndScheduleSilentUpgrade(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(probeCount).toBe(1)

    probeDc.readyState = 'open'
    const openPromise = probeDc.onopen()
    resolveProbeStats()
    await openPromise

    expect(promoteSpy).not.toHaveBeenCalled()
    expect(peerMgr.currentTransportInfo).toEqual(relayInfo)
    expect(peerMgr.updateTransportInfo).toHaveBeenCalledWith(activeTurnPc)

    // Probe #2 MUST be scheduled despite finishProbe(false) earlier observing ipv6_p2p
    await vi.advanceTimersByTimeAsync(120000)
    expect(probeCount).toBe(2)

    mgr.resetSilentUpgradeState()
  })

  it('M1-12. VirtualDataChannel.send/sendAsync rejects cleanly without calling signaling.send, hanging, or leaking pendingSendAborts when close() fires mid-encryptSignalingData', async () => {
    const origEncrypt = crypto.subtle.encrypt.bind(crypto.subtle)
    let releaseEncrypt!: () => void
    let notifyEncryptEntered!: () => void
    let encryptEntered = new Promise<void>((resolve) => {
      notifyEncryptEntered = resolve
    })
    let encryptGate = new Promise<void>((resolve) => {
      releaseEncrypt = resolve
    })

    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (algo: any, key: any, data: any) => {
      notifyEncryptEntered()
      await encryptGate
      return origEncrypt(algo, key, data)
    })

    try {
      // Part A: sendAsync() with a blackhole signaling.send must reject cleanly when close() fires mid-encryption
      const blackholeSignaling = {
        send: vi.fn().mockImplementation(() => new Promise<void>(() => {}))
      }
      const vdcA = new VirtualDataChannel({
        label: 'm1-12-sendasync',
        sessionId: 'sess-m1-12-a',
        getSignaling: () => blackholeSignaling as any,
        getSharedAesKey: () => mockAesKey,
        getTargetPeerId: () => 'host-peer-1'
      })
      vdcA.open()

      const sendAsyncPromise = vdcA.sendAsync('mid-encrypt-close-async')
      await encryptEntered

      // Close fires AFTER pre-await readyState check passed and WHILE encryptSignalingData is suspended
      vdcA.close()
      expect(vdcA.readyState).toBe('closed')

      // Resume encryption -> post-await guard must reject without calling signaling.send or leaking pendingSendAborts
      releaseEncrypt()
      await expect(sendAsyncPromise).rejects.toThrow(/VirtualDataChannel closed before queued frame could be sent \(state: closed\)/)
      expect(blackholeSignaling.send).not.toHaveBeenCalled()
      expect((vdcA as any).pendingSendAborts.size).toBe(0)
      expect(vdcA.bufferedAmount).toBe(0)

      // Subsequent sendAsync on closed channel must reject immediately (sendChain must not wedge)
      await expect(vdcA.sendAsync('after-close')).rejects.toThrow(/VirtualDataChannel is not open \(state: closed\)/)

      // Part B: send() (fire-and-forget wrapper) must surface error event cleanly when close() fires mid-encryption
      encryptEntered = new Promise<void>((resolve) => {
        notifyEncryptEntered = resolve
      })
      encryptGate = new Promise<void>((resolve) => {
        releaseEncrypt = resolve
      })

      const vdcB = new VirtualDataChannel({
        label: 'm1-12-send',
        sessionId: 'sess-m1-12-b',
        getSignaling: () => blackholeSignaling as any,
        getSharedAesKey: () => mockAesKey,
        getTargetPeerId: () => 'host-peer-1'
      })
      vdcB.open()

      const capturedErrors: any[] = []
      vdcB.onerror = (ev: any) => {
        capturedErrors.push(ev)
      }

      vdcB.send('mid-encrypt-close-sync')
      await encryptEntered
      vdcB.close()
      releaseEncrypt()

      await waitUntil(() => capturedErrors.length > 0)
      expect(capturedErrors).toHaveLength(1)
      expect(String(capturedErrors[0]?.message || capturedErrors[0]?.error?.message || '')).toMatch(
        /VirtualDataChannel closed before queued frame could be sent \(state: closed\)/
      )
      expect(blackholeSignaling.send).not.toHaveBeenCalled()
      expect((vdcB as any).pendingSendAborts.size).toBe(0)
      expect(vdcB.bufferedAmount).toBe(0)
    } finally {
      encryptSpy.mockRestore()
    }
  })
})
