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
export interface CustomTurnConfig {
  urls: string[]
  username: string
  credential?: string
}

export interface ScoutingEvent {
  id: string
  name: string
  inviteCode: string
  hostId: string
  ftcYear?: number
  ftcEventCode?: string
  customTurnConfig?: CustomTurnConfig | null
  hasCustomTurn?: boolean
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
  teleopCycleTimestamps?: number[]  // 每次手动循环完成时刻 epoch ms，数组长度与 teleopCycles 同步对齐，撤销轮次时同步弹出
  predictCycleTimeSec?: number | null // 可选单场缓存：剔除最快 1 次后取接下来 4 次较短循环间隔的均值（单位秒，有效间隔 < 5 个为 null）

  // Endgame (2026-2027 BIOBUZZ)
  teleopPark: boolean
  flowerNectars?: number            // 花朵大球 Nectar (0–8, +2 pts/ball)
  flowerBottomBonusCount?: number   // 花朵占底 Nectar 朵数 (0–4 且 <= flowerNectars, +5 pts/flower)
  flowerPollens?: number            // 花朵小球 Pollen (0–12, +2 pts/ball)
  gardenBalls?: number              // Garden 推进球数 (0–12, +1 pt/ball)
  flowerDescore?: boolean           // 战术标签：敌方花朵底口掏球拆台 (G418)
  g410EarlyFlowerFoul?: boolean     // 风险标签：<60s 误投 Nectar 触发 Major Foul (G410)
  /** @deprecated Legacy compatibility alias for historical rawData */
  flowerPlaced?: boolean
  /** @deprecated Legacy compatibility alias for historical rawData */
  flowerBottomBonus?: boolean

  // Custom Fields
  customFields?: Record<string, any>
}

// --- Official Match ---
export interface OfficialMatch {
  matchNum: number
  tournamentLevel?: string
  series?: number
  description?: string
  scores: {
    red: { penaltyPointsCommitted: number; totalPointsNp: number; finalScore?: number; totalTips?: number }
    blue: { penaltyPointsCommitted: number; totalPointsNp: number; finalScore?: number; totalTips?: number }
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
  | WebRtcScheduleBatchSync
  | WebRtcAssignmentUpdate
  | WebRtcPitScoutUpdate
  | WebRtcPitFullSync
  | WebRtcPitScoutBatchSync
  | WebRtcPitScoutAck
  | WebRtcRequestPitSync
  | WebRtcOfficialRosterSync
  | WebRtcPitPhotoUpload
  | WebRtcPitPhotoChunk
  | WebRtcPitPhotoAck
  | WebRtcMergeAccountRequest
  | WebRtcMergeAccountResponse
  | WebRtcHostHandoffBatch
  | WebRtcHostHandoffAck
  | WebRtcPing
  | WebRtcPong

export interface WebRtcPing {
  type: 'PING'
  timestamp: number
  authCode?: string
}

export interface WebRtcPong {
  type: 'PONG'
  timestamp: number
  authCode?: string
}

export interface WebRtcPitPhotoChunk {
  type: 'PIT_PHOTO_CHUNK'
  transferId: string
  eventId: string
  key: string
  chunkIndex: number
  totalChunks: number
  chunkData: string
  authCode?: string
  senderId?: string
}

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

export interface WebRtcScheduleBatchSync {
  type: 'SCHEDULE_BATCH_SYNC'
  batchIndex: number
  totalBatches: number
  schedules: MatchScheduleItem[]
  assignments: ScoutAssignment[]
  authCode?: string
  syncId?: string
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
  /** 主备切换/对齐标识 */
  isHostTakeover?: boolean
  /** 客户端已知的最高 hostSeq，供新主机时钟单调向前推进 */
  clientMaxSeq?: number
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

export interface WebRtcHostHandoffBatch {
  type: 'HOST_HANDOFF_BATCH'
  eventId: string
  incomingMaxSeq: number
  hostEpoch: number
  records: ScoutingRecord[]
  schedules?: MatchScheduleItem[]
  assignments?: ScoutAssignment[]
  pitRecords?: PitScoutingRecord[]
  teamTags?: TeamTagItem[]
  customFields?: CustomFieldDefinition[]
  authCode?: string
  senderUserId?: string
  hostSessionId?: string
}

export interface WebRtcHostHandoffAck {
  type: 'HOST_HANDOFF_ACK'
  eventId: string
  acceptedCount: number
  alignedMaxSeq: number
  hostEpoch: number
  authCode?: string
  hostSessionId?: string
}

// --- Connection status ---
export type ConnectionStatus = 'offline' | 'connecting' | 'waiting' | 'connected' | 'unstable' | 'degraded' | 'long_offline'

export type TransportType = 'ipv6_p2p' | 'lan_p2p' | 'nat_p2p' | 'relay' | 'unknown'

export interface ConnectionTransportInfo {
  type: TransportType
  label?: string
  isVirtualTunnel?: boolean
  localCandidateType: string
  remoteCandidateType: string
  localAddress: string
  remoteAddress: string
  protocol: string
  rttMs: number | null
  securityFingerprint?: string
  selectedCandidatePair?: string
}



// --- FTC Official Rankings & Advancement ---
export interface OfficialRanking {
  rank: number
  teamNumber: number
  sortOrder1?: number
  sortOrder2?: number
  sortOrder3?: number
  wins?: number
  losses?: number
  ties?: number
  qualMatchesPlayed?: number
  dq?: number
}

export interface OfficialAward {
  awardId?: number
  name: string
  series: number
  teamNumber: number
  person?: string
}

export type AllianceTeamRef = number | { teamNumber?: number; TeamNumber?: number; team?: number } | null | undefined

export interface OfficialAlliance {
  number: number
  captain: AllianceTeamRef
  round1: AllianceTeamRef
  round2?: AllianceTeamRef
  round3?: AllianceTeamRef
  backup?: AllianceTeamRef
  name?: string
}

export type AdvancementStatus =
  | 'ADVANCING'
  | 'BUBBLE'
  | 'COMPETING'
  | 'ALREADY_ADVANCING'
  | 'DECLINED'
  | 'INELIGIBLE'
  | 'NONE'

export interface OfficialAdvancementSlot {
  team?: number | null
  displayTeam?: string
  slot?: number
  criteria?: string
  declined?: boolean
  status?: string
}

export interface OfficialAdvancementResponse {
  advancesTo?: string
  slots?: number
  fcmpReserved?: number
  advancement?: OfficialAdvancementSlot[]
}

export interface AdvancementBreakdown {
  qualPoints: number
  alliancePoints: number
  playoffPoints: number
  awardPoints: number
}

export interface AdvancementDetail {
  teamNumber: number
  advancementRank: number
  totalAdvancementPoints: number
  qualRank: number
  qualPoints: number
  alliancePoints: number
  playoffPoints: number
  awardPoints: number
  advancementStatus: AdvancementStatus
  officialStatus?: string
  declined?: boolean
  rolledDown?: boolean
  advancementSlot?: number
  advancementCriteria?: string
  advancesTo?: string
  breakdown: AdvancementBreakdown
}

// --- Rankings row (aggregated client-side) ---
export interface RankingRow {
  teamNumber: number
  matchCount: number
  avgAutoScore: number
  avgTeleopScore: number
  avgEndgameScore: number
  avgTipsPerMatch?: number       // 场均蜂巢翻转贡献次数 (tips/场)
  // FTC 官方标准晋级积分体系
  advancementPoints?: number     // 实时计算得到的总晋级积分
  advancementRank?: number       // 实时晋级排位
  advancementStatus?: AdvancementStatus // 实时晋级状态 ('ADVANCING' | 'ALREADY_ADVANCING' | 'DECLINED' | 'INELIGIBLE' | 'BUBBLE' | 'COMPETING')
  advancementOfficialStatus?: string
  advancementDeclined?: boolean
  advancementRolledDown?: boolean
  advancementSlot?: number
  advancementCriteria?: string
  advancementAdvancesTo?: string
  advancementBreakdown?: AdvancementBreakdown // 晋级分明细
  // BIOBUZZ 2026-2027 教练评估核心指标
  teleopParkRate?: number        // 终局装载区停泊率 (0–1)
  avgMobilityRpPts?: number      // 场均机动贡献分 (Leave*3 + AutoPark*5 + TeleOpPark*5, 满分 13, 用于预判 Swarm RP >= 16)
  avgFlowerNectars?: number      // 场均花朵大球 Nectar 投入数
  avgFlowerBottomBonus?: number  // 场均花朵占底数 (Bottom Nectar Bonus)
  avgFlowerPollens?: number      // 场均花朵小球 Pollen 投入数
  avgGardenBalls?: number        // 场均 Garden 推进球数
  descoreRate?: number           // 花底掏球拆台率 (0–1, G418)
  g410FoulRate?: number          // G410 <60s 误投 Nectar 大犯规率 (0–1)
  predictCycleTime?: number | null    // 预测单轮循环平均耗时（秒）：单场 >=5 有效间隔去最快1次取4次较短均值，跨达标场次均值
  predictCycleMatches?: number        // 参与 predictCycleTime 计算的有效达标场次数（单场有效间隔 >= 5）
  predictCycleSpread?: number | null  // 有效循环耗时离散度（秒，样本不足为 null）
  estimatedMaxCycles?: number | null  // 基于 predictCycleTime 推算的理论手动可打轮次（无达标样本为 null）
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

  // 核心硬件与战术特点 (BIOBUZZ 2026-2027, 仅记录客观特点，不包含限重/尺寸合规检查)
  drivetrainType: 'mecanum' | 'tank' | 'swerve' | 'other'
  weightLbs: number
  chassisSize?: string          // 车体尺寸特征（如紧凑小车 ≤15" / 标准中型 16"-17" / 宽体大车 ~18" 或自定义尺寸备注，不做合规校验）
  ballCompatibility: BallCompatibility
  launcherType: string
  flowerMechanism: string
  hasColorSensor: boolean
  hasDescoreMech?: boolean      // 是否具备敌方花朵底口掏 Pollen 拆台机构 (G418)
  hasApriltagVision?: boolean   // 是否具备 AprilTag / 视觉自瞄
  odometryType: string  // 'none' | 'two_wheel' | 'three_wheel' | 'pinpoint' | 'sparkfun_otos'

  // 核心量化自述指标
  claimedAutoStrategy?: string
  claimedAutoScore: number
  claimedTeleopCycles: number
  claimedTeleopScore: number
  claimedTeleopPark?: boolean         // 自述终局回装载区停泊 (+5 pts)
  claimedFlowerNectars?: number       // 自述花朵放入 Nectar 数 (+2 pts/球)
  claimedFlowerBottomBonus?: number   // 自述花朵占底数 (+5 pts/朵)
  claimedFlowerPollens?: number       // 自述花朵放入 Pollen 数 (+2 pts/球)
  claimedGardenBalls?: number         // 自述 Garden 推进球数 (+1 pt/球)
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
  overallRatio: number          // claimedTotal / actualMaxTotal
  autoRatio: number             // claimedAuto / actualMaxAuto
  teleopRatio: number           // claimedTeleop / actualMaxTeleop
  endgameRatio?: number         // claimedEndgame / actualMaxEndgame
  endgameUnfulfilled: boolean   // claimed flower/endgame unfulfilled across matches
  endgamePardoned?: boolean     // 残局花朵未履约特赦标志
  endgameVerified?: boolean     // 残局花朵实测已证实（兼容既有字段）
  flowerVerified?: boolean      // 规范化：实测已证实花朵能力
  flowerPending?: boolean       // 规范化：自述花朵能力待实测证实
  parkVerified?: boolean        // 规范化：实测已证实终局停泊能力
  parkPending?: boolean         // 规范化：自述停泊能力待实测或未稳定履约
  statusKeys?: string[]         // 规范化 i18n 状态修饰 key 列表（消除硬编码中文拼接）
  labelKey?: string             // 规范化 i18n 主标签 key（消除硬编码中文）
  /** @deprecated Legacy alias kept for backwards compatibility */
  hangUnfulfilled?: boolean
  /** @deprecated Legacy alias kept for backwards compatibility */
  hangPardoned?: boolean
  /** @deprecated Legacy alias kept for backwards compatibility */
  hangVerified?: boolean
  label: string                 // Fallback display label (prefer i18n via tier/labelKey/statusKeys)
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
