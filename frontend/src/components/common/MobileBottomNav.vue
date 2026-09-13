<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useEventStore } from '@/stores/events'
import { hapticLight } from '@/utils/haptics'
import type { EventTab } from '@/stores/navigation'

const props = defineProps<{
  activeTab: EventTab
}>()

const emit = defineEmits<{
  (e: 'update:activeTab', tab: EventTab): void
}>()

const { t } = useI18n()
const eventStore = useEventStore()
const showMoreSheet = ref(false)

interface NavItem {
  key: EventTab | 'more'
  label: string
  icon: string
  badge?: boolean
}

// Dynamic 5th tab
const fifthItem = computed<NavItem>(() => {
  if (props.activeTab === 'history') {
    return { key: 'history', label: t('bottom_nav.history'), icon: 'history' }
  }
  if (props.activeTab === 'ai') {
    return { key: 'ai', label: t('bottom_nav.ai'), icon: 'smart_toy' }
  }
  if (props.activeTab === 'scouts') {
    return { key: 'scouts', label: t('bottom_nav.scouts'), icon: 'groups' }
  }
  return { key: 'more', label: t('bottom_nav.more'), icon: 'more_horiz' }
})

const navItems = computed<NavItem[]>(() => {
  return [
    { key: 'scout', label: t('bottom_nav.scout'), icon: 'sports_score' },
    { key: 'pit', label: t('bottom_nav.pit'), icon: 'storefront' },
    { key: 'schedule', label: t('bottom_nav.schedule'), icon: 'calendar_month' },
    { key: 'rankings', label: t('bottom_nav.rankings'), icon: 'leaderboard' },
    fifthItem.value
  ]
})

// Secondary Tabs (in More sheet)
const moreItems = computed<NavItem[]>(() => {
  const items: NavItem[] = [
    { key: 'history', label: t('bottom_nav.history'), icon: 'history' },
    { key: 'ai', label: t('bottom_nav.ai'), icon: 'smart_toy' }
  ]
  if (eventStore.isHost) {
    items.push({ key: 'scouts', label: t('bottom_nav.scouts'), icon: 'groups' })
  }
  return items
})

const isFifthActive = computed(() => {
  return ['history', 'ai', 'scouts'].includes(props.activeTab)
})

function handleSelect(key: EventTab | 'more') {
  hapticLight()
  if (key === 'more') {
    showMoreSheet.value = !showMoreSheet.value
    return
  }
  // If clicking on the active 5th tab item, toggle the more sheet so user can switch among sub-tabs
  if (key === fifthItem.value.key && isFifthActive.value) {
    showMoreSheet.value = !showMoreSheet.value
    return
  }
  showMoreSheet.value = false
  emit('update:activeTab', key as EventTab)
}

function handleSelectMore(key: EventTab) {
  hapticLight()
  showMoreSheet.value = false
  emit('update:activeTab', key)
}
</script>

<template>
  <Teleport to="body">
    <!-- More Actions Sheet Backdrop -->
    <Transition name="sheet-fade">
      <div
        v-if="showMoreSheet"
        class="more-sheet-backdrop"
        @click="showMoreSheet = false"
      />
    </Transition>

    <!-- More Actions Bottom Sheet -->
    <Transition name="sheet-slide">
      <div v-if="showMoreSheet" class="more-sheet" role="dialog" aria-modal="true">
        <div class="sheet-header">
          <div class="sheet-handle"></div>
          <span class="sheet-title">{{ t('bottom_nav.more') }}</span>
        </div>
        <div class="sheet-grid">
          <button
            v-for="item in moreItems"
            :key="item.key"
            class="sheet-item-btn"
            :class="{ 'is-active': activeTab === item.key }"
            @click="handleSelectMore(item.key as EventTab)"
          >
            <span class="material-icons sheet-icon">{{ item.icon }}</span>
            <span class="sheet-label">{{ item.label }}</span>
          </button>
        </div>
      </div>
    </Transition>

    <!-- Bottom Navigation Bar -->
    <nav class="mobile-bottom-nav" aria-label="Mobile Navigation">
      <div class="mobile-bottom-nav-inner">
        <button
          v-for="(item, idx) in navItems"
          :key="item.key + '-' + idx"
          class="nav-item-btn"
          :class="{
            'is-active': idx === 4 ? isFifthActive : activeTab === item.key,
            'is-more-opened': idx === 4 && showMoreSheet
          }"
          @click="handleSelect(item.key)"
        >
          <div class="nav-icon-wrap">
            <span class="material-icons nav-icon">{{ item.icon }}</span>
            <span v-if="(idx === 4 ? isFifthActive : activeTab === item.key) && !showMoreSheet" class="nav-active-dot"></span>
          </div>
          <span class="nav-label">{{ item.label }}</span>
        </button>
      </div>
    </nav>
  </Teleport>
</template>

<style scoped>
.mobile-bottom-nav {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: calc(56px + var(--sab, env(safe-area-inset-bottom, 0px)));
  padding-bottom: var(--sab, env(safe-area-inset-bottom, 0px));
  box-sizing: border-box;
  background: rgba(18, 18, 22, 0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  z-index: 850;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.45);
  user-select: none;
}

@media (max-width: 680px) {
  .mobile-bottom-nav {
    display: block;
  }
}

.mobile-bottom-nav-inner {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-around;
  width: 100%;
}

.nav-item-btn {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  background: transparent;
  border: none;
  color: var(--muted-foreground, #888888);
  cursor: pointer;
  padding: 4px 0;
  transition: color 0.15s ease, transform 0.1s ease;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  min-height: 44px;
}

.nav-item-btn:active {
  transform: scale(0.92);
}

.nav-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.nav-active-dot {
  position: absolute;
  bottom: -3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--primary, #39ff14);
  box-shadow: 0 0 6px rgba(57, 255, 20, 0.8);
  animation: dot-pop 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

@keyframes dot-pop {
  from {
    opacity: 0;
    transform: scale(0);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.nav-item-btn.is-active {
  color: var(--primary, #39ff14);
  font-weight: 600;
  text-shadow: 0 0 10px rgba(57, 255, 20, 0.45);
}

.nav-item-btn.is-active .nav-icon {
  animation: nav-pop 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

@keyframes nav-pop {
  0% {
    transform: scale(0.92);
  }
  40% {
    transform: scale(1.22);
  }
  100% {
    transform: scale(1);
  }
}

.nav-item-btn.is-more-opened {
  color: var(--primary, #39ff14);
}

.nav-icon {
  font-size: 22px;
}

.nav-label {
  font-size: 11px;
  line-height: 1;
}

/* More Sheet Backdrop */
.more-sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: 840;
}

/* More Actions Bottom Sheet */
.more-sheet {
  position: fixed;
  bottom: calc(56px + var(--sab, env(safe-area-inset-bottom, 0px)));
  left: 0;
  right: 0;
  margin: 0 auto;
  max-width: 540px;
  background: rgba(24, 24, 28, 0.98);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-bottom: none;
  padding: 12px 16px 20px;
  box-sizing: border-box;
  z-index: 845;
  box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.6);
}

.sheet-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.sheet-handle {
  width: 36px;
  height: 4px;
  background: rgba(255, 255, 255, 0.25);
  border-radius: 2px;
}

.sheet-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--muted-foreground, #888888);
  letter-spacing: 0.5px;
}

.sheet-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.sheet-item-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 14px 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  color: var(--foreground, #ffffff);
  cursor: pointer;
  transition: all 0.2s ease;
  min-height: 48px;
  -webkit-tap-highlight-color: transparent;
}

.sheet-item-btn:active {
  transform: scale(0.95);
  background: rgba(255, 255, 255, 0.08);
}

.sheet-item-btn.is-active {
  background: rgba(57, 255, 20, 0.12);
  border-color: var(--primary, #39ff14);
  color: var(--primary, #39ff14);
  box-shadow: 0 0 12px rgba(57, 255, 20, 0.25);
}

.sheet-icon {
  font-size: 24px;
}

.sheet-label {
  font-size: 12px;
  font-weight: 500;
  text-align: center;
}

/* Animations */
.sheet-fade-enter-active,
.sheet-fade-leave-active {
  transition: opacity 0.2s ease;
}
.sheet-fade-enter-from,
.sheet-fade-leave-to {
  opacity: 0;
}

.sheet-slide-enter-active {
  transition: transform 0.32s cubic-bezier(0.34, 1.25, 0.64, 1), opacity 0.25s ease;
}
.sheet-slide-leave-active {
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
}
.sheet-slide-enter-from,
.sheet-slide-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

.sheet-slide-enter-active .sheet-item-btn {
  animation: sheet-item-pop 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.sheet-slide-enter-active .sheet-item-btn:nth-child(1) { animation-delay: 0.03s; }
.sheet-slide-enter-active .sheet-item-btn:nth-child(2) { animation-delay: 0.06s; }
.sheet-slide-enter-active .sheet-item-btn:nth-child(3) { animation-delay: 0.09s; }

@keyframes sheet-item-pop {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
