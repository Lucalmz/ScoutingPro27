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

export class SenderAbortedError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'SenderAbortedError'
  }
}

export class DataChannelSender {
  private queue: Array<{
    payload: string
    resolve: () => void
    reject: (err: any) => void
  }> = []
  private isProcessing = false
  private aborted = false
  /** 当前正在背压等待中的任务的取消句柄（abort 时需要一并拒绝，否则会遗留一个无人观察的 pending 任务） */
  private cancelBackpressureWait: ((err: Error) => void) | null = null

  public readonly BUFFER_HIGH_WATERMARK = 32 * 1024 // 32 KiB
  public readonly BUFFER_LOW_WATERMARK = 16 * 1024  // 16 KiB
  public readonly MAX_PAYLOAD_SIZE = 64 * 1024      // 64 KiB
  public readonly MAX_BACKPRESSURE_TIMEOUT = 5000   // 5s 超时熔断

  constructor(
    private dc: RTCDataChannel,
    private onCongestion?: (isCongested: boolean) => void
  ) {}

  public getQueueLength(): number {
    return this.queue.length
  }

  public isAborted(): boolean {
    return this.aborted
  }

  public enqueueSend(payload: string): Promise<void> {
    if (this.aborted) {
      return Promise.reject(new SenderAbortedError('DataChannel sender aborted'))
    }
    if (this.dc.readyState === 'closed' || this.dc.readyState === 'closing') {
      return Promise.reject(new Error(`DataChannel is not open (state: ${this.dc.readyState})`))
    }
    if (payload.length > this.MAX_PAYLOAD_SIZE) {
      return Promise.reject(
        new Error(
          `Payload size ${payload.length} bytes exceeds MAX_PAYLOAD_SIZE (${this.MAX_PAYLOAD_SIZE} bytes). Message must be chunked at application layer.`
        )
      )
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ payload, resolve, reject })
      this.processQueue()
    })
  }

  /**
   * 发后即忘（fire-and-forget）专用：永不 reject。对端中途断开 / 队列被中止 / 背压超时都只记录日志并返回 false，
   * 杜绝 “Uncaught (in promise) DataChannel closed while waiting for backpressure relief”。
   */
  public enqueueSendQuiet(payload: string, label = 'message'): Promise<boolean> {
    return this.enqueueSend(payload).then(
      () => true,
      (err) => {
        log.warn(`Dropped ${label}: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    )
  }

  /**
   * 终止发送器：拒绝队列中所有待发任务，并取消当前正在背压等待中的任务。之后该发送器不再接受新任务。
   * 通道被拆毁 / 重置 / 被新连接取代时必须调用。
   */
  public abort(reason = 'DataChannel sender aborted'): void {
    this.aborted = true
    const error = new SenderAbortedError(reason)
    this.failFastRemaining(error)
    const cancel = this.cancelBackpressureWait
    this.cancelBackpressureWait = null
    cancel?.(error)
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
        if (this.queue.length > 0 && task.payload.length > 1120 && !(this.dc as any)?.isVirtual) {
          await new Promise((r) => setTimeout(r, 3))
        }
      } catch (err) {
        if (err instanceof SenderAbortedError) {
          log.info(`Send task cancelled: ${err.message}`)
        } else {
          log.error('Send task failed:', err)
        }
        task.reject(err)

        if (err instanceof SenderAbortedError) {
          this.failFastRemaining(err)
          break
        }

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

    if (payload.length > this.MAX_PAYLOAD_SIZE) {
      throw new Error(
        `Payload size ${payload.length} bytes exceeds MAX_PAYLOAD_SIZE (${this.MAX_PAYLOAD_SIZE} bytes). Message must be chunked at application layer.`
      )
    }

    const needsWait =
      this.dc.bufferedAmount > this.BUFFER_HIGH_WATERMARK ||
      (this.dc.bufferedAmount > this.BUFFER_LOW_WATERMARK &&
        this.dc.bufferedAmount + payload.length > this.BUFFER_HIGH_WATERMARK)

    if (needsWait) {
      log.warn(
        `DataChannel buffer pressure detected (${this.dc.bufferedAmount} bytes + payload ${payload.length} > ${this.BUFFER_HIGH_WATERMARK}). Pausing sender for backpressure relief.`
      )
      this.onCongestion?.(true)
      await new Promise<void>((resolve, reject) => {
        let finished = false
        let intervalId: ReturnType<typeof setInterval> | null = null
        let timeoutId: ReturnType<typeof setTimeout> | null = null

        const cleanup = () => {
          if (intervalId) clearInterval(intervalId)
          if (timeoutId) clearTimeout(timeoutId)
          this.cancelBackpressureWait = null
          this.dc.removeEventListener('bufferedamountlow', onLow)
          this.dc.removeEventListener('close', onClose)
          this.dc.removeEventListener('error', onClose)
        }

        this.cancelBackpressureWait = (err: Error) => {
          if (!finished) {
            finished = true
            cleanup()
            reject(err)
          }
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
        }, 50)

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

    if (typeof (this.dc as any).sendAsync === 'function') {
      await (this.dc as any).sendAsync(payload)
    } else {
      this.dc.send(payload)
    }

    if (this.dc.bufferedAmount > this.BUFFER_HIGH_WATERMARK) {
      this.onCongestion?.(true)
    }
  }
}
