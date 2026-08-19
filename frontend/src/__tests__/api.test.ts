import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkUserExists, LocalApiTimeoutError } from '../services/api'

describe('api service timeout and error handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
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
})
