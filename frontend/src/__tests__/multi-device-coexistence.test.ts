import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { createWebRtcService } from '@/services/webrtc'

const mockMqttClient = {
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  publish: vi.fn(),
  on: vi.fn(),
  end: vi.fn()
}

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn().mockImplementation(() => mockMqttClient)
  }
}))

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<any>('@/services/api')
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ valid: true, userId: 'host_id', username: 'HostUser' }),
    verifyWebRtcTicket: vi.fn().mockResolvedValue({ valid: true, userId: 'valid_scout', username: 'Scout' })
  }
})

describe('Multi-Device Concurrent Coexistence (探查端多设备并发共存与多播)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    vi.clearAllMocks()
    let channelCounter = 0
    // Mock RTCPeerConnection
    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      channelCounter++
      return {
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'fake-sdp' }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'fake-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        createDataChannel: vi.fn().mockReturnValue({
          send: vi.fn(),
          close: vi.fn(),
          readyState: 'open',
          onopen: null,
          onclose: null,
          onmessage: null
        }),
        close: vi.fn(),
        connectionState: 'connected',
        iceConnectionState: 'connected',
        onicecandidate: null,
        ondatachannel: null,
        onconnectionstatechange: null,
        oniceconnectionstatechange: null
      }
    }) as any
  })

  it('allows same user to connect simultaneously on two devices without kicking or conflict', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-invite')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    // 1. First device connects as Alice (e.g. Laptop in Pit)
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_laptop',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    await dc1.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice_id',
        senderUserName: 'Alice',
        authCode: 'test-invite'
      })
    })

    // 2. Second device connects as Alice (e.g. Phone in stands) with same userId
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_alice_phone',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc2.ondatachannel({ channel: dc2 })

    await dc2.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'scout_alice_id',
        senderUserName: 'Alice',
        authCode: 'test-invite'
      })
    })

    // VERIFY: Device 2 does NOT receive SAME_USER SESSION_CONFLICT!
    const conflictCall = dc2.send.mock.calls.find((c: any) => c[0].includes('"type":"SESSION_CONFLICT"'))
    expect(conflictCall).toBeUndefined()

    // Device 1 was NOT closed or kicked
    expect(dc1.close).not.toHaveBeenCalled()
    expect(pc1.connectionState).not.toBe('closed')

    // 3. Multicast Direct Message: Host forwards message for target 'scout_alice_id'
    // A teammate sends a direct message to Alice
    const dmMessage = {
      type: 'DIRECT_MESSAGE',
      messageId: 'msg-1001',
      senderId: 'scout_bob_id',
      senderName: 'Bob',
      targetId: 'scout_alice_id',
      targetName: 'Alice',
      title: 'Pit check',
      body: 'Please check robot 27570 intake',
      authCode: 'test-invite'
    }

    await dc1.onmessage({ data: JSON.stringify(dmMessage) })

    // Check that dc1 (laptop) or dc2 (phone) received the forwarded message
    const calls1 = dc1.send.mock.calls.map((c: any) => c[0])
    const calls2 = dc2.send.mock.calls.map((c: any) => c[0])

    const hasMsg1 = calls1.some((m: string) => m.includes('Please check robot 27570 intake'))
    const hasMsg2 = calls2.some((m: string) => m.includes('Please check robot 27570 intake'))

    expect(hasMsg1 || hasMsg2).toBe(true)
  })

  it('still detects DUPLICATE_NAME conflict when a different person uses the same username', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation((recs) => Promise.resolve(recs)),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.host('test-invite')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]

    // 1. User 1 connects as Alice (userId: alice_1)
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_user1',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
    const pc1 = vi.mocked(global.RTCPeerConnection).mock.results[0].value
    const dc1 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc1.ondatachannel({ channel: dc1 })

    await dc1.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'user_alice_1',
        senderUserName: 'Alice',
        authCode: 'test-invite'
      })
    })

    // 2. User 2 (DIFFERENT person, userId: stranger_2) also chooses username "Alice"
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      sender: 'peer_stranger2',
      offer: { type: 'offer', sdp: '...' }
    })))
    await new Promise(r => setTimeout(r, 10))
    const pc2 = vi.mocked(global.RTCPeerConnection).mock.results[1].value
    const dc2 = { send: vi.fn(), readyState: 'open', close: vi.fn(), onmessage: null as any }
    pc2.ondatachannel({ channel: dc2 })

    await dc2.onmessage({
      data: JSON.stringify({
        type: 'REQUEST_SYNC',
        senderUserId: 'stranger_user_2',
        senderUserName: 'Alice',
        authCode: 'test-invite'
      })
    })

    // User 2 MUST be prompted with DUPLICATE_NAME conflict to rename
    expect(dc2.send).toHaveBeenCalledWith(
      expect.stringContaining('"conflictType":"DUPLICATE_NAME"')
    )
    expect(dc2.send).toHaveBeenCalledWith(
      expect.stringContaining('"suggestedName":"Alice-')
    )
  })
})
