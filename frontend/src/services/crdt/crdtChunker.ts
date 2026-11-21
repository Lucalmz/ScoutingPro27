import type { WebRtcCrdtSyncChunk, WebRtcCrdtSyncMsg } from '@/types'

export const CRDT_MAX_FRAME_BYTES = 48 * 1024 // Strictly below DataChannelSender 64 KiB cap
export const CRDT_CHUNK_DATA_CHARS = 34 * 1024 // Safe UTF-8 + JSON envelope headroom (< 48 KiB)

const utf8Encoder = new TextEncoder()

export function measureUtf8Bytes(str: string): number {
  return utf8Encoder.encode(str).byteLength
}

export function encodeCrdtSyncFrames(
  msg: WebRtcCrdtSyncMsg
): Array<WebRtcCrdtSyncMsg | WebRtcCrdtSyncChunk> {
  const serialized = JSON.stringify(msg)
  if (measureUtf8Bytes(serialized) <= CRDT_MAX_FRAME_BYTES) {
    return [msg]
  }

  const totalChunks = Math.ceil(serialized.length / CRDT_CHUNK_DATA_CHARS)
  const transferId = `crdt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const chunks: WebRtcCrdtSyncChunk[] = []

  for (let i = 0; i < totalChunks; i++) {
    chunks.push({
      type: 'CRDT_SYNC_CHUNK',
      eventId: msg.eventId,
      transferId,
      chunkIndex: i,
      totalChunks,
      chunkData: serialized.slice(i * CRDT_CHUNK_DATA_CHARS, (i + 1) * CRDT_CHUNK_DATA_CHARS),
      authCode: msg.authCode
    })
  }
  return chunks
}

interface PendingTransfer {
  totalChunks: number
  receivedCount: number
  chunks: Array<string | undefined>
  createdAt: number
}

export function createCrdtChunkReassembler(ttlMs = 30_000) {
  const pending = new Map<string, PendingTransfer>()

  function pruneExpired(now = Date.now()): void {
    for (const [id, entry] of pending.entries()) {
      if (now - entry.createdAt > ttlMs) {
        pending.delete(id)
      }
    }
  }

  function pushChunk(chunk: WebRtcCrdtSyncChunk): WebRtcCrdtSyncMsg | null {
    if (
      !chunk ||
      chunk.type !== 'CRDT_SYNC_CHUNK' ||
      !chunk.transferId ||
      typeof chunk.chunkIndex !== 'number' ||
      typeof chunk.totalChunks !== 'number' ||
      chunk.totalChunks <= 0 ||
      chunk.chunkIndex < 0 ||
      chunk.chunkIndex >= chunk.totalChunks
    ) {
      return null
    }

    const now = Date.now()
    pruneExpired(now)

    let entry = pending.get(chunk.transferId)
    if (!entry) {
      entry = {
        totalChunks: chunk.totalChunks,
        receivedCount: 0,
        chunks: new Array<string | undefined>(chunk.totalChunks),
        createdAt: now
      }
      pending.set(chunk.transferId, entry)
    }

    if (entry.chunks[chunk.chunkIndex] === undefined) {
      entry.receivedCount++
    }
    entry.chunks[chunk.chunkIndex] = chunk.chunkData

    if (entry.receivedCount < entry.totalChunks) {
      return null
    }

    pending.delete(chunk.transferId)
    try {
      const joined = entry.chunks.join('')
      const parsed = JSON.parse(joined)
      if (parsed && parsed.type === 'CRDT_SYNC_MSG') {
        return parsed as WebRtcCrdtSyncMsg
      }
    } catch {
      // Ignore corrupt chunk assembly
    }
    return null
  }

  function clear(): void {
    pending.clear()
  }

  function pendingCount(): number {
    return pending.size
  }

  return {
    pushChunk,
    clear,
    pendingCount
  }
}
