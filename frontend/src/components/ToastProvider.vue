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
  border-radius: 9999px; /* pill shape */
  font-size: 13.5px;
  font-weight: 600;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  white-space: nowrap;
  box-sizing: border-box;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
  transition: all 0.2s ease;
}

.toast-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.toast-message {
  color: #f1f5f9;
  letter-spacing: 0.02em;
}

.toast-detail-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 9999px;
  font-size: 12px;
  font-weight: 700;
  font-family: 'Orbitron', 'Manrope', monospace;
  letter-spacing: 0.04em;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
}

/* Success: Cyberpunk Fluorescent Green */
.toast-success {
  background: rgba(8, 24, 12, 0.94);
  border: 1px solid var(--primary, #39ff14);
  box-shadow: 0 0 16px rgba(57, 255, 20, 0.4), 0 4px 16px rgba(0, 0, 0, 0.6);
}
.toast-success .toast-icon {
  color: var(--primary, #39ff14);
}
.toast-success .toast-detail-badge {
  color: var(--primary, #39ff14);
  background: rgba(57, 255, 20, 0.15);
  border-color: rgba(57, 255, 20, 0.35);
}

/* Warning: Tactical Amber */
.toast-warning {
  background: rgba(28, 18, 6, 0.94);
  border: 1px solid #f59e0b;
  box-shadow: 0 0 16px rgba(245, 158, 11, 0.4), 0 4px 16px rgba(0, 0, 0, 0.6);
}
.toast-warning .toast-icon {
  color: #f59e0b;
}
.toast-warning .toast-detail-badge {
  color: #fbbf24;
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.35);
}

/* Error: Neon Red */
.toast-error {
  background: rgba(30, 8, 8, 0.94);
  border: 1px solid var(--destructive, #ef4444);
  box-shadow: 0 0 16px rgba(239, 68, 68, 0.4), 0 4px 16px rgba(0, 0, 0, 0.6);
}
.toast-error .toast-icon {
  color: var(--destructive, #ef4444);
}
.toast-error .toast-detail-badge {
  color: #fca5a5;
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.35);
}

/* Info: Neon Cyan / Blue */
.toast-info {
  background: rgba(8, 20, 32, 0.94);
  border: 1px solid #38bdf8;
  box-shadow: 0 0 16px rgba(56, 189, 248, 0.35), 0 4px 16px rgba(0, 0, 0, 0.6);
}
.toast-info .toast-icon {
  color: #38bdf8;
}
.toast-info .toast-detail-badge {
  color: #7dd3fc;
  background: rgba(56, 189, 248, 0.15);
  border-color: rgba(56, 189, 248, 0.35);
}

/* Transitions */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
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
