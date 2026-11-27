import type { WebRtcCrdtSyncChunk, WebRtcCrdtSyncMsg } from '@/types'

export const CRDT_MAX_FRAME_BYTES = 16 * 1024 // Keep individual frames <= 16 KiB so control frames interleave on slow links
export const CRDT_CHUNK_DATA_CHARS = 12 * 1024 // Target slice length (~12 KiB ASCII, dynamically clamped for multi-byte UTF-8)

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

  const transferId = `crdt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  // Reserve conservative digit width for chunkIndex/totalChunks when sizing UTF-8 frame budget
  const estimatedMaxChunks = Math.max(9999, serialized.length)
  const buildCandidateFrame = (chunkData: string, chunkIndex: number, totalChunks: number): WebRtcCrdtSyncChunk => ({
    type: 'CRDT_SYNC_CHUNK',
    eventId: msg.eventId,
    transferId,
    chunkIndex,
    totalChunks,
    chunkData,
    authCode: msg.authCode
  })

  const slices: string[] = []
  let offset = 0
  while (offset < serialized.length) {
    let end = Math.min(serialized.length, offset + CRDT_CHUNK_DATA_CHARS)
    const fitsFrame = (candidateEnd: number): boolean => {
      const candidate = buildCandidateFrame(
        serialized.slice(offset, candidateEnd),
        estimatedMaxChunks,
        estimatedMaxChunks
      )
      return measureUtf8Bytes(JSON.stringify(candidate)) <= CRDT_MAX_FRAME_BYTES
    }

    if (!fitsFrame(end)) {
      let low = offset + 1
      let high = end - 1
      let best = offset + 1
      while (low <= high) {
        const mid = (low + high) >> 1
        if (fitsFrame(mid)) {
          best = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      end = best
    }

    // Avoid splitting a UTF-16 surrogate pair when advancing to the next slice
    if (end < serialized.length && end > offset + 1) {
      const lastCode = serialized.charCodeAt(end - 1)
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        end--
      }
    }

    slices.push(serialized.slice(offset, end))
    offset = end
  }

  const totalChunks = slices.length
  return slices.map((chunkData, chunkIndex) => buildCandidateFrame(chunkData, chunkIndex, totalChunks))
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
