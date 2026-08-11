import { reactive } from 'vue'

export const transitionState = reactive({
  sharedElementId: null as string | null,
  activeToken: null as number | null,
  
  startSharedTransition(id: string): number {
    this.sharedElementId = id
    this.activeToken = Date.now() + Math.random()
    return this.activeToken
  },
  
  clear(token: number) {
    // Only clear if the token matches, avoiding race conditions during rapid interrupted navigations
    if (this.activeToken === token) {
      this.sharedElementId = null
      this.activeToken = null
    }
  }
})
