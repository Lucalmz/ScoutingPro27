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
  const originalVibrate = navigator.vibrate

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalVibrate !== undefined) {
      Object.defineProperty(navigator, 'vibrate', {
        value: originalVibrate,
        configurable: true,
        writable: true
      })
    }
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

  it('safely handles missing navigator.vibrate without throwing', () => {
    Object.defineProperty(navigator, 'vibrate', {
      value: undefined,
      configurable: true,
      writable: true
    })

    expect(() => {
      hapticLight()
      hapticMedium()
      hapticSuccess()
      hapticWarning()
    }).not.toThrow()
  })
})
