import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { listEvents, createEvent, joinEvent, syncExternalEvent, isStaticCloudHost } from '@/services/api'
import { isDesktopHost } from '@/services/photoStorage'
import { isMobileDevice } from '@/composables/useIsMobile'
import { useUserStore } from '@/stores/user'
import { useConnectionStore } from '@/stores/connection'
import { setCustomTurnConfig } from '@/services/webrtc/connectivity'
import { getEpochWitnessRecord, isPlaceholderEventId } from '@/services/webrtc/epochStore'
import type { CustomTurnConfig, ScoutingEvent } from '@/types'

export const useEventStore = defineStore('events', () => {
  const events = ref<ScoutingEvent[]>([])
  const currentEvent = ref<ScoutingEvent | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  
  const userStore = useUserStore()

  function sanitizeEventList(list: any[]): ScoutingEvent[] {
    if (!Array.isArray(list)) return []
    const cleanList: ScoutingEvent[] = []
    const seenIds = new Set<string>()
    const codeToAuthoritative = new Map<string, ScoutingEvent>()

    // First pass: register authoritative UUID events (not starting with evt-)
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const id = String(item.id || '').trim()
      if (!id) continue
      const inviteCode = String(item.inviteCode || '').trim().toUpperCase()
      const rawName = typeof item.name === 'string' ? item.name.trim() : ''
      const name =
        rawName && rawName.toLowerCase() !== 'scoutingpro27' && rawName.toLowerCase() !== 'scoutingpro 27'
          ? rawName
          : inviteCode
          ? `Event ${inviteCode}`
          : 'Scouting Event'
      const sanitized: ScoutingEvent = {
        ...item,
        id,
        name,
        inviteCode
      }
      const isPlaceholder = id.toLowerCase().startsWith('evt-') || (Boolean(inviteCode) && id.toUpperCase() === `EXT_${inviteCode}`)
      if (!isPlaceholder && inviteCode) {
        codeToAuthoritative.set(inviteCode, sanitized)
      }
    }

    // Second pass: eliminate placeholders if authoritative exists, and deduplicate
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const id = String(item.id || '').trim()
      if (!id || seenIds.has(id)) continue
      const inviteCode = String(item.inviteCode || '').trim().toUpperCase()
      const isPlaceholder = id.toLowerCase().startsWith('evt-') || (Boolean(inviteCode) && id.toUpperCase() === `EXT_${inviteCode}`)
      if (isPlaceholder && inviteCode && codeToAuthoritative.has(inviteCode)) {
        continue
      }
      const rawName = typeof item.name === 'string' ? item.name.trim() : ''
      const name =
        rawName && rawName.toLowerCase() !== 'scoutingpro27' && rawName.toLowerCase() !== 'scoutingpro 27'
          ? rawName
          : inviteCode
          ? `Event ${inviteCode}`
          : 'Scouting Event'
      const sanitized: ScoutingEvent = {
        ...item,
        id,
        name,
        inviteCode
      }
      seenIds.add(id)
      cleanList.push(sanitized)
    }

    return cleanList
  }

  function restoreFromCache() {
    if (typeof localStorage === 'undefined') return
    try {
      const rawEvents = localStorage.getItem('scoutingpro_events')
      if (rawEvents && events.value.length === 0) {
        const parsed = JSON.parse(rawEvents)
        events.value = sanitizeEventList(parsed)
      }
      const rawCurrent = localStorage.getItem('scoutingpro_current_event')
      if (rawCurrent && !currentEvent.value) {
        const parsedCurrent = JSON.parse(rawCurrent)
        if (parsedCurrent && typeof parsedCurrent === 'object' && !Array.isArray(parsedCurrent) && parsedCurrent.id) {
          const rawName = typeof parsedCurrent.name === 'string' ? parsedCurrent.name.trim() : ''
          const code = String(parsedCurrent.inviteCode || '').trim().toUpperCase()
          parsedCurrent.name =
            rawName && rawName.toLowerCase() !== 'scoutingpro27' && rawName.toLowerCase() !== 'scoutingpro 27'
              ? rawName
              : code
              ? `Event ${code}`
              : 'Scouting Event'
          currentEvent.value = parsedCurrent
          setCustomTurnConfig(parsedCurrent?.customTurnConfig ?? null)
        }
      }
    } catch {}
  }

  watch(
    events,
    (evts) => {
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem('scoutingpro_events', JSON.stringify(evts))
        } catch {}
      }
    },
    { deep: true, flush: 'sync' }
  )

  watch(
    currentEvent,
    (cur) => {
      setCustomTurnConfig(cur?.customTurnConfig ?? null)
      if (typeof localStorage !== 'undefined') {
        try {
          if (cur) {
            localStorage.setItem('scoutingpro_current_event', JSON.stringify(cur))
          } else {
            localStorage.removeItem('scoutingpro_current_event')
          }
        } catch {}
      }
    },
    { deep: true, flush: 'sync' }
  )

  const isHost = computed(() => {
    // 手机端坚决不可作为主机（无例外）
    if (isMobileDevice() || !isDesktopHost()) {
      return false
    }
    const conn = useConnectionStore()
    if (conn.rtcService && typeof conn.rtcService.isHostMode === 'function' && conn.rtcService.isHostMode()) {
      return true
    }
    return Boolean(currentEvent.value?.hostId && currentEvent.value.hostId === userStore.userId)
  })

  async function fetchEvents(userId: string) {
    restoreFromCache()
    if (isStaticCloudHost()) {
      error.value = null
      return
    }
    loading.value = true
    error.value = null
    try {
      const remoteEvents = await listEvents(userId)
      if (Array.isArray(remoteEvents)) {
        const map = new Map(events.value.map(e => [e.id, e]))
        for (const re of remoteEvents) {
          map.set(re.id, re)
        }
        events.value = sanitizeEventList(Array.from(map.values()))
        if (currentEvent.value && map.has(currentEvent.value.id)) {
          currentEvent.value = map.get(currentEvent.value.id)!
        }
      }
    } catch (e: any) {
      console.warn('[eventStore] Failed to fetch events from backend:', e)
      if (!isDesktopHost() || e?.status === 404) {
        error.value = null
      } else {
        error.value = e.message ?? 'Failed to load events'
      }
    } finally {
      loading.value = false
    }
  }

  async function create(name: string): Promise<ScoutingEvent | null> {
    loading.value = true
    error.value = null
    try {
      const res = await createEvent({ name })
      const evt: ScoutingEvent = {
        id: res.id,
        name,
        inviteCode: res.inviteCode,
        hostId: userStore.userId,
      }
      const existingIdx = events.value.findIndex(e => e.id === evt.id)
      if (existingIdx >= 0) {
        events.value[existingIdx] = evt
      } else {
        events.value.push(evt)
      }
      currentEvent.value = evt
      return evt
    } catch (e: any) {
      error.value = e.message ?? 'Failed to create event'
      return null
    } finally {
      loading.value = false
    }
  }

  async function join(inviteCode: string, eventName?: string): Promise<ScoutingEvent | null> {
    loading.value = true
    error.value = null
    const cleanCode = inviteCode.trim().toUpperCase()
    try {
      const existingLocal = events.value.find(
        (e) => e.inviteCode?.trim().toUpperCase() === cleanCode && !isPlaceholderEventId(e.id)
      )

      if (!existingLocal && isDesktopHost() && !isMobileDevice() && !isStaticCloudHost()) {
        let witness = getEpochWitnessRecord(cleanCode)
        const isTestEnv =
          (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
          Boolean((globalThis as any).__vitest_worker__)
        const shouldDiscoverOnline = !isTestEnv || Boolean((globalThis as any).__TEST_ENABLE_ROOM_DISCOVERY__)

        if ((!witness || isPlaceholderEventId(witness.authoritativeEventId)) && shouldDiscoverOnline) {
          try {
            const { discoverRoomWitness } = await import('@/services/webrtc')
            const discovered = await discoverRoomWitness({
              inviteCode: cleanCode,
              userId: userStore.userId,
              username: userStore.username
            })
            if (discovered.authoritativeEventId && !isPlaceholderEventId(discovered.authoritativeEventId)) {
              witness = {
                inviteCode: cleanCode,
                authoritativeEventId: discovered.authoritativeEventId,
                eventName: discovered.eventName,
                hostUserId: discovered.hostUserId,
                ftcYear: discovered.ftcYear,
                ftcEventCode: discovered.ftcEventCode,
                highestSeenEpoch: discovered.highestSeenEpoch,
                activeHostSessionId: discovered.activeHostSessionId,
                activeHostDeviceId: discovered.activeHostDeviceId,
                updatedAt: Date.now()
              }
            }
          } catch (discErr) {
            console.warn('[eventStore] Witness discovery skipped/failed:', discErr)
          }
        }

        if (witness && witness.authoritativeEventId && !isPlaceholderEventId(witness.authoritativeEventId)) {
          const authoritativeMeta: ScoutingEvent = {
            id: witness.authoritativeEventId,
            name: witness.eventName || eventName || `Event ${cleanCode}`,
            inviteCode: cleanCode,
            hostId: witness.hostUserId || 'external_host',
            ftcYear: witness.ftcYear,
            ftcEventCode: witness.ftcEventCode
          }
          try {
            const synced = await syncExternalEvent(authoritativeMeta)
            if (synced && synced.id) {
              const existingIdx = events.value.findIndex((e) => e.id === synced.id)
              if (existingIdx >= 0) {
                events.value[existingIdx] = synced
              } else {
                events.value.push(synced)
              }
              currentEvent.value = synced
              return synced
            }
          } catch (syncErr) {
            console.warn('[eventStore] Witness external-sync fallback to joinEvent:', syncErr)
          }
        }
      }

      const evt = await joinEvent(cleanCode)
      const existingIdx = events.value.findIndex(e => e.id === evt.id)
      if (existingIdx >= 0) {
        events.value[existingIdx] = evt
      } else {
        events.value.push(evt)
      }
      currentEvent.value = evt
      return evt
    } catch (e: any) {
      // In standalone PWA / client mode without local backend API:
      const pwaEvt: ScoutingEvent = {
        id: 'evt-' + cleanCode,
        name: eventName || `Event ${cleanCode}`,
        inviteCode: cleanCode,
        hostId: 'remote-host'
      }
      const existingIdx = events.value.findIndex(e => e.inviteCode === pwaEvt.inviteCode || e.id === pwaEvt.id)
      if (existingIdx >= 0) {
        events.value[existingIdx] = pwaEvt
      } else {
        events.value.push(pwaEvt)
      }
      currentEvent.value = pwaEvt
      return pwaEvt
    } finally {
      loading.value = false
    }
  }

  async function syncExternal(event: ScoutingEvent): Promise<ScoutingEvent | null> {
    loading.value = true
    error.value = null
    try {
      const existingLocal = events.value.find(e => e.id === event.id)
      const lockedInviteCode =
        existingLocal && !isPlaceholderEventId(existingLocal.id) && existingLocal.inviteCode
          ? existingLocal.inviteCode
          : event.inviteCode
      const synced = await syncExternalEvent({ ...event, inviteCode: lockedInviteCode })
      const existingIdx = events.value.findIndex(e => e.id === synced.id)
      if (existingIdx >= 0) {
        events.value[existingIdx] = synced
      } else {
        events.value.push(synced)
      }
      currentEvent.value = synced
      return synced
    } catch (e: any) {
      error.value = e.message ?? 'Failed to sync external event'
      return null
    } finally {
      loading.value = false
    }
  }

  function setCurrentEvent(evt: ScoutingEvent | null) {
    currentEvent.value = evt
    setCustomTurnConfig(evt?.customTurnConfig ?? null)
  }

  function updateFtcConfig(eventId: string, ftcYear: number, ftcEventCode: string) {
    const target = events.value.find(e => e.id === eventId)
    if (target) {
      target.ftcYear = ftcYear
      target.ftcEventCode = ftcEventCode
    }
    if (currentEvent.value && currentEvent.value.id === eventId) {
      currentEvent.value = {
        ...currentEvent.value,
        ftcYear,
        ftcEventCode
      }
    }
  }

  function updateTurnConfig(eventId: string, config: CustomTurnConfig | null) {
    const hasCustomTurn = Boolean(config && Array.isArray(config.urls) && config.urls.length > 0)
    const normalized: CustomTurnConfig | null = hasCustomTurn ? config : null
    const target = events.value.find(e => e.id === eventId)
    if (target) {
      target.customTurnConfig = normalized
      target.hasCustomTurn = hasCustomTurn
    }
    if (currentEvent.value && currentEvent.value.id === eventId) {
      currentEvent.value = {
        ...currentEvent.value,
        customTurnConfig: normalized,
        hasCustomTurn
      }
      setCustomTurnConfig(normalized)
    }
  }

  function clearError() {
    error.value = null
  }

  async function deleteEvent(eventId: string) {
    events.value = events.value.filter((e) => e.id !== eventId)
    if (currentEvent.value?.id === eventId) {
      currentEvent.value = null
    }
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('scoutingpro_events', JSON.stringify(events.value))
        if (currentEvent.value === null) {
          localStorage.removeItem('scoutingpro_current_event')
        }
        localStorage.removeItem(`scoutingpro27_schedule_${eventId}`)
        localStorage.removeItem(`scoutingpro27_assignments_${eventId}`)
        localStorage.removeItem(`sp27_records_${eventId}`)
        localStorage.removeItem(`sp27_pit_records_${eventId}`)
        localStorage.removeItem(`sp27_pit_teams_${eventId}`)
        localStorage.removeItem(`sp27_cf_${eventId}`)
        localStorage.removeItem(`sp27_custom_fields_${eventId}`)
        localStorage.removeItem(`sp27_team_tags_${eventId}`)
        localStorage.removeItem(`sp27_known_scouts_${eventId}`)
        localStorage.removeItem(`sp27_official_matches_${eventId}`)
        localStorage.removeItem(`sp27_advancement_${eventId}`)
        localStorage.removeItem(`sp27_banned_teams_${eventId}`)
        // 同步清理全局合并存储中属于该赛事的记录与标签
        try {
          const rawRecs = localStorage.getItem('scoutingpro_records')
          if (rawRecs) {
            const kept = JSON.parse(rawRecs).filter((r: any) => r.eventId !== eventId)
            localStorage.setItem('scoutingpro_records', JSON.stringify(kept))
          }
          const rawTags = localStorage.getItem('scoutingpro_tags')
          if (rawTags) {
            const keptTags = JSON.parse(rawTags).filter((t: any) => t.eventId !== eventId)
            localStorage.setItem('scoutingpro_tags', JSON.stringify(keptTags))
          }
        } catch {}
      } catch {}
    }
    try {
      const { deleteEvent: apiDeleteEvent } = await import('@/services/api')
      await apiDeleteEvent(eventId)
    } catch (e) {
      console.warn('[eventStore] Failed to delete event on backend API:', e)
    }
  }

  function migratePlaceholder(placeholderId: string, authoritativeEvent: ScoutingEvent) {
    if (!authoritativeEvent || !authoritativeEvent.id) return
    const targetPlaceholder = placeholderId.trim().toLowerCase()
    const authInviteCode = (authoritativeEvent.inviteCode || '').trim().toUpperCase()

    const cleanList = events.value.filter((e) => {
      const eId = (e.id || '').trim().toLowerCase()
      const eCode = (e.inviteCode || '').trim().toUpperCase()
      if (eId === targetPlaceholder || e.id === authoritativeEvent.id) return false
      if ((eId.startsWith('evt-') || eId.startsWith('ext_')) && authInviteCode && eCode === authInviteCode) return false
      return true
    })
    cleanList.push(authoritativeEvent)
    events.value = sanitizeEventList(cleanList)
    if (
      currentEvent.value &&
      (currentEvent.value.id.trim().toLowerCase() === targetPlaceholder ||
        currentEvent.value.id === authoritativeEvent.id ||
        (currentEvent.value.inviteCode &&
          currentEvent.value.inviteCode.trim().toUpperCase() === authInviteCode))
    ) {
      currentEvent.value = authoritativeEvent
    }
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('scoutingpro_events', JSON.stringify(events.value))
        if (currentEvent.value) {
          localStorage.setItem('scoutingpro_current_event', JSON.stringify(currentEvent.value))
        }
      } catch {}
    }
  }

  function clearUserSessionCache() {
    events.value = []
    currentEvent.value = null
    setCustomTurnConfig(null)
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem('scoutingpro_events')
        localStorage.removeItem('scoutingpro_current_event')
      } catch {}
    }
  }

  function clearAllLocalCache() {
    events.value = []
    currentEvent.value = null
    if (typeof localStorage !== 'undefined') {
      try {
        const toRemove: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (
            key &&
            key !== 'scoutingpro-user' &&
            (key.startsWith('scoutingpro_') ||
              key.startsWith('scoutingpro27_') ||
              key.startsWith('sp27_') ||
              key.startsWith('sp_inbox_') ||
              key.startsWith('sp_outbox_') ||
              key.startsWith('inbox-messages-') ||
              key.startsWith('inbox-outbox-'))
          ) {
            toRemove.push(key)
          }
        }
        for (const k of toRemove) {
          localStorage.removeItem(k)
        }
      } catch {}
    }
  }

  return {
    events,
    currentEvent,
    loading,
    error,
    isHost,
    fetchEvents,
    create,
    join,
    syncExternal,
    setCurrentEvent,
    updateFtcConfig,
    updateTurnConfig,
    clearError,
    restoreFromCache,
    deleteEvent,
    migratePlaceholder,
    clearUserSessionCache,
    clearAllLocalCache,
  }
})

