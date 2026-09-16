import { ref, onMounted, onUnmounted } from 'vue'

export function useIsMobile(breakpoint = 768) {
  const isMobile = ref(typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false)

  function update() {
    if (typeof window !== 'undefined') {
      isMobile.value = window.innerWidth <= breakpoint
    }
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
