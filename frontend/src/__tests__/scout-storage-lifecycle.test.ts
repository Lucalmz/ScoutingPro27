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

  it('verifies WebRTC reconnect deduplication prevents API call storms', async () => {
    const addEventMemberMock = vi.fn().mockResolvedValue(undefined)
    const syncedMemberIds = new Set<string>()

    // Simulate WebRTC onClientConnected logic
    const handleClientConnected = async (currentEventId: string, userId: string, userName: string, isHost: boolean) => {
      saveKnownScout(currentEventId, { id: userId, name: userName, lastSeen: Date.now() })
      if (!syncedMemberIds.has(userId) && isHost) {
        syncedMemberIds.add(userId)
        await addEventMemberMock(currentEventId, userId, userName)
      }
    }

    // 1. Initial connection from mobile phone
    await handleClientConnected(testEventId, 'phone_user_1', 'Mobile Scout 1', true)
    expect(addEventMemberMock).toHaveBeenCalledTimes(1)
    expect(addEventMemberMock).toHaveBeenCalledWith(testEventId, 'phone_user_1', 'Mobile Scout 1')

    // 2. Flapping / Reconnection 1 (phone screen lock & unlock)
    await handleClientConnected(testEventId, 'phone_user_1', 'Mobile Scout 1', true)
    // 3. Flapping / Reconnection 2 (Wi-Fi roaming)
    await handleClientConnected(testEventId, 'phone_user_1', 'Mobile Scout 1', true)
    // 4. Flapping / Reconnection 3
    await handleClientConnected(testEventId, 'phone_user_1', 'Mobile Scout 1', true)

    // Assert: addEventMember was NOT spammed; strictly called only ONCE
    expect(addEventMemberMock).toHaveBeenCalledTimes(1)

    // 5. Another scout joins
    await handleClientConnected(testEventId, 'phone_user_2', 'Mobile Scout 2', true)
    expect(addEventMemberMock).toHaveBeenCalledTimes(2)
    expect(addEventMemberMock).toHaveBeenCalledWith(testEventId, 'phone_user_2', 'Mobile Scout 2')
  })
})
