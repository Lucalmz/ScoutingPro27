<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'
import { useToastStore } from '@/stores/toast'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const { t } = useI18n()
const userStore = useUserStore()
const connStore = useConnectionStore()
const eventStore = useEventStore()
const toastStore = useToastStore()

const newNickname = ref('')
const targetPassword = ref('')
const renaming = ref(false)
const merging = ref(false)
const mergeErrorMsg = ref<string | null>(null)
const isTakeoverRequested = ref(false)
const cooldownSeconds = ref(0)
let cooldownTimer: any = null

function handleClose() {
  connStore.clearSessionConflict()
}

function handleExitEvent() {
  connStore.clearSessionConflict()
  connStore.disconnect()
  router.push('/')
}

const conflictData = computed(() => connStore.sessionConflict)

const isDuplicateName = computed(() => conflictData.value?.conflictType === 'DUPLICATE_NAME')

watch(conflictData, (data) => {
  if (data && data.conflictingUsername) {
    if (data.suggestedName) {
      newNickname.value = data.suggestedName
    } else {
      newNickname.value = `${data.conflictingUsername}-${Math.floor(Math.random() * 90 + 10)}`
    }
    isTakeoverRequested.value = false
    targetPassword.value = ''
    mergeErrorMsg.value = null
    renaming.value = false
    merging.value = false
  }
}, { immediate: true })

async function handleRename() {
  if (!newNickname.value || !newNickname.value.trim() || renaming.value || merging.value) return
  const trimmed = newNickname.value.trim()
  const oldId = userStore.userId

  renaming.value = true
  try {
    // 1. Rename locally (updates userStore and migrates local recordStore)
    const res = await userStore.rename(trimmed)

    // 2. Broadcast IDENTITY_MIGRATION to Host so Host DB and all peers migrate records
    const currentEventId = eventStore.currentEvent?.id
    if (currentEventId && oldId && res.newId) {
      connStore.rtcService?.sendIdentityMigration(currentEventId, oldId, res.newId, res.newUsername)
    }

    // 3. Clear conflict modal
    connStore.clearSessionConflict()

    // 4. Re-request sync with updated nickname and deterministic ID
    connStore.requestSync(0, undefined, userStore.userId, userStore.username)
  } catch (err: any) {
    console.error('Rename error during conflict resolution:', err)
  } finally {
    renaming.value = false
  }
}

async function handleMergeAccount() {
  const pwd = targetPassword.value
  const targetName = conflictData.value?.conflictingUsername?.trim()
  if (!targetName || !pwd || merging.value || renaming.value) return

  merging.value = true
  mergeErrorMsg.value = null

  try {
    const res = await userStore.mergeAccount(targetName, pwd)
    if (res.success) {
      const currentEventId = eventStore.currentEvent?.id
      if (currentEventId && res.oldId && res.newId) {
        connStore.rtcService?.sendIdentityMigration(currentEventId, res.oldId, res.newId, res.newUsername)
      }

      connStore.clearSessionConflict()
      connStore.requestSync(0, undefined, res.newId, res.newUsername)
      toastStore.showToast(t('user.merge_success_toast', { username: res.newUsername }) || `账号已成功合并至 ${res.newUsername}`, 'success')
    } else {
      let msg = res.error || t('user.merge_failed')
      if (msg.includes('401') || msg.includes('Invalid target account password')) {
        msg = t('conflict.merge_invalid_password') || t('user.invalid_target_password')
      } else if (msg.includes('404') || msg.includes('Target user not found')) {
        msg = t('user.target_user_not_found')
      } else if (msg.includes('Cannot merge user into itself')) {
        msg = t('user.merge_into_self')
      }
      mergeErrorMsg.value = msg
    }
  } catch (err: any) {
    let msg = err?.message || t('user.merge_failed')
    if (msg.includes('401') || msg.includes('Invalid target account password')) {
      msg = t('conflict.merge_invalid_password') || t('user.invalid_target_password')
    } else if (msg.includes('404') || msg.includes('Target user not found')) {
      msg = t('user.target_user_not_found')
    } else if (msg.includes('Cannot merge user into itself')) {
      msg = t('user.merge_into_self')
    }
    mergeErrorMsg.value = msg
  } finally {
    merging.value = false
  }
}

function handleTakeover() {
  if (cooldownSeconds.value > 0) return
  isTakeoverRequested.value = true
  connStore.requestTakeover(userStore.username, userStore.userId)

  cooldownSeconds.value = 30
  if (cooldownTimer) clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    cooldownSeconds.value--
    if (cooldownSeconds.value <= 0) {
      clearInterval(cooldownTimer)
      cooldownTimer = null
    }
  }, 1000)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="conflictData" class="modal-overlay">
        <div class="modal-card">
          <div class="modal-header">
            <div class="header-icon" :class="{ 'warning-icon': isDuplicateName }">
              <span class="icon">{{ isDuplicateName ? 'badge' : 'warning' }}</span>
            </div>
            <h3 class="modal-title">
              {{ isDuplicateName ? t('conflict.duplicate_name_title') : t('conflict.title') }}
            </h3>
            <button class="btn-close-modal" @click="handleClose" :title="t('common.close', '关闭')">
              <span class="material-icons">close</span>
            </button>
          </div>

      <p class="modal-desc">
        {{ isDuplicateName ? t('conflict.duplicate_name_desc', { name: conflictData.conflictingUsername }) : t('conflict.description', { name: conflictData.conflictingUsername }) }}
      </p>

      <div v-if="conflictData.rejected" class="alert-banner error">
        <span class="icon">error</span>
        <span>{{ t('conflict.rejected_hint') }}</span>
      </div>

      <div class="options-container">
        <!-- Mode A: DUPLICATE_NAME Conflict -> Choose Rename OR Merge -->
        <template v-if="isDuplicateName">
          <!-- Option 1: Different Person (Rename) -->
          <div class="option-block">
            <h4 class="option-title">
              {{ t('conflict.option_duplicate_rename_title') }}
            </h4>
            <p class="option-hint">
              {{ t('conflict.option_duplicate_rename_hint') }}
            </p>
            <div class="input-row">
              <input
                v-model="newNickname"
                type="text"
                class="form-input"
                :placeholder="t('conflict.nickname_placeholder')"
                maxlength="30"
                :disabled="renaming || merging"
                @keydown.enter="handleRename"
              />
              <button
                class="btn btn-primary"
                :disabled="!newNickname.trim() || renaming || merging"
                @click="handleRename"
              >
                {{ renaming ? t('user.btn_saving') : t('conflict.btn_confirm_rename') }}
              </button>
            </div>
          </div>

          <div class="divider">
            <span>{{ t('conflict.or') }}</span>
          </div>

          <!-- Option 2: Same Person (Merge into Primary Account) -->
          <div class="option-block merge-block">
            <h4 class="option-title">
              {{ t('conflict.option_duplicate_merge_title') }}
            </h4>
            <p class="option-hint">
              {{ t('conflict.option_duplicate_merge_hint') }}
            </p>

            <div v-if="mergeErrorMsg" class="alert-banner error compact">
              <span class="icon">error_outline</span>
              <span>{{ mergeErrorMsg }}</span>
            </div>

            <div class="input-row">
              <input
                v-model="targetPassword"
                type="password"
                class="form-input"
                :placeholder="t('conflict.target_password_placeholder')"
                :disabled="renaming || merging"
                @keydown.enter="handleMergeAccount"
              />
              <button
                class="btn btn-accent"
                :disabled="!targetPassword.trim() || renaming || merging"
                @click="handleMergeAccount"
              >
                <span v-if="merging" class="spinner-small" style="margin-right: 4px;"></span>
                {{ merging ? t('conflict.btn_merging') : t('conflict.btn_confirm_merge') }}
              </button>
            </div>
          </div>
        </template>

        <!-- Mode B: SAME_USER Session Conflict (multi-tab / session takeover) -->
        <template v-else>
          <!-- Option 1: Rename (Temporary Nickname) -->
          <div class="option-block">
            <h4 class="option-title">{{ t('conflict.option_rename') }}</h4>
            <p class="option-hint">{{ t('conflict.rename_hint') }}</p>
            <div class="input-row">
              <input
                v-model="newNickname"
                type="text"
                class="form-input"
                :placeholder="t('conflict.nickname_placeholder')"
                maxlength="30"
                :disabled="renaming"
                @keydown.enter="handleRename"
              />
              <button
                class="btn btn-primary"
                :disabled="!newNickname.trim() || renaming"
                @click="handleRename"
              >
                {{ renaming ? (t('user.btn_saving') || '保存中...') : t('conflict.btn_rename') }}
              </button>
            </div>
          </div>

          <div class="divider">
            <span>{{ t('conflict.or') }}</span>
          </div>

          <!-- Option 2: Takeover -->
          <div class="option-block">
            <h4 class="option-title">{{ t('conflict.option_takeover') }}</h4>
            <p class="option-hint">{{ t('conflict.takeover_hint') }}</p>
            <div class="takeover-action">
              <button
                class="btn btn-secondary"
                :disabled="cooldownSeconds > 0"
                @click="handleTakeover"
              >
                <span v-if="cooldownSeconds > 0">
                  {{ t('conflict.cooldown_hint', { seconds: cooldownSeconds }) }}
                </span>
                <span v-else>
                  {{ t('conflict.btn_takeover') }}
                </span>
              </button>
              <div v-if="isTakeoverRequested && cooldownSeconds > 15" class="waiting-indicator">
                <span class="spinner"></span>
                <span>{{ t('conflict.takeover_requested') }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div class="modal-footer-actions">
        <button class="btn btn-secondary-exit" @click="handleExitEvent">
          <span class="material-icons">exit_to_app</span>
          {{ t('conflict.btn_exit', '离开赛事 / 返回大厅') }}
        </button>
      </div>
    </div>
  </div>
  </Transition>
</Teleport>
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
  z-index: 100000;
  padding: 1.5rem;
}

.modal-card {
  background: var(--card, #0a0a0a);
  border: 1px solid var(--border, #262626);
  border-radius: 12px;
  max-width: 520px;
  width: 100%;
  padding: 1.75rem;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.8), 0 0 24px rgba(57, 255, 20, 0.08);
  color: var(--foreground, #f1f5f9);
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.btn-close-modal {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-muted, #8b949e);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.btn-close-modal:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.modal-footer-actions {
  margin-top: 1.25rem;
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--border, #262626);
  padding-top: 1rem;
}

.btn-secondary-exit {
  background: rgba(255, 255, 255, 0.08);
  color: #c9d1d9;
  border: 1px solid rgba(255, 255, 255, 0.15);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-secondary-exit:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #ffffff;
}

.header-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: #f59e0b;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
}

.modal-title {
  font-family: 'Orbitron', 'ZCOOLQingKeHuangYou', sans-serif;
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--foreground, #f1f5f9);
  margin: 0;
}

.modal-desc {
  font-size: 0.9rem;
  color: var(--muted-foreground, #a3a3a3);
  line-height: 1.5;
  margin-bottom: 1.25rem;
}

.alert-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-size: 0.85rem;
  margin-bottom: 1rem;
}

.alert-banner.error {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #f87171;
}

.options-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.option-block {
  background: var(--input, #1a1a1a);
  border: 1px solid var(--border, #262626);
  border-radius: 8px;
  padding: 1rem;
}

.option-block.merge-block {
  border-color: rgba(245, 158, 11, 0.3);
  background: rgba(245, 158, 11, 0.04);
}

.alert-banner.compact {
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
  margin-bottom: 0.5rem;
}

.btn-accent {
  background: #f59e0b;
  color: #000000;
  box-shadow: 0 0 10px rgba(245, 158, 11, 0.3);
}

.btn-accent:hover:not(:disabled) {
  filter: brightness(1.1);
  box-shadow: 0 0 15px rgba(245, 158, 11, 0.5);
}

.spinner-small {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(0, 0, 0, 0.2);
  border-top-color: #000000;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
  vertical-align: middle;
}

.option-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--foreground, #f1f5f9);
  margin: 0 0 0.35rem 0;
}

.option-hint {
  font-size: 0.8rem;
  color: var(--muted-foreground, #a3a3a3);
  margin: 0 0 0.75rem 0;
  line-height: 1.4;
}

.input-row {
  display: flex;
  gap: 0.5rem;
}

.form-input {
  flex: 1;
  background: var(--background, #000000);
  border: 1px solid var(--border, #262626);
  border-radius: 6px;
  color: var(--foreground, #f1f5f9);
  padding: 0.5rem 0.75rem;
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.2s;
}

.form-input:focus {
  border-color: var(--primary, #39ff14);
  box-shadow: 0 0 8px rgba(57, 255, 20, 0.3);
}

.btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
  white-space: nowrap;
}

.btn-primary {
  background: var(--primary, #39ff14);
  color: var(--primary-foreground, #000000);
  box-shadow: var(--glow-primary);
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
  box-shadow: var(--glow-primary-hover);
}

.btn-secondary {
  width: 100%;
  background: var(--muted, #1a1a1a);
  border: 1px solid var(--border, #262626);
  color: var(--foreground, #f1f5f9);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--surface-hover, #141414);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.divider {
  display: flex;
  align-items: center;
  text-align: center;
  color: var(--muted-foreground, #a3a3a3);
  font-size: 0.75rem;
  font-weight: 600;
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  border-bottom: 1px solid var(--border, #262626);
}

.divider span {
  padding: 0 0.5rem;
}

.takeover-action {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.waiting-indicator {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--primary, #39ff14);
  margin-top: 0.25rem;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(57, 255, 20, 0.2);
  border-top-color: var(--primary, #39ff14);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.icon {
  font-family: 'Material Icons', sans-serif;
}
</style>
