// ============================================================
// API service — communicates with the local Java backend
// ============================================================

import type {
  User,
  ScoutingEvent,
  ScoutingRecord,
  LoginRequest,
  LoginResponse,
  CreateEventResponse,
  OfficialMatch,
  MatchScheduleItem,
  ScoutAssignment,
} from '@/types'
import { ApiError } from '@/utils/errorHelper'

export { ApiError }

const BASE = '/api'

export function isStaticCloudHost(): boolean {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname.toLowerCase()
  return (
    host.endsWith('github.io') ||
    host.endsWith('pages.dev') ||
    host.endsWith('vercel.app') ||
    host.endsWith('netlify.app') ||
    host.includes('gitlab.io')
  )
}

let staticHostDetected = false

function handleStaticHostFallback<T>(method: string, path: string, body?: unknown): Promise<T> {
  // 1. User check
  if (path.startsWith('/user/check')) {
    return Promise.resolve({ exists: false } as unknown as T)
  }
  // 2. User login / register
  if (path.startsWith('/user/login') || path.startsWith('/user/register')) {
    const b = (body || {}) as LoginRequest
    const clientUser: LoginResponse = {
      id: 'scout-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      username: b.username || 'Scout',
      token: 'pwa-' + Date.now().toString(36)
    }
    return Promise.resolve(clientUser as unknown as T)
  }
  // 3. Verify token
  if (path.startsWith('/user/verify-token')) {
    return Promise.resolve({ valid: true, userId: 'pwa-user', username: 'PWA Scout' } as unknown as T)
  }
  // 4. Rename user
  if (path.startsWith('/user/rename')) {
    const b = (body || {}) as UpdateProfileParams
    return Promise.resolve({
      id: b.newId || 'scout-' + Date.now().toString(36),
      username: b.newUsername || 'Scout',
      token: 'pwa-' + Date.now().toString(36)
    } as unknown as T)
  }
  // 5. Events list
  if (path.startsWith('/events') && method === 'GET') {
    return Promise.resolve([] as unknown as T)
  }
  // 6. Join event
  if (path.startsWith('/events/join')) {
    const b = (body || {}) as { inviteCode: string }
    const code = (b.inviteCode || '').trim().toUpperCase()
    const pwaEvt: ScoutingEvent = {
      id: 'evt-' + code,
      name: `Event ${code}`,
      inviteCode: code,
      hostId: 'remote-host'
    }
    return Promise.resolve(pwaEvt as unknown as T)
  }
  // 7. Create event
  if (path.startsWith('/events') && method === 'POST') {
    const b = (body || {}) as { name: string }
    const code = 'SP' + Math.random().toString(36).slice(2, 6).toUpperCase()
    const pwaEvt: CreateEventResponse = {
      id: 'evt-' + code,
      inviteCode: code
    }
    return Promise.resolve(pwaEvt as unknown as T)
  }
  // 8. Records
  if (path.startsWith('/records/batch')) {
    return Promise.resolve({ synced: Array.isArray(body) ? body.length : 0, failed: 0 } as unknown as T)
  }
  if (path.startsWith('/records') && method === 'GET') {
    return Promise.resolve([] as unknown as T)
  }
  // 9. Schedule
  if (path.includes('/schedule')) {
    return Promise.resolve({ schedules: [], assignments: [] } as unknown as T)
  }
  // 10. Pit records & Custom fields & Tags & Members
  if (
    path.includes('/pit/records') ||
    path.includes('/custom-fields') ||
    path.includes('/tags') ||
    path.includes('/members') ||
    path.includes('/banned-teams')
  ) {
    return Promise.resolve([] as unknown as T)
  }
  // 11. Pit photo upload -> throw so photoStorage falls back to WebRTC
  if (path.includes('/pit/photos') && method === 'POST') {
    return Promise.reject(new Error('Static cloud host does not support direct HTTP photo upload; falling back to WebRTC DataChannel'))
  }

  return Promise.resolve([] as unknown as T)
}

export class LocalApiTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`应用响应异常（请求 ${path} 挂起超过 ${timeoutMs}ms），可能需要重启应用`)
    this.name = 'LocalApiTimeoutError'
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 8000
): Promise<T> {
  // On static cloud hosts (e.g. GitHub Pages), there is no local backend HTTP API.
  // Directly provide zero-latency synthetic responses to avoid 404 network spam.
  if (isStaticCloudHost() || staticHostDetected) {
    return handleStaticHostFallback<T>(method, path, body)
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
  }
  
  // Attach token if present
  const userJson = localStorage.getItem('scoutingpro-user')
  if (userJson) {
    try {
      const user = JSON.parse(userJson) as User
      if (user && user.token) {
        ;(opts.headers as Record<string, string>)['Authorization'] = `Bearer ${user.token}`
      }
    } catch (e) {
      // ignore
    }
  }

  if (body !== undefined) {
    opts.body = JSON.stringify(body)
  }

  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, opts)
  } catch (err: any) {
    clearTimeout(timeoutId)
    if (err && (err.name === 'AbortError' || err.code === 20)) {
      throw new LocalApiTimeoutError(path, timeoutMs)
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }

  if (!res.ok) {
    const isAuthExempt =
      path.startsWith('/user/rename') ||
      path.startsWith('/user/login') ||
      path.startsWith('/webrtc/verify-ticket') ||
      path.startsWith('/users/merge') ||
      path.startsWith('/user/merge')
    if (res.status === 401 && !isAuthExempt) {
      // Clear token and force reload
      localStorage.removeItem('scoutingpro-user')
      window.dispatchEvent(new Event('auth-unauthorized'))
    }
    const text = await res.text().catch(() => '')
    const isHtmlError = text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('<head')
    if (res.status === 404 && isHtmlError) {
      staticHostDetected = true
      console.warn(`[api] Detected static host 404 on ${path}. Switching to static host fallback mode.`)
      return handleStaticHostFallback<T>(method, path, body)
    }
    let cleanMessage = text
    if (isHtmlError) {
      cleanMessage = `HTTP ${res.status} ${res.statusText || 'Not Found'}`
    }
    throw new ApiError(res.status, path, method, cleanMessage)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  
  const contentType = res.headers.get('content-type')
  if (contentType && contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }
  return text as unknown as T
}

// --- User ---
export function checkUserExists(username: string): Promise<{exists: boolean}> {
  return request<{exists: boolean}>('GET', `/user/check?username=${encodeURIComponent(username)}`)
}

export function login(body: LoginRequest): Promise<LoginResponse> {
  return request<LoginResponse>('POST', '/user/login', body)
}

export function register(body: LoginRequest): Promise<User> {
  return request<User>('POST', '/user/register', body)
}

export function verifyToken(token: string): Promise<{ valid: boolean; userId: string; username: string }> {
  return request<{ valid: boolean; userId: string; username: string }>('POST', '/user/verify-token', { token })
}

export interface UpdateProfileParams {
  newUsername?: string
  oldPassword?: string
  newPassword?: string
  newId?: string
}

export function renameUser(
  paramsOrUsername: string | UpdateProfileParams,
  maybeNewId?: string
): Promise<LoginResponse> {
  const body = typeof paramsOrUsername === 'string'
    ? { newUsername: paramsOrUsername, newId: maybeNewId }
    : paramsOrUsername
  return request<LoginResponse>('POST', '/user/rename', body)
}

export interface MergeUserParams {
  targetUsername: string
  targetPassword: string
}

export function mergeUser(params: MergeUserParams): Promise<LoginResponse> {
  return request<LoginResponse>('POST', '/users/merge', params)
}

export function migrateScoutRecords(
  eventId: string,
  oldScoutId: string,
  newScoutId: string,
  newScoutName: string
): Promise<void> {
  return request<void>('POST', '/records/migrate-scout', { eventId, oldScoutId, newScoutId, newScoutName })
}

// --- Events ---
export function listEvents(userId: string): Promise<ScoutingEvent[]> {
  return request<ScoutingEvent[]>('GET', `/events?userId=${encodeURIComponent(userId)}`)
}

export function createEvent(body: { name: string }): Promise<CreateEventResponse> {
  return request<CreateEventResponse>('POST', '/events', body)
}

export function joinEvent(inviteCode: string): Promise<ScoutingEvent> {
  return request<ScoutingEvent>('POST', '/events/join', { inviteCode })
}

export interface EventMemberItem {
  id: string
  username: string
  host?: boolean
  role?: string
}

export function fetchEventMembers(eventId: string): Promise<EventMemberItem[]> {
  return request<EventMemberItem[]>('GET', `/events/${encodeURIComponent(eventId)}/members`)
}

export function syncExternalEvent(event: ScoutingEvent): Promise<ScoutingEvent> {
  return request<ScoutingEvent>('POST', '/events/external-sync', event)
}

export function updateEventFtcConfig(eventId: string, ftcYear: number, ftcEventCode: string): Promise<void> {
  return request<void>('PUT', `/events/${eventId}/ftc-config`, { ftcYear, ftcEventCode })
}

export function fetchBannedTeams(eventId: string): Promise<number[]> {
  return request<number[]>('GET', `/events/${eventId}/banned-teams`)
}

export function banTeam(eventId: string, teamNumber: number): Promise<void> {
  return request<void>('POST', `/events/${eventId}/banned-teams`, { teamNumber })
}

export function unbanTeam(eventId: string, teamNumber: number): Promise<void> {
  return request<void>('DELETE', `/events/${eventId}/banned-teams/${teamNumber}`)
}

// --- Records ---
export function listRecords(eventId: string): Promise<ScoutingRecord[]> {
  return request<ScoutingRecord[]>('GET', `/records?eventId=${encodeURIComponent(eventId)}`)
}

export function saveRecord(record: ScoutingRecord): Promise<void> {
  return request<void>('POST', '/records', record)
}

export function syncRecords(records: ScoutingRecord[]): Promise<void> {
  return request<void>('POST', '/records/sync', records)
}

export function getPendingRecords(eventId: string): Promise<ScoutingRecord[]> {
  return request<ScoutingRecord[]>('GET', `/records/pending?eventId=${encodeURIComponent(eventId)}`)
}

export function markRecordsSynced(ids: string[]): Promise<void> {
  return request<void>('POST', '/records/mark-synced', ids)
}

// --- FTC Official API Proxy ---
export function fetchFtcMatches(season: number, eventCode: string, tournamentLevel?: string): Promise<OfficialMatch[]> {
  const query = tournamentLevel ? `?tournamentLevel=${encodeURIComponent(tournamentLevel)}` : ''
  return request<OfficialMatch[]>('GET', `/ftc/${season}/matches/${encodeURIComponent(eventCode)}${query}`)
}

export function fetchFtcScores(season: number, eventCode: string, tournamentLevel?: string): Promise<any> {
  const query = tournamentLevel ? `?tournamentLevel=${encodeURIComponent(tournamentLevel)}` : ''
  return request<any>('GET', `/ftc/${season}/scores/${encodeURIComponent(eventCode)}${query}`)
}

// --- Custom Team Tags ---
export function fetchEventTags(eventId: string): Promise<import('@/types').TeamTagItem[]> {
  return request<import('@/types').TeamTagItem[]>('GET', `/events/${encodeURIComponent(eventId)}/tags`)
}

export function addTeamTag(
  eventId: string,
  teamNumber: number,
  tag: string,
  color?: string,
  isPreset?: boolean
): Promise<import('@/types').TeamTagItem> {
  return request<import('@/types').TeamTagItem>(
    'POST',
    `/events/${encodeURIComponent(eventId)}/teams/${teamNumber}/tags`,
    { tag, color, isPreset }
  )
}

export function deleteTeamTag(eventId: string, teamNumber: number, tag: string): Promise<void> {
  return request<void>(
    'DELETE',
    `/events/${encodeURIComponent(eventId)}/teams/${teamNumber}/tags/${encodeURIComponent(tag)}`
  )
}

// --- WebRTC Handshake Ticket Security ---
export interface WebRtcTicketResponse {
  ticket: string
  expiresIn: number
}

export interface WebRtcVerifyTicketResponse {
  valid: boolean
  userId?: string
  username?: string
  eventId?: string
  error?: string
}

export function createWebRtcTicket(eventId: string, ecdhPublicKey: string): Promise<WebRtcTicketResponse> {
  return request<WebRtcTicketResponse>('POST', '/webrtc/handshake-ticket', { eventId, ecdhPublicKey })
}

export async function verifyWebRtcTicket(ticket: string, eventId: string, ecdhPublicKey: string): Promise<WebRtcVerifyTicketResponse> {
  try {
    return await request<WebRtcVerifyTicketResponse>('POST', '/webrtc/verify-ticket', { ticket, eventId, ecdhPublicKey })
  } catch (err: any) {
    return { valid: false, error: err.message || 'Ticket verification failed' }
  }
}

// --- Match Schedule & Scout Assignments ---
export function fetchEventSchedule(eventId: string): Promise<{ schedules: MatchScheduleItem[]; assignments: ScoutAssignment[] }> {
  return request<{ schedules: MatchScheduleItem[]; assignments: ScoutAssignment[] }>('GET', `/events/${encodeURIComponent(eventId)}/schedule`)
}

export function saveScheduleBatch(
  eventId: string,
  items: MatchScheduleItem[],
  replace = false
): Promise<{ success: boolean; count: number }> {
  return request<{ success: boolean; count: number }>('POST', `/events/${encodeURIComponent(eventId)}/schedule/batch`, {
    items,
    replace
  })
}

export function clearEventSchedule(eventId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('DELETE', `/events/${encodeURIComponent(eventId)}/schedule`)
}

export function saveScoutAssignments(
  eventId: string,
  assignments: ScoutAssignment[]
): Promise<{ success: boolean; count: number }> {
  return request<{ success: boolean; count: number }>('PUT', `/events/${encodeURIComponent(eventId)}/assignments`, {
    assignments
  })
}

// --- Pit Scouting & Official Teams ---
export function fetchPitRecords(eventId: string): Promise<{ records: import('@/types').PitScoutingRecord[]; officialTeams: import('@/types').OfficialTeamInfo[] }> {
  return request<{ records: import('@/types').PitScoutingRecord[]; officialTeams: import('@/types').OfficialTeamInfo[] }>('GET', `/events/${encodeURIComponent(eventId)}/pit-records`)
}

export function savePitRecord(eventId: string, record: import('@/types').PitScoutingRecord): Promise<{ success: boolean; record: import('@/types').PitScoutingRecord }> {
  return request<{ success: boolean; record: import('@/types').PitScoutingRecord }>('POST', `/events/${encodeURIComponent(eventId)}/pit-records`, record)
}

export function syncPitRecordsBatch(eventId: string, records: import('@/types').PitScoutingRecord[]): Promise<{ success: boolean; count: number }> {
  return request<{ success: boolean; count: number }>('POST', `/events/${encodeURIComponent(eventId)}/pit-records/batch`, records)
}

export function syncOfficialTeams(eventId: string, teams: import('@/types').OfficialTeamInfo[]): Promise<{ success: boolean; count: number }> {
  return request<{ success: boolean; count: number }>('POST', `/events/${encodeURIComponent(eventId)}/official-teams/sync`, teams)
}

export function fetchOfficialTeams(eventId: string): Promise<import('@/types').OfficialTeamInfo[]> {
  return request<import('@/types').OfficialTeamInfo[]>('GET', `/events/${encodeURIComponent(eventId)}/official-teams`)
}

export function fetchFtcTeams(season: number, eventCode: string): Promise<import('@/types').OfficialTeamInfo[]> {
  return request<import('@/types').OfficialTeamInfo[]>('GET', `/ftc/${season}/teams/${encodeURIComponent(eventCode.trim())}`)
}

export function uploadPitPhoto(
  eventId: string,
  key: string,
  dataUrl: string
): Promise<{ success: boolean; key: string; url: string }> {
  return request<{ success: boolean; key: string; url: string }>(
    'POST',
    `/events/${encodeURIComponent(eventId)}/pit/photos`,
    { key, dataUrl }
  )
}

export function deletePitPhoto(eventId: string, key: string): Promise<void> {
  return request<void>(
    'DELETE',
    `/events/${encodeURIComponent(eventId)}/pit/photos/${encodeURIComponent(key)}`
  )
}

// --- Custom Fields API ---

export function fetchCustomFields(eventId: string): Promise<import('@/types').CustomFieldDefinition[]> {
  return request<import('@/types').CustomFieldDefinition[]>('GET', `/events/${encodeURIComponent(eventId)}/custom-fields`)
}

export function createCustomField(
  eventId: string,
  def: Partial<import('@/types').CustomFieldDefinition>
): Promise<import('@/types').CustomFieldDefinition> {
  return request<import('@/types').CustomFieldDefinition>('POST', `/events/${encodeURIComponent(eventId)}/custom-fields`, def)
}

export function updateCustomField(
  eventId: string,
  id: string,
  def: Partial<import('@/types').CustomFieldDefinition>
): Promise<import('@/types').CustomFieldDefinition> {
  return request<import('@/types').CustomFieldDefinition>('PUT', `/events/${encodeURIComponent(eventId)}/custom-fields/${encodeURIComponent(id)}`, def)
}

export function deleteCustomField(eventId: string, id: string): Promise<{ success: boolean; id: string }> {
  return request<{ success: boolean; id: string }>('DELETE', `/events/${encodeURIComponent(eventId)}/custom-fields/${encodeURIComponent(id)}`)
}

