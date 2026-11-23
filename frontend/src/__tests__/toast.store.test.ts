import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useToastStore } from '@/stores/toast'

describe('Toast Store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('deduplicates identical active toasts and allows distinct toasts', () => {
    const toastStore = useToastStore()

    toastStore.showToast('Network error occurred', 'error', { detail: 'code 500' })
    expect(toastStore.toasts.length).toBe(1)

    toastStore.showToast('Network error occurred', 'error', { detail: 'code 500' })
    expect(toastStore.toasts.length).toBe(1)

    toastStore.showToast('Another issue occurred', 'error')
    expect(toastStore.toasts.length).toBe(2)

    toastStore.showToast('Network error occurred', 'warning')
    expect(toastStore.toasts.length).toBe(3)
  })

  it('auto-dismisses toasts after the configured duration', () => {
    const toastStore = useToastStore()

    toastStore.showToast('Transient message', 'info')
    expect(toastStore.toasts).toHaveLength(1)

    vi.advanceTimersByTime(3499)
    expect(toastStore.toasts).toHaveLength(1)

    vi.advanceTimersByTime(1)
    expect(toastStore.toasts).toHaveLength(0)
  })
})
