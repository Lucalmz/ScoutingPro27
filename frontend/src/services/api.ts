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

const BASE = '/api'

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
    const isAuthExempt = path.startsWith('/user/rename') || path.startsWith('/user/login') || path.startsWith('/webrtc/verify-ticket')
    if (res.status === 401 && !isAuthExempt) {
      // Clear token and force reload
      localStorage.removeItem('scoutingpro-user')
      window.dispatchEvent(new Event('auth-unauthorized'))
    }
    const text = await res.text().catch(() => '')
    throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`)
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
