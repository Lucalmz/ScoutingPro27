import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { createWebRtcService } from '@/services/webrtc'

const mockMqttClient = {
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  publish: vi.fn(),
  on: vi.fn().mockImplementation((event: string, handler: any) => {
    if (event === 'connect') {
      handler()
    }
  }),
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
    createWebRtcTicket: vi.fn().mockResolvedValue({ ticket: 'test-ticket-mock', expiresIn: 180 }),
    verifyToken: vi.fn().mockResolvedValue({ valid: true, userId: 'host_id', username: 'HostUser' }),
    verifyWebRtcTicket: vi.fn().mockResolvedValue({ valid: true, userId: 'valid_scout', username: 'Scout' })
  }
})

describe('WebRTC Client Handshake Protection against host_hello teardown', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia());
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true;
    (globalThis as any).__TEST_PROBE_MS__ = 50
    vi.clearAllMocks()

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'fake-sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'fake-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      createDataChannel: vi.fn().mockReturnValue({
        readyState: 'connecting',
        send: vi.fn(),
        close: vi.fn()
      }),
      close: vi.fn(),
      connectionState: 'new',
      iceConnectionState: 'new',
      signalingState: 'have-local-offer',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })) as any
  })

  it('preserves connecting peer connection when redundant host_hello arrives from the same host', async () => {
    const clientService = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })

    await clientService.join('room-handshake-test')
    const messageCalls = mockMqttClient.on.mock.calls.filter((c: any) => c[0] === 'message')
    const onClientMessage = messageCalls[messageCalls.length - 1]?.[1]
    expect(onClientMessage).toBeDefined()

    // 1. First host_hello sets up the connection and sends Offer
    await onClientMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_hello',
      sender: 'peer_host_alpha',
      hostSessionId: 'sess-alpha-001',
      deviceId: 'dev_host_alpha'
    })))

    await vi.waitFor(() => {
      const offers = mockMqttClient.publish.mock.calls.filter((c: any) => {
        const payload = c[1]?.toString() || ''
        return payload.includes('"type":"offer"')
      })
      expect(offers.length).toBeGreaterThanOrEqual(1)
    })

    // 2. Host sends redundant host_hello while handshake is in-flight (within 8s window)
    mockMqttClient.publish.mockClear()

    await onClientMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_hello',
      sender: 'peer_host_alpha',
      hostSessionId: 'sess-alpha-001',
      deviceId: 'dev_host_alpha'
    })))

    // Allow any pending microtasks to run
    await new Promise((r) => setTimeout(r, 80))

    // Client must NOT tear down and recreate another offer
    const offersSentRedundant = mockMqttClient.publish.mock.calls.filter((c: any) => {
      const payload = c[1]?.toString() || ''
      return payload.includes('"type":"offer"')
    }).length

    expect(offersSentRedundant).toBe(0)
  })

  it('breaks have-local-offer deadlock and reconnects when host_hello arrives after 8s timeout with dropped offer', async () => {
    let mockNow = 1000000
    const realNow = Date.now
    Date.now = vi.fn(() => mockNow)

    try {
      const clientService = createWebRtcService({
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn().mockResolvedValue([]),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn()
      })

      await clientService.join('room-handshake-timeout-test')
      const messageCalls = mockMqttClient.on.mock.calls.filter((c: any) => c[0] === 'message')
      const onClientMessage = messageCalls[messageCalls.length - 1]?.[1]
      expect(onClientMessage).toBeDefined()

      // 1. First host_hello sets up the connection and sends Offer
      await onClientMessage('topic', new TextEncoder().encode(JSON.stringify({
        type: 'host_hello',
        sender: 'peer_host_alpha',
        hostSessionId: 'sess-alpha-001',
        deviceId: 'dev_host_alpha'
      })))

      await vi.waitFor(() => {
        const offers = mockMqttClient.publish.mock.calls.filter((c: any) => {
          const payload = c[1]?.toString() || ''
          return payload.includes('"type":"offer"')
        })
        expect(offers.length).toBeGreaterThanOrEqual(1)
      })

      // Simulate offer packet dropped by network; 8500ms elapsed
      mockMqttClient.publish.mockClear()
      mockNow += 8500

      // 2. Next host_hello arrives; signalingState is still have-local-offer, but 8s elapsed
      await onClientMessage('topic', new TextEncoder().encode(JSON.stringify({
        type: 'host_hello',
        sender: 'peer_host_alpha',
        hostSessionId: 'sess-alpha-001',
        deviceId: 'dev_host_alpha'
      })))

      await vi.waitFor(() => {
        const offers = mockMqttClient.publish.mock.calls.filter((c: any) => {
          const payload = c[1]?.toString() || ''
          return payload.includes('"type":"offer"')
        })
        // Client breaks the deadlock and sends a new offer
        expect(offers.length).toBeGreaterThanOrEqual(1)
      })
    } finally {
      Date.now = realNow
    }
  })
})
