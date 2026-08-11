<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useToastStore } from '@/stores/toast'
import { checkUserExists } from '@/services/api'
import { useI18n } from 'vue-i18n'
import { switchLanguage } from '@/i18n'

const router = useRouter()
const userStore = useUserStore()
const toastStore = useToastStore()
const { t, locale } = useI18n()

const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const isNewUser = ref<boolean | null>(null)
const checkingUser = ref(false)
const submitted = ref(false)

onMounted(() => {
  userStore.restoreFromCache()
  if (userStore.isLoggedIn) {
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
    toastStore.showError("Passwords do not match")
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
        <span class="material-icons logo-icon">hive</span>
        <h1>ScoutingPro 27</h1>
        <p class="powered-by">developed by 27570 B.E.A.R. and 25787 TechBY</p>
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

        <template v-if="isNewUser">
          <label for="confirmPassword" style="margin-top: 16px;">{{ t('login.confirm_password') }}</label>
          <input
            id="confirmPassword"
            v-model="confirmPassword"
            type="password"
            :placeholder="t('login.confirm_placeholder')"
            autocomplete="off"
            :disabled="submitted"
          />
        </template>

        <button type="submit" :disabled="!!(submitted || checkingUser || !username.trim() || !password.trim() || (isNewUser && !confirmPassword.trim()))">
          <span v-if="submitted || checkingUser" class="spinner"></span>
          {{ checkingUser ? t('login.checking_user') : (submitted ? t('login.signing_in') : (isNewUser ? t('login.register_start') : t('login.start_scouting'))) }}
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
}

.logo-area {
  text-align: center;
  margin-bottom: 32px;
}

.logo-icon {
  font-size: 48px;
  margin-bottom: 8px;
  color: var(--primary);
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
