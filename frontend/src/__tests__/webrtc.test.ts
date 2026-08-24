import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWebRtcService, probePublicConnectivity } from '../services/webrtc'
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
        close: vi.fn(),
        connectionState: 'new',
      }
    }) as any

    global.RTCSessionDescription = vi.fn().mockImplementation((init) => init) as any
    global.RTCIceCandidate = vi.fn().mockImplementation((init) => init) as any
  })

  afterEach(() => {
    vi.clearAllMocks()
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

    await new Promise(r => setTimeout(r, 100))

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

  it('Host extracts authentic identity from JWT and rejects spoofed senderUserId in handshake', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // Attacker holds Alice's token, but attempts to spoof identity as Bob during handshake
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_attacker',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc.ondatachannel({ channel: dc })

    // Attacker lies: senderUserId is claimed as 'scout_bob', but the provided token is signed for 'scout_alice'
    await dc.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_bob',
        senderUserName: 'Bob',
        token: 'valid_jwt_alice',
        authCode: 'test-code'
      })
    })

    // Attacker submits a record under Bob's ID
    const recBob = { id: 'rec_bob_attack', scoutId: 'scout_bob', matchNumber: 1, teamNumber: 27570 }
    await dc.onmessage({
      data: JSON.stringify({
        type: 'SYNC_DATA',
        records: [recBob],
        authCode: 'test-code'
      })
    })

    // Host must NOT accept Bob's record from this connection because JWT verified identity is Alice
    expect(callbacks.onRecordsReceived).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'rec_bob_attack' })]),
      expect.anything()
    )
    expect(dc.send).toHaveBeenCalledWith(expect.stringContaining('"rejectedRecordIds":["rec_bob_attack"]'))
  })

  it('Host completely rejects handshake when invalid or forged JWT token is supplied', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_malicious',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
    const pc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc.ondatachannel({ channel: dc })

    // Malicious user passes fake token with forged signature
    await dc.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_bob',
        senderUserName: 'Bob',
        token: 'forged_fake_signature_token',
        authCode: 'test-code'
      })
    })

    // Handshake should be rejected
    expect(callbacks.onRequestSync).not.toHaveBeenCalled()

    // Subsequent SYNC_DATA is dropped
    await dc.onmessage({
      data: JSON.stringify({
        type: 'SYNC_DATA',
        records: [{ id: 'rec_fake', scoutId: 'scout_bob', matchNumber: 1, teamNumber: 27570 }],
        authCode: 'test-code'
      })
    })
    expect(callbacks.onRecordsReceived).not.toHaveBeenCalled()
    expect(dc.send).toHaveBeenCalledWith(expect.stringContaining('"rejectedRecordIds":["rec_fake"]'))
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

  it('replaces and cleans up obsolete session when client reconnects with new sessionId after JWT auth', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // Session 1 from client_alice
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_alice',
      clientSessionId: 'sess_1',
      offer: { type: 'offer', sdp: 'sdp_1' }
    })))
    await new Promise(r => setTimeout(r, 10))

    const firstPc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const firstCloseSpy = vi.spyOn(firstPc, 'close')
    const firstDc = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    firstPc.ondatachannel({ channel: firstDc })

    // Authenticate Session 1 with valid JWT
    await firstDc.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        senderUserName: 'Alice',
        token: 'valid_jwt_alice',
        authCode: 'test-code'
      })
    })

    // Session 2 from client_alice (reconnect with new session)
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_alice',
      clientSessionId: 'sess_2',
      offer: { type: 'offer', sdp: 'sdp_2' }
    })))
    await new Promise(r => setTimeout(r, 10))

    const secondPc = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const secondDc = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    secondPc.ondatachannel({ channel: secondDc })

    // Before JWT auth, first connection is preserved (two-phase teardown)
    expect(firstCloseSpy).not.toHaveBeenCalled()

    // Authenticate Session 2 with Alice's valid JWT
    await secondDc.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        senderUserName: 'Alice',
        token: 'valid_jwt_alice',
        authCode: 'test-code'
      })
    })

    // Now that Session 2 proved authentic ownership of scout_alice, previous session is cleanly closed
    expect(firstCloseSpy).toHaveBeenCalled()
  })

  it('rejects staged session promotion when valid JWT identity belongs to another scout (anti-DoS sender hijacking)', async () => {
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

    // 1. Legitimate Alice establishes active connection (scout_alice)
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_alice',
      clientSessionId: 'sess_alice_original',
      offer: { type: 'offer', sdp: 'sdp_alice' }
    })))
    await new Promise(r => setTimeout(r, 10))

    const alicePc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const aliceCloseSpy = vi.spyOn(alicePc, 'close')
    const aliceDc = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    alicePc.ondatachannel({ channel: aliceDc })

    await aliceDc.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        token: 'valid_jwt_alice',
        authCode: 'test-code'
      })
    })

    // 2. Malicious peer in same room (Bob, with valid room HMAC and valid token for scout_bob)
    // tries to DoS Alice by sending offer claiming sender: client_alice
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_alice',
      clientSessionId: 'sess_malicious_attacker',
      offer: { type: 'offer', sdp: 'sdp_attacker' }
    })))
    await new Promise(r => setTimeout(r, 10))

    const attackerPc = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const attackerCloseSpy = vi.spyOn(attackerPc, 'close')
    const attackerDc = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    attackerPc.ondatachannel({ channel: attackerDc })

    // Attacker sends REQUEST_SYNC with Bob's OWN VALID JWT token (valid signature for scout_bob)
    await attackerDc.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_bob',
        token: 'valid_jwt_bob',
        authCode: 'test-code'
      })
    })

    // 3. Crucial Assert:
    // Host detects that authenticated identity "scout_bob" does not match bound identity "scout_alice"
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('authenticated identity "scout_bob" does not match existing bound identity "scout_alice". Anti-DoS hijack prevented!')
    )
    // Alice's active connection was NEVER closed!
    expect(aliceCloseSpy).not.toHaveBeenCalled()
    // Attacker's staged connection was immediately torn down!
    expect(attackerCloseSpy).toHaveBeenCalled()

    consoleWarnSpy.mockRestore()
  })

  it('rejects staged session promotion when JWT token signature is forged or invalid', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn(),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-code')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. Legitimate Alice establishes active connection
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_alice',
      clientSessionId: 'sess_alice_original',
      offer: { type: 'offer', sdp: 'sdp_alice' }
    })))
    await new Promise(r => setTimeout(r, 10))

    const alicePc = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const aliceCloseSpy = vi.spyOn(alicePc, 'close')
    const aliceDc = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    alicePc.ondatachannel({ channel: aliceDc })

    await aliceDc.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        token: 'valid_jwt_alice',
        authCode: 'test-code'
      })
    })

    // 2. Malicious peer sends offer claiming sender: client_alice with forged/fake token
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'client_alice',
      clientSessionId: 'sess_malicious_attacker',
      offer: { type: 'offer', sdp: 'sdp_attacker' }
    })))
    await new Promise(r => setTimeout(r, 10))

    const attackerPc = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const attackerDc = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    attackerPc.ondatachannel({ channel: attackerDc })

    await attackerDc.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice',
        token: 'forged_fake_token',
        authCode: 'test-code'
      })
    })

    // 3. Alice's active connection was NEVER closed!
    expect(aliceCloseSpy).not.toHaveBeenCalled()
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
})
