import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { createWebRtcService } from '@/services/webrtc'
import { useConnectionStore } from '@/stores/connection'
import type { ScoutingRecord } from '@/types'

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
    delete (globalThis as any).__TEST_PROBE_MS__
    messageHandler = null
  })

  it('stampHostSeq is non-destructive: preserves existing hostSeq and advances clock monotonically', () => {
    const service = createWebRtcService({
      onStatusChange: vi.fn(),
      onRecordsReceived: vi.fn().mockResolvedValue([]),
      onAckReceived: vi.fn(),
      onRequestSync: vi.fn()
    })

    // 1. Fresh records get stamped starting from 1
    const fresh1: ScoutingRecord = {
      id: 'rec-1',
      eventId: 'ev-1',
      matchNumber: 1,
      teamNumber: 100,
      scoutId: 'scout-1',
      scoutName: 'Scout 1',
      autoScore: 10,
      teleopScore: 20,
      endgameScore: 30,
      updatedAt: new Date().toISOString()
    }
    const stamped1 = service.stampHostSeq([fresh1])
    expect(stamped1[0].hostSeq).toBe(1)
    expect(service.getHostSeqCounter()).toBe(1)

    // 2. Incoming record from another host handoff already stamped with hostSeq=25
    const preStamped: ScoutingRecord = {
      id: 'rec-2',
      eventId: 'ev-1',
      matchNumber: 2,
      teamNumber: 101,
      scoutId: 'scout-2',
      scoutName: 'Scout 2',
      autoScore: 15,
      teleopScore: 25,
      endgameScore: 35,
      hostSeq: 25,
      updatedAt: new Date().toISOString()
    }
    const stamped2 = service.stampHostSeq([preStamped])
    expect(stamped2[0].hostSeq).toBe(25) // Preserved, not overwritten!
    expect(service.getHostSeqCounter()).toBe(25) // Clock advanced!

    // 3. Next fresh record continues monotonically from 26
    const fresh2: ScoutingRecord = {
      id: 'rec-3',
      eventId: 'ev-1',
      matchNumber: 3,
      teamNumber: 102,
      scoutId: 'scout-1',
      scoutName: 'Scout 1',
      autoScore: 5,
      teleopScore: 10,
      endgameScore: 15,
      updatedAt: new Date().toISOString()
    }
    const stamped3 = service.stampHostSeq([fresh2])
    expect(stamped3[0].hostSeq).toBe(26)
    expect(service.getHostSeqCounter()).toBe(26)

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
    await new Promise((r) => setTimeout(r, 70))
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
    await new Promise(r => setTimeout(r, 100))
    expect(service.isStandbyHost()).toBe(false)

    // Simulate incoming takeover from competing host with LOWER epoch (epoch: 0 < local: 1)
    if (messageHandler) {
      const lowerTakeover = JSON.stringify({
        type: 'host_takeover',
        oldHostSessionId: 'old-sess',
        newHostSessionId: 'competing-host-low',
        deviceId: 'device-competing-aaa',
        hostEpoch: 0,
        sender: 'competing-client-low'
      })
      await messageHandler('scoutingpro/signal/room-ftc-tie', Buffer.from(lowerTakeover))
    }

    // Host should NOT demote because incoming epoch is lower!
    expect(onHostDemoted).not.toHaveBeenCalled()
    expect(service.isStandbyHost()).toBe(false)

    // Now simulate incoming takeover from competing host with HIGHER epoch (epoch: 10 > local: 1)
    if (messageHandler) {
      const higherTakeover = JSON.stringify({
        type: 'host_takeover',
        oldHostSessionId: 'old-sess',
        newHostSessionId: 'competing-host-high',
        deviceId: 'device-competing-zzz',
        hostEpoch: 10,
        sender: 'competing-client-high'
      })
      await messageHandler('scoutingpro/signal/room-ftc-tie', Buffer.from(higherTakeover))
    }

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

  it('HOST_HANDOFF_BATCH updates clock, calls callbacks, and emits HOST_HANDOFF_ACK', async () => {
    const { createChannelMessageHandler } = await import('@/services/webrtc/channelMessageHandler')
    const sentMessages: any[] = []
    let hostSeqCounter = 10
    const onRecordsReceived = vi.fn().mockImplementation(async (records: ScoutingRecord[]) => records)
    const onHostHandoffReceived = vi.fn().mockResolvedValue(2)
    const finishTakeoverReconciliation = vi.fn()

    const handler = createChannelMessageHandler({
      isHostMode: () => true,
      currentInviteCode: () => 'room-handoff',
      getHostSessionId: () => 'host-session-123',
      getCurrentHostSessionId: () => 'host-session-123',
      setCurrentHostSessionId: vi.fn(),
      callbacks: {
        onStatusChange: vi.fn(),
        onRecordsReceived,
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn(),
        onHostHandoffReceived
      } as any,
      clients: new Map(),
      stagedClients: new Map(),
      scoutIdToClientIds: new Map(),
      clientIdToScoutId: new Map([['peer_old_host', 'host_user']]),
      clientIdToScoutName: new Map([['peer_old_host', 'OldHost']]),
      pendingTakeovers: new Map(),
      takeoverCooldowns: new Map(),
      offlineMessages: { enqueue: vi.fn() } as any,
      sendMessage: vi.fn().mockImplementation(async (msg, target) => {
        sentMessages.push({ msg, target })
      }),
      promoteTakeover: vi.fn(),
      enqueueHostTask: vi.fn().mockImplementation((sender, task) => task()),
      cleanupPeerResources: vi.fn(),
      stampHostSeq: (records) => {
        for (const r of records) {
          if (r.hostSeq && r.hostSeq > hostSeqCounter) hostSeqCounter = r.hostSeq
        }
      },
      getHostSeqCounter: () => hostSeqCounter,
      setHostSeqCounter: (n) => {
        hostSeqCounter = n
      },
      closeClient: vi.fn(),
      setStatus: vi.fn(),
      finishTakeoverReconciliation
    })

    const handoffPayload = {
      type: 'HOST_HANDOFF_BATCH',
      eventId: 'event-1',
      incomingMaxSeq: 42,
      hostEpoch: 3,
      authCode: 'room-handoff',
      records: [
        { id: 'rec-10', eventId: 'event-1', matchNumber: 1, teamNumber: 100, hostSeq: 41, scoutId: 'scout-1', autoScore: 10, teleopScore: 20, endgameScore: 30, updatedAt: '' },
        { id: 'rec-11', eventId: 'event-1', matchNumber: 2, teamNumber: 200, hostSeq: 42, scoutId: 'scout-2', autoScore: 15, teleopScore: 25, endgameScore: 35, updatedAt: '' }
      ]
    }

    const ev = { data: JSON.stringify(handoffPayload) } as MessageEvent
    await handler(ev, 'peer_old_host')

    // Records received and merged
    expect(onRecordsReceived).toHaveBeenCalled()
    expect(onHostHandoffReceived).toHaveBeenCalled()
    // Reconciliation finished
    expect(finishTakeoverReconciliation).toHaveBeenCalledWith('handoff_processed')
    // Clock advanced to incomingMaxSeq (42)
    expect(hostSeqCounter).toBe(42)

    // ACK returned to peer_old_host
    expect(sentMessages.length).toBe(1)
    expect(sentMessages[0].target).toBe('peer_old_host')
    expect(sentMessages[0].msg.type).toBe('HOST_HANDOFF_ACK')
    expect(sentMessages[0].msg.alignedMaxSeq).toBe(42)
  })

  it('in-flight SYNC_DATA waits for takeover reconciliation gate and stamps non-colliding hostSeq', async () => {
    const { createChannelMessageHandler } = await import('@/services/webrtc/channelMessageHandler')
    let isReconciling = true
    let resolveReconciliation: () => void
    const reconPromise = new Promise<void>((r) => {
      resolveReconciliation = r
    })

    let hostSeqCounter = 10
    const sentMessages: any[] = []

    const handler = createChannelMessageHandler({
      isHostMode: () => true,
      currentInviteCode: () => 'room-gate',
      getHostSessionId: () => 'host-gate-sess',
      getCurrentHostSessionId: () => 'host-gate-sess',
      setCurrentHostSessionId: vi.fn(),
      callbacks: {
        onStatusChange: vi.fn(),
        onRecordsReceived: vi.fn().mockImplementation(async (recs) => recs),
        onAckReceived: vi.fn(),
        onRequestSync: vi.fn()
      } as any,
      clients: new Map(),
      stagedClients: new Map(),
      scoutIdToClientIds: new Map(),
      clientIdToScoutId: new Map([['scout_peer', 'scout_user_1']]),
      clientIdToScoutName: new Map([['scout_peer', 'Scout 1']]),
      pendingTakeovers: new Map(),
      takeoverCooldowns: new Map(),
      offlineMessages: { enqueue: vi.fn() } as any,
      sendMessage: vi.fn().mockImplementation(async (msg, target) => {
        sentMessages.push({ msg, target })
      }),
      promoteTakeover: vi.fn(),
      enqueueHostTask: vi.fn().mockImplementation((sender, task) => task()),
      cleanupPeerResources: vi.fn(),
      stampHostSeq: (records) => {
        for (const r of records) {
          if (!r.hostSeq) r.hostSeq = ++hostSeqCounter
        }
      },
      getHostSeqCounter: () => hostSeqCounter,
      setHostSeqCounter: (n) => {
        hostSeqCounter = n
      },
      closeClient: vi.fn(),
      setStatus: vi.fn(),
      isTakeoverReconciling: () => isReconciling,
      waitForTakeoverReconciliation: () => reconPromise
    })

    const freshRecordPayload = {
      type: 'SYNC_DATA',
      authCode: 'room-gate',
      senderUserId: 'scout_user_1',
      records: [
        { id: 'fresh-rec', eventId: 'event-1', matchNumber: 5, teamNumber: 999, scoutId: 'scout_user_1', autoScore: 10, teleopScore: 20, endgameScore: 30, updatedAt: '' }
      ]
    }

    // Launch SYNC_DATA while reconciling
    const syncDataPromise = handler({ data: JSON.stringify(freshRecordPayload) } as MessageEvent, 'scout_peer')

    // At this moment, syncDataPromise is paused awaiting reconPromise!
    expect(sentMessages.length).toBe(0)

    // Simulate Handoff batch completes, advancing hostSeqCounter to 50
    hostSeqCounter = 50
    isReconciling = false
    resolveReconciliation!()

    // Wait for syncDataPromise to finish
    await syncDataPromise

    // Stamped record now has hostSeq = 51!
    expect(sentMessages.length).toBeGreaterThanOrEqual(1)
    const ackMsg = sentMessages.find(m => m.msg.type === 'ACK_SYNC')
    expect(ackMsg).toBeDefined()
    expect(ackMsg.msg.stampedRecords[0].hostSeq).toBe(51) // Strictly greater than 50!
  })
})
