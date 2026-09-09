import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { login as apiLogin } from '@/services/api'
import { useToastStore } from '@/stores/toast'
import type { User } from '@/types'

export const useUserStore = defineStore('user', () => {
  const user = ref<User | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isLoggedIn = computed(() => user.value !== null)
  const userId = computed(() => user.value?.id ?? '')
  const username = computed(() => user.value?.username ?? '')
  const token = computed(() => user.value?.token ?? '')

  // Try to restore from localStorage
  function restoreFromCache() {
    const cached = localStorage.getItem('scoutingpro-user')
    if (cached) {
      try {
        user.value = JSON.parse(cached) as User
      } catch {
        localStorage.removeItem('scoutingpro-user')
      }
    }
  }

  async function login(usernameInput: string, passwordInput: string): Promise<boolean> {
    loading.value = true
    error.value = null
    try {
      const u = await apiLogin({ username: usernameInput, password: passwordInput })
      user.value = u
      localStorage.setItem('scoutingpro-user', JSON.stringify(u))

      if (u.legacyAliasNotice) {
        useToastStore().showToast(u.legacyAliasNotice, 'info')
      }
      return true
    } catch (e: any) {
      const msg = e.message ?? 'Login failed'
      error.value = msg
      useToastStore().showError(msg)
      return false
    } finally {
      loading.value = false
    }
  }

  async function register(usernameInput: string, passwordInput: string): Promise<boolean> {
    loading.value = true
    error.value = null
    try {
      const { register: apiRegister } = await import('@/services/api')
      const u = await apiRegister({ username: usernameInput, password: passwordInput })
      user.value = u
      localStorage.setItem('scoutingpro-user', JSON.stringify(u))
      return true
    } catch (e: any) {
      const msg = e.message ?? 'Registration failed'
      error.value = msg
      useToastStore().showError(msg)
      return false
    } finally {
      loading.value = false
    }
  }

  async function rename(
    optionsOrName: string | { newUsername?: string; oldPassword?: string; newPassword?: string },
    legacyPassword?: string
  ): Promise<{ success: boolean; oldId: string; newId: string; newUsername: string; error?: string }> {
    if (!user.value) {
      return { success: false, oldId: '', newId: '', newUsername: '', error: 'Not logged in' }
    }
    error.value = null
    const oldId = user.value.id
    const currentUsername = user.value.username

    let targetUsername = currentUsername
    let oldPassword = ''
    let newPassword = ''

    if (typeof optionsOrName === 'string') {
      targetUsername = optionsOrName.trim() || currentUsername
      newPassword = legacyPassword || ''
    } else {
      targetUsername = optionsOrName.newUsername?.trim() || currentUsername
      oldPassword = optionsOrName.oldPassword || ''
      newPassword = optionsOrName.newPassword || ''
    }

    try {
      const { renameUser: apiRenameUser } = await import('@/services/api')
      const res = await apiRenameUser({
        newUsername: targetUsername,
        oldPassword: oldPassword || undefined,
        newPassword: newPassword || undefined
      })
      user.value = {
        ...user.value,
        id: res.id || oldId,
        username: res.username,
        token: res.token || user.value.token
      }
      localStorage.setItem('scoutingpro-user', JSON.stringify(user.value))

      const [{ useRecordStore }, { useScheduleStore }, { usePitScoutStore }] = await Promise.all([
        import('@/stores/records'),
        import('@/stores/schedule'),
        import('@/stores/pitScout')
      ])
      useRecordStore().migrateScoutId(oldId, user.value.id, res.username)
      useScheduleStore().migrateScoutId(oldId, user.value.id, res.username)
      usePitScoutStore().migrateScoutId(oldId, user.value.id, res.username)

      return { success: true, oldId, newId: user.value.id, newUsername: res.username }
    } catch (e: any) {
      const errMsg = e?.message || ''
      const isHttpError = /failed \(\d+\)/.test(errMsg)
      if (isHttpError) {
        error.value = errMsg
        return { success: false, oldId, newId: oldId, newUsername: currentUsername, error: errMsg }
      }
      console.warn('Backend unreachable, updating local state offline:', e)
      user.value = {
        ...user.value,
        id: oldId,
        username: targetUsername
      }
      localStorage.setItem('scoutingpro-user', JSON.stringify(user.value))

      const [{ useRecordStore }, { useScheduleStore }, { usePitScoutStore }] = await Promise.all([
        import('@/stores/records'),
        import('@/stores/schedule'),
        import('@/stores/pitScout')
      ])
      useRecordStore().migrateScoutId(oldId, oldId, targetUsername)
      useScheduleStore().migrateScoutId(oldId, oldId, targetUsername)
      usePitScoutStore().migrateScoutId(oldId, oldId, targetUsername)

      return { success: true, oldId, newId: oldId, newUsername: targetUsername }
    }
  }

  function updateNickname(newUsername: string, _password?: string) {
    if (!newUsername || !newUsername.trim()) return
    const trimmed = newUsername.trim()
    const oldId = user.value?.id || ''
    if (user.value) {
      user.value = {
        ...user.value,
        username: trimmed
      }
      localStorage.setItem('scoutingpro-user', JSON.stringify(user.value))
    }
    if (oldId) {
      Promise.all([
        import('@/stores/records'),
        import('@/stores/schedule'),
        import('@/stores/pitScout')
      ]).then(([{ useRecordStore }, { useScheduleStore }, { usePitScoutStore }]) => {
        useRecordStore().migrateScoutId(oldId, oldId, trimmed)
        useScheduleStore().migrateScoutId(oldId, oldId, trimmed)
        usePitScoutStore().migrateScoutId(oldId, oldId, trimmed)
      })
    }
  }

  async function mergeAccount(
    targetUsername: string,
    targetPassword: string
  ): Promise<{ success: boolean; oldId: string; newId: string; newUsername: string; error?: string }> {
    if (!user.value) {
      return { success: false, oldId: '', newId: '', newUsername: '', error: 'Not logged in' }
    }
    const oldId = user.value.id
    const currentUsername = user.value.username

    loading.value = true
    error.value = null

    try {
      const { mergeUser: apiMergeUser } = await import('@/services/api')
      const res = await apiMergeUser({
        targetUsername: targetUsername.trim(),
        targetPassword
      })

      const targetId = res.id
      const targetName = res.username

      // Update user state to target user
      user.value = {
        id: targetId,
        username: targetName,
        token: res.token || user.value.token
      }
      localStorage.setItem('scoutingpro-user', JSON.stringify(user.value))

      // Migrate records, schedules, and pit scouting locally
      const [{ useRecordStore }, { useScheduleStore }, { usePitScoutStore }] = await Promise.all([
        import('@/stores/records'),
        import('@/stores/schedule'),
        import('@/stores/pitScout')
      ])
      useRecordStore().migrateScoutId(oldId, targetId, targetName)
      useScheduleStore().migrateScoutId(oldId, targetId, targetName)
      usePitScoutStore().migrateScoutId(oldId, targetId, targetName)

      // Broadcast identity migration via WebRTC if connected
      const { useConnectionStore } = await import('@/stores/connection')
      const { useEventStore } = await import('@/stores/events')
      const connStore = useConnectionStore()
      const eventStore = useEventStore()
      const currentEventId = eventStore.currentEvent?.id
      if (currentEventId && connStore.rtcService) {
        connStore.rtcService.sendIdentityMigration(currentEventId, oldId, targetId, targetName)
      }

      useToastStore().showToast(`已成功将账号合并至 ${targetName}`, 'success')
      return { success: true, oldId, newId: targetId, newUsername: targetName }
    } catch (e: any) {
      const errMsg = e?.message || '账号合并失败'
      error.value = errMsg
      useToastStore().showError(errMsg)
      return { success: false, oldId, newId: oldId, newUsername: currentUsername, error: errMsg }
    } finally {
      loading.value = false
    }
  }

  function logout() {
    user.value = null
    localStorage.removeItem('scoutingpro-user')
  }

  // Handle automatic logout on 401
  window.addEventListener('auth-unauthorized', () => {
    logout()
  })

  return { user, loading, error, isLoggedIn, userId, username, token, restoreFromCache, login, register, rename, updateNickname, mergeAccount, logout }
})
