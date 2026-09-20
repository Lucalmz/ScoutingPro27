import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DataChannelSender, BackpressureTimeoutError } from '@/services/dataChannelSender'

function createMockDataChannel(initialState: RTCDataChannelState = 'open', initialBufferedAmount = 0) {
  const listeners: Record<string, Function[]> = {}
  return {
    readyState: initialState,
    bufferedAmount: initialBufferedAmount,
    bufferedAmountLowThreshold: 0,
    send: vi.fn(),
    addEventListener: vi.fn((event: string, cb: Function) => {
      listeners[event] = listeners[event] || []
      listeners[event].push(cb)
    }),
    removeEventListener: vi.fn((event: string, cb: Function) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(fn => fn !== cb)
      }
    }),
    _triggerEvent: (event: string) => {
      if (listeners[event]) {
        listeners[event].forEach(cb => cb())
      }
    }
  } as unknown as RTCDataChannel & { _triggerEvent: (event: string) => void }
}

describe('DataChannelSender', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should send payload sequentially through queue when channel is open', async () => {
    const dc = createMockDataChannel('open', 0)
    const congestionCb = vi.fn()
    const sender = new DataChannelSender(dc, congestionCb)

    const p1 = sender.enqueueSend(JSON.stringify({ type: 'MSG1' }))
    const p2 = sender.enqueueSend(JSON.stringify({ type: 'MSG2' }))

    await Promise.all([p1, p2])

    expect(dc.send).toHaveBeenCalledTimes(2)
    expect(dc.send).toHaveBeenNthCalledWith(1, JSON.stringify({ type: 'MSG1' }))
    expect(dc.send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: 'MSG2' }))
  })

  it('should throw error when channel is not open', async () => {
    const dc = createMockDataChannel('closed', 0)
    const sender = new DataChannelSender(dc)

    await expect(sender.enqueueSend('test')).rejects.toThrow('DataChannel is not open')
  })

  it('should wait on backpressure until bufferedamountlow fires', async () => {
    const dc = createMockDataChannel('open', 40 * 1024) // 40 KiB > 32 KiB
    const congestionCb = vi.fn()
    const sender = new DataChannelSender(dc, congestionCb)

    let sendFinished = false
    const sendPromise = sender.enqueueSend('large_payload').then(() => {
      sendFinished = true
    })

    expect(congestionCb).toHaveBeenCalledWith(true)
    expect(sendFinished).toBe(false)
    expect(dc.send).not.toHaveBeenCalled()

    // Drain buffer and trigger low event
    ;(dc as any).bufferedAmount = 10 * 1024
    ;(dc as any)._triggerEvent('bufferedamountlow')

    await sendPromise
    expect(sendFinished).toBe(true)
    expect(dc.send).toHaveBeenCalledWith('large_payload')
  })

  it('should reject payloads exceeding MAX_PAYLOAD_SIZE (64 KiB)', async () => {
    const dc = createMockDataChannel('open', 0)
    const sender = new DataChannelSender(dc)
    const oversizedPayload = 'x'.repeat(65 * 1024)

    await expect(sender.enqueueSend(oversizedPayload)).rejects.toThrow('exceeds MAX_PAYLOAD_SIZE')
    expect(dc.send).not.toHaveBeenCalled()
  })

  it('should trigger pre-flight backpressure when bufferedAmount + payload > BUFFER_HIGH_WATERMARK', async () => {
    // 20 KiB current buffer (> 16 KiB low watermark) + 15 KiB payload = 35 KiB > 32 KiB high watermark
    const dc = createMockDataChannel('open', 20 * 1024)
    const congestionCb = vi.fn()
    const sender = new DataChannelSender(dc, congestionCb)
    const payload = 'x'.repeat(15 * 1024)

    let sendFinished = false
    const sendPromise = sender.enqueueSend(payload).then(() => {
      sendFinished = true
    })

    expect(congestionCb).toHaveBeenCalledWith(true)
    expect(sendFinished).toBe(false)
    expect(dc.send).not.toHaveBeenCalled()

    // Drain buffer below 16 KiB low watermark
    ;(dc as any).bufferedAmount = 8 * 1024
    ;(dc as any)._triggerEvent('bufferedamountlow')

    await sendPromise
    expect(sendFinished).toBe(true)
    expect(dc.send).toHaveBeenCalledWith(payload)
  })

  it('should trigger fail-fast when backpressure times out after 5000ms', async () => {
    const dc = createMockDataChannel('open', 50 * 1024)
    const congestionCb = vi.fn()
    const sender = new DataChannelSender(dc, congestionCb)

    const p1 = sender.enqueueSend('payload1')
    const p2 = sender.enqueueSend('payload2')
    const p3 = sender.enqueueSend('payload3')

    // Advance time by 5000ms to trigger backpressure timeout
    vi.advanceTimersByTime(5000)

    await expect(p1).rejects.toThrow(BackpressureTimeoutError)
    await expect(p2).rejects.toThrow('Queue aborted due to network congestion')
    await expect(p3).rejects.toThrow('Queue aborted due to network congestion')

    expect(sender.getQueueLength()).toBe(0)
  })
})
