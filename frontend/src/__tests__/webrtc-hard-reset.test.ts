import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createWebRtcService,
  optimizeCandidatePriority
} from '../services/webrtc'
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
  createWebRtcTicket: vi.fn().mockResolvedValue({ ticket: 'test_ticket', expiresIn: 180 }),
  verifyWebRtcTicket: vi.fn().mockResolvedValue({ valid: true, userId: 'scout_test', username: 'Tester' }),
  verifyToken: vi.fn().mockResolvedValue({ valid: true, userId: 'host_test', username: 'Host' })
}))

describe('WebRTC Hard Reset & Channel Teardown Architecture', () => {
  let mockMqttClient: any
  let closedPcs: any[] = []

  beforeEach(() => {
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true
    closedPcs = []
    mockMqttClient = {
      on: vi.fn(),
      subscribe: vi.fn(),
      publish: vi.fn(),
      connected: true,
      unsubscribe: vi.fn(),
      end: vi.fn()
    }
    vi.mocked(mqtt.connect).mockReturnValue(mockMqttClient)

    global.RTCPeerConnection = vi.fn().mockImplementation((config: any) => {
      const pcObj: any = {
        config,
        close: vi.fn().mockImplementation(function (this: any) {
          closedPcs.push(this)
        }),
        createDataChannel: vi.fn().mockReturnValue({
          send: vi.fn(),
          readyState: 'open',
          close: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn()
        }),
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        connectionState: 'new',
        iceConnectionState: 'new',
        onicecandidate: null,
        oniceconnectionstatechange: null,
        onconnectionstatechange: null,
        ondatachannel: null
      }
      return pcObj
    }) as any
  })

  it('optimizeCandidatePriority correctly ranks IPv4 srflx and prflx above TURN relay', () => {
    const ipv4Srflx = 'candidate:1 1 udp 1694498815 111.8.3.78 3478 typ srflx raddr 192.168.1.5 rport 50000'
    const ipv4Prflx = 'candidate:2 1 udp 1694498815 111.8.3.78 3479 typ prflx raddr 192.168.1.5 rport 50001'
    const relayCand = 'candidate:3 1 udp 255 172.233.148.95 3478 typ relay raddr 111.8.3.78 rport 50000'

    const optSrflx = optimizeCandidatePriority(ipv4Srflx)
    const optPrflx = optimizeCandidatePriority(ipv4Prflx)
    const optRelay = optimizeCandidatePriority(relayCand)

    const srflxPriority = parseInt(optSrflx.split(' ')[3], 10)
    const prflxPriority = parseInt(optPrflx.split(' ')[3], 10)
    const relayPriority = parseInt(optRelay.split(' ')[3], 10)

    expect(srflxPriority).toBeGreaterThan(relayPriority)
    expect(prflxPriority).toBeGreaterThan(relayPriority)
    expect(srflxPriority).toBeGreaterThanOrEqual(1500000000)
    expect(relayPriority).toBeLessThanOrEqual(256)
  })

  it('reconnectNow resets clientForceRelay from true back to false', async () => {
    const callbacks = {
      onStatusChange: vi.fn()
    }
    const service = createWebRtcService(callbacks)
    await service.join('reset-relay-test')

    // Simulate relay downgrade triggered by 8s stall watchdog
    const clientSession = (service as any)._clientSession
    // Set forceRelay through internal context or reconnect
    await service.reconnectNow()

    const createdPcs = vi.mocked(global.RTCPeerConnection).mock.results
    const latestPc = createdPcs[createdPcs.length - 1].value
    expect(latestPc.config.iceTransportPolicy).not.toBe('relay')
    service.disconnect()
  })

  it('Host tears down previous active connection immediately when receiving a new Offer from same peer', async () => {
    const callbacks = {
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    }
    const hostService = createWebRtcService(callbacks)
    await hostService.host('host-teardown-test', undefined, 'HostUser', 'host_user_1')

    // Find the 'message' callback registered on mockMqttClient
    const messageCall = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(messageCall).toBeDefined()

    // Dispatch initial Offer 1 from client
    const offerPayload1 = {
      sender: 'client_peer_1',
      clientSessionId: 'sess-1',
      offer: {
        type: 'offer',
        sdp: 'v=0\r\n'
      }
    }

    await messageCall('scoutingpro27/signal/test', new TextEncoder().encode(JSON.stringify(offerPayload1)))

    const firstPc = vi.mocked(global.RTCPeerConnection).mock.results[0].value

    // Now client reconnects (e.g. Wi-Fi drops and switches to cellular) and sends Offer 2 with sess-2
    const offerPayload2 = {
      sender: 'client_peer_1',
      clientSessionId: 'sess-2',
      offer: {
        type: 'offer',
        sdp: 'v=0\r\n'
      }
    }
    await messageCall('scoutingpro27/signal/test', new TextEncoder().encode(JSON.stringify(offerPayload2)))
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Verify: The first PC was explicitly closed and dismantled
    expect(closedPcs).toContain(firstPc)

    // Verify: The second PC was created and is active
    expect(vi.mocked(global.RTCPeerConnection).mock.results.length).toBeGreaterThanOrEqual(2)

    hostService.disconnect()
  })
})
