<script setup lang="ts">
import { watch } from 'vue'
import ToastProvider from '@/components/ToastProvider.vue'
import InboxWidget from '@/components/common/InboxWidget.vue'
import { useInboxStore } from '@/stores/inbox'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

const inboxStore = useInboxStore()
const toastStore = useToastStore()
const userStore = useUserStore()

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
  <InboxWidget v-if="userStore.isLoggedIn" />
  <router-view v-slot="{ Component }">
    <transition 
      :name="isViewTransitionSupported ? 'none' : 'page'" 
      :css="!isViewTransitionSupported"
      :mode="isViewTransitionSupported ? undefined : 'out-in'">
      <component :is="Component" />
    </transition>
  </router-view>
</template>

<style>
/* Global styles are in assets/main.css */

.page-enter-active,
.page-leave-active {
  transition: opacity 0.5s cubic-bezier(0.25, 1, 0.5, 1), transform 0.5s cubic-bezier(0.25, 1, 0.5, 1);
}

.page-enter-from {
  opacity: 0;
  transform: translateX(80px);
}

.page-leave-to {
  opacity: 0;
  transform: translateX(-80px);
}

/* View Transitions API Animations */
::view-transition-group(*),
::view-transition-old(*),
::view-transition-new(*) {
  animation-duration: 0.6s;
  animation-timing-function: cubic-bezier(0.25, 1, 0.5, 1);
}

[data-direction='forward']::view-transition-new(root) {
  animation-name: slide-from-right;
}
[data-direction='forward']::view-transition-old(root) {
  animation-name: slide-to-left;
}
[data-direction='back']::view-transition-new(root) {
  animation-name: slide-from-left;
}
[data-direction='back']::view-transition-old(root) {
  animation-name: slide-to-right;
}
[data-direction='fade']::view-transition-old(root) {
  animation-name: fade-out;
}
[data-direction='fade']::view-transition-new(root) {
  animation-name: fade-in;
}

/* If a shared element is transitioning, tone down the root transition */
[data-transition-type='shared']::view-transition-old(root) {
  animation-name: fade-out;
  animation-duration: 0.4s;
}
[data-transition-type='shared']::view-transition-new(root) {
  animation-name: fade-in;
  animation-duration: 0.4s;
}

@keyframes slide-from-right {
  from {
    transform: translateX(80px) scale(0.98);
    filter: blur(4px);
    opacity: 0;
  }
}

@keyframes slide-to-left {
  to {
    transform: translateX(-80px) scale(0.98);
    filter: blur(4px);
    opacity: 0;
  }
}

@keyframes slide-from-left {
  from {
    transform: translateX(-80px) scale(0.98);
    filter: blur(4px);
    opacity: 0;
  }
}

@keyframes slide-to-right {
  to {
    transform: translateX(80px) scale(0.98);
    filter: blur(4px);
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

/* EventView Staggered Entrance and Exit (Native View Transitions) */
::view-transition-new(event-topbar),
::view-transition-new(event-tabs),
::view-transition-new(event-content),
::view-transition-new(event-status),
::view-transition-old(event-topbar),
::view-transition-old(event-tabs),
::view-transition-old(event-content),
::view-transition-old(event-status) {
  animation-duration: 0.65s;
  animation-timing-function: cubic-bezier(0.25, 1, 0.5, 1);
  animation-fill-mode: both;
}

::view-transition-group(event-card-title) {
  z-index: 9999;
}

[data-direction='forward']::view-transition-new(event-topbar) {
  animation-name: slide-down-fade-in;
  animation-delay: 0.15s;
}
[data-direction='forward']::view-transition-new(event-status) {
  animation-name: slide-from-left-fade-in;
  animation-delay: 0.25s;
}
[data-direction='forward']::view-transition-new(event-tabs) {
  animation-name: slide-from-right-fade-in;
  animation-delay: 0.35s;
}
[data-direction='forward']::view-transition-new(event-content) {
  animation-name: slide-up-fade-in;
  animation-delay: 0.45s;
}

[data-direction='back']::view-transition-old(event-topbar) {
  animation-name: slide-up-fade-out;
  animation-delay: 0s;
}
[data-direction='back']::view-transition-old(event-status) {
  animation-name: slide-to-left-fade-out;
  animation-delay: 0.1s;
}
[data-direction='back']::view-transition-old(event-tabs) {
  animation-name: slide-to-right-fade-out;
  animation-delay: 0.2s;
}
[data-direction='back']::view-transition-old(event-content) {
  animation-name: slide-down-fade-out;
  animation-delay: 0.3s;
}

@keyframes slide-down-fade-in {
  from {
    transform: translateY(-60px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes slide-up-fade-in {
  from {
    transform: translateY(60px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes slide-from-left-fade-in {
  from {
    transform: translateX(-120px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes slide-from-right-fade-in {
  from {
    transform: translateX(120px);
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
    transform: translateY(-60px);
    opacity: 0;
  }
}

@keyframes slide-down-fade-out {
  from {
    transform: translateY(0);
    opacity: 1;
  }
  to {
    transform: translateY(60px);
    opacity: 0;
  }
}

@keyframes slide-to-left-fade-out {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(-120px);
    opacity: 0;
  }
}

@keyframes slide-to-right-fade-out {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(120px);
    opacity: 0;
  }
}

/* ----------------------------------------------------
   Tab Switching View Transitions
   ---------------------------------------------------- */
[data-transition-type='tab-switch']::view-transition-group(root) {
  animation: none !important;
}
[data-transition-type='tab-switch']::view-transition-old(root),
[data-transition-type='tab-switch']::view-transition-new(root) {
  animation: none !important;
}

[data-transition-type='tab-switch']::view-transition-old(event-content),
[data-transition-type='tab-switch']::view-transition-new(event-content) {
  animation-duration: 0.35s;
  animation-timing-function: cubic-bezier(0.25, 1, 0.5, 1);
  animation-fill-mode: both;
}

[data-transition-type='tab-switch'][data-tab-direction='slide-left']::view-transition-old(event-content) {
  animation-name: slide-to-left-fade-out;
}
[data-transition-type='tab-switch'][data-tab-direction='slide-left']::view-transition-new(event-content) {
  animation-name: slide-from-right-fade-in;
}

[data-transition-type='tab-switch'][data-tab-direction='slide-right']::view-transition-old(event-content) {
  animation-name: slide-to-right-fade-out;
}
[data-transition-type='tab-switch'][data-tab-direction='slide-right']::view-transition-new(event-content) {
  animation-name: slide-from-left-fade-in;
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

[data-to-type='team-detail']::view-transition-old(root),
[data-from-type='team-detail']::view-transition-new(root) {
  z-index: 1;
  mix-blend-mode: normal;
  background: black;
}

/* Hide the root of the new page when entering (we only want the modal-sheet to animate) */
[data-to-type='team-detail']::view-transition-new(root) {
  animation: none !important;
  opacity: 0 !important;
}

/* Hide the root of the old page when leaving */
[data-from-type='team-detail']::view-transition-old(root) {
  animation: none !important;
  opacity: 0 !important;
}

/* Entering TeamDetailView */
[data-to-type='team-detail']::view-transition-new(modal-sheet) {
  animation: modal-slide-up 0.5s cubic-bezier(0.25, 1, 0.5, 1) both;
}
[data-to-type='team-detail']::view-transition-old(root) {
  animation: modal-push-back 0.5s cubic-bezier(0.25, 1, 0.5, 1) both;
}

/* Leaving TeamDetailView */
[data-from-type='team-detail']::view-transition-old(modal-sheet) {
  animation: modal-slide-down 0.5s cubic-bezier(0.25, 1, 0.5, 1) both;
}
[data-from-type='team-detail']::view-transition-new(root) {
  animation: modal-pull-forward 0.5s cubic-bezier(0.25, 1, 0.5, 1) both;
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
  to { transform: scale(0.92); filter: brightness(0.6); border-radius: 16px; }
}

@keyframes modal-pull-forward {
  from { transform: scale(0.92); filter: brightness(0.6); border-radius: 16px; }
  to { transform: scale(1); filter: brightness(1); border-radius: 0; }
}
</style>
