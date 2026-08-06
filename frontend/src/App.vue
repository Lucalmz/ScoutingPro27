<script setup lang="ts">
import ToastProvider from '@/components/ToastProvider.vue'
</script>

<template>
  <ToastProvider />
  <router-view v-slot="{ Component }">
    <transition name="page" mode="out-in">
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
</style>
