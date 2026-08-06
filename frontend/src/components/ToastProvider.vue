<script setup lang="ts">
import { useToastStore } from '@/stores/toast'

const toastStore = useToastStore()
</script>

<template>
  <div class="toast-container">
    <TransitionGroup name="toast">
      <div 
        v-for="toast in toastStore.toasts" 
        :key="toast.id"
        class="toast"
        :class="`toast-${toast.type}`"
      >
        {{ toast.message }}
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 12px;
  pointer-events: none;
}

.toast {
  background: var(--card);
  color: var(--foreground);
  padding: 12px 24px;
  border-radius: 9999px; /* pill shape */
  font-size: 14px;
  font-weight: 500;
  box-shadow: var(--glow-primary);
  backdrop-filter: blur(8px);
  text-align: center;
  min-width: 200px;
}

.toast-error {
  border-left: 4px solid var(--status-error);
  background: rgba(127, 29, 29, 0.9);
  box-shadow: 0 0 15px rgba(239, 68, 68, 0.5);
}

.toast-success {
  border-left: 4px solid var(--status-success);
}

/* Transitions */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(-20px) scale(0.9);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(-20px) scale(0.9);
}
</style>
