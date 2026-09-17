// ============================================================
// DataChannelSender — FIFO Queue, Backpressure Detection,
// and Fail-Fast Congestion Circuit Breaker for WebRTC DataChannel
// ============================================================

import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:Sender')

export class BackpressureTimeoutError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'BackpressureTimeoutError'
  }
}

export class DataChannelSender {
  private queue: Array<{
    payload: string
    resolve: () => void
    reject: (err: any) => void
  }> = []
  private isProcessing = false

  public readonly BUFFER_HIGH_WATERMARK = 64 * 1024 // 64 KiB
  public readonly BUFFER_LOW_WATERMARK = 32 * 1024  // 32 KiB
  public readonly MAX_BACKPRESSURE_TIMEOUT = 5000   // 5s 超时熔断

  constructor(
    private dc: RTCDataChannel,
    private onCongestion?: (isCongested: boolean) => void
  ) {}

  public getQueueLength(): number {
    return this.queue.length
  }

  public enqueueSend(payload: string): Promise<void> {
    if (this.dc.readyState === 'closed' || this.dc.readyState === 'closing') {
      return Promise.reject(new Error(`DataChannel is not open (state: ${this.dc.readyState})`))
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ payload, resolve, reject })
      this.processQueue()
    })
  }

  public abort(reason = 'DataChannel sender aborted'): void {
    this.failFastRemaining(new Error(reason))
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    while (this.queue.length > 0) {
      const task = this.queue.shift()
      if (!task) break

      try {
        await this.safeSendInternal(task.payload)
        task.resolve()
        this.onCongestion?.(false)
      } catch (err) {
        log.error('Send task failed:', err)
        task.reject(err)

        if (err instanceof BackpressureTimeoutError) {
          log.warn('Backpressure timeout reached. Signaling congestion and aborting remaining queued tasks.')
          this.onCongestion?.(true)
          this.failFastRemaining(new Error('Queue aborted due to network congestion'))
          break
        }

        if (this.dc.readyState === 'closed' || this.dc.readyState === 'closing') {
          log.warn(`Queue aborted: DataChannel is ${this.dc.readyState}`)
          this.failFastRemaining(new Error(`Queue aborted: DataChannel is ${this.dc.readyState}`))
          break
        }
      }
    }

    this.isProcessing = false
  }

  private failFastRemaining(error: Error) {
    while (this.queue.length > 0) {
      const remaining = this.queue.shift()
      remaining?.reject(error)
    }
  }

  private async safeSendInternal(payload: string): Promise<void> {
    if (this.dc.readyState !== 'open') {
      throw new Error(`DataChannel is not open (state: ${this.dc.readyState})`)
    }

    if (this.dc.bufferedAmount > this.BUFFER_HIGH_WATERMARK) {
      log.warn(`DataChannel buffer exceeded high watermark (${this.dc.bufferedAmount} bytes > ${this.BUFFER_HIGH_WATERMARK}). Pausing sender for backpressure relief.`)
      this.onCongestion?.(true)
      await new Promise<void>((resolve, reject) => {
        let finished = false
        let intervalId: ReturnType<typeof setInterval> | null = null
        let timeoutId: ReturnType<typeof setTimeout> | null = null

        const cleanup = () => {
          if (intervalId) clearInterval(intervalId)
          if (timeoutId) clearTimeout(timeoutId)
          this.dc.removeEventListener('bufferedamountlow', onLow)
          this.dc.removeEventListener('close', onClose)
          this.dc.removeEventListener('error', onClose)
        }

        const done = () => {
          if (!finished) {
            finished = true
            cleanup()
            resolve()
          }
        }

        const onClose = () => {
          if (!finished) {
            finished = true
            cleanup()
            reject(new Error('DataChannel closed while waiting for backpressure relief'))
          }
        }

        const onLow = () => done()

        this.dc.bufferedAmountLowThreshold = this.BUFFER_LOW_WATERMARK
        this.dc.addEventListener('bufferedamountlow', onLow)
        this.dc.addEventListener('close', onClose)
        this.dc.addEventListener('error', onClose)

        if (this.dc.bufferedAmount <= this.BUFFER_LOW_WATERMARK) {
          done()
          return
        }

        intervalId = setInterval(() => {
          if (this.dc.readyState !== 'open') {
            onClose()
          } else if (this.dc.bufferedAmount <= this.BUFFER_LOW_WATERMARK) {
            done()
          }
        }, 100)

        timeoutId = setTimeout(() => {
          if (!finished) {
            finished = true
            cleanup()
            reject(new BackpressureTimeoutError(`Backpressure wait timeout (${this.MAX_BACKPRESSURE_TIMEOUT}ms)`))
          }
        }, this.MAX_BACKPRESSURE_TIMEOUT)
      })
    }

    if (this.dc.readyState !== 'open') {
      throw new Error(`DataChannel closed before send (current state: ${this.dc.readyState})`)
    }

    this.dc.send(payload)
  }
}
