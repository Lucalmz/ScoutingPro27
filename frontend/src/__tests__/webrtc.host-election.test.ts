import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import mqtt from 'mqtt'
import { createWebRtcService } from '@/services/webrtc'

const realSetTimeout = globalThis.setTimeout
const realDateNow = Date.now

async function waitForMockPublish(
  predicate: () => unknown,
  maxWaitMs = 500
): Promise<void> {
  const deadline = realDateNow() + maxWaitMs
  for (let i = 0; i < 20; i++) {
    if (predicate()) return
    await flushPromises()
  }
  while (!predicate() && realDateNow() < deadline) {
    await new Promise((resolve) => realSetTimeout(resolve, 2))
    await flushPromises()
  }
}

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
    createWebRtcTicket: vi.fn().mockImplementation(async (_eventId: string, ecdhPublicKey: string) => ({
      ticket: `ticket_for_${ecdhPublicKey ? ecdhPublicKey.slice(0, 10) : 'dummy'}`,
      expiresIn: 180
    })),
    verifyToken: vi.fn().mockResolvedValue({ valid: true, userId: 'host_id', username: 'HostUser' }),
    verifyWebRtcTicket: vi.fn().mockResolvedValue({ valid: true, userId: 'valid_scout', username: 'Scout' })
  }
})

describe('Host Mutex, Standby Mode & Takeover (双主机互斥与接管)', () => {
  const origRtcpc = global.RTCPeerConnection
  const createdServices: Array<{ disconnect: () => void }> = []

  beforeEach(() => {
    vi.useFakeTimers()
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
    while (createdServices.length > 0) {
      createdServices.pop()?.disconnect()
    }
    delete (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__
    delete (globalThis as any).__TEST_PROBE_MS__
    global.RTCPeerConnection = origRtcpc
    vi.useRealTimers()
    localStorage.clear()
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
    createdServices.push(service1)

    await service1.host('room-ftc-123')
    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()

    expect(service1.isStandbyHost()).toBe(false)
    expect(onHostPromoted).toHaveBeenCalled()
    expect(onHostStandby).not.toHaveBeenCalled()
    const findHostHello = () =>
      mockMqttClient.publish.mock.calls.some((c: any) => {
        const payloadStr = c[1]?.toString() || ''
        return payloadStr.includes('"type":"host_hello"')
      })
    await waitForMockPublish(findHostHello)
    expect(findHostHello()).toBe(true)
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
    createdServices.push(service2)

    await service2.host('room-ftc-123')

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_heartbeat',
      sender: 'peer_pit_laptop',
      hostSessionId: 'host-pit-laptop-session',
      deviceId: 'dev_laptop_123',
      timestamp: Date.now()
    })))

    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()

    expect(service2.isStandbyHost()).toBe(true)
    expect(onHostStandby).toHaveBeenCalledWith(expect.objectContaining({
      hostSessionId: 'host-pit-laptop-session'
    }))
    expect(onHostPromoted).not.toHaveBeenCalled()
  })

  it('standby host can gracefully take over active host role via takeoverHost()', async () => {
    const host1Demoted = vi.fn()
    const service1 = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostDemoted: host1Demoted
    })
    createdServices.push(service1)
    await service1.host('room-ftc-123')
    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()
    expect(service1.isStandbyHost()).toBe(false)

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
    createdServices.push(service2)

    await service2.host('room-ftc-123')
    const messageCalls = mockMqttClient.on.mock.calls.filter((c: any) => c[0] === 'message')
    const onMessage1 = messageCalls[0]?.[1]
    const onMessage2 = messageCalls[messageCalls.length - 1]?.[1]

    onMessage2('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_heartbeat',
      sender: 'peer_host1',
      hostSessionId: 'host1-session-id',
      deviceId: 'dev_host1',
      timestamp: Date.now()
    })))

    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()
    expect(service2.isStandbyHost()).toBe(true)

    await service2.takeoverHost()
    expect(service2.isStandbyHost()).toBe(false)
    expect(host2Promoted).toHaveBeenCalled()

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
  })

  it('connected client detects host change from host_hello and initiates reconnect to new host', async () => {
    const clientService = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })
    createdServices.push(clientService)

    await clientService.join('room-ftc-123')
    const messageCalls = mockMqttClient.on.mock.calls.filter((c: any) => c[0] === 'message')
    const onClientMessage = messageCalls[messageCalls.length - 1]?.[1]
    expect(onClientMessage).toBeDefined()

    await onClientMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_hello',
      sender: 'peer_host_1',
      hostSessionId: 'host-session-alpha',
      deviceId: 'dev_host_1'
    })))
    await flushPromises()

    mockMqttClient.publish.mockClear()
    await onClientMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_hello',
      sender: 'peer_host_2',
      hostSessionId: 'host-session-beta',
      deviceId: 'dev_host_2'
    })))

    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()

    const findNewHelloOrOffer = () =>
      mockMqttClient.publish.mock.calls.some((call: any) => {
        const payloadStr = call[1]?.toString() || ''
        return payloadStr.includes('"type":"client_hello"') || payloadStr.includes('"type":"offer"')
      })
    await waitForMockPublish(findNewHelloOrOffer)
    expect(findNewHelloOrOffer()).toBe(true)
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
    createdServices.push(clientService)

    await clientService.join('room-ftc-123')
    const messageCalls = mockMqttClient.on.mock.calls.filter((c: any) => c[0] === 'message')
    const onClientMessage = messageCalls[messageCalls.length - 1]?.[1]
    expect(onClientMessage).toBeDefined()

    await onClientMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'HOST_LEAVING',
      sender: 'peer_host_1'
    })))

    expect(onActiveHostLeft).toHaveBeenCalled()
  })

  it('active host immediately responds with host_heartbeat upon receiving host_probe from probing peer', async () => {
    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })
    createdServices.push(service)

    await service.host('room-ftc-123')
    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()
    expect(service.isStandbyHost()).toBe(false)

    mockMqttClient.publish.mockClear()
    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    await onMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_probe',
      sender: 'peer_incoming_probe',
      hostSessionId: 'probing-session-999',
      deviceId: 'dev_probe_999'
    })))

    const findHeartbeatCall = () =>
      mockMqttClient.publish.mock.calls.find((c: any) => {
        const payloadStr = c[1]?.toString() || ''
        return payloadStr.includes('"type":"host_heartbeat"')
      })
    await waitForMockPublish(findHeartbeatCall)
    expect(findHeartbeatCall()).toBeDefined()
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
    createdServices.push(service)

    await service.host('room-ftc-123')
    await vi.advanceTimersByTimeAsync(60)
    await flushPromises()
    expect(service.isStandbyHost()).toBe(false)

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_heartbeat',
      sender: 'peer_winner',
      hostSessionId: 'host-000-winning-session',
      deviceId: 'dev_winner',
      timestamp: Date.now() - 5000
    })))

    expect(service.isStandbyHost()).toBe(true)
    expect(onHostDemoted).toHaveBeenCalledWith({
      hostSessionId: 'host-000-winning-session',
      hostDeviceId: 'dev_winner'
    })
  })

  it('re-entering host from same device ignores stale heartbeats from prior session and remains active host', async () => {
    const onHostPromoted = vi.fn()
    const onHostStandby = vi.fn()
    const onHostDemoted = vi.fn()

    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted,
      onHostStandby,
      onHostDemoted
    })
    createdServices.push(service)

    await service.host('room-ftc-123')
    await vi.advanceTimersByTimeAsync(15)
    await flushPromises()

    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    const findProbeCall = () =>
      mockMqttClient.publish.mock.calls.find((c: any) => {
        const payloadStr = c[1]?.toString() || ''
        return payloadStr.includes('"type":"host_probe"')
      })
    await waitForMockPublish(findProbeCall)
    const probeCall = findProbeCall()
    expect(probeCall).toBeDefined()
    const probePayload = JSON.parse(probeCall[1].toString())
    const myDeviceId = probePayload.deviceId
    expect(myDeviceId).toBeTruthy()

    onMessage('topic', new TextEncoder().encode(JSON.stringify({
      type: 'host_heartbeat',
      sender: 'peer_old_session',
      hostSessionId: 'host-old-session-id',
      deviceId: myDeviceId,
      timestamp: Date.now() - 1000
    })))

    await vi.advanceTimersByTimeAsync(50)
    await flushPromises()

    expect(service.isStandbyHost()).toBe(false)
    expect(onHostPromoted).toHaveBeenCalled()
    expect(onHostStandby).not.toHaveBeenCalled()
    expect(onHostDemoted).not.toHaveBeenCalled()
  })
})
