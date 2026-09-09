<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useUserStore } from '@/stores/user'
import { useToastStore } from '@/stores/toast'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'merged', targetName: string, meta?: { oldId?: string, newId?: string }): void
}>()

const { t } = useI18n()
const userStore = useUserStore()
const toastStore = useToastStore()

const targetUsername = ref('')
const targetPassword = ref('')
const merging = ref(false)
const errorMsg = ref<string | null>(null)

watch(() => props.visible, (val) => {
  if (val) {
    targetUsername.value = ''
    targetPassword.value = ''
    errorMsg.value = null
    merging.value = false
  }
}, { immediate: true })

function handleClose() {
  if (merging.value) return
  emit('update:visible', false)
}

function onGlobalKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.visible) {
    handleClose()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeyDown)
})

async function handleMerge() {
  const trimmedName = targetUsername.value.trim()
  const pwd = targetPassword.value
  errorMsg.value = null

  if (!trimmedName) {
    errorMsg.value = t('user.enter_target_username')
    return
  }
  if (!pwd) {
    errorMsg.value = t('user.enter_target_password')
    return
  }

  if (trimmedName.toLowerCase() === userStore.username.toLowerCase()) {
    errorMsg.value = t('user.merge_into_self')
    return
  }

  merging.value = true
  try {
    const res = await userStore.mergeAccount(trimmedName, pwd)
    if (res.success) {
      emit('merged', res.newUsername, { oldId: res.oldId, newId: res.newId })
      emit('update:visible', false)
    } else {
      let msg = res.error || t('user.merge_failed')
      if (msg.includes('Invalid target account password')) {
        msg = t('user.invalid_target_password')
      } else if (msg.includes('Target user not found')) {
        msg = t('user.target_user_not_found')
      } else if (msg.includes('Cannot merge user into itself')) {
        msg = t('user.merge_into_self')
      }
      errorMsg.value = msg
    }
  } catch (e: any) {
    let msg = e?.message || t('user.merge_failed')
    if (msg.includes('Invalid target account password')) {
      msg = t('user.invalid_target_password')
    } else if (msg.includes('Target user not found')) {
      msg = t('user.target_user_not_found')
    } else if (msg.includes('Cannot merge user into itself')) {
      msg = t('user.merge_into_self')
    } else {
      msg = t('user.merge_exception') + msg
    }
    errorMsg.value = msg
  } finally {
    merging.value = false
  }
}
</script>

<template>
  <Transition name="fade">
    <div v-if="visible" class="modal-overlay" @click.self="handleClose">
      <div class="modal-card" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div class="header-icon-wrap">
            <span class="material-icons merge-icon">merge_type</span>
          </div>
          <div>
            <h3 class="modal-title">{{ t('user.merge_account_title') }}</h3>
            <p class="modal-subtitle">
              {{ t('user.merge_account_desc', { username: userStore.username }) }}
            </p>
          </div>
          <button type="button" class="btn-close" :disabled="merging" @click="handleClose" :aria-label="t('user.btn_cancel')">
            <span class="material-icons">close</span>
          </button>
        </div>

        <form class="modal-body" @submit.prevent="handleMerge">
          <div v-if="errorMsg" class="error-banner">
            <span class="material-icons">error_outline</span>
            <span>{{ errorMsg }}</span>
          </div>

          <div class="form-group">
            <label class="form-label" for="target-username">{{ t('user.target_username_label') }}</label>
            <input
              id="target-username"
              v-model="targetUsername"
              type="text"
              class="form-input"
              :placeholder="t('user.target_username_placeholder')"
              autocomplete="username"
              :disabled="merging"
              required
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="target-password">{{ t('user.target_password_label') }}</label>
            <input
              id="target-password"
              v-model="targetPassword"
              type="password"
              class="form-input"
              :placeholder="t('user.target_password_placeholder')"
              autocomplete="current-password"
              :disabled="merging"
              required
            />
            <span class="form-hint">{{ t('user.target_password_hint') }}</span>
          </div>

          <div class="modal-actions">
            <button
              type="button"
              class="btn btn-secondary"
              :disabled="merging"
              @click="handleClose"
            >
              {{ t('user.btn_cancel') }}
            </button>
            <button
              type="submit"
              class="btn btn-primary"
              :disabled="merging || !targetUsername.trim() || !targetPassword"
            >
              <span v-if="merging" class="spinner-small"></span>
              <span>{{ merging ? t('user.btn_merging') : t('user.btn_confirm_merge') }}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 1rem;
}

.modal-card {
  background: var(--card, #121212);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 16px;
  max-width: 480px;
  width: 100%;
  padding: 1.5rem;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.8), 0 0 24px rgba(57, 255, 20, 0.08);
  color: var(--foreground, #f1f5f9);
  max-height: 90vh;
  overflow-y: auto;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  position: relative;
  margin-bottom: 1.25rem;
}

.header-icon-wrap {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: rgba(57, 255, 20, 0.12);
  border: 1px solid rgba(57, 255, 20, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.merge-icon {
  color: #39ff14;
  font-size: 24px;
}

.modal-title {
  font-size: 1.15rem;
  font-weight: 700;
  margin: 0 0 0.25rem 0;
  color: var(--foreground, #f1f5f9);
}

.modal-subtitle {
  font-size: 0.85rem;
  color: var(--muted-foreground, #94a3b8);
  margin: 0;
  line-height: 1.4;
}

.highlight-user {
  color: #39ff14;
  font-weight: 600;
}

.btn-close {
  position: absolute;
  top: 0;
  right: 0;
  background: transparent;
  border: none;
  color: var(--muted-foreground, #94a3b8);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.btn-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 1.15rem;
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #ef4444;
  padding: 0.65rem 0.85rem;
  border-radius: 8px;
  font-size: 0.85rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.form-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--foreground, #e2e8f0);
}

.form-input {
  background: var(--background, #080808);
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  padding: 0.65rem 0.85rem;
  color: #fff;
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.form-input:focus {
  border-color: #39ff14;
  box-shadow: 0 0 0 2px rgba(57, 255, 20, 0.2);
}

.form-hint {
  font-size: 0.75rem;
  color: var(--muted-foreground, #64748b);
  line-height: 1.3;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.btn {
  padding: 0.6rem 1.15rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.9rem;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid transparent;
  transition: all 0.2s;
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--border, #333);
  color: var(--foreground, #cbd5e1);
}

.btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
}

.btn-primary {
  background: #39ff14;
  color: #000;
  border-color: #39ff14;
}

.btn-primary:hover:not(:disabled) {
  background: #32e012;
  box-shadow: 0 0 14px rgba(57, 255, 20, 0.4);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinner-small {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(0, 0, 0, 0.3);
  border-top-color: #000;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Mobile responsive drawer styles */
@media (max-width: 640px) {
  .modal-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .modal-card {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    max-width: 100%;
    padding: 1.25rem 1rem env(safe-area-inset-bottom, 1rem) 1rem;
  }

  .modal-actions {
    flex-direction: column-reverse;
  }

  .btn {
    width: 100%;
    justify-content: center;
    padding: 0.75rem 1rem;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
