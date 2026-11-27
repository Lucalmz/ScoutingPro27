import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DataChannelSender, BackpressureTimeoutError, SenderAbortedError } from '@/services/dataChannelSender'

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

    const p1Expect = expect(p1).rejects.toThrow(BackpressureTimeoutError)
    const p2Expect = expect(p2).rejects.toThrow('Queue aborted due to network congestion')
    const p3Expect = expect(p3).rejects.toThrow('Queue aborted due to network congestion')

    // Advance time by 5000ms to trigger backpressure timeout
    vi.advanceTimersByTime(5000)

    await Promise.all([p1Expect, p2Expect, p3Expect])
    expect(sender.getQueueLength()).toBe(0)
  })

  it('should cleanly abort active backpressure wait and queued items with SenderAbortedError', async () => {
    const dc = createMockDataChannel('open', 50 * 1024)
    const sender = new DataChannelSender(dc)

    const p1 = sender.enqueueSend('payload_in_backpressure')
    const p2 = sender.enqueueSend('payload_in_queue')

    const p1Expect = expect(p1).rejects.toThrow(SenderAbortedError)
    const p2Expect = expect(p2).rejects.toThrow(SenderAbortedError)

    expect(sender.isAborted()).toBe(false)
    sender.abort('Connection torn down')
    expect(sender.isAborted()).toBe(true)

    await Promise.all([p1Expect, p2Expect])
    expect(sender.getQueueLength()).toBe(0)

    // After abort, any new enqueueSend rejects immediately
    await expect(sender.enqueueSend('payload_after_abort')).rejects.toThrow(SenderAbortedError)
  })

  it('enqueueSendQuiet should never throw or reject on abort or error', async () => {
    const dc = createMockDataChannel('open', 50 * 1024)
    const sender = new DataChannelSender(dc)

    const quietPromise = sender.enqueueSendQuiet('quiet_payload', 'test-broadcast')
    sender.abort('Channel destroyed')

    const result = await quietPromise
    expect(result).toBe(false)

    // Call after abort
    const postAbortResult = await sender.enqueueSendQuiet('after_abort')
    expect(postAbortResult).toBe(false)
  })

  it('exposes bound RTCDataChannel via getChannel()', () => {
    const dc = createMockDataChannel('open', 0)
    const sender = new DataChannelSender(dc)
    expect(sender.getChannel()).toBe(dc)
  })

  it('high-priority control frames preempt queued 30 KiB chunks while preserving FIFO order within each lane', async () => {
    const dc = createMockDataChannel('open', 40 * 1024) // active backpressure blocks chunk 0
    const sender = new DataChannelSender(dc)

    const chunk0 = '0'.repeat(30 * 1024)
    const chunk1 = '1'.repeat(30 * 1024)
    const chunk2 = '2'.repeat(30 * 1024)
    const ping1 = JSON.stringify({ type: 'PING', seq: 1 })
    const clockReq2 = JSON.stringify({ type: 'CLOCK_SYNC_REQ', seq: 2 })

    const p0 = sender.enqueueSend(chunk0)
    const p1 = sender.enqueueSend(chunk1)
    const p2 = sender.enqueueSend(chunk2)
    const pHigh1 = sender.enqueueSend(ping1, { priority: 'high' })
    const pHigh2 = sender.enqueueSend(clockReq2, { priority: 'high' })

    // Positive prerequisite: chunk0 is paused in safeSendInternal; 4 tasks remain queued across both lanes
    expect(dc.send).not.toHaveBeenCalled()
    expect(sender.getQueueLength()).toBe(4)

    // Release backpressure -> chunk0 sends, then highQueue preempts chunk1 & chunk2 in FIFO order
    ;(dc as any).bufferedAmount = 0
    ;(dc as any)._triggerEvent('bufferedamountlow')

    await vi.advanceTimersByTimeAsync(10)
    await Promise.all([p0, p1, p2, pHigh1, pHigh2])

    expect(sender.getQueueLength()).toBe(0)
    expect(dc.send).toHaveBeenCalledTimes(5)
    expect((dc.send as any).mock.calls.map((c: any[]) => c[0])).toEqual([
      chunk0,
      ping1,
      clockReq2,
      chunk1,
      chunk2
    ])
  })

  it('re-checks bufferedAmount in a while loop on spurious/concurrent bufferedamountlow events without bursting and honors shared deadline', async () => {
    const dc = createMockDataChannel('open', 40 * 1024)
    ;(dc.send as any).mockImplementation((payload: string) => {
      ;(dc as any).bufferedAmount += payload.length
    })
    const sender = new DataChannelSender(dc)

    const chunk1 = 'a'.repeat(20 * 1024)
    const chunk2 = 'b'.repeat(20 * 1024)

    const p1 = sender.enqueueSend(chunk1)
    const p2 = sender.enqueueSend(chunk2)
    expect(dc.send).not.toHaveBeenCalled()

    // Spurious bufferedamountlow while bufferedAmount is still > 32 KiB: must NOT send
    ;(dc as any)._triggerEvent('bufferedamountlow')
    await Promise.resolve()
    expect(dc.send).not.toHaveBeenCalled()

    // Partial drain to 30 KiB (30 + 20 = 50 KiB > 32 KiB): while loop must re-check and stay paused
    ;(dc as any).bufferedAmount = 30 * 1024
    ;(dc as any)._triggerEvent('bufferedamountlow')
    await Promise.resolve()
    expect(dc.send).not.toHaveBeenCalled()

    // Drain to 0 -> chunk1 sends and refills bufferedAmount to 20 KiB
    ;(dc as any).bufferedAmount = 0
    ;(dc as any)._triggerEvent('bufferedamountlow')
    await p1
    expect(dc.send).toHaveBeenCalledTimes(1)
    expect(dc.send).toHaveBeenLastCalledWith(chunk1)

    // Advance 3ms pacing -> chunk2 sees 20 KiB + 20 KiB > 32 KiB and MUST pause (no burst!)
    await vi.advanceTimersByTimeAsync(3)
    expect(dc.send).toHaveBeenCalledTimes(1)

    // Drain below 12 KiB (10 + 20 = 30 KiB <= 32 KiB) -> chunk2 sends
    ;(dc as any).bufferedAmount = 10 * 1024
    ;(dc as any)._triggerEvent('bufferedamountlow')
    await p2
    expect(dc.send).toHaveBeenCalledTimes(2)
    expect(dc.send).toHaveBeenLastCalledWith(chunk2)

    // Verify shared deadline is not reset by spurious bufferedamountlow events
    const dcTimeout = createMockDataChannel('open', 40 * 1024)
    const senderTimeout = new DataChannelSender(dcTimeout)
    const pTimeout = senderTimeout.enqueueSend('c'.repeat(20 * 1024))
    const pTimeoutExpect = expect(pTimeout).rejects.toThrow(BackpressureTimeoutError)

    await vi.advanceTimersByTimeAsync(2500)
    ;(dcTimeout as any)._triggerEvent('bufferedamountlow') // spurious at 2.5s
    await vi.advanceTimersByTimeAsync(2400) // total 4.9s
    expect(dcTimeout.send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100) // reaches 5.0s deadline
    await pTimeoutExpect
  })

  it('sends small high-priority control frames between 32 KiB and 64 KiB, and pauses when > 64 KiB', async () => {
    const ping = JSON.stringify({ type: 'PING', ts: 123 })

    // Positive control: normal priority pauses at 48 KiB (> 32 KiB)
    const normalDc = createMockDataChannel('open', 48 * 1024)
    const normalSender = new DataChannelSender(normalDc)
    const normalPromise = normalSender.enqueueSend(ping, { priority: 'normal' })
    expect(normalDc.send).not.toHaveBeenCalled()
    ;(normalDc as any).bufferedAmount = 0
    ;(normalDc as any)._triggerEvent('bufferedamountlow')
    await normalPromise
    expect(normalDc.send).toHaveBeenCalledTimes(1)

    // Small high-priority frame sends immediately at 48 KiB (< 64 KiB control ceiling)
    const highDc = createMockDataChannel('open', 48 * 1024)
    const highSender = new DataChannelSender(highDc)
    await highSender.enqueueSend(ping, { priority: 'high' })
    expect(highDc.send).toHaveBeenCalledTimes(1)
    expect(highDc.send).toHaveBeenCalledWith(ping)

    // Small high-priority frame pauses when bufferedAmount + payload > 64 KiB
    ;(highDc as any).bufferedAmount = 65 * 1024
    let highResolved = false
    const pausedHighPromise = highSender.enqueueSend(ping, { priority: 'high' }).then(() => {
      highResolved = true
    })
    expect(highDc.send).toHaveBeenCalledTimes(1)
    expect(highResolved).toBe(false)

    // Draining to 50 KiB (below 64 KiB ceiling, still > 32 KiB) releases small high-priority frame
    ;(highDc as any).bufferedAmount = 50 * 1024
    ;(highDc as any)._triggerEvent('bufferedamountlow')
    await pausedHighPromise
    expect(highResolved).toBe(true)
    expect(highDc.send).toHaveBeenCalledTimes(2)
  })

  it('abort() rejects active backpressure wait and both highQueue and normal queue', async () => {
    const dc = createMockDataChannel('open', 70 * 1024) // > 64 KiB blocks even high-priority frames
    const sender = new DataChannelSender(dc)

    const pActive = sender.enqueueSend('active_normal')
    const pHigh = sender.enqueueSend(JSON.stringify({ type: 'PING' }), { priority: 'high' })
    const pNormal = sender.enqueueSend('queued_normal')

    expect(sender.getQueueLength()).toBe(2)

    const eActive = expect(pActive).rejects.toThrow(SenderAbortedError)
    const eHigh = expect(pHigh).rejects.toThrow(SenderAbortedError)
    const eNormal = expect(pNormal).rejects.toThrow(SenderAbortedError)

    sender.abort('Connection closed')
    await Promise.all([eActive, eHigh, eNormal])

    expect(sender.isAborted()).toBe(true)
    expect(sender.getQueueLength()).toBe(0)
    expect(dc.send).not.toHaveBeenCalled()
  })
})
