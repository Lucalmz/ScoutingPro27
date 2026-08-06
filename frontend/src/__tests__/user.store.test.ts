import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUserStore } from '../stores/user'
import * as api from '../services/api'

vi.mock('../services/api', () => ({
  login: vi.fn()
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
})
