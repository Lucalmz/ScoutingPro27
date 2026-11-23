import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useUserStore, clearBeforeLogoutHooksForTesting } from '../stores/user'
import { useRecordStore } from '../stores/records'
import { usePitScoutStore } from '../stores/pitScout'
import { useConnectionStore } from '../stores/connection'
import * as api from '../services/api'
import type { ScoutingRecord } from '../types'

vi.mock('../services/api', async () => {
  const actual = await vi.importActual<any>('../services/api')
  return {
    ...actual,
    login: vi.fn(),
    renameUser: vi.fn(),
    mergeUser: vi.fn(),
    checkUserExists: vi.fn(),
    verifyToken: vi.fn(),
    saveRecord: vi.fn().mockResolvedValue(undefined),
    isStaticCloudHost: vi.fn(() => false)
  }
})

describe('User Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(api.isStaticCloudHost).mockReturnValue(false)
  })

  afterEach(() => {
    clearBeforeLogoutHooksForTesting()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('login success', async () => {
    const store = useUserStore()
    vi.mocked(api.login).mockResolvedValue({ id: '123', username: 'testuser' })
    const success = await store.login('testuser', 'testpass')
    expect(success).toBe(true)
    expect(store.user).toEqual({ id: '123', username: 'testuser' })
    expect(store.isLoggedIn).toBe(true)
    expect(localStorage.getItem('scoutingpro-user')).toBeTruthy()
  })

  it('logout', async () => {
    const store = useUserStore()
    store.user = { id: '123', username: 'testuser' }
    localStorage.setItem('scoutingpro-user', JSON.stringify(store.user))
    await store.logout()
    expect(store.user).toBeNull()
    expect(localStorage.getItem('scoutingpro-user')).toBeNull()
  })

  it('restoreFromCache', () => {
    const store = useUserStore()
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: '999', username: 'cached' }))
    store.restoreFromCache()
    expect(store.user?.username).toBe('cached')
  })

  it('rename preserves immutable user ID online', async () => {
    const store = useUserStore()
    store.user = { id: 'user-uuid-permanent', username: 'OldName' }
    vi.mocked(api.renameUser).mockResolvedValue({
      id: 'user-uuid-permanent',
      username: 'NewName',
      token: 'new-token'
    })

    const res = await store.rename('NewName')
    expect(res.success).toBe(true)
    expect(res.oldId).toBe('user-uuid-permanent')
    expect(res.newId).toBe('user-uuid-permanent')
    expect(store.userId).toBe('user-uuid-permanent')
    expect(store.username).toBe('NewName')
  }, 15000)

  it('rename preserves immutable user ID when backend is offline', async () => {
    const store = useUserStore()
    store.user = { id: 'user-uuid-permanent', username: 'OldName' }
    vi.mocked(api.renameUser).mockRejectedValue(new Error('Network error'))

    const res = await store.rename('OfflineNewName')
    expect(res.success).toBe(true)
    expect(res.oldId).toBe('user-uuid-permanent')
    expect(res.newId).toBe('user-uuid-permanent')
    expect(store.userId).toBe('user-uuid-permanent')
    expect(store.username).toBe('OfflineNewName')
  })

  it('updateNickname updates username while preserving immutable user ID', () => {
    const store = useUserStore()
    store.user = { id: 'user-uuid-permanent', username: 'OldName' }
    store.updateNickname('NewNicknameOnly')
    expect(store.userId).toBe('user-uuid-permanent')
    expect(store.username).toBe('NewNicknameOnly')
  })

  it('rename does not fake success when backend returns 409 duplicate name', async () => {
    const store = useUserStore()
    store.user = { id: 'user-uuid-permanent', username: 'OldName' }
    vi.mocked(api.renameUser).mockRejectedValue(new Error('API POST /user/rename failed (409): {"error":"username already taken"}'))

    const res = await store.rename('TakenName')
    expect(res.success).toBe(false)
    expect(res.error).toContain('409')
    expect(store.username).toBe('OldName')
  })

  it('rename does not fake success when backend returns 401 incorrect password', async () => {
    const store = useUserStore()
    store.user = { id: 'user-uuid-permanent', username: 'OldName' }
    vi.mocked(api.renameUser).mockRejectedValue(new Error('API POST /user/rename failed (401): {"error":"invalid old password"}'))

    const res = await store.rename({ newUsername: 'NewName', oldPassword: 'wrong-pass' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('401')
    expect(store.username).toBe('OldName')
  })

  describe('mergeAccount (Account Merging)', () => {
    it('successfully merges source user into target user and cascades local stores', async () => {
      const userStore = useUserStore()
      const recordStore = useRecordStore()
      const pitStore = usePitScoutStore()

      const phoneUserId = 'user_phone_uuid_111'
      userStore.user = {
        id: phoneUserId,
        username: 'Alice-Phone',
        token: 'token_phone_123'
      }

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

      const mainUserId = 'user_main_uuid_222'
      vi.mocked(api.mergeUser).mockResolvedValueOnce({
        id: mainUserId,
        username: 'Alice-Main',
        token: 'token_main_456'
      })

      const res = await userStore.mergeAccount('Alice-Main', 'SecretPass123')
      expect(res.success).toBe(true)
      expect(res.oldId).toBe(phoneUserId)
      expect(res.newId).toBe(mainUserId)
      expect(res.newUsername).toBe('Alice-Main')

      expect(userStore.userId).toBe(mainUserId)
      expect(userStore.username).toBe('Alice-Main')
      expect(userStore.token).toBe('token_main_456')

      expect(recordStore.records[0].scoutId).toBe(mainUserId)
      expect(recordStore.records[0].scoutName).toBe('Alice-Main')
      expect(pitStore.records[0].scoutId).toBe(mainUserId)
      expect(pitStore.records[0].scoutName).toBe('Alice-Main')

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
      expect(userStore.userId).toBe(phoneUserId)
      expect(userStore.username).toBe('Alice-Phone')
    })

    it('delegates to connStore.rtcService.requestAccountMerge when running as client', async () => {
      const userStore = useUserStore()
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
      expect(userStore.userId).toBe(phoneUserId)
      expect(userStore.username).toBe('Alice-Phone')
      expect(JSON.parse(localStorage.getItem('scoutingpro-user')!).id).toBe(phoneUserId)
    })
  })
})
