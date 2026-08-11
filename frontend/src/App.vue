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
    <transition :name="isViewTransitionSupported ? 'none' : 'page'" mode="out-in">
      <component :is="Component" />
    </transition>
  </router-view>
</template>

<style>
/* Global styles are in assets/main.css */

.page-enter-active,
.page-leave-active {
  transition: opacity 0.4s cubic-bezier(0.4, 0, 0.2, 1), transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.page-enter-from {
  opacity: 0;
  transform: translateX(100px);
}

.page-leave-to {
  opacity: 0;
  transform: translateX(-100px);
}

/* View Transitions API Animations */
::view-transition-old(root),
::view-transition-new(root) {
  animation-duration: 0.4s;
  animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
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
[data-transition-type='shared']::view-transition-old(root),
[data-transition-type='shared']::view-transition-new(root) {
  animation-name: fade-out; /* Use simple fade or none to avoid visual noise */
  animation-duration: 0.2s;
}

@keyframes slide-from-right {
  from {
    transform: translateX(30px) scale(0.98);
    filter: blur(4px);
    opacity: 0;
  }
}

@keyframes slide-to-left {
  to {
    transform: translateX(-30px) scale(0.98);
    filter: blur(4px);
    opacity: 0;
  }
}

@keyframes slide-from-left {
  from {
    transform: translateX(-30px) scale(0.98);
    filter: blur(4px);
    opacity: 0;
  }
}

@keyframes slide-to-right {
  to {
    transform: translateX(30px) scale(0.98);
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
</style>
