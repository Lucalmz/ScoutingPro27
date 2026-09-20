import type {
  WebRtcMessage,
  ScoutingRecord,
  ConnectionStatus
} from '@/types'
import { safeJsonParse } from '@/utils/json'
import { syncRecords } from '@/services/api'
import { DataChannelSender } from '@/services/dataChannelSender'
import { useInboxStore } from '@/stores/inbox'
import { getActivePinia } from 'pinia'
import { useUserStore } from '@/stores/user'
import type { WebRtcCallbacks, ClientEntry } from './types'
import type { OfflineMessageManager } from './offlineQueue'
import { createLogger } from '@/utils/logger'

const log = createLogger('WebRTC:Data')

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
  getCurrentEventId?: () => string
  getUsername?: () => string
  getUserId?: () => string
  handleMergeAccountResponse?: (msg: any) => void
  isTakeoverReconciling?: () => boolean
  waitForTakeoverReconciliation?: () => Promise<void>
  finishTakeoverReconciliation?: (reason?: string) => void
  onPongReceived?: (timestamp: number) => void
}

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

export function createChannelMessageHandler(ctx: ChannelMessageHandlerContext) {
  const OFFLINE_MSG_TTL_MS = 10 * 60 * 1000

  return async function handleChannelMessage(ev: MessageEvent, senderId?: string): Promise<void> {
    const msg = safeJsonParse<WebRtcMessage>(ev.data)
    if (!msg) {
      log.warn('Ignored invalid or malformed data-channel message payload')
      return
    }

    const currentInviteCode = ctx.currentInviteCode()
    if (msg.authCode && msg.authCode !== currentInviteCode) {
      log.warn(`Auth code mismatch for message ${msg.type}, ignoring message`, {
        expected: currentInviteCode,
        received: msg.authCode
      })
      return
    }

    log.info(`Received message ${msg.type} from ${senderId || 'unknown'}`)

    const isHostMode = ctx.isHostMode()
    const callbacks = ctx.callbacks

    switch (msg.type) {
      case 'PING' as any: {
        if (isHostMode) {
          await ctx.sendMessage({ type: 'PONG' as any, timestamp: (msg as any).timestamp }, senderId)
        }
        return
      }
      case 'PONG' as any: {
        if (!isHostMode && ctx.onPongReceived) {
          ctx.onPongReceived((msg as any).timestamp)
        }
        return
      }
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
              let conflictingExistingId: string | null = null

              // 1. Check against Host's own user identity
              let hostUser: any = null
              if (getActivePinia()) {
                try {
                  const uStore = useUserStore()
                  hostUser = uStore.user || (uStore.username ? { id: uStore.userId, username: uStore.username } : null)
                } catch {}
              }
              if (!hostUser && typeof localStorage !== 'undefined') {
                try {
                  const raw = localStorage.getItem('scoutingpro-user')
                  if (raw) hostUser = JSON.parse(raw)
                } catch {}
              }
              if (!hostUser && ctx.getUsername?.()) {
                hostUser = { id: ctx.getUserId?.() || '', username: ctx.getUsername?.() || '' }
              }

              if (
                hostUser &&
                hostUser.id !== senderUserId &&
                hostUser.username &&
                hostUser.username.trim().toLowerCase() === senderUserName.trim().toLowerCase()
              ) {
                conflictingExistingId = hostUser.id
              }

              // 2. Check against other connected clients
              if (!conflictingExistingId) {
                for (const [boundScoutId, boundClientIds] of ctx.scoutIdToClientIds.entries()) {
                  if (boundScoutId !== senderUserId) {
                    for (const boundClientId of boundClientIds) {
                      if (boundClientId !== senderId) {
                        const boundName = ctx.clientIdToScoutName.get(boundClientId)
                        if (boundName && boundName.trim().toLowerCase() === senderUserName.trim().toLowerCase()) {
                          const peerClient = ctx.clients.get(boundClientId)
                          if (peerClient && peerClient.dc && peerClient.dc.readyState === 'open') {
                            duplicateNameClientId = boundClientId
                            conflictingExistingId = boundScoutId
                            break
                          }
                        }
                      }
                    }
                    if (conflictingExistingId) break
                  }
                }
              }

              if (conflictingExistingId) {
                console.warn(
                  `[WebRTC Host] Detected duplicate name conflict for username "${senderUserName}" (different userId ${senderUserId} vs existing ${conflictingExistingId}). Prompting to rename or merge.`
                )
                const randomSuffix = Math.floor(10 + Math.random() * 90)
                ctx.sendMessage(
                  {
                    type: 'SESSION_CONFLICT',
                    conflictType: 'DUPLICATE_NAME',
                    conflictingUsername: senderUserName,
                    conflictingUserId: conflictingExistingId,
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
        if (isHostMode && msg.clientMaxSeq && typeof msg.clientMaxSeq === 'number' && msg.clientMaxSeq > 0) {
          const curSeq = ctx.getHostSeqCounter()
          if (msg.clientMaxSeq > curSeq) {
            console.log(`[WebRTC Host] Advancing hostSeqCounter from ${curSeq} to ${msg.clientMaxSeq} based on clientMaxSeq`)
            ctx.setHostSeqCounter(msg.clientMaxSeq)
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
            if (ctx.isTakeoverReconciling?.()) {
              log.info(`Takeover reconciliation active; awaiting handoff completion before processing SYNC_DATA from ${senderId}`)
              await ctx.waitForTakeoverReconciliation?.()
            }
            const expectedScoutId = senderId ? ctx.clientIdToScoutId.get(senderId) : undefined

            // 安全过滤：防伪造冒充。每一条同步的记录必须匹配该 DataChannel 经 JWT 验证绑定的权威 scoutId
            const legitimateRecords: ScoutingRecord[] = []
            const forgedRecordIds: string[] = []

            for (const r of msg.records) {
              if (!r || typeof r !== 'object' || !r.id) continue
              if (!expectedScoutId || r.scoutId !== expectedScoutId) {
                log.error(`Dropped forged record ${r.id}: claimed scoutId="${r.scoutId}" does not match peer authenticated scoutId="${expectedScoutId}"`)
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
                  if (r.hostSeq && r.hostSeq > stagedSeq) {
                    r.hostSeq = undefined
                  }
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

      case 'REQUEST_CUSTOM_FIELDS_SYNC':
        if (isHostMode) {
          callbacks.onRequestCustomFieldsSync?.(senderId)
        }
        break

      case 'CUSTOM_FIELDS_FULL_SYNC':
        if (!isHostMode && Array.isArray(msg.fields)) {
          callbacks.onCustomFieldsFullSyncReceived?.(msg.fields, msg.eventId)
        }
        break

      case 'CUSTOM_FIELD_UPDATE':
        if (msg.field) {
          callbacks.onCustomFieldUpdateReceived?.(msg.field, msg.action, msg.eventId)
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

      case 'SCHEDULE_BATCH_SYNC':
        if (!isHostMode && Array.isArray(msg.schedules)) {
          callbacks.onScheduleBatchSyncReceived?.(
            msg.schedules,
            msg.assignments || [],
            msg.batchIndex ?? 0,
            msg.totalBatches ?? 1
          )
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
            // 回传确认回执给发送方 Client
            if (senderId && msg.record.teamNumber) {
              ctx.sendMessage(
                {
                  type: 'PIT_SCOUT_ACK',
                  teamNumbers: [msg.record.teamNumber],
                  authCode: currentInviteCode
                },
                senderId
              )
            }
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
            // 回传批量确认回执给发送方 Client
            if (senderId) {
              const teamNumbers = msg.records
                .map((r: any) => r?.teamNumber)
                .filter((n: any) => typeof n === 'number')
              if (teamNumbers.length > 0) {
                ctx.sendMessage(
                  {
                    type: 'PIT_SCOUT_ACK',
                    teamNumbers,
                    authCode: currentInviteCode
                  },
                  senderId
                )
              }
            }
          }
        }
        break

      case 'PIT_SCOUT_ACK':
        if (!isHostMode && Array.isArray(msg.teamNumbers)) {
          callbacks.onPitScoutAckReceived?.(msg.teamNumbers)
        }
        break

      case 'OFFICIAL_ROSTER_SYNC':
        if (!isHostMode && Array.isArray(msg.teams)) {
          callbacks.onOfficialRosterSyncReceived?.(msg.teams)
        }
        break

      case 'HOST_HANDOFF_BATCH': {
        if (isHostMode) {
          return ctx.enqueueHostTask(senderId || 'handoff', async () => {
            console.log(
              `[WebRTC Host] Received HOST_HANDOFF_BATCH from ${senderId || 'peer'}: ${msg.records?.length || 0} records, incomingMaxSeq=${msg.incomingMaxSeq}`
            )

            // 1. 批量落库并保留原有权威序列号
            let acceptedRecords: ScoutingRecord[] = []
            if (Array.isArray(msg.records) && msg.records.length > 0) {
              acceptedRecords = await callbacks.onRecordsReceived(msg.records, senderId)
              ctx.stampHostSeq(acceptedRecords)
              try {
                await syncRecords(acceptedRecords)
              } catch (err) {
                console.error('[WebRTC Host] Failed to persist handoff records to DB:', err)
              }
            }

            // 2. 推进 hostSeqCounter 至 max(当前, incomingMaxSeq, 记录中最大)
            const incomingSeq = typeof msg.incomingMaxSeq === 'number' ? msg.incomingMaxSeq : 0
            let curSeq = ctx.getHostSeqCounter()
            for (const r of acceptedRecords) {
              if (typeof r.hostSeq === 'number' && r.hostSeq > curSeq) {
                curSeq = r.hostSeq
              }
            }
            if (incomingSeq > curSeq) {
              curSeq = incomingSeq
            }
            ctx.setHostSeqCounter(curSeq)

            // 3. 处理赛程排班、Pit 展位、战队标签与自定义字段
            if (callbacks.onHostHandoffReceived) {
              await callbacks.onHostHandoffReceived(msg)
            } else {
              if (Array.isArray(msg.schedules) && Array.isArray(msg.assignments)) {
                callbacks.onScheduleFullSyncReceived?.(msg.schedules, msg.assignments)
              }
              if (Array.isArray(msg.pitRecords)) {
                callbacks.onPitScoutFullSyncReceived?.(msg.pitRecords)
              }
              if (Array.isArray(msg.teamTags) && msg.eventId) {
                callbacks.onTagsFullSyncReceived?.(msg.teamTags, msg.eventId)
              }
              if (Array.isArray(msg.customFields) && msg.eventId) {
                callbacks.onCustomFieldsFullSyncReceived?.(msg.customFields, msg.eventId)
              }
            }

            // 4. 解除 Takeover 对齐门禁，放行等待中的普通 SYNC_DATA 队列
            ctx.finishTakeoverReconciliation?.('handoff_processed')

            // 5. 回传 ACK
            if (senderId) {
              await ctx.sendMessage(
                {
                  type: 'HOST_HANDOFF_ACK',
                  eventId: msg.eventId,
                  acceptedCount: acceptedRecords.length,
                  alignedMaxSeq: curSeq,
                  hostEpoch: msg.hostEpoch || 0,
                  authCode: currentInviteCode,
                  hostSessionId: ctx.getHostSessionId()
                },
                senderId
              )
            }
          })
        }
        break
      }

      case 'HOST_HANDOFF_ACK': {
        console.log(
          `[WebRTC] Received HOST_HANDOFF_ACK: accepted ${msg.acceptedCount}, alignedMaxSeq=${msg.alignedMaxSeq}`
        )
        callbacks.onHostHandoffAck?.(msg)
        break
      }

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

      case 'TAKEOVER_SUCCESS':
        console.log('[WebRTC] Session takeover was successful!')
        callbacks.onTakeoverSuccess?.()
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
        break
      }

      case 'PIT_PHOTO_CHUNK': {
        if (!isHostMode) break
        const { transferId, eventId, key, chunkIndex, totalChunks, chunkData } = msg
        if (!transferId || !eventId || !key || typeof chunkIndex !== 'number' || typeof totalChunks !== 'number') {
          break
        }

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
            eventId,
            key,
            totalChunks,
            chunks: new Array(totalChunks),
            receivedCount: 0,
            updatedAt: now
          }
          photoChunkBuffers.set(transferId, buffer)
        }

        if (!buffer.chunks[chunkIndex]) {
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
        break
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
        break
      }

      case 'MERGE_ACCOUNT_REQUEST': {
        if (!isHostMode) break
        const { requestId, targetUsername, targetPassword, sourceUserId, sourceUsername } = msg
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
                c.sender.enqueueSend(JSON.stringify(migrationMsg))
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
        break
      }

      case 'MERGE_ACCOUNT_RESPONSE': {
        if (isHostMode) break
        if (ctx.handleMergeAccountResponse) {
          ctx.handleMergeAccountResponse(msg)
        }
        break
      }
    }
  }
}
