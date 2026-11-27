import { createMergeableStore, type MergeableStore } from 'tinybase'
import { createCustomSynchronizer, type Message, type Receive, type Synchronizer } from 'tinybase/synchronizers'
import type { WebRtcCrdtSyncChunk, WebRtcCrdtSyncMsg } from '@/types'
import { MAX_CLOCK_SKEW_MS } from '@/services/clock'
import { createCrdtChunkReassembler, encodeCrdtSyncFrames } from './crdtChunker'
import { scanSyncMessageBody, type HlcScanResult } from './hlcGuard'
import type { CrdtPullTrustContext } from './recordSignature'
import { CRDT_TABLES } from './schema'

export interface WebRtcCrdtHubOptions {
  eventId: string
  store: MergeableStore
  clientId: string
  getNowMs: () => number
  getAuthCode?: () => string | undefined
  requestTimeoutSeconds?: number
  maxClockSkewMs?: number
  sendToPeer: (peerId: string, msg: WebRtcCrdtSyncMsg | WebRtcCrdtSyncChunk) => void | Promise<void>
  onFutureClockSkew?: (senderPeerId: string, scan: HlcScanResult) => void
  sanitizeIncomingMessage?: (
    senderPeerId: string,
    msg: WebRtcCrdtSyncMsg,
    pullContext?: CrdtPullTrustContext
  ) => Promise<WebRtcCrdtSyncMsg | null> | WebRtcCrdtSyncMsg | null
  onPeerSyncSettled?: (peerId: string) => void
  onIgnoredError?: (err: unknown) => void
}

interface AttachedPeerSync {
  peerId: string
  synchronizer: Synchronizer
  receive: Receive
  fail: (err: Error) => void
  syncPromise?: Promise<Synchronizer>
}

export interface WebRtcCrdtSynchronizerHub {
  attachPeer: (peerId: string, options?: { awaitInitialSync?: boolean }) => Promise<void>
  detachPeer: (peerId: string) => Promise<void>
  handleIncomingMessage: (senderPeerId: string, msg: WebRtcCrdtSyncMsg | WebRtcCrdtSyncChunk) => void
  triggerFullSyncWithPeer: (peerId: string) => Promise<boolean>
  getAttachedPeers: () => string[]
  destroy: () => Promise<void>
}

/**
 * Per-peer TinyBase CustomSynchronizer star-topology hub over WebRTC DataChannels.
 *
 * Keeps a dedicated Synchronizer per remote peer against the shared MergeableStore so
 * Client1 -> Host automatically fans out delta ContentDiffs to Client2 with zero echo loops,
 * performs chunked (16 KiB) framing, and runs pre-merge HLC skew scanning (`decodeHlc`).
 */
export function createWebRtcCrdtSynchronizerHub(opts: WebRtcCrdtHubOptions): WebRtcCrdtSynchronizerHub {
  const {
    eventId,
    store,
    clientId,
    getNowMs,
    getAuthCode,
    sendToPeer,
    onFutureClockSkew,
    sanitizeIncomingMessage,
    onPeerSyncSettled,
    onIgnoredError
  } = opts
  const requestTimeoutSeconds = opts.requestTimeoutSeconds ?? 12
  const maxClockSkewMs = opts.maxClockSkewMs ?? MAX_CLOCK_SKEW_MS

  const peers = new Map<string, AttachedPeerSync>()
  const inboundQueues = new Map<string, Promise<void>>()
  const MAX_PULL_TRUST_CONTEXTS = 64
  const pullTrustContexts = new Map<string, CrdtPullTrustContext>()
  const reassembler = createCrdtChunkReassembler()
  let destroyed = false

  function getOrCreatePullTrustContext(txKey: string): CrdtPullTrustContext {
    let ctx = pullTrustContexts.get(txKey)
    if (ctx) return ctx
    ctx = { bindings: new Map(), knownHostKeys: new Set() }
    pullTrustContexts.set(txKey, ctx)
    if (pullTrustContexts.size > MAX_PULL_TRUST_CONTEXTS) {
      const oldestKey = pullTrustContexts.keys().next().value
      if (oldestKey !== undefined) {
        pullTrustContexts.delete(oldestKey)
      }
    }
    return ctx
  }

  function dispatchSyncMsgToPeer(
    peerId: string,
    requestId: string | null,
    message: Message,
    body: unknown
  ): void {
    if (destroyed) return
    let outboundBody = body
    if (Number(message) === 4 && outboundBody && typeof outboundBody === 'object' && !Array.isArray(outboundBody)) {
      const cloned = { ...(outboundBody as Record<string, unknown>) }
      delete cloned[CRDT_TABLES.MEMBER_IDENTITIES]
      outboundBody = cloned
    }
    const payload: WebRtcCrdtSyncMsg = {
      type: 'CRDT_SYNC_MSG',
      eventId,
      fromClientId: clientId,
      toClientId: peerId,
      requestId: requestId ?? null,
      message: Number(message),
      body: outboundBody,
      authCode: getAuthCode?.()
    }
    const frames = encodeCrdtSyncFrames(payload)
    for (const frame of frames) {
      try {
        void Promise.resolve(sendToPeer(peerId, frame)).catch((err) => onIgnoredError?.(err))
      } catch (err) {
        onIgnoredError?.(err)
      }
    }
  }

  async function attachPeer(peerId: string, attachOpts?: { awaitInitialSync?: boolean }): Promise<void> {
    if (destroyed || !peerId) return
    if (peers.has(peerId)) {
      return
    }

    let boundReceive!: Receive
    let boundFail!: (err: Error) => void

    const synchronizer = createCustomSynchronizer(
      store,
      (_toClientId, requestId, message, body) => {
        dispatchSyncMsgToPeer(peerId, requestId, message, body)
      },
      (receive, fail) => {
        boundReceive = receive
        boundFail = fail
      },
      () => {},
      requestTimeoutSeconds,
      undefined,
      undefined,
      onIgnoredError
    )

    const entry: AttachedPeerSync = {
      peerId,
      synchronizer,
      receive: boundReceive,
      fail: boundFail
    }
    peers.set(peerId, entry)

    const syncPromise = synchronizer
      .startSync()
      .then((res) => {
        if (!destroyed && peers.has(peerId)) {
          onPeerSyncSettled?.(peerId)
        }
        return res
      })
      .catch((err) => {
        onIgnoredError?.(err)
        return synchronizer
      })
    entry.syncPromise = syncPromise

    if (attachOpts?.awaitInitialSync !== false) {
      await syncPromise
    }
  }

  async function detachPeer(peerId: string): Promise<void> {
    const entry = peers.get(peerId)
    inboundQueues.delete(peerId)
    for (const key of pullTrustContexts.keys()) {
      if (key.startsWith(`${peerId}::`)) {
        pullTrustContexts.delete(key)
      }
    }
    if (!entry) return
    peers.delete(peerId)
    try {
      entry.fail(new Error(`Peer ${peerId} detached`))
    } catch {}
    try {
      await entry.synchronizer.destroy()
    } catch (err) {
      onIgnoredError?.(err)
    }
  }

  function deliverDecodedMessage(senderPeerId: string, msg: WebRtcCrdtSyncMsg): void {
    if (destroyed) return
    const entry = peers.get(senderPeerId)
    if (!entry) return

    const scan = scanSyncMessageBody(Number(msg.message), msg.body, getNowMs(), maxClockSkewMs)
    if (scan.hasFutureSkew) {
      onFutureClockSkew?.(senderPeerId, scan)
    }

    if (!sanitizeIncomingMessage) {
      try {
        entry.receive(
          msg.fromClientId || senderPeerId,
          msg.requestId ?? null,
          Number(msg.message) as Message,
          msg.body
        )
      } catch (err) {
        onIgnoredError?.(err)
      }
      return
    }

    const prev = inboundQueues.get(senderPeerId) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        if (destroyed || !peers.has(senderPeerId)) return
        const isPullResponse = Number(msg.message) === 0 && Boolean(msg.requestId)
        const pullContext = isPullResponse
          ? getOrCreatePullTrustContext(`${senderPeerId}::${String(msg.requestId).split('.')[0]}`)
          : undefined
        const sanitized = await sanitizeIncomingMessage(senderPeerId, msg, pullContext)
        if (!sanitized || destroyed) return
        const cur = peers.get(senderPeerId)
        if (!cur) return
        cur.receive(
          sanitized.fromClientId || senderPeerId,
          sanitized.requestId ?? null,
          Number(sanitized.message) as Message,
          sanitized.body
        )
      })
      .catch((err) => onIgnoredError?.(err))
    inboundQueues.set(senderPeerId, next)
  }

  function handleIncomingMessage(senderPeerId: string, msg: WebRtcCrdtSyncMsg | WebRtcCrdtSyncChunk): void {
    if (destroyed || !msg || !senderPeerId) return
    if (msg.eventId && eventId && msg.eventId !== eventId) return

    if (msg.type === 'CRDT_SYNC_CHUNK') {
      const assembled = reassembler.pushChunk(msg)
      if (assembled) {
        deliverDecodedMessage(senderPeerId, assembled)
      }
      return
    }

    if (msg.type === 'CRDT_SYNC_MSG') {
      deliverDecodedMessage(senderPeerId, msg)
    }
  }

  async function triggerFullSyncWithPeer(peerId: string): Promise<boolean> {
    if (destroyed || !peerId) return false
    const entry = peers.get(peerId)
    if (!entry) {
      await attachPeer(peerId)
      return !destroyed && peers.has(peerId)
    }
    try {
      await entry.synchronizer.load()
      await entry.synchronizer.save()
      if (!destroyed && peers.has(peerId)) {
        onPeerSyncSettled?.(peerId)
        return true
      }
      return false
    } catch (err) {
      onIgnoredError?.(err)
      return false
    }
  }

  async function destroy(): Promise<void> {
    destroyed = true
    reassembler.clear()
    inboundQueues.clear()
    pullTrustContexts.clear()
    const peerIds = Array.from(peers.keys())
    await Promise.allSettled(peerIds.map((id) => detachPeer(id)))
  }

  return {
    attachPeer,
    detachPeer,
    handleIncomingMessage,
    triggerFullSyncWithPeer,
    getAttachedPeers: () => Array.from(peers.keys()),
    destroy
  }
}

export function createStandaloneCrdtStore(
  uniqueId: string,
  getNow: () => number,
  maxClockSkewSeconds = 300
): MergeableStore {
  return createMergeableStore(uniqueId, getNow, maxClockSkewSeconds)
}
