<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useToastStore } from '@/stores/toast'
import { checkUserExists } from '@/services/api'
import { useI18n } from 'vue-i18n'
import { switchLanguage } from '@/i18n'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const eventStore = useEventStore()
const toastStore = useToastStore()
const { t, locale } = useI18n()

const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const isNewUser = ref<boolean | null>(null)
const checkingUser = ref(false)
const submitted = ref(false)

const pendingInviteCode = computed(() => {
  const q = route.query.join || route.query.code
  return typeof q === 'string' ? q.trim().toUpperCase() : ''
})

onMounted(async () => {
  userStore.restoreFromCache()
  if (userStore.isLoggedIn) {
    if (pendingInviteCode.value) {
      try {
        const evt = await eventStore.join(pendingInviteCode.value, 'Joined Event')
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
    console.error(e)
    isNewUser.value = null
  } finally {
    checkingUser.value = false
  }
}

async function handleLogin() {
  if (checkingUser.value) return
  if (!username.value.trim() || !password.value.trim()) return
  if (isNewUser.value && password.value !== confirmPassword.value) {
    toastStore.showError(t('login.password_mismatch'))
    return
  }
  submitted.value = true
  let ok = false
  if (isNewUser.value) {
    ok = await userStore.register(username.value.trim(), password.value.trim())
  } else {
    ok = await userStore.login(username.value.trim(), password.value.trim())
  }
  submitted.value = false
  if (ok) {
    toastStore.showToast(t('toast.welcome_back', { name: username.value.trim() }), 'success')
    if (pendingInviteCode.value) {
      try {
        const evt = await eventStore.join(pendingInviteCode.value, 'Joined Event')
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
        <p class="powered-by">developed by 27570 B.E.A.R. and 25787 TechBY</p>
      </div>

      <div v-if="pendingInviteCode" class="invite-banner">
        <span class="material-icons invite-icon">group_add</span>
        <div class="invite-info">
          <span class="invite-title">{{ t('login.joining_with_code') }}</span>
          <span class="invite-code-text">{{ pendingInviteCode }}</span>
        </div>
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
          {{ checkingUser ? t('login.checking_user') : (submitted ? t('login.signing_in') : (pendingInviteCode ? (isNewUser ? t('login.register_join') : t('login.login_join')) : (isNewUser ? t('login.register_start') : t('login.start_scouting')))) }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: linear-gradient(135deg, var(--background) 0%, var(--card) 50%, var(--background) 100%);
  position: relative;
}

.lang-switcher {
  position: absolute;
  top: 24px;
  right: 24px;
}

.lang-btn {
  background: transparent;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  padding: 8px 12px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  width: auto;
  margin-top: 0;
}

.lang-btn:hover {
  color: var(--foreground);
  border-color: var(--primary);
  background: var(--card);
}

.login-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 48px 40px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4);
  animation: login-card-enter var(--motion-duration-slow) var(--motion-ease-out);
}

.invite-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(59, 130, 246, 0.12);
  border: 1px solid var(--primary);
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

@keyframes login-card-enter {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(20px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
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
  margin-bottom: 32px;
}

.login-brand-logo {
  width: 68px;
  height: 68px;
  object-fit: contain;
  margin-bottom: 10px;
  filter: drop-shadow(0 0 14px rgba(57, 255, 20, 0.45));
}

h1 {
  font-size: 28px;
  font-weight: 700;
  color: var(--foreground);
  margin: 0 0 4px;
}

.powered-by {
  color: var(--muted-foreground);
  font-size: 11px;
  margin-top: 8px;
  opacity: 0.8;
}

label {
  display: block;
  color: var(--muted-foreground);
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 6px;
}

input {
  width: 100%;
  padding: 12px 16px;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--foreground);
  font-size: 16px;
  outline: none;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

input:focus {
  border-color: var(--primary);
}

input:disabled {
  opacity: 0.6;
}

button[type="submit"] {
  width: 100%;
  margin-top: 20px;
  padding: 12px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 16px;
  font-weight: 600;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

button[type="submit"]:hover:not(:disabled) {
  box-shadow: var(--glow-primary);
}

button[type="submit"]:disabled {
  opacity: 0.5;
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
</style>
