<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import ToastProvider from '@/components/ToastProvider.vue'
import ConfirmModal from '@/components/common/ConfirmModal.vue'
import InboxWidget from '@/components/common/InboxWidget.vue'
import { useInboxStore } from '@/stores/inbox'
import { useToastStore } from '@/stores/toast'
import { useScoutAllianceHalo } from '@/composables/useScoutAllianceHalo'

const inboxStore = useInboxStore()
const toastStore = useToastStore()
const router = useRouter()
const { scoutAllianceHalo } = useScoutAllianceHalo()

const isViewTransitionSupported = typeof document !== 'undefined' && 'startViewTransition' in document
const bootActive = ref(true)

let isUnmounted = false
let bootOverlayTimer: ReturnType<typeof setTimeout> | null = null
let splashCleanupTimer: ReturnType<typeof setTimeout> | null = null
let splashRafId: number | null = null

async function dismissWebBootSplash() {
  if (typeof document === 'undefined') return
  const splash = document.getElementById('web-boot-splash')
  if (!splash) return

  if (router && typeof router.isReady === 'function') {
    await router.isReady().catch(() => {})
  }
  if (isUnmounted) return

  const startFade = () => {
    if (isUnmounted || !splash.isConnected) return

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (prefersReducedMotion) {
      splash.remove()
      return
    }

    let cleaned = false
    const finalizeRemoval = (e?: Event) => {
      if (e && e.target !== splash) return
      if (cleaned) return
      cleaned = true
      if (splashCleanupTimer !== null) {
        clearTimeout(splashCleanupTimer)
        splashCleanupTimer = null
      }
      splash.removeEventListener('transitionend', finalizeRemoval)
      splash.remove()
    }

    splash.addEventListener('transitionend', finalizeRemoval)
    splash.classList.add('is-fading')
    splashCleanupTimer = setTimeout(finalizeRemoval, 280)
  }

  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    splashRafId = window.requestAnimationFrame(() => {
      splashRafId = null
      startFade()
    })
  } else {
    startFade()
  }
}

onMounted(() => {
  void dismissWebBootSplash()
  bootOverlayTimer = setTimeout(() => {
    bootActive.value = false
    bootOverlayTimer = null
  }, 480)
})

onBeforeUnmount(() => {
  isUnmounted = true
  if (bootOverlayTimer !== null) {
    clearTimeout(bootOverlayTimer)
    bootOverlayTimer = null
  }
  if (splashCleanupTimer !== null) {
    clearTimeout(splashCleanupTimer)
    splashCleanupTimer = null
  }
  if (splashRafId !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(splashRafId)
    splashRafId = null
  }
})

watch(() => inboxStore.messages.length, (newLen, oldLen) => {
  if (newLen > oldLen) {
    const latest = inboxStore.messages[0]
    if (latest && !latest.read) {
      toastStore.showToast(`New message: ${latest.title}`, 'info')
    }
  }
})
</script>

<template>
  <div class="ambient-halo-stage" aria-hidden="true">
    <div class="ambient-halo-layer is-default" :class="{ active: scoutAllianceHalo === 'none' }"></div>
    <div class="ambient-halo-layer is-red" :class="{ active: scoutAllianceHalo === 'red' }"></div>
    <div class="ambient-halo-layer is-blue" :class="{ active: scoutAllianceHalo === 'blue' }"></div>
  </div>
  <ToastProvider />
  <ConfirmModal />
  <!-- Minimal non-blocking boot line (no text) -->
  <div v-if="bootActive" class="tactical-boot-overlay" aria-hidden="true">
    <div class="tactical-boot-scanline"></div>
  </div>
  <div class="router-view-container">
    <router-view v-slot="{ Component, route }">
      <transition 
        :name="isViewTransitionSupported ? 'none' : 'page'" 
        :css="!isViewTransitionSupported"
        :mode="isViewTransitionSupported ? undefined : 'out-in'">
        <component :is="Component" :key="(route.name === 'event' || route.name === 'team-detail') ? 'event-view' : route.path" />
      </transition>
    </router-view>
  </div>
  <Teleport to="body">
    <InboxWidget />
  </Teleport>
</template>

<style>
/* Global styles are in assets/main.css */

.page-enter-active,
.page-leave-active {
  transition: opacity var(--motion-duration-page) var(--motion-ease-page),
              transform var(--motion-duration-page) var(--motion-ease-page);
}

.page-enter-from {
  opacity: 0;
  transform: translateX(80px);
}

.page-leave-to {
  opacity: 0;
  transform: translateX(-80px);
}

:root {
  view-transition-name: none;
}

.router-view-container {
  view-transition-name: page-view;
  min-height: 100vh;
  width: 100%;
}

/* InboxWidget: captured by View Transitions but stays completely static and single-layered (zero glow-doubling) */
::view-transition-group(inbox-widget) {
  animation: none !important;
  z-index: 99999;
}
::view-transition-old(inbox-widget) {
  display: none !important;
}
::view-transition-new(inbox-widget) {
  animation: none !important;
  opacity: 1 !important;
  mix-blend-mode: normal !important;
}

/* View Transitions API Animations */
::view-transition-group(*),
::view-transition-old(*),
::view-transition-new(*) {
  animation-duration: var(--motion-duration-page);
  animation-timing-function: var(--motion-ease-page);
}

[data-direction='forward']::view-transition-new(page-view) {
  animation-name: slide-from-right;
}
[data-direction='forward']::view-transition-old(page-view) {
  animation-name: slide-to-left;
}
[data-direction='back']::view-transition-new(page-view) {
  animation-name: slide-from-left;
}
[data-direction='back']::view-transition-old(page-view) {
  animation-name: slide-to-right;
}
[data-direction='fade']::view-transition-old(page-view) {
  animation-name: fade-out;
}
[data-direction='fade']::view-transition-new(page-view) {
  animation-name: fade-in;
}

/* If a shared element is transitioning, tone down the page-view transition */
[data-transition-type='shared']::view-transition-old(page-view) {
  animation-name: fade-out;
  animation-duration: var(--motion-duration-shared);
}
[data-transition-type='shared']::view-transition-new(page-view) {
  animation-name: fade-in;
  animation-duration: var(--motion-duration-shared);
}

@keyframes slide-from-right {
  from {
    transform: translateX(48px) scale(0.98);
    opacity: 0;
  }
}

@keyframes slide-to-left {
  to {
    transform: translateX(-48px) scale(0.98);
    opacity: 0;
  }
}

@keyframes slide-from-left {
  from {
    transform: translateX(-48px) scale(0.98);
    opacity: 0;
  }
}

@keyframes slide-to-right {
  to {
    transform: translateX(48px) scale(0.98);
    opacity: 0;
  }
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation: none !important;
  }
}

/* EventView Staggered Entrance and Exit (Native View Transitions - 核心保留并调优) */
::view-transition-new(event-topbar),
::view-transition-new(event-tabs),
::view-transition-new(event-content),
::view-transition-new(event-status),
::view-transition-old(event-topbar),
::view-transition-old(event-tabs),
::view-transition-old(event-content),
::view-transition-old(event-status) {
  animation-duration: var(--motion-duration-page);
  animation-timing-function: var(--motion-ease-page);
  animation-fill-mode: both;
}

::view-transition-group(event-card-title) {
  z-index: 9999;
  animation-duration: var(--motion-duration-shared);
  animation-timing-function: var(--motion-ease-page);
}

/* The title snapshot keeps its aspect ratio, stays anchored to the text's left edge,
   and cross-fades on the exact same duration/easing as the group travel so the two
   text boxes always line up smoothly in both directions. */
::view-transition-old(event-card-title),
::view-transition-new(event-card-title) {
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: left center;
  overflow: clip;
  mix-blend-mode: plus-lighter;
  animation-duration: var(--motion-duration-shared);
  animation-timing-function: var(--motion-ease-page);
}

/* Prevent router container, Inbox FAB, and EventView sections from participating in or overlapping
   user-profile modal transitions. */
html[data-transition-type='user-profile'] .router-view-container,
html[data-transition-type='user-profile'] .inbox-widget,
html[data-transition-type='user-profile'] .event-view .topbar,
html[data-transition-type='user-profile'] .event-view .event-name,
html[data-transition-type='user-profile'] .event-view .topbar-right,
html[data-transition-type='user-profile'] .event-view .tab-bar,
html[data-transition-type='user-profile'] .event-view .tab-content {
  view-transition-name: none !important;
}

[data-direction='forward']::view-transition-new(event-topbar) {
  animation-name: slide-down-fade-in;
  animation-delay: var(--motion-page-stagger);
}
[data-direction='forward']::view-transition-new(event-status) {
  animation-name: slide-from-left-fade-in;
  animation-delay: calc(var(--motion-page-stagger) * 2);
}
[data-direction='forward']::view-transition-new(event-tabs) {
  animation-name: slide-from-right-fade-in;
  animation-delay: calc(var(--motion-page-stagger) * 3);
}
[data-direction='forward']::view-transition-new(event-content) {
  animation-name: slide-up-fade-in;
  animation-delay: calc(var(--motion-page-stagger) * 4);
}

[data-direction='back']::view-transition-old(event-topbar) {
  animation-name: slide-up-fade-out;
  animation-delay: 0ms;
}
[data-direction='back']::view-transition-old(event-status) {
  animation-name: slide-to-left-fade-out;
  animation-delay: var(--motion-page-stagger);
}
[data-direction='back']::view-transition-old(event-tabs) {
  animation-name: slide-to-right-fade-out;
  animation-delay: calc(var(--motion-page-stagger) * 2);
}
[data-direction='back']::view-transition-old(event-content) {
  animation-name: slide-down-fade-out;
  animation-delay: calc(var(--motion-page-stagger) * 3);
}

@keyframes slide-down-fade-in {
  from {
    transform: translateY(-32px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes slide-up-fade-in {
  from {
    transform: translateY(32px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes slide-from-left-fade-in {
  from {
    transform: translateX(-40px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes slide-from-right-fade-in {
  from {
    transform: translateX(40px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes slide-up-fade-out {
  from {
    transform: translateY(0);
    opacity: 1;
  }
  to {
    transform: translateY(-32px);
    opacity: 0;
  }
}

@keyframes slide-down-fade-out {
  from {
    transform: translateY(0);
    opacity: 1;
  }
  to {
    transform: translateY(32px);
    opacity: 0;
  }
}

@keyframes slide-to-left-fade-out {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(-40px);
    opacity: 0;
  }
}

@keyframes slide-to-right-fade-out {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(40px);
    opacity: 0;
  }
}

/* ----------------------------------------------------
   Tab Switching View Transitions (精致从上至下滑刷入)
   ---------------------------------------------------- */
[data-transition-type='tab-switch']::view-transition-group(page-view) {
  animation: none !important;
}
[data-transition-type='tab-switch']::view-transition-old(page-view),
[data-transition-type='tab-switch']::view-transition-new(page-view) {
  animation: none !important;
}

[data-transition-type='tab-switch']::view-transition-old(event-content) {
  animation: tab-brush-out var(--motion-duration-fast) var(--motion-ease-out) both;
}

[data-transition-type='tab-switch']::view-transition-new(event-content) {
  animation: tab-brush-in var(--motion-duration-moderate) var(--motion-ease-out) both;
}

@keyframes tab-brush-out {
  from {
    transform: translateY(0);
    opacity: 1;
  }
  to {
    transform: translateY(16px);
    opacity: 0;
  }
}

@keyframes tab-brush-in {
  from {
    transform: translateY(-24px) scale(0.995);
    opacity: 0;
  }
  to {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}

/* ==============================================================
   Minimal boot line (non-blocking, no text)
   ============================================================== */
.tactical-boot-overlay {
  position: fixed;
  inset: 0;
  z-index: 99990;
  pointer-events: none;
  overflow: hidden;
  animation: boot-overlay-fade var(--motion-duration-slow) var(--motion-ease-out) forwards;
}

.tactical-boot-scanline {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--primary) 40%, transparent) 50%, transparent 100%);
  animation: tactical-scanline-sweep var(--motion-duration-slow) var(--motion-ease-out) forwards;
}

@keyframes boot-overlay-fade {
  0% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}
</style>
