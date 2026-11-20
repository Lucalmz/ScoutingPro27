import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  buildIceConfiguration,
  setCustomTurnConfig,
  getCustomTurnConfig,
  getEffectiveTurnServers,
  TURN_SERVERS
} from '@/services/webrtc/connectivity'
import { useEventStore } from '@/stores/events'
import { createEvent, joinEvent, listEvents } from '@/services/api'
import { PeerConnectionManager } from '@/services/webrtc/peerManager'
import { createHostSignalingHandler } from '@/services/webrtc/hostSession'
import { createClientSession } from '@/services/webrtc/clientSession'
import { SasSecurityManager } from '@/services/webrtc/sasManager'
import { encryptSignalingData } from '@/utils/crypto'
import type { CustomTurnConfig, ScoutingEvent } from '@/types'

const realSetTimeout = globalThis.setTimeout.bind(globalThis)

async function waitUntil(predicate: () => boolean, maxAttempts = 80): Promise<void> {
  for (let i = 0; i < maxAttempts && !predicate(); i++) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 2))
  }
}

vi.mock('@/services/api', () => ({
  listEvents: vi.fn().mockResolvedValue([]),
  createEvent: vi.fn(),
  joinEvent: vi.fn(),
  syncExternalEvent: vi.fn(),
  deleteEvent: vi.fn().mockResolvedValue(undefined),
  isStaticCloudHost: vi.fn().mockReturnValue(false),
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
    iceGatheringState: 'complete',
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

describe('Custom TURN Configuration & Isolation', () => {
  const origRtcpc = global.RTCPeerConnection

  beforeEach(() => {
    setActivePinia(createPinia())
    setCustomTurnConfig(null)
    if (typeof localStorage !== 'undefined') {
      localStorage.clear()
    }
  })

  afterEach(() => {
    setCustomTurnConfig(null)
    global.RTCPeerConnection = origRtcpc
    vi.useRealTimers()
  })

  it('uses hardcoded TURN_SERVERS (global.relay.metered.ca) by default when custom TURN is null or empty', () => {
    expect(getCustomTurnConfig()).toBeNull()
    expect(getEffectiveTurnServers()).toEqual(TURN_SERVERS)

    const cfg = buildIceConfiguration(true, false)
    const turnEntries = cfg.iceServers!.filter((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
      return urls.some((u) => /^turns?:/i.test(u))
    })
    expect(turnEntries).toEqual(TURN_SERVERS)
    expect(JSON.stringify(turnEntries)).toContain('global.relay.metered.ca')

    // Invalid/empty configs reset to null and keep default TURN_SERVERS
    setCustomTurnConfig({ urls: ['http://invalid.example.com'], username: 'team123', credential: 'secret' })
    expect(getCustomTurnConfig()).toBeNull()
    setCustomTurnConfig({ urls: ['turn:turn.team123.org:3478'], username: '   ', credential: 'secret' })
    expect(getCustomTurnConfig()).toBeNull()
    expect(getEffectiveTurnServers()).toEqual(TURN_SERVERS)
  })

  it('uses ONLY custom TURN servers and zero global.relay.metered.ca when setCustomTurnConfig is active, and 0 TURN when allowTurn=false', () => {
    const custom: CustomTurnConfig = {
      urls: ['turn:turn.team123.org:3478', 'turns:turn.team123.org:5349?transport=tcp'],
      username: 'team123',
      credential: 'secret'
    }
    setCustomTurnConfig(custom)
    expect(getCustomTurnConfig()).toEqual(custom)

    const fullTurnCfg = buildIceConfiguration(true, false)
    const fullTurnEntries = fullTurnCfg.iceServers!.filter((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
      return urls.some((u) => /^turns?:/i.test(u))
    })
    expect(fullTurnEntries).toEqual([
      { urls: 'turn:turn.team123.org:3478', username: 'team123', credential: 'secret' },
      { urls: 'turns:turn.team123.org:5349?transport=tcp', username: 'team123', credential: 'secret' }
    ])
    expect(JSON.stringify(fullTurnCfg.iceServers)).not.toContain('global.relay.metered.ca')

    const primaryOnlyCfg = buildIceConfiguration(true, false, { primaryTurnOnly: true })
    const primaryTurnEntries = primaryOnlyCfg.iceServers!.filter((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
      return urls.some((u) => /^turns?:/i.test(u))
    })
    expect(primaryTurnEntries).toEqual([
      { urls: 'turn:turn.team123.org:3478', username: 'team123', credential: 'secret' }
    ])
    expect(JSON.stringify(primaryOnlyCfg.iceServers)).not.toContain('global.relay.metered.ca')

    const noTurnCfg = buildIceConfiguration(false, false)
    const noTurnEntries = noTurnCfg.iceServers!.filter((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
      return urls.some((u) => /^turns?:/i.test(u))
    })
    expect(noTurnEntries).toHaveLength(0)

    // Clearing restores hardcoded TURN_SERVERS
    setCustomTurnConfig(null)
    expect(getCustomTurnConfig()).toBeNull()
    expect(getEffectiveTurnServers()).toEqual(TURN_SERVERS)
    const restoredCfg = buildIceConfiguration(true, false)
    expect(JSON.stringify(restoredCfg.iceServers)).toContain('global.relay.metered.ca')
  })

  it('syncs getCustomTurnConfig() from events store setCurrentEvent and updateTurnConfig', () => {
    const store = useEventStore()
    const custom: CustomTurnConfig = {
      urls: ['turns:relay.frc27.org:443?transport=tcp'],
      username: 'frc27',
      credential: 'pw27'
    }
    const evtA: ScoutingEvent = {
      id: 'evt-a',
      name: 'Event A',
      inviteCode: 'AAAA',
      hostId: 'host-1',
      customTurnConfig: custom,
      hasCustomTurn: true
    }
    const evtB: ScoutingEvent = {
      id: 'evt-b',
      name: 'Event B',
      inviteCode: 'BBBB',
      hostId: 'host-1'
    }

    store.events = [evtA, evtB]
    store.setCurrentEvent(evtA)
    expect(getCustomTurnConfig()).toEqual(custom)

    store.setCurrentEvent(evtB)
    expect(getCustomTurnConfig()).toBeNull()

    const updatedCustom: CustomTurnConfig = {
      urls: ['turn:turn.team999.net:3478'],
      username: 'team999',
      credential: 'tok999'
    }
    store.updateTurnConfig('evt-b', updatedCustom)
    expect(store.currentEvent?.customTurnConfig).toEqual(updatedCustom)
    expect(store.currentEvent?.hasCustomTurn).toBe(true)
    expect(getCustomTurnConfig()).toEqual(updatedCustom)

    store.updateTurnConfig('evt-b', null)
    expect(store.currentEvent?.customTurnConfig).toBeNull()
    expect(store.currentEvent?.hasCustomTurn).toBe(false)
    expect(getCustomTurnConfig()).toBeNull()
  })

  it('propagates customTurnConfig from hostSession optimizedAnswer to clientSession getCustomTurnConfig()', async () => {
    vi.useFakeTimers()
    const mockAesKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )

    const hostCustomTurn: CustomTurnConfig = {
      urls: ['turns:turn.team123.org:5349?transport=tcp'],
      username: 'team123',
      credential: 'secret-pass'
    }
    const hostEventMeta: ScoutingEvent = {
      id: 'evt-host-1',
      name: 'Host Event',
      inviteCode: 'INV123',
      hostId: 'host-1',
      customTurnConfig: hostCustomTurn,
      hasCustomTurn: true
    }

    const sentPayloads: any[] = []
    const hostSignaling = {
      send: vi.fn((payload: any) => sentPayloads.push(payload)),
      setHostMode: vi.fn(),
      isConnected: () => true
    }

    const hostPeer = createMockPeer({
      localDescription: { type: 'answer', sdp: 'v=0\r\n' },
      signalingState: 'stable'
    })
    let clientPeer = createMockPeer()
    let nextPeerIsHost = true
    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      return nextPeerIsHost ? hostPeer : clientPeer
    }) as any

    const hostSas = new SasSecurityManager()
    hostSas.clientSharedKeys.set('client-1', mockAesKey)

    const hostPeerMgr = new PeerConnectionManager({
      isHostMode: () => true,
      getHostSignaling: () => hostSignaling as any,
      getClientSignaling: () => null,
      getClientHostSenderId: () => '',
      getClientDcState: () => undefined,
      isExplicitlyClosed: () => false
    })

    const hostHandler = createHostSignalingHandler({
      clients: new Map(),
      stagedClients: new Map(),
      preOfferCandidates: new Map(),
      enqueueHostTask: (_sender, task) => task(),
      updateHostStatus: vi.fn(),
      peerMgr: hostPeerMgr,
      sas: hostSas,
      getSignaling: () => hostSignaling as any,
      getLocalEcdhKeyPair: () => null,
      getLocalEcdhPubHex: () => '',
      getLocalDeviceId: () => 'host-dev',
      getHostSessionId: () => 'host-sess-1',
      getCurrentInviteCode: () => 'INV123',
      getCurrentEventMetadata: () => hostEventMeta,
      sendMessage: vi.fn(),
      handleChannelMessage: vi.fn(),
      rejectSas: vi.fn(),
      callbacks: {}
    })

    hostHandler({
      sender: 'client-1',
      clientSessionId: 'csess-1',
      allowTurn: false,
      offer: { type: 'offer', sdp: 'v=0\r\n' }
    })

    await vi.advanceTimersByTimeAsync(350)
    await waitUntil(() => sentPayloads.some((p) => p.answer))
    const answerMsg = sentPayloads.find((p) => p.answer)
    expect(answerMsg).toBeDefined()
    expect(answerMsg.answer.ciphertext).toBeDefined()

    // Now switch to client side with customTurnConfig initially null
    setCustomTurnConfig(null)
    expect(getCustomTurnConfig()).toBeNull()
    nextPeerIsHost = false

    let curPc: any = null
    let curDc: any = null
    let clientSessionId = 'csess-1'
    const clientPeerMgr = new PeerConnectionManager({
      isHostMode: () => false,
      getHostSignaling: () => null,
      getClientSignaling: () => ({ send: vi.fn(), isConnected: () => true }) as any,
      getClientHostSenderId: () => 'host-peer-1',
      getClientDcState: () => curDc?.readyState,
      isExplicitlyClosed: () => false
    })

    const clientSession = createClientSession({
      peerMgr: clientPeerMgr,
      sas: {
        clientSasState: 'VERIFIED',
        clientSharedAesKey: mockAesKey,
        clientHostEcdhPubHex: '04abcd',
        clientHostDeviceId: 'host-dev',
        clientSecurityFingerprint: 'AABB-CCDD'
      } as any,
      getSignaling: () => ({ send: vi.fn(), isConnected: () => true }) as any,
      getLocalEcdhKeyPair: () => null,
      getLocalEcdhPubHex: () => '041122',
      getLocalDeviceId: () => 'phone-dev-1',
      getCurrentInviteCode: () => 'INV123',
      getCurrentHostSessionId: () => 'host-sess-1',
      setCurrentHostSessionId: () => {},
      getClientSessionId: () => clientSessionId,
      setClientSessionId: (id) => {
        clientSessionId = id
      },
      getClientHostSenderId: () => 'host-peer-1',
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
      sendMessage: async () => {},
      handleChannelMessage: async () => {},
      rejectSas: () => {},
      callbacks: {}
    })

    await clientSession.setupClientConnection()
    await clientSession.handleClientSignalingMessage({
      sender: 'host-peer-1',
      clientSessionId,
      hostSessionId: 'host-sess-1',
      answer: answerMsg.answer
    })

    expect(getCustomTurnConfig()).toEqual(hostCustomTurn)

    // Also verify explicit null answer on a fresh attempt clears custom TURN config
    clientPeer = createMockPeer()
    await clientSession.setupClientConnection()
    const clearedPayload = await encryptSignalingData(
      mockAesKey,
      JSON.stringify({ type: 'answer', sdp: 'v=0\r\n', customTurnConfig: null })
    )
    await clientSession.handleClientSignalingMessage({
      sender: 'host-peer-1',
      clientSessionId,
      hostSessionId: 'host-sess-1',
      answer: clearedPayload
    })
    expect(getCustomTurnConfig()).toBeNull()
  })

  it('syncs and clears getCustomTurnConfig() across create, join, fetchEvents, deleteEvent, and clearAllLocalCache', async () => {
    const store = useEventStore()
    const customTurnA: CustomTurnConfig = {
      urls: ['turn:turn.team123.org:3478'],
      username: 'team123',
      credential: 'secret-a'
    }
    const customTurnB: CustomTurnConfig = {
      urls: ['turns:turn.team456.org:5349?transport=tcp'],
      username: 'team456',
      credential: 'secret-b'
    }

    // 1. Seed active custom TURN from Event A, then create() a new event -> must clear custom TURN
    setCustomTurnConfig(customTurnA)
    expect(getCustomTurnConfig()).toEqual(customTurnA)
    vi.mocked(createEvent).mockResolvedValueOnce({ id: 'evt-new', inviteCode: 'NEW1' })
    await store.create('New Event')
    expect(store.currentEvent?.id).toBe('evt-new')
    expect(getCustomTurnConfig()).toBeNull()

    // 2. join() an event that has customTurnConfig -> must sync custom TURN
    vi.mocked(joinEvent).mockResolvedValueOnce({
      id: 'evt-joined',
      name: 'Joined Event',
      inviteCode: 'JOIN',
      hostId: 'host-j',
      customTurnConfig: customTurnB,
      hasCustomTurn: true
    })
    await store.join('JOIN')
    expect(store.currentEvent?.id).toBe('evt-joined')
    expect(getCustomTurnConfig()).toEqual(customTurnB)

    // 3. fetchEvents() refreshes currentEvent from backend -> updates customTurnConfig
    vi.mocked(listEvents).mockResolvedValueOnce([
      {
        id: 'evt-joined',
        name: 'Joined Event',
        inviteCode: 'JOIN',
        hostId: 'host-j',
        customTurnConfig: customTurnA,
        hasCustomTurn: true
      }
    ])
    await store.fetchEvents('user-1')
    expect(getCustomTurnConfig()).toEqual(customTurnA)

    // 4. deleteEvent() on currentEvent -> clears currentEvent and custom TURN
    await store.deleteEvent('evt-joined')
    expect(store.currentEvent).toBeNull()
    expect(getCustomTurnConfig()).toBeNull()

    // 5. clearAllLocalCache() while an event with custom TURN is active -> clears custom TURN
    store.setCurrentEvent({
      id: 'evt-cache',
      name: 'Cached Event',
      inviteCode: 'CACH',
      hostId: 'host-c',
      customTurnConfig: customTurnB,
      hasCustomTurn: true
    })
    expect(getCustomTurnConfig()).toEqual(customTurnB)
    store.clearAllLocalCache()
    expect(store.currentEvent).toBeNull()
    expect(getCustomTurnConfig()).toBeNull()
  })
})
