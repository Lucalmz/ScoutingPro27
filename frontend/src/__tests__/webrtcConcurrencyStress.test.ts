import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { VirtualDataChannel } from '@/services/webrtc/virtualDataChannel'
import { createClientVirtualFallbackController } from '@/services/webrtc/clientVirtualFallback'
import { createMessageDispatcher } from '@/services/webrtc/messageDispatcher'
import { DataChannelSender } from '@/services/dataChannelSender'
import { encryptSignalingData, decryptSignalingData } from '@/utils/crypto'
import { useInboxStore } from '@/stores/inbox'
import { useRecordStore } from '@/stores/records'
import type { ClientEntry } from '@/services/webrtc/types'
import type { ScoutingRecord } from '@/types'

describe('WebRTC Concurrency & Adversarial Stress Suite (Challenger Empirical Verification)', () => {
  let mockAesKey: CryptoKey

  beforeEach(async () => {
    setActivePinia(createPinia())
    mockAesKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  })

  // =========================================================================
  // Stress Scenario 1: Rapid Switching / Flapping (50 iterations)
  // =========================================================================
  it('Stress 1: Rapid oscillation between VirtualDataChannel and Native UDP without leaks or corruption', async () => {
    let clientDc: any = null
    let clientSender: any = null
    let currentEpoch = 1
    const receivedFrames: string[] = []

    const mockSignaling = {
      send: vi.fn().mockImplementation(async () => {
        // Asynchronous micro-tick
        await new Promise((r) => setTimeout(r, 1))
      })
    }

    const ctx: any = {
      sas: { clientSharedAesKey: mockAesKey },
      getClientSessionId: () => 'sess-rapid-flap',
      getCurrentHostSessionId: () => 'host-rapid-flap',
      getClientHostSenderId: () => 'host-peer-1',
      getClientDc: () => clientDc,
      setClientDc: (dc: any) => { clientDc = dc },
      getClientSender: () => clientSender,
      setClientSender: (sender: any) => { clientSender = sender },
      getClientPc: () => null,
      getLocalDeviceId: () => 'dev-flap',
      getLocalEcdhPubHex: () => '04aabb',
      peerMgr: {
        markVirtualChannelActive: vi.fn(),
        updateTransportInfo: vi.fn(),
        currentTransportInfo: null
      },
      callbacks: {},
      setStatus: vi.fn(),
      handleChannelMessage: vi.fn().mockImplementation((ev: MessageEvent) => {
        receivedFrames.push(ev.data)
      }),
      getSignaling: () => mockSignaling
    }

    const ctrl = createClientVirtualFallbackController({
      ctx,
      getAttemptEpoch: () => currentEpoch,
      clearFailedEpochIfMatch: vi.fn(),
      clearConnectWatchdog: vi.fn(),
      clearReconnectTimer: vi.fn(),
      startDataChannelHeartbeat: vi.fn(),
      checkAndScheduleSilentUpgrade: vi.fn().mockResolvedValue(undefined),
      getSilentUpgradeProbeCount: () => 0,
      incrementSilentUpgradeProbeCount: () => 1
    })

    // Perform 50 rapid alternating switch cycles
    for (let i = 0; i < 50; i++) {
      // 1. Fallback activation
      ctrl.activateVirtualFallbackChannel(1, `sess-flap-${i}`)
      const vdc = ctrl.getActiveVirtualDc()
      expect(vdc).toBeDefined()
      vdc!.open()

      // 2. Simulated native upgrade
      ctrl.closeActiveVirtualDc(true, true)
      expect(ctrl.getActiveVirtualDc()).toBeNull()
      expect(vdc!.isDraining).toBe(true)

      // 3. Simulated drop / re-fallback
      ctrl.closeActiveVirtualDc()
      expect(vdc!.readyState).toBe('closed')
      expect(vdc!.isDraining).toBe(false)
    }

    // Final cycle: verify the channel is fully operational
    ctrl.activateVirtualFallbackChannel(1, 'sess-flap-final')
    const finalVdc = ctrl.getActiveVirtualDc()!
    finalVdc.open()
    expect(finalVdc.readyState).toBe('open')

    const inboundMsg = JSON.stringify({ type: 'PING', count: 999 })
    const encryptedFrame = await encryptSignalingData(
      mockAesKey,
      JSON.stringify({
        vdc: 'data',
        sessionId: 'sess-rapid-flap',
        payload: inboundMsg
      })
    )
    await ctrl.handleIncomingEncryptedVirtualFrame(encryptedFrame)
    expect(receivedFrames).toContain(inboundMsg)

    ctrl.closeActiveVirtualDc()
    expect(finalVdc.readyState).toBe('closed')
  })

  // =========================================================================
  // Stress Scenario 2: In-Flight High-Concurrency Burst (100 messages)
  // =========================================================================
  it('Stress 2: High-concurrency 100-message burst during hot-upgrade drain preserves FIFO ordering', async () => {
    const sentWirePayloads: string[] = []

    const mockSignaling = {
      send: vi.fn().mockImplementation(async (data: any) => {
        // Simulate jitter / variable network delay (1-5ms)
        const delay = Math.floor(Math.random() * 5) + 1
        await new Promise((r) => setTimeout(r, delay))
        const decryptedJson = await decryptSignalingData(mockAesKey, data.encrypted)
        const parsed = JSON.parse(decryptedJson)
        sentWirePayloads.push(parsed.payload)
      })
    }

    const vdc = new VirtualDataChannel({
      label: 'stress-burst-dc',
      sessionId: 'sess-burst-100',
      getSignaling: () => mockSignaling as any,
      getSharedAesKey: () => mockAesKey,
      getTargetPeerId: () => 'host-peer'
    })

    vdc.open()

    const burstCount = 100
    const sendPromises: Promise<void>[] = []

    // Launch 100 concurrent asynchronous sends
    for (let i = 0; i < burstCount; i++) {
      if (i === 50) {
        // Right at midpoint, trigger hot-upgrade drain
        vdc.startDrain(2000, 2000)
      }
      sendPromises.push(vdc.sendAsync(`msg-${i}`))
    }

    // Await all 100 concurrent sends
    await Promise.all(sendPromises)

    // Assert exact message count and strict FIFO ordering
    expect(sentWirePayloads.length).toBe(burstCount)
    for (let i = 0; i < burstCount; i++) {
      expect(sentWirePayloads[i]).toBe(`msg-${i}`)
    }

    // Assert buffer settles to 0
    expect(vdc.bufferedAmount).toBe(0)

    vdc.close()
    expect(vdc.readyState).toBe('closed')
  })

  // =========================================================================
  // Stress Scenario 3: Hung Signaling with Drain Expiry Surfaces Errors
  // =========================================================================
  it('Stress 3: Hung signaling during drain gracefully rejects stuck sends without memory leaks', async () => {
    let callIndex = 0
    const mockSignaling = {
      send: vi.fn().mockImplementation(async () => {
        callIndex++
        if (callIndex <= 5) {
          // First 5 messages succeed quickly
          return Promise.resolve()
        }
        // Messages 6-10 hang indefinitely (network blackhole)
        return new Promise<void>(() => {})
      })
    }

    const vdc = new VirtualDataChannel({
      label: 'stress-hung-dc',
      sessionId: 'sess-hung',
      getSignaling: () => mockSignaling as any,
      getSharedAesKey: () => mockAesKey,
      getTargetPeerId: () => 'host-peer'
    })

    vdc.open()
    vdc.startDrain(40, 40) // 40ms grace + 40ms flush cap

    const results: Array<{ idx: number; status: 'resolved' | 'rejected'; error?: string }> = []
    const promises: Promise<void>[] = []

    for (let i = 1; i <= 10; i++) {
      const p = vdc.sendAsync(`packet-${i}`)
        .then(() => {
          results.push({ idx: i, status: 'resolved' })
        })
        .catch((err) => {
          results.push({ idx: i, status: 'rejected', error: err?.message })
        })
      promises.push(p)
    }

    // Wait until grace (40ms) + cap (40ms) + margin = 120ms
    await new Promise((r) => setTimeout(r, 120))
    await Promise.all(promises)

    expect(vdc.readyState).toBe('closed')
    expect(vdc.isDraining).toBe(false)

    // First 5 must have resolved cleanly
    const resolved = results.filter((r) => r.status === 'resolved')
    expect(resolved.length).toBe(5)
    for (const r of resolved) {
      expect(r.idx).toBeLessThanOrEqual(5)
    }

    // Remaining 5 must have rejected with exact error
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected.length).toBe(5)
    for (const r of rejected) {
      expect(r.idx).toBeGreaterThan(5)
      expect(r.error).toMatch(/VirtualDataChannel closed before queued frame could be sent/)
    }
  })

  // =========================================================================
  // Stress Scenario 4: Message Ordering & Duplicate Reception across Hybrid Channels
  // =========================================================================
  it('Stress 4: Hybrid transport out-of-order and duplicate delivery is safely handled by stores', async () => {
    const inboxStore = useInboxStore()
    const recordsStore = useRecordStore()

    // 1. Direct Message Deduplication Test:
    // Peer receives M2 (over native DC), then M3 (over native DC), then M1 (delayed over VDC), then duplicate M2 (over VDC)
    const msg1 = { id: 'msg-id-1', title: 'Task 1', body: 'First task', timestamp: Date.now() - 3000 }
    const msg2 = { id: 'msg-id-2', title: 'Task 2', body: 'Second task', timestamp: Date.now() - 2000 }
    const msg3 = { id: 'msg-id-3', title: 'Task 3', body: 'Third task', timestamp: Date.now() - 1000 }

    // Delivery order: M2, M3, M1, duplicate M2
    inboxStore.addMessage(msg2 as any)
    inboxStore.addMessage(msg3 as any)
    inboxStore.addMessage(msg1 as any)
    inboxStore.addMessage(msg2 as any) // Duplicate

    // Assert: Only 3 unique messages exist; no duplicate of msg2
    expect(inboxStore.messages.length).toBe(3)
    const occurrencesOfM2 = inboxStore.messages.filter((m) => m.id === 'msg-id-2')
    expect(occurrencesOfM2.length).toBe(1)

    // 2. Scouting Record CRDT LWW Conflict Resolution Test:
    // Create baseline record in store
    const localRecord: ScoutingRecord = {
      id: 'rec-uuid-1',
      eventKey: '2026cmp',
      matchNumber: 1,
      teamNumber: '19827',
      scoutName: 'Alice',
      data: { score: 10 },
      version: 1,
      hostSeq: 10,
      timestamp: 1000,
      updatedAt: 1000
    }
    recordsStore.records = [localRecord]

    // A newer update arrives via Native DC: v2, hostSeq 11
    const newerNativeRecord: ScoutingRecord = {
      id: 'rec-uuid-1',
      eventKey: '2026cmp',
      matchNumber: 1,
      teamNumber: '19827',
      scoutName: 'Alice',
      data: { score: 25 },
      version: 2,
      hostSeq: 11,
      timestamp: 2000,
      updatedAt: 2000
    }
    recordsStore.bulkSync([newerNativeRecord])

    // Current state in store must be the newer version
    expect(recordsStore.records[0].version).toBe(2)
    expect(recordsStore.records[0].data.score).toBe(25)

    // Late-arriving stale packet from draining VDC: duplicate v1, hostSeq 10
    const staleVdcRecord: ScoutingRecord = {
      id: 'rec-uuid-1',
      eventKey: '2026cmp',
      matchNumber: 1,
      teamNumber: '19827',
      scoutName: 'Alice',
      data: { score: 10 },
      version: 1,
      hostSeq: 10,
      timestamp: 1000,
      updatedAt: 1000
    }
    recordsStore.bulkSync([staleVdcRecord])

    // Assert: CRDT LWW preserves version 2; stale packet was safely rejected
    expect(recordsStore.records[0].version).toBe(2)
    expect(recordsStore.records[0].data.score).toBe(25)
  })

  // =========================================================================
  // Stress Scenario 5: Teardown & Immediate Reconnection under Abnormal Drops
  // =========================================================================
  it('Stress 5: Abnormal session drop cleans up draining channels and prevents cross-session leaks', async () => {
    let clientDc: any = null
    let clientSender: any = null
    const sessionBMessages: string[] = []

    const mockSignaling = {
      send: vi.fn().mockResolvedValue(undefined)
    }

    let currentSessionId = 'session-A'
    let currentEpoch = 1

    const ctx: any = {
      sas: { clientSharedAesKey: mockAesKey },
      getClientSessionId: () => currentSessionId,
      getCurrentHostSessionId: () => 'host-1',
      getClientHostSenderId: () => 'host-peer-1',
      getClientDc: () => clientDc,
      setClientDc: (dc: any) => { clientDc = dc },
      getClientSender: () => clientSender,
      setClientSender: (sender: any) => { clientSender = sender },
      getClientPc: () => null,
      getLocalDeviceId: () => 'dev-client-1',
      getLocalEcdhPubHex: () => '04aabb',
      peerMgr: {
        markVirtualChannelActive: vi.fn(),
        updateTransportInfo: vi.fn(),
        currentTransportInfo: null
      },
      callbacks: {},
      setStatus: vi.fn(),
      handleChannelMessage: vi.fn().mockImplementation((ev: MessageEvent) => {
        sessionBMessages.push(ev.data)
      }),
      getSignaling: () => mockSignaling
    }

    const ctrl = createClientVirtualFallbackController({
      ctx,
      getAttemptEpoch: () => currentEpoch,
      clearFailedEpochIfMatch: vi.fn(),
      clearConnectWatchdog: vi.fn(),
      clearReconnectTimer: vi.fn(),
      startDataChannelHeartbeat: vi.fn(),
      checkAndScheduleSilentUpgrade: vi.fn().mockResolvedValue(undefined),
      getSilentUpgradeProbeCount: () => 0,
      incrementSilentUpgradeProbeCount: () => 1
    })

    // 1. Establish Session A and promote to draining
    ctrl.activateVirtualFallbackChannel(1, 'session-A')
    const sessionAVdc = ctrl.getActiveVirtualDc()!
    sessionAVdc.open()
    ctrl.closeActiveVirtualDc(true, true) // Upgrade: sessionAVdc is now draining

    expect(sessionAVdc.isDraining).toBe(true)
    expect(sessionAVdc.readyState).toBe('open')

    // 2. Abnormal network drop happens: client performs hard reset
    ctrl.closeActiveVirtualDc()
    expect(sessionAVdc.readyState).toBe('closed')
    expect(sessionAVdc.isDraining).toBe(false)

    // 3. Immediately establish Session B
    currentSessionId = 'session-B'
    currentEpoch = 2
    ctrl.activateVirtualFallbackChannel(2, 'session-B')
    const sessionBVdc = ctrl.getActiveVirtualDc()!
    sessionBVdc.open()
    expect(sessionBVdc.readyState).toBe('open')

    // 4. Stale frame arrives from old Session A over signaling
    const staleFrameA = await encryptSignalingData(
      mockAesKey,
      JSON.stringify({
        vdc: 'data',
        sessionId: 'session-A',
        payload: JSON.stringify({ type: 'DIRECT_MESSAGE', text: 'stale frame from session A' })
      })
    )
    await ctrl.handleIncomingEncryptedVirtualFrame(staleFrameA)

    // Frame from Session A must be ignored because sessionId != currentSessionId
    expect(sessionBMessages.length).toBe(0)

    // 5. Valid frame arrives for Session B
    const validFrameB = await encryptSignalingData(
      mockAesKey,
      JSON.stringify({
        vdc: 'data',
        sessionId: 'session-B',
        payload: JSON.stringify({ type: 'DIRECT_MESSAGE', text: 'valid frame for session B' })
      })
    )
    await ctrl.handleIncomingEncryptedVirtualFrame(validFrameB)

    // Frame for Session B must be accepted
    expect(sessionBMessages.length).toBe(1)
    expect(sessionBMessages[0]).toContain('valid frame for session B')

    // Cleanup
    ctrl.closeActiveVirtualDc()
    expect(sessionBVdc.readyState).toBe('closed')
  })

  // =========================================================================
  // Stress Scenario 6: Host Direct Message Burst Across Connecting and Draining Clients
  // =========================================================================
  it('Stress 6: Host direct message concurrent burst to multiple clients across native and draining channels', async () => {
    const mockSignaling = {
      send: vi.fn().mockResolvedValue(undefined)
    }

    // Client 1: Has Native DC OPEN
    const mockNativeDc1: any = {
      readyState: 'open',
      send: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    const sender1 = new DataChannelSender(mockNativeDc1)
    const client1: ClientEntry = {
      pc: {} as any,
      dc: mockNativeDc1,
      sender: sender1
    }

    // Client 2: Native DC CONNECTING, Draining Virtual DC OPEN
    const mockNativeDc2: any = {
      readyState: 'connecting',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    const drainingVdc2 = new VirtualDataChannel({
      label: 'vdc-client-2',
      sessionId: 'sess-c2',
      getSignaling: () => mockSignaling as any,
      getSharedAesKey: () => mockAesKey,
      getTargetPeerId: () => 'c2'
    })
    drainingVdc2.open()
    drainingVdc2.startDrain(5000)

    const sender2 = new DataChannelSender(mockNativeDc2)
    const client2: ClientEntry = {
      pc: {} as any,
      dc: mockNativeDc2,
      drainingVirtualDc: drainingVdc2,
      sender: sender2
    }

    const clientsMap = new Map<string, ClientEntry>([
      ['c1', client1],
      ['c2', client2]
    ])

    const dispatcher = createMessageDispatcher({
      isHostMode: () => true,
      getCurrentInviteCode: () => 'INV-BURST',
      getHostSessionId: () => 'host-burst',
      getLocalUserId: () => 'host-user',
      getLocalUserName: () => 'HostUser',
      clients: clientsMap,
      scoutIdToClientIds: new Map(),
      offlineMessages: { enqueue: vi.fn() } as any,
      sas: { clientSasStates: new Map(), hostPendingOutgoing: new Map() } as any
    })

    // Dispatch 20 concurrent messages to Client 1 (Native) and Client 2 (Draining)
    const sendOps: Promise<boolean>[] = []
    for (let i = 0; i < 20; i++) {
      sendOps.push(dispatcher.sendDirectMessage({
        targetId: 'c1',
        title: `Msg C1 #${i}`,
        body: `Body C1 #${i}`
      }))
      sendOps.push(dispatcher.sendDirectMessage({
        targetId: 'c2',
        title: `Msg C2 #${i}`,
        body: `Body C2 #${i}`
      }))
    }

    const results = await Promise.all(sendOps)
    // All 40 sends must succeed
    expect(results.every((res) => res === true)).toBe(true)

    // Assert Client 1's native sender sent 20 messages
    expect(mockNativeDc1.send).toHaveBeenCalledTimes(20)

    // Assert Client 2's draining DC sent 20 messages over signaling
    expect(mockSignaling.send).toHaveBeenCalledTimes(20)

    // Assert Client 2's sender was NOT mutated and remains bound to mockNativeDc2
    expect(client2.sender).toBe(sender2)
    expect((client2.sender as any).dc).toBe(mockNativeDc2)

    drainingVdc2.close()
  })
})
