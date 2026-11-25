export interface CrdtLoadStateResponse {
  exists: boolean
  eventId: string
  hostEpoch: number
  snapshotRevision: number
  snapshot: unknown | null
  updatedAt?: string | null
}

export interface CrdtSaveStateRequest {
  hostEpoch: number
  snapshotRevision: number
  snapshot: unknown
  dirtyRows: Record<string, string[]>
  fullProjection?: boolean
}

export interface CrdtSaveStateResponse {
  saved: boolean
  stale?: boolean
  error?: string
  eventId: string
  hostEpoch: number
  snapshotRevision: number
  projectedCounts?: Record<string, number>
}

export interface CrdtHttpTransport {
  loadState: (eventId: string) => Promise<CrdtLoadStateResponse | null>
  saveState: (
    eventId: string,
    payload: CrdtSaveStateRequest,
    options?: { keepalive?: boolean }
  ) => Promise<CrdtSaveStateResponse>
}

function readAuthToken(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem('scoutingpro-user')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return typeof parsed?.token === 'string' && parsed.token ? parsed.token : null
  } catch {
    return null
  }
}

function maybeApplyRefreshedToken(res: Response): void {
  if (typeof localStorage === 'undefined') return
  const refreshed = res.headers.get('X-Refreshed-Token')
  if (!refreshed) return
  try {
    const raw = localStorage.getItem('scoutingpro-user')
    if (!raw) return
    const parsed = JSON.parse(raw)
    parsed.token = refreshed
    localStorage.setItem('scoutingpro-user', JSON.stringify(parsed))
  } catch {}
}

function handleUnauthorizedIfNeeded(res: Response): void {
  if (res.status !== 401) return
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem('scoutingpro-user')
    } catch {}
  }
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new Event('auth-unauthorized'))
    } catch {}
  }
}

export async function fetchCrdtState(eventId: string): Promise<CrdtLoadStateResponse | null> {
  if (!eventId) return null
  const token = readAuthToken()
  if (!token) return null

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`
  }

  const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/crdt-state`, {
    method: 'GET',
    headers
  })
  maybeApplyRefreshedToken(res)
  handleUnauthorizedIfNeeded(res)

  if (!res.ok) {
    throw new Error(`CRDT GET /api/events/${eventId}/crdt-state failed (${res.status})`)
  }
  return (await res.json()) as CrdtLoadStateResponse
}

export async function saveCrdtState(
  eventId: string,
  payload: CrdtSaveStateRequest,
  options?: { keepalive?: boolean }
): Promise<CrdtSaveStateResponse> {
  const token = readAuthToken()
  if (!token) {
    throw new Error('Missing auth token for CRDT state save')
  }

  const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/crdt-state`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload),
    keepalive: Boolean(options?.keepalive)
  })
  maybeApplyRefreshedToken(res)
  handleUnauthorizedIfNeeded(res)

  const text = await res.text()
  let parsed: CrdtSaveStateResponse | null = null
  try {
    parsed = text ? (JSON.parse(text) as CrdtSaveStateResponse) : null
  } catch {
    parsed = null
  }

  if (res.status === 409 && parsed) {
    return {
      saved: false,
      stale: true,
      error: parsed.error || 'stale_revision',
      eventId: parsed.eventId || eventId,
      hostEpoch: parsed.hostEpoch ?? payload.hostEpoch,
      snapshotRevision: parsed.snapshotRevision ?? payload.snapshotRevision
    }
  }

  if (!res.ok) {
    throw new Error(parsed?.error || `CRDT PUT /api/events/${eventId}/crdt-state failed (${res.status})`)
  }

  return (
    parsed ?? {
      saved: true,
      eventId,
      hostEpoch: payload.hostEpoch,
      snapshotRevision: payload.snapshotRevision
    }
  )
}

export const defaultCrdtHttpTransport: CrdtHttpTransport = {
  loadState: fetchCrdtState,
  saveState: saveCrdtState
}
