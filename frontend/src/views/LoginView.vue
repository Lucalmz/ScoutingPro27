<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useToastStore } from '@/stores/toast'
import { checkUserExists } from '@/services/api'
import { useI18n } from 'vue-i18n'
import { switchLanguage } from '@/i18n'
import { isDesktopHost } from '@/services/photoStorage'
import { useIsMobile } from '@/composables/useIsMobile'
import QrScannerModal from '@/components/common/QrScannerModal.vue'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const eventStore = useEventStore()
const toastStore = useToastStore()
const { t, locale } = useI18n()
const { isMobile } = useIsMobile()
const isMobileClient = computed(() => isMobile.value && !isDesktopHost())

const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const isNewUser = ref<boolean | null>(null)
const checkingUser = ref(false)
const submitted = ref(false)
const showQrScannerModal = ref(false)
const scannedInviteCode = ref('')

watch(username, () => {
  isNewUser.value = null
})

const effectiveInviteCode = computed(() => {
  if (scannedInviteCode.value) return scannedInviteCode.value
  const q = route.query.join || route.query.code
  return typeof q === 'string' ? q.trim().toUpperCase() : ''
})

onMounted(async () => {
  const b = route.query.b || route.query.broker
  if (b && typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem('sp27-active-broker', String(b))
  }
  userStore.restoreFromCache()
  if (userStore.isLoggedIn) {
    if (effectiveInviteCode.value) {
      try {
        const evt = await eventStore.join(effectiveInviteCode.value, 'Joined Event')
        if (evt) {
          router.replace(`/event/${evt.id}`)
          return
        }
      } catch (e) {
        console.warn('[LoginView] Failed to auto-join with cached session:', e)
      }
    }
    router.replace('/dashboard')
  }
})

async function handleQrScanned(code: string) {
  scannedInviteCode.value = code
  toastStore.showToast(t('qr_scanner.scan_success'), 'success')
  if (userStore.isLoggedIn) {
    try {
      const evt = await eventStore.join(code, 'Joined Event')
      if (evt) {
        router.push(`/event/${evt.id}`)
        return
      }
    } catch (e) {
      console.warn('[LoginView] Failed to auto-join after scan:', e)
    }
    router.push('/dashboard')
  }
}

function toggleLang() {
  const newLang = locale.value === 'en' ? 'zh' : 'en'
  switchLanguage(newLang)
}

async function handleUsernameBlur() {
  const uname = username.value.trim()
  if (!uname) {
    isNewUser.value = null
    return
  }
  checkingUser.value = true
  try {
    const res = await checkUserExists(uname)
    isNewUser.value = !res.exists
  } catch (e) {
    console.warn('[LoginView] User check deferred or offline:', e)
    // On standalone PWA / offline client, allow proceeding as existing user
    isNewUser.value = false
  } finally {
    checkingUser.value = false
  }
}

async function handleLogin() {
  if (checkingUser.value) {
    let attempts = 0
    while (checkingUser.value && attempts < 40) {
      await new Promise((r) => setTimeout(r, 50))
      attempts++
    }
  }
  const uname = username.value.trim()
  if (!uname) return

  if (isNewUser.value === null) {
    await handleUsernameBlur()
  }

  const pwd = password.value.trim()
  if (!pwd) return

  if (isNewUser.value) {
    if (!confirmPassword.value.trim()) {
      return
    }
    if (pwd !== confirmPassword.value.trim()) {
      toastStore.showError(t('login.password_mismatch'))
      return
    }
  }

  submitted.value = true
  let ok = false
  if (isNewUser.value) {
    ok = await userStore.register(uname, pwd)
  } else {
    ok = await userStore.login(uname, pwd)
  }
  submitted.value = false
  if (ok) {
    toastStore.showToast(t('toast.welcome_back', { name: uname }), 'success')
    if (effectiveInviteCode.value) {
      try {
        const evt = await eventStore.join(effectiveInviteCode.value, 'Joined Event')
        if (evt) {
          router.push(`/event/${evt.id}`)
          return
        }
      } catch (e) {
        console.warn('[LoginView] Failed to auto-join after login:', e)
      }
    }
    router.push('/dashboard')
  }
}
</script>

<template>
  <div class="login-screen">
    <div class="lang-switcher">
      <button type="button" @click="toggleLang" class="lang-btn">
        <span class="material-icons">language</span>
        {{ locale === 'en' ? t('login.lang_zh') : t('login.lang_en') }}
      </button>
    </div>
    
    <div class="login-card">
      <div class="logo-area">
        <img src="/logo_transparent.png" alt="SP27" class="login-brand-logo" />
        <h1>ScoutingPro 27</h1>
        <p class="powered-by">developed by 27570 B.E.A.R.</p>
      </div>

      <div v-if="effectiveInviteCode" class="invite-banner">
        <span class="material-icons invite-icon">group_add</span>
        <div class="invite-info">
          <span class="invite-title">{{ t('login.joining_with_code') }}</span>
          <span class="invite-code-text">{{ effectiveInviteCode }}</span>
        </div>
        <button v-if="isMobileClient" type="button" class="btn-rescan" @click="showQrScannerModal = true" :title="t('login.rescan_qr_code')">
          <span class="material-icons">qr_code_scanner</span>
        </button>
      </div>

      <form @submit.prevent="handleLogin">
        <label for="username">{{ t('login.scouter_name') }}</label>
        <input
          id="username"
          v-model="username"
          @blur="handleUsernameBlur"
          type="text"
          :placeholder="t('login.scouter_placeholder')"
          autocomplete="off"
          :disabled="submitted || checkingUser"
        />

        <label for="password" style="margin-top: 16px;">{{ t('login.password') }}</label>
        <input
          id="password"
          v-model="password"
          type="password"
          :placeholder="t('login.password_placeholder')"
          autocomplete="off"
          :disabled="submitted"
        />

        <Transition name="field-expand">
          <div v-if="isNewUser" class="expandable-field">
            <label for="confirmPassword" style="margin-top: 16px;">{{ t('login.confirm_password') }}</label>
            <input
              id="confirmPassword"
              v-model="confirmPassword"
              type="password"
              :placeholder="t('login.confirm_placeholder')"
              autocomplete="off"
              :disabled="submitted"
            />
          </div>
        </Transition>

        <button type="submit" :disabled="!!(submitted || checkingUser || !username.trim() || !password.trim() || (isNewUser && !confirmPassword.trim()))">
          <span v-if="submitted || checkingUser" class="spinner"></span>
          {{ checkingUser ? t('login.checking_user') : (submitted ? t('login.signing_in') : (effectiveInviteCode ? (isNewUser ? t('login.register_join') : t('login.login_join')) : (isNewUser ? t('login.register_start') : t('login.start_scouting')))) }}
        </button>
      </form>

      <div v-if="isMobileClient" class="login-alt-actions">
        <button type="button" class="btn-scan-login" @click="showQrScannerModal = true">
          <span class="material-icons">qr_code_scanner</span>
          {{ effectiveInviteCode ? t('login.rescan_qr_code') : t('login.scan_qr_join') }}
        </button>
      </div>
    </div>

    <!-- QR Scanner Modal -->
    <QrScannerModal v-model="showQrScannerModal" @scan="handleQrScanned" />
  </div>
</template>

<style scoped>
.login-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background-color: var(--background);
  position: relative;
  overflow: hidden;
}

.lang-switcher {
  position: absolute;
  top: max(16px, var(--sat, env(safe-area-inset-top, 0px)));
  right: max(16px, var(--sar, env(safe-area-inset-right, 0px)));
  z-index: 10;
}

.lang-btn {
  background: var(--card);
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  padding: 8px 14px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  width: auto;
  margin-top: 0;
}

.lang-btn:hover {
  color: var(--foreground);
  border-color: var(--primary);
  background: var(--surface-elevated);
}

.login-card {
  position: relative;
  z-index: 2;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 44px 38px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 28px 64px rgba(0, 0, 0, 0.72);
  animation: login-card-enter 0.72s var(--motion-ease-out) both;
}

.invite-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--surface-recessed);
  border: 1px solid var(--primary);
  border-left: 3px solid var(--primary);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 20px;
}

.invite-icon {
  color: var(--primary);
  font-size: 28px;
}

.invite-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.invite-title {
  font-size: 12px;
  color: var(--muted-foreground);
}

.invite-code-text {
  font-size: 16px;
  font-weight: 700;
  color: var(--foreground);
  letter-spacing: 0.5px;
}

.btn-rescan {
  margin-left: auto;
  background: var(--card);
  border: 1px solid rgba(57, 255, 20, 0.4);
  color: var(--primary);
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
  padding: 0;
  flex-shrink: 0;
}

.btn-rescan:hover {
  background: rgba(57, 255, 20, 0.15);
  border-color: var(--primary);
}

.login-alt-actions {
  margin-top: 14px;
  text-align: center;
}

.btn-scan-login {
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  padding: 10px 16px;
  border-radius: 10px;
  width: 100%;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-scan-login:hover {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--surface-elevated);
}

.btn-scan-login .material-icons {
  font-size: 20px;
}

@keyframes login-card-enter {
  0% {
    opacity: 0;
    transform: translateY(28px) scale(0.95);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.field-expand-enter-active,
.field-expand-leave-active {
  transition: all var(--motion-duration-moderate) var(--motion-ease-out);
  overflow: hidden;
}

.field-expand-enter-from,
.field-expand-leave-to {
  opacity: 0;
  max-height: 0;
  transform: translateY(-8px);
}

.field-expand-enter-to,
.field-expand-leave-from {
  opacity: 1;
  max-height: 120px;
  transform: translateY(0);
}

.logo-area {
  text-align: center;
  margin-bottom: 28px;
  animation: tactical-stagger-rise 0.65s var(--motion-ease-out) 0.08s both;
}

.login-brand-logo {
  width: 64px;
  height: 64px;
  object-fit: contain;
  image-rendering: -webkit-optimize-contrast;
  margin-bottom: 14px;
}

h1 {
  font-size: 27px;
  font-weight: 800;
  color: var(--foreground);
  margin: 0 0 4px;
  letter-spacing: 0.04em;
}

.powered-by {
  color: var(--muted-foreground);
  font-size: 11px;
  font-family: 'Orbitron', sans-serif;
  letter-spacing: 0.08em;
  margin-top: 6px;
}

form {
  animation: tactical-stagger-rise 0.65s var(--motion-ease-out) 0.16s both;
}

label {
  display: block;
  color: var(--muted-foreground);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 6px;
}

input {
  width: 100%;
  padding: 12px 16px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--foreground);
  font-size: 15px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
  box-sizing: border-box;
}

input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(57, 255, 20, 0.14);
}

input:disabled {
  opacity: 0.6;
}

button[type="submit"] {
  width: 100%;
  margin-top: 22px;
  padding: 13px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-family: 'Orbitron', 'Manrope', sans-serif;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.04em;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

button[type="submit"]:hover:not(:disabled) {
  box-shadow: var(--glow-primary);
}

button[type="submit"]:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: var(--primary-foreground);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 480px) {
  .login-screen {
    padding: 16px 12px;
  }
  .login-card {
    padding: 32px 18px;
    border-radius: 14px;
  }
  h1 {
    font-size: 22px;
  }
  .login-brand-logo {
    width: 52px;
    height: 52px;
  }
  .logo-area {
    margin-bottom: 24px;
  }
}
</style>
