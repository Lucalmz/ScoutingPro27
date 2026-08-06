import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  // Use hash history so the JCEF embedded browser never hits the Java
  // backend for unknown paths — everything stays in the SPA.
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
    },
    {
      path: '/event/:eventId',
      name: 'event',
      component: () => import('@/views/EventView.vue'),
      props: true,
    },
  ],
})

export default router
