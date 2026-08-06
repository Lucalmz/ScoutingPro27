import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWebRtcService } from '../services/webrtc'
import mqtt from 'mqtt'

vi.mock('mqtt', () => {
  return {
    default: {
      connect: vi.fn()
    }
  }
})

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
      data: JSON.stringify({ type: 'REQUEST_SYNC', authCode: 'wrong-code' })
    })

    expect(callbacks.onRequestSync).not.toHaveBeenCalled()

    dc1.onmessage({
      data: JSON.stringify({ type: 'REQUEST_SYNC', authCode: 'test-code' })
    })

    expect(callbacks.onRequestSync).toHaveBeenCalled()
  })

  it('SYNC_DATA triggers a broadcast to other clients', async () => {
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

    dc1.onmessage({
      data: JSON.stringify({ type: 'SYNC_DATA', records: [{ id: '1' }], authCode: 'test-code' })
    })

    expect(dc1.send).toHaveBeenCalledWith(expect.stringContaining('ACK_SYNC'))
    
    expect(dc2.send).toHaveBeenCalledWith(expect.stringContaining('SYNC_DATA'))
  })
})
