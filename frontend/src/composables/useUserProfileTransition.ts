import { ref, nextTick } from 'vue'

export type ProfileTransitionPhase = 'idle' | 'open' | 'close'

const isProfileTransitioning = ref(false)
const profileTransitionPhase = ref<ProfileTransitionPhase>('idle')
const lastLandingSeq = ref(0)

let transitionSeq = 0
let lastTriggerEl: HTMLElement | null = null
let safetyTimer: ReturnType<typeof setTimeout> | null = null
let activeVt: { skipTransition?: () => void } | null = null

export function supportsViewTransitionApi(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof (document as Document & { startViewTransition?: unknown }).startViewTransition === 'function'
  )
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function clearSafetyTimer() {
  if (safetyTimer !== null) {
    clearTimeout(safetyTimer)
    safetyTimer = null
  }
}

function setDocumentPhaseAttrs(phase: 'open' | 'close') {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.transitionType = 'user-profile'
  document.documentElement.dataset.profilePhase = phase
}

function clearDocumentPhaseAttrs() {
  if (typeof document === 'undefined') return
  document.documentElement.removeAttribute('data-transition-type')
  document.documentElement.removeAttribute('data-profile-phase')
}

function restoreTriggerFocus() {
  if (lastTriggerEl && lastTriggerEl.isConnected && typeof lastTriggerEl.focus === 'function') {
    lastTriggerEl.focus({ preventScroll: true })
  }
  lastTriggerEl = null
}

/**
 * Coordinates shared-element open/close View Transitions for the Edit Profile modal.
 */
export function useUserProfileTransition() {
  function openProfileModal(setVisible: (val: boolean) => void, triggerEl?: HTMLElement | null) {
    lastTriggerEl =
      triggerEl ??
      (typeof document !== 'undefined' &&
      typeof HTMLElement !== 'undefined' &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null)

    const seq = ++transitionSeq
    clearSafetyTimer()

    const prevVt = activeVt
    activeVt = null
    if (prevVt) {
      try {
        prevVt.skipTransition?.()
      } catch {}
    }

    if (!supportsViewTransitionApi() || prefersReducedMotion()) {
      isProfileTransitioning.value = false
      profileTransitionPhase.value = 'idle'
      clearDocumentPhaseAttrs()
      setVisible(true)
      lastLandingSeq.value++
      return
    }

    isProfileTransitioning.value = true
    profileTransitionPhase.value = 'open'
    setDocumentPhaseAttrs('open')

    let finished = false
    const finishOpen = () => {
      if (finished || seq !== transitionSeq) return
      finished = true
      activeVt = null
      clearSafetyTimer()
      isProfileTransitioning.value = false
      profileTransitionPhase.value = 'idle'
      clearDocumentPhaseAttrs()
      lastLandingSeq.value++
    }

    safetyTimer = setTimeout(() => {
      if (seq !== transitionSeq) return
      const vtToSkip = activeVt
      activeVt = null
      if (vtToSkip) {
        try {
          vtToSkip.skipTransition?.()
        } catch {}
      }
      finishOpen()
    }, 1200)

    let callbackInvoked = false
    try {
      const vt = (document as any).startViewTransition(async () => {
        callbackInvoked = true
        setVisible(true)
        await nextTick()
      })
      if (vt) {
        activeVt = vt
        vt.ready?.catch(() => {})
        vt.updateCallbackDone?.catch(() => {})
        Promise.resolve(vt.finished).catch(() => {}).finally(finishOpen)
      } else {
        if (!callbackInvoked) setVisible(true)
        finishOpen()
      }
    } catch {
      if (!callbackInvoked) setVisible(true)
      finishOpen()
    }
  }

  async function closeProfileModal(setVisible: (val: boolean) => void) {
    const seq = ++transitionSeq
    clearSafetyTimer()

    const prevVt = activeVt
    activeVt = null
    if (prevVt) {
      try {
        prevVt.skipTransition?.()
      } catch {}
    }

    if (!supportsViewTransitionApi() || prefersReducedMotion()) {
      isProfileTransitioning.value = false
      profileTransitionPhase.value = 'idle'
      clearDocumentPhaseAttrs()
      setVisible(false)
      await nextTick()
      restoreTriggerFocus()
      return
    }

    isProfileTransitioning.value = true
    profileTransitionPhase.value = 'close'
    setDocumentPhaseAttrs('close')

    if (
      typeof document !== 'undefined' &&
      typeof HTMLElement !== 'undefined' &&
      document.activeElement instanceof HTMLElement
    ) {
      document.activeElement.blur()
    }

    await nextTick()
    if (seq !== transitionSeq) return

    let finished = false
    const finishClose = () => {
      if (finished || seq !== transitionSeq) return
      finished = true
      activeVt = null
      clearSafetyTimer()
      isProfileTransitioning.value = false
      profileTransitionPhase.value = 'idle'
      clearDocumentPhaseAttrs()
      restoreTriggerFocus()
    }

    safetyTimer = setTimeout(() => {
      if (seq !== transitionSeq) return
      const vtToSkip = activeVt
      activeVt = null
      if (vtToSkip) {
        try {
          vtToSkip.skipTransition?.()
        } catch {}
      }
      finishClose()
    }, 1000)

    let callbackInvoked = false
    try {
      const vt = (document as any).startViewTransition(async () => {
        callbackInvoked = true
        setVisible(false)
        await nextTick()
      })
      if (vt) {
        activeVt = vt
        vt.ready?.catch(() => {})
        vt.updateCallbackDone?.catch(() => {})
        Promise.resolve(vt.finished).catch(() => {}).finally(finishClose)
      } else {
        if (!callbackInvoked) setVisible(false)
        finishClose()
      }
    } catch {
      if (!callbackInvoked) setVisible(false)
      finishClose()
    }
  }

  function resetProfileTransition() {
    transitionSeq++
    clearSafetyTimer()
    const vtToSkip = activeVt
    activeVt = null
    if (vtToSkip) {
      try {
        vtToSkip.skipTransition?.()
      } catch {}
    }
    isProfileTransitioning.value = false
    profileTransitionPhase.value = 'idle'
    lastLandingSeq.value = 0
    lastTriggerEl = null
    clearDocumentPhaseAttrs()
  }

  return {
    isProfileTransitioning,
    profileTransitionPhase,
    lastLandingSeq,
    openProfileModal,
    closeProfileModal,
    resetProfileTransition
  }
}
