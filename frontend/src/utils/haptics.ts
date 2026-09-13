/**
 * ScoutingPro27 — Progressive Cross-Platform Haptics Engine
 *
 * Supports:
 * 1. Standard W3C Vibration API (`navigator.vibrate`) for Android / Chrome / Firefox.
 * 2. iOS Safari 17.4+ native Taptic Engine trigger using the `<input type="checkbox" switch>` mechanism.
 * 3. Graceful degradation when haptics are unsupported or blocked.
 *
 * NOTE: MUST be called synchronously within a direct user interaction handler
 * (e.g. click, pointerdown, touchstart).
 */

let iosSwitchEl: HTMLInputElement | null = null
let iosSwitchLabel: HTMLLabelElement | null = null

function isIosOrSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1)
}

function getOrInitIosSwitch(): HTMLInputElement | null {
  if (typeof document === 'undefined' || !document.body) return null
  if (iosSwitchEl && iosSwitchEl.isConnected) return iosSwitchEl

  try {
    const el = document.createElement('input')
    el.type = 'checkbox'
    el.setAttribute('switch', '')
    el.id = '__sp27_haptic_switch__'
    el.style.position = 'fixed'
    el.style.top = '-9999px'
    el.style.left = '-9999px'
    el.style.opacity = '0'
    el.style.pointerEvents = 'none'
    el.style.width = '0'
    el.style.height = '0'
    el.style.zIndex = '-9999'
    el.tabIndex = -1
    el.setAttribute('aria-hidden', 'true')

    const label = document.createElement('label')
    label.htmlFor = el.id
    label.style.position = 'fixed'
    label.style.top = '-9999px'
    label.style.left = '-9999px'
    label.style.opacity = '0'
    label.style.pointerEvents = 'none'
    label.tabIndex = -1
    label.setAttribute('aria-hidden', 'true')

    document.body.appendChild(el)
    document.body.appendChild(label)

    iosSwitchEl = el
    iosSwitchLabel = label
    return el
  } catch {
    return null
  }
}

function triggerIosHaptic() {
  try {
    const sw = getOrInitIosSwitch()
    if (sw) {
      sw.checked = !sw.checked
      if (iosSwitchLabel) {
        iosSwitchLabel.click()
      } else {
        sw.click()
      }
    }
  } catch {
    // Gracefully ignore
  }
}

/**
 * Base haptic feedback function.
 * @param pattern Duration in ms or vibration pattern array.
 */
export function hapticFeedback(pattern: number | number[] = 10): void {
  if (typeof window === 'undefined') return

  // 1. Android / Standard browsers with navigator.vibrate
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern)
      return
    } catch {
      // Ignored
    }
  }

  // 2. iOS Safari fallback via switch trick
  if (isIosOrSafari()) {
    triggerIosHaptic()
  }
}

/** Light tap (10ms) — Tab switches, minor button clicks, tag removal */
export function hapticLight(): void {
  hapticFeedback(10)
}

/** Medium tap (18ms) — Score increments (+), primary counter actions */
export function hapticMedium(): void {
  hapticFeedback(18)
}

/** Heavy tap (28ms) — Important mode switches */
export function hapticHeavy(): void {
  hapticFeedback(28)
}

/** Selection toggle (12ms) — Checkboxes, segmented buttons */
export function hapticSelection(): void {
  hapticFeedback(12)
}

/** Success feedback — Double pulse [18, 45, 18] — Form submit, save */
export function hapticSuccess(): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([18, 45, 18])
      return
    } catch {}
  }
  // On iOS Safari trigger twice with small interval
  if (isIosOrSafari()) {
    triggerIosHaptic()
    setTimeout(() => {
      triggerIosHaptic()
    }, 60)
  }
}

/** Warning / Error feedback — Triplet pulse [35, 45, 35] — Invalid input, ban warning */
export function hapticWarning(): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([35, 45, 35])
      return
    } catch {}
  }
  if (isIosOrSafari()) {
    triggerIosHaptic()
    setTimeout(() => {
      triggerIosHaptic()
    }, 50)
  }
}

