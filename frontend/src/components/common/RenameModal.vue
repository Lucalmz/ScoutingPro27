<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useUserStore } from '@/stores/user'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'
import { useToastStore } from '@/stores/toast'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  visible: boolean
  eventId?: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'renamed', newName: string): void
  (e: 'openMerge'): void
}>()

const { t } = useI18n()
const userStore = useUserStore()
const connStore = useConnectionStore()
const eventStore = useEventStore()
const toastStore = useToastStore()

const newUsername = ref('')
const changePassword = ref(false)
const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')

const saving = ref(false)
const errorMsg = ref<string | null>(null)
const isTransitioning = ref(false)

watch(() => props.visible, (val) => {
  if (val) {
    newUsername.value = userStore.username
    changePassword.value = false
    oldPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    errorMsg.value = null
    saving.value = false
    isTransitioning.value = true
    setTimeout(() => {
      isTransitioning.value = false
    }, 380)
  } else {
    isTransitioning.value = false
  }
}, { immediate: true })

function handleClose() {
  if (saving.value) return
  if (typeof document !== 'undefined' && 'startViewTransition' in document) {
    isTransitioning.value = true
    document.documentElement.dataset.transitionType = 'user-profile'
    const vt = document.startViewTransition(async () => {
      emit('update:visible', false)
      await nextTick()
    })
    vt.finished.finally(() => {
      isTransitioning.value = false
      document.documentElement.removeAttribute('data-transition-type')
    })
  } else {
    emit('update:visible', false)
  }
}

function handleOpenMerge() {
  if (saving.value) return
  emit('update:visible', false)
  emit('openMerge')
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

async function handleSave() {
  const trimmedName = newUsername.value.trim()
  if (!trimmedName) {
    errorMsg.value = t('user.name_required') || '用户名不能为空'
    return
  }

  const isNameChanged = trimmedName !== userStore.username
  const isPassChanged = changePassword.value && newPassword.value.trim().length > 0

  if (!isNameChanged && !isPassChanged) {
    errorMsg.value = t('user.no_changes')
    return
  }

  if (isPassChanged) {
    if (!oldPassword.value) {
      errorMsg.value = t('user.old_password_required')
      return
    }
    if (newPassword.value !== confirmPassword.value) {
      errorMsg.value = t('user.password_mismatch')
      return
    }
  }

  saving.value = true
  errorMsg.value = null

  try {
    const res = await userStore.rename({
      newUsername: trimmedName,
      oldPassword: changePassword.value ? oldPassword.value : undefined,
      newPassword: isPassChanged ? newPassword.value : undefined
    })

    if (res.success) {
      const activeEventId = props.eventId || eventStore.currentEvent?.id
      if (activeEventId && res.oldId && res.newId) {
        connStore.rtcService?.sendIdentityMigration(activeEventId, res.oldId, res.newId, res.newUsername)
        connStore.requestSync(0, undefined, res.newId, res.newUsername)
      }
      toastStore.showToast(t('user.rename_success'), 'info')
      emit('renamed', res.newUsername)
      if (typeof document !== 'undefined' && 'startViewTransition' in document) {
        isTransitioning.value = true
        document.documentElement.dataset.transitionType = 'user-profile'
        const vt = document.startViewTransition(async () => {
          emit('update:visible', false)
          await nextTick()
        })
        vt.finished.finally(() => {
          isTransitioning.value = false
          document.documentElement.removeAttribute('data-transition-type')
        })
      } else {
        emit('update:visible', false)
      }
    } else {
      if (res.error?.includes('401') || res.error?.includes('invalid old password')) {
        errorMsg.value = t('user.old_password_incorrect')
      } else if (res.error?.includes('409') || res.error?.includes('username already taken')) {
        errorMsg.value = t('user.name_taken')
      } else {
        errorMsg.value = (t('user.rename_failed') + (res.error || '')).trim()
      }
    }
  } catch (err: any) {
    errorMsg.value = t('user.rename_failed') + (err.message || String(err))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Transition name="modal-overlay-fade">
    <div v-if="visible" class="modal-overlay" @click.self="handleClose">
      <div class="modal-card rename-modal">
        <div class="modal-header">
          <div class="header-icon">
            <span class="material-icons">badge</span>
          </div>
          <h3 class="modal-title">{{ t('user.rename_title') }}</h3>
        </div>

        <p class="modal-desc">
          {{ t('user.rename_desc') }}
        </p>

        <div v-if="errorMsg" class="alert-banner error">
          <span class="material-icons icon">error</span>
          <span>{{ errorMsg }}</span>
        </div>

        <!-- Username Field with View Transition Target -->
        <div class="form-group">
          <label class="form-label">{{ t('user.nickname_label') || '用户名 / 昵称' }}</label>
          <div class="input-wrapper" :style="{ viewTransitionName: visible ? 'user-profile-box' : 'none' }">
            <span class="material-icons field-icon">person</span>
            <input
              v-model="newUsername"
              type="text"
              class="form-input with-icon"
              :class="{ 'text-transparent': isTransitioning }"
              :placeholder="t('user.nickname_placeholder') || '请输入用户名 (1-30 个字符)'"
              maxlength="30"
              :disabled="saving"
              @keydown.enter="handleSave"
            />
            <span
              v-if="isTransitioning"
              class="input-text-morph"
              :style="{ viewTransitionName: visible ? 'user-profile-text' : 'none' }"
            >{{ newUsername }}</span>
          </div>
        </div>

        <!-- Expandable Accordion for Password Modification -->
        <div class="accordion-card" :class="{ open: changePassword }">
          <div class="accordion-header" @click="changePassword = !changePassword">
            <div class="accordion-header-left">
              <span class="material-icons lock-icon">lock</span>
              <span class="accordion-title">{{ t('user.change_password_toggle') || '修改密码' }}</span>
            </div>
            <span class="material-icons chevron-icon" :class="{ rotated: changePassword }">expand_more</span>
          </div>

          <div class="accordion-collapse-wrapper" :class="{ expanded: changePassword }">
            <div class="accordion-inner-content">
              <div class="accordion-body">
                <div class="form-group">
                  <label class="form-label">{{ t('user.old_password_label') || '原密码' }}</label>
                  <div class="input-wrapper">
                    <span class="material-icons field-icon">vpn_key</span>
                    <input
                      v-model="oldPassword"
                      type="password"
                      class="form-input with-icon"
                      :placeholder="t('user.old_password_placeholder') || '请输入原密码以验证身份'"
                      :disabled="saving"
                    />
                  </div>
                </div>

                <div class="form-group">
                  <label class="form-label">{{ t('user.new_password_label') || '新密码' }}</label>
                  <div class="input-wrapper">
                    <span class="material-icons field-icon">lock_reset</span>
                    <input
                      v-model="newPassword"
                      type="password"
                      class="form-input with-icon"
                      :placeholder="t('user.new_password_placeholder') || '请输入新密码'"
                      :disabled="saving"
                    />
                  </div>
                </div>

                <div class="form-group">
                  <label class="form-label">{{ t('user.confirm_password_label') || '确认新密码' }}</label>
                  <div class="input-wrapper">
                    <span class="material-icons field-icon">check_circle</span>
                    <input
                      v-model="confirmPassword"
                      type="password"
                      class="form-input with-icon"
                      :placeholder="t('user.confirm_password_placeholder') || '请再次输入新密码'"
                      :disabled="saving"
                      @keydown.enter="handleSave"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-footer-row">
          <button type="button" class="btn-merge-link" :disabled="saving" @click="handleOpenMerge">
            <span class="material-icons merge-icon">merge_type</span>
            <span>{{ t('user.merge_modal_title') || '合并已有账号' }}</span>
          </button>
          <div class="modal-actions">
            <button class="btn btn-secondary" :disabled="saving" @click="handleClose">
              {{ t('common.cancel') || t('user.btn_cancel') || '取消' }}
            </button>
            <button class="btn btn-primary" :disabled="saving || !newUsername.trim()" @click="handleSave">
              <span v-if="saving" class="material-icons spinning" style="font-size: 16px; margin-right: 4px;">sync</span>
              {{ saving ? (t('user.btn_saving') || '保存中...') : (t('user.btn_save') || '保存修改') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 16px;
  will-change: opacity;
  transform: translateZ(0);
}

.modal-card {
  background: var(--card, #0a0a0a);
  border: 1px solid var(--border, #262626);
  border-radius: 16px;
  max-width: 480px;
  width: 100%;
  padding: 24px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.8), 0 0 20px rgba(57, 255, 20, 0.05);
  max-height: 90vh;
  overflow-y: auto;
  box-sizing: border-box;
  will-change: transform, opacity;
  transform: translateZ(0);
}

.modal-overlay-fade-enter-active,
.modal-overlay-fade-leave-active {
  transition: opacity var(--motion-duration-normal) var(--motion-ease-out);
}

.modal-overlay-fade-enter-active .modal-card,
.modal-overlay-fade-leave-active .modal-card {
  transition: transform var(--motion-duration-normal) var(--motion-ease-out),
              opacity var(--motion-duration-normal) var(--motion-ease-out);
}

.modal-overlay-fade-enter-from,
.modal-overlay-fade-leave-to {
  opacity: 0;
}

.modal-overlay-fade-enter-from .modal-card,
.modal-overlay-fade-leave-to .modal-card {
  opacity: 0;
  transform: scale(0.95) translateY(16px);
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.header-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: rgba(57, 255, 20, 0.12);
  border: 1px solid rgba(57, 255, 20, 0.35);
  color: var(--primary, #39ff14);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--glow-primary, 0 0 10px rgba(57, 255, 20, 0.3));
}

.header-icon .material-icons {
  font-size: 24px;
}

.modal-title {
  font-family: 'Orbitron', 'ZCOOLQingKeHuangYou', sans-serif;
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--foreground, #f1f5f9);
  margin: 0;
  letter-spacing: 0.03em;
}

.modal-desc {
  font-size: 0.85rem;
  color: var(--muted-foreground, #a3a3a3);
  line-height: 1.5;
  margin-bottom: 18px;
}

.alert-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 0.85rem;
}

.alert-banner.error {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #f87171;
}

.form-group {
  margin-bottom: 14px;
}

.form-label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted-foreground, #a3a3a3);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.field-icon {
  position: absolute;
  left: 12px;
  color: var(--muted-foreground, #a3a3a3);
  font-size: 18px;
  pointer-events: none;
  z-index: 3;
}

.form-input {
  width: 100%;
  height: 42px;
  background: var(--input, #1a1a1a);
  border: 1px solid var(--border, #262626);
  border-radius: 10px;
  padding: 0 14px;
  color: var(--foreground, #f1f5f9);
  font-size: 0.95rem;
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  box-sizing: border-box;
}

.form-input.with-icon {
  padding-left: 38px;
}

.form-input.text-transparent {
  color: transparent !important;
}

.input-text-morph {
  position: absolute;
  left: 38px;
  top: 1px;
  bottom: 1px;
  height: 40px;
  display: flex;
  align-items: center;
  font-size: 0.95rem;
  font-family: inherit;
  color: var(--foreground, #f1f5f9);
  pointer-events: none;
  white-space: nowrap;
  user-select: none;
  z-index: 2;
}

.form-input:focus {
  border-color: var(--primary, #39ff14);
  box-shadow: 0 0 10px rgba(57, 255, 20, 0.3);
}

.form-input:disabled {
  opacity: 0.5;
}

/* Expandable Accordion Card Style */
.accordion-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border, #262626);
  border-radius: 12px;
  margin-bottom: 18px;
  overflow: hidden;
  transition: border-color 0.6s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.6s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.5s ease;
}

.accordion-card.open {
  border-color: rgba(57, 255, 20, 0.45);
  background: rgba(57, 255, 20, 0.02);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 12px rgba(57, 255, 20, 0.08);
}

.accordion-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.3s ease;
}

.accordion-header:hover {
  background: rgba(255, 255, 255, 0.04);
}

.accordion-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lock-icon {
  font-size: 18px;
  color: var(--primary, #39ff14);
}

.accordion-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--foreground, #f1f5f9);
}

.chevron-icon {
  font-size: 20px;
  color: var(--muted-foreground, #a3a3a3);
  transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1), color 0.3s ease;
}

.chevron-icon.rotated {
  transform: rotate(180deg);
  color: var(--primary, #39ff14);
}

.accordion-collapse-wrapper {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--motion-duration-normal) var(--motion-ease-out), opacity var(--motion-duration-moderate) ease;
  opacity: 0;
}

.accordion-collapse-wrapper.expanded {
  grid-template-rows: 1fr;
  opacity: 1;
}

.accordion-inner-content {
  overflow: hidden;
  min-height: 0;
}

.accordion-body {
  padding: 14px;
  border-top: 1px solid var(--border, #262626);
}

.modal-footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 20px;
  gap: 12px;
}

.btn-merge-link {
  background: transparent;
  border: none;
  color: var(--primary, #39ff14);
  font-size: 0.85rem;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  padding: 6px 0;
  transition: opacity 0.2s;
  font-family: inherit;
}

.btn-merge-link:hover:not(:disabled) {
  opacity: 0.8;
  text-decoration: underline;
}

.btn-merge-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.merge-icon {
  font-size: 16px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.btn {
  padding: 9px 18px;
  border-radius: 10px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  font-family: inherit;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--muted, #1a1a1a);
  border: 1px solid var(--border, #262626);
  color: var(--foreground, #f1f5f9);
}

.btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
}

.btn-primary {
  background: var(--primary, #39ff14);
  color: #000000;
  font-weight: 700;
  box-shadow: var(--glow-primary, 0 0 10px rgba(57, 255, 20, 0.3));
}

.btn-primary:hover:not(:disabled) {
  box-shadow: var(--glow-primary-hover, 0 0 15px rgba(57, 255, 20, 0.6));
  filter: brightness(1.05);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
