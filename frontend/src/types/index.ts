// ============================================================
// ScoutingPro27 — Type definitions
// ============================================================

// --- User ---
export interface User {
  id: string
  username: string
  token?: string
  legacyAliasNotice?: string
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
  tournamentLevel?: string
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
  tournamentLevel?: string
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
  legacyAliasNotice?: string
}

export interface CreateEventRequest {
  name: string
}

export interface CreateEventResponse {
  id: string
  inviteCode: string
}

// --- Match Schedule & Scout Assignments ---
export type StationType = 'red1' | 'red2' | 'blue1' | 'blue2'

export interface MatchScheduleItem {
  id?: string
  eventId: string
  matchNumber: number
  tournamentLevel?: string
  red1: number
  red2: number
  blue1: number
  blue2: number
  scoreRedFinal?: number | null
  scoreBlueFinal?: number | null
  createdAt?: string
}

export interface ScoutAssignment {
  id?: string
  eventId: string
  matchNumber: number
  tournamentLevel?: string
  station: StationType
  teamNumber: number
  scoutId?: string | null
  scoutName?: string | null
  updatedAt?: string
}

// --- WebRTC Data-Channel message protocol ---
export type WebRtcMessage =
  | WebRtcRequestSync
  | WebRtcSyncData
  | WebRtcAckSync
  | WebRtcDirectMessage
  | WebRtcTeamTagUpdate
  | WebRtcRequestTagsSync
  | WebRtcTagsFullSync
  | WebRtcSessionConflict
  | WebRtcTakeoverRequest
  | WebRtcTakeoverPrompt
  | WebRtcTakeoverDecision
  | WebRtcSessionKicked
  | WebRtcIdentityMigration
  | WebRtcAckMigration
  | WebRtcEventMetadata
  | WebRtcRequestScheduleSync
  | WebRtcScheduleFullSync
  | WebRtcAssignmentUpdate
  | WebRtcPitScoutUpdate
  | WebRtcPitFullSync
  | WebRtcPitScoutBatchSync
  | WebRtcRequestPitSync
  | WebRtcOfficialRosterSync

export interface WebRtcRequestScheduleSync {
  type: 'REQUEST_SCHEDULE_SYNC'
  authCode?: string
  senderId?: string
}

export interface WebRtcScheduleFullSync {
  type: 'SCHEDULE_FULL_SYNC'
  schedules: MatchScheduleItem[]
  assignments: ScoutAssignment[]
  authCode?: string
}

export interface WebRtcAssignmentUpdate {
  type: 'ASSIGNMENT_UPDATE'
  assignment: ScoutAssignment
  authCode?: string
}

export interface WebRtcPitScoutUpdate {
  type: 'PIT_SCOUT_UPDATE'
  record: PitScoutingRecord
  authCode?: string
  senderId?: string
}

export interface WebRtcPitFullSync {
  type: 'PIT_SCOUT_FULL_SYNC'
  records: PitScoutingRecord[]
  authCode?: string
}

export interface WebRtcPitScoutBatchSync {
  type: 'PIT_SCOUT_BATCH_SYNC'
  records: PitScoutingRecord[]
  authCode?: string
  senderId?: string
}

export interface WebRtcRequestPitSync {
  type: 'REQUEST_PIT_SYNC'
  authCode?: string
  senderId?: string
}

export interface WebRtcOfficialRosterSync {
  type: 'OFFICIAL_ROSTER_SYNC'
  teams: OfficialTeamInfo[]
  authCode?: string
}

export interface WebRtcEventMetadata {
  type: 'EVENT_METADATA'
  event: ScoutingEvent
  authCode?: string
  hostSessionId?: string
}

export interface WebRtcIdentityMigration {
  type: 'IDENTITY_MIGRATION'
  eventId: string
  oldScoutId: string
  newScoutId: string
  newScoutName: string
  authCode?: string
}

export interface WebRtcAckMigration {
  type: 'ACK_MIGRATION'
  eventId: string
  newScoutId: string
  authCode?: string
}

export interface WebRtcSessionConflict {
  type: 'SESSION_CONFLICT'
  conflictingUsername: string
  conflictingUserId: string
  conflictType?: 'SAME_USER' | 'DUPLICATE_NAME'
  suggestedName?: string
  rejected?: boolean
  authCode?: string
}

export interface WebRtcTakeoverRequest {
  type: 'TAKEOVER_REQUEST'
  username: string
  userId?: string
  authCode?: string
}

export interface WebRtcTakeoverPrompt {
  type: 'TAKEOVER_PROMPT'
  requesterUsername: string
  timeoutSeconds: number
  authCode?: string
}

export interface WebRtcTakeoverDecision {
  type: 'TAKEOVER_DECISION'
  username: string
  permit: boolean
  authCode?: string
}

export interface WebRtcSessionKicked {
  type: 'SESSION_KICKED'
  reason: string
  authCode?: string
}

export interface TeamTagItem {
  id: string
  eventId: string
  teamNumber: number
  tag: string
  color: 'red' | 'orange' | 'green' | 'blue' | 'purple' | 'gray' | 'yellow'
  isPreset: boolean
  createdBy?: string
  createdAt?: string
  updatedAt?: string
}

export interface WebRtcTeamTagUpdate {
  type: 'TEAM_TAGS_UPDATE'
  eventId: string
  teamNumber: number
  tag: TeamTagItem
  action: 'ADD' | 'REMOVE'
  authCode?: string
  senderUserId?: string
  token?: string
  hostSessionId?: string
}

export interface WebRtcRequestTagsSync {
  type: 'REQUEST_TAGS_SYNC'
  eventId: string
  authCode?: string
  senderUserId?: string
  token?: string
  hostSessionId?: string
}

export interface WebRtcTagsFullSync {
  type: 'TAGS_FULL_SYNC'
  eventId: string
  tags: TeamTagItem[]
  authCode?: string
  senderUserId?: string
  token?: string
  hostSessionId?: string
}

export interface WebRtcDirectMessage {
  type: 'DIRECT_MESSAGE'
  id?: string
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

export type TransportType = 'ipv6_p2p' | 'lan_p2p' | 'nat_p2p' | 'relay' | 'unknown'

export interface ConnectionTransportInfo {
  type: TransportType
  localCandidateType: string
  remoteCandidateType: string
  localAddress: string
  remoteAddress: string
  protocol: string
  rttMs: number | null
  securityFingerprint?: string
}



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

// --- Pit Scouting & Unified Team Pool ---
export interface PitScoutingRecord {
  id: string
  eventId: string
  teamNumber: number
  scoutId: string
  scoutName: string
  robotName?: string

  // 核心硬件构型
  drivetrainType: 'mecanum' | 'tank' | 'swerve' | 'other'
  weightLbs: number
  sizingPassed: boolean
  mechanismType: string // 'slide_claw' | 'slide_roller' | 'linkage_arm' | 'other'
  hangType: string      // 'winch' | 'slide' | 'passive' | 'none'
  odometryType: string  // 'none' | 'two_wheel' | 'three_wheel' | 'pinpoint_otos'

  // 核心量化自述指标
  claimedAutoScore: number
  claimedAutoPieces: number
  claimedAutoHangLevel: number
  claimedTeleopScore: number
  claimedTeleopCycleSec: number
  claimedEndgameHangLevel: number
  claimedEndgameTimeSec: number
  claimedTotalScore: number

  // 图片与版本
  photoKeys?: string[]
  version: number
  hostSeq?: number
  isDeleted?: boolean
  createdAt?: string
  updatedAt?: string
  syncStatus?: SyncStatus
}

export interface OfficialTeamInfo {
  eventId?: string
  teamNumber: number
  nameFull: string
  robotName?: string
  city?: string
  country?: string
}

export type BragTier = 'realistic' | 'optimistic' | 'overclaimed' | 'mythical' | 'pending'

export interface BragInfo {
  tier: BragTier
  overallRatio: number       // claimedTotal / actualMaxTotal
  autoRatio: number          // claimedAuto / actualMaxAuto
  teleopRatio: number        // claimedTeleop / actualMaxTeleop
  hangUnfulfilled: boolean   // claimed high hang (>=2) but actual <= 1
  hangPardoned?: boolean     // 高悬挂未履约特赦标志（机构难复位或常规赛留力）
  hangVerified?: boolean     // 高悬挂实测已证实（只要有一次成功即证明没说谎）
  label: string              // e.g. "1.05x 真实守信"
}

export interface UnifiedTeamItem {
  teamNumber: number
  name: string
  robotName?: string
  city?: string
  country?: string
  hasPitRecord: boolean
  pitRecord?: PitScoutingRecord | null
  bragInfo?: BragInfo
  matchCount: number
  avgTotalScore?: number
  maxTotalScore?: number
  tags: TeamTagItem[]
}

