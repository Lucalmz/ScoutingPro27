import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchCrdtState, saveCrdtState } from '../services/crdt/crdtApi'
import {
  CRDT_MAX_FRAME_BYTES,
  CRDT_CHUNK_DATA_CHARS,
  encodeCrdtSyncFrames,
  createCrdtChunkReassembler,
  measureUtf8Bytes
} from '../services/crdt/crdtChunker'
import { scanMergeableContent, scanSyncMessageBody, extractMaxHlcPtFromSnapshot } from '../services/crdt/hlcGuard'
import { getHlcFunctions } from 'tinybase'
import type { WebRtcCrdtSyncMsg } from '@/types'

const [, , encodeHlc] = getHlcFunctions()

describe('crdtApi, crdtChunker, and hlcGuard', () => {
  const origFetch = globalThis.fetch

  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    localStorage.clear()
    vi.useRealTimers()
  })

  describe('crdtApi', () => {
    it('returns null from fetchCrdtState when eventId or token is missing', async () => {
      expect(await fetchCrdtState('')).toBeNull()
      expect(await fetchCrdtState('evt-1')).toBeNull()
    })

    it('fetches CRDT state, applies X-Refreshed-Token, and handles 401 unauthorized', async () => {
      localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', token: 'old-tok' }))
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            exists: true,
            eventId: 'evt-1',
            hostEpoch: 2,
            snapshotRevision: 5,
            snapshot: [[{}, ''], [{}, '']]
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'X-Refreshed-Token': 'new-tok-123'
            }
          }
        )
      ) as any

      const loaded = await fetchCrdtState('evt-1')
      expect(loaded?.exists).toBe(true)
      expect(loaded?.hostEpoch).toBe(2)
      expect(JSON.parse(localStorage.getItem('scoutingpro-user')!).token).toBe('new-tok-123')

      // 401 clears user and dispatches auth-unauthorized
      globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response('Unauthorized', { status: 401 })) as any
      await expect(fetchCrdtState('evt-1')).rejects.toThrow('(401)')
      expect(localStorage.getItem('scoutingpro-user')).toBeNull()
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'auth-unauthorized' }))
    })

    it('saveCrdtState handles missing token, 409 stale_epoch, keepalive, and server errors', async () => {
      await expect(
        saveCrdtState('evt-1', { hostEpoch: 1, snapshotRevision: 1, snapshot: [], dirtyRows: {} })
      ).rejects.toThrow('Missing auth token')

      localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', token: 'tok-1' }))

      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            saved: false,
            stale: true,
            error: 'stale_epoch',
            eventId: 'evt-1',
            hostEpoch: 3,
            snapshotRevision: 9
          }),
          { status: 409 }
        )
      ) as any

      const conflictRes = await saveCrdtState(
        'evt-1',
        { hostEpoch: 1, snapshotRevision: 2, snapshot: [], dirtyRows: {} },
        { keepalive: true }
      )
      expect(conflictRes).toEqual({
        saved: false,
        stale: true,
        error: 'stale_epoch',
        eventId: 'evt-1',
        hostEpoch: 3,
        snapshotRevision: 9
      })
      expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]).toMatchObject({ keepalive: true })

      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Only the event host can advance hostEpoch' }), { status: 403 })
      ) as any
      await expect(
        saveCrdtState('evt-1', { hostEpoch: 5, snapshotRevision: 1, snapshot: [], dirtyRows: {} })
      ).rejects.toThrow('Only the event host can advance hostEpoch')
    })
  })

  describe('crdtChunker', () => {
    it('passes small messages unchunked and splits/reassembles large messages out-of-order', () => {
      const smallMsg: WebRtcCrdtSyncMsg = {
        type: 'CRDT_SYNC_MSG',
        eventId: 'evt-1',
        fromClientId: 'c1',
        message: 0,
        body: { ok: true },
        authCode: 'CODE1'
      }
      const smallFrames = encodeCrdtSyncFrames(smallMsg)
      expect(smallFrames).toHaveLength(1)
      expect(smallFrames[0]).toEqual(smallMsg)

      const largeMsg: WebRtcCrdtSyncMsg = {
        type: 'CRDT_SYNC_MSG',
        eventId: 'evt-1',
        fromClientId: 'c1',
        message: 3,
        body: { blob: 'x'.repeat(80_000) },
        authCode: 'CODE1'
      }
      const chunks = encodeCrdtSyncFrames(largeMsg)
      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.every((c) => c.type === 'CRDT_SYNC_CHUNK')).toBe(true)

      const reassembler = createCrdtChunkReassembler(5000)
      const typedChunks = chunks as Extract<(typeof chunks)[number], { type: 'CRDT_SYNC_CHUNK' }>[]
      // Deliver in reverse order with a duplicate chunk
      for (let i = typedChunks.length - 1; i > 0; i--) {
        expect(reassembler.pushChunk(typedChunks[i]!)).toBeNull()
      }
      expect(reassembler.pushChunk(typedChunks[typedChunks.length - 1]!)).toBeNull()
      expect(reassembler.pendingCount()).toBe(1)

      const assembled = reassembler.pushChunk(typedChunks[0]!)
      expect(assembled).toEqual(largeMsg)
      expect(reassembler.pendingCount()).toBe(0)
    })

    it('keeps every CRDT_SYNC_CHUNK <= 16 KiB UTF-8 (including multi-byte CJK notes) and reassembles 250 KB+ messages', () => {
      expect(CRDT_MAX_FRAME_BYTES).toBe(16 * 1024)
      expect(CRDT_CHUNK_DATA_CHARS).toBe(12 * 1024)

      const cjkNotes = '防守稳健、传球精准、底线推进能力强，自动阶段稳定得分。'.repeat(3500)
      const asciiBlob = 'S'.repeat(140_000)
      const hugeMsg: WebRtcCrdtSyncMsg = {
        type: 'CRDT_SYNC_MSG',
        eventId: 'evt-cjk-250k',
        fromClientId: 'c1',
        toClientId: 'host',
        requestId: 'req-42',
        message: 0,
        body: {
          cjkNotes,
          asciiBlob,
          nested: { tags: ['快速', '稳定', '高分'] }
        },
        authCode: 'CODE1'
      }

      const rawBytes = measureUtf8Bytes(JSON.stringify(hugeMsg))
      expect(rawBytes).toBeGreaterThan(250 * 1024)

      const frames = encodeCrdtSyncFrames(hugeMsg)
      expect(frames.length).toBeGreaterThan(15)
      for (const frame of frames) {
        expect(frame.type).toBe('CRDT_SYNC_CHUNK')
        const frameBytes = measureUtf8Bytes(JSON.stringify(frame))
        expect(frameBytes).toBeLessThanOrEqual(16 * 1024)
      }

      const reassembler = createCrdtChunkReassembler(10_000)
      let assembled: WebRtcCrdtSyncMsg | null = null
      for (const frame of frames) {
        if (frame.type === 'CRDT_SYNC_CHUNK') {
          assembled = reassembler.pushChunk(frame)
        }
      }
      expect(assembled).toEqual(hugeMsg)
      expect(reassembler.pendingCount()).toBe(0)
    })

    it('rejects invalid chunks, prunes expired transfers, and ignores corrupt JSON payloads', () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000_000)

      const reassembler = createCrdtChunkReassembler(1000)
      expect(reassembler.pushChunk({
        type: 'CRDT_SYNC_CHUNK',
        eventId: 'e1',
        transferId: 'bad',
        chunkIndex: -1,
        totalChunks: 2,
        chunkData: 'a'
      })).toBeNull()

      expect(reassembler.pushChunk({
        type: 'CRDT_SYNC_CHUNK',
        eventId: 'e1',
        transferId: 'exp',
        chunkIndex: 0,
        totalChunks: 2,
        chunkData: 'a'
      })).toBeNull()
      expect(reassembler.pendingCount()).toBe(1)

      // Advance past TTL -> old entry pruned when next chunk arrives
      vi.advanceTimersByTime(1500)
      expect(reassembler.pushChunk({
        type: 'CRDT_SYNC_CHUNK',
        eventId: 'e1',
        transferId: 'corrupt',
        chunkIndex: 0,
        totalChunks: 1,
        chunkData: '{broken-json'
      })).toBeNull()
      expect(reassembler.pendingCount()).toBe(0)
    })
  })

  describe('hlcGuard', () => {
    it('scans MSG_RESPONSE and MSG_CONTENT_DIFF stamps and ignores 16-char leaf cell values', () => {
      const now = 1_760_000_000_000
      const validHlc = encodeHlc(now + 1000, 0, 'c1')
      const poisonedHlc = encodeHlc(now + 400_000, 0, 'c2')

      // Leaf value is exactly 16 valid HLC chars — must NEVER trigger future skew
      const benignContent = [
        [
          {
            scouting_records: [
              {
                rec1: [
                  {
                    notes: ['ABCDEFGHIJKLMNOP', validHlc, 123]
                  },
                  validHlc,
                  456
                ]
              },
              validHlc,
              789
            ]
          },
          validHlc,
          1
        ],
        [{}, '', 0]
      ]

      const benignRes = scanMergeableContent(benignContent, now, 300_000)
      expect(benignRes.hasFutureSkew).toBe(false)
      expect(benignRes.scannedStamps).toBeGreaterThanOrEqual(4)

      // MSG_RESPONSE format 1: [TablesStamp, differingHashes]
      const responseMsgBody = [
        [
          {
            scouting_records: [
              {
                rec1: [{ notes: ['ok', poisonedHlc, 1] }, validHlc, 2]
              },
              validHlc,
              3
            ]
          },
          validHlc,
          4
        ],
        {}
      ]
      const respScan = scanSyncMessageBody(0, responseMsgBody, now, 300_000)
      expect(respScan.hasFutureSkew).toBe(true)
      expect(respScan.offendingHlc).toBe(poisonedHlc)

      // MSG_RESPONSE format 2: direct TablesStamp [ { tableId: TableStamp }, ... ]
      const cellDiffRes = scanSyncMessageBody(
        0,
        [
          {
            team_tags: [
              {
                '27570::fast': [{ tag: ['fast', poisonedHlc, 1] }, validHlc, 2]
              },
              validHlc,
              3
            ]
          },
          validHlc,
          4
        ],
        now,
        300_000
      )
      expect(cellDiffRes.hasFutureSkew).toBe(true)
      expect(extractMaxHlcPtFromSnapshot(responseMsgBody[0] ? [responseMsgBody[0], [{}, '']] : [])).toBeGreaterThan(now)
    })
  })
})
