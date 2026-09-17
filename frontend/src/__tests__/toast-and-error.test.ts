import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useToastStore } from '@/stores/toast'
import { formatUserFriendlyError, ApiError } from '@/utils/errorHelper'

describe('Toast Store Deduplication & Error Helper Timeout Handling', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('deduplicates identical active toasts and allows distinct toasts', () => {
    const toastStore = useToastStore()

    // First push
    toastStore.showToast('Network error occurred', 'error', { detail: 'code 500' })
    expect(toastStore.toasts.length).toBe(1)

    // Second push of exact same toast while first is still active: should be suppressed
    toastStore.showToast('Network error occurred', 'error', { detail: 'code 500' })
    expect(toastStore.toasts.length).toBe(1)

    // Different message: should be accepted
    toastStore.showToast('Another issue occurred', 'error')
    expect(toastStore.toasts.length).toBe(2)

    // Same message but different type: should be accepted
    toastStore.showToast('Network error occurred', 'warning')
    expect(toastStore.toasts.length).toBe(3)
  })

  it('formatUserFriendlyError only classifies actual API errors as request_timeout', () => {
    // 1. Generic non-API string containing 'timeout' (like SAS timeout) should NOT be hijacked into backend service timeout
    const sasTimeoutResult = formatUserFriendlyError('Safety code mismatch: SAS verification timeout (60s)')
    expect(sasTimeoutResult.message).not.toContain('服务响应超时')
    expect(sasTimeoutResult.message).not.toContain('Service response timed out')
    expect(sasTimeoutResult.detail).toContain('Safety code mismatch')

    // 2. ApiError timeout SHOULD be classified as request_timeout
    const apiTimeoutResult = formatUserFriendlyError(new ApiError(408, '/api/records', 'POST', 'Request timed out'))
    expect(apiTimeoutResult.message).toMatch(/(服务响应超时|Service response timed out)/)

    // 3. LocalApiTimeoutError SHOULD be classified as request_timeout
    const localTimeoutErr = new Error('LocalApiTimeoutError: /api/events/test挂起超过15000ms')
    const localResult = formatUserFriendlyError(localTimeoutErr)
    expect(localResult.message).toMatch(/(服务响应超时|Service response timed out)/)
  })
})
