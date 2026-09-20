import { describe, it, expect, vi, beforeEach } from 'vitest'
import { uploadPhotoViaWebRtcChunks } from '../services/photoStorage'
import { createChannelMessageHandler } from '../services/webrtc/channelMessageHandler'
import * as api from '../services/api'

vi.mock('../services/api', () => ({
  uploadPitPhoto: vi.fn().mockResolvedValue({ status: 'ok' }),
  deletePitPhoto: vi.fn().mockResolvedValue({ success: true }),
  syncRecords: vi.fn().mockResolvedValue({ success: true })
}))

const mockSendMessage = vi.fn().mockResolvedValue(undefined)

vi.mock('@/stores/connection', () => ({
  useConnectionStore: () => ({
    status: 'connected',
    rtcService: {
      sendMessage: mockSendMessage
    }
  })
}))

describe('Photo WebRTC Chunking & Assembly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('splits large photo into 24KB chunks and sends them sequentially via WebRTC', async () => {
    const eventId = 'evt_test_chunk'
    const key = 'photo_large_1'
    // Generate ~60KB payload (should be 3 chunks of 24KB, 24KB, 12KB)
    const largeDataUrl = 'data:image/webp;base64,' + 'A'.repeat(60 * 1024)

    const success = await uploadPhotoViaWebRtcChunks(eventId, key, largeDataUrl)
    expect(success).toBe(true)

    // Expected 3 chunks
    expect(mockSendMessage).toHaveBeenCalledTimes(3)

    const firstCall = mockSendMessage.mock.calls[0][0]
    expect(firstCall.type).toBe('PIT_PHOTO_CHUNK')
    expect(firstCall.eventId).toBe(eventId)
    expect(firstCall.key).toBe(key)
    expect(firstCall.chunkIndex).toBe(0)
    expect(firstCall.totalChunks).toBe(3)
    expect(firstCall.chunkData.length).toBe(24 * 1024)

    const thirdCall = mockSendMessage.mock.calls[2][0]
    expect(thirdCall.chunkIndex).toBe(2)
    expect(thirdCall.totalChunks).toBe(3)
  })

  it('host channel handler correctly reassembles chunks and saves photo to disk', async () => {
    const hostSendMessage = vi.fn().mockResolvedValue(undefined)
    const mockCtx: any = {
      isHostMode: () => true,
      currentInviteCode: () => 'INVITE-1234',
      getHostSessionId: () => 'host-sess-1',
      getCurrentHostSessionId: () => 'host-sess-1',
      setCurrentHostSessionId: vi.fn(),
      callbacks: {},
      clients: new Map(),
      stagedClients: new Map(),
      scoutIdToClientIds: new Map(),
      clientIdToScoutId: new Map(),
      clientIdToScoutName: new Map(),
      pendingTakeovers: new Map(),
      takeoverCooldowns: new Map(),
      offlineMessages: {} as any,
      sendMessage: hostSendMessage,
      promoteTakeover: vi.fn(),
      enqueueHostTask: vi.fn(),
      cleanupPeerResources: vi.fn(),
      stampHostSeq: vi.fn(),
      getHostSeqCounter: () => 1,
      setHostSeqCounter: vi.fn(),
      closeClient: vi.fn(),
      setStatus: vi.fn()
    }

    const handler = createChannelMessageHandler(mockCtx)

    const transferId = 'transfer_photo_unit_test'
    const eventId = 'evt_host_assemble'
    const key = 'photo_assembled'
    const part1 = 'data:image/webp;base64,HEADER_'
    const part2 = 'BODY_CHUNK_MIDDLE_'
    const part3 = 'FOOTER_END'
    const fullExpected = part1 + part2 + part3

    // Receive Chunk 0
    await handler(
      {
        data: JSON.stringify({
          type: 'PIT_PHOTO_CHUNK',
          transferId,
          eventId,
          key,
          chunkIndex: 0,
          totalChunks: 3,
          chunkData: part1
        })
      } as MessageEvent,
      'client-sender-1'
    )

    // Not complete yet, uploadPitPhoto should not have been called
    expect(api.uploadPitPhoto).not.toHaveBeenCalled()

    // Receive Chunk 1
    await handler(
      {
        data: JSON.stringify({
          type: 'PIT_PHOTO_CHUNK',
          transferId,
          eventId,
          key,
          chunkIndex: 1,
          totalChunks: 3,
          chunkData: part2
        })
      } as MessageEvent,
      'client-sender-1'
    )
    expect(api.uploadPitPhoto).not.toHaveBeenCalled()

    // Receive Chunk 2 (Final chunk)
    await handler(
      {
        data: JSON.stringify({
          type: 'PIT_PHOTO_CHUNK',
          transferId,
          eventId,
          key,
          chunkIndex: 2,
          totalChunks: 3,
          chunkData: part3
        })
      } as MessageEvent,
      'client-sender-1'
    )

    // Complete! Should have called uploadPitPhoto with fully assembled string
    expect(api.uploadPitPhoto).toHaveBeenCalledWith(eventId, key, fullExpected)

    // Should have sent PIT_PHOTO_ACK back to client
    expect(hostSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PIT_PHOTO_ACK',
        eventId,
        key,
        success: true
      }),
      'client-sender-1'
    )
  })
})
