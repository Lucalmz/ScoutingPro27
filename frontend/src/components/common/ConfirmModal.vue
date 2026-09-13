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
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(8px);
  padding: 16px;
}

.confirm-modal-card {
  width: 100%;
  max-width: 440px;
  background: var(--card, #131826);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  gap: 16px;
  animation: card-pop 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
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
  background: rgba(245, 158, 11, 0.18);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.confirm-icon-box.danger {
  background: rgba(239, 68, 68, 0.18);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.confirm-icon-box.info {
  background: rgba(56, 189, 248, 0.18);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.confirm-icon-box .material-icons {
  font-size: 24px;
}

.confirm-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--foreground, #f8fafc);
}

.confirm-body {
  font-size: 14px;
  line-height: 1.6;
  color: var(--muted-foreground, #94a3b8);
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
  transition: all 0.15s ease;
  user-select: none;
}

.confirm-btn:active {
  transform: scale(0.96);
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.08);
  color: var(--foreground, #f8fafc);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.14);
}

.btn-primary {
  background: var(--primary, #38bdf8);
  color: #000;
  font-weight: 700;
}

.btn-primary:hover {
  filter: brightness(1.1);
}

.btn-danger {
  background: #ef4444;
  color: #fff;
  font-weight: 700;
}

.btn-danger:hover {
  background: #dc2626;
}

.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.2s ease;
}

.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
</style>
