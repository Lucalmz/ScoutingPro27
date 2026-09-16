import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUserStore } from '@/stores/user'
import { useRecordStore } from '@/stores/records'
import { useScheduleStore } from '@/stores/schedule'
import * as api from '@/services/api'
import type { ScoutingRecord } from '@/types'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<any>('@/services/api')
  return {
    ...actual,
    mergeUser: vi.fn(),
    login: vi.fn(),
    checkUserExists: vi.fn(),
    verifyToken: vi.fn(),
  }
})

describe('User Store - mergeAccount (Approach 2: Account Merging)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('successfully merges source user into target user and cascades local stores', async () => {
    const userStore = useUserStore()
    const recordStore = useRecordStore()
    const scheduleStore = useScheduleStore()

    // 1. Initial login on secondary device (e.g. Phone)
    const phoneUserId = 'user_phone_uuid_111'
    userStore.user = {
      id: phoneUserId,
      username: 'Alice-Phone',
      token: 'token_phone_123'
    }

    // 2. Add local records recorded on phone
    const rec1: ScoutingRecord = {
      id: 'rec_phone_1',
      eventId: 'evt_merge_test',
      scoutId: phoneUserId,
      scoutName: 'Alice-Phone',
      matchNumber: 1,
      teamNumber: 27570,
      autoScore: 30,
      teleopScore: 40,
      endgameScore: 20,
      totalScore: 90,
      notes: 'Recorded on phone',
      rawData: '{}',
      syncStatus: 'SYNCED',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    await recordStore.addRecord(rec1)
    expect(recordStore.records[0].scoutId).toBe(phoneUserId)

    const pitStore = (await import('@/stores/pitScout')).usePitScoutStore()
    pitStore.records = [
      {
        id: 'pit_phone_1',
        eventId: 'evt_merge_test',
        teamNumber: 27570,
        scoutId: phoneUserId,
        scoutName: 'Alice-Phone',
        drivetrainType: 'mecanum',
        weightLbs: 35,
        ballCompatibility: 'universal',
        launcherType: '',
        flowerMechanism: '',
        hasColorSensor: false,
        odometryType: '',
        claimedAutoScore: 0,
        claimedTeleopCycles: 0,
        claimedTeleopScore: 0,
        claimedEndgameScore: 0,
        claimedTotalScore: 0,
        version: 1
      }
    ]

    // 3. Mock successful backend merge
    const mainUserId = 'user_main_uuid_222'
    vi.mocked(api.mergeUser).mockResolvedValueOnce({
      id: mainUserId,
      username: 'Alice-Main',
      token: 'token_main_456'
    })

    // 4. Execute account merge
    const res = await userStore.mergeAccount('Alice-Main', 'SecretPass123')
    expect(res.success).toBe(true)
    expect(res.oldId).toBe(phoneUserId)
    expect(res.newId).toBe(mainUserId)
    expect(res.newUsername).toBe('Alice-Main')

    // 5. Verify userStore is updated to target user
    expect(userStore.userId).toBe(mainUserId)
    expect(userStore.username).toBe('Alice-Main')
    expect(userStore.token).toBe('token_main_456')

    // 6. Verify local match and pit records were migrated to mainUserId
    expect(recordStore.records[0].scoutId).toBe(mainUserId)
    expect(recordStore.records[0].scoutName).toBe('Alice-Main')
    expect(pitStore.records[0].scoutId).toBe(mainUserId)
    expect(pitStore.records[0].scoutName).toBe('Alice-Main')

    // 7. Verify localStorage persistence
    const storedUser = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}')
    expect(storedUser.id).toBe(mainUserId)
    expect(storedUser.username).toBe('Alice-Main')
  })

  it('handles backend merge failure gracefully without corrupting current user state', async () => {
    const userStore = useUserStore()
    const phoneUserId = 'user_phone_uuid_111'
    userStore.user = {
      id: phoneUserId,
      username: 'Alice-Phone',
      token: 'token_phone_123'
    }

    vi.mocked(api.mergeUser).mockRejectedValueOnce(new Error('API POST /users/merge failed (401): Invalid target account password'))

    const res = await userStore.mergeAccount('Alice-Main', 'WrongPassword')
    expect(res.success).toBe(false)
    expect(res.error).toContain('401')

    // User state remains intact
    expect(userStore.userId).toBe(phoneUserId)
    expect(userStore.username).toBe('Alice-Phone')
  })

  it('delegates to connStore.rtcService.requestAccountMerge when running as client', async () => {
    const userStore = useUserStore()
    const recordStore = useRecordStore()
    const { useConnectionStore } = await import('@/stores/connection')
    const connStore = useConnectionStore()

    const phoneUserId = 'user_phone_uuid_111'
    userStore.user = {
      id: phoneUserId,
      username: 'Alice-Phone',
      token: 'token_phone_123'
    }

    const mockRequestAccountMerge = vi.fn().mockResolvedValue({
      success: true,
      newId: 'user_host_999',
      newUsername: 'Alice-Main',
      token: 'token_host_jwt_789'
    })

    connStore.rtcService = {
      isHostMode: vi.fn(() => false),
      requestAccountMerge: mockRequestAccountMerge,
      sendIdentityMigration: vi.fn()
    } as any

    const res = await userStore.mergeAccount('Alice-Main', 'CorrectPassword123')
    expect(mockRequestAccountMerge).toHaveBeenCalledWith(
      'Alice-Main',
      'CorrectPassword123',
      phoneUserId,
      'Alice-Phone'
    )
    expect(res.success).toBe(true)
    expect(res.newId).toBe('user_host_999')
    expect(userStore.userId).toBe('user_host_999')
    expect(userStore.username).toBe('Alice-Main')
    expect(userStore.token).toBe('token_host_jwt_789')

    const stored = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}')
    expect(stored.id).toBe('user_host_999')
    expect(stored.token).toBe('token_host_jwt_789')
  })

  it('handles client-side WebRTC merge failure without corrupting localStorage or userStore', async () => {
    const userStore = useUserStore()
    const { useConnectionStore } = await import('@/stores/connection')
    const connStore = useConnectionStore()

    const phoneUserId = 'user_phone_uuid_111'
    userStore.user = {
      id: phoneUserId,
      username: 'Alice-Phone',
      token: 'token_phone_123'
    }
    localStorage.setItem('scoutingpro-user', JSON.stringify(userStore.user))

    const mockRequestAccountMerge = vi.fn().mockResolvedValue({
      success: false,
      error: 'Invalid target account password'
    })

    connStore.rtcService = {
      isHostMode: vi.fn(() => false),
      requestAccountMerge: mockRequestAccountMerge
    } as any

    const res = await userStore.mergeAccount('Alice-Main', 'WrongPassword123')
    expect(res.success).toBe(false)
    expect(res.error).toBe('Invalid target account password')

    // Preserved unchanged
    expect(userStore.userId).toBe(phoneUserId)
    expect(userStore.username).toBe('Alice-Phone')
    const stored = JSON.parse(localStorage.getItem('scoutingpro-user') || '{}')
    expect(stored.id).toBe(phoneUserId)
  })
})
