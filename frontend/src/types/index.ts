// ============================================================
// ScoutingPro27 — Type definitions
// ============================================================

// --- User ---
export interface User {
  id: string
  username: string
}

// --- Event ---
export interface ScoutingEvent {
  id: string
  name: string
  inviteCode: string
  isHost: boolean
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
}

// --- 前端表单数据（序列化后放入 rawData）---
export interface ScoutingFormData {
  matchNumber: number
  teamNumber: number
  allianceColor: 'none' | 'red' | 'blue'
  autoMoved: boolean
  autoParked: boolean
  autoPixelsPlaced: number
  teleOpPixelsScored: number
  teleOpPixelsMissed: number
  endgameHang: 'none' | 'low' | 'high'
  endgameDrone: boolean
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

export interface WebRtcRequestSync {
  type: 'REQUEST_SYNC'
  lastSyncTime: string
  authCode?: string
}

export interface WebRtcSyncData {
  type: 'SYNC_DATA'
  records: ScoutingRecord[]
  authCode?: string
}

export interface WebRtcAckSync {
  type: 'ACK_SYNC'
  recordIds: string[]
  authCode?: string
}

// --- Connection status ---
export type ConnectionStatus = 'offline' | 'connecting' | 'waiting' | 'connected'

// --- Rankings row (aggregated client-side) ---
export interface RankingRow {
  teamNumber: number
  matchCount: number
  avgAutoScore: number
  avgTeleopScore: number
  avgEndgameScore: number
  maxScore: number
  totalScore: number
}
