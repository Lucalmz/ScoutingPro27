<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useUserStore } from '@/stores/user'
import { useConnectionStore } from '@/stores/connection'
import { useEventStore } from '@/stores/events'
import { useToastStore } from '@/stores/toast'
import { useI18n } from 'vue-i18n'
import { useUserProfileTransition, supportsViewTransitionApi } from '@/composables/useUserProfileTransition'

const props = defineProps<{
  visible: boolean
  eventId?: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'renamed', newName: string): void
}>()

const { t } = useI18n()
const userStore = useUserStore()
const connStore = useConnectionStore()
const eventStore = useEventStore()
const toastStore = useToastStore()
const { isProfileTransitioning, lastLandingSeq, closeProfileModal } = useUserProfileTransition()

const newUsername = ref('')
const changePassword = ref(false)
const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')

const saving = ref(false)
const errorMsg = ref<string | null>(null)
const usernameInputRef = ref<HTMLInputElement | null>(null)
const isLanded = ref(false)
let landedTimer: ReturnType<typeof setTimeout> | null = null

const useFallbackTransition = computed(() => !supportsViewTransitionApi())

watch(() => props.visible, (val) => {
  if (landedTimer !== null) {
    clearTimeout(landedTimer)
    landedTimer = null
  }
  isLanded.value = false
  if (val) {
    newUsername.value = userStore.username
    changePassword.value = false
    oldPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    errorMsg.value = null
    saving.value = false
  }
}, { immediate: true })

watch(lastLandingSeq, async () => {
  if (!props.visible || isProfileTransitioning.value) return
  await nextTick()
  const input = usernameInputRef.value
  if (input) {
    input.focus({ preventScroll: true })
    const len = input.value.length
    if (typeof input.setSelectionRange === 'function') {
      input.setSelectionRange(len, len)
    }
  }
  isLanded.value = true
  if (landedTimer !== null) clearTimeout(landedTimer)
  landedTimer = setTimeout(() => {
    isLanded.value = false
    landedTimer = null
  }, 520)
})

function handleClose() {
  if (saving.value) return
  void closeProfileModal((val) => emit('update:visible', val))
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
  if (landedTimer !== null) {
    clearTimeout(landedTimer)
    landedTimer = null
  }
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
      newUsername.value = res.newUsername
      emit('renamed', res.newUsername)
      await closeProfileModal((val) => emit('update:visible', val))
    } else {
      const errLower = (res.error || '').toLowerCase()
      if (errLower.includes('401') || errLower.includes('old password') || errLower.includes('incorrect password')) {
        errorMsg.value = t('user.old_password_incorrect')
      } else if (errLower.includes('409') || errLower.includes('already taken') || errLower.includes('conflict')) {
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
  <Transition :name="useFallbackTransition ? 'profile-fallback' : undefined" :css="useFallbackTransition">
    <div
      v-if="visible"
      class="modal-overlay"
      :style="{ viewTransitionName: isProfileTransitioning && visible ? 'user-profile-backdrop' : 'none' }"
      @click.self="handleClose"
    >
      <div
        class="modal-card rename-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-modal-title"
        :style="{ viewTransitionName: isProfileTransitioning && visible ? 'user-profile-panel' : 'none' }"
      >
        <div class="modal-header">
          <div class="header-icon">
            <span class="material-icons">badge</span>
          </div>
          <h3 id="rename-modal-title" class="modal-title">{{ t('user.rename_title') }}</h3>
        </div>

        <p class="modal-desc">
          {{ t('user.rename_desc') }}
        </p>

        <div v-if="errorMsg" class="alert-banner error">
          <span class="material-icons icon">error</span>
          <span>{{ errorMsg }}</span>
        </div>

        <!-- Username Field with Direct View Transition Target -->
        <div class="form-group">
          <label class="form-label">{{ t('user.nickname_label') }}</label>
          <div class="input-wrapper username-input-wrapper" :class="{ 'is-landed': isLanded }">
            <span class="material-icons field-icon">person</span>
            <input
              ref="usernameInputRef"
              v-model="newUsername"
              type="text"
              class="form-input with-icon username-input"
              :class="{ 'text-transparent': isProfileTransitioning }"
              :placeholder="t('user.nickname_placeholder')"
              maxlength="30"
              :disabled="saving"
              @keydown.enter="handleSave"
            />
            <span
              v-if="isProfileTransitioning"
              class="input-text-morph"
              :style="{ viewTransitionName: visible ? 'user-profile-text' : 'none' }"
            >{{ newUsername.trim() || userStore.username }}</span>
            <span class="dock-sheen" aria-hidden="true"></span>
          </div>
        </div>

        <!-- Expandable Accordion for Password Modification -->
        <div class="accordion-card" :class="{ open: changePassword }">
          <div class="accordion-header" @click="changePassword = !changePassword">
            <div class="accordion-header-left">
              <span class="material-icons lock-icon">lock</span>
              <span class="accordion-title">{{ t('user.change_password_toggle') }}</span>
            </div>
            <span class="material-icons chevron-icon" :class="{ rotated: changePassword }">expand_more</span>
          </div>

          <div class="accordion-collapse-wrapper" :class="{ expanded: changePassword }">
            <div class="accordion-inner-content">
              <div class="accordion-body">
                <div class="form-group">
                  <label class="form-label">{{ t('user.old_password_label') }}</label>
                  <div class="input-wrapper">
                    <span class="material-icons field-icon">vpn_key</span>
                    <input
                      v-model="oldPassword"
                      type="password"
                      class="form-input with-icon"
                      :placeholder="t('user.old_password_placeholder')"
                      :disabled="saving"
                    />
                  </div>
                </div>

                <div class="form-group">
                  <label class="form-label">{{ t('user.new_password_label') }}</label>
                  <div class="input-wrapper">
                    <span class="material-icons field-icon">lock_reset</span>
                    <input
                      v-model="newPassword"
                      type="password"
                      class="form-input with-icon"
                      :placeholder="t('user.new_password_placeholder')"
                      :disabled="saving"
                    />
                  </div>
                </div>

                <div class="form-group">
                  <label class="form-label">{{ t('user.confirm_password_label') }}</label>
                  <div class="input-wrapper">
                    <span class="material-icons field-icon">check_circle</span>
                    <input
                      v-model="confirmPassword"
                      type="password"
                      class="form-input with-icon"
                      :placeholder="t('user.confirm_password_placeholder')"
                      :disabled="saving"
                      @keydown.enter="handleSave"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn btn-secondary" :disabled="saving" @click="handleClose">
            {{ t('common.cancel') }}
          </button>
          <button class="btn btn-primary" :disabled="saving || !newUsername.trim()" @click="handleSave">
            <span v-if="saving" class="material-icons spinning" style="font-size: 16px; margin-right: 4px;">sync</span>
            {{ saving ? t('user.btn_saving') : t('user.btn_save') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: radial-gradient(ellipse 82% 72% at 50% 42%, rgba(9, 12, 15, 0.68) 0%, rgba(5, 7, 9, 0.88) 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 16px;
}

.modal-card {
  position: relative;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--g-800) 94%, var(--primary) 2.5%) 0%,
    var(--popover) 24%,
    color-mix(in srgb, var(--g-900) 96%, var(--g-950) 4%) 100%
  );
  border: 1px solid color-mix(in srgb, var(--border-strong) 82%, rgba(255, 255, 255, 0.1));
  border-radius: 18px;
  max-width: 480px;
  width: 100%;
  padding: 24px;
  box-shadow:
    0 32px 80px rgba(0, 0, 0, 0.65),
    0 10px 28px rgba(0, 0, 0, 0.38),
    inset 0 1px 0 rgba(255, 255, 255, 0.07);
  max-height: 90vh;
  overflow-x: hidden;
  overflow-y: auto;
  box-sizing: border-box;
}

.modal-card::before {
  content: '';
  position: absolute;
  inset: 0 24px auto;
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, rgba(var(--primary-rgb), 0.42) 50%, transparent 100%);
  pointer-events: none;
}

/* Fallback transition when document.startViewTransition is unavailable */
.profile-fallback-enter-active,
.profile-fallback-leave-active {
  transition: opacity 240ms var(--motion-ease-out);
}

.profile-fallback-enter-active .modal-card,
.profile-fallback-leave-active .modal-card {
  transition: opacity 260ms var(--motion-ease-out), transform 260ms var(--motion-ease-out);
}

.profile-fallback-enter-from,
.profile-fallback-leave-to {
  opacity: 0;
}

.profile-fallback-enter-from .modal-card,
.profile-fallback-leave-to .modal-card {
  opacity: 0;
  transform: translate3d(0, -14px, 0) scale(0.96);
}

@media (prefers-reduced-motion: reduce) {
  .profile-fallback-enter-from .modal-card,
  .profile-fallback-leave-to .modal-card {
    transform: none;
  }
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
  background: var(--status-success-bg);
  border: 1px solid var(--status-success-border);
  box-shadow: inset 0 1px 0 rgba(var(--primary-rgb), 0.25);
  color: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-icon .material-icons {
  font-size: 24px;
}

.modal-title {
  font-family: var(--font-sans);
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--foreground);
  margin: 0;
  letter-spacing: -0.01em;
}

.modal-desc {
  font-size: 0.85rem;
  color: var(--muted-foreground);
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
  background: var(--status-error-bg);
  border: 1px solid var(--status-error-border);
  color: var(--status-error);
}

.form-group {
  margin-bottom: 14px;
}

.form-label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted-foreground);
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
  color: var(--muted-foreground);
  font-size: 18px;
  pointer-events: none;
  z-index: 3;
}

.form-input {
  width: 100%;
  height: 42px;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0 14px;
  color: var(--foreground);
  font-size: 0.95rem;
  font-family: inherit;
  outline: none;
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out), box-shadow var(--motion-duration-fast) var(--motion-ease-out);
  box-sizing: border-box;
}

.form-input.with-icon {
  padding-left: 38px;
}

.form-input.username-input {
  font-weight: 500;
  line-height: 1.25;
}

.form-input.text-transparent {
  color: transparent !important;
  caret-color: transparent !important;
}

.input-text-morph {
  position: absolute;
  left: 39px;
  top: 50%;
  transform: translateY(-50%);
  height: auto;
  width: fit-content;
  max-width: calc(100% - 54px);
  line-height: 1.25;
  font-size: 0.95rem;
  font-weight: 500;
  font-family: inherit;
  color: var(--foreground);
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
  z-index: 2;
}

.dock-sheen {
  position: absolute;
  inset: 1px;
  border-radius: 9px;
  overflow: hidden;
  pointer-events: none;
  z-index: 4;
}

.dock-sheen::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-110%) skewX(-18deg);
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(var(--primary-rgb), 0.14) 50%,
    transparent 100%
  );
  opacity: 0;
}

@media (prefers-reduced-motion: no-preference) {
  .username-input-wrapper.is-landed .dock-sheen::after {
    animation: profile-dock-sheen 480ms var(--motion-ease-out) both;
  }
}

@keyframes profile-dock-sheen {
  0% {
    opacity: 0;
    transform: translateX(-110%) skewX(-18deg);
  }
  28% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateX(130%) skewX(-18deg);
  }
}

.form-input:focus {
  border-color: var(--primary);
  box-shadow: var(--focus-ring-sm);
}

.form-input:disabled {
  opacity: 0.5;
}

/* Expandable Accordion Card Style */
.accordion-card {
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 18px;
  overflow: hidden;
  transition: border-color var(--motion-duration-slow) var(--motion-ease-out), box-shadow var(--motion-duration-slow) var(--motion-ease-out), background-color var(--motion-duration-normal) var(--motion-ease-out);
}

.accordion-card.open {
  border-color: var(--status-success-border);
  background: rgba(var(--primary-rgb), 0.03);
  box-shadow: var(--shadow-1);
}

.accordion-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  cursor: pointer;
  user-select: none;
  transition: background-color var(--motion-duration-moderate) var(--motion-ease-out);
}

.accordion-header:hover {
  background: var(--surface-hover);
}

.accordion-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lock-icon {
  font-size: 18px;
  color: var(--primary);
}

.accordion-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--foreground);
}

.chevron-icon {
  font-size: 20px;
  color: var(--muted-foreground);
  transition: transform var(--motion-duration-normal) var(--motion-ease-out), color var(--motion-duration-moderate) var(--motion-ease-out);
}

.chevron-icon.rotated {
  transform: rotate(180deg);
  color: var(--primary);
}

.accordion-collapse-wrapper {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--motion-duration-normal) var(--motion-ease-out), opacity var(--motion-duration-moderate) var(--motion-ease-out);
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
  border-top: 1px solid var(--border);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 20px;
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
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), transform var(--motion-duration-fast) var(--motion-ease-out);
  font-family: inherit;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  color: var(--foreground);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.btn-primary {
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 700;
}

.btn-primary:hover:not(:disabled) {
  background: var(--s-300);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
