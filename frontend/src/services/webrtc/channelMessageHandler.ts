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
import { handleChannelPhotoMessage, isChannelPhotoMessageType } from './channelPhotoHandler'
import { handleChannelIdentityAndTakeoverMessage, isChannelIdentityAndTakeoverMessageType } from './channelIdentityHandler'
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

export type ChannelMessageHandler = ((ev: MessageEvent, senderId?: string) => Promise<void>) & {
  isQuarantinedPeer: (senderId: string) => boolean
  clearQuarantine: (senderId: string) => void
}

export function createChannelMessageHandler(ctx: ChannelMessageHandlerContext): ChannelMessageHandler {
  const OFFLINE_MSG_TTL_MS = 10 * 60 * 1000
  const quarantinedSenders = new Set<string>()

  const handler = async function handleChannelMessage(ev: MessageEvent, senderId?: string): Promise<void> {
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

    const normalizeIncomingEventId = (rawEventId?: string): string | undefined => {
      if (!rawEventId || !isHostMode) return rawEventId
      const hostAuthEventId = ctx.getCurrentEventId?.()
      const rawUpper = rawEventId.trim().toUpperCase()
      const codeUpper = (currentInviteCode || '').trim().toUpperCase()
      if (
        hostAuthEventId &&
        codeUpper &&
        (rawUpper === `EVT-${codeUpper}` || rawUpper === `EXT_${codeUpper}`)
      ) {
        return hostAuthEventId
      }
      return rawEventId
    }

    if (isHostMode && senderId && ctx.stagedClients?.has(senderId)) {
      const staged = ctx.stagedClients.get(senderId)
      if (staged) {
        const oldActive = ctx.clients.get(senderId)
        if (oldActive && oldActive !== staged) {
          if (oldActive.dc) {
            oldActive.dc.onmessage = null
            oldActive.dc.onopen = null
            oldActive.dc.onclose = null
            oldActive.dc.onerror = null
            try { oldActive.dc.close() } catch {}
          }
          if (oldActive.pc) {
            oldActive.pc.onicecandidate = null
            oldActive.pc.onconnectionstatechange = null
            oldActive.pc.oniceconnectionstatechange = null
            try { oldActive.pc.ondatachannel = () => {} } catch {}
            try { oldActive.pc.close() } catch {}
          }
        }
        ctx.clients.set(senderId, staged)
        ctx.stagedClients.delete(senderId)
      }
    }

    if (isChannelPhotoMessageType(msg.type)) {
      await handleChannelPhotoMessage(ctx, msg, senderId)
      return
    }

    if (isChannelIdentityAndTakeoverMessageType(msg.type)) {
      await handleChannelIdentityAndTakeoverMessage(ctx, quarantinedSenders, msg, senderId)
      return
    }

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
                  `[WebRTC Host] Detected duplicate name conflict for username "${senderUserName}" (different userId ${senderUserId} vs existing ${conflictingExistingId}). Placing client ${senderId} in quarantine.`
                )
                quarantinedSenders.add(senderId)
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
              } else {
                // 已无同名冲突（已重命名或合法合并），解除隔离
                quarantinedSenders.delete(senderId)
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
        if (isHostMode && senderId && quarantinedSenders.has(senderId)) {
          log.warn(`[WebRTC Host] Suppressing REQUEST_SYNC full sync for quarantined conflicting peer ${senderId}`)
          return
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

        if (isHostMode && senderId && quarantinedSenders.has(senderId)) {
          log.warn(`[WebRTC Host] Dropping SYNC_DATA from quarantined conflicting peer ${senderId} - records isolated`)
          return
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
                const hostAuthEventId = ctx.getCurrentEventId?.()
                const recEventUpper = (r.eventId || '').trim().toUpperCase()
                const codeUpper = (currentInviteCode || '').trim().toUpperCase()
                if (
                  hostAuthEventId &&
                  codeUpper &&
                  (recEventUpper === `EVT-${codeUpper}` || recEventUpper === `EXT_${codeUpper}`)
                ) {
                  r.eventId = hostAuthEventId
                }
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
                    c.sender.enqueueSendQuiet(payload, `records broadcast to ${cid}`)
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
                  targetClient.sender.enqueueSendQuiet(JSON.stringify(msg), 'DIRECT_MESSAGE forward')
                  forwarded = true
                }
              }
            } else {
              const targetClient = ctx.clients.get(msg.targetId)
              if (targetClient && targetClient.dc && targetClient.dc.readyState === 'open') {
                if (msg.targetId !== senderId) {
                  if (!targetClient.sender) targetClient.sender = new DataChannelSender(targetClient.dc)
                  targetClient.sender.enqueueSendQuiet(JSON.stringify(msg), 'DIRECT_MESSAGE forward')
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
          if (isHostMode) {
            msg.eventId = normalizeIncomingEventId(msg.eventId) || msg.eventId
            if (msg.tag.eventId) {
              msg.tag.eventId = normalizeIncomingEventId(msg.tag.eventId) || msg.tag.eventId
            }
          }
          callbacks.onTagUpdateReceived?.(msg.tag, msg.action, msg.eventId, msg.teamNumber)
          // Host 广播给其他 Client
          if (isHostMode && senderId) {
            ctx.clients.forEach((c, cid) => {
              if (cid !== senderId && c.dc && c.dc.readyState === 'open') {
                if (!c.sender) c.sender = new DataChannelSender(c.dc)
                c.sender.enqueueSendQuiet(JSON.stringify(msg), 'TEAM_TAGS_UPDATE broadcast')
              }
            })
          }
        }
        break

      case 'REQUEST_TAGS_SYNC':
        if (isHostMode) {
          if (senderId && quarantinedSenders.has(senderId)) {
            log.warn(`[WebRTC Host] Dropping REQUEST_TAGS_SYNC from quarantined conflicting peer ${senderId}`)
            break
          }
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
          if (senderId && quarantinedSenders.has(senderId)) {
            log.warn(`[WebRTC Host] Dropping REQUEST_CUSTOM_FIELDS_SYNC from quarantined conflicting peer ${senderId}`)
            break
          }
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
                c.sender.enqueueSendQuiet(JSON.stringify(msg), 'CUSTOM_FIELD_UPDATE broadcast')
              }
            })
          }
        }
        break

      case 'REQUEST_SCHEDULE_SYNC':
        if (isHostMode) {
          if (senderId && quarantinedSenders.has(senderId)) {
            log.warn(`[WebRTC Host] Dropping REQUEST_SCHEDULE_SYNC from quarantined conflicting peer ${senderId}`)
            break
          }
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
                c.sender.enqueueSendQuiet(JSON.stringify(msg), 'ASSIGNMENT_UPDATE broadcast')
              }
            })
          }
        }
        break

      case 'REQUEST_PIT_SYNC':
        if (isHostMode) {
          if (senderId && quarantinedSenders.has(senderId)) {
            log.warn(`[WebRTC Host] Dropping REQUEST_PIT_SYNC from quarantined conflicting peer ${senderId}`)
            break
          }
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
          if (isHostMode && msg.record.eventId) {
            msg.record.eventId = normalizeIncomingEventId(msg.record.eventId) || msg.record.eventId
          }
          callbacks.onPitScoutUpdateReceived?.(msg.record)
          if (isHostMode) {
            // Forward to other clients
            ctx.clients.forEach((c, cid) => {
              if (cid !== senderId && c.dc && c.dc.readyState === 'open') {
                if (!c.sender) c.sender = new DataChannelSender(c.dc)
                c.sender.enqueueSendQuiet(JSON.stringify(msg), 'PIT_SCOUT_UPDATE broadcast')
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
          if (isHostMode) {
            for (const r of msg.records) {
              if (r && r.eventId) {
                r.eventId = normalizeIncomingEventId(r.eventId) || r.eventId
              }
            }
          }
          callbacks.onPitScoutBatchSyncReceived?.(msg.records, senderId)
          if (isHostMode) {
            // Forward to other clients
            ctx.clients.forEach((c, cid) => {
              if (cid !== senderId && c.dc && c.dc.readyState === 'open') {
                if (!c.sender) c.sender = new DataChannelSender(c.dc)
                c.sender.enqueueSendQuiet(JSON.stringify(msg), 'PIT_SCOUT_BATCH_SYNC broadcast')
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

      case 'EVENT_METADATA':
        if (msg.event) {
          console.log(`[WebRTC] Received EVENT_METADATA for event ${msg.event.id} (${msg.event.name})`)
          callbacks.onEventMetadataReceived?.(msg.event)
        }
        break
    }
  }

  handler.isQuarantinedPeer = (senderId: string) => quarantinedSenders.has(senderId)
  handler.clearQuarantine = (senderId: string) => {
    quarantinedSenders.delete(senderId)
  }

  return handler as ChannelMessageHandler
}
