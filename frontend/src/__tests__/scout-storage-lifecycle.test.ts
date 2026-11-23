import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getKnownScouts,
  saveKnownScout,
  removeKnownScout,
  clearKnownScouts
} from '@/services/scoutStorage'

describe('ScoutStorage & Member Lifecycle Tests', () => {
  const testEventId = 'evt_test_storage_123'

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Automated teardown: strictly clean up any test data in localStorage
    clearKnownScouts(testEventId)
    localStorage.clear()
    expect(getKnownScouts(testEventId)).toHaveLength(0)
  })

  it('saves, updates, and retrieves known scouts in localStorage', () => {
    expect(getKnownScouts(testEventId)).toEqual([])

    saveKnownScout(testEventId, { id: 'scout_1', name: 'Alice', lastSeen: 1000 })
    let scouts = getKnownScouts(testEventId)
    expect(scouts).toHaveLength(1)
    expect(scouts[0].id).toBe('scout_1')
    expect(scouts[0].name).toBe('Alice')
    expect(scouts[0].lastSeen).toBe(1000)

    // Update with new lastSeen
    saveKnownScout(testEventId, { id: 'scout_1', name: 'Alice (Renamed)', lastSeen: 2000 })
    scouts = getKnownScouts(testEventId)
    expect(scouts).toHaveLength(1)
    expect(scouts[0].name).toBe('Alice (Renamed)')
    expect(scouts[0].lastSeen).toBe(2000)

    // Add another scout
    saveKnownScout(testEventId, { id: 'scout_2', name: 'Bob', lastSeen: 1500 })
    scouts = getKnownScouts(testEventId)
    expect(scouts).toHaveLength(2)
  })

  it('removes a single known scout to prevent zombie resurrection', () => {
    saveKnownScout(testEventId, { id: 'scout_keep', name: 'Keep Me' })
    saveKnownScout(testEventId, { id: 'scout_remove', name: 'Remove Me' })

    expect(getKnownScouts(testEventId)).toHaveLength(2)

    removeKnownScout(testEventId, 'scout_remove')

    const remaining = getKnownScouts(testEventId)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('scout_keep')
    expect(remaining.find((s) => s.id === 'scout_remove')).toBeUndefined()
  })

  it('clears all known scouts on event deletion', () => {
    saveKnownScout(testEventId, { id: 'scout_1', name: 'Alice' })
    saveKnownScout(testEventId, { id: 'scout_2', name: 'Bob' })

    clearKnownScouts(testEventId)
    expect(getKnownScouts(testEventId)).toEqual([])
  })
})
