import type {
  WebRtcMessage,
  ScoutingRecord,
  ConnectionStatus
} from '@/types'
import { safeJsonParse } from '@/utils/json'
import { syncRecords } from '@/services/api'
import { DataChannelSender } from '@/services/dataChannelSender'
import { useInboxStore } from '@/stores/inbox'
import { useUserStore } from '@/stores/user'
import type { WebRtcCallbacks, ClientEntry } from './types'
import type { OfflineMessageManager } from './offlineQueue'

export interface ChannelMessageHandlerContext {
  isHostMode: () => boolean
  currentInviteCode: () => string
  getHostSessionId: () => string
  getCurrentHostSessionId: () => string
  setCurrentHostSessionId: (id: string) => void
  callbacks: WebRtcCallbacks
  clients: Map<string, ClientEntry>
  stagedClients: Map<string, ClientEntry>
  scoutIdToClientIds: Map<string, Set<string>>
  clientIdToScoutId: Map<string, string>
  clientIdToScoutName: Map<string, string>
  pendingTakeovers: Map<string, { newClientId: string; oldClientId?: string; username: string; timeoutTimer: any }>
  takeoverCooldowns: Map<string, number>
  offlineMessages: OfflineMessageManager
  sendMessage: (msg: WebRtcMessage, targetId?: string) => Promise<void>
  promoteTakeover: (userId: string, username: string, newClientId: string, oldClientId: string | undefined, reason: string) => void
  enqueueHostTask: (sender: string, task: () => Promise<void>) => Promise<void>
  cleanupPeerResources: (peerId: string) => void
  stampHostSeq: (records: ScoutingRecord[]) => void
  getHostSeqCounter: () => number
  setHostSeqCounter: (n: number) => void
  closeClient: () => void
  setStatus: (s: ConnectionStatus) => void
}

export function createChannelMessageHandler(ctx: ChannelMessageHandlerContext) {
  const OFFLINE_MSG_TTL_MS = 10 * 60 * 1000

  return async function handleChannelMessage(ev: MessageEvent, senderId?: string): Promise<void> {
    const msg = safeJsonParse<WebRtcMessage>(ev.data)
    if (!msg) {
      console.warn('[WebRTC] Ignored invalid or malformed data-channel message payload')
      return
    }

    const currentInviteCode = ctx.currentInviteCode()
    if (msg.authCode && msg.authCode !== currentInviteCode) {
      console.warn('[WebRTC] Auth code mismatch, ignoring message')
      return
    }

    console.log(`[WebRTC] Received message ${msg.type} from ${senderId || 'unknown'}`)

    const isHostMode = ctx.isHostMode()
    const callbacks = ctx.callbacks

    switch (msg.type) {
      case 'REQUEST_SYNC':
        if (isHostMode && senderId) {
          const senderUserId = msg.senderUserId
          const senderUserName = msg.senderUserName

          if (senderUserId) {
            // Mode 1: SAME USER ID - Multi-Device Coexistence!
            // Clean up any stale/closed clients for this user first
            const existingClientIds = ctx.scoutIdToClientIds.get(senderUserId)
            if (existingClientIds) {
              for (const cid of Array.from(existingClientIds)) {
                if (cid === senderId) continue
                const existingClient = ctx.clients.get(cid)
                if (!existingClient || !existingClient.dc || existingClient.dc.readyState !== 'open') {
                  if (existingClient) {
                    if (existingClient.dc) existingClient.dc.onclose = null
                    existingClient.pc.close()
                    ctx.clients.delete(cid)
                  }
                  existingClientIds.delete(cid)
                  ctx.clientIdToScoutId.delete(cid)
                  ctx.clientIdToScoutName.delete(cid)
                  ctx.cleanupPeerResources(cid)
                }
              }
              if (existingClientIds.size === 0) {
                ctx.scoutIdToClientIds.delete(senderUserId)
              }
            }

            // Mode 2: DUPLICATE NAME Conflict (Different Person, Same Display Name)
            if (senderUserName) {
              let duplicateNameClientId: string | null = null
              for (const [boundScoutId, boundClientIds] of ctx.scoutIdToClientIds.entries()) {
                if (boundScoutId !== senderUserId) {
                  for (const boundClientId of boundClientIds) {
                    if (boundClientId !== senderId) {
                      const boundName = ctx.clientIdToScoutName.get(boundClientId)
                      if (boundName && boundName.trim().toLowerCase() === senderUserName.trim().toLowerCase()) {
                        const peerClient = ctx.clients.get(boundClientId)
                        if (peerClient && peerClient.dc && peerClient.dc.readyState === 'open') {
                          duplicateNameClientId = boundClientId
                          break
                        }
                      }
                    }
                  }
                  if (duplicateNameClientId) break
                }
              }

              if (duplicateNameClientId) {
                console.warn(
                  `[WebRTC Host] Detected duplicate name conflict for username "${senderUserName}" (different userId ${senderUserId} vs existing). Prompting to rename.`
                )
                const randomSuffix = Math.floor(10 + Math.random() * 90)
                ctx.sendMessage(
                  {
                    type: 'SESSION_CONFLICT',
                    conflictType: 'DUPLICATE_NAME',
                    conflictingUsername: senderUserName,
                    conflictingUserId: senderUserId,
                    suggestedName: `${senderUserName}-${randomSuffix}`,
                    authCode: currentInviteCode
                  },
                  senderId
                )
                return
              }
            }

            const staged = ctx.stagedClients.get(senderId)
            if (staged) {
              const oldActive = ctx.clients.get(senderId)
              if (oldActive && oldActive !== staged) {
                if (oldActive.dc) oldActive.dc.onclose = null
                oldActive.pc.onconnectionstatechange = null
                oldActive.pc.oniceconnectionstatechange = null
                oldActive.dc?.close()
                oldActive.pc.close()
              }
              ctx.clients.set(senderId, staged)
              ctx.stagedClients.delete(senderId)
            }

            let clientSet = ctx.scoutIdToClientIds.get(senderUserId)
            if (!clientSet) {
              clientSet = new Set<string>()
              ctx.scoutIdToClientIds.set(senderUserId, clientSet)
            }
            clientSet.add(senderId)
            ctx.clientIdToScoutId.set(senderId, senderUserId)
            if (senderUserName) {
              ctx.clientIdToScoutName.set(senderId, senderUserName)
              callbacks.onClientConnected?.(senderUserId, senderUserName)
            }
            const pending = ctx.offlineMessages.flush(senderUserId)
            if (pending && pending.length > 0) {
              const now = Date.now()
              pending
                .filter((item) => now - item.queuedAt < OFFLINE_MSG_TTL_MS)
                .forEach((item) => ctx.sendMessage(item.message, senderId))
            }
          }
        }
        callbacks.onRequestSync(msg.sinceVersion ?? 0, senderId)
        break

      case 'SYNC_DATA': {
        if (!Array.isArray(msg.records)) {
          console.warn('[WebRTC] Received SYNC_DATA with non-array records payload, ignoring')
          break
        }
        if (msg.hostSessionId) {
          ctx.setCurrentHostSessionId(msg.hostSessionId)
        }

        if (isHostMode && senderId && !ctx.clientIdToScoutId.has(senderId)) {
          const senderUserId = msg.senderUserId
          const senderUserName = msg.senderUserName
          if (senderUserId) {
            const staged = ctx.stagedClients.get(senderId)
            if (staged) {
              const oldActive = ctx.clients.get(senderId)
              if (oldActive && oldActive !== staged) {
                if (oldActive.dc) oldActive.dc.onclose = null
                oldActive.pc.onconnectionstatechange = null
                oldActive.pc.oniceconnectionstatechange = null
                oldActive.dc?.close()
                oldActive.pc.close()
              }
              ctx.clients.set(senderId, staged)
              ctx.stagedClients.delete(senderId)
            }

            let clientSet = ctx.scoutIdToClientIds.get(senderUserId)
            if (!clientSet) {
              clientSet = new Set<string>()
              ctx.scoutIdToClientIds.set(senderUserId, clientSet)
            }
            clientSet.add(senderId)
            ctx.clientIdToScoutId.set(senderId, senderUserId)
            if (senderUserName) {
              ctx.clientIdToScoutName.set(senderId, senderUserName)
              callbacks.onClientConnected?.(senderUserId, senderUserName)
            }
          }
        }

        if (isHostMode) {
          return ctx.enqueueHostTask(senderId || 'default', async () => {
            const expectedScoutId = senderId ? ctx.clientIdToScoutId.get(senderId) : undefined

            // 安全过滤：防伪造冒充。每一条同步的记录必须匹配该 DataChannel 经 JWT 验证绑定的权威 scoutId
            const legitimateRecords: ScoutingRecord[] = []
            const forgedRecordIds: string[] = []

            for (const r of msg.records) {
              if (!r || typeof r !== 'object' || !r.id) continue
              if (!expectedScoutId || r.scoutId !== expectedScoutId) {
                console.error(
                  `[WebRTC Host Security] Dropped forged record ${r.id}: claimed scoutId="${r.scoutId}" does not match peer authenticated scoutId="${expectedScoutId}"`
                )
                forgedRecordIds.push(r.id)
              } else {
                legitimateRecords.push(r)
              }
            }

            // 步骤 1：本地过滤并打上单调递增的 hostSeq
            const accepted =
              legitimateRecords.length > 0
                ? await callbacks.onRecordsReceived(legitimateRecords, senderId)
                : []
            const stagedSeq = ctx.getHostSeqCounter()
            if (accepted.length > 0) {
              ctx.stampHostSeq(accepted)
            }

            // 步骤 2：持久化先于广播执行！确保落库成功后再通知外界
            if (accepted.length > 0) {
              try {
                await syncRecords(accepted)
              } catch (err) {
                console.error('[WebRTC Host] Failed to persist stamped records to DB:', err)
                // 回滚计数器与 hostSeq，避免虚高断号
                ctx.setHostSeqCounter(stagedSeq)
                for (const r of accepted) {
                  r.hostSeq = undefined
                }
                // 回传拒绝回执，提示客户端重试
                ctx.sendMessage(
                  {
                    type: 'ACK_SYNC',
                    recordIds: msg.records.map((r) => r.id),
                    stampedRecords: [],
                    rejectedRecordIds: msg.records.map((r) => r.id),
                    authCode: currentInviteCode,
                    hostSessionId: ctx.getHostSessionId()
                  },
                  senderId
                )
                return
              }
            }

            const rejectedRecordIds = [
              ...forgedRecordIds,
              ...legitimateRecords.filter((r) => !accepted.some((a) => a.id === r.id)).map((r) => r.id)
            ]

            // 步骤 3：持久化成功，向原始推送者回传 ACK（含已打号记录及被拒记录 ID）
            ctx.sendMessage(
              {
                type: 'ACK_SYNC',
                recordIds: msg.records.map((r) => r.id),
                stampedRecords: accepted,
                rejectedRecordIds,
                authCode: currentInviteCode,
                hostSessionId: ctx.getHostSessionId()
              },
              senderId
            )

            // 步骤 4：唯有 Host 持久化成功后，才向房间内其他 Client 广播更新
            if (accepted.length > 0) {
              const BATCH_SIZE = 15
              for (let i = 0; i < accepted.length; i += BATCH_SIZE) {
                const chunk = accepted.slice(i, i + BATCH_SIZE)
                const payload = JSON.stringify({
                  type: 'SYNC_DATA',
                  records: chunk,
                  authCode: currentInviteCode,
                  hostSessionId: ctx.getHostSessionId()
                })
                ctx.clients.forEach((c, cid) => {
                  if (cid !== senderId && c.dc && c.dc.readyState === 'open') {
                    if (!c.sender) c.sender = new DataChannelSender(c.dc)
                    c.sender.enqueueSend(payload).catch((err) => {
                      console.warn(`[WebRTC Host] Failed to broadcast chunk to client ${cid}:`, err)
                    })
                  }
                })
              }
            }
          })
        } else {
          // Client 收到 Host 下发的记录，写入本地
          const safeRecords = msg.records.filter((r) => r && typeof r === 'object' && r.id)
          if (safeRecords.length > 0) {
            await callbacks.onRecordsReceived(safeRecords, senderId)
          }
        }
        break
      }

      case 'ACK_SYNC':
        if (!Array.isArray(msg.recordIds)) {
          console.warn('[WebRTC] Received ACK_SYNC with non-array recordIds payload, ignoring')
          break
        }
        if (msg.hostSessionId) {
          ctx.setCurrentHostSessionId(msg.hostSessionId)
        }
        callbacks.onAckReceived(
          msg.recordIds,
          Array.isArray(msg.stampedRecords) ? msg.stampedRecords : undefined,
          Array.isArray(msg.rejectedRecordIds) ? msg.rejectedRecordIds : undefined
        )
        break

      case 'DIRECT_MESSAGE': {
        const inboxStore = useInboxStore()
        const userStore = useUserStore()
        const myUserId = userStore.userId
        
        // 目标是本地用户或者未指定目标时，存入本地收件箱
        if (!msg.targetId || msg.targetId === myUserId || (isHostMode && msg.targetId === 'host')) {
          inboxStore.addMessage({
            id: msg.messageId || msg.id,
            title: msg.title,
            body: msg.body,
            type: 'direct',
            senderId: msg.senderId,
            senderName: msg.senderName,
            targetId: msg.targetId,
            targetName: msg.targetName,
            deliveryStatus: 'DELIVERED'
          })
        }

        // Host 负责星型拓扑下的私信转发
        if (isHostMode) {
          if (msg.targetId && msg.targetId !== myUserId && msg.targetId !== 'host') {
            const targetClientIds = ctx.scoutIdToClientIds.get(msg.targetId)
            let forwarded = false
            if (targetClientIds && targetClientIds.size > 0) {
              for (const cid of targetClientIds) {
                if (cid === senderId) continue // Do not echo back to the sender's device socket
                const targetClient = ctx.clients.get(cid)
                if (targetClient && targetClient.dc && targetClient.dc.readyState === 'open') {
                  if (!targetClient.sender) targetClient.sender = new DataChannelSender(targetClient.dc)
                  targetClient.sender.enqueueSend(JSON.stringify(msg))
                  forwarded = true
                }
              }
            } else {
              const targetClient = ctx.clients.get(msg.targetId)
              if (targetClient && targetClient.dc && targetClient.dc.readyState === 'open') {
                if (msg.targetId !== senderId) {
                  if (!targetClient.sender) targetClient.sender = new DataChannelSender(targetClient.dc)
                  targetClient.sender.enqueueSend(JSON.stringify(msg))
                  forwarded = true
                }
              }
            }
            if (!forwarded) {
              ctx.offlineMessages.enqueue(msg.targetId, msg)
            }
          }
        }
        break
      }

      case 'TEAM_TAGS_UPDATE':
        if (msg.eventId && msg.tag) {
          callbacks.onTagUpdateReceived?.(msg.tag, msg.action, msg.eventId, msg.teamNumber)
          // Host 广播给其他 Client
          if (isHostMode && senderId) {
            ctx.clients.forEach((c, cid) => {
              if (cid !== senderId && c.dc && c.dc.readyState === 'open') {
                if (!c.sender) c.sender = new DataChannelSender(c.dc)
                c.sender.enqueueSend(JSON.stringify(msg))
              }
            })
          }
        }
        break

      case 'REQUEST_TAGS_SYNC':
        if (isHostMode) {
          callbacks.onRequestTagsSync?.(senderId)
        }
        break

      case 'TAGS_FULL_SYNC':
        if (!isHostMode && msg.eventId && Array.isArray(msg.tags)) {
          callbacks.onTagsFullSyncReceived?.(msg.tags, msg.eventId)
        }
        break

      case 'REQUEST_SCHEDULE_SYNC':
        if (isHostMode) {
          callbacks.onRequestScheduleSync?.(senderId)
        }
        break

      case 'SCHEDULE_FULL_SYNC':
        if (!isHostMode && Array.isArray(msg.schedules)) {
          callbacks.onScheduleFullSyncReceived?.(msg.schedules, msg.assignments || [])
        }
        break

      case 'ASSIGNMENT_UPDATE':
        if (msg.assignment) {
          callbacks.onAssignmentUpdateReceived?.(msg.assignment)
          if (isHostMode) {
            // Forward to other clients
            ctx.clients.forEach((c, cid) => {
              if (cid !== senderId && c.dc && c.dc.readyState === 'open') {
                if (!c.sender) c.sender = new DataChannelSender(c.dc)
                c.sender.enqueueSend(JSON.stringify(msg))
              }
            })
          }
        }
        break

      case 'REQUEST_PIT_SYNC':
        if (isHostMode) {
          callbacks.onRequestPitSync?.(senderId)
        }
        break

      case 'PIT_SCOUT_FULL_SYNC':
        if (!isHostMode && Array.isArray(msg.records)) {
          callbacks.onPitScoutFullSyncReceived?.(msg.records)
        }
        break

      case 'PIT_SCOUT_UPDATE':
        if (msg.record) {
          callbacks.onPitScoutUpdateReceived?.(msg.record)
          if (isHostMode) {
            // Forward to other clients
            ctx.clients.forEach((c, cid) => {
              if (cid !== senderId && c.dc && c.dc.readyState === 'open') {
                if (!c.sender) c.sender = new DataChannelSender(c.dc)
                c.sender.enqueueSend(JSON.stringify(msg))
              }
            })
          }
        }
        break

      case 'PIT_SCOUT_BATCH_SYNC':
        if (Array.isArray(msg.records) && msg.records.length > 0) {
          callbacks.onPitScoutBatchSyncReceived?.(msg.records, senderId)
          if (isHostMode) {
            // Forward to other clients
            ctx.clients.forEach((c, cid) => {
              if (cid !== senderId && c.dc && c.dc.readyState === 'open') {
                if (!c.sender) c.sender = new DataChannelSender(c.dc)
                c.sender.enqueueSend(JSON.stringify(msg))
              }
            })
          }
        }
        break

      case 'OFFICIAL_ROSTER_SYNC':
        if (!isHostMode && Array.isArray(msg.teams)) {
          callbacks.onOfficialRosterSyncReceived?.(msg.teams)
        }
        break

      case 'TAKEOVER_REQUEST': {
        if (!isHostMode || !senderId) break
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
        if (!username || !userId) break

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
          break
        }
        ctx.takeoverCooldowns.set(username, now)

        const clientIds = ctx.scoutIdToClientIds.get(userId)
        const oldClientId = clientIds ? Array.from(clientIds).find((cid) => cid !== senderId) : undefined
        const oldClient = oldClientId ? ctx.clients.get(oldClientId) : undefined

        if (!oldClientId || !oldClient || !oldClient.dc || oldClient.dc.readyState !== 'open') {
          // Old client is not connected, immediately permit takeover
          ctx.promoteTakeover(userId, username, senderId, oldClientId, 'TAKEOVER_PERMITTED')
          break
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
        break
      }

      case 'TAKEOVER_DECISION': {
        if (!isHostMode || !senderId) break
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
        if (!pending || !pendingKey) break

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
        break
      }

      case 'SESSION_CONFLICT':
        callbacks.onSessionConflict?.(
          msg.conflictingUsername,
          msg.conflictingUserId,
          msg.rejected,
          msg.conflictType,
          msg.suggestedName
        )
        break

      case 'TAKEOVER_PROMPT':
        callbacks.onTakeoverPrompt?.(msg.requesterUsername, msg.timeoutSeconds)
        break

      case 'SESSION_KICKED':
        console.warn(`[WebRTC] Session kicked by host. Reason: ${msg.reason}`)
        callbacks.onSessionKicked?.(msg.reason)
        ctx.closeClient()
        ctx.setStatus('offline')
        break

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
                c.sender.enqueueSend(JSON.stringify(msg))
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
        break

      case 'ACK_MIGRATION':
        console.log(`[WebRTC] Host acknowledged identity migration for newScoutId ${msg.newScoutId}`)
        break

      case 'EVENT_METADATA':
        if (msg.event) {
          console.log(`[WebRTC] Received EVENT_METADATA for event ${msg.event.id} (${msg.event.name})`)
          callbacks.onEventMetadataReceived?.(msg.event)
        }
        break
    }
  }
}
