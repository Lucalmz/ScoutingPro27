import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setupSelfHealing } from '../services/webrtc/selfHealing'
import * as connectivity from '../services/webrtc/connectivity'

describe('setupSelfHealing', () => {
  let probeSpy: any
  let listeners: Record<string, Function[]> = {}

  beforeEach(() => {
    listeners = {}
    probeSpy = vi.spyOn(connectivity, 'probePublicConnectivity').mockResolvedValue(true)

    // Mock window & document event listeners
    vi.spyOn(window, 'addEventListener').mockImplementation((event: string, handler: any) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(handler)
    })
    vi.spyOn(window, 'removeEventListener').mockImplementation((event: string, handler: any) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(h => h !== handler)
      }
    })

    vi.spyOn(document, 'addEventListener').mockImplementation((event: string, handler: any) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(handler)
    })
    vi.spyOn(document, 'removeEventListener').mockImplementation((event: string, handler: any) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(h => h !== handler)
      }
    })

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reconnects when network comes online and probe succeeds', async () => {
    const reconnectNow = vi.fn().mockResolvedValue(true)
    const selfHealing = setupSelfHealing({
      getStatus: () => 'offline',
      reconnectNow
    })

    expect(listeners['online']).toBeDefined()
    await listeners['online'][0]()

    expect(probeSpy).toHaveBeenCalled()
    expect(reconnectNow).toHaveBeenCalledTimes(1)
    selfHealing.dispose()
  })

  it('detects zombie connection on resume and triggers reconnectNow when ping fails', async () => {
    const reconnectNow = vi.fn().mockResolvedValue(true)
    const pingPeer = vi.fn().mockResolvedValue(false) // Ping fails (zombie connection)

    const selfHealing = setupSelfHealing({
      getStatus: () => 'connected', // Still says 'connected' in memory
      reconnectNow,
      pingPeer
    })

    expect(listeners['visibilitychange']).toBeDefined()
    await listeners['visibilitychange'][0]()

    expect(pingPeer).toHaveBeenCalled()
    expect(reconnectNow).toHaveBeenCalledTimes(1)
    selfHealing.dispose()
  })

  it('does not reconnect on resume if pingPeer succeeds', async () => {
    const reconnectNow = vi.fn().mockResolvedValue(true)
    const pingPeer = vi.fn().mockResolvedValue(true) // Ping succeeds (healthy)

    const selfHealing = setupSelfHealing({
      getStatus: () => 'connected',
      reconnectNow,
      pingPeer
    })

    await listeners['visibilitychange'][0]()

    expect(pingPeer).toHaveBeenCalled()
    expect(reconnectNow).not.toHaveBeenCalled()
    selfHealing.dispose()
  })

  it('responds to pageshow event (iOS Safari bfcache resume)', async () => {
    const reconnectNow = vi.fn().mockResolvedValue(true)
    const selfHealing = setupSelfHealing({
      getStatus: () => 'offline',
      reconnectNow
    })

    expect(listeners['pageshow']).toBeDefined()
    await listeners['pageshow'][0]()

    expect(reconnectNow).toHaveBeenCalledTimes(1)
    expect(reconnectNow).toHaveBeenCalledWith(true)
    selfHealing.dispose()
  })

  it('triggers reconnectNow(true) on resume when status is stuck in connecting', async () => {
    const reconnectNow = vi.fn().mockResolvedValue(true)
    const selfHealing = setupSelfHealing({
      getStatus: () => 'connecting',
      reconnectNow
    })

    expect(listeners['visibilitychange']).toBeDefined()
    await listeners['visibilitychange'][0]()

    expect(reconnectNow).toHaveBeenCalledTimes(1)
    expect(reconnectNow).toHaveBeenCalledWith(true)
    selfHealing.dispose()
  })
})
