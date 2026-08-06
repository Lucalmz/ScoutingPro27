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
  if (body !== undefined) {
    opts.body = JSON.stringify(body)
  }

  const res = await fetch(`${BASE}${path}`, opts)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

// --- User ---
export function checkUserExists(username: string): Promise<{exists: boolean}> {
  return request<{exists: boolean}>('GET', `/user/check?username=${encodeURIComponent(username)}`)
}

export function login(body: LoginRequest): Promise<User> {
  return request<User>('POST', '/user/login', body)
}

// --- Events ---
export function listEvents(userId: string): Promise<ScoutingEvent[]> {
  return request<ScoutingEvent[]>('GET', `/events?userId=${encodeURIComponent(userId)}`)
}

export function createEvent(body: { name: string }): Promise<CreateEventResponse> {
  return request<CreateEventResponse>('POST', '/events', body)
}

export function joinEvent(event: ScoutingEvent): Promise<void> {
  return request<void>('POST', '/events/join', event)
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
