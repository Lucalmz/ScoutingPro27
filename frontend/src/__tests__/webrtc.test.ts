import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createWebRtcService,
  probePublicConnectivity,
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
import mqtt from 'mqtt'




vi.mock('mqtt', () => {
  return {
    default: {
      connect: vi.fn()
    }
  }
})

vi.mock('../services/api', () => ({
  syncRecords: vi.fn().mockResolvedValue(undefined),
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

  beforeEach(() => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
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
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = false
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
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()
    
    const calls: number[] = []
    
    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      return {
        setRemoteDescription: vi.fn().mockImplementation(async () => {
          calls.push(1)
          await new Promise(r => setTimeout(r, 50))
          calls.push(2)
        }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockImplementation(async () => {
          calls.push(3)
          await new Promise(r => setTimeout(r, 10))
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

    await new Promise(r => setTimeout(r, 200))

    expect(calls).toEqual([1, 2, 3, 4])
  })

  it('sendMessage correctly handles targetId (unicast)', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
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
    await new Promise(r => setTimeout(r, 10))
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn() }
    pc1.ondatachannel({ channel: dc1 })

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
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
    const service = createWebRtcService(callbacks)
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
    await new Promise(r => setTimeout(r, 10))
    
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
    const service = createWebRtcService(callbacks)
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
    await new Promise(r => setTimeout(r, 10))
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
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
    expect(syncRecords).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'r1', hostSeq: 1 })]))

    // 验证 ACK 回执中包含 stampedRecords (r1) 以及 rejectedRecordIds (r2)
    expect(dc1.send).toHaveBeenCalledWith(expect.stringContaining('"rejectedRecordIds":["r2"]'))
    const ackPayload = JSON.parse(dc1.send.mock.calls[0][0])
    expect(ackPayload.stampedRecords).toEqual([expect.objectContaining({ id: 'r1', hostSeq: 1, scoutId: 'client1' })])
    
    // 验证仅向 client2 广播了 accepted 记录
    const relayPayload = JSON.parse(dc2.send.mock.calls[0][0])
    expect(relayPayload.records).toEqual([expect.objectContaining({ id: 'r1', hostSeq: 1, scoutId: 'client1' })])
  })

  it('Host rolls back hostSeqCounter and does not broadcast if DB persistence fails', async () => {
    const { syncRecords } = await import('../services/api')
    vi.mocked(syncRecords).mockRejectedValueOnce(new Error('DB Error'))

    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([{ id: 'r1', scoutId: 'client1' }]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
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
    await new Promise(r => setTimeout(r, 10))
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
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
      data: JSON.stringify({ type: 'SYNC_DATA', records: [{ id: 'r1', hostSeq: 5 }] })
    })

    expect(callbacks.onRecordsReceived).toHaveBeenCalled()
    // Client 应落库，但不应向 Host 发送冗余 ACK_SYNC
    expect(dc.send).not.toHaveBeenCalled()
  })

  it('disconnect cleans up peer connections and all internal state maps', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')
    
    service.disconnect()
    expect(mockMqttClient.unsubscribe).toHaveBeenCalled()
    expect(mockMqttClient.end).toHaveBeenCalled()
  })

  it('Host rejects and drops SYNC_DATA records when scoutId does not match sender peer authenticated identity', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. Client 1 (Alice) connects with valid JWT
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
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
        dc.onclose?.()
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
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. First device connects as Alice
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
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
    await new Promise(r => setTimeout(r, 10))
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
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. First device connects as Alice (Pass 1 -> scout_alice_user1)
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_user1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
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
    await new Promise(r => setTimeout(r, 10))
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
      expect.stringContaining('"suggestedName":"Alice-')
    )
  })

  it('Host handles takeover request with permit decision', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onClientConnected: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. Dev 1 connects as Alice
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
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
    await new Promise(r => setTimeout(r, 10))
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
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. Dev 1 connects as Alice
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
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
    await new Promise(r => setTimeout(r, 10))
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
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // Dev 1 connects as Alice
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_dev1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
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
    await new Promise(r => setTimeout(r, 10))
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
    // First call connects
    const firstResult = await probePublicConnectivity(1000)
    expect(firstResult).toBe(true)

    // Second call within 20s window hits cache immediately
    const secondResult = await probePublicConnectivity(1000)
    expect(secondResult).toBe(true)
  })

  it('disconnect cleans up all client connections, state, and timers', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_1',
      offer: { type: 'offer', sdp: 'sdp_1' }
    })))
    await new Promise(r => setTimeout(r, 10))

    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const closeSpy = vi.spyOn(pc, 'close')

    service.disconnect()
    expect(closeSpy).toHaveBeenCalled()
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('offline')
  })

  it('iceTimeout timer is cleared when peer is closed', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_1',
      offer: { type: 'offer', sdp: 'sdp_1' }
    })))
    await new Promise(r => setTimeout(r, 10))

    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    
    vi.useFakeTimers()
    pc.iceConnectionState = 'disconnected'
    await pc.oniceconnectionstatechange()
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('unstable')

    // Close peer before 15s timeout
    pc.close()
    vi.advanceTimersByTime(20000)

    // onDisconnect was not triggered because timer was cleared
    expect(callbacks.onStatusChange).not.toHaveBeenCalledWith('degraded')
    vi.useRealTimers()
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
    const service = createWebRtcService(callbacks)
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
    await new Promise(r => setTimeout(r, 10))

    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dc1 = pc1.ondatachannel ? { readyState: 'open', send: vi.fn(), onmessage: null } : null
    const dc2 = pc2.ondatachannel ? { readyState: 'open', send: vi.fn(), onmessage: null } : null

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
    const service = createWebRtcService(callbacks)
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
    await new Promise(r => setTimeout(r, 10))

    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc = { readyState: 'open', send: vi.fn(), onmessage: null as any }
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
    await new Promise(r => setTimeout(r, 50))

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
    const service = createWebRtcService(callbacks)
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
    await new Promise(r => setTimeout(r, 10))

    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc = { readyState: 'open', send: vi.fn(), onmessage: null as any, onopen: null as any }
    pc.ondatachannel({ channel: dc })

    if (dc.onopen) dc.onopen()
    await new Promise(r => setTimeout(r, 20))

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
})

describe('IPv6 Priority & Transport Diagnostics', () => {
  let mockMqttClient: any

  beforeEach(() => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    mockMqttClient = {
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn(),
      connected: true,
      unsubscribe: vi.fn(),
      end: vi.fn()
    }
    vi.mocked(mqtt.connect).mockReturnValue(mockMqttClient)

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createDataChannel: vi.fn().mockReturnValue({
        send: vi.fn(),
        readyState: 'open',
        close: vi.fn()
      }),
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer-sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      connectionState: 'new'
    })) as any
  })

  afterEach(() => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = false
    vi.clearAllMocks()
  })

  it('configures Cloudflare Anycast STUN as the primary STUN servers', () => {
    const iceServers = STUN_SERVERS.iceServers || []
    expect(iceServers.length).toBeGreaterThanOrEqual(3)
    const firstServer = iceServers[0]
    expect(firstServer.urls).toEqual([
      'stun:stun.cloudflare.com:3478',
      'stun:stun.cloudflare.com:53'
    ])
    // Secondary Google STUN
    expect(iceServers[1].urls).toEqual([
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302'
    ])
  })

  it('correctly validates Global Unicast IPv6 addresses and rejects local/private addresses', () => {
    // China Telecom IPv6
    expect(isGlobalIpv6Address('240e:398:3241:880:c0de::1')).toBe(true)
    // China Unicom IPv6
    expect(isGlobalIpv6Address('2408:8207:7852:12::1')).toBe(true)
    // China Mobile IPv6
    expect(isGlobalIpv6Address('2409:8a00:1000::1')).toBe(true)
    // Cloudflare IPv6
    expect(isGlobalIpv6Address('2606:4700:49::1')).toBe(true)
    // Google IPv6 DNS (valid GUA)
    expect(isGlobalIpv6Address('2001:4860:4860::8888')).toBe(true)

    // Link-local (fe80::/10)
    expect(isGlobalIpv6Address('fe80::1ff:fe00:3a60')).toBe(false)
    expect(isGlobalIpv6Address('fe80:0:0:0:200:f8ff:fe21:67cf')).toBe(false)
    // Unique local ULA (fc00::/7)
    expect(isGlobalIpv6Address('fc00::1')).toBe(false)
    expect(isGlobalIpv6Address('fd12:3456:789a::1')).toBe(false)
    // Multicast (ff00::/8)
    expect(isGlobalIpv6Address('ff02::1')).toBe(false)
    // Teredo tunneling (2001:0000::/32)
    expect(isGlobalIpv6Address('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(false)
    expect(isGlobalIpv6Address('2001::1')).toBe(false)
    // Documentation prefix (2001:db8::/32)
    expect(isGlobalIpv6Address('2001:db8:85a3::8a2e:370:7334')).toBe(false)
    expect(isGlobalIpv6Address('2001:0db8::1')).toBe(false)
    // 6to4 transition prefix (2002::/16)
    expect(isGlobalIpv6Address('2002:cb00:7100:1::1')).toBe(false)
    // NAT64 well-known prefix (64:ff9b::/96)
    expect(isGlobalIpv6Address('64:ff9b::192.0.2.128')).toBe(false)
    // IPv4-mapped (::ffff:0:0/96)
    expect(isGlobalIpv6Address('::ffff:192.0.2.1')).toBe(false)
    // Discard prefix (100::/64)
    expect(isGlobalIpv6Address('100::1')).toBe(false)
    // Loopback
    expect(isGlobalIpv6Address('::1')).toBe(false)
    // Empty / unspecified
    expect(isGlobalIpv6Address('::')).toBe(false)
    // IPv4
    expect(isGlobalIpv6Address('192.168.1.1')).toBe(false)
    expect(isGlobalIpv6Address('')).toBe(false)
  })

  it('identifies valid IPv6 and private IPv4 addresses', () => {
    expect(isIpv6Address('240e:398::1')).toBe(true)
    expect(isIpv6Address('fe80::1')).toBe(true)
    expect(isIpv6Address('192.168.1.1')).toBe(false)

    expect(isPrivateIpv4Address('192.168.1.50')).toBe(true)
    expect(isPrivateIpv4Address('10.0.0.1')).toBe(true)
    expect(isPrivateIpv4Address('172.16.0.1')).toBe(true)
    expect(isPrivateIpv4Address('172.31.255.254')).toBe(true)
    expect(isPrivateIpv4Address('127.0.0.1')).toBe(true)
    expect(isPrivateIpv4Address('1.1.1.1')).toBe(false)
    expect(isPrivateIpv4Address('114.114.114.114')).toBe(false)
  })

  it('optimizes candidate priority according to RFC 8445 for IPv6 hole punching', () => {
    // IPv6 host candidate (default type-pref 126, component 1, local-pref boosted to 65535)
    // priority = 126*16777216 + 65535*256 + 255 = 2130706431
    const ipv6HostCand = 'candidate:1001 1 udp 2122260223 240e:398:3241:880:c0de::1 54321 typ host generation 0'
    const optimizedHost = optimizeCandidatePriority(ipv6HostCand)
    expect(optimizedHost).toContain('candidate:1001 1 udp 2130706431 240e:398:3241:880:c0de::1 54321 typ host generation 0')

    // IPv6 srflx candidate (type-pref 100, component 1, local-pref boosted to 65535)
    // priority = 100*16777216 + 65535*256 + 255 = 1694498815
    const ipv6SrflxCand = 'candidate:1002 1 udp 1686052607 2408:8207:7852:12::1 54322 typ srflx raddr :: rport 0 generation 0'
    const optimizedSrflx = optimizeCandidatePriority(ipv6SrflxCand)
    expect(optimizedSrflx).toContain('candidate:1002 1 udp 1694498815 2408:8207:7852:12::1 54322 typ srflx raddr :: rport 0 generation 0')

    // IPv4 host candidate remains unchanged
    const ipv4HostCand = 'candidate:1003 1 udp 2122260223 192.168.1.100 54323 typ host generation 0'
    expect(optimizeCandidatePriority(ipv4HostCand)).toBe(ipv4HostCand)

    // IPv6 Link-local candidate remains unchanged
    const fe80Cand = 'candidate:1004 1 udp 2122260223 fe80::1 54324 typ host generation 0'
    expect(optimizeCandidatePriority(fe80Cand)).toBe(fe80Cand)
  })

  it('optimizes SDP by rewriting candidate lines for IPv6 priority', () => {
    const sdp = [
      'v=0',
      'o=- 12345 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host',
      'a=candidate:2 1 udp 2122260223 240e:398:1::1 50001 typ host',
      'a=candidate:3 1 udp 1686052607 240e:398:1::1 50002 typ srflx raddr :: rport 0',
      'a=end-of-candidates'
    ].join('\r\n')

    const optimized = optimizeSdpCandidates(sdp)
    const lines = optimized.split('\r\n')

    expect(lines[0]).toBe('v=0')
    // IPv4 host line untouched
    expect(lines[4]).toBe('a=candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host')
    // IPv6 host line priority boosted to 2130706431
    expect(lines[5]).toBe('a=candidate:2 1 udp 2130706431 240e:398:1::1 50001 typ host')
    // IPv6 srflx line priority boosted to 1694498815
    expect(lines[6]).toBe('a=candidate:3 1 udp 1694498815 240e:398:1::1 50002 typ srflx raddr :: rport 0')
    expect(lines[7]).toBe('a=end-of-candidates')
  })

  it('sorts candidates placing IPv6 candidates ahead of IPv4 and relay', () => {
    const list = [
      { candidate: 'candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host' },
      { candidate: 'candidate:2 1 udp 1000 1.2.3.4 50001 typ relay' },
      { candidate: 'candidate:3 1 udp 1686052607 240e:398::1 50002 typ srflx raddr :: rport 0' },
      { candidate: 'candidate:4 1 udp 2122260223 240e:398::1 50003 typ host' },
      { candidate: 'candidate:5 1 udp 1686052607 114.114.114.114 50004 typ srflx raddr 192.168.1.10 rport 50000' }
    ]

    const sorted = sortCandidatesPreferIpv6(list)
    expect(sorted[0].candidate).toContain('240e:398::1 50003 typ host')
    expect(sorted[1].candidate).toContain('240e:398::1 50002 typ srflx')
    expect(sorted[2].candidate).toContain('192.168.1.10 50000 typ host')
    expect(sorted[3].candidate).toContain('114.114.114.114 50004 typ srflx')
    expect(sorted[4].candidate).toContain('typ relay')
  })

  it('accurately classifies connection transport type', () => {
    // IPv6 Global Unicast Direct
    expect(classifyCandidatePair('host', 'host', '240e:398::1', '2408:8207::2')).toBe('ipv6_p2p')
    expect(classifyCandidatePair('srflx', 'host', '240e:398::1', '192.168.1.1')).toBe('ipv6_p2p')

    // LAN Direct
    expect(classifyCandidatePair('host', 'host', '192.168.1.100', '192.168.1.101')).toBe('lan_p2p')
    expect(classifyCandidatePair('host', 'host', '10.0.0.2', '10.0.0.3')).toBe('lan_p2p')

    // NAT hole punched
    expect(classifyCandidatePair('srflx', 'srflx', '114.114.114.114', '223.5.5.5')).toBe('nat_p2p')
    expect(classifyCandidatePair('host', 'srflx', '192.168.1.100', '223.5.5.5')).toBe('nat_p2p')

    // Relay
    expect(classifyCandidatePair('relay', 'host', '162.159.207.1', '192.168.1.100')).toBe('relay')
    expect(classifyCandidatePair('host', 'relay', '240e:398::1', '162.159.207.1')).toBe('relay')
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

  it('enforces mandatory HMAC verification in production mode (drops unsigned or tampered messages)', async () => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = false

    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    const room = 'SECURE_ROOM_999'
    await service.host(room)

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 1. Send message without signature -> should be dropped
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_attacker',
      offer: { type: 'offer', sdp: 'fake-sdp' },
      timestamp: Date.now(),
      nonce: generateNonce()
    })))

    await new Promise(r => setTimeout(r, 20))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing mandatory HMAC signature'))
    expect(vi.mocked(global.RTCPeerConnection)).not.toHaveBeenCalled()

    // 2. Send message with forged / invalid signature -> should be dropped
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_attacker',
      offer: { type: 'offer', sdp: 'fake-sdp' },
      timestamp: Date.now(),
      nonce: generateNonce(),
      signature: 'deadbeef1234567890'
    })))

    await new Promise(r => setTimeout(r, 20))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid HMAC signature'))
    expect(vi.mocked(global.RTCPeerConnection)).not.toHaveBeenCalled()

    // 3. Send message with legitimate signature derived from room inviteCode -> accepted!
    const hmacKey = await deriveHmacKey(room)
    const legitPayload: any = {
      sender: 'client_legit',
      offer: { type: 'offer', sdp: 'valid-sdp' },
      timestamp: Date.now(),
      nonce: generateNonce(),
      ecdhPublicKey: '04legit123',
      token: 'valid_jwt_alice'
    }
    legitPayload.signature = await signSignalingPayload(hmacKey, legitPayload)

    onMessage('topic', new TextEncoder().encode(JSON.stringify(legitPayload)))
    await new Promise(r => setTimeout(r, 30))
    expect(vi.mocked(global.RTCPeerConnection)).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('gracefully handles malformed candidate and SDP strings without throwing (defensive rewriting)', () => {
    // Malformed candidate strings
    expect(optimizeCandidatePriority('')).toBe('')
    expect(optimizeCandidatePriority('candidate:invalid')).toBe('candidate:invalid')
    expect(optimizeCandidatePriority(null as any)).toBe(null)

    // Malformed / non-standard SDP
    expect(optimizeSdpCandidates('')).toBe('')
    expect(optimizeSdpCandidates('corrupted sdp string without candidates')).toBe('corrupted sdp string without candidates')
    expect(optimizeSdpCandidates(null as any)).toBe(null)
  })
})

describe('WebRTC Security Hardening & SAS Gating (v2)', () => {
  let mockMqttClient: any

  beforeEach(async () => {
    await clearSecurityStoreForTesting();
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    mockMqttClient = {
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn(),
      connected: true,
      unsubscribe: vi.fn(),
      end: vi.fn()
    }
    vi.mocked(mqtt.connect).mockReturnValue(mockMqttClient)
  })

  afterEach(() => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = false
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('client offer does not transmit plaintext auth token in outer MQTT envelope', async () => {
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', username: 'Alice', token: 'secret_jwt_alice' }))
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
    await new Promise(r => setTimeout(r, 30))

    // Check message published via signaling
    expect(mockMqttClient.publish).toHaveBeenCalled()
    const publishCalls = mockMqttClient.publish.mock.calls
    for (const call of publishCalls) {
      const payloadStr = call[1]
      const payload = JSON.parse(payloadStr)
      // Check that token is NOT present on outer MQTT envelope
      expect(payload.token).toBeUndefined()
    }
    service.disconnect()
  })

  it('rejects offer when ticket pkHash does not match actual ecdhPublicKey (replay attack prevention)', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    const aliceKeys = await generateEcdhKeyPair()
    const alicePubHex = await exportEcdhPublicKey(aliceKeys.publicKey)
    const eveKeys = await generateEcdhKeyPair()
    const evePubHex = await exportEcdhPublicKey(eveKeys.publicKey)

    // Attacker Eve presents Alice's ticket but with Eve's key: evePubHex
    const tamperedOfferPayload = {
      sender: 'client_attacker_eve',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: `ticket_for_${alicePubHex.slice(0, 10)}` // Alice's ticket
      },
      ecdhPublicKey: evePubHex, // Eve's key
      clientSessionId: 'sess-eve-1'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(tamperedOfferPayload)))
    await new Promise(r => setTimeout(r, 50))

    // Verification failed on backend, so SAS verification should NOT be called
    expect(callbacks.onSasVerificationRequired).not.toHaveBeenCalled()
    service.disconnect()
  })

  it('TOFU auto-trusts first-seen peer without requiring manual confirmation modal', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasVerified: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    let channelMessageHandler: any
    let channelSendMock = vi.fn()
    const mockDc = {
      readyState: 'open',
      send: channelSendMock,
      close: vi.fn(),
      set onmessage(fn: any) { channelMessageHandler = fn },
      get onmessage() { return channelMessageHandler }
    }

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      connectionState: 'connected',
      iceConnectionState: 'connected',
      set ondatachannel(fn: any) {
        setTimeout(() => fn({ channel: mockDc }), 10)
      }
    })) as any

    const bobKeys = await generateEcdhKeyPair()
    const bobPubHex = await exportEcdhPublicKey(bobKeys.publicKey)

    const firstSeenOffer = {
      sender: 'peer_first_seen_bob',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: `ticket_for_${bobPubHex.slice(0, 10)}`
      },
      ecdhPublicKey: bobPubHex,
      deviceId: 'dev_bob_ipad',
      clientSessionId: 'sess-bob-1'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(firstSeenOffer)))
    await new Promise(r => setTimeout(r, 60))

    // Under TOFU, baseline trust is established automatically without modal interruption
    expect(callbacks.onSasVerificationRequired).not.toHaveBeenCalled()
    expect(service.getSasState('peer_first_seen_bob')).toBe('VERIFIED')

    service.disconnect()
  })

  it('DataChannel blocks outgoing and incoming business messages before SAS is verified, and flushes after confirmSas', async () => {
    // Pre-seed Alice's device with an older key to trigger KEY_ROTATION_ALERT
    await savePeerTrustRecord({
      eventId: 'test-code',
      userId: 'scout_alice',
      username: 'Alice',
      deviceId: 'device_default',
      publicKeyHex: '04old_alice_key',
      firstSeenAt: Date.now() - 10000,
      lastSeenAt: Date.now() - 10000,
      trustedAt: Date.now() - 10000,
      trustLevel: 'TOFU_TRUSTED'
    })

    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasVerified: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    let channelMessageHandler: any
    let channelSendMock = vi.fn()
    const mockDc = {
      readyState: 'open',
      send: channelSendMock,
      close: vi.fn(),
      set onmessage(fn: any) { channelMessageHandler = fn },
      get onmessage() { return channelMessageHandler }
    }

    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      let dcHandler: any
      return {
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'sdp' }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        connectionState: 'connected',
        iceConnectionState: 'connected',
        set ondatachannel(fn: any) {
          dcHandler = fn
          setTimeout(() => fn({ channel: mockDc }), 10)
        }
      }
    }) as any

    const aliceKeys = await generateEcdhKeyPair()
    const alicePubHex = await exportEcdhPublicKey(aliceKeys.publicKey)

    // Legitimate offer from Alice (with rotated key)
    const legitOffer = {
      sender: 'peer_alice',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: `ticket_for_${alicePubHex.slice(0, 10)}`
      },
      ecdhPublicKey: alicePubHex,
      clientSessionId: 'sess-alice-1'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(legitOffer)))
    await new Promise(r => setTimeout(r, 60))

    // Host detected key rotation for device_default and requested SAS verification modal
    expect(callbacks.onSasVerificationRequired).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: 'peer_alice' }),
      expect.any(String)
    )
    expect(service.getSasState('peer_alice')).toBe('PENDING_VERIFICATION')

    // 1. Peer sends incoming sync request message over DataChannel
    channelMessageHandler({
      data: JSON.stringify({ type: 'REQUEST_SYNC', authCode: 'test-code', sinceVersion: 0 })
    })

    // Because SAS is pending, onRequestSync must NOT be dispatched!
    expect(callbacks.onRequestSync).not.toHaveBeenCalled()

    // 2. Host tries to send message over DataChannel to peer_alice
    await service.sendMessage({
      type: 'TEAM_TAGS_UPDATE',
      eventId: 'evt1',
      teamNumber: 27570,
      action: 'ADD',
      tag: { eventId: 'evt1', teamNumber: 27570, tag: 'Leader' } as any
    }, 'peer_alice')

    // Underlying dc.send should NOT have been called!
    expect(channelSendMock).not.toHaveBeenCalled()

    // 3. User confirms SAS!
    service.confirmSas('peer_alice')

    // State becomes VERIFIED
    expect(service.getSasState('peer_alice')).toBe('VERIFIED')
    expect(callbacks.onSasVerified).toHaveBeenCalledWith('peer_alice')

    // Queued incoming message is dispatched!
    expect(callbacks.onRequestSync).toHaveBeenCalledWith(0, 'peer_alice')

    // Queued outgoing message is sent!
    expect(channelSendMock).toHaveBeenCalled()
    expect(channelSendMock).toHaveBeenCalledWith(expect.stringContaining('TEAM_TAGS_UPDATE'))

    service.disconnect()
  })

  it('DataChannel purges queues and terminates connection immediately upon rejectSas', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasRejected: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    let channelMessageHandler: any
    let closeMock = vi.fn()
    const mockDc = {
      readyState: 'open',
      send: vi.fn(),
      close: closeMock,
      set onmessage(fn: any) { channelMessageHandler = fn },
      get onmessage() { return channelMessageHandler }
    }

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createDataChannel: vi.fn().mockReturnValue(mockDc),
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      restartIce: vi.fn(),
      close: closeMock,
      connectionState: 'connected',
      iceConnectionState: 'connected',
      set ondatachannel(fn: any) {
        setTimeout(() => fn({ channel: mockDc }), 10)
      }
    })) as any

    // Pre-seed historical record to trigger KEY_ROTATION_ALERT
    await savePeerTrustRecord({
      eventId: 'test-code',
      userId: 'scout_alice',
      username: 'Alice',
      deviceId: 'device_default',
      publicKeyHex: '04old_key_for_rotation',
      firstSeenAt: Date.now() - 10000,
      lastSeenAt: Date.now() - 10000,
      trustedAt: Date.now() - 10000,
      trustLevel: 'TOFU_TRUSTED'
    })

    const bobKeys = await generateEcdhKeyPair()
    const bobPubHex = await exportEcdhPublicKey(bobKeys.publicKey)

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_bob',
      offer: { type: 'offer', sdp: 'sdp', ticket: `ticket_for_${bobPubHex.slice(0, 10)}` },
      ecdhPublicKey: bobPubHex,
      clientSessionId: 'sess-bob-1'
    })))
    await new Promise(r => setTimeout(r, 60))

    expect(service.getSasState('peer_bob')).toBe('PENDING_VERIFICATION')

    // User rejects SAS
    service.rejectSas('peer_bob', 'Security code mismatch')

    expect(service.getSasState('peer_bob')).toBe('REJECTED')
    expect(callbacks.onSasRejected).toHaveBeenCalledWith('peer_bob', 'Security code mismatch')
    expect(closeMock).toHaveBeenCalled()

    service.disconnect()
  })

  it('ICE watchdog notifies stall at 3500ms and triggers restartIce up to 2 times', async () => {
    vi.useFakeTimers()
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onIceStalled: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.join('test-code')

    const connectCb = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
    await connectCb?.()

    // Get the RTCPeerConnection instance created for client
    const pcInstance = vi.mocked(global.RTCPeerConnection).mock.results[0]?.value
    expect(pcInstance).toBeDefined()
    pcInstance.restartIce = vi.fn()

    // Simulate ICE state entering 'checking'
    pcInstance.iceConnectionState = 'checking'
    pcInstance.oniceconnectionstatechange()

    // Advance 3500ms -> should alert stall
    vi.advanceTimersByTime(3500)
    expect(callbacks.onIceStalled).toHaveBeenCalledWith(true)

    // Advance to 5500ms -> restartIce attempt 1
    await vi.advanceTimersByTimeAsync(2000)
    expect(pcInstance.restartIce).toHaveBeenCalledTimes(1)

    // Advance another 5500ms -> restartIce attempt 2
    pcInstance.iceConnectionState = 'checking'
    pcInstance.oniceconnectionstatechange()
    await vi.advanceTimersByTimeAsync(5500)
    expect(pcInstance.restartIce).toHaveBeenCalledTimes(2)

    // Simulate ICE recovering to 'connected'
    pcInstance.iceConnectionState = 'connected'
    pcInstance.oniceconnectionstatechange()
    expect(callbacks.onIceStalled).toHaveBeenCalledWith(false)

    service.disconnect()
    vi.useRealTimers()
  })

  it('ICE watchdog actively tears down connection and rebuilds RTCPeerConnection with iceTransportPolicy: "relay" when restart attempts exceed 2', async () => {
    vi.useFakeTimers()
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onIceStalled: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.join('test-code')

    const connectCb = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'connect')?.[1]
    await connectCb?.()

    // 1st PeerConnection created with default 'all' policy
    const firstCallConfig = vi.mocked(global.RTCPeerConnection).mock.calls[0]?.[0]
    expect(firstCallConfig?.iceTransportPolicy).toBe('all')

    const pcInstance = vi.mocked(global.RTCPeerConnection).mock.results[0]?.value
    expect(pcInstance).toBeDefined()

    // Attempt 1 at 5500ms
    pcInstance.iceConnectionState = 'checking'
    pcInstance.oniceconnectionstatechange()
    await vi.advanceTimersByTimeAsync(5500)
    expect(pcInstance.restartIce).toHaveBeenCalledTimes(1)

    // Attempt 2 at 5500ms
    pcInstance.iceConnectionState = 'checking'
    pcInstance.oniceconnectionstatechange()
    await vi.advanceTimersByTimeAsync(5500)
    expect(pcInstance.restartIce).toHaveBeenCalledTimes(2)

    // Exceeding 2 attempts -> Watchdog actively triggers relay-only fallback
    pcInstance.iceConnectionState = 'checking'
    pcInstance.oniceconnectionstatechange()
    await vi.advanceTimersByTimeAsync(5500)

    // Verify a new RTCPeerConnection was instantiated with iceTransportPolicy: 'relay'
    const calls = vi.mocked(global.RTCPeerConnection).mock.calls
    expect(calls.length).toBeGreaterThan(1)
    const lastCallConfig = calls[calls.length - 1]?.[0]
    expect(lastCallConfig?.iceTransportPolicy).toBe('relay')

    service.disconnect()
    vi.useRealTimers()
  })

  it('Scheme B: Cross-machine peer with foreign signature falls back to ECDH + SAS + TOFU without dropping offer', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasVerified: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    let channelMessageHandler: any
    let channelSendMock = vi.fn()
    const mockDc = {
      readyState: 'open',
      send: channelSendMock,
      close: vi.fn(),
      set onmessage(fn: any) { channelMessageHandler = fn },
      get onmessage() { return channelMessageHandler }
    }

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      connectionState: 'connected',
      iceConnectionState: 'connected',
      set ondatachannel(fn: any) {
        setTimeout(() => fn({ channel: mockDc }), 10)
      }
    })) as any

    const charlieKeys = await generateEcdhKeyPair()
    const charliePubHex = await exportEcdhPublicKey(charlieKeys.publicKey)

    const foreignOffer = {
      sender: 'peer_charlie_laptop',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: 'cross_machine_foreign_ticket' // Signed by foreign backend with different secret
      },
      ecdhPublicKey: charliePubHex,
      deviceId: 'dev_charlie_thinkpad',
      clientSessionId: 'sess-charlie-1'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(foreignOffer)))
    await new Promise(r => setTimeout(r, 60))

    // Scheme B: Offer was NOT dropped! It fell back to SAS verification modal
    expect(callbacks.onSasVerificationRequired).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: 'peer_charlie_laptop' }),
      expect.any(String)
    )
    expect(service.getSasState('peer_charlie_laptop')).toBe('PENDING_VERIFICATION')

    // Host confirms SAS
    service.confirmSas('peer_charlie_laptop')
    expect(service.getSasState('peer_charlie_laptop')).toBe('VERIFIED')
    expect(callbacks.onSasVerified).toHaveBeenCalledWith('peer_charlie_laptop')

    // Now test reconnection from same device & key: TOFU recognizes it as TRUSTED_MATCH
    callbacks.onSasVerificationRequired.mockClear()
    const reconnectOffer = {
      sender: 'peer_charlie_laptop',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: 'cross_machine_foreign_ticket'
      },
      ecdhPublicKey: charliePubHex,
      deviceId: 'dev_charlie_thinkpad',
      clientSessionId: 'sess-charlie-2'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(reconnectOffer)))
    await new Promise(r => setTimeout(r, 60))

    // Automatically trusted via TOFU IndexedDB cache without requiring SAS modal again!
    expect(callbacks.onSasVerificationRequired).not.toHaveBeenCalled()
    expect(service.getSasState('peer_charlie_laptop')).toBe('VERIFIED')

    service.disconnect()
  })

  it('Scheme B: Replay or key-tampering attacks are strictly rejected without fallback', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired: vi.fn(),
      onSasVerified: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    const eveKeys = await generateEcdhKeyPair()
    const evePubHex = await exportEcdhPublicKey(eveKeys.publicKey)

    // Attacker Eve presents Alice's ticket with Eve's key (triggering public key hash mismatch)
    const tamperedOffer = {
      sender: 'peer_eve_tampered',
      offer: {
        type: 'offer',
        sdp: 'offer-sdp',
        ticket: 'tampered_ticket_triggering_mismatch'
      },
      ecdhPublicKey: evePubHex,
      deviceId: 'dev_eve_tamper',
      clientSessionId: 'sess-eve-tamper'
    }

    onMessage('topic', new TextEncoder().encode(JSON.stringify(tamperedOffer)))
    await new Promise(r => setTimeout(r, 60))

    // Must be completely rejected: no SAS prompt, state is REJECTED
    expect(callbacks.onSasVerificationRequired).not.toHaveBeenCalled()
    expect(service.getSasState('peer_eve_tampered')).toBe('REJECTED')

    service.disconnect()
  })
})

describe('WebRTC Pit Scouting & Batch Sync Protocol', () => {
  let mockMqttClient: any

  beforeEach(() => {
    vi.clearAllMocks()
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
    await new Promise(r => setTimeout(r, 10))
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn() }
    pc1.ondatachannel({ channel: dc1 })

    // Client 2 connects
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
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
      sizingPassed: true,
      mechanismType: '',
      hangType: '',
      odometryType: '',
      claimedAutoScore: 60,
      claimedAutoPieces: 3,
      claimedAutoHangLevel: 1,
      claimedTeleopScore: 80,
      claimedTeleopCycleSec: 8,
      claimedEndgameHangLevel: 2,
      claimedEndgameTimeSec: 5,
      claimedTotalScore: 140,
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

    // Host forwards to Client 2 (but NOT back to Client 1)
    expect(dc2.send).toHaveBeenCalled()
    const forwardedMsg = JSON.parse(dc2.send.mock.calls[0][0])
    expect(forwardedMsg.type).toBe('PIT_SCOUT_UPDATE')
    expect(forwardedMsg.record.teamNumber).toBe(27570)
    expect(dc1.send).not.toHaveBeenCalled()

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
    await new Promise(r => setTimeout(r, 10))
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn() }
    pc1.ondatachannel({ channel: dc1 })

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
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

    vi.useRealTimers()
    clientService.disconnect()
  })
})



