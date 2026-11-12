import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VirtualDataChannel } from '@/services/webrtc/virtualDataChannel'
import { createClientVirtualFallbackController } from '@/services/webrtc/clientVirtualFallback'
import { createMessageDispatcher } from '@/services/webrtc/messageDispatcher'
import { DataChannelSender } from '@/services/dataChannelSender'
import { encryptSignalingData, decryptSignalingData } from '@/utils/crypto'
import type { ClientEntry } from '@/services/webrtc/types'

describe('WebRTC Hot-Upgrade Drain & Transition Hardening (CR-3)', () => {
  let mockAesKey: CryptoKey

  beforeEach(async () => {
    mockAesKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  })

  // =========================================================================
  // Requirement 1a: VDC queued send during the switch
  // =========================================================================
  it('1a. delivers queued VDC send during hot-upgrade switch (isDraining=true)', async () => {
    const sentSignalingPayloads: any[] = []
    const mockSignaling = {
      send: vi.fn().mockImplementation(async (payload, target) => {
        sentSignalingPayloads.push({ payload, target })
      })
    }

    const vdc = new VirtualDataChannel({
      label: 'scoutingpro-data-virtual',
      sessionId: 'session-switch-1a',
      getSignaling: () => mockSignaling as any,
      getSharedAesKey: () => mockAesKey,
      getTargetPeerId: () => 'host-peer-1'
    })

    // 1. Channel opens initially
    vdc.open()
    expect(vdc.readyState).toBe('open')
    expect(vdc.isDraining).toBe(false)

    // 2. Hot-upgrade begins: start drain with 5000ms grace
    vdc.startDrain(5000)
    expect(vdc.readyState).toBe('open')
    expect(vdc.isDraining).toBe(true)

    // 3. Queue a send during the switch while in draining mode
    const testData = JSON.stringify({ type: 'DIRECT_MESSAGE', text: 'queued during switch' })
    const sendPromise = vdc.sendAsync(testData)

    // 4. Assert send completes successfully
    await expect(sendPromise).resolves.toBeUndefined()
    expect(mockSignaling.send).toHaveBeenCalledTimes(1)
    expect(sentSignalingPayloads.length).toBe(1)

    // 5. Verify the frame payload is encrypted and contains exact message
    const rawFrame = sentSignalingPayloads[0].payload
    expect(rawFrame.clientSessionId).toBe('session-switch-1a')
    const decryptedJson = await decryptSignalingData(mockAesKey, rawFrame.encrypted)
    const frameObj = JSON.parse(decryptedJson)
    expect(frameObj.vdc).toBe('data')
    expect(frameObj.payload).toBe(testData)

    // Cleanup
    vdc.close()
    expect(vdc.readyState).toBe('closed')
    expect(vdc.isDraining).toBe(false)
  })

  // =========================================================================
  // Requirement 1b: Inbound frame arriving after the switch
  // =========================================================================
  it('1b. receives inbound frame arriving after the switch via drainingVirtualDc', async () => {
    const receivedMessages: string[] = []
    const mockSignaling = {
      send: vi.fn().mockResolvedValue(undefined)
    }

    let clientDc: any = null
    let clientSender: any = null
    const ctx: any = {
      sas: {
        clientSharedAesKey: mockAesKey
      },
      getClientSessionId: () => 'session-upgrade-1b',
      getCurrentHostSessionId: () => 'host-sess-1',
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
      callbacks: {
        onIceStalled: vi.fn()
      },
      setStatus: vi.fn(),
      handleChannelMessage: vi.fn().mockImplementation((ev: MessageEvent) => {
        receivedMessages.push(ev.data)
      }),
      getSignaling: () => mockSignaling
    }

    const ctrl = createClientVirtualFallbackController({
      ctx,
      getAttemptEpoch: () => 1,
      clearFailedEpochIfMatch: vi.fn(),
      clearConnectWatchdog: vi.fn(),
      clearReconnectTimer: vi.fn(),
      startDataChannelHeartbeat: vi.fn(),
      checkAndScheduleSilentUpgrade: vi.fn().mockResolvedValue(undefined),
      getSilentUpgradeProbeCount: () => 0,
      incrementSilentUpgradeProbeCount: () => 1
    })

    // 1. Fallback channel activated and opened
    ctrl.activateVirtualFallbackChannel(1, 'session-upgrade-1b')
    const activeVdc = ctrl.getActiveVirtualDc()!
    expect(activeVdc).toBeDefined()
    activeVdc.open()
    expect(activeVdc.readyState).toBe('open')

    // 2. Native UDP hot-upgrade occurs: switch activeVirtualDc to draining mode
    ctrl.closeActiveVirtualDc(true, true)
    expect(ctrl.getActiveVirtualDc()).toBeNull() // activeVirtualDc is now null (native took over)
    expect(activeVdc.isDraining).toBe(true)

    // 3. Inbound frame arrives over signaling (MQTT/TLS) from Host after the switch
    const inboundPayload = JSON.stringify({
      type: 'DIRECT_MESSAGE',
      messageId: 'msg-late-inbound-1',
      body: 'Hello from host over draining VDC!'
    })
    const encryptedFrame = await encryptSignalingData(
      mockAesKey,
      JSON.stringify({
        vdc: 'data',
        sessionId: 'session-upgrade-1b',
        payload: inboundPayload
      })
    )

    await ctrl.handleIncomingEncryptedVirtualFrame(encryptedFrame)

    // 4. Assert exact delivery to message listener
    expect(ctx.handleChannelMessage).toHaveBeenCalledTimes(1)
    expect(receivedMessages).toContain(inboundPayload)

    // Cleanup
    ctrl.closeActiveVirtualDc()
  })

  // =========================================================================
  // Requirement 1c & Requirement 2: Send still pending after grace period (Flush cap & error surfacing)
  // =========================================================================
  it('1c & 2. flush-before-close cap expires on hung send and surfaces rejection error (no silent loss)', async () => {
    let resolveHangingSend: (() => void) | null = null
    const hangingPromise = new Promise<void>((resolve) => {
      resolveHangingSend = resolve
    })

    const mockSignaling = {
      send: vi.fn().mockReturnValue(hangingPromise) // Simulates hung signaling network
    }

    const vdc = new VirtualDataChannel({
      label: 'scoutingpro-data-virtual',
      sessionId: 'session-pending-1c',
      getSignaling: () => mockSignaling as any,
      getSharedAesKey: () => mockAesKey,
      getTargetPeerId: () => 'host-peer-1'
    })

    vdc.open()

    // Start drain with 30ms grace period and 30ms flush cap
    vdc.startDrain(30, 30)
    expect(vdc.isDraining).toBe(true)

    // Enqueue send while draining
    const pendingSendPromise = vdc.sendAsync('msg-should-fail-on-timeout')

    // Wait until grace period (30ms) + flush cap (30ms) expire
    await new Promise((r) => setTimeout(r, 90))

    // Assert state transitions
    expect(vdc.readyState).toBe('closed')
    expect(vdc.isDraining).toBe(false)

    // Assert that the pending send REJECTS and error is surfaced (not swallowed)
    await expect(pendingSendPromise).rejects.toThrow(
      /VirtualDataChannel closed before queued frame could be sent/
    )

    // Cleanup
    resolveHangingSend?.()
  })

  // =========================================================================
  // Requirement 2: Flush-before-close completes sendChain if it settles within cap
  // =========================================================================
  it('2. flush-before-close delivers pending sends when sendChain settles within flush cap', async () => {
    let resolveSend: (() => void) | null = null
    const mockSignaling = {
      send: vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => {
          resolveSend = resolve
        })
      })
    }

    const vdc = new VirtualDataChannel({
      label: 'scoutingpro-data-virtual',
      sessionId: 'session-flush-settles',
      getSignaling: () => mockSignaling as any,
      getSharedAesKey: () => mockAesKey,
      getTargetPeerId: () => 'host-peer-1'
    })

    vdc.open()

    // 1. Start drain: 20ms grace, 100ms flush cap
    let drainCompleted = false
    vdc.startDrain(20, 100, () => {
      drainCompleted = true
    })

    // 2. Enqueue send while draining
    const sendPromise = vdc.sendAsync('msg-settles-during-flush')

    // 3. Wait 30ms: grace period expired, channel is in flush waiting for sendChain
    await new Promise((r) => setTimeout(r, 30))
    expect(vdc.isDraining).toBe(true)
    expect(vdc.readyState).toBe('open')
    expect(drainCompleted).toBe(false)

    // 4. Resolve the pending send within flush cap
    resolveSend?.()
    await expect(sendPromise).resolves.toBeUndefined()

    // 5. Channel flushes and formally closes cleanly
    await new Promise((r) => setTimeout(r, 20))
    expect(vdc.readyState).toBe('closed')
    expect(drainCompleted).toBe(true)
  })

  // =========================================================================
  // Requirement 3: Side effect in messageDispatcher.sendDirectMessage (host)
  // =========================================================================
  it('3. host sendDirectMessage does NOT mutate targetClient.sender when dispatching via draining DC', async () => {
    const mockSignaling = {
      send: vi.fn().mockResolvedValue(undefined)
    }

    const drainingVdc = new VirtualDataChannel({
      label: 'draining-dc',
      sessionId: 'sess-host-direct',
      getSignaling: () => mockSignaling as any,
      getSharedAesKey: () => mockAesKey,
      getTargetPeerId: () => 'client-peer-1'
    })
    drainingVdc.open()
    drainingVdc.startDrain(5000)

    // Mock native DC that is still connecting
    const mockNativeDc: any = {
      readyState: 'connecting',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    const nativeSender = new DataChannelSender(mockNativeDc)

    const clientEntry: ClientEntry = {
      pc: {} as any,
      dc: mockNativeDc,
      drainingVirtualDc: drainingVdc,
      sender: nativeSender // sender initially bound to nativeDc
    }

    const clientsMap = new Map<string, ClientEntry>()
    clientsMap.set('client-peer-1', clientEntry)

    const dispatcher = createMessageDispatcher({
      isHostMode: () => true,
      getCurrentInviteCode: () => 'INV-TEST',
      getHostSessionId: () => 'host-sess-1',
      getLocalUserId: () => 'host-user-id',
      getLocalUserName: () => 'HostUser',
      clients: clientsMap,
      scoutIdToClientIds: new Map(),
      offlineMessages: {
        enqueue: vi.fn()
      } as any,
      sas: {
        clientSasStates: new Map(),
        hostPendingOutgoing: new Map()
      } as any
    })

    // Dispatch direct message to client-peer-1
    const delivered = await dispatcher.sendDirectMessage({
      targetId: 'client-peer-1',
      title: 'Direct Msg',
      body: 'Hello client'
    })

    expect(delivered).toBe(true)

    // CRITICAL ASSERTION: targetClient.sender was NOT overwritten with draining channel
    expect(clientEntry.sender).toBe(nativeSender)
    expect((clientEntry.sender as any).dc).toBe(mockNativeDc)

    drainingVdc.close()
  })

  // =========================================================================
  // Requirement 4: Teardown leak (client & host)
  // =========================================================================
  it('4. closeActiveVirtualDc() cleans up drainingVirtualDc when activeVirtualDc is null on hard reset', () => {
    let clientDc: any = null
    let clientSender: any = null
    const ctx: any = {
      sas: { clientSharedAesKey: mockAesKey },
      getClientSessionId: () => 'session-leak-test',
      getCurrentHostSessionId: () => 'host-1',
      getClientHostSenderId: () => 'host-peer-1',
      getClientDc: () => clientDc,
      setClientDc: (dc: any) => { clientDc = dc },
      getClientSender: () => clientSender,
      setClientSender: (sender: any) => { clientSender = sender },
      getClientPc: () => null,
      getLocalDeviceId: () => 'dev-1',
      getLocalEcdhPubHex: () => '041122',
      peerMgr: {
        markVirtualChannelActive: vi.fn(),
        updateTransportInfo: vi.fn()
      },
      callbacks: {},
      setStatus: vi.fn(),
      handleChannelMessage: vi.fn(),
      getSignaling: () => ({ send: vi.fn().mockResolvedValue(undefined) })
    }

    const ctrl = createClientVirtualFallbackController({
      ctx,
      getAttemptEpoch: () => 1,
      clearFailedEpochIfMatch: vi.fn(),
      clearConnectWatchdog: vi.fn(),
      clearReconnectTimer: vi.fn(),
      startDataChannelHeartbeat: vi.fn(),
      checkAndScheduleSilentUpgrade: vi.fn().mockResolvedValue(undefined),
      getSilentUpgradeProbeCount: () => 0,
      incrementSilentUpgradeProbeCount: () => 1
    })

    // 1. Activate fallback
    ctrl.activateVirtualFallbackChannel(1, 'session-leak-test')
    const vdc = ctrl.getActiveVirtualDc()!
    vdc.open()

    // 2. Hot-upgrade: activeVirtualDc becomes null, vdc moves to draining
    ctrl.closeActiveVirtualDc(true, true)
    expect(ctrl.getActiveVirtualDc()).toBeNull()
    expect(vdc.isDraining).toBe(true)
    expect(vdc.readyState).toBe('open')

    // 3. ClientSession performs hard reset (closeActiveVirtualDc() with no args)
    ctrl.closeActiveVirtualDc()

    // 4. Draining channel must be formally closed immediately
    expect(vdc.readyState).toBe('closed')
    expect(vdc.isDraining).toBe(false)
  })

  // =========================================================================
  // Requirement 5: Single timer ownership
  // =========================================================================
  it('5. single timer ownership: VirtualDataChannel owns the drain timer and cancels on early close', async () => {
    const vdc = new VirtualDataChannel({
      label: 'vdc-timer-test',
      sessionId: 'sess-timer',
      getSignaling: () => null,
      getSharedAesKey: () => null,
      getTargetPeerId: () => undefined
    })

    vdc.open()

    let drainCallbackFired = false
    vdc.startDrain(100, 50, () => {
      drainCallbackFired = true
    })

    expect(vdc.isDraining).toBe(true)

    // Immediate explicit close before timer fires
    vdc.close()
    expect(vdc.readyState).toBe('closed')
    expect(vdc.isDraining).toBe(false)

    // Wait past the timer duration
    await new Promise((r) => setTimeout(r, 120))

    // Callback should not have fired after explicit close
    expect(drainCallbackFired).toBe(false)
  })
})
