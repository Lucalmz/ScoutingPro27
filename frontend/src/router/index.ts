import { createRouter, createWebHashHistory } from 'vue-router'
import { nextTick } from 'vue'
import { transitionState } from '@/utils/transitionState'

const router = createRouter({
  // Use hash history so the JCEF embedded browser never hits the Java
  // backend for unknown paths — everything stays in the SPA.
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { depth: 0 }
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { depth: 1 }
    },
    {
      path: '/event/:eventId',
      name: 'event',
      component: () => import('@/views/EventView.vue'),
      props: true,
      meta: { depth: 2 }
    },
    {
      path: '/event/:eventId/team/:teamNumber',
      name: 'team-detail',
      component: () => import('@/views/TeamDetailView.vue'),
      props: true,
      meta: { depth: 3 }
    },
  ],
})

let currentTransition: any = null // Use any if ViewTransition type is missing in older TS

router.beforeEach((to, from) => {
  if (to.name === 'dashboard' && from.name === 'event') {
    transitionState.startSharedTransition(`event-card-${from.params.eventId}`)
  }
})

router.beforeResolve((to, from, next) => {
  if (to.path === from.path || !document.startViewTransition) {
    if (transitionState.activeToken) {
      transitionState.clear(transitionState.activeToken)
    }
    return next()
  }

  // Interruption handling
  if (currentTransition) {
    currentTransition.skipTransition()
  }

  let direction = 'fade'
  const toDepth = to.meta.depth as number | undefined
  const fromDepth = from.meta.depth as number | undefined
  
  if (toDepth !== undefined && fromDepth !== undefined && toDepth !== fromDepth) {
    direction = toDepth < fromDepth ? 'back' : 'forward'
  }

  // Synchronously set dataset right before startViewTransition
  document.documentElement.dataset.direction = direction
  document.documentElement.dataset.transitionType = transitionState.sharedElementId ? 'shared' : 'root'

  // Capture the transaction token assigned by the click
  const token = transitionState.activeToken

  currentTransition = document.startViewTransition(() => {
    return new Promise<void>(resolve => {
      const unregister = router.afterEach(() => {
        unregister()
        nextTick(() => {
          setTimeout(resolve, 10)
        })
      })
      next()
    })
  })

  // Cleanup reliably after transition finishes or is interrupted
  currentTransition.finished.finally(() => {
    currentTransition = null
    if (token !== null) {
      transitionState.clear(token)
    }
    
    // Only remove dataset attributes if a new transition hasn't started
    // (If a new one started, it would have overwritten them, and we shouldn't wipe its work)
    if (transitionState.activeToken === null || transitionState.activeToken === token) {
      document.documentElement.removeAttribute('data-direction')
      document.documentElement.removeAttribute('data-transition-type')
    }
  })
})

export default router
