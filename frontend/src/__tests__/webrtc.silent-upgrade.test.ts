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

describe('WebRTC Silent Upgrade Probing Hardening', () => {
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
})
