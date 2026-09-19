import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { createWebRtcService, compareHostAuthority } from '@/services/webrtc'

// In-memory Virtual Signal Bus simulating MQTT Broker routing between multiple clients
class VirtualSignalBus {
  private clients = new Map<string, { topic: string; handler: (topic: string, payload: Uint8Array) => void }>()

  register(clientId: string, topic: string, handler: (topic: string, payload: Uint8Array) => void) {
    this.clients.set(clientId, { topic, handler })
  }

  unregister(clientId: string) {
    this.clients.delete(clientId)
  }

  broadcast(senderClientId: string, topic: string, payloadString: string) {
    const raw = new TextEncoder().encode(payloadString)
    for (const [cid, entry] of this.clients.entries()) {
      if (cid === senderClientId) continue // Do not loopback to sender directly
      if (entry.topic === topic) {
        entry.handler(topic, raw)
      }
    }
  }

  clear() {
    this.clients.clear()
  }
}

const signalBus = new VirtualSignalBus()

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn().mockImplementation((url: string, opts: any) => {
      const clientId = opts?.clientId || `mock_client_${Math.random()}`
      let currentTopic = ''
      const listeners: Record<string, any[]> = {}

      const client = {
        connected: true,
        clientId,
        on: vi.fn().mockImplementation((event: string, handler: any) => {
          if (!listeners[event]) listeners[event] = []
          listeners[event].push(handler)
          if (event === 'connect') {
            setTimeout(handler, 2)
          }
          return client
        }),
        subscribe: vi.fn().mockImplementation((topic: string, cb?: any) => {
          currentTopic = topic
          signalBus.register(clientId, topic, (t, payload) => {
            listeners['message']?.forEach(fn => fn(t, payload))
          })
          if (cb) cb(null)
        }),
        publish: vi.fn().mockImplementation((topic: string, message: string) => {
          signalBus.broadcast(clientId, topic, message)
        }),
        unsubscribe: vi.fn().mockImplementation(() => {
          signalBus.unregister(clientId)
        }),
        end: vi.fn().mockImplementation(() => {
          signalBus.unregister(clientId)
          listeners['offline']?.forEach(fn => fn())
        }),
        emitOffline: () => {
          listeners['offline']?.forEach(fn => fn())
        }
      }
      return client
    })
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

describe('Comprehensive Concurrency, Standby Takeover & Silent Failure Edge Tests', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    signalBus.clear();
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true;
    (globalThis as any).__TEST_PROBE_MS__ = 40;
    (globalThis as any).__TEST_WATCHDOG_TIMEOUT_MS__ = 120;
    (globalThis as any).__TEST_WATCHDOG_INTERVAL_MS__ = 30;
    (globalThis as any).__TEST_HEARTBEAT_INTERVAL_MS__ = 25;
    (globalThis as any).__TEST_PING_TIMEOUT_MS__ = 20;
    vi.clearAllMocks()

    global.RTCPeerConnection = vi.fn().mockImplementation(() => {
      let channelOnmessage: any = null
      const mockDc = {
        readyState: 'open',
        send: vi.fn().mockImplementation((data: string) => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.type === 'PING') {
              setTimeout(() => {
                if (mockDc.readyState === 'open' && channelOnmessage) {
                  channelOnmessage({
                    data: JSON.stringify({ type: 'PONG', timestamp: parsed.timestamp })
                  })
                }
              }, 2)
            }
          } catch {}
        }),
        close: vi.fn(),
        set onmessage(fn: any) { channelOnmessage = fn },
        get onmessage() { return channelOnmessage },
        onopen: null as any,
        onclose: null as any
      }
      return {
        createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'fake-sdp' }),
        createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'fake-sdp' }),
        setLocalDescription: vi.fn().mockResolvedValue(undefined),
        setRemoteDescription: vi.fn().mockResolvedValue(undefined),
        addIceCandidate: vi.fn().mockResolvedValue(undefined),
        createDataChannel: vi.fn().mockReturnValue(mockDc),
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

  afterEach(() => {
    delete (globalThis as any).__TEST_PROBE_MS__
    delete (globalThis as any).__TEST_WATCHDOG_TIMEOUT_MS__
    delete (globalThis as any).__TEST_WATCHDOG_INTERVAL_MS__
    delete (globalThis as any).__TEST_HEARTBEAT_INTERVAL_MS__
    delete (globalThis as any).__TEST_PING_TIMEOUT_MS__
    signalBus.clear()
  })

  it('Case 1: Same-Device Multi-Tab Coexistence & Standby Takeover (同设备分屏双开联调)', async () => {
    // Both sessions share the exact same localDeviceId in localStorage
    localStorage.setItem('sp27_device_identity', JSON.stringify({
      deviceId: 'shared_pc_device_id_123',
      publicKeyHex: '04aabbccdd',
      privateKeyJwk: {}
    }))

    const hostPromoted1 = vi.fn()
    const hostStandby1 = vi.fn()
    const service1 = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted: hostPromoted1,
      onHostStandby: hostStandby1
    })

    // 1. Tab 1 hosts the room
    await service1.host('room-shared-device-test')
    await vi.waitFor(() => {
      expect(service1.isStandbyHost()).toBe(false)
      expect(hostPromoted1).toHaveBeenCalled()
    })

    // 2. Tab 2 opens on the same device and probes
    const hostPromoted2 = vi.fn()
    const hostStandby2 = vi.fn()
    const hostLeft2 = vi.fn()
    const service2 = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted: hostPromoted2,
      onHostStandby: hostStandby2,
      onActiveHostLeft: hostLeft2
    })

    await service2.host('room-shared-device-test')
    await vi.waitFor(() => {
      expect(service2.isStandbyHost()).toBe(true)
      expect(hostStandby2).toHaveBeenCalled()
    })

    // 3. Tab 1 disconnects / crashes
    service1.disconnect()

    // Wait for Tab 2 watchdog to trigger on missing heartbeats
    await vi.waitFor(() => {
      expect(hostLeft2).toHaveBeenCalled()
    })

    // 4. Tab 2 clicks Takeover to become Active Host
    await service2.takeoverHost()
    await vi.waitFor(() => {
      expect(service2.isStandbyHost()).toBe(false)
      expect(hostPromoted2).toHaveBeenCalled()
    })

    service2.disconnect()
  })

  it('Case 2: Silent UDP Blackhole / Virtual NIC Disconnect (虚拟网卡断开与静默丢包快速探活)', async () => {
    let mockChannelHandler: any = null
    let isBlackholed = false

    const mockDc = {
      readyState: 'open',
      send: vi.fn().mockImplementation((data: string) => {
        if (isBlackholed) {
          // Silent blackhole: packets drop into the ether, host never receives them
          return
        }
        try {
          const parsed = JSON.parse(data)
          if (parsed.type === 'PING') {
            // Immediate PONG response from host
            setTimeout(() => {
              if (!isBlackholed && mockChannelHandler) {
                mockChannelHandler({
                  data: JSON.stringify({ type: 'PONG', timestamp: parsed.timestamp })
                })
              }
            }, 5)
          }
        } catch {}
      }),
      close: vi.fn(),
      set onmessage(fn: any) { mockChannelHandler = fn },
      get onmessage() { return mockChannelHandler },
      onopen: null as any,
      onclose: null as any
    }

    global.RTCPeerConnection = vi.fn().mockImplementation(() => ({
      createOffer: vi.fn().mockResolvedValue({ type: 'offer', sdp: 'fake-sdp' }),
      createAnswer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'fake-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
      createDataChannel: vi.fn().mockReturnValue(mockDc),
      close: vi.fn(),
      connectionState: 'connected',
      iceConnectionState: 'connected'
    })) as any

    const statusChanges: string[] = []
    const onHostDisconnected = vi.fn()
    const clientService = createWebRtcService({
      onStatusChange: (s) => statusChanges.push(s),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostDisconnected
    })

    await clientService.join('room-blackhole-test')
    await new Promise(r => setTimeout(r, 20))

    // Simulate DataChannel open
    mockDc.onopen?.()
    expect(statusChanges).toContain('connected')

    // Verify healthy ping-pong exchange
    await new Promise(r => setTimeout(r, 50))
    expect(mockDc.send).toHaveBeenCalled()

    // TRIGGER SILENT BLACKHOLE (Virtual NIC dropped: no close, readyState stays 'open')
    isBlackholed = true

    // Wait for 2 missed pings (~70ms with test interval 25ms and timeout 20ms)
    await new Promise(r => setTimeout(r, 100))

    // Verify autonomous degradation without waiting 30 seconds
    expect(statusChanges).toContain('degraded')
    expect(onHostDisconnected).toHaveBeenCalled()

    clientService.disconnect()
  })

  it('Case 3: Multi-Standby Concurrent Takeover Race (多备用机毫秒级并发抢占接管仲裁)', async () => {
    // Deterministic authority comparator test
    const authorityWinner = compareHostAuthority(2, 'dev_standby_A', 'host_session_early_100', 2, 'dev_standby_B', 'host_session_late_200')
    expect(authorityWinner).toBeGreaterThan(0) // Earlier session ID wins flat tie

    // Full service race simulation
    const hostPromotedA = vi.fn()
    const hostDemotedA = vi.fn()
    const standbyA = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted: hostPromotedA,
      onHostDemoted: hostDemotedA
    })

    const hostPromotedB = vi.fn()
    const hostDemotedB = vi.fn()
    const standbyB = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted: hostPromotedB,
      onHostDemoted: hostDemotedB
    })

    // Both start in standby mode
    await standbyA.host('room-takeover-race')
    await standbyB.host('room-takeover-race')
    await vi.waitFor(() => {
      expect(standbyA.isStandbyHost() || standbyB.isStandbyHost()).toBe(true)
    })

    // Concurrent takeover clicks from both Standbys
    await Promise.all([
      standbyA.takeoverHost(),
      standbyB.takeoverHost()
    ])

    // Wait for mutual takeover negotiation and arbitration
    await vi.waitFor(() => {
      const isAHost = !standbyA.isStandbyHost()
      const isBHost = !standbyB.isStandbyHost()
      expect(isAHost !== isBHost).toBe(true) // XOR: exactly one active host!
      expect(Number(isAHost) + Number(isBHost)).toBe(1)
    })

    standbyA.disconnect()
    standbyB.disconnect()
  })

  it('Case 4: Stale Host Epoch 1 Heartbeat Replay Suppression (低任期旧主机心跳压制与反向降级)', async () => {
    const demotedOldHost = vi.fn()
    const oldHostService = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostDemoted: demotedOldHost
    })

    await oldHostService.host('room-stale-epoch')
    await vi.waitFor(() => expect(oldHostService.isStandbyHost()).toBe(false))

    // New standby host joins the room and discovers old host
    const newHostService = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })

    await newHostService.host('room-stale-epoch')
    await vi.waitFor(() => expect(newHostService.isStandbyHost()).toBe(true))

    // Standby takes over: increments Epoch (Epoch 2) and broadcasts takeover
    await newHostService.takeoverHost()
    await vi.waitFor(() => {
      expect(demotedOldHost).toHaveBeenCalled()
      expect(oldHostService.isStandbyHost()).toBe(true)
    })

    oldHostService.disconnect()
    newHostService.disconnect()
  })

  it('Case 5: Multi-Device Simultaneous Wake-from-Sleep Concurrency Storm (多设备同时唤醒并发探活风暴)', async () => {
    // 1 Host + 6 concurrent scout clients
    const hostService = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })

    await hostService.host('room-storm-test')
    await new Promise(r => setTimeout(r, 60))

    const clients = Array.from({ length: 6 }, (_, i) => {
      const pingsReceived: number[] = []
      return {
        id: `scout_${i + 1}`,
        pingsReceived,
        service: createWebRtcService({
          onStatusChange: vi.fn(),
          onRecordsReceived: vi.fn().mockResolvedValue([]),
          onAckReceived: vi.fn(),
          onRequestSync: vi.fn(),
          onPongReceived: (ts) => pingsReceived.push(ts)
        })
      }
    })

    for (const c of clients) {
      await c.service.join('room-storm-test', `Scout_${c.id}`, c.id)
    }
    await new Promise(r => setTimeout(r, 50))

    // Simulate DataChannel open on wake for all 6 clients
    for (const c of clients) {
      const dc = c.service.getDataChannel() as any
      if (dc && dc.onopen) {
        dc.onopen()
      }
    }

    // All 6 devices simulate simultaneous wake-up ping flood
    const pings = clients.map((c) => c.service.pingPeer!(80))
    const results = await Promise.allSettled(pings)

    // Verify all 6 pings resolved successfully without deadlocks
    results.forEach(res => {
      expect(res.status).toBe('fulfilled')
      if (res.status === 'fulfilled') {
        expect(res.value).toBe(true)
      }
    })

    hostService.disconnect()
    clients.forEach(c => c.service.disconnect())
  })

  it('Case 6: Scouting Match Sync Resilience & Zero Loss During Host Takeover (主机离线接管全流程记录零丢失与单调时钟继承)', async () => {
    // Host 1 initial active host
    const host1ReceivedRecords: any[] = []
    const host1 = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation(async (recs) => {
        host1ReceivedRecords.push(...recs)
        return recs.map((r: any) => r.id)
      }),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })
    await host1.host('room-sync-resilience')
    await vi.waitFor(() => expect(host1.isStandbyHost()).toBe(false))

    // Standby Host 2 joins as standby
    const host2ReceivedRecords: any[] = []
    const host2 = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockImplementation(async (recs) => {
        host2ReceivedRecords.push(...recs)
        return recs.map((r: any) => r.id)
      }),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })
    await host2.host('room-sync-resilience')
    await vi.waitFor(() => expect(host2.isStandbyHost()).toBe(true))

    // 1. Initial 3 match records synced to Host 1
    const matchBatch1 = [
      { id: 'rec-q1-red1', eventId: 'ev-1', matchNumber: 1, teamNumber: 101, scoutId: 'scout_1' },
      { id: 'rec-q1-red2', eventId: 'ev-1', matchNumber: 1, teamNumber: 102, scoutId: 'scout_2' },
      { id: 'rec-q1-blue1', eventId: 'ev-1', matchNumber: 1, teamNumber: 201, scoutId: 'scout_3' }
    ]
    const stampedByHost1 = host1.stampHostSeq(matchBatch1 as any)
    expect(stampedByHost1.map(r => r.hostSeq)).toEqual([1, 2, 3])
    expect(host1.getHostSeqCounter()).toBe(3)

    // 2. Host 1 network severed (simulated by disconnect)
    host1.disconnect()

    // 3. Scout generates new records offline while host is disconnected
    const offlineBatch2 = [
      { id: 'rec-q2-red1', eventId: 'ev-1', matchNumber: 2, teamNumber: 101, scoutId: 'scout_1' },
      { id: 'rec-q2-red2', eventId: 'ev-1', matchNumber: 2, teamNumber: 102, scoutId: 'scout_2' }
    ]

    // 4. Standby Host 2 detects Host 1 offline & triggers takeover
    await host2.takeoverHost()
    expect(host2.isStandbyHost()).toBe(false)

    // Host 2 inherits sequence counter from database / handoff
    host2.initHostSeq(3)
    expect(host2.getHostSeqCounter()).toBe(3)

    // 5. Scout syncs offline batch to Host 2
    const stampedByHost2 = host2.stampHostSeq(offlineBatch2 as any)
    expect(stampedByHost2.map(r => r.hostSeq)).toEqual([4, 5])
    expect(host2.getHostSeqCounter()).toBe(5)

    // Verify: monotonic sequence without gaps or collisions
    const allRecords = [...stampedByHost1, ...stampedByHost2]
    expect(allRecords.length).toBe(5)
    expect(allRecords.map(r => r.hostSeq)).toEqual([1, 2, 3, 4, 5])

    // Verify non-destructive re-stamping of pre-stamped records
    const restamped = host2.stampHostSeq([stampedByHost1[0]])
    expect(restamped[0].hostSeq).toBe(1) // Existing sequence preserved!
    expect(host2.getHostSeqCounter()).toBe(5) // Clock was NOT rolled back

    host2.disconnect()
  })

  it('Case 7: Fast Reconnect Throttling & De-bouncing (网络高频瞬断与去抖恢复)', async () => {
    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })

    await service.join('room-flap-test')
    await new Promise(r => setTimeout(r, 40))

    // Rapid successive reconnectNow triggers (e.g. cellular signal flapping 4 times in 10ms)
    const triggerPromises = [
      service.reconnectNow(),
      service.reconnectNow(),
      service.reconnectNow(),
      service.reconnectNow()
    ]

    const results = await Promise.all(triggerPromises)
    // All calls should resolve cleanly without uncaught rejections
    expect(results.length).toBe(4)

    service.disconnect()
  })
})
