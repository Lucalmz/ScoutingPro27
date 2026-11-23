import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import mqtt from 'mqtt'
import * as api from '@/services/api'
import { createWebRtcService } from '@/services/webrtc'
import { useConnectionStore } from '@/stores/connection'
import type { ScoutingRecord } from '@/types'

const origRTCPeerConnection = global.RTCPeerConnection

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
    verifyWebRtcTicket: vi.fn().mockResolvedValue({ valid: true, userId: 'valid_scout', username: 'Scout' }),
    syncRecords: vi.fn().mockResolvedValue({ success: true })
  }
})

describe('Host Takeover Full-Sync & Handoff Protocol (主机接管全量对齐与交接协议)', () => {
  let messageHandler: ((topic: string, message: Buffer) => void) | null = null

  beforeEach(() => {
    setActivePinia(createPinia());
    (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__ = true;
    (globalThis as any).__TEST_PROBE_MS__ = 50
    vi.clearAllMocks()
    localStorage.clear()

    vi.mocked(mqtt.connect).mockImplementation(() => mockMqttClient as any)
    vi.mocked(api.createWebRtcTicket).mockImplementation(async (_eventId: string, ecdhPublicKey: string) => ({
      ticket: `ticket_for_${ecdhPublicKey ? ecdhPublicKey.slice(0, 10) : 'dummy'}`,
      expiresIn: 180
    }))
    vi.mocked(api.verifyToken).mockResolvedValue({ valid: true, userId: 'host_id', username: 'HostUser' })
    vi.mocked(api.verifyWebRtcTicket).mockResolvedValue({ valid: true, userId: 'valid_scout', username: 'Scout' })
    vi.mocked(api.syncRecords).mockResolvedValue({ success: true } as any)

    mockMqttClient.on.mockImplementation((event: string, handler: any) => {
      if (event === 'connect') handler()
      if (event === 'message') messageHandler = handler
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
    delete (globalThis as any).__TEST_ALLOW_UNSIGNED_SIGNALING__
    delete (globalThis as any).__TEST_PROBE_MS__
    global.RTCPeerConnection = origRTCPeerConnection
    vi.useRealTimers()
    vi.restoreAllMocks()
    messageHandler = null
  })

  it('retires legacy hostSeq and HOST_HANDOFF_BATCH methods from WebRtcService', () => {
    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })

    expect((service as any).stampHostSeq).toBeUndefined()
    expect((service as any).initHostSeq).toBeUndefined()
    expect((service as any).getHostSeqCounter).toBeUndefined()
    expect((service as any).sendHostHandoffBatch).toBeUndefined()
    expect((service as any).sendHostHandoffAck).toBeUndefined()

    service.disconnect()
  })

  it('takeoverHost sends hostEpoch and increments local epoch term', async () => {
    const onHostPromoted = vi.fn()
    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted
    })

    await service.host('room-ftc-epoch')
    await vi.waitFor(() => {
      expect(onHostPromoted).toHaveBeenCalled()
    })
    await service.takeoverHost()

    const publishCalls = mockMqttClient.publish.mock.calls
    const takeoverCall = publishCalls.find((c: any) => {
      const payloadStr = c[1]?.toString() || ''
      return payloadStr.includes('"type":"host_takeover"')
    })

    expect(takeoverCall).toBeDefined()
    const payload = JSON.parse(takeoverCall[1].toString())
    expect(payload.type).toBe('host_takeover')
    expect(payload.hostEpoch).toBeGreaterThanOrEqual(1)

    service.disconnect()
  })

  it('concurrent takeover tie-breaker: lower epoch yields, higher epoch suppresses and reaffirms', async () => {
    const onHostPromoted = vi.fn()
    const onHostDemoted = vi.fn()
    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted,
      onHostDemoted
    })

    await service.host('room-ftc-tie')
    await vi.waitFor(() => {
      expect(onHostPromoted).toHaveBeenCalled()
    })
    expect(service.isStandbyHost()).toBe(false)
    expect(messageHandler).toBeTypeOf('function')

    // Simulate incoming takeover from competing host with LOWER epoch (epoch: 0 < local: 1)
    const lowerTakeover = JSON.stringify({
      type: 'host_takeover',
      oldHostSessionId: 'old-sess',
      newHostSessionId: 'competing-host-low',
      deviceId: 'device-competing-aaa',
      hostEpoch: 0,
      sender: 'competing-client-low'
    })
    await messageHandler!('scoutingpro/signal/room-ftc-tie', Buffer.from(lowerTakeover))

    // Host should NOT demote because incoming epoch is lower!
    expect(onHostDemoted).not.toHaveBeenCalled()
    expect(service.isStandbyHost()).toBe(false)

    // Now simulate incoming takeover from competing host with HIGHER epoch (epoch: 10 > local: 1)
    const higherTakeover = JSON.stringify({
      type: 'host_takeover',
      oldHostSessionId: 'old-sess',
      newHostSessionId: 'competing-host-high',
      deviceId: 'device-competing-zzz',
      hostEpoch: 10,
      sender: 'competing-client-high'
    })
    await messageHandler!('scoutingpro/signal/room-ftc-tie', Buffer.from(higherTakeover))

    // Host should demote because incoming epoch is higher!
    expect(onHostDemoted).toHaveBeenCalled()
    expect(service.isStandbyHost()).toBe(true)

    service.disconnect()
  })

  it('takeoverHost cooldown & mutex throttles rapid clicks within 3 seconds', async () => {
    const connStore = useConnectionStore()
    const mockRtc = {
      takeoverHost: vi.fn().mockResolvedValue(undefined)
    } as any
    connStore.setRtcService(mockRtc)
    connStore.setStandbyHost(true)

    // First click: succeeds
    await connStore.takeoverHost()
    expect(mockRtc.takeoverHost).toHaveBeenCalledTimes(1)
    expect(connStore.isTakingOver).toBe(true)

    // Second immediate click: throttled by mutex/cooldown
    await connStore.takeoverHost()
    expect(mockRtc.takeoverHost).toHaveBeenCalledTimes(1) // Still 1!
  })

  it('CRDT concurrent takeover merges old-host, standby-host, and in-flight scout writes without blocking gate or hostSeq', async () => {
    const { createMergeableStore } = await import('tinybase')
    const { createWebRtcCrdtSynchronizerHub, readScoutingRecordsFromCrdt, writeScoutingRecordToCrdt } = await import('@/services/crdt')

    let now = 1_760_000_000_000
    const oldHostStore = createMergeableStore('dev-old-host', () => ++now, 300)
    const newHostStore = createMergeableStore('dev-new-host', () => ++now, 300)
    const scoutStore = createMergeableStore('dev-scout-1', () => ++now, 300)

    writeScoutingRecordToCrdt(oldHostStore, {
      id: 'rec-old-host-exclusive',
      eventId: 'event-1',
      scoutId: 'host-user',
      scoutName: 'OldHost',
      matchNumber: 5,
      teamNumber: 27570,
      autoScore: 10,
      teleopScore: 20,
      endgameScore: 10,
      totalScore: 40,
      notes: '',
      rawData: '{}',
      syncStatus: 'SYNCED',
      createdAt: '',
      updatedAt: '',
      isBroken: false,
      version: 1
    })

    writeScoutingRecordToCrdt(newHostStore, {
      id: 'rec-new-host-offline',
      eventId: 'event-1',
      scoutId: 'bob-user',
      scoutName: 'StandbyBob',
      matchNumber: 6,
      teamNumber: 1234,
      autoScore: 15,
      teleopScore: 25,
      endgameScore: 15,
      totalScore: 55,
      notes: '',
      rawData: '{}',
      syncStatus: 'SYNCED',
      createdAt: '',
      updatedAt: '',
      isBroken: false,
      version: 1
    })

    writeScoutingRecordToCrdt(scoutStore, {
      id: 'rec-scout-inflight',
      eventId: 'event-1',
      scoutId: 'scout-1',
      scoutName: 'Scout 1',
      matchNumber: 7,
      teamNumber: 999,
      autoScore: 20,
      teleopScore: 30,
      endgameScore: 10,
      totalScore: 60,
      notes: '',
      rawData: '{}',
      syncStatus: 'SYNCED',
      createdAt: '',
      updatedAt: '',
      isBroken: false,
      version: 1
    })

    let newHostHub!: ReturnType<typeof createWebRtcCrdtSynchronizerHub>
    let oldHostHub!: ReturnType<typeof createWebRtcCrdtSynchronizerHub>
    let scoutHub!: ReturnType<typeof createWebRtcCrdtSynchronizerHub>

    newHostHub = createWebRtcCrdtSynchronizerHub({
      eventId: 'event-1',
      store: newHostStore,
      clientId: 'dev-new-host',
      getNowMs: () => now,
      sendToPeer: (peerId, msg) => {
        if (peerId === 'old-host') oldHostHub.handleIncomingMessage('host', msg)
        if (peerId === 'scout-1') scoutHub.handleIncomingMessage('host', msg)
      }
    })
    oldHostHub = createWebRtcCrdtSynchronizerHub({
      eventId: 'event-1',
      store: oldHostStore,
      clientId: 'dev-old-host',
      getNowMs: () => now,
      sendToPeer: (_peerId, msg) => newHostHub.handleIncomingMessage('old-host', msg)
    })
    scoutHub = createWebRtcCrdtSynchronizerHub({
      eventId: 'event-1',
      store: scoutStore,
      clientId: 'dev-scout-1',
      getNowMs: () => now,
      sendToPeer: (_peerId, msg) => newHostHub.handleIncomingMessage('scout-1', msg)
    })

    // Concurrent peer attachment without any blocking staging gate
    await Promise.all([
      newHostHub.attachPeer('scout-1'),
      scoutHub.attachPeer('host'),
      newHostHub.attachPeer('old-host'),
      oldHostHub.attachPeer('host')
    ])

    const expectedIds = ['rec-new-host-offline', 'rec-old-host-exclusive', 'rec-scout-inflight']
    await vi.waitFor(() => {
      for (const st of [newHostStore, oldHostStore, scoutStore]) {
        const recs = readScoutingRecordsFromCrdt(st, 'event-1')
        expect(recs.map((r) => r.id).sort()).toEqual(expectedIds)
        expect(recs.every((r) => (r as any).hostSeq === undefined)).toBe(true)
      }
    })

    await Promise.all([newHostHub.destroy(), oldHostHub.destroy(), scoutHub.destroy()])
  })

  it('compareHostAuthority enforces strict total order across epoch, sessionId, and deviceId', async () => {
    const { compareHostAuthority } = await import('@/services/webrtc')

    // 1. Higher epoch always wins
    expect(compareHostAuthority(5, 'dev-a', 'host-1', 4, 'dev-z', 'host-9')).toBeGreaterThan(0)
    expect(compareHostAuthority(2, 'dev-z', 'host-9', 3, 'dev-a', 'host-1')).toBeLessThan(0)

    // 2. Equal epoch: sessionId breaks tie (smaller/older session ID wins)
    expect(compareHostAuthority(3, 'dev-z', 'host-1', 3, 'dev-a', 'host-9')).toBeGreaterThan(0)
    expect(compareHostAuthority(3, 'dev-a', 'host-9', 3, 'dev-z', 'host-1')).toBeLessThan(0)

    // 3. Equal epoch and sessionId: deviceId breaks tie (smaller device ID wins)
    expect(compareHostAuthority(3, 'dev-a', 'host-1', 3, 'dev-z', 'host-1')).toBeGreaterThan(0)
    expect(compareHostAuthority(3, 'dev-z', 'host-1', 3, 'dev-a', 'host-1')).toBeLessThan(0)
    expect(compareHostAuthority(3, 'dev-a', 'host-1', 3, 'dev-a', 'host-1')).toBe(0)
  })

  it('stale host_heartbeat with lower epoch NEVER demotes a higher-epoch active host', async () => {
    const onHostPromoted = vi.fn()
    const onHostDemoted = vi.fn()
    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted,
      onHostDemoted
    })

    await service.host('room-stale-hb')
    await vi.waitFor(() => {
      expect(onHostPromoted).toHaveBeenCalled()
    })
    // Promote local host to epoch 3
    await service.takeoverHost()
    await service.takeoverHost() // localEpoch is now at least 3

    expect(service.isStandbyHost()).toBe(false)
    expect(messageHandler).toBeTypeOf('function')

    // Stale heartbeat from old host with epoch: 1 arrives over MQTT broker
    const staleHeartbeat = JSON.stringify({
      type: 'host_heartbeat',
      hostSessionId: 'host-old-timestamp-1111111',
      deviceId: 'device-zzz',
      hostEpoch: 1,
      sender: 'old-host-client'
    })
    await messageHandler!('scoutingpro/signal/room-stale-hb', Buffer.from(staleHeartbeat))

    // Active host MUST NOT demote!
    expect(onHostDemoted).not.toHaveBeenCalled()
    expect(service.isStandbyHost()).toBe(false)

    service.disconnect()
  })

  it('Standby host auto-approves host_hello and bypasses onSasVerificationRequired popup', async () => {
    const onSasVerificationRequired = vi.fn()
    const onSasVerified = vi.fn()
    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onSasVerificationRequired,
      onSasVerified
    })

    // Start as host with active probe
    await service.host('room-standby-no-sas')
    const onMessage = mockMqttClient.on.mock.calls.find((c: any) => c[0] === 'message')?.[1]
    expect(onMessage).toBeDefined()

    // During probe, active host heartbeat arrives -> enters standby
    onMessage(
      'topic',
      new TextEncoder().encode(
        JSON.stringify({
          type: 'host_heartbeat',
          hostSessionId: 'active-main-host-session',
          deviceId: 'dev_active_main',
          hostEpoch: 1
        })
      )
    )
    await vi.waitFor(() => {
      expect(service.isStandbyHost()).toBe(true)
    })

    // Now active host sends host_hello with ECDH public key
    const { generateEcdhKeyPair, exportEcdhPublicKey } = await import('@/utils/crypto')
    const hostKeys = await generateEcdhKeyPair()
    const hostPubHex = await exportEcdhPublicKey(hostKeys.publicKey)

    onMessage(
      'topic',
      new TextEncoder().encode(
        JSON.stringify({
          type: 'host_hello',
          hostSessionId: 'active-main-host-session',
          deviceId: 'dev_active_main',
          ecdhPublicKey: hostPubHex,
          hostEpoch: 1,
          username: 'MainHost',
          userId: 'host_user_1'
        })
      )
    )
    await vi.waitFor(() => {
      expect(onSasVerified).toHaveBeenCalledWith('host')
      expect(service.getSasState('host')).toBe('VERIFIED')
      expect(onSasVerificationRequired).not.toHaveBeenCalled()
    }, { timeout: 1000 })

    service.disconnect()
  })

  it('Concurrent takeovers with identical epoch break tie deterministically without split-brain or double-standby', async () => {
    const onHostPromoted1 = vi.fn()
    const onHostDemoted1 = vi.fn()
    const service1 = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn(),
      onHostPromoted: onHostPromoted1,
      onHostDemoted: onHostDemoted1
    })

    await service1.host('room-concurrent-takeover')
    await vi.waitFor(() => {
      expect(onHostPromoted1).toHaveBeenCalled()
    })

    // Host 1 promotes to epoch 2
    await service1.takeoverHost()
    expect(service1.isStandbyHost()).toBe(false)
    expect(messageHandler).toBeTypeOf('function')

    // Host 2 also initiated takeover with identical epoch 2 but different sessionId
    // Suppose Host 2 has a newer (larger) session ID: 'host-999999999-peer'
    // Under our rule: smaller/older session ID wins, so Host 1 wins and stays Active Host!
    await messageHandler!(
      'scoutingpro/signal/room-concurrent-takeover',
      Buffer.from(
        JSON.stringify({
          type: 'host_takeover',
          newHostSessionId: 'host-999999999-peer',
          deviceId: 'dev_host2',
          hostEpoch: 2,
          sender: 'peer-host2'
        })
      )
    )
    await flushPromises()

    // Host 1 did not demote because its session was earlier!
    expect(onHostDemoted1).not.toHaveBeenCalled()
    expect(service1.isStandbyHost()).toBe(false)

    // Now test the opposite: incoming takeover has an older/smaller session ID: 'host-000000000-winner'
    await messageHandler!(
      'scoutingpro/signal/room-concurrent-takeover',
      Buffer.from(
        JSON.stringify({
          type: 'host_takeover',
          newHostSessionId: 'host-000000000-winner',
          deviceId: 'dev_host_winner',
          hostEpoch: 2,
          sender: 'peer-winner'
        })
      )
    )
    await vi.waitFor(() => {
      expect(onHostDemoted1).toHaveBeenCalledWith({
        hostSessionId: 'host-000000000-winner',
        hostDeviceId: 'dev_host_winner'
      })
    })
    expect(service1.isStandbyHost()).toBe(true)

    service1.disconnect()
  })
})
