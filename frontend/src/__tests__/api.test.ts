import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkUserExists, renameUser, listEvents, LocalApiTimeoutError } from '../services/api'

describe('api service timeout and error handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('throws LocalApiTimeoutError when fetch is aborted due to timeout', async () => {
    // Mock fetch rejecting with AbortError
    global.fetch = vi.fn().mockImplementation((_url, _opts) => {
      const abortError = new Error('The operation was aborted')
      abortError.name = 'AbortError'
      return Promise.reject(abortError)
    })

    await expect(checkUserExists('test')).rejects.toThrow(LocalApiTimeoutError)
  })

  it('formats error message indicating local application response issue', () => {
    const err = new LocalApiTimeoutError('/user/check', 8000)
    expect(err.name).toBe('LocalApiTimeoutError')
    expect(err.message).toContain('应用响应异常')
    expect(err.message).toContain('挂起超过 8000ms')
    expect(err.message).toContain('可能需要重启应用')
  })

  it('does NOT clear user token or dispatch auth-unauthorized when renameUser receives 401', async () => {
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', token: 'valid-token' }))
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":"invalid old password"}'),
      headers: new Headers()
    })

    await expect(renameUser({ oldPassword: 'wrong' })).rejects.toThrow('API POST /user/rename failed (401)')
    expect(localStorage.getItem('scoutingpro-user')).toBeTruthy()
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('clears user token and dispatches auth-unauthorized when general request receives 401', async () => {
    localStorage.setItem('scoutingpro-user', JSON.stringify({ id: 'u1', token: 'expired-token' }))
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
      headers: new Headers()
    })

    await expect(listEvents('u1')).rejects.toThrow('API GET /events?userId=u1 failed (401)')
    expect(localStorage.getItem('scoutingpro-user')).toBeNull()
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'auth-unauthorized' }))
  })
})
