<script setup lang="ts">
import { watch } from 'vue'
import ToastProvider from '@/components/ToastProvider.vue'
import InboxWidget from '@/components/common/InboxWidget.vue'
import { useInboxStore } from '@/stores/inbox'
import { useToastStore } from '@/stores/toast'

const inboxStore = useInboxStore()
const toastStore = useToastStore()

const isViewTransitionSupported = 'startViewTransition' in document

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
  <ToastProvider />
  <div class="router-view-container">
    <router-view v-slot="{ Component }">
      <transition 
        :name="isViewTransitionSupported ? 'none' : 'page'" 
        :css="!isViewTransitionSupported"
        :mode="isViewTransitionSupported ? undefined : 'out-in'">
        <component :is="Component" />
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
  transition: opacity 0.85s cubic-bezier(0.25, 1, 0.5, 1), transform 0.85s cubic-bezier(0.25, 1, 0.5, 1);
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
  animation-duration: var(--motion-duration-slow);
  animation-timing-function: var(--motion-ease-out);
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
  animation-duration: var(--motion-duration-normal);
}
[data-transition-type='shared']::view-transition-new(page-view) {
  animation-name: fade-in;
  animation-duration: var(--motion-duration-normal);
}

@keyframes slide-from-right {
  from {
    transform: translateX(48px) scale(0.98);
    filter: blur(2px);
    opacity: 0;
  }
}

@keyframes slide-to-left {
  to {
    transform: translateX(-48px) scale(0.98);
    filter: blur(2px);
    opacity: 0;
  }
}

@keyframes slide-from-left {
  from {
    transform: translateX(-48px) scale(0.98);
    filter: blur(2px);
    opacity: 0;
  }
}

@keyframes slide-to-right {
  to {
    transform: translateX(48px) scale(0.98);
    filter: blur(2px);
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
  animation-duration: var(--motion-duration-slow);
  animation-timing-function: var(--motion-ease-out);
  animation-fill-mode: both;
}

::view-transition-group(event-card-title) {
  z-index: 9999;
  animation-duration: var(--motion-duration-slow);
  animation-timing-function: var(--motion-ease-out);
}

[data-direction='forward']::view-transition-new(event-topbar) {
  animation-name: slide-down-fade-in;
  animation-delay: 0.136s;
}
[data-direction='forward']::view-transition-new(event-status) {
  animation-name: slide-from-left-fade-in;
  animation-delay: 0.238s;
}
[data-direction='forward']::view-transition-new(event-tabs) {
  animation-name: slide-from-right-fade-in;
  animation-delay: 0.34s;
}
[data-direction='forward']::view-transition-new(event-content) {
  animation-name: slide-up-fade-in;
  animation-delay: 0.442s;
}

[data-direction='back']::view-transition-old(event-topbar) {
  animation-name: slide-up-fade-out;
  animation-delay: 0s;
}
[data-direction='back']::view-transition-old(event-status) {
  animation-name: slide-to-left-fade-out;
  animation-delay: 0.102s;
}
[data-direction='back']::view-transition-old(event-tabs) {
  animation-name: slide-to-right-fade-out;
  animation-delay: 0.204s;
}
[data-direction='back']::view-transition-old(event-content) {
  animation-name: slide-down-fade-out;
  animation-delay: 0.306s;
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
   Team Detail: iOS Modal Sheet Transition
   ============================================================== */

/* Ensure the modal layers correctly: Detail View is ALWAYS on top */
[data-to-type='team-detail']::view-transition-new(modal-sheet),
[data-from-type='team-detail']::view-transition-old(modal-sheet) {
  z-index: 2;
  mix-blend-mode: normal;
}

[data-to-type='team-detail']::view-transition-old(page-view),
[data-from-type='team-detail']::view-transition-new(page-view) {
  z-index: 1;
  mix-blend-mode: normal;
  background: black;
}

/* Hide the page-view of the new page when entering (we only want the modal-sheet to animate) */
[data-to-type='team-detail']::view-transition-new(page-view) {
  animation: none !important;
  opacity: 0 !important;
}

/* Hide the page-view of the old page when leaving */
[data-from-type='team-detail']::view-transition-old(page-view) {
  animation: none !important;
  opacity: 0 !important;
}

/* Entering TeamDetailView */
[data-to-type='team-detail']::view-transition-new(modal-sheet) {
  animation: modal-slide-up 0.765s var(--motion-ease-out) both;
}
[data-to-type='team-detail']::view-transition-old(page-view) {
  animation: modal-push-back 0.765s var(--motion-ease-out) both;
}

/* Leaving TeamDetailView */
[data-from-type='team-detail']::view-transition-old(modal-sheet) {
  animation: modal-slide-down 0.765s var(--motion-ease-out) both;
}
[data-from-type='team-detail']::view-transition-new(page-view) {
  animation: modal-pull-forward 0.765s var(--motion-ease-out) both;
}

@keyframes modal-slide-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

@keyframes modal-slide-down {
  from { transform: translateY(0); }
  to { transform: translateY(100%); }
}

@keyframes modal-push-back {
  from { transform: scale(1); filter: brightness(1); border-radius: 0; }
  to { transform: scale(0.94); filter: brightness(0.65); border-radius: 16px; }
}

@keyframes modal-pull-forward {
  from { transform: scale(0.94); filter: brightness(0.65); border-radius: 16px; }
  to { transform: scale(1); filter: brightness(1); border-radius: 0; }
}
</style>
