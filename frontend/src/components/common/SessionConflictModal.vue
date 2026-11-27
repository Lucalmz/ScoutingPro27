<script setup lang="ts">
import { ref, watch, computed, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'
import { useToastStore } from '@/stores/toast'
import { useI18n } from 'vue-i18n'
import { formatUserFriendlyError } from '@/utils/errorHelper'

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
  handleExitEvent()
}

function handleExitEvent() {
  connStore.clearSessionConflict()
  connStore.disconnect()
  router.push(userStore.isLoggedIn ? '/dashboard' : '/')
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
  const pwd = targetPassword.value ?? ''
  const targetName = conflictData.value?.conflictingUsername?.trim()
  if (!targetName || !pwd || merging.value || renaming.value) return

  merging.value = true
  mergeErrorMsg.value = null

  try {
    const res = await userStore.mergeAccount(targetName, pwd)
    if (res.success) {
      connStore.clearSessionConflict()
      connStore.requestSync(0, undefined, res.newId, res.newUsername)
      toastStore.showToast(t('user.merge_success_toast', { username: res.newUsername }) || `账号已成功合并至 ${res.newUsername}`, 'success')
    } else {
      mergeErrorMsg.value = formatUserFriendlyError(res.error, t('user.merge_failed')).message
    }
  } catch (err: any) {
    mergeErrorMsg.value = formatUserFriendlyError(err, t('user.merge_failed')).message
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

onUnmounted(() => {
  if (cooldownTimer) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
})
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
            <button class="btn-close-modal" @click="handleClose" :title="t('common.close')">
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
                :disabled="!targetPassword || renaming || merging"
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
  background: color-mix(in srgb, var(--g-950) 84%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100000;
  padding: 1.5rem;
  overflow-y: auto;
}

.modal-card {
  position: relative;
  background: var(--popover);
  border: 1px solid var(--border-strong);
  border-top: 3px solid var(--status-warning);
  border-radius: 14px;
  max-width: 520px;
  width: 100%;
  padding: 1.75rem;
  box-shadow: var(--shadow-3);
  color: var(--foreground);
  max-height: 90vh;
  overflow-y: auto;
  box-sizing: border-box;
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.85rem;
  padding-bottom: 0.85rem;
  border-bottom: 1px solid var(--border);
}

.btn-close-modal {
  margin-left: auto;
  background: var(--surface-elevated);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  cursor: pointer;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), transform var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-close-modal:hover {
  background: var(--surface-hover);
  border-color: var(--g-500);
  color: var(--foreground);
}

.modal-footer-actions {
  margin-top: 1.25rem;
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--border);
  padding-top: 1rem;
}

.btn-secondary-exit {
  background: var(--surface-elevated);
  color: var(--foreground);
  border: 1px solid var(--border-strong);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), transform var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-secondary-exit:hover {
  background: var(--surface-hover);
  border-color: var(--g-500);
  color: var(--g-50);
}

.header-icon {
  width: 38px;
  height: 38px;
  border-radius: 9px;
  background: var(--status-warning-bg);
  border: 1px solid var(--status-warning-border);
  color: var(--status-warning);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
}

.modal-title {
  font-family: var(--font-sans);
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--foreground);
  letter-spacing: -0.01em;
  margin: 0;
}

.modal-desc {
  font-size: 0.9rem;
  color: var(--muted-foreground);
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
  background: var(--status-error-bg);
  border: 1px solid var(--status-error-border);
  color: var(--status-error-text);
}

.options-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.option-block {
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem;
}

.option-block.merge-block {
  border-color: var(--status-warning-border);
  background: var(--status-warning-bg);
}

.alert-banner.compact {
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
  margin-bottom: 0.5rem;
}

.btn-accent {
  background: var(--status-warning);
  color: var(--on-primary);
  border: 1px solid var(--status-warning);
}

.btn-accent:hover:not(:disabled) {
  background: color-mix(in srgb, var(--status-warning) 85%, var(--g-50));
}

.spinner-small {
  width: 12px;
  height: 12px;
  border: 2px solid color-mix(in srgb, var(--on-primary) 25%, transparent);
  border-top-color: var(--on-primary);
  border-radius: 50%;
  animation: spin 800ms linear infinite;
  display: inline-block;
  vertical-align: middle;
}

.option-title {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--foreground);
  margin: 0 0 0.35rem 0;
}

.option-hint {
  font-size: 0.8rem;
  color: var(--muted-foreground);
  margin: 0 0 0.75rem 0;
  line-height: 1.4;
}

.input-row {
  display: flex;
  gap: 0.5rem;
}

.form-input {
  flex: 1;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--foreground);
  padding: 0.55rem 0.75rem;
  font-size: 0.9rem;
  outline: none;
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out), box-shadow var(--motion-duration-fast) var(--motion-ease-out);
}

.form-input:focus {
  border-color: var(--primary);
  box-shadow: var(--focus-ring-sm);
}

.btn {
  padding: 0.55rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), transform var(--motion-duration-fast) var(--motion-ease-out);
  white-space: nowrap;
}

.btn-primary {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--s-300);
}

.btn-secondary {
  width: 100%;
  background: var(--surface-elevated);
  border: 1px solid var(--border-strong);
  color: var(--foreground);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--surface-hover);
  border-color: var(--g-500);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.divider {
  display: flex;
  align-items: center;
  text-align: center;
  color: var(--muted-foreground);
  font-size: 0.75rem;
  font-weight: 600;
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  border-bottom: 1px solid var(--border);
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
  color: var(--primary);
  margin-top: 0.25rem;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(var(--primary-rgb), 0.2);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 800ms linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.icon {
  font-family: 'Material Icons', sans-serif;
}

@media (max-width: 480px) {
  .modal-overlay {
    padding: 0.75rem;
  }
  .modal-card {
    padding: 1.25rem 1rem;
    max-height: 94vh;
  }
  .input-row {
    flex-direction: column;
    gap: 0.5rem;
  }
  .input-row .btn {
    width: 100%;
    justify-content: center;
  }
  .modal-desc {
    font-size: 0.85rem;
    margin-bottom: 1rem;
  }
  .btn-secondary-exit {
    width: 100%;
    justify-content: center;
  }
}
</style>
