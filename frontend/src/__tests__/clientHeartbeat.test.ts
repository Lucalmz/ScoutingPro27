import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createClientHeartbeatManager } from '../services/webrtc/clientHeartbeat'
import type { ClientSessionContext } from '../services/webrtc/clientSession'

describe('clientHeartbeat - Ping/Pong RTT, Degraded & Rebuild Escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as any).__TEST_HEARTBEAT_INTERVAL_MS__ = 100
    ;(globalThis as any).__TEST_PING_TIMEOUT_MS__ = 50
  })

  afterEach(() => {
    delete (globalThis as any).__TEST_HEARTBEAT_INTERVAL_MS__
    delete (globalThis as any).__TEST_PING_TIMEOUT_MS__
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function makeHeartbeatHarness(opts?: { initialRttMs?: number | null; initialQueueLength?: number }) {
    let status = 'connected'
    let epoch = 1
    let clientDc: any = { readyState: 'open', bufferedAmount: 0 }
    let clientPc: any = { connectionState: 'connected' }
    let queueLength = opts?.initialQueueLength ?? 0
    const sentMessages: any[] = []
    const failAttempt = vi.fn()
    const onTransportInfoChanged = vi.fn()
    const onHostDisconnected = vi.fn()
    const resetTransportInfo = vi.fn()
    const updateTransportInfo = vi.fn().mockResolvedValue(undefined)

    const ctx: Partial<ClientSessionContext> = {
      getClientDc: () => clientDc,
      getClientPc: () => clientPc,
      getClientSender: () => ({ getQueueLength: () => queueLength }) as any,
      getStatus: () => status,
      setStatus: (s) => { status = s },
      sendMessage: vi.fn(async (msg) => {
        sentMessages.push(msg)
      }),
      peerMgr: {
        currentTransportInfo: { type: 'p2p', rttMs: opts?.initialRttMs ?? null },
        resetTransportInfo,
        updateTransportInfo
      } as any,
      sas: {
        clientSecurityFingerprint: 'ABCD-1234'
      } as any,
      callbacks: {
        onTransportInfoChanged,
        onHostDisconnected
      } as any
    }

    const mgr = createClientHeartbeatManager({
      ctx: ctx as ClientSessionContext,
      getAttemptEpoch: () => epoch,
      getActiveVirtualDc: () => null,
      failAttempt
    })

    return {
      mgr,
      sentMessages,
      failAttempt,
      onTransportInfoChanged,
      onHostDisconnected,
      resetTransportInfo,
      updateTransportInfo,
      getStatus: () => status,
      setDc: (dc: any) => { clientDc = dc },
      setQueueLength: (len: number) => { queueLength = len },
      setEpoch: (e: number) => { epoch = e }
    }
  }

  it('measures RTT on handlePong and resolves pingHost true', async () => {
    const h = makeHeartbeatHarness()
    const pingPromise = h.mgr.pingHost(200)
    expect(h.sentMessages).toHaveLength(1)
    const ts = h.sentMessages[0].timestamp

    vi.advanceTimersByTime(25)
    h.mgr.handlePong(ts)
    await expect(pingPromise).resolves.toBe(true)
  })

  it('returns false from pingHost when DataChannel is closed or send throws', async () => {
    const h = makeHeartbeatHarness()
    h.setDc({ readyState: 'closed' })
    await expect(h.mgr.pingHost(100)).resolves.toBe(false)

    h.setDc({ readyState: 'open' })
    const p = h.mgr.pingHost(50)
    h.mgr.abortPendingPings()
    await expect(p).resolves.toBe(false)
  })

  it('marks degraded after 2 misses, restores connected on pong, and calls failAttempt after 8 misses', async () => {
    const h = makeHeartbeatHarness()
    h.mgr.startDataChannelHeartbeat()

    // 2 consecutive missed pings -> degraded
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(60)
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(60)

    expect(h.getStatus()).toBe('degraded')
    expect(h.resetTransportInfo).toHaveBeenCalledTimes(1)
    expect(h.onHostDisconnected).toHaveBeenCalledTimes(1)
    expect(h.failAttempt).not.toHaveBeenCalled()

    // Remaining 6 misses (total 8) -> failAttempt('heartbeat_timeout')
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(60)
    }
    expect(h.failAttempt).toHaveBeenCalledWith(1, 'heartbeat_timeout')
    h.mgr.stopDataChannelHeartbeat()
  })

  it('recovers degraded -> connected and resets miss counter when a late PONG arrives after timeout', async () => {
    const h = makeHeartbeatHarness()
    h.mgr.startDataChannelHeartbeat()

    // 2 misses -> degraded (tick at 100ms, timeout at 150ms; tick at 200ms, timeout at 250ms)
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(50)

    expect(h.getStatus()).toBe('degraded')
    expect(h.sentMessages.length).toBe(2)

    // Late PONG for the already timed-out first PING arrives
    h.mgr.handlePong(h.sentMessages[0].timestamp)
    expect(h.getStatus()).toBe('connected')
    expect(h.updateTransportInfo).toHaveBeenCalled()

    // Counter must be reset to 0: 7 more misses should NOT trigger rebuild yet, only 8th does
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(h.getStatus()).toBe('degraded')
    expect(h.failAttempt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(50)
    expect(h.failAttempt).toHaveBeenCalledWith(1, 'heartbeat_timeout')
    h.mgr.stopDataChannelHeartbeat()
  })

  it('holds off heartbeat_timeout rebuild across 10+ ticks while bulk transfer makes drain progress', async () => {
    const h = makeHeartbeatHarness({ initialQueueLength: 20 })
    const dc: any = { readyState: 'open', bufferedAmount: 200_000 }
    h.setDc(dc)
    h.mgr.startDataChannelHeartbeat()

    // Simulate 12 consecutive missed PINGs while SCTP buffer & sender queue steadily drain
    await vi.advanceTimersByTimeAsync(100)
    for (let i = 0; i < 12; i++) {
      dc.bufferedAmount = Math.max(1000, dc.bufferedAmount - 15_000)
      h.setQueueLength(Math.max(1, 20 - i))
      await vi.advanceTimersByTimeAsync(50)
      if (i < 11) {
        await vi.advanceTimersByTimeAsync(50)
      }
    }

    expect(h.getStatus()).toBe('degraded')
    expect(h.onHostDisconnected).toHaveBeenCalledTimes(1)
    expect(h.failAttempt).not.toHaveBeenCalled()
    h.mgr.stopDataChannelHeartbeat()
  })

  it('triggers failAttempt heartbeat_timeout at 8 misses when SCTP buffer is wedged at constant 50000', async () => {
    const h = makeHeartbeatHarness({ initialQueueLength: 0 })
    h.setDc({ readyState: 'open', bufferedAmount: 50_000 })
    h.mgr.startDataChannelHeartbeat()

    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(50)
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(h.getStatus()).toBe('degraded')
    expect(h.failAttempt).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(50)
    expect(h.failAttempt).toHaveBeenCalledWith(1, 'heartbeat_timeout')
    h.mgr.stopDataChannelHeartbeat()
  })

  it('computes adaptive RTT timeout (rttMs=200 -> 2000ms) when __TEST_PING_TIMEOUT_MS__ is unset', async () => {
    delete (globalThis as any).__TEST_PING_TIMEOUT_MS__
    ;(globalThis as any).__TEST_HEARTBEAT_INTERVAL_MS__ = 2500

    const h = makeHeartbeatHarness({ initialRttMs: 200 })
    h.mgr.startDataChannelHeartbeat()

    // Tick 1 at 2500ms -> PING[0]
    await vi.advanceTimersByTimeAsync(2500)
    expect(h.sentMessages).toHaveLength(1)

    // PONG after 1500ms (< 2000ms adaptive timeout) must succeed and keep miss counter at 0
    await vi.advanceTimersByTimeAsync(1500)
    h.mgr.handlePong(h.sentMessages[0].timestamp)
    expect(h.getStatus()).toBe('connected')

    // Tick 2 at 5000ms -> PING[1], no PONG past 2000ms -> 1 miss (still connected, proving Tick 1 survived)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.sentMessages).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2005)
    expect(h.getStatus()).toBe('connected')

    // Tick 3 at 7500ms -> PING[2], no PONG past 2000ms -> 2nd miss -> degraded
    await vi.advanceTimersByTimeAsync(495)
    expect(h.sentMessages).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(2005)
    expect(h.getStatus()).toBe('degraded')
    expect(h.onHostDisconnected).toHaveBeenCalledTimes(1)

    h.mgr.stopDataChannelHeartbeat()
  })
})
