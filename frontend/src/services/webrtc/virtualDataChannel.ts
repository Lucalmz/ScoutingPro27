import { encryptSignalingData, decryptSignalingData } from '@/utils/crypto'
import type { SignalingChannel } from './signaling'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:VirtualDC')

export interface VirtualDataChannelOptions {
  label?: string
  sessionId: string
  getSignaling: () => SignalingChannel | null
  getSharedAesKey: () => CryptoKey | null
  getTargetPeerId: () => string | undefined
}

/**
 * 基于 ECDH AES-256-GCM 端到端加密的虚拟 DataChannel：
 * 当双端处于全局 TUN 代理、校园网 UDP 封锁或双端对称型 NAT 导致原生 WebRTC UDP 打洞超时时，
 * 自动无缝接管 DataChannel 通信；若后台原生 UDP 打洞随后连通，支持零感热切回原生 UDP 通道。
 */
export class VirtualDataChannel {
  public readonly label: string
  public readonly sessionId: string
  public readyState: RTCDataChannelState = 'connecting'
  public bufferedAmount = 0
  public bufferedAmountLowThreshold = 0
  public readonly isVirtual = true
  public isDraining = false
  private drainTimer: any = null
  private pendingSendAborts = new Set<(err: Error) => void>()

  public onopen: ((this: RTCDataChannel, ev: Event) => any) | null = null
  public onclose: ((this: RTCDataChannel, ev: Event) => any) | null = null
  public onerror: ((this: RTCDataChannel, ev: Event) => any) | null = null
  public onmessage: ((this: RTCDataChannel, ev: MessageEvent) => any) | null = null

  private listeners = new Map<string, Set<EventListener>>()
  private sendChain: Promise<void> = Promise.resolve()

  constructor(private options: VirtualDataChannelOptions) {
    this.label = options.label || 'scoutingpro-data'
    this.sessionId = options.sessionId
  }

  public open(): void {
    if (this.readyState === 'open' || this.readyState === 'closed') return
    this.readyState = 'open'
    log.info(`VirtualDataChannel '${this.label}' OPENED (session: ${this.sessionId})`)
    const ev = new Event('open')
    this.onopen?.call(this as unknown as RTCDataChannel, ev)
    this.dispatchEvent('open', ev)
  }

  public startDrain(graceMs: number = 5000, flushCapMs: number = 1000, onDrainComplete?: () => void): void {
    if (this.readyState === 'closed' || this.isDraining) return
    this.isDraining = true
    log.info(`VirtualDataChannel '${this.label}' started draining mode (graceMs: ${graceMs}, flushCapMs: ${flushCapMs})`)
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
    this.drainTimer = setTimeout(async () => {
      this.drainTimer = null
      try {
        await this.flush(flushCapMs)
      } finally {
        this.close()
        try {
          onDrainComplete?.()
        } catch {}
      }
    }, graceMs)
  }

  public async flush(capMs: number = 1000): Promise<void> {
    const settlement = this.sendChain
    if (!settlement) return
    let timeoutHandle: any
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, capMs)
    })
    try {
      await Promise.race([settlement, timeoutPromise])
    } finally {
      clearTimeout(timeoutHandle)
    }
  }

  public sendAsync(data: string): Promise<void> {
    if (this.readyState !== 'open' && !this.isDraining) {
      return Promise.reject(new Error(`VirtualDataChannel is not open (state: ${this.readyState})`))
    }
    const byteLen = typeof data === 'string' ? data.length : 0
    this.bufferedAmount += byteLen

    const currentTask = (async () => {
      // 等待前序排队任务解决（无论成功与否，均允许后续任务继续执行）
      try {
        await this.sendChain
      } catch {}

      if (this.readyState !== 'open' && !this.isDraining) {
        throw new Error(`VirtualDataChannel closed before queued frame could be sent (state: ${this.readyState})`)
      }
      const signaling = this.options.getSignaling()
      const aesKey = this.options.getSharedAesKey()
      const target = this.options.getTargetPeerId()
      if (!signaling || !aesKey) {
        throw new Error('Cannot send over VirtualDataChannel: signaling or ECDH AES key missing')
      }
      const encrypted = await encryptSignalingData(
        aesKey,
        JSON.stringify({
          vdc: 'data',
          sessionId: this.sessionId,
          payload: data
        })
      )
      let abortCallback: ((err: Error) => void) | null = null
      const closeRace = new Promise<never>((_, reject) => {
        abortCallback = reject
        this.pendingSendAborts.add(reject)
      })

      const sendPromise = signaling.send(
        {
          encrypted,
          clientSessionId: this.sessionId
        },
        target
      )

      try {
        await Promise.race([sendPromise, closeRace])
      } finally {
        if (abortCallback) {
          this.pendingSendAborts.delete(abortCallback)
        }
      }
    })()
      .finally(() => {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLen)
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
          this.dispatchEvent('bufferedamountlow', new Event('bufferedamountlow'))
        }
      })

    // Advance sendChain, catching rejection on the internal chain
    this.sendChain = currentTask.catch(() => {})
    return currentTask
  }

  public send(data: string): void {
    this.sendAsync(data).catch((err) => {
      log.warn('VirtualDataChannel send failed:', err)
      const ev =
        typeof ErrorEvent !== 'undefined'
          ? new ErrorEvent('error', { error: err, message: err?.message || String(err) })
          : Object.assign(new Event('error'), { error: err, message: err?.message || String(err) })
      this.onerror?.call(this as unknown as RTCDataChannel, ev)
      this.dispatchEvent('error', ev)
    })
  }

  public receiveDecryptedPayload(payload: string): void {
    if (this.readyState === 'closed' && !this.isDraining) return
    if (this.readyState === 'connecting') {
      this.open()
    }
    const ev = { data: payload } as MessageEvent
    this.onmessage?.call(this as unknown as RTCDataChannel, ev)
    this.dispatchEvent('message', ev as unknown as Event)
  }

  public close(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
    this.isDraining = false
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.bufferedAmount = 0

    // Abort any in-flight sends immediately
    const abortErr = new Error(`VirtualDataChannel closed before queued frame could be sent (state: ${this.readyState})`)
    for (const abort of Array.from(this.pendingSendAborts)) {
      try {
        abort(abortErr)
      } catch {}
    }
    this.pendingSendAborts.clear()

    const ev = new Event('close')
    this.onclose?.call(this as unknown as RTCDataChannel, ev)
    this.dispatchEvent('close', ev)
    this.listeners.clear()
  }

  public addEventListener(type: string, listener: EventListener): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  public removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  private dispatchEvent(type: string, ev: Event): void {
    const set = this.listeners.get(type)
    if (set) {
      for (const fn of Array.from(set)) {
        try {
          fn(ev)
        } catch {}
      }
    }
  }
}

/**
 * 尝试解密信令通道收到的 `msg.encrypted` 虚拟通道帧
 */
export async function tryDecryptVirtualFrame(
  aesKey: CryptoKey | null | undefined,
  encryptedPayload: { ciphertext: string; iv: string } | undefined
): Promise<{ vdc: 'open' | 'data'; sessionId: string; payload?: string } | null> {
  if (!aesKey || !encryptedPayload || !encryptedPayload.ciphertext || !encryptedPayload.iv) {
    return null
  }
  try {
    const raw = await decryptSignalingData(aesKey, encryptedPayload)
    const parsed = JSON.parse(raw)
    if (parsed && (parsed.vdc === 'open' || parsed.vdc === 'data') && typeof parsed.sessionId === 'string') {
      return parsed
    }
  } catch {}
  return null
}
