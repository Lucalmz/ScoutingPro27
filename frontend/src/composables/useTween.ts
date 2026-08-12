import { ref, watch, type Ref } from 'vue'

/**
 * A lightweight hook to tween numbers smoothly using requestAnimationFrame.
 * This avoids heavy DOM manipulation of traditional odometer wheels while
 * maintaining a premium numeric rolling effect.
 */
export function useTween(sourceTarget: Ref<number | string>, duration: number = 600) {
  const tweened = ref(Number(sourceTarget.value) || 0)
  
  watch(sourceTarget, (newVal) => {
    const target = Number(newVal) || 0
    if (tweened.value === target) return
    
    const start = tweened.value
    const change = target - start
    const startTime = performance.now()
    
    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime
      if (elapsed >= duration) {
        tweened.value = target
        return
      }
      
      // Ease out cubic
      const progress = elapsed / duration
      const easeProgress = 1 - Math.pow(1 - progress, 3)
      
      tweened.value = start + change * easeProgress
      
      requestAnimationFrame(animate)
    }
    
    requestAnimationFrame(animate)
  })
  
  return tweened
}
