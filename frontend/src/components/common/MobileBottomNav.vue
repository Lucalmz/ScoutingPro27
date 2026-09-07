<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEventStore } from '@/stores/events'
import { useConnectionStore } from '@/stores/connection'
import type { EventTab } from '@/stores/navigation'

const props = defineProps<{
  activeTab: EventTab
}>()

const emit = defineEmits<{
  (e: 'update:activeTab', tab: EventTab): void
}>()

const { t } = useI18n()
const eventStore = useEventStore()
const connStore = useConnectionStore()

interface NavItem {
  key: EventTab
  label: string
  icon: string
  badge?: boolean
}

const navItems = computed<NavItem[]>(() => {
  const items: NavItem[] = [
    { key: 'scout', label: t('bottom_nav.scout'), icon: 'sports_score' },
    { key: 'pit', label: t('bottom_nav.pit'), icon: 'storefront' },
    { key: 'schedule', label: t('bottom_nav.schedule'), icon: 'calendar_month' },
    { key: 'rankings', label: t('bottom_nav.rankings'), icon: 'leaderboard' }
  ]
  if (eventStore.isHost) {
    items.push({ key: 'scouts', label: t('bottom_nav.scouts'), icon: 'groups' })
  } else {
    items.push({ key: 'history', label: t('bottom_nav.history'), icon: 'history' })
  }
  return items
})

function handleSelect(key: EventTab) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(10)
    } catch {}
  }
  emit('update:activeTab', key)
}
</script>

<template>
  <nav class="mobile-bottom-nav">
    <button
      v-for="item in navItems"
      :key="item.key"
      class="nav-item-btn"
      :class="{ 'is-active': activeTab === item.key }"
      @click="handleSelect(item.key)"
    >
      <span class="material-icons nav-icon">{{ item.icon }}</span>
      <span class="nav-label">{{ item.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.mobile-bottom-nav {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 56px;
  background: var(--card);
  border-top: 1px solid var(--border);
  z-index: 50;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.15);
}

@media (max-width: 768px) {
  .mobile-bottom-nav {
    display: flex;
    align-items: center;
    justify-content: space-around;
  }
}

.nav-item-btn {
  flex: 1;
  height: 100%;
  min-height: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 4px 0;
  transition: color 0.15s ease, transform 0.1s ease;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.nav-item-btn:active {
  transform: scale(0.92);
}

.nav-item-btn.is-active {
  color: var(--primary);
  font-weight: 600;
}

.nav-icon {
  font-size: 22px;
}

.nav-label {
  font-size: 11px;
  line-height: 1;
}
</style>
