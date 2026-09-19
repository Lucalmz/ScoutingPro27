import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './assets/main.css'

import { i18n } from './i18n'
import { useUserStore } from './stores/user'
import { isDesktopHost } from './services/photoStorage'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
useUserStore().restoreFromCache()

app.use(router)
app.use(i18n)

app.mount('#app')

if (!isDesktopHost() && typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
