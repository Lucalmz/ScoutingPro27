import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  createWebRtcService,
  probePublicConnectivity,
  resetConnectivityProbeCacheForTesting,
  STUN_SERVERS,
  isGlobalIpv6Address,
  isIpv6Address,
  isPrivateIpv4Address,
  optimizeCandidatePriority,
  optimizeSdpCandidates,
  sortCandidatesPreferIpv6,
  classifyCandidatePair
} from '../services/webrtc'
import {
  deriveHmacKey,
  signSignalingPayload,
  generateNonce,
  generateEcdhKeyPair,
  exportEcdhPublicKey
} from '../utils/crypto'
import { savePeerTrustRecord, clearSecurityStoreForTesting } from '../utils/identityStore'
import * as api from '../services/api'
import mqtt from 'mqtt'

const origRTCPeerConnection = global.RTCPeerConnection
const origRTCSessionDescription = global.RTCSessionDescription
const origRTCIceCandidate = global.RTCIceCandidate
const origFetch = global.fetch

function resetDefaultApiMocks() {
  vi.mocked(api.syncRecords).mockResolvedValue(undefined as any)
  vi.mocked(api.login).mockImplementation(async ({ username, password }: any) => {
    if (password === 'CorrectPassword123') {
      return { id: 'user_target_id', username, token: 'target_jwt_token' }
    }
    const err: any = new Error('Invalid credentials')
    err.status = 401
    throw err
  })
  vi.mocked(api.createWebRtcTicket).mockImplementation(async (_eventId: string, ecdhPublicKey: string) => {
    return { ticket: `ticket_for_${ecdhPublicKey.slice(0, 10)}`, expiresIn: 180 }
  })
  vi.mocked(api.verifyWebRtcTicket).mockImplementation(async (ticket: string, _eventId: string, ecdhPublicKey: string) => {
    if (ticket.includes('ticket_for_') && ecdhPublicKey && ticket === `ticket_for_${ecdhPublicKey.slice(0, 10)}`) {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (ticket === 'valid_ticket_alice' && ecdhPublicKey === '04alice_pk') {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (ticket === 'valid_ticket_bob' && ecdhPublicKey === '04bob_pk') {
      return { valid: true, userId: 'scout_bob', username: 'Bob' }
    }
    if (ticket === 'cross_machine_foreign_ticket') {
      return { valid: false, error: "Invalid or expired ticket: The Token's Signature resulted invalid" }
    }
    if (ticket === 'user_not_found_ticket') {
      return { valid: false, error: 'User not found' }
    }
    return { valid: false, error: 'Public key hash mismatch' }
  })
  vi.mocked(api.verifyToken).mockImplementation(async (token: string) => {
    if (token === 'valid_jwt_alice') {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (token === 'valid_jwt_bob') {
      return { valid: true, userId: 'scout_bob', username: 'Bob' }
    }
    if (token === 'valid_jwt_client1' || token === 'client1') {
      return { valid: true, userId: 'client1', username: 'Client 1' }
    }
    return { valid: false }
  })
}




vi.mock('mqtt', () => {
  return {
    default: {
      connect: vi.fn()
    }
  }
})

vi.mock('../services/api', () => ({
  syncRecords: vi.fn().mockResolvedValue(undefined),
  login: vi.fn().mockImplementation(async ({ username, password }: any) => {
    if (password === 'CorrectPassword123') {
      return { id: 'user_target_id', username, token: 'target_jwt_token' }
    }
    const err: any = new Error('Invalid credentials')
    err.status = 401
    throw err
  }),
  createWebRtcTicket: vi.fn().mockImplementation(async (eventId: string, ecdhPublicKey: string) => {
    return { ticket: `ticket_for_${ecdhPublicKey.slice(0, 10)}`, expiresIn: 180 }
  }),
  verifyWebRtcTicket: vi.fn().mockImplementation(async (ticket: string, eventId: string, ecdhPublicKey: string) => {
    if (ticket.includes('ticket_for_') && ecdhPublicKey && ticket === `ticket_for_${ecdhPublicKey.slice(0, 10)}`) {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (ticket === 'valid_ticket_alice' && ecdhPublicKey === '04alice_pk') {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (ticket === 'valid_ticket_bob' && ecdhPublicKey === '04bob_pk') {
      return { valid: true, userId: 'scout_bob', username: 'Bob' }
    }
    if (ticket === 'cross_machine_foreign_ticket') {
      return { valid: false, error: "Invalid or expired ticket: The Token's Signature resulted invalid" }
    }
    if (ticket === 'user_not_found_ticket') {
      return { valid: false, error: 'User not found' }
    }
    return { valid: false, error: 'Public key hash mismatch' }
  }),
  verifyToken: vi.fn().mockImplementation(async (token: string) => {
    if (token === 'valid_jwt_alice') {
      return { valid: true, userId: 'scout_alice', username: 'Alice' }
    }
    if (token === 'valid_jwt_bob') {
      return { valid: true, userId: 'scout_bob', username: 'Bob' }
    }
    if (token === 'valid_jwt_client1' || token === 'client1') {
      return { valid: true, userId: 'client1', username: 'Client 1' }
    }
    return { valid: false }
  })
}))


describe('webrtc service', () => {
  let mockMqttClient: any
  const createdServices: Array<{ disconnect: () => void }> = []
  const trackService = <T extends { disconnect: () => void }>(s: T): T => {
    createdServices.push(s)
    return s
  }

  beforeEach(() => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    resetDefaultApiMocks()
    mockMqttClient = {
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn(),
      connected: true,
      unsubscribe: vi.fn(),
      end: vi.fn()
    }
    vi.mocked(mqtt.connect).mockReturnValue(mockMqttClient)

    // Mock WebRTC globals
    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      return {
        createDataChannel: vi.fn().mockReturnValue({
          send: vi.fn(),
          readyState: 'open',
          close: vi.fn(),
        }),
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        restartIce: vi.fn(),
        close: vi.fn(),
        connectionState: 'new',
      }
    }) as any

    global.RTCSessionDescription = vi.fn().mockImplementation((init) => init) as any
    global.RTCIceCandidate = vi.fn().mockImplementation((init) => init) as any
  })

  afterEach(() => {
    while (createdServices.length > 0) {
      createdServices.pop()?.disconnect()
    }
    delete (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__
    global.fetch = origFetch
    localStorage.clear()
    global.RTCPeerConnection = origRTCPeerConnection
    global.RTCSessionDescription = origRTCSessionDescription
    global.RTCIceCandidate = origRTCIceCandidate
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('enqueueHostTask executes sequentially', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    const calls: number[] = []
    let releaseSetRemote!: () => void
    const setRemoteGate = new Promise<void>((resolve) => {
      releaseSetRemote = resolve
    })

    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      return {
        setRemoteDescription: vi.fn().mockImplementation(async () => {
          calls.push(1)
          await setRemoteGate
          calls.push(2)
        }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockImplementation(async () => {
          calls.push(3)
          calls.push(4)
        }),
        close: vi.fn(),
        connectionState: 'new'
      }
    }) as any

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client1',
      offer: { type: 'offer', sdp: '...' }
    })))

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client1',
      candidate: { candidate: 'cand1' }
    })))

    // Offer entered setRemoteDescription while candidate waits behind it in enqueueHostTask
    await vi.waitFor(() => {
      expect(calls).toEqual([1])
    })

    releaseSetRemote()
    await vi.waitFor(() => {
      expect(calls).toEqual([1, 2, 3, 4])
    })
  })

  it('sendMessage correctly handles targetId (unicast)', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')
    
    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    let dc1: any, dc2: any;

    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      return {
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        connectionState: 'new',
      }
    }) as any

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn() }
    pc1.ondatachannel({ channel: dc1 })

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn() }
    pc2.ondatachannel({ channel: dc2 })

    service.pushRecords([], 'client1')
    
    expect(dc1.send).toHaveBeenCalled()
    expect(dc2.send).not.toHaveBeenCalled()
  })

  it('drops received message if authCode does not match', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')
    
    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      return {
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        connectionState: 'new',
      }
    }) as any

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    dc1.onmessage({
      data: JSON.stringify({ type: 'REQUEST_SYNC', authCode: 'wrong-code', token: 'valid_jwt_client1' })
    })

    expect(callbacks.onRequestSync).not.toHaveBeenCalled()

    await dc1.onmessage({
      data: JSON.stringify({ type: 'REQUEST_SYNC', authCode: 'test-code', token: 'valid_jwt_client1' })
    })

    expect(callbacks.onRequestSync).toHaveBeenCalled()
  })

  it('SYNC_DATA triggers persistence before broadcast and handles partial acceptance', async () => {
    const { syncRecords } = await import('../services/api')
    const callbacks = {
      onStatusChange: vi.fn(),
      // 模拟 2 条记录中只有 r1 被接受，r2 因旧版本被拒绝
      onRecordsReceived: vi.fn().mockImplementation(async (records: any[]) => {
        return records.filter(r => r.id === 'r1')
      }),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')
    
    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    
    let dc1: any, dc2: any;

    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      return {
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        connectionState: 'new',
      }
    }) as any

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc2.ondatachannel({ channel: dc2 })

    await dc1.onmessage({
      data: JSON.stringify({
        type: 'SYNC_DATA',
        records: [{ id: 'r1', scoutId: 'client1' }, { id: 'r2', scoutId: 'client1' }],
        senderUserId: 'client1',
        token: 'valid_jwt_client1',
        authCode: 'test-code'
      })
    })

    // 验证 Host 在广播前先调用了 syncRecords 持久化已接受的记录
    expect(syncRecords).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'r1' })]))

    // 验证 ACK 回执中包含 stampedRecords (r1) 以及 rejectedRecordIds (r2)
    expect(dc1.send).toHaveBeenCalledWith(expect.stringContaining('"rejectedRecordIds":["r2"]'))
    const ackPayload = JSON.parse(dc1.send.mock.calls[0][0])
    expect(ackPayload.stampedRecords).toEqual([expect.objectContaining({ id: 'r1', scoutId: 'client1' })])
    
    // 验证仅向 client2 广播了 accepted 记录
    const relayPayload = JSON.parse(dc2.send.mock.calls[0][0])
    expect(relayPayload.records).toEqual([expect.objectContaining({ id: 'r1', scoutId: 'client1' })])
  })

  it('Host does not broadcast if DB persistence fails', async () => {
    const { syncRecords } = await import('../services/api')
    vi.mocked(syncRecords).mockRejectedValueOnce(new Error('DB Error'))

    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([{ id: 'r1', scoutId: 'client1' }]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')
    
    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    
    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      connectionState: 'new',
    })) as any

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc2.ondatachannel({ channel: dc2 })

    await dc1.onmessage({
      data: JSON.stringify({
        type: 'SYNC_DATA',
        records: [{ id: 'r1', scoutId: 'client1' }],
        senderUserId: 'client1',
        token: 'valid_jwt_client1',
        authCode: 'test-code'
      })
    })

    // 验证失败时不向 client2 广播
    expect(dc2.send).not.toHaveBeenCalled()
    // 验证向 client1 发送了包含 rejectedRecordIds 的回执供其重试
    expect(dc1.send).toHaveBeenCalledWith(expect.stringContaining('"rejectedRecordIds":["r1"]'))
  })

  it('Client receiving SYNC_DATA does not send redundant ACK_SYNC', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([{ id: 'r1' }]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.join('test-code')

    const connectCb = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
    await connectCb?.()

    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc = pc.createDataChannel.mock.results[0].value
    
    // Simulate Host sending SYNC_DATA to Client
    await dc.onmessage({
      data: JSON.stringify({ type: 'SYNC_DATA', records: [{ id: 'r1' }] })
    })

    expect(callbacks.onRecordsReceived).toHaveBeenCalled()
    // Client 应落库，但不应向 Host 发送冗余 ACK_SYNC
    expect(dc.send).not.toHaveBeenCalled()
  })

  it('Host rejects and drops SYNC_DATA records when scoutId does not match sender peer authenticated identity', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. Client 1 (Alice) connects with valid JWT
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    // Alice authenticates via REQUEST_SYNC with valid JWT
    await dc1.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        senderUserName: 'Alice',
        token: 'valid_jwt_alice',
        authCode: 'test-code'
      })
    })

    // 2. Alice sends SYNC_DATA containing 1 legitimate record and 1 forged record (Bob's ID)
    const recAlice = { id: 'rec_1', scoutId: 'scout_alice', matchNumber: 1, teamNumber: 27570 }
    const recForgedBob = { id: 'rec_forged', scoutId: 'scout_bob', matchNumber: 1, teamNumber: 27570 }

    await dc1.onmessage({
      data: JSON.stringify({
        type: 'SYNC_DATA',
        records: [recAlice, recForgedBob],
        authCode: 'test-code'
      })
    })

    // 3. 验证 Host 仅将合法归属 Alice 的记录送入 onRecordsReceived 进行落库
    expect(callbacks.onRecordsReceived).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'rec_1', scoutId: 'scout_alice' })],
      'peer_alice'
    )
    expect(callbacks.onRecordsReceived).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'rec_forged' })]),
      expect.anything()
    )

    // 4. 验证 Host 向 Alice 回传包含 rec_forged 的被拒回执 (rejectedRecordIds)
    expect(dc1.send).toHaveBeenCalledWith(expect.stringContaining('"rejectedRecordIds":["rec_forged"]'))
  })

  it('pushRecords slices large batch into chunks of 15 records', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.join('test-code')

    const connectCb = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
    await connectCb?.()

    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc = pc.createDataChannel.mock.results[0].value

    // Generate 35 dummy records
    const records: any[] = []
    for (let i = 1; i <= 35; i++) {
      records.push({ id: `rec_${i}`, matchNumber: i, teamNumber: 27570 })
    }

    await service.pushRecords(records)

    // 35 records should be split into 3 chunks: 15, 15, 5
    expect(dc.send).toHaveBeenCalledTimes(3)
    const chunk1 = JSON.parse(dc.send.mock.calls[0][0])
    const chunk2 = JSON.parse(dc.send.mock.calls[1][0])
    const chunk3 = JSON.parse(dc.send.mock.calls[2][0])

    expect(chunk1.type).toBe('SYNC_DATA')
    expect(chunk1.records).toHaveLength(15)
    expect(chunk2.records).toHaveLength(15)
    expect(chunk3.records).toHaveLength(5)
  })

  it('probePublicConnectivity returns true when fetch succeeds and false on failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true })
    const ok = await probePublicConnectivity(100, true)
    expect(ok).toBe(true)

    global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'))
    const fail = await probePublicConnectivity(100, true)
    expect(fail).toBe(false)
  })

  it('reconnectNow resets attempts and establishes connection', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true })
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.join('test-code')

    // Call reconnectNow explicitly
    const reconnected = await service.reconnectNow()
    expect(reconnected).toBe(true)
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('connecting')
  })

  it('transitions to long_offline after 6 failed reconnect attempts', async () => {
    vi.useFakeTimers()
    try {
      const callbacks = {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn(),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn()
      }
      const service = createWebRtcService(callbacks)
      await service.join('test-code')

      const connectCb = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
      await connectCb?.()

      const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
      const dc = pc.createDataChannel.mock.results[0].value

      // Trigger 7 consecutive disconnects (6 retries exhausted -> long_offline)
      for (let i = 0; i < 7; i++) {
        const curDc = service.getDataChannel()
        curDc?.onclose?.({} as any)
        await vi.runAllTimersAsync()
      }

      // After 6 retries, status should be long_offline
      expect(callbacks.onStatusChange).toHaveBeenCalledWith('long_offline')
      expect(service.getStatus()).toBe('long_offline')
    } finally {
      vi.useRealTimers()
    }
  })

  it('disconnect cleans up event listeners and stops timers', () => {
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    service.disconnect()

    expect(removeEventListenerSpy).toHaveBeenCalledWith('online', expect.any(Function))
    expect(service.getStatus()).toBe('offline')
  })

  it('drops illegal business payload (SYNC_DATA/DIRECT_MESSAGE) over MQTT signaling channel', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // Attacker publishes malicious SYNC_DATA directly to MQTT
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'SYNC_DATA',
      records: [{ id: 'injected_rec', matchNumber: 1, teamNumber: 9999 }],
      sender: 'attacker_peer'
    })))

    // Must be dropped with security warning and never call onRecordsReceived
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Dropped illegal business payload 'SYNC_DATA' over public MQTT signaling channel.")
    )
    expect(callbacks.onRecordsReceived).not.toHaveBeenCalled()
    consoleWarnSpy.mockRestore()
  })

  it('Host allows same user to connect simultaneously on two devices without conflict', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onClientConnected: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. First device connects as Alice
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    await dc1.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        senderUserName: 'Alice',
        authCode: 'test-code'
      })
    })

    // 2. Second device connects as Alice
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc2.ondatachannel({ channel: dc2 })

    await dc2.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        senderUserName: 'Alice',
        authCode: 'test-code'
      })
    })

    // Second device does NOT receive SESSION_CONFLICT, and device 1 remains open
    const conflictCall = dc2.send.mock.calls.find((c: any) => c[0].includes('"type":"SESSION_CONFLICT"'))
    expect(conflictCall).toBeUndefined()
    expect(dc1.close).not.toHaveBeenCalled()
    expect(callbacks.onClientConnected).toHaveBeenCalledWith('scout_alice', 'Alice')
  })

  it('Host detects DUPLICATE_NAME conflict when different identity uses same username', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. First device connects as Alice (Pass 1 -> scout_alice_user1)
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_user1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    await dc1.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice_user1',
        senderUserName: 'Alice',
        authCode: 'test-code'
      })
    })

    // 2. Second device connects as Alice with different password (Pass 2 -> scout_alice_user2)
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_user2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc2.ondatachannel({ channel: dc2 })

    await dc2.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice_user2',
        senderUserName: 'Alice',
        authCode: 'test-code'
      })
    })

    // Host should send DUPLICATE_NAME conflict to user 2 with suggestedName
    expect(dc2.send).toHaveBeenCalledWith(
      expect.stringContaining('"conflictType":"DUPLICATE_NAME"')
    )
    expect(dc2.send).toHaveBeenCalledWith(
      expect.stringContaining('"conflictingUserId":"scout_alice_user1"')
    )
  })

  it('Host detects DUPLICATE_NAME conflict when client has same username as Host itself', async () => {
    localStorage.setItem(
      'scoutingpro-user',
      JSON.stringify({ id: 'host_alice_uuid', username: 'HostAlice' })
    )

    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onClientConnected: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // Client connects with same username as Host but different userId
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_client_alice',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc.ondatachannel({ channel: dc })

    await dc.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'client_alice_uuid',
        senderUserName: 'HostAlice',
        authCode: 'test-code'
      })
    })

    expect(dc.send).toHaveBeenCalledWith(
      expect.stringContaining('"conflictType":"DUPLICATE_NAME"')
    )
    expect(dc.send).toHaveBeenCalledWith(
      expect.stringContaining('"conflictingUserId":"host_alice_uuid"')
    )
    expect(dc.send).toHaveBeenCalledWith(
      expect.stringContaining('"conflictingUsername":"HostAlice"')
    )

    localStorage.removeItem('scoutingpro-user')
  })

  it('Host handles takeover request with permit decision', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onClientConnected: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. Dev 1 connects as Alice
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const closeSpy1 = vi.spyOn(pc1, 'close')
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    await dc1.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        senderUserName: 'Alice',
        authCode: 'test-code'
      })
    })

    // 2. Dev 2 connects and requests takeover
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc2.ondatachannel({ channel: dc2 })

    await dc2.onmessage({
      data: JSON.stringify({
        type: 'TAKEOVER_REQUEST',
        username: 'Alice',
        userId: 'scout_alice',
        authCode: 'test-code'
      })
    })

    // Dev 1 receives TAKEOVER_PROMPT
    expect(dc1.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"TAKEOVER_PROMPT"')
    )

    // Dev 1 grants permit
    await dc1.onmessage({
      data: JSON.stringify({
        type: 'TAKEOVER_DECISION',
        username: 'Alice',
        permit: true,
        authCode: 'test-code'
      })
    })

    // Dev 1 receives SESSION_KICKED and is closed
    expect(dc1.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"SESSION_KICKED"')
    )
    expect(closeSpy1).toHaveBeenCalled()

    // Dev 2 is promoted
    expect(callbacks.onClientConnected).toHaveBeenCalledWith('scout_alice', 'Alice')
  })

  it('Host handles takeover request auto-permit upon 15s timeout', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onClientConnected: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. Dev 1 connects as Alice
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const closeSpy1 = vi.spyOn(pc1, 'close')
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    await dc1.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        senderUserName: 'Alice',
        authCode: 'test-code'
      })
    })

    // 2. Dev 2 connects and requests takeover
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc2.ondatachannel({ channel: dc2 })

    vi.useFakeTimers()
    try {
      await dc2.onmessage({
        data: JSON.stringify({
          type: 'TAKEOVER_REQUEST',
          username: 'Alice',
          userId: 'scout_alice',
          authCode: 'test-code'
        })
      })

      // Dev 1 receives prompt
      expect(dc1.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"TAKEOVER_PROMPT"')
      )

      // Advance 15s timeout
      await vi.advanceTimersByTimeAsync(15000)

      // Dev 1 is kicked with TAKEOVER_TIMEOUT and closed
      expect(dc1.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"SESSION_KICKED"')
      )
      expect(dc1.send).toHaveBeenCalledWith(
        expect.stringContaining('"reason":"TAKEOVER_TIMEOUT"')
      )
      expect(closeSpy1).toHaveBeenCalled()

      // Dev 2 is promoted
      expect(callbacks.onClientConnected).toHaveBeenCalledWith('scout_alice', 'Alice')
    } finally {
      vi.useRealTimers()
    }
  })

  it('Host enforces 30s rate-limiting cooldown on repeated takeover requests', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // Dev 1 connects as Alice
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    await dc1.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        senderUserName: 'Alice',
        authCode: 'test-code'
      })
    })

    // Dev 2 connects and requests takeover first time
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc2.ondatachannel({ channel: dc2 })

    await dc2.onmessage({
      data: JSON.stringify({
        type: 'TAKEOVER_REQUEST',
        username: 'Alice',
        userId: 'scout_alice',
        authCode: 'test-code'
      })
    })

    // Dev 2 immediately spams another TAKEOVER_REQUEST within 30s
    await dc2.onmessage({
      data: JSON.stringify({
        type: 'TAKEOVER_REQUEST',
        username: 'Alice',
        userId: 'scout_alice',
        authCode: 'test-code'
      })
    })

    // Second request is rate limited with rejected: true
    expect(dc2.send).toHaveBeenCalledWith(
      expect.stringContaining('"rejected":true')
    )
  })

  it('Client dispatches onSessionKicked callback when kicked by host', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSessionKicked: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.join('test-code')

    const connectCb = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
    await connectCb?.()

    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc = pc.createDataChannel.mock.results[0].value

    // Host kicks this client
    await dc.onmessage({
      data: JSON.stringify({
        type: 'SESSION_KICKED',
        reason: 'TAKEOVER_PERMITTED'
      })
    })

    expect(callbacks.onSessionKicked).toHaveBeenCalledWith('TAKEOVER_PERMITTED')
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('offline')
  })

  it('probePublicConnectivity throttles repeated checks within 20s window', async () => {
    resetConnectivityProbeCacheForTesting()
    vi.useFakeTimers()
    const origWs = global.WebSocket
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    global.fetch = fetchMock as any
    ;(global as any).WebSocket = undefined
    try {
      vi.setSystemTime(new Date('2026-11-22T12:00:00Z'))

      // 1st call: cold probe cache -> invokes transport once
      const firstResult = await probePublicConnectivity(1000)
      expect(firstResult).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // 2nd call within <20s window -> throttled, does NOT invoke transport again
      await vi.advanceTimersByTimeAsync(19_000)
      const secondResult = await probePublicConnectivity(1000)
      expect(secondResult).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // 3rd call after >20s window -> throttle expired, invokes transport again
      await vi.advanceTimersByTimeAsync(2_000)
      const thirdResult = await probePublicConnectivity(1000)
      expect(thirdResult).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      global.WebSocket = origWs
      vi.useRealTimers()
      resetConnectivityProbeCacheForTesting()
    }
  })

  it('disconnect cleans up all client connections, state, and timers', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_1',
      offer: { type: 'offer', sdp: 'sdp_1' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })

    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const closeSpy = vi.spyOn(pc, 'close')

    service.disconnect()
    expect(closeSpy).toHaveBeenCalled()
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('offline')
    expect(mockMqttClient.unsubscribe).toHaveBeenCalled()
    expect(mockMqttClient.end).toHaveBeenCalled()
  })

  it('iceTimeout timer is cleared when peer is closed', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_1',
      offer: { type: 'offer', sdp: 'sdp_1' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })

    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    
    vi.useFakeTimers()
    try {
      pc.iceConnectionState = 'disconnected'
      await pc.oniceconnectionstatechange()
      expect(callbacks.onStatusChange).toHaveBeenCalledWith('unstable')

      // Close peer before 15s timeout
      pc.close()
      vi.advanceTimersByTime(20000)

      // onDisconnect was not triggered because timer was cleared
      expect(callbacks.onStatusChange).not.toHaveBeenCalledWith('degraded')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops TEAM_TAGS_UPDATE, REQUEST_TAGS_SYNC, TAGS_FULL_SYNC over public MQTT signaling channel (V9)', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onTagUpdateReceived: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // Send forbidden BUSINESS_TYPES over MQTT
    for (const forbiddenType of ['TEAM_TAGS_UPDATE', 'REQUEST_TAGS_SYNC', 'TAGS_FULL_SYNC']) {
      await onMessage('topic', new TextEncoder().encode(JSON.stringify({
        type: forbiddenType,
        sender: 'attacker',
        tag: { id: 't1', tag: 'hack' }
      })))
    }

    expect(callbacks.onTagUpdateReceived).not.toHaveBeenCalled()
  })

  it('Host receives IDENTITY_MIGRATION, triggers callback, sends ACK, and broadcasts to other clients', async () => {
    const onIdentityMigration = vi.fn()
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onIdentityMigration
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    // Simulate 2 clients connecting
    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    
    // Client 1 (Alice)
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_alice',
      offer: { type: 'offer', sdp: 'sdp_1' }
    })))
    // Client 2 (Bob)
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_bob',
      offer: { type: 'offer', sdp: 'sdp_2' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })

    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dc1 = pc1.ondatachannel ? { readyState: 'open', send: vi.fn(), close: vi.fn(), onmessage: null } : null
    const dc2 = pc2.ondatachannel ? { readyState: 'open', send: vi.fn(), close: vi.fn(), onmessage: null } : null

    // Register DataChannels
    pc1.ondatachannel({ channel: dc1 })
    pc2.ondatachannel({ channel: dc2 })

    // Client 1 sends IDENTITY_MIGRATION (Alice -> Alice-88)
    const migrationMsg = {
      type: 'IDENTITY_MIGRATION',
      eventId: 'evt_2026',
      oldScoutId: 'alice_old_uuid',
      newScoutId: 'alice_88_uuid',
      newScoutName: 'Alice-88',
      authCode: 'test-code'
    }

    await dc1.onmessage({ data: JSON.stringify(migrationMsg) })

    // 1. Host callback triggered
    expect(onIdentityMigration).toHaveBeenCalledWith('evt_2026', 'alice_old_uuid', 'alice_88_uuid', 'Alice-88')

    // 2. Host replied ACK_MIGRATION to Client 1
    expect(dc1.send).toHaveBeenCalledWith(expect.stringContaining('"type":"ACK_MIGRATION"'))

    // 3. Host broadcasted IDENTITY_MIGRATION to Client 2
    expect(dc2.send).toHaveBeenCalledWith(expect.stringContaining('"type":"IDENTITY_MIGRATION"'))
    expect(dc2.send).toHaveBeenCalledWith(expect.stringContaining('"newScoutName":"Alice-88"'))
  })

  it('bounds offline direct messages queue to 50 items and drains on reconnect', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    await service.host('test-code')

    // Send 55 direct messages to offline target
    for (let i = 0; i < 55; i++) {
      await service.sendDirectMessage({
        targetId: 'offline_scout',
        title: 'Notice',
        body: `hello_${i}`
      })
    }

    // Now client connects
    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_offline_scout',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })

    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc = { readyState: 'open', send: vi.fn(), close: vi.fn(), onmessage: null as any }
    pc.ondatachannel({ channel: dc })

    // Client sends REQUEST_SYNC identifying as offline_scout
    await dc.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        sinceVersion: 0,
        senderUserId: 'offline_scout',
        senderUserName: 'OfflineScout',
        authCode: 'test-code'
      })
    })

    // Wait for DataChannelSender asynchronous queue to flush
    await vi.waitFor(() => {
      expect(dc.send.mock.calls.filter((call: any) => call[0].includes('DIRECT_MESSAGE')).length).toBe(50)
    })

    // Assert that exactly 50 messages were sent (oldest 5 messages were capped)
    const directSends = dc.send.mock.calls.filter((call: any) => call[0].includes('DIRECT_MESSAGE'))
    expect(directSends.length).toBe(50)
    // First sent message should be hello_5, not hello_0
    expect(directSends[0][0]).toContain('hello_5')
    expect(directSends[49][0]).toContain('hello_54')
  })

  it('Host sends EVENT_METADATA upon peer connection and client promotion', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = trackService(createWebRtcService(callbacks))
    const mockEvent: any = {
      id: 'evt_123',
      name: 'Regional Championship',
      inviteCode: 'test-code',
      hostId: 'host_uuid',
      ftcYear: 2026,
      ftcEventCode: 'CNCMP'
    }
    await service.host('test-code', mockEvent)

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_scout_1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })

    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc = { readyState: 'open', send: vi.fn(), close: vi.fn(), onmessage: null as any, onopen: null as any }
    pc.ondatachannel({ channel: dc })

    if (dc.onopen) dc.onopen()
    await vi.waitFor(() => {
      expect(dc.send.mock.calls.some((call: any) => call[0].includes('EVENT_METADATA'))).toBe(true)
    })

    // Check dc.send was called with EVENT_METADATA
    const eventMetadataSends = dc.send.mock.calls.filter((call: any) => call[0].includes('EVENT_METADATA'))
    expect(eventMetadataSends.length).toBeGreaterThan(0)
    expect(eventMetadataSends[0][0]).toContain('Regional Championship')
    expect(eventMetadataSends[0][0]).toContain('CNCMP')
  })

  it('Client triggers onEventMetadataReceived callback when receiving EVENT_METADATA message', async () => {
    const onEventMetadataReceived = vi.fn()
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onEventMetadataReceived
    }
    const service = createWebRtcService(callbacks)
    await service.join('test-code')

    const connectCb = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
    await connectCb?.()

    // Simulate opening data channel and receiving EVENT_METADATA
    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc = pc.createDataChannel.mock.results[0].value
    await dc.onmessage({
      data: JSON.stringify({
        type: 'EVENT_METADATA',
        event: {
          id: 'evt_official_999',
          name: 'Official World Championship',
          inviteCode: 'test-code',
          hostId: 'host_999'
        },
        authCode: 'test-code'
      })
    })

    expect(onEventMetadataReceived).toHaveBeenCalledWith(expect.objectContaining({
      id: 'evt_official_999',
      name: 'Official World Championship'
    }))
  })

  it('exposes getTransportInfo and triggers onTransportInfoChanged on WebRtcService', async () => {
    const onTransportInfoChanged = vi.fn()
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onTransportInfoChanged
    }
    const service = createWebRtcService(callbacks)
    expect(typeof service.getTransportInfo).toBe('function')
    expect(service.getTransportInfo()).toBeNull()

    // When disconnected, reset transport info is dispatched
    service.disconnect()
    expect(onTransportInfoChanged).toHaveBeenCalledWith(expect.objectContaining({
      type: 'unknown',
      localCandidateType: '',
      remoteCandidateType: ''
    }))
  })

  it('Host allows same user multi-device coexistence without SESSION_CONFLICT and multicasts DIRECT_MESSAGE to ALL devices of targetId', async () => {
    setActivePinia(createPinia())
    const hostService = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onDirectMessageReceived: vi.fn()
    })
    await hostService.host('test-invite')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    // 1. Alice Device 1 (Laptop) connects
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_laptop',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })
    await dc1.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        senderUserName: 'Alice',
        authCode: 'test-invite'
      })
    })

    // 2. Alice Device 2 (Phone) connects with the same userId
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_phone',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc2.ondatachannel({ channel: dc2 })
    await dc2.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        senderUserName: 'Alice',
        authCode: 'test-invite'
      })
    })

    // Verify neither device receives SESSION_CONFLICT and Device 1 stays open
    expect(dc2.send.mock.calls.find((c: any) => String(c[0]).includes('"type":"SESSION_CONFLICT"'))).toBeUndefined()
    expect(dc1.close).not.toHaveBeenCalled()

    // 3. Bob connects as a separate scout
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_bob',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[2]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pcBob = vi.mocked(global.RTCPeerConnection).mock.results[2].value
    const dcBob = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pcBob.ondatachannel({ channel: dcBob })
    await dcBob.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_bob',
        senderUserName: 'Bob',
        authCode: 'test-invite'
      })
    })

    dc1.send.mockClear()
    dc2.send.mockClear()
    dcBob.send.mockClear()

    // 4. Bob sends DIRECT_MESSAGE targeting 'scout_alice' -> Host must forward to BOTH Alice devices, not back to Bob
    const dmMessage = {
      type: 'DIRECT_MESSAGE',
      messageId: 'msg-1001',
      senderId: 'scout_bob',
      senderName: 'Bob',
      targetId: 'scout_alice',
      targetName: 'Alice',
      title: 'Pit check',
      body: 'Please check robot 27570 intake',
      authCode: 'test-invite'
    }
    await dcBob.onmessage({ data: JSON.stringify(dmMessage) })

    const calls1 = dc1.send.mock.calls.map((c: any) => String(c[0]))
    const calls2 = dc2.send.mock.calls.map((c: any) => String(c[0]))
    const callsBob = dcBob.send.mock.calls.map((c: any) => String(c[0]))

    expect(calls1.some((m: string) => m.includes('Please check robot 27570 intake'))).toBe(true)
    expect(calls2.some((m: string) => m.includes('Please check robot 27570 intake'))).toBe(true)
    expect(callsBob.some((m: string) => m.includes('Please check robot 27570 intake'))).toBe(false)

    hostService.disconnect()
  })
})

describe('WebRTC Pit Scouting & Batch Sync Protocol', () => {
  let mockMqttClient: any

  beforeEach(() => {
    vi.clearAllMocks()
    resetDefaultApiMocks()
    clearSecurityStoreForTesting()
    localStorage.clear()
    ;(globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true

    mockMqttClient = {
      subscribe: vi.fn(),
      publish: vi.fn(),
      on: vi.fn(),
      unsubscribe: vi.fn(),
      end: vi.fn()
    }
    vi.mocked(mqtt.connect).mockReturnValue(mockMqttClient as any)
    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createDataChannel: vi.fn().mockReturnValue({ readyState: 'open', send: vi.fn(), close: vi.fn() }),
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      restartIce: vi.fn(),
      close: vi.fn(),
      connectionState: 'connected'
    })) as any
  })

  afterEach(() => {
    delete (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__
    global.fetch = origFetch
    localStorage.clear()
    global.RTCPeerConnection = origRTCPeerConnection
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('dispatches PIT_SCOUT_UPDATE and Host forwards to other connected clients', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onPitScoutUpdateReceived: vi.fn()
    }

    const hostService = createWebRtcService(callbacks)
    await hostService.host('room-pit-1')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    let dc1: any, dc2: any
    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      connectionState: 'connected'
    })) as any

    // Client 1 connects
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn() }
    pc1.ondatachannel({ channel: dc1 })

    // Client 2 connects
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn() }
    pc2.ondatachannel({ channel: dc2 })

    // Client 1 sends PIT_SCOUT_UPDATE
    const pitRecord: any = {
      id: 'p-1',
      eventId: 'evt-1',
      teamNumber: 27570,
      scoutId: 's1',
      scoutName: 'Alice',
      drivetrainType: 'mecanum',
      weightLbs: 38,
      ballCompatibility: 'universal',
      launcherType: '差速双飞轮',
      flowerMechanism: '垂直级联高抬升',
      hasColorSensor: true,
      odometryType: 'two_wheel',
      claimedAutoScore: 60,
      claimedTeleopCycles: 8,
      claimedTeleopScore: 80,
      claimedEndgameScore: 15,
      claimedTotalScore: 155,
      version: 1
    }

    dc1.onmessage({
      data: JSON.stringify({
        type: 'PIT_SCOUT_UPDATE',
        record: pitRecord
      })
    })

    // Host receives record
    expect(callbacks.onPitScoutUpdateReceived).toHaveBeenCalledWith(pitRecord)

    // Host forwards to Client 2 (PIT_SCOUT_UPDATE) and replies ACK to Client 1
    expect(dc2.send).toHaveBeenCalled()
    const forwardedMsg = JSON.parse(dc2.send.mock.calls[0][0])
    expect(forwardedMsg.type).toBe('PIT_SCOUT_UPDATE')
    expect(forwardedMsg.record.teamNumber).toBe(27570)
    expect(dc1.send).toHaveBeenCalledWith(expect.stringContaining('"type":"PIT_SCOUT_ACK"'))

    hostService.disconnect()
  })

  it('dispatches PIT_SCOUT_BATCH_SYNC and Host forwards batch to other connected clients', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onPitScoutBatchSyncReceived: vi.fn()
    }

    const hostService = createWebRtcService(callbacks)
    await hostService.host('room-pit-2')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    let dc1: any, dc2: any
    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      connectionState: 'connected'
    })) as any

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[0]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn() }
    pc1.ondatachannel({ channel: dc1 })

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await vi.waitFor(() => {
      expect(vi.mocked(global.RTCPeerConnection).mock.results[1]?.value?.ondatachannel).toBeTypeOf('function')
    })
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn() }
    pc2.ondatachannel({ channel: dc2 })

    const batchRecords: any[] = [
      { id: 'p-1', eventId: 'evt-1', teamNumber: 27570, version: 2 },
      { id: 'p-2', eventId: 'evt-1', teamNumber: 25787, version: 1 }
    ]

    dc1.onmessage({
      data: JSON.stringify({
        type: 'PIT_SCOUT_BATCH_SYNC',
        records: batchRecords
      })
    })

    expect(callbacks.onPitScoutBatchSyncReceived).toHaveBeenCalledWith(batchRecords, 'client1')
    expect(dc2.send).toHaveBeenCalled()
    const forwarded = JSON.parse(dc2.send.mock.calls[0][0])
    expect(forwarded.type).toBe('PIT_SCOUT_BATCH_SYNC')
    expect(forwarded.records).toHaveLength(2)

    hostService.disconnect()
  })

  it('client automatically schedules reconnection without being deadlocked when disconnected', async () => {
    vi.useFakeTimers()
    try {
      const callbacks = {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn(),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn()
      }

      let clientDc: any
      global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        createDataChannel: vi.fn().mockImplementation(() => {
          clientDc = {
            readyState: 'open',
            send: vi.fn(),
            close: vi.fn()
          }
          return clientDc
        }),
        close: vi.fn(),
        connectionState: 'connected'
      })) as any

      const clientService = createWebRtcService(callbacks)
      await clientService.join('room-reconnect-test')

      // Simulate MQTT connected event so setupClientConnection runs
      const connectCb = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
      await connectCb?.()

      // Simulate connection established
      clientDc.onopen()
      expect(callbacks.onStatusChange).toHaveBeenCalledWith('connected')

      // Simulate unexpected network drop (DataChannel closed, connection state changed)
      const pcInstance = vi.mocked(global.RTCPeerConnection).mock.results[0].value
      pcInstance.connectionState = 'disconnected'
      pcInstance.onconnectionstatechange()
      expect(callbacks.onStatusChange).toHaveBeenCalledWith('unstable')

      clientDc.onclose()

      // Status transitions to connecting to prepare reconnect
      expect(callbacks.onStatusChange).toHaveBeenCalledWith('connecting')

      // Fast-forward delay for reconnection attempt
      await vi.advanceTimersByTimeAsync(3000)

      // Verify RTCPeerConnection was created anew for reconnection (first call on join, second on reconnect)
      expect(vi.mocked(global.RTCPeerConnection).mock.calls.length).toBeGreaterThanOrEqual(2)

      clientService.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('enters standby mode upon discovering an existing host during probe and propagates hostSessionId', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostStandby: vi.fn()
    }

    const hostService = createWebRtcService(callbacks)
    await hostService.host('room-standby-test')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // Simulate another active host announcing heartbeat during probe phase
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_heartbeat',
      hostSessionId: 'active-host-session-12345',
      deviceId: 'dev_host_1',
      timestamp: Date.now()
    })))

    await vi.waitFor(() => {
      expect(callbacks.onHostStandby).toHaveBeenCalledWith({
        hostSessionId: 'active-host-session-12345',
        hostDeviceId: 'dev_host_1'
      })
    })

    hostService.disconnect()
  })
})
