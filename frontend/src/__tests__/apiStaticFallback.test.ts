import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('api static host fallback routing', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('rejects uploadPitPhoto and savePitRecord on static 404 HTML host instead of matching POST /events', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><html><body>404 Static Client Host</body></html>', {
        status: 404,
        headers: { 'Content-Type': 'text/html' }
      })
    ) as any

    const api = await import('../services/api')

    await expect(
      api.uploadPitPhoto('evt-123', 'pit_27570_1_0', 'data:image/webp;base64,AAA')
    ).rejects.toThrow(/WebRTC DataChannel/i)

    await expect(
      api.savePitRecord('evt-123', { teamNumber: 27570 } as any)
    ).rejects.toThrow(/WebRTC/i)

    await expect(api.fetchEventSchedule('evt-123')).resolves.toEqual({
      schedules: [],
      assignments: []
    })

    await expect(api.fetchPitRecords('evt-123')).resolves.toEqual({
      records: [],
      officialTeams: []
    })

    await expect(api.listEvents('u-1')).resolves.toEqual([])

    const created = await api.createEvent({ name: 'Local Demo' })
    expect(created.id).toMatch(/^evt-SP/)
    expect(created.inviteCode).toMatch(/^SP/)
  })
})
