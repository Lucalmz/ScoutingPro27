// ============================================================
// DataChannelSender — FIFO Queue, Backpressure Detection,
// and Fail-Fast Congestion Circuit Breaker for WebRTC DataChannel
// ============================================================

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
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ payload, resolve, reject })
      this.processQueue()
    })
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
        console.error('[DataChannelSender] Send task failed:', err)
        task.reject(err)

        if (err instanceof BackpressureTimeoutError) {
          this.onCongestion?.(true)
          this.failFastRemaining(new Error('Queue aborted due to network congestion'))
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
      this.onCongestion?.(true)
      await new Promise<void>((resolve, reject) => {
        let resolved = false
        let intervalId: ReturnType<typeof setInterval> | null = null
        let timeoutId: ReturnType<typeof setTimeout> | null = null

        const cleanup = () => {
          if (intervalId) clearInterval(intervalId)
          if (timeoutId) clearTimeout(timeoutId)
          this.dc.removeEventListener('bufferedamountlow', onLow)
        }

        const done = () => {
          if (!resolved) {
            resolved = true
            cleanup()
            resolve()
          }
        }

        const onLow = () => done()

        this.dc.bufferedAmountLowThreshold = this.BUFFER_LOW_WATERMARK
        this.dc.addEventListener('bufferedamountlow', onLow)

        if (this.dc.bufferedAmount <= this.BUFFER_LOW_WATERMARK) {
          done()
          return
        }

        intervalId = setInterval(() => {
          if (this.dc.bufferedAmount <= this.BUFFER_LOW_WATERMARK || this.dc.readyState !== 'open') {
            done()
          }
        }, 100)

        timeoutId = setTimeout(() => {
          if (!resolved) {
            resolved = true
            cleanup()
            reject(new BackpressureTimeoutError(`Backpressure wait timeout (${this.MAX_BACKPRESSURE_TIMEOUT}ms)`))
          }
        }, this.MAX_BACKPRESSURE_TIMEOUT)
      })
    }

    this.dc.send(payload)
  }
}
