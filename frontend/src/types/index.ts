// ============================================================
// ScoutingPro27 — Type definitions
// ============================================================

// --- User ---
export interface User {
  id: string
  username: string
  token?: string
}

// --- System Messaging & Outbox ---
export type MessageDeliveryStatus = 'PENDING_DELIVERY' | 'DELIVERING' | 'DELIVERED' | 'FAILED'

export interface DirectMessageOutboxItem {
  id: string
  targetId: string
  targetName?: string
  senderId?: string
  senderName?: string
  title: string
  body: string
  status: MessageDeliveryStatus
  createdAt: string
  deliveredAt?: string
  retryCount: number
}

export interface SystemMessage {
  id: string
  title: string
  body: string
  read: boolean
  timestamp: string
  type?: 'conflict' | 'direct'
  senderId?: string
  senderName?: string
  targetId?: string
  targetName?: string
  deliveryStatus?: MessageDeliveryStatus
  conflictMatchNumber?: number
  conflictTeamNumber?: number
}

// --- Event ---
export interface ScoutingEvent {
  id: string
  name: string
  inviteCode: string
  hostId: string
  ftcYear?: number
  ftcEventCode?: string
}

// --- Scouting Record (后端存储的粗粒度版本) ---
export interface ScoutingRecord {
  id: string
  eventId: string
  scoutId: string
  scoutName: string

  matchNumber: number
  teamNumber: number

  // 粗粒度分数（存入 DB）
  autoScore: number
  teleopScore: number
  endgameScore: number
  totalScore: number

  notes: string
  rawData: string  // 前端完整表单数据的 JSON 字符串

  syncStatus: SyncStatus
  createdAt: string
  updatedAt: string
  isBroken: boolean
  isDeleted?: boolean
  isConflict?: boolean
  /** 记录级逻辑版本号，每次该记录被任何节点编辑就 +1，用于 LWW 冲突解决（替代 updatedAt 比较）*/
  version: number
  /** Host 分配的全局单调序列号，用于客户端增量同步请求（sinceVersion 过滤）*/
  hostSeq?: number
}

// --- 前端表单数据（序列化后放入 rawData）---
export interface ScoutingFormData {
  matchNumber: number
  teamNumber: number
  allianceColor: 'none' | 'red' | 'blue'
  isBroken: boolean
  
  // 2026 DECODE Fields
  // Auto
  autoClassified: number
  autoOverflow: number
  autoPatterns: number
  autoMovementScore: number

  // Teleop
  teleopClassified: number
  teleopOverflow: number
  gatesTriggered: number

  // Endgame
  baseScore: number
  supportMultiplier: number
}

// --- Official Match ---
export interface OfficialMatch {
  matchNum: number
  scores: {
    red: { penaltyPointsCommitted: number; totalPointsNp: number }
    blue: { penaltyPointsCommitted: number; totalPointsNp: number }
  } | null
  teams: { teamNumber: number; alliance: string }[]
}

export type SyncStatus = 'PENDING' | 'SYNCED'

// --- API request / response shapes ---
export interface LoginRequest {
  username: string
  password?: string
}

export interface LoginResponse {
  id: string
  username: string
  token: string
}

export interface CreateEventRequest {
  name: string
}

export interface CreateEventResponse {
  id: string
  inviteCode: string
}

// --- WebRTC Data-Channel message protocol ---
export type WebRtcMessage =
  | WebRtcRequestSync
  | WebRtcSyncData
  | WebRtcAckSync
  | WebRtcDirectMessage

export interface WebRtcDirectMessage {
  type: 'DIRECT_MESSAGE'
  messageId?: string
  targetId: string
  targetName?: string
  senderId?: string
  senderName?: string
  title: string
  body: string
  authCode?: string
}

export interface WebRtcRequestSync {
  type: 'REQUEST_SYNC'
  lastSyncTime: string
  /** 增量同步：只请求 hostSeq > sinceVersion 的记录；0 或缺失表示全量请求 */
  sinceVersion?: number
  authCode?: string
  senderUserId?: string
  senderUserName?: string
  token?: string
  hostSessionId?: string
}

export interface WebRtcSyncData {
  type: 'SYNC_DATA'
  records: ScoutingRecord[]
  authCode?: string
  senderUserId?: string
  senderUserName?: string
  token?: string
  hostSessionId?: string
}

export interface WebRtcAckSync {
  type: 'ACK_SYNC'
  recordIds: string[]
  /** Host 回传给原始推送者的、已打上 hostSeq 的记录，供其更新本地 hostSeq 和 lastHostSeq */
  stampedRecords?: ScoutingRecord[]
  /** 被 Host 判定为旧版本而被拒绝的记录 ID 列表 */
  rejectedRecordIds?: string[]
  authCode?: string
  hostSessionId?: string
}

// --- Connection status ---
export type ConnectionStatus = 'offline' | 'connecting' | 'waiting' | 'connected' | 'unstable' | 'degraded' | 'long_offline'

// --- Rankings row (aggregated client-side) ---
export interface RankingRow {
  teamNumber: number
  matchCount: number
  avgAutoScore: number
  avgTeleopScore: number
  avgEndgameScore: number
  maxScore: number
  avgRating: number
  brokenCount: number
  trend: 'up' | 'down' | 'stable' | 'new'
}

export interface AiSettings {
  userId?: string;
  provider: 'OPENAI' | 'GEMINI';
  apiKeyEncrypted: string;
  modelName: string;
  systemPrompt: string;
  proxyHost: string;
  proxyPort: number | null;
  baseUrl?: string;
}
