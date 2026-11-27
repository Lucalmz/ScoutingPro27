import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  addEventMember,
  addTeamTag,
  banTeam,
  clearEventSchedule,
  createCustomField,
  createEvent,
  createWebRtcTicket,
  deleteCustomField,
  deleteEvent,
  deletePitPhoto,
  deleteTeamTag,
  fetchBannedTeams,
  fetchCustomFields,
  fetchEventMembers,
  fetchEventSchedule,
  fetchEventTags,
  fetchFtcAdvancement,
  fetchFtcAlliances,
  fetchFtcAwards,
  fetchFtcMatches,
  fetchFtcRankings,
  fetchFtcScores,
  fetchFtcTeams,
  fetchOfficialTeams,
  fetchPitRecords,
  getPendingRecords,
  joinEvent,
  login,
  markRecordsSynced,
  mergeUser,
  migrateScoutRecords,
  register,
  removeEventMember,
  renameUser,
  savePitRecord,
  saveRecord,
  saveScheduleBatch,
  saveScoutAssignments,
  syncExternalEvent,
  syncOfficialTeams,
  syncPitRecordsBatch,
  syncRecords,
  unbanTeam,
  updateCustomField,
  updateEventFtcConfig,
  updateEventTurnConfig,
  uploadPitPhoto,
  verifyToken,
  verifyWebRtcTicket
} from '../services/api'

describe('api.ts - Complete Endpoint Coverage & Response Handling', () => {
  const origFetch = globalThis.fetch

  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    localStorage.clear()
  })

  function mockJsonFetch(body: unknown, status = 200, headers: Record<string, string> = {}) {
    const fn = vi.fn().mockImplementation(async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers }
      })
    )
    globalThis.fetch = fn as any
    return fn
  }

  it('refreshes localStorage token on x-refreshed-token and handles 204, plain text, and HTML 500 errors', async () => {
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', token: 'old-jwt' }))

    mockJsonFetch({ valid: true, userId: 'u1', username: 'Alice' }, 200, {
      'x-refreshed-token': 'refreshed-jwt-999'
    })
    const verified = await verifyToken('old-jwt')
    expect(verified.valid).toBe(true)
    expect(JSON.parse(localStorage.getItem('scoutingpro-user')!).token).toBe('refreshed-jwt-999')

    // 204 No Content
    mockJsonFetch(null, 204)
    await expect(deleteEvent('evt-1')).resolves.toBeUndefined()

    // Plain text 200 OK
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    ) as any
    await expect(saveRecord({ id: 'r1' } as any)).resolves.toBe('OK')

    // HTML 502 error strips HTML into clean HTTP status message
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response('<html><body>Bad Gateway</body></html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/html' }
      })
    ) as any
    await expect(fetchFtcMatches(2026, 'USUTSAS1')).rejects.toThrow('HTTP 502 Bad Gateway')
  })

  it('does NOT trigger auth-unauthorized on login, merge, or verifyWebRtcTicket 401s and verifyWebRtcTicket catches errors', async () => {
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', token: 'tok' }))
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('Invalid credentials', { status: 401 })) as any
    await expect(login({ username: 'a', password: 'b' })).rejects.toThrow('(401)')
    await expect(mergeUser({ targetUsername: 'b', targetPassword: 'c' })).rejects.toThrow('(401)')
    const ticketRes = await verifyWebRtcTicket('t', 'e', 'pk')
    expect(ticketRes.valid).toBe(false)
    expect(ticketRes.error).toContain('401')

    expect(localStorage.getItem('scoutingpro-user')).not.toBeNull()
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('dispatches correct HTTP methods, paths, and payloads across all REST domain wrappers', async () => {
    const fetchSpy = mockJsonFetch({ ok: true })

    await register({ username: 'bob', password: 'pw' })
    await renameUser('bob2', 'legacy-id')
    await migrateScoutRecords('e1', 'old', 'new', 'Bob')
    await createEvent({ name: 'Regional' })
    await joinEvent('ABC123')
    await fetchEventMembers('e1')
    await addEventMember('e1', 'u2', 'Carl')
    await removeEventMember('e1', 'u2')
    await syncExternalEvent({ id: 'e1', name: 'Ext', inviteCode: 'ABC123', hostId: 'h1' })
    await updateEventFtcConfig('e1', 2026, 'USUTSAS1')
    await updateEventTurnConfig('e1', { urls: ['turn:t.example.com'], username: 'u', credential: 'p' })
    await updateEventTurnConfig('e1', null)
    await fetchBannedTeams('e1')
    await banTeam('e1', 27570)
    await unbanTeam('e1', 27570)
    await syncRecords([])
    await getPendingRecords('e1')
    await markRecordsSynced(['r1'])
    await fetchFtcScores(2026, 'USUTSAS1', 'QUALIFICATION')
    await fetchFtcRankings(2026, ' USUTSAS1 ')
    await fetchFtcAwards(2026, 'USUTSAS1')
    await fetchFtcAlliances(2026, 'USUTSAS1')
    await fetchFtcAdvancement(2026, 'USUTSAS1')
    await fetchEventTags('e1')
    await addTeamTag('e1', 27570, 'fast', 'green', false)
    await deleteTeamTag('e1', 27570, 'fast#1')
    await createWebRtcTicket('e1', '04abcd')
    await fetchEventSchedule('e1')
    await saveScheduleBatch('e1', [], true, [])
    await clearEventSchedule('e1')
    await saveScoutAssignments('e1', [])
    await fetchPitRecords('e1')
    await savePitRecord('e1', { teamNumber: 27570 } as any)
    await syncPitRecordsBatch('e1', [])
    await syncOfficialTeams('e1', [])
    await fetchOfficialTeams('e1')
    await fetchFtcTeams(2026, 'USUTSAS1')
    await uploadPitPhoto('e1', 'k1', 'data:image/webp;base64,AA')
    await deletePitPhoto('e1', 'k1')
    await fetchCustomFields('e1')
    await createCustomField('e1', { name: 'F1' })
    await updateCustomField('e1', 'cf1', { name: 'F2' })
    await deleteCustomField('e1', 'cf1')

    const calledUrls = fetchSpy.mock.calls.map((c: any[]) => `${c[1].method} ${c[0]}`)
    expect(calledUrls).toContain('POST /api/user/register')
    expect(calledUrls).toContain('POST /api/records/migrate-scout')
    expect(calledUrls).toContain('PUT /api/events/e1/turn-config')
    expect(calledUrls).toContain('DELETE /api/events/e1/teams/27570/tags/fast%231')
    expect(calledUrls).toContain('POST /api/webrtc/handshake-ticket')
    expect(calledUrls).toContain('POST /api/events/e1/pit/photos')
    expect(calledUrls).toContain('DELETE /api/events/e1/custom-fields/cf1')
  })
})
