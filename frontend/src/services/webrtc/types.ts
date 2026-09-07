import type {
  WebRtcMessage,
  ScoutingRecord,
  ConnectionStatus,
  WebRtcDirectMessage,
  TeamTagItem,
  ScoutingEvent,
  ConnectionTransportInfo
} from '@/types'
import { DataChannelSender } from '@/services/dataChannelSender'

export type SasState = 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED'

export type WebRtcCallbacks = {
  onStatusChange: (status: ConnectionStatus) => void
  /** 返回真正被接受写入本地的记录，Host 用此打 hostSeq */
  onRecordsReceived: (records: ScoutingRecord[], senderId?: string) => Promise<ScoutingRecord[]>
  onAckReceived: (recordIds: string[], stampedRecords?: ScoutingRecord[], rejectedRecordIds?: string[]) => void
  /** sinceVersion: 0 或缺失表示全量请求；>0 表示增量请求 */
  onRequestSync: (sinceVersion: number, senderId?: string) => void
  onClientConnected?: (userId: string, userName: string) => void
  onTagUpdateReceived?: (tag: TeamTagItem, action: 'ADD' | 'REMOVE', eventId: string, teamNumber: number) => void
  onRequestTagsSync?: (senderId?: string) => void
  onTagsFullSyncReceived?: (tags: TeamTagItem[], eventId: string) => void
  onRequestScheduleSync?: (senderId?: string) => void
  onScheduleFullSyncReceived?: (schedules: import('@/types').MatchScheduleItem[], assignments: import('@/types').ScoutAssignment[]) => void
  onAssignmentUpdateReceived?: (assignment: import('@/types').ScoutAssignment) => void
  onPitScoutUpdateReceived?: (record: import('@/types').PitScoutingRecord) => void
  onPitScoutFullSyncReceived?: (records: import('@/types').PitScoutingRecord[]) => void
  onRequestPitSync?: (senderId?: string) => void
  onOfficialRosterSyncReceived?: (teams: import('@/types').OfficialTeamInfo[]) => void
  onSessionConflict?: (
    conflictingUsername: string,
    conflictingUserId: string,
    rejected?: boolean,
    conflictType?: 'SAME_USER' | 'DUPLICATE_NAME',
    suggestedName?: string
  ) => void
  onTakeoverPrompt?: (requesterUsername: string, timeoutSeconds: number) => void
  onSessionKicked?: (reason: string) => void
  onIdentityMigration?: (eventId: string, oldScoutId: string, newScoutId: string, newScoutName: string) => Promise<void> | void
  onEventMetadataReceived?: (event: ScoutingEvent) => void
  onTransportInfoChanged?: (info: ConnectionTransportInfo) => void
  onSasVerificationRequired?: (peer: { peerId: string; username: string; ecdhPublicKey?: string }, fingerprint: string) => void
  onSasVerified?: (peerId: string) => void
  onSasRejected?: (peerId: string, reason?: string) => void
  onIceStalled?: (isStalled: boolean) => void
}

export interface ClientEntry {
  pc: RTCPeerConnection
  sessionId?: string
  dc?: RTCDataChannel
  sender?: DataChannelSender
  pendingCandidates: RTCIceCandidateInit[]
}

export interface QueuedOfflineMessage {
  message: WebRtcDirectMessage
  queuedAt: number
}

export interface WebRtcService {
  host: (inviteCode: string, eventMetadata?: ScoutingEvent) => Promise<void>
  setEventMetadata: (meta: ScoutingEvent) => void
  join: (inviteCode: string) => Promise<void>
  requestSync: (sinceVersion?: number, authCode?: string, senderUserId?: string, senderUserName?: string, token?: string) => void
  pushRecords: (records: ScoutingRecord[], targetId?: string) => Promise<void>
  ackRecords: (recordIds: string[], targetId?: string, stampedRecords?: ScoutingRecord[], rejectedRecordIds?: string[]) => Promise<void>
  sendMessage: (msg: WebRtcMessage, targetId?: string) => Promise<void>
  sendDirectMessage: (msg: WebRtcDirectMessage) => Promise<boolean>
  broadcastTagUpdate: (tag: TeamTagItem, action: 'ADD' | 'REMOVE', targetId?: string) => Promise<void>
  sendTagsFullSync: (tags: TeamTagItem[], eventId: string, targetId?: string) => Promise<void>
  requestTagsSync: (eventId: string, targetId?: string) => Promise<void>
  requestTakeover: (username: string, userId?: string) => Promise<void>
  sendTakeoverDecision: (username: string, permit: boolean) => Promise<void>
  sendIdentityMigration: (eventId: string, oldScoutId: string, newScoutId: string, newScoutName: string) => Promise<void> | undefined
  reconnectNow: () => Promise<boolean>
  disconnect: () => void
  initHostSeq: (maxDbSeq: number) => void
  stampHostSeq: (records: ScoutingRecord[]) => ScoutingRecord[]
  confirmSas: (peerId?: string) => void
  rejectSas: (peerId?: string, reason?: string) => void
  getSasState: (peerId?: string) => SasState
  getSasFingerprint: (peerId?: string) => string | undefined
  getStatus: () => ConnectionStatus
  getTransportInfo: () => ConnectionTransportInfo | null
  getDataChannel: () => RTCDataChannel | null
  updateCallbacks?: (callbacks: Partial<WebRtcCallbacks>) => void
}
