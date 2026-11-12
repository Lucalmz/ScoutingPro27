import { DataChannelSender } from '@/services/dataChannelSender'
import type { ChannelMessageHandlerContext } from './channelMessageHandler'

const IDENTITY_AND_TAKEOVER_MESSAGE_TYPES = new Set([
  'TAKEOVER_REQUEST',
  'TAKEOVER_DECISION',
  'SESSION_CONFLICT',
  'TAKEOVER_PROMPT',
  'TAKEOVER_SUCCESS',
  'SESSION_KICKED',
  'IDENTITY_MIGRATION',
  'ACK_MIGRATION',
  'MERGE_ACCOUNT_REQUEST',
  'MERGE_ACCOUNT_RESPONSE'
])

export function isChannelIdentityAndTakeoverMessageType(type: string | undefined): boolean {
  return Boolean(type && IDENTITY_AND_TAKEOVER_MESSAGE_TYPES.has(type))
}

/**
 * 处理会话接管 (TAKEOVER_*)、冲突与踢出 (SESSION_CONFLICT / SESSION_KICKED)、
 * 身份迁移 (IDENTITY_MIGRATION / ACK_MIGRATION) 及账号合并 (MERGE_ACCOUNT_*) 协议
 * @returns true 表示消息已由本模块处理完毕
 */
export async function handleChannelIdentityAndTakeoverMessage(
  ctx: ChannelMessageHandlerContext,
  quarantinedSenders: Set<string>,
  msg: any,
  senderId?: string
): Promise<boolean> {
  const isHostMode = ctx.isHostMode()
  const currentInviteCode = ctx.currentInviteCode()
  const callbacks = ctx.callbacks

  switch (msg.type) {
    case 'TAKEOVER_REQUEST': {
      if (!isHostMode || !senderId) return true
      const username = msg.username
      let userId: string | undefined = msg.userId
      if (!userId && username) {
        for (const [cid, name] of ctx.clientIdToScoutName.entries()) {
          if (name.trim().toLowerCase() === username.trim().toLowerCase()) {
            userId = ctx.clientIdToScoutId.get(cid)
            break
          }
        }
      }
      if (!username || !userId) return true

      // 30s Cooldown check
      const now = Date.now()
      const lastReq = ctx.takeoverCooldowns.get(username) || 0
      if (now - lastReq < 30000) {
        console.warn(`[WebRTC Host] Takeover request rate limited for "${username}"`)
        ctx.sendMessage(
          {
            type: 'SESSION_CONFLICT',
            conflictingUsername: username,
            conflictingUserId: userId,
            rejected: true,
            authCode: currentInviteCode
          },
          senderId
        )
        return true
      }
      ctx.takeoverCooldowns.set(username, now)

      const clientIds = ctx.scoutIdToClientIds.get(userId)
      const oldClientId = clientIds ? Array.from(clientIds).find((cid) => cid !== senderId) : undefined
      const oldClient = oldClientId ? ctx.clients.get(oldClientId) : undefined

      if (!oldClientId || !oldClient || !oldClient.dc || oldClient.dc.readyState !== 'open') {
        // Old client is not connected, immediately permit takeover
        ctx.promoteTakeover(userId, username, senderId, oldClientId, 'TAKEOVER_PERMITTED')
        return true
      }

      // Send 15s takeover prompt to old client
      ctx.sendMessage(
        {
          type: 'TAKEOVER_PROMPT',
          requesterUsername: username,
          timeoutSeconds: 15,
          authCode: currentInviteCode
        },
        oldClientId
      )

      const existingPending = ctx.pendingTakeovers.get(userId)
      if (existingPending) {
        clearTimeout(existingPending.timeoutTimer)
      }

      const timer = setTimeout(() => {
        console.log(`[WebRTC Host] 15s takeover prompt timed out for "${username}". Auto-permitting takeover.`)
        ctx.pendingTakeovers.delete(userId)
        ctx.promoteTakeover(userId, username, senderId, oldClientId, 'TAKEOVER_TIMEOUT')
      }, 15000)

      ctx.pendingTakeovers.set(userId, {
        newClientId: senderId,
        oldClientId,
        username,
        timeoutTimer: timer
      })
      return true
    }

    case 'TAKEOVER_DECISION': {
      if (!isHostMode || !senderId) return true
      const username = msg.username
      const boundUserId = senderId ? ctx.clientIdToScoutId.get(senderId) : undefined

      let pendingKey: string | undefined = boundUserId
      let pending = boundUserId ? ctx.pendingTakeovers.get(boundUserId) : undefined
      if (!pending) {
        for (const [key, p] of ctx.pendingTakeovers.entries()) {
          if ((username && p.username.toLowerCase() === username.toLowerCase()) || p.oldClientId === senderId) {
            pending = p
            pendingKey = key
            break
          }
        }
      }
      if (!pending || !pendingKey) return true

      const targetUserId = pendingKey

      clearTimeout(pending.timeoutTimer)
      ctx.pendingTakeovers.delete(pendingKey)

      if (msg.permit) {
        ctx.promoteTakeover(targetUserId, pending.username, pending.newClientId, pending.oldClientId, 'TAKEOVER_PERMITTED')
      } else {
        console.log(`[WebRTC Host] Takeover rejected by old client for "${username}"`)
        ctx.sendMessage(
          {
            type: 'SESSION_CONFLICT',
            conflictingUsername: pending.username,
            conflictingUserId: targetUserId,
            rejected: true,
            authCode: currentInviteCode
          },
          pending.newClientId
        )
      }
      return true
    }

    case 'SESSION_CONFLICT':
      callbacks.onSessionConflict?.(
        msg.conflictingUsername,
        msg.conflictingUserId,
        msg.rejected,
        msg.conflictType,
        msg.suggestedName
      )
      return true

    case 'TAKEOVER_PROMPT':
      callbacks.onTakeoverPrompt?.(msg.requesterUsername, msg.timeoutSeconds)
      return true

    case 'TAKEOVER_SUCCESS':
      console.log('[WebRTC] Session takeover was successful!')
      callbacks.onTakeoverSuccess?.()
      return true

    case 'SESSION_KICKED':
      console.warn(`[WebRTC] Session kicked by host. Reason: ${msg.reason}`)
      callbacks.onSessionKicked?.(msg.reason)
      ctx.closeClient()
      ctx.setStatus('offline')
      return true

    case 'IDENTITY_MIGRATION':
      if (msg.eventId && msg.oldScoutId && msg.newScoutId && msg.newScoutName) {
        console.log(
          `[WebRTC] Received IDENTITY_MIGRATION for event ${msg.eventId}: ${msg.oldScoutId} -> ${msg.newScoutId} (${msg.newScoutName})`
        )
        if (callbacks.onIdentityMigration) {
          await callbacks.onIdentityMigration(msg.eventId, msg.oldScoutId, msg.newScoutId, msg.newScoutName)
        }
        if (isHostMode) {
          if (senderId) {
            quarantinedSenders.delete(senderId)
            const oldSet = ctx.scoutIdToClientIds.get(msg.oldScoutId)
            ctx.scoutIdToClientIds.delete(msg.oldScoutId)
            let targetSet = ctx.scoutIdToClientIds.get(msg.newScoutId)
            if (!targetSet) {
              targetSet = new Set<string>()
              ctx.scoutIdToClientIds.set(msg.newScoutId, targetSet)
            }
            if (oldSet) {
              for (const cid of oldSet) {
                targetSet.add(cid)
                ctx.clientIdToScoutId.set(cid, msg.newScoutId)
                ctx.clientIdToScoutName.set(cid, msg.newScoutName)
              }
            }
            targetSet.add(senderId)
            ctx.clientIdToScoutId.set(senderId, msg.newScoutId)
            ctx.clientIdToScoutName.set(senderId, msg.newScoutName)
          }
          // Broadcast IDENTITY_MIGRATION to all other clients
          ctx.clients.forEach((c, cid) => {
            if (cid !== senderId && c.dc && c.dc.readyState === 'open') {
              if (!c.sender) c.sender = new DataChannelSender(c.dc)
              c.sender.enqueueSendQuiet(JSON.stringify(msg), 'IDENTITY_MIGRATION broadcast')
            }
          })
          if (senderId) {
            ctx.sendMessage(
              {
                type: 'ACK_MIGRATION',
                eventId: msg.eventId,
                newScoutId: msg.newScoutId,
                authCode: currentInviteCode
              },
              senderId
            )
          }
        }
      }
      return true

    case 'ACK_MIGRATION':
      console.log(`[WebRTC] Host acknowledged identity migration for newScoutId ${msg.newScoutId}`)
      return true

    case 'MERGE_ACCOUNT_REQUEST': {
      if (!isHostMode) return true
      const { requestId, targetUsername, targetPassword, sourceUserId } = msg
      try {
        const cleanUser = (targetUsername || '').trim()
        const cleanPwd = (targetPassword || '').trim()
        const { login: apiLogin } = await import('@/services/api')
        const authRes = await apiLogin({
          username: cleanUser,
          password: cleanPwd
        })

        if (!authRes || !authRes.id) {
          throw new Error('Invalid credentials')
        }

        const currentEventId = ctx.getCurrentEventId?.() || ctx.currentInviteCode()
        if (callbacks.onIdentityMigration && currentEventId && sourceUserId && sourceUserId !== authRes.id) {
          await callbacks.onIdentityMigration(currentEventId, sourceUserId, authRes.id, authRes.username)
        }

        if (senderId) {
          quarantinedSenders.delete(senderId)
          let targetSet = ctx.scoutIdToClientIds.get(authRes.id)
          if (!targetSet) {
            targetSet = new Set<string>()
            ctx.scoutIdToClientIds.set(authRes.id, targetSet)
          }
          if (sourceUserId && sourceUserId !== authRes.id) {
            const oldSet = ctx.scoutIdToClientIds.get(sourceUserId)
            ctx.scoutIdToClientIds.delete(sourceUserId)
            if (oldSet) {
              for (const cid of oldSet) {
                targetSet.add(cid)
                ctx.clientIdToScoutId.set(cid, authRes.id)
                ctx.clientIdToScoutName.set(cid, authRes.username)
              }
            }
          }
          targetSet.add(senderId)
          ctx.clientIdToScoutId.set(senderId, authRes.id)
          ctx.clientIdToScoutName.set(senderId, authRes.username)
        }

        // Broadcast IDENTITY_MIGRATION to all other connected clients if ID changed
        if (currentEventId && sourceUserId && sourceUserId !== authRes.id) {
          const migrationMsg = {
            type: 'IDENTITY_MIGRATION' as const,
            eventId: currentEventId,
            oldScoutId: sourceUserId,
            newScoutId: authRes.id,
            newScoutName: authRes.username,
            authCode: currentInviteCode
          }
          ctx.clients.forEach((c, cid) => {
            if (cid !== senderId && c.dc && c.dc.readyState === 'open') {
              if (!c.sender) c.sender = new DataChannelSender(c.dc)
              c.sender.enqueueSendQuiet(JSON.stringify(migrationMsg), 'IDENTITY_MIGRATION broadcast')
            }
          })
        }

        if (senderId) {
          await ctx.sendMessage(
            {
              type: 'MERGE_ACCOUNT_RESPONSE',
              requestId,
              success: true,
              newId: authRes.id,
              newUsername: authRes.username,
              token: authRes.token,
              authCode: currentInviteCode
            },
            senderId
          )
        }
      } catch (err: any) {
        console.warn('[WebRTC Host] Account merge failed for request:', requestId, err?.message)
        let errorMsg = err?.message || 'Invalid target account password'
        if (err?.status === 401 || errorMsg.includes('401') || errorMsg.includes('Invalid credentials')) {
          errorMsg = 'Invalid target account password'
        }
        if (senderId) {
          await ctx.sendMessage(
            {
              type: 'MERGE_ACCOUNT_RESPONSE',
              requestId,
              success: false,
              error: errorMsg,
              authCode: currentInviteCode
            },
            senderId
          )
        }
      }
      return true
    }

    case 'MERGE_ACCOUNT_RESPONSE': {
      if (isHostMode) return true
      if (ctx.handleMergeAccountResponse) {
        ctx.handleMergeAccountResponse(msg)
      }
      return true
    }

    default:
      return false
  }
}
