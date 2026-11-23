import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import mqtt from 'mqtt'
import { createWebRtcService } from '@/services/webrtc'

const { mockMqttClient } = vi.hoisted(() => ({
  mockMqttClient: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    publish: vi.fn(),
    on: vi.fn(),
    end: vi.fn()
  }
}))

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn(() => mockMqttClient)
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

describe('WebRTC Client Session & Handshake Protection', () => {
  const origRtcpc = global.RTCPeerConnection
  const createdServices: Array<{ disconnect: () => void }> = []

  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    ;(globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    ;(globalThis as any).__TEST_PROBE_MS__ = 50
    vi.clearAllMocks()

    vi.mocked(mqtt.connect).mockImplementation(() => mockMqttClient as any)
    mockMqttClient.on.mockImplementation((event: string, handler: any) => {
      if (event === 'connect') {
        handler()
      }
    })

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

  afterEach(() => {
    while (createdServices.length > 0) {
      createdServices.pop()?.disconnect()
    }
    delete (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__
    delete (globalThis as any).__TEST_PROBE_MS__
    global.RTCPeerConnection = origRtcpc
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('preserves connecting peer connection when redundant host_hello arrives from the same host', async () => {
    const clientService = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })
    createdServices.push(clientService)

    await clientService.join('room-handshake-test')
    const messageCalls = mockMqttClient.on.mock.calls.filter((c: any) => c[0] === 'message')
    const onClientMessage = messageCalls[messageCalls.length - 1]?.[1]
    expect(onClientMessage).toBeDefined()

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

    mockMqttClient.publish.mockClear()

    await onClientMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_hello',
      sender: 'peer_host_alpha',
      hostSessionId: 'sess-alpha-001',
      deviceId: 'dev_host_alpha'
    })))

    await flushPromises()

    const offersSentRedundant = mockMqttClient.publish.mock.calls.filter((c: any) => {
      const payload = c[1]?.toString() || ''
      return payload.includes('"type":"offer"')
    }).length

    expect(offersSentRedundant).toBe(0)
  })

  it('breaks have-local-offer deadlock and reconnects when host_hello arrives after 8s timeout with dropped offer', async () => {
    let mockNow = 1000000
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => mockNow)
    try {
      const clientService = createWebRtcService({
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn().mockResolvedValue([]),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn()
      })
      createdServices.push(clientService)

      await clientService.join('room-handshake-timeout-test')
      const messageCalls = mockMqttClient.on.mock.calls.filter((c: any) => c[0] === 'message')
      const onClientMessage = messageCalls[messageCalls.length - 1]?.[1]
      expect(onClientMessage).toBeDefined()

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

      mockMqttClient.publish.mockClear()
      mockNow += 8500

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
    } finally {
      dateNowSpy.mockRestore()
    }
  })
})
