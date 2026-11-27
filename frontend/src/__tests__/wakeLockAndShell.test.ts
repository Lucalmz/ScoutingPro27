import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { ScreenWakeLockManager, useScreenWakeLock } from '../utils/wakeLock'
import { transitionState } from '../utils/transitionState'
import { hasDesktopTitleBar } from '../utils/desktopShell'

describe('wakeLock, transitionState, and desktopShell utilities', () => {
  const origWakeLockDesc = Object.getOwnPropertyDescriptor(navigator, 'wakeLock')
  const origVisibilityDesc = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  const origLocation = window.location

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    if (origWakeLockDesc) {
      Object.defineProperty(navigator, 'wakeLock', origWakeLockDesc)
    } else {
      delete (navigator as any).wakeLock
    }
    if (origVisibilityDesc) {
      Object.defineProperty(document, 'visibilityState', origVisibilityDesc)
    }
    vi.restoreAllMocks()
  })

  it('handles unsupported wakeLock API gracefully', async () => {
    delete (navigator as any).wakeLock
    const mgr = new ScreenWakeLockManager()
    expect(await mgr.request()).toBe(false)
    expect(mgr.isLocked()).toBe(false)
    await mgr.release()
  })

  it('acquires wakeLock, handles system release + visibilitychange re-acquire, and releases manually', async () => {
    const releaseListeners: Array<() => void> = []
    let currentSentinel = {
      released: false,
      addEventListener: vi.fn((ev: string, cb: () => void) => {
        if (ev === 'release') releaseListeners.push(cb)
      }),
      release: vi.fn(async function (this: any) {
        this.released = true
      })
    }

    const requestMock = vi.fn().mockImplementation(async () => currentSentinel)
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: requestMock },
      configurable: true
    })
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true
    })

    const mgr = new ScreenWakeLockManager()
    expect(await mgr.request()).toBe(true)
    expect(mgr.isLocked()).toBe(true)

    // System releases sentinel
    currentSentinel.released = true
    releaseListeners.forEach((fn) => fn())
    expect(mgr.isLocked()).toBe(false)

    // Page becomes visible again -> re-requests wake lock
    currentSentinel = {
      released: false,
      addEventListener: vi.fn(),
      release: vi.fn(async function (this: any) {
        this.released = true
      })
    }
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(2)
    })
    expect(mgr.isLocked()).toBe(true)

    // Manual release cleans up listener and sentinel
    await mgr.release()
    expect(currentSentinel.release).toHaveBeenCalledTimes(1)
    expect(mgr.isLocked()).toBe(false)
  })

  it('returns false when document is hidden or request rejects', async () => {
    const requestMock = vi.fn().mockRejectedValue(new Error('Permission denied'))
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: requestMock },
      configurable: true
    })

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true
    })
    const mgr = new ScreenWakeLockManager()
    expect(await mgr.request()).toBe(false)
    expect(requestMock).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true
    })
    expect(await mgr.request()).toBe(false)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it('useScreenWakeLock requests on mount and releases on unmount', async () => {
    const releaseSpy = vi.fn(async () => {})
    const requestMock = vi.fn(async () => ({
      released: false,
      addEventListener: vi.fn(),
      release: releaseSpy
    }))
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: requestMock },
      configurable: true
    })
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true
    })

    const TestComp = defineComponent({
      setup() {
        return useScreenWakeLock()
      },
      template: '<div />'
    })

    const wrapper = mount(TestComp)
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1)
    })
    wrapper.unmount()
    await vi.waitFor(() => {
      expect(releaseSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('transitionState clears only when activeToken matches', () => {
    const token1 = transitionState.startSharedTransition('event-card-1')
    expect(transitionState.sharedElementId).toBe('event-card-1')

    const token2 = transitionState.startSharedTransition('event-card-2')
    transitionState.clear(token1) // stale token must NOT clear newer transition
    expect(transitionState.sharedElementId).toBe('event-card-2')

    transitionState.clear(token2)
    expect(transitionState.sharedElementId).toBeNull()
    expect(transitionState.activeToken).toBeNull()
  })

  it('hasDesktopTitleBar checks shell=desktop query param', () => {
    expect(hasDesktopTitleBar()).toBe(false)
    window.history.replaceState({}, '', '/?shell=desktop')
    expect(hasDesktopTitleBar()).toBe(true)
    window.history.replaceState({}, '', '/')
    expect(hasDesktopTitleBar()).toBe(false)
    void origLocation
  })
})
