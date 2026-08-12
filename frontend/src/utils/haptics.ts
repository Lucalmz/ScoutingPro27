/**
 * Safely trigger device haptic feedback.
 * MUST be called synchronously within a user gesture handler (e.g. click/touchstart)
 * Otherwise it will be ignored by many browsers.
 */
export function hapticFeedback(pattern: number | number[] = 10) {
  if (typeof window !== 'undefined' && navigator && navigator.vibrate) {
    try {
      navigator.vibrate(pattern)
    } catch (e) {
      // Ignore errors if vibrate is not supported or blocked
    }
  }
}
