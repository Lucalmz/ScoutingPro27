import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  hapticFeedback,
  hapticLight,
  hapticMedium,
  hapticHeavy,
  hapticSelection,
  hapticSuccess,
  hapticWarning
} from '../utils/haptics'

describe('Progressive Haptics Engine', () => {
  const origVibrateDesc = Object.getOwnPropertyDescriptor(navigator, 'vibrate')
  const origUaDesc = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
  const origTouchPointsDesc = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.getElementById('__sp27_haptic_switch__')?.remove()
    document.querySelectorAll('label[for="__sp27_haptic_switch__"]').forEach((el) => el.remove())
    if (origVibrateDesc) {
      Object.defineProperty(navigator, 'vibrate', origVibrateDesc)
    } else {
      delete (navigator as any).vibrate
    }
    if (origUaDesc) {
      Object.defineProperty(navigator, 'userAgent', origUaDesc)
    }
    if (origTouchPointsDesc) {
      Object.defineProperty(navigator, 'maxTouchPoints', origTouchPointsDesc)
    }
    vi.restoreAllMocks()
  })

  it('calls navigator.vibrate on platforms that support it', () => {
    const vibrateMock = vi.fn()
    Object.defineProperty(navigator, 'vibrate', {
      value: vibrateMock,
      configurable: true,
      writable: true
    })

    hapticFeedback(15)
    expect(vibrateMock).toHaveBeenCalledWith(15)

    hapticLight()
    expect(vibrateMock).toHaveBeenCalledWith(10)

    hapticMedium()
    expect(vibrateMock).toHaveBeenCalledWith(18)

    hapticHeavy()
    expect(vibrateMock).toHaveBeenCalledWith(28)

    hapticSelection()
    expect(vibrateMock).toHaveBeenCalledWith(12)

    hapticSuccess()
    expect(vibrateMock).toHaveBeenCalledWith([18, 45, 18])

    hapticWarning()
    expect(vibrateMock).toHaveBeenCalledWith([35, 45, 35])
  })

  it('triggers iOS Safari switch fallback for iPhone and iPadOS Macintosh touch devices', () => {
    Object.defineProperty(navigator, 'vibrate', {
      value: undefined,
      configurable: true,
      writable: true
    })
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)',
      configurable: true
    })

    hapticFeedback()
    const sw = document.getElementById('__sp27_haptic_switch__') as HTMLInputElement | null
    expect(sw).not.toBeNull()
    expect(sw?.type).toBe('checkbox')
    expect(sw?.hasAttribute('switch')).toBe(true)

    const label = document.querySelector('label[for="__sp27_haptic_switch__"]') as HTMLLabelElement | null
    expect(label).not.toBeNull()
    const labelClickSpy = vi.spyOn(label!, 'click')

    // Double pulse for hapticSuccess (initial + 60ms)
    hapticSuccess()
    expect(labelClickSpy).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60)
    expect(labelClickSpy).toHaveBeenCalledTimes(2)

    // Double pulse for hapticWarning (initial + 50ms) on iPadOS Macintosh with touch points
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true
    })
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: 5,
      configurable: true
    })
    hapticWarning()
    expect(labelClickSpy).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(50)
    expect(labelClickSpy).toHaveBeenCalledTimes(4)
  })

  it('falls back gracefully when navigator.vibrate throws or is missing on non-iOS', () => {
    Object.defineProperty(navigator, 'vibrate', {
      value: () => {
        throw new Error('Blocked')
      },
      configurable: true,
      writable: true
    })
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true
    })

    expect(() => {
      hapticLight()
      hapticMedium()
      hapticSuccess()
      hapticWarning()
    }).not.toThrow()
  })
})
