import type { ChannelMessageHandlerContext } from './channelMessageHandler'

interface PhotoChunkBuffer {
  transferId: string
  eventId: string
  key: string
  totalChunks: number
  chunks: string[]
  receivedCount: number
  updatedAt: number
}

const photoChunkBuffers = new Map<string, PhotoChunkBuffer>()

const PHOTO_MESSAGE_TYPES = new Set([
  'PIT_PHOTO_UPLOAD',
  'PIT_PHOTO_CHUNK',
  'PIT_PHOTO_ACK'
])

export function isChannelPhotoMessageType(type: string | undefined): boolean {
  return Boolean(type && PHOTO_MESSAGE_TYPES.has(type))
}

/**
 * 处理 PIT_PHOTO_UPLOAD、PIT_PHOTO_CHUNK 与 PIT_PHOTO_ACK 照片分片组装与持久化消息
 * @returns true 表示该消息属于照片传输协议并已处理完毕
 */
export async function handleChannelPhotoMessage(
  ctx: ChannelMessageHandlerContext,
  msg: any,
  senderId?: string
): Promise<boolean> {
  const isHostMode = ctx.isHostMode()
  const currentInviteCode = ctx.currentInviteCode()

  switch (msg.type) {
    case 'PIT_PHOTO_UPLOAD': {
      if (isHostMode && msg.eventId && msg.key && msg.dataUrl) {
        try {
          const { uploadPitPhoto } = await import('@/services/api')
          await uploadPitPhoto(msg.eventId, msg.key, msg.dataUrl)
          console.log(`[WebRTC Host] Successfully saved pit photo ${msg.key} for event ${msg.eventId}`)
          await ctx.sendMessage(
            {
              type: 'PIT_PHOTO_ACK',
              eventId: msg.eventId,
              key: msg.key,
              success: true,
              authCode: currentInviteCode
            },
            senderId
          )
        } catch (err) {
          console.error(`[WebRTC Host] Failed to save pit photo ${msg.key}:`, err)
          await ctx.sendMessage(
            {
              type: 'PIT_PHOTO_ACK',
              eventId: msg.eventId,
              key: msg.key,
              success: false,
              authCode: currentInviteCode
            },
            senderId
          )
        }
      }
      return true
    }

    case 'PIT_PHOTO_CHUNK': {
      if (!isHostMode) return true
      const { transferId, eventId, key, chunkIndex, totalChunks, chunkData } = msg
      if (
        !transferId ||
        !eventId ||
        !key ||
        typeof chunkIndex !== 'number' ||
        typeof totalChunks !== 'number' ||
        !Number.isInteger(chunkIndex) ||
        !Number.isInteger(totalChunks) ||
        totalChunks <= 0 ||
        totalChunks > 500 ||
        chunkIndex < 0 ||
        chunkIndex >= totalChunks ||
        typeof chunkData !== 'string'
      ) {
        return true
      }

      const hostAuthEventId = ctx.getCurrentEventId?.()
      const rawEventUpper = eventId.trim().toUpperCase()
      const codeUpper = (currentInviteCode || '').trim().toUpperCase()
      const effectiveEventId =
        hostAuthEventId &&
        codeUpper &&
        (rawEventUpper === `EVT-${codeUpper}` || rawEventUpper === `EXT_${codeUpper}`)
          ? hostAuthEventId
          : eventId

      // 清理超过 5 分钟未完成的过期分片缓冲
      const now = Date.now()
      for (const [tId, buf] of photoChunkBuffers.entries()) {
        if (now - buf.updatedAt > 300000) {
          photoChunkBuffers.delete(tId)
        }
      }

      let buffer = photoChunkBuffers.get(transferId)
      if (!buffer) {
        buffer = {
          transferId,
          eventId: effectiveEventId,
          key,
          totalChunks,
          chunks: new Array(totalChunks),
          receivedCount: 0,
          updatedAt: now
        }
        photoChunkBuffers.set(transferId, buffer)
      }

      if (buffer.chunks[chunkIndex] === undefined) {
        buffer.chunks[chunkIndex] = chunkData
        buffer.receivedCount++
        buffer.updatedAt = now
      }

      if (buffer.receivedCount === buffer.totalChunks) {
        photoChunkBuffers.delete(transferId)
        const assembledDataUrl = buffer.chunks.join('')
        try {
          const { uploadPitPhoto } = await import('@/services/api')
          await uploadPitPhoto(buffer.eventId, buffer.key, assembledDataUrl)
          console.log(`[WebRTC Host] Successfully assembled and saved pit photo ${buffer.key} (${buffer.totalChunks} chunks)`)
          await ctx.sendMessage(
            {
              type: 'PIT_PHOTO_ACK',
              eventId: buffer.eventId,
              key: buffer.key,
              success: true,
              authCode: currentInviteCode
            },
            senderId
          )
        } catch (err) {
          console.error(`[WebRTC Host] Failed to save assembled pit photo ${buffer.key}:`, err)
          await ctx.sendMessage(
            {
              type: 'PIT_PHOTO_ACK',
              eventId: buffer.eventId,
              key: buffer.key,
              success: false,
              authCode: currentInviteCode
            },
            senderId
          )
        }
      }
      return true
    }

    case 'PIT_PHOTO_ACK': {
      if (!isHostMode && msg.key && msg.success) {
        try {
          const { markMobilePhotoSynced } = await import('@/services/mobilePhotoCache')
          await markMobilePhotoSynced(msg.key)
          console.log(`[WebRTC Client] Pit photo ${msg.key} acknowledged and marked synced`)
        } catch (err) {
          console.warn('[WebRTC Client] Failed to mark photo synced upon ACK:', err)
        }
      }
      return true
    }

    default:
      return false
  }
}
