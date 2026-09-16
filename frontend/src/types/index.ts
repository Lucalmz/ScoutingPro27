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
  conflictTournamentLevel?: string
  eventId?: string
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
  
  // 2026-2027 BIOBUZZ Fields
  // Auto
  autoLeave: boolean
  autoBalls: number
  autoCycles?: number[]
  autoMissedCycles?: number[]
  autoPark: boolean
  autoPreload?: boolean
  autoSecondary?: boolean

  // Teleop (Cycle Tracker)
  teleopCycles: number[]
  teleopMissedCycles?: number[]

  // Endgame
  flowerPlaced: boolean
  flowerBottomBonus: boolean
  teleopPark: boolean

  // Custom Fields
  customFields?: Record<string, any>
}

// --- Official Match ---
export interface OfficialMatch {
  matchNum: number
  tournamentLevel?: string
  scores: {
    red: { penaltyPointsCommitted: number; totalPointsNp: number; totalTips?: number }
    blue: { penaltyPointsCommitted: number; totalPointsNp: number; totalTips?: number }
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
  | WebRtcCustomFieldsFullSync
  | WebRtcCustomFieldUpdate
  | WebRtcRequestCustomFieldsSync
  | WebRtcSessionConflict
  | WebRtcTakeoverRequest
  | WebRtcTakeoverPrompt
  | WebRtcTakeoverDecision
  | WebRtcSessionKicked
  | WebRtcTakeoverSuccess
  | WebRtcIdentityMigration
  | WebRtcAckMigration
  | WebRtcEventMetadata
  | WebRtcRequestScheduleSync
  | WebRtcScheduleFullSync
  | WebRtcAssignmentUpdate
  | WebRtcPitScoutUpdate
  | WebRtcPitFullSync
  | WebRtcPitScoutBatchSync
  | WebRtcPitScoutAck
  | WebRtcRequestPitSync
  | WebRtcOfficialRosterSync
  | WebRtcPitPhotoUpload
  | WebRtcPitPhotoAck
  | WebRtcMergeAccountRequest
  | WebRtcMergeAccountResponse

export interface WebRtcPitPhotoUpload {
  type: 'PIT_PHOTO_UPLOAD'
  eventId: string
  key: string
  dataUrl: string
  authCode?: string
  senderId?: string
}

export interface WebRtcPitPhotoAck {
  type: 'PIT_PHOTO_ACK'
  eventId: string
  key: string
  success: boolean
  authCode?: string
}

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

export interface WebRtcPitScoutAck {
  type: 'PIT_SCOUT_ACK'
  teamNumbers: number[]
  authCode?: string
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

export interface WebRtcTakeoverSuccess {
  type: 'TAKEOVER_SUCCESS'
  authCode?: string
  message?: string
}

export interface WebRtcMergeAccountRequest {
  type: 'MERGE_ACCOUNT_REQUEST'
  requestId: string
  targetUsername: string
  targetPassword: string
  sourceUserId: string
  sourceUsername: string
  authCode?: string
}

export interface WebRtcMergeAccountResponse {
  type: 'MERGE_ACCOUNT_RESPONSE'
  requestId: string
  success: boolean
  newId?: string
  newUsername?: string
  token?: string
  error?: string
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

export interface WebRtcCustomFieldsFullSync {
  type: 'CUSTOM_FIELDS_FULL_SYNC'
  eventId: string
  fields: CustomFieldDefinition[]
  authCode?: string
  senderUserId?: string
  token?: string
  hostSessionId?: string
}

export interface WebRtcCustomFieldUpdate {
  type: 'CUSTOM_FIELD_UPDATE'
  eventId: string
  field: CustomFieldDefinition
  action: 'CREATE' | 'UPDATE' | 'DELETE'
  authCode?: string
  senderUserId?: string
  token?: string
  hostSessionId?: string
}

export interface WebRtcRequestCustomFieldsSync {
  type: 'REQUEST_CUSTOM_FIELDS_SYNC'
  eventId: string
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
  avgTipsPerMatch?: number     // 场均蜂巢翻转贡献次数 (tips/场)
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
export type BallCompatibility = 'universal' | 'sorting' | 'pollen_only'

export interface PitScoutingRecord {
  id: string
  eventId: string
  teamNumber: number
  scoutId: string
  scoutName: string
  robotName?: string

  // 核心硬件构型 (BIOBUZZ 2026-2027)
  drivetrainType: 'mecanum' | 'tank' | 'swerve' | 'other'
  weightLbs: number
  ballCompatibility: BallCompatibility
  launcherType: string
  flowerMechanism: string
  hasColorSensor: boolean
  odometryType: string  // 'none' | 'two_wheel' | 'three_wheel' | 'pinpoint' | 'sparkfun_otos'

  // 核心量化自述指标
  claimedAutoStrategy?: string
  claimedAutoScore: number
  claimedTeleopCycles: number
  claimedTeleopScore: number
  claimedEndgameScore: number
  claimedTotalScore: number

  // 图片与版本
  photoKeys?: string[]
  rawData?: string
  customFields?: Record<string, any>
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
  endgameUnfulfilled: boolean   // claimed flower/endgame (>=10) but actual < 10
  endgamePardoned?: boolean     // 残局花朵未履约特赦标志
  endgameVerified?: boolean     // 残局花朵实测已证实
  hangUnfulfilled?: boolean     // 兼容别名
  hangPardoned?: boolean
  hangVerified?: boolean
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

// --- Custom Field System ---
export type CustomFieldTarget = 'MATCH' | 'PIT'
export type CustomFieldType = 'boolean' | 'number' | 'level' | 'select' | 'multi_select' | 'text'
export type CustomFieldPhase = 'auto' | 'teleop' | 'endgame' | 'overall' | 'hardware' | 'strategy'

export interface CustomFieldOption {
  label: string
  value: string
  color?: string // 'green' | 'blue' | 'red' | 'orange' | 'purple' | 'gray'
}

export interface CustomFieldDefinition {
  id: string
  eventId: string
  target: CustomFieldTarget
  phase: CustomFieldPhase
  name: string
  fieldKey: string
  fieldType: CustomFieldType
  required: boolean
  defaultVal?: string | null
  optionsJson?: string | null
  options?: CustomFieldOption[]
  minVal?: number | null
  maxVal?: number | null
  stepVal?: number | null
  unit?: string | null
  orderSeq: number
  isActive: boolean
  createdAt?: string
  updatedAt?: string
}
