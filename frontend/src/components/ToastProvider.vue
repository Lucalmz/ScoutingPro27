<script setup lang="ts">
import { useToastStore, type Toast } from '@/stores/toast'

const toastStore = useToastStore()

function resolveIcon(toast: Toast): string {
  if (toast.icon) return toast.icon
  switch (toast.type) {
    case 'success':
      return 'check_circle'
    case 'warning':
      return 'warning'
    case 'error':
      return 'error_outline'
    case 'info':
    default:
      return 'info'
  }
}
</script>

<template>
  <div class="toast-container" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toastStore.toasts"
        :key="toast.id"
        class="toast-pill"
        :class="`toast-${toast.type}`"
      >
        <span class="material-icons toast-icon">{{ resolveIcon(toast) }}</span>
        <span class="toast-message">{{ toast.message }}</span>
        <span v-if="toast.detail" class="toast-detail-badge">
          {{ toast.detail }}
        </span>
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
  z-index: 10000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  pointer-events: none;
  max-width: 90vw;
}

.toast-pill {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 18px;
  border-radius: 10px;
  background: var(--popover);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-2);
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  box-sizing: border-box;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
  transition: transform var(--motion-duration-fast) var(--motion-ease-out),
              opacity var(--motion-duration-fast) var(--motion-ease-out);
}

.toast-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.toast-message {
  color: var(--foreground);
  letter-spacing: 0.02em;
}

.toast-detail-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 9999px;
  font-size: 12px;
  font-weight: 700;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  background: var(--g-750);
  border: 1px solid var(--border-strong);
}

/* Success: Pit Wall Signal Green */
.toast-success {
  border-left: 3px solid var(--status-success);
}
.toast-success .toast-icon {
  color: var(--status-success);
}
.toast-success .toast-detail-badge {
  color: var(--s-200);
  background: var(--status-success-bg);
  border-color: var(--status-success-border);
}

/* Warning: Pit Wall Amber */
.toast-warning {
  border-left: 3px solid var(--status-warning);
}
.toast-warning .toast-icon {
  color: var(--status-warning);
}
.toast-warning .toast-detail-badge {
  color: var(--status-warning);
  background: var(--status-warning-bg);
  border-color: var(--status-warning-border);
}

/* Error: Pit Wall Crimson */
.toast-error {
  border-left: 3px solid var(--status-error);
}
.toast-error .toast-icon {
  color: var(--status-error);
}
.toast-error .toast-detail-badge {
  color: var(--status-error);
  background: var(--status-error-bg);
  border-color: var(--status-error-border);
}

/* Info: Pit Wall Telemetry Cyan */
.toast-info {
  border-left: 3px solid var(--status-info);
}
.toast-info .toast-icon {
  color: var(--status-info);
}
.toast-info .toast-detail-badge {
  color: var(--status-info);
  background: var(--status-info-bg);
  border-color: var(--status-info-border);
}

/* Transitions */
.toast-enter-active,
.toast-leave-active {
  transition: all var(--motion-duration-moderate) var(--motion-ease-out);
}
.toast-leave-active {
  position: absolute;
}
.toast-move {
  transition: transform var(--motion-duration-moderate) var(--motion-ease-out);
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(-24px) scale(0.92);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(-16px) scale(0.92);
}
</style>
