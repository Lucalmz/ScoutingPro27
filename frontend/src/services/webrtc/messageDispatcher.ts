import type {
  WebRtcMessage,
  ScoutingRecord,
  ConnectionStatus,
  WebRtcDirectMessage,
  TeamTagItem,
  ScoutingEvent
} from '@/types'
import { DataChannelSender } from '@/services/dataChannelSender'
import type { ClientEntry } from './types'
import type { OfflineMessageManager } from './offlineQueue'
import type { SasSecurityManager } from './sasManager'

export function getLocalAuthToken(): string | undefined {
  try {
    const userJson = localStorage.getItem('scoutingpro-user')
    if (userJson) {
      const user = JSON.parse(userJson)
      if (user && user.token) return user.token
    }
  } catch {}
  return undefined
}

export interface MessageDispatcherContext {
  isHostMode: () => boolean
  getCurrentInviteCode: () => string
  getHostSessionId: () => string
  getCurrentEventMetadata?: () => ScoutingEvent | null
  clients: Map<string, ClientEntry>
  stagedClients?: Map<string, ClientEntry>
  scoutIdToClientId: Map<string, string>
  clientIdToScoutId?: Map<string, string>
  clientIdToScoutName?: Map<string, string>
  offlineMessages: OfflineMessageManager
  sas: SasSecurityManager
  getClientDc: () => RTCDataChannel | null
  getClientSender: () => DataChannelSender | null
  setClientSender: (sender: DataChannelSender | null) => void
  setStatus: (s: ConnectionStatus) => void
  getLocalUserId: () => string | undefined
  setLocalUserId: (id: string | undefined) => void
  getLocalUserName: () => string | undefined
  setLocalUserName: (name: string | undefined) => void
  getHostSeqCounter: () => number
  setHostSeqCounter: (seq: number) => void
  onClientConnected?: (userId: string, username: string) => void
  onRequestSync?: (sinceVersion: number, clientId: string) => void
}

export function createMessageDispatcher(ctx: MessageDispatcherContext) {
  const RECORD_CHUNK_SIZE = 15

  function sendMessage(msg: WebRtcMessage, targetId?: string): Promise<void> {
    console.log(`[WebRTC] Sending message ${msg.type} to ${targetId || 'all'}`)
    const payload = JSON.stringify(msg)
    if (ctx.isHostMode()) {
      if (targetId) {
        const peerSas = ctx.sas.clientSasStates.get(targetId)
        if (peerSas === 'PENDING_VERIFICATION') {
          console.log(`[WebRTC Security Gating] Host: Buffering outgoing ${msg.type} for peer ${targetId} (SAS pending).`)
          const q = ctx.sas.hostPendingOutgoing.get(targetId) || []
          q.push({ msg, targetId })
          ctx.sas.hostPendingOutgoing.set(targetId, q)
          return Promise.resolve()
        }
        if (peerSas === 'REJECTED') {
          console.warn(`[WebRTC Security Gating] Dropping message to rejected peer ${targetId}.`)
          return Promise.resolve()
        }
        const c = ctx.clients.get(targetId)
        if (c && c.dc && c.dc.readyState === 'open') {
          if (!c.sender) c.sender = new DataChannelSender(c.dc)
          return c.sender.enqueueSend(payload)
        }
        return Promise.resolve()
      } else {
        const promises: Promise<void>[] = []
        ctx.clients.forEach((c, peerId) => {
          const peerSas = ctx.sas.clientSasStates.get(peerId)
          if (peerSas === 'PENDING_VERIFICATION') {
            console.log(`[WebRTC Security Gating] Host: Buffering broadcast ${msg.type} for peer ${peerId} (SAS pending).`)
            const q = ctx.sas.hostPendingOutgoing.get(peerId) || []
            q.push({ msg, targetId: peerId })
            ctx.sas.hostPendingOutgoing.set(peerId, q)
            return
          }
          if (peerSas === 'REJECTED') return
          if (c.dc && c.dc.readyState === 'open') {
            if (!c.sender) c.sender = new DataChannelSender(c.dc)
            promises.push(c.sender.enqueueSend(payload))
          }
        })
        return Promise.all(promises).then(() => {})
      }
    } else {
      if (ctx.sas.clientSasState === 'PENDING_VERIFICATION') {
        console.log(`[WebRTC Security Gating] Client: Buffering outgoing ${msg.type} to host (SAS pending).`)
        ctx.sas.clientPendingOutgoing.push({ msg, targetId })
        return Promise.resolve()
      }
      if (ctx.sas.clientSasState === 'REJECTED') {
        console.warn(`[WebRTC Security Gating] Dropping outgoing message to rejected host.`)
        return Promise.resolve()
      }
      const clientDc = ctx.getClientDc()
      if (clientDc && clientDc.readyState === 'open') {
        let clientSender = ctx.getClientSender()
        if (!clientSender) {
          clientSender = new DataChannelSender(clientDc, (isCongested) => {
            if (isCongested) ctx.setStatus('unstable')
          })
          ctx.setClientSender(clientSender)
        }
        return clientSender.enqueueSend(payload)
      }
      return Promise.resolve()
    }
  }

  function promoteTakeover(
    userId: string,
    username: string,
    newClientId: string,
    oldClientId: string | undefined,
    reason: string
  ) {
    if (oldClientId && oldClientId !== newClientId) {
      sendMessage(
        {
          type: 'SESSION_KICKED',
          reason,
          authCode: ctx.getCurrentInviteCode()
        },
        oldClientId
      )
      const old = ctx.clients.get(oldClientId)
      if (old) {
        if (old.dc) old.dc.onclose = null
        old.pc.onconnectionstatechange = null
        old.pc.oniceconnectionstatechange = null
        old.dc?.close()
        old.pc.close()
        ctx.clients.delete(oldClientId)
      }
      ctx.clientIdToScoutId?.delete(oldClientId)
      ctx.clientIdToScoutName?.delete(oldClientId)
      ctx.sas.cleanupPeerResources(oldClientId)
    }

    const staged = ctx.stagedClients?.get(newClientId)
    if (staged) {
      const oldActive = ctx.clients.get(newClientId)
      if (oldActive && oldActive !== staged) {
        if (oldActive.dc) oldActive.dc.onclose = null
        oldActive.pc.onconnectionstatechange = null
        oldActive.pc.oniceconnectionstatechange = null
        oldActive.dc?.close()
        oldActive.pc.close()
      }
      ctx.clients.set(newClientId, staged)
      ctx.stagedClients?.delete(newClientId)
    }

    ctx.scoutIdToClientId.set(userId, newClientId)
    ctx.clientIdToScoutId?.set(newClientId, userId)
    ctx.clientIdToScoutName?.set(newClientId, username)
    ctx.onClientConnected?.(userId, username)

    const meta = ctx.getCurrentEventMetadata?.()
    if (meta) {
      sendMessage(
        {
          type: 'EVENT_METADATA',
          event: meta,
          authCode: ctx.getCurrentInviteCode() || undefined,
          hostSessionId: ctx.getHostSessionId() || undefined
        },
        newClientId
      )
    }

    ctx.onRequestSync?.(0, newClientId)
  }

  function requestSync(
    sinceVersion: number = 0,
    authCode?: string,
    senderUserId?: string,
    senderUserName?: string,
    token?: string
  ) {
    if (senderUserId) ctx.setLocalUserId(senderUserId)
    if (senderUserName) ctx.setLocalUserName(senderUserName)
    const authToken = token || getLocalAuthToken()

    sendMessage({
      type: 'REQUEST_SYNC',
      lastSyncTime: '',
      sinceVersion,
      authCode: authCode || ctx.getCurrentInviteCode(),
      senderUserId,
      senderUserName,
      token: authToken,
      hostSessionId: ctx.isHostMode() ? ctx.getHostSessionId() : undefined
    })
  }

  function pushRecords(records: ScoutingRecord[], targetId?: string): Promise<void> {
    const isHost = ctx.isHostMode()
    const authToken = isHost ? undefined : getLocalAuthToken()
    const currentInviteCode = ctx.getCurrentInviteCode()
    const hostSessionId = ctx.getHostSessionId()
    const localUserId = ctx.getLocalUserId()
    const localUserName = ctx.getLocalUserName()

    if (!records || records.length === 0) {
      return sendMessage(
        {
          type: 'SYNC_DATA',
          records: [],
          authCode: currentInviteCode,
          senderUserId: isHost ? undefined : localUserId,
          senderUserName: isHost ? undefined : localUserName,
          token: authToken,
          hostSessionId: isHost ? hostSessionId : undefined
        },
        targetId
      )
    }
    const promises: Promise<void>[] = []
    for (let i = 0; i < records.length; i += RECORD_CHUNK_SIZE) {
      const chunk = records.slice(i, i + RECORD_CHUNK_SIZE)
      promises.push(
        sendMessage(
          {
            type: 'SYNC_DATA',
            records: chunk,
            authCode: currentInviteCode,
            senderUserId: isHost ? undefined : localUserId,
            senderUserName: isHost ? undefined : localUserName,
            token: authToken,
            hostSessionId: isHost ? hostSessionId : undefined
          },
          targetId
        )
      )
    }
    return Promise.all(promises).then(() => {})
  }

  function ackRecords(
    recordIds: string[],
    targetId?: string,
    stampedRecords?: ScoutingRecord[],
    rejectedRecordIds?: string[]
  ) {
    return sendMessage(
      {
        type: 'ACK_SYNC',
        recordIds,
        stampedRecords,
        rejectedRecordIds,
        authCode: ctx.getCurrentInviteCode(),
        hostSessionId: ctx.isHostMode() ? ctx.getHostSessionId() : undefined
      },
      targetId
    )
  }

  async function sendDirectMessage(payload: {
    targetId: string
    title: string
    body: string
    messageId?: string
    senderId?: string
    senderName?: string
    targetName?: string
  }): Promise<boolean> {
    const currentInviteCode = ctx.getCurrentInviteCode()
    const localUserId = ctx.getLocalUserId()
    const localUserName = ctx.getLocalUserName()

    const directMsg: WebRtcDirectMessage = {
      type: 'DIRECT_MESSAGE',
      messageId:
        payload.messageId ||
        (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `msg-${Date.now()}`),
      targetId: payload.targetId,
      targetName: payload.targetName,
      senderId: payload.senderId || localUserId,
      senderName: payload.senderName || localUserName,
      title: payload.title,
      body: payload.body,
      authCode: currentInviteCode
    }

    if (ctx.isHostMode()) {
      const clientId = ctx.scoutIdToClientId.get(payload.targetId)
      let sent = false
      if (clientId) {
        const targetClient = ctx.clients.get(clientId)
        if (targetClient && targetClient.dc && targetClient.dc.readyState === 'open') {
          if (!targetClient.sender) targetClient.sender = new DataChannelSender(targetClient.dc)
          await targetClient.sender.enqueueSend(JSON.stringify(directMsg))
          sent = true
        }
      }

      if (!sent) {
        ctx.offlineMessages.enqueue(payload.targetId, directMsg)
      }
      return sent
    } else {
      const clientDc = ctx.getClientDc()
      if (clientDc && clientDc.readyState === 'open') {
        await sendMessage(directMsg)
        return true
      }
      return false
    }
  }

  function initHostSeq(maxSeq: number) {
    ctx.setHostSeqCounter(maxSeq)
  }

  function stampHostSeq(records: ScoutingRecord[]): ScoutingRecord[] {
    let nextSeq = ctx.getHostSeqCounter()
    for (const r of records) {
      r.hostSeq = ++nextSeq
    }
    ctx.setHostSeqCounter(nextSeq)
    return records
  }

  function broadcastTagUpdate(tag: TeamTagItem, action: 'ADD' | 'REMOVE', targetId?: string) {
    const isHost = ctx.isHostMode()
    const authToken = isHost ? undefined : getLocalAuthToken()
    return sendMessage(
      {
        type: 'TEAM_TAGS_UPDATE',
        eventId: tag.eventId,
        teamNumber: tag.teamNumber,
        tag,
        action,
        authCode: ctx.getCurrentInviteCode(),
        senderUserId: isHost ? undefined : ctx.getLocalUserId(),
        token: authToken,
        hostSessionId: isHost ? ctx.getHostSessionId() : undefined
      },
      targetId
    )
  }

  function sendTagsFullSync(tags: TeamTagItem[], eventId: string, targetId?: string) {
    const isHost = ctx.isHostMode()
    const authToken = isHost ? undefined : getLocalAuthToken()
    return sendMessage(
      {
        type: 'TAGS_FULL_SYNC',
        eventId,
        tags,
        authCode: ctx.getCurrentInviteCode(),
        senderUserId: isHost ? undefined : ctx.getLocalUserId(),
        token: authToken,
        hostSessionId: isHost ? ctx.getHostSessionId() : undefined
      },
      targetId
    )
  }

  function requestTagsSync(eventId: string, targetId?: string) {
    const isHost = ctx.isHostMode()
    const authToken = isHost ? undefined : getLocalAuthToken()
    return sendMessage(
      {
        type: 'REQUEST_TAGS_SYNC',
        eventId,
        authCode: ctx.getCurrentInviteCode(),
        senderUserId: isHost ? undefined : ctx.getLocalUserId(),
        token: authToken,
        hostSessionId: isHost ? ctx.getHostSessionId() : undefined
      },
      targetId
    )
  }

  function requestTakeover(username: string, userId?: string) {
    return sendMessage({
      type: 'TAKEOVER_REQUEST',
      username,
      userId,
      authCode: ctx.getCurrentInviteCode()
    })
  }

  function sendTakeoverDecision(username: string, permit: boolean) {
    return sendMessage({
      type: 'TAKEOVER_DECISION',
      username,
      permit,
      authCode: ctx.getCurrentInviteCode()
    })
  }

  function sendIdentityMigration(eventId: string, oldScoutId: string, newScoutId: string, newScoutName: string) {
    if (!eventId || !oldScoutId || !newScoutId || !newScoutName) return
    return sendMessage({
      type: 'IDENTITY_MIGRATION',
      eventId,
      oldScoutId,
      newScoutId,
      newScoutName,
      authCode: ctx.getCurrentInviteCode()
    })
  }

  return {
    sendMessage,
    promoteTakeover,
    requestSync,
    pushRecords,
    ackRecords,
    sendDirectMessage,
    broadcastTagUpdate,
    sendTagsFullSync,
    requestTagsSync,
    requestTakeover,
    sendTakeoverDecision,
    sendIdentityMigration,
    initHostSeq,
    stampHostSeq
  }
}
