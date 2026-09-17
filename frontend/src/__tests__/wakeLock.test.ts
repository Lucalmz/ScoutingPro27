import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ScreenWakeLockManager } from '../utils/wakeLock'

describe('ScreenWakeLockManager', () => {
  let mockSentinel: any
  let originalNavigator: any

  beforeEach(() => {
    mockSentinel = {
      released: false,
      release: vi.fn().mockImplementation(async () => {
        mockSentinel.released = true
      }),
      addEventListener: vi.fn()
    }

    originalNavigator = global.navigator
    Object.defineProperty(global, 'navigator', {
      value: {
        wakeLock: {
          request: vi.fn().mockResolvedValue(mockSentinel)
        }
      },
      writable: true,
      configurable: true
    })

    Object.defineProperty(global.document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true
    })
  })

  afterEach(() => {
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true
    })
    vi.clearAllMocks()
  })

  it('requests screen wake lock successfully when supported and visible', async () => {
    const manager = new ScreenWakeLockManager()
    const acquired = await manager.request()
    expect(acquired).toBe(true)
    expect(manager.isLocked()).toBe(true)
    expect((navigator as any).wakeLock.request).toHaveBeenCalledWith('screen')
  })

  it('handles unsupported platforms gracefully', async () => {
    Object.defineProperty(global, 'navigator', {
      value: {},
      writable: true,
      configurable: true
    })
    const manager = new ScreenWakeLockManager()
    const acquired = await manager.request()
    expect(acquired).toBe(false)
    expect(manager.isLocked()).toBe(false)
  })

  it('releases wake lock properly', async () => {
    const manager = new ScreenWakeLockManager()
    await manager.request()
    expect(manager.isLocked()).toBe(true)

    await manager.release()
    expect(mockSentinel.release).toHaveBeenCalled()
    expect(manager.isLocked()).toBe(false)
  })

  it('does not acquire lock if document is hidden', async () => {
    Object.defineProperty(global.document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true
    })
    const manager = new ScreenWakeLockManager()
    const acquired = await manager.request()
    expect(acquired).toBe(false)
  })
})
