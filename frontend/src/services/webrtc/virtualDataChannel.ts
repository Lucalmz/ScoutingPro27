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

  public send(data: string): void {
    if (this.readyState !== 'open') {
      throw new Error(`VirtualDataChannel is not open (state: ${this.readyState})`)
    }
    const byteLen = typeof data === 'string' ? data.length : 0
    this.bufferedAmount += byteLen

    this.sendChain = this.sendChain
      .then(async () => {
        if (this.readyState !== 'open') return
        const signaling = this.options.getSignaling()
        const aesKey = this.options.getSharedAesKey()
        const target = this.options.getTargetPeerId()
        if (!signaling || !aesKey) {
          log.warn('Cannot send over VirtualDataChannel: signaling or ECDH AES key missing')
          return
        }
        const encrypted = await encryptSignalingData(
          aesKey,
          JSON.stringify({
            vdc: 'data',
            sessionId: this.sessionId,
            payload: data
          })
        )
        await signaling.send(
          {
            encrypted,
            clientSessionId: this.sessionId
          },
          target
        )
      })
      .catch((err) => {
        log.warn('VirtualDataChannel encrypted frame send error:', err)
      })
      .finally(() => {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - byteLen)
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
          this.dispatchEvent('bufferedamountlow', new Event('bufferedamountlow'))
        }
      })
  }

  public receiveDecryptedPayload(payload: string): void {
    if (this.readyState === 'closed') return
    if (this.readyState === 'connecting') {
      this.open()
    }
    const ev = { data: payload } as MessageEvent
    this.onmessage?.call(this as unknown as RTCDataChannel, ev)
    this.dispatchEvent('message', ev as unknown as Event)
  }

  public close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.bufferedAmount = 0
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
