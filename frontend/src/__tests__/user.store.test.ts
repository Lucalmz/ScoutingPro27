import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUserStore } from '../stores/user'
import * as api from '../services/api'

vi.mock('../services/api', () => ({
  login: vi.fn(),
  renameUser: vi.fn()
}))

describe('User Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
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
    store.logout()
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
  })

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
})
