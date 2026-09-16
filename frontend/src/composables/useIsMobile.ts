import { ref, onMounted, onUnmounted } from 'vue'

export function isMobileDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const isMobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)
  const isTouchMac = /Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1
  return isMobileUa || isTouchMac
}

export function useIsMobile(breakpoint = 768) {
  function check(): boolean {
    if (typeof window === 'undefined') return false
    return window.innerWidth <= breakpoint || isMobileDevice()
  }

  const isMobile = ref(check())

  function update() {
    isMobile.value = check()
  }

  onMounted(() => {
    window.addEventListener('resize', update, { passive: true })
    update()
  })

  onUnmounted(() => {
    window.removeEventListener('resize', update)
  })

  return {
    isMobile
  }
}
