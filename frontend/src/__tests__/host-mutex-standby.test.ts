import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
    createWebRtcTicket: vi.fn().mockImplementation(async (eventId: string, ecdhPublicKey: string) => {
      return { ticket: `ticket_for_${ecdhPublicKey ? ecdhPublicKey.slice(0, 10) : 'dummy'}`, expiresIn: 180 }
    }),
    verifyToken: vi.fn().mockResolvedValue({ valid: true, userId: 'host_id', username: 'HostUser' }),
    verifyWebRtcTicket: vi.fn().mockResolvedValue({ valid: true, userId: 'valid_scout', username: 'Scout' })
  }
})

describe('Host Mutex, Standby Mode & Takeover (双主机互斥与接管)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true;
    (globalThis as any).__TEST_PROBE_MS__ = 50; // Fast probe for unit test
    vi.clearAllMocks()

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
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
    })) as any
  })

  afterEach(() => {
    delete (globalThis as any).__TEST_PROBE_MS__
  })

  it('first device becomes Active Host after silent probe and broadcasts heartbeats', async () => {
    const onHostPromoted = vi.fn()
    const onHostStandby = vi.fn()
    const service1 = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted,
      onHostStandby
    })

    await service1.host('room-ftc-123')

    // Wait for probe to complete
    await new Promise(r => setTimeout(r, 70))

    expect(service1.isStandbyHost()).toBe(false)
    expect(onHostPromoted).toHaveBeenCalled()
    expect(onHostStandby).not.toHaveBeenCalled()

    // Verify host_hello was sent
    const publishCalls = mockMqttClient.publish.mock.calls
    const hasHostHello = publishCalls.some((c: any) => {
      const payloadStr = c[1]?.toString() || ''
      return payloadStr.includes('"type":"host_hello"')
    })
    expect(hasHostHello).toBe(true)

    service1.disconnect()
  })

  it('second device detects existing host heartbeat during silent probe and enters Standby mode', async () => {
    const onHostPromoted = vi.fn()
    const onHostStandby = vi.fn()
    const service2 = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted,
      onHostStandby
    })

    // Start hosting
    await service2.host('room-ftc-123')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    // During silent probe, simulate receiving heartbeat from another host (laptop in pit)
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_heartbeat',
      sender: 'peer_pit_laptop',
      hostSessionId: 'host-pit-laptop-session',
      deviceId: 'dev_laptop_123',
      timestamp: Date.now()
    })))

    await new Promise(r => setTimeout(r, 70))

    expect(service2.isStandbyHost()).toBe(true)
    expect(onHostStandby).toHaveBeenCalledWith(expect.objectContaining({
      hostSessionId: 'host-pit-laptop-session'
    }))
    expect(onHostPromoted).not.toHaveBeenCalled()

    service2.disconnect()
  })

  it('standby host can gracefully take over active host role via takeoverHost()', async () => {
    // 1. Setup Host 1 (Active)
    const host1Demoted = vi.fn()
    const service1 = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostDemoted: host1Demoted
    })
    await service1.host('room-ftc-123')
    await new Promise(r => setTimeout(r, 70))
    expect(service1.isStandbyHost()).toBe(false)

    // 2. Setup Host 2 (Standby)
    const host2Promoted = vi.fn()
    const host2Standby = vi.fn()
    const service2 = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted: host2Promoted,
      onHostStandby: host2Standby
    })

    await service2.host('room-ftc-123')
    const messageCalls = mockMqttClient.on.mock.calls.filter((c: any) => c[0] === 'message')
    const onMessage1 = messageCalls[0]?.[1]
    const onMessage2 = messageCalls[messageCalls.length - 1]?.[1]

    // Service 2 hears Host 1 heartbeat during probe
    onMessage2('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_heartbeat',
      sender: 'peer_host1',
      hostSessionId: 'host1-session-id',
      deviceId: 'dev_host1',
      timestamp: Date.now()
    })))

    await new Promise(r => setTimeout(r, 70))
    expect(service2.isStandbyHost()).toBe(true)

    // 3. Host 2 executes Takeover!
    await service2.takeoverHost()
    expect(service2.isStandbyHost()).toBe(false)
    expect(host2Promoted).toHaveBeenCalled()

    // Host 1 receives the takeover signaling message and is demoted
    onMessage1('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_takeover',
      sender: 'peer_host2',
      oldHostSessionId: 'host1-session-id',
      newHostSessionId: 'host2-session-id',
      deviceId: 'dev_host2'
    })))

    expect(service1.isStandbyHost()).toBe(true)
    expect(host1Demoted).toHaveBeenCalledWith({
      hostSessionId: 'host2-session-id',
      hostDeviceId: 'dev_host2'
    })

    service1.disconnect()
    service2.disconnect()
  })

  it('connected client detects host change from host_hello and initiates reconnect to new host', async () => {
    // 1. Client connects to Host 1 initially
    const onClientStatus = vi.fn()
    const clientService = createWebRtcService({
      onStatusChange: onClientStatus,
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })

    await clientService.join('room-ftc-123')
    const messageCalls = mockMqttClient.on.mock.calls.filter((c: any) => c[0] === 'message')
    const onClientMessage = messageCalls[messageCalls.length - 1]?.[1]
    expect(onClientMessage).toBeDefined()

    // Host 1 sends host_hello
    await onClientMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_hello',
      sender: 'peer_host_1',
      hostSessionId: 'host-session-alpha',
      deviceId: 'dev_host_1'
    })))

    // Now Host 2 takes over and broadcasts host_hello with a different session ID
    mockMqttClient.publish.mockClear()
    await onClientMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_hello',
      sender: 'peer_host_2',
      hostSessionId: 'host-session-beta',
      deviceId: 'dev_host_2'
    })))

    // Await async execution of setupClientConnection
    await new Promise((r) => setTimeout(r, 60))

    // Client should have initiated reconnect (sending client_hello or offer)
    const published = mockMqttClient.publish.mock.calls
    const sentNewHelloOrOffer = published.some((call: any) => {
      const payloadStr = call[1]?.toString() || ''
      return payloadStr.includes('"type":"client_hello"') || payloadStr.includes('"type":"offer"')
    })
    expect(sentNewHelloOrOffer).toBe(true)

    clientService.disconnect()
  })

  it('triggers onActiveHostLeft when active host broadcasts HOST_LEAVING', async () => {
    const onActiveHostLeft = vi.fn()
    const clientService = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onActiveHostLeft
    })

    await clientService.join('room-ftc-123')
    const messageCalls = mockMqttClient.on.mock.calls.filter((c: any) => c[0] === 'message')
    const onClientMessage = messageCalls[messageCalls.length - 1]?.[1]
    expect(onClientMessage).toBeDefined()

    // Active Host broadcasts HOST_LEAVING
    await onClientMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'HOST_LEAVING',
      sender: 'peer_host_1'
    })))

    expect(onActiveHostLeft).toHaveBeenCalled()
    clientService.disconnect()
  })

  it('active host immediately responds with host_heartbeat upon receiving host_probe from probing peer', async () => {
    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })

    await service.host('room-ftc-123')
    await new Promise(r => setTimeout(r, 70))
    expect(service.isStandbyHost()).toBe(false)

    mockMqttClient.publish.mockClear()
    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    // Another peer begins probing and sends host_probe
    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_probe',
      sender: 'peer_incoming_probe',
      hostSessionId: 'probing-session-999',
      deviceId: 'dev_probe_999'
    })))

    const calls = mockMqttClient.publish.mock.calls
    const heartbeatCall = calls.find((c: any) => {
      const payloadStr = c[1]?.toString() || ''
      return payloadStr.includes('"type":"host_heartbeat"')
    })
    expect(heartbeatCall).toBeDefined()

    service.disconnect()
  })

  it('active-active split brain collision automatically demotes losing host session to standby', async () => {
    const onHostDemoted = vi.fn()
    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostDemoted
    })

    await service.host('room-ftc-123')
    await new Promise(r => setTimeout(r, 70))
    expect(service.isStandbyHost()).toBe(false)

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    // Simulate an older winning host (lexicographically smaller session ID: 'host-000-winning')
    // colliding by sending a heartbeat
    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_heartbeat',
      sender: 'peer_winner',
      hostSessionId: 'host-000-winning-session',
      deviceId: 'dev_winner',
      timestamp: Date.now() - 5000
    })))

    // Local host must gracefully yield and enter Standby mode!
    expect(service.isStandbyHost()).toBe(true)
    expect(onHostDemoted).toHaveBeenCalledWith({
      hostSessionId: 'host-000-winning-session',
      hostDeviceId: 'dev_winner'
    })

    service.disconnect()
  })
})
