<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useConfirm } from '@/composables/useConfirm'
import { useI18n } from 'vue-i18n'

const { confirmState, handleConfirm, handleCancel } = useConfirm()

let t = (key: string) => {
  if (key === 'confirm_dialog.title') return '操作确认'
  if (key === 'confirm_dialog.cancel') return '取消'
  if (key === 'confirm_dialog.confirm') return '确定'
  if (key === 'confirm_dialog.danger_confirm') return '确认丢弃/清空'
  return key
}

try {
  const i18n = useI18n()
  t = i18n.t
} catch {
  // Fallback for tests where App.vue is mounted without i18n plugin
}

function onKeyDown(e: KeyboardEvent) {
  if (!confirmState.value?.isOpen) return
  if (e.key === 'Escape') {
    handleCancel()
  } else if (e.key === 'Enter') {
    handleConfirm()
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown)
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onKeyDown)
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="confirm-fade">
      <div
        v-if="confirmState?.isOpen"
        class="confirm-modal-overlay"
        @click.self="handleCancel"
      >
        <div
          class="confirm-modal-card"
          :class="confirmState.type || 'warning'"
          role="alertdialog"
          aria-modal="true"
        >
          <div class="confirm-header">
            <div class="confirm-icon-box" :class="confirmState.type || 'warning'">
              <span class="material-icons">
                {{ confirmState.type === 'danger' ? 'error' : confirmState.type === 'info' ? 'info' : 'warning' }}
              </span>
            </div>
            <h3 class="confirm-title">
              {{ confirmState.title || t('confirm_dialog.title') }}
            </h3>
          </div>

          <div class="confirm-body">
            <p class="confirm-message">{{ confirmState.message }}</p>
          </div>

          <div class="confirm-actions">
            <button
              type="button"
              class="confirm-btn btn-secondary"
              @click="handleCancel"
            >
              {{ confirmState.cancelText || t('confirm_dialog.cancel') }}
            </button>
            <button
              type="button"
              class="confirm-btn"
              :class="confirmState.type === 'danger' ? 'btn-danger' : 'btn-primary'"
              @click="handleConfirm"
            >
              {{ confirmState.confirmText || (confirmState.type === 'danger' ? t('confirm_dialog.danger_confirm') : t('confirm_dialog.confirm')) }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.confirm-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--g-950) 82%, transparent);
  padding: 16px;
}

.confirm-modal-card {
  width: 100%;
  max-width: 440px;
  background: var(--card);
  border: 1px solid var(--border);
  border-top: 3px solid var(--status-warning);
  border-radius: 14px;
  padding: 24px;
  box-shadow: var(--shadow-3);
  display: flex;
  flex-direction: column;
  gap: 16px;
  animation: card-pop var(--motion-duration-moderate) var(--motion-ease-out);
}

.confirm-modal-card.danger {
  border-top-color: var(--status-error);
}

.confirm-modal-card.info {
  border-top-color: var(--status-info);
}

@keyframes card-pop {
  from {
    opacity: 0;
    transform: scale(0.92) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 14px;
}

.confirm-icon-box {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.confirm-icon-box.warning {
  background: var(--status-warning-bg);
  color: var(--status-warning);
  border: 1px solid var(--status-warning-border);
}

.confirm-icon-box.danger {
  background: var(--status-error-bg);
  color: var(--status-error);
  border: 1px solid var(--status-error-border);
}

.confirm-icon-box.info {
  background: var(--status-info-bg);
  color: var(--status-info);
  border: 1px solid var(--status-info-border);
}

.confirm-icon-box .material-icons {
  font-size: 24px;
}

.confirm-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--foreground);
}

.confirm-body {
  font-size: 14px;
  line-height: 1.6;
  color: var(--muted-foreground);
}

.confirm-message {
  margin: 0;
  word-break: break-word;
}

.confirm-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 8px;
}

.confirm-btn {
  min-height: 42px;
  padding: 8px 18px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out),
              transform var(--motion-duration-fast) var(--motion-ease-out),
              opacity var(--motion-duration-fast) var(--motion-ease-out);
  user-select: none;
}

.confirm-btn:active {
  transform: scale(0.96);
}

.btn-secondary {
  background: var(--surface-elevated);
  color: var(--foreground);
  border: 1px solid var(--border);
}

.btn-secondary:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.btn-primary {
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 700;
}

.btn-primary:hover {
  background: var(--s-300);
}

.btn-danger {
  background: var(--status-error);
  color: var(--destructive-foreground);
  font-weight: 700;
}

.btn-danger:hover {
  background: color-mix(in srgb, var(--status-error) 85%, var(--g-950));
}

.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity var(--motion-duration-fast) var(--motion-ease-out);
}

.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
</style>
