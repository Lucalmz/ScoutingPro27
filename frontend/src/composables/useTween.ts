import { ref, watch, onScopeDispose, type Ref } from 'vue'

/**
 * A lightweight hook to tween numbers smoothly using requestAnimationFrame.
 * This avoids heavy DOM manipulation of traditional odometer wheels while
 * maintaining a premium numeric rolling effect.
 */
export function useTween(sourceTarget: Ref<number | string>, duration: number = 600) {
  const tweened = ref(Number(sourceTarget.value) || 0)
  let rafId: number | null = null

  const cancelCurrentAnimation = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  watch(sourceTarget, (newVal) => {
    cancelCurrentAnimation()
    const target = Number(newVal) || 0
    if (tweened.value === target) return

    // Honor prefers-reduced-motion
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      tweened.value = target
      return
    }

    const start = tweened.value
    const change = target - start
    const startTime = performance.now()

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime
      if (elapsed >= duration) {
        tweened.value = target
        rafId = null
        return
      }

      // Ease out cubic
      const progress = elapsed / duration
      const easeProgress = 1 - Math.pow(1 - progress, 3)

      tweened.value = start + change * easeProgress

      rafId = requestAnimationFrame(animate)
    }

    rafId = requestAnimationFrame(animate)
  })

  onScopeDispose(() => {
    cancelCurrentAnimation()
  })

  return tweened
}
