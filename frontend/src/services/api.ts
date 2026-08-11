// ============================================================
// API service — communicates with the local Java backend
// ============================================================

import type {
  User,
  ScoutingEvent,
  ScoutingRecord,
  LoginRequest,
  CreateEventResponse,
} from '@/types'

const BASE = '/api'

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
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

  const res = await fetch(`${BASE}${path}`, opts)
  if (!res.ok) {
    if (res.status === 401) {
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

export function login(body: LoginRequest): Promise<User> {
  return request<User>('POST', '/user/login', body)
}

export function register(body: LoginRequest): Promise<User> {
  return request<User>('POST', '/user/register', body)
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
