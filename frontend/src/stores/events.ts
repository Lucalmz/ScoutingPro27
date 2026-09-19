import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { listEvents, createEvent, joinEvent, syncExternalEvent, isStaticCloudHost } from '@/services/api'
import { isDesktopHost } from '@/services/photoStorage'
import { useUserStore } from '@/stores/user'
import { useConnectionStore } from '@/stores/connection'
import type { ScoutingEvent } from '@/types'

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
      if (!id.startsWith('evt-') && inviteCode) {
        codeToAuthoritative.set(inviteCode, sanitized)
      }
    }

    // Second pass: eliminate placeholders if authoritative exists, and deduplicate
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const id = String(item.id || '').trim()
      if (!id || seenIds.has(id)) continue
      const inviteCode = String(item.inviteCode || '').trim().toUpperCase()
      if (id.startsWith('evt-') && inviteCode && codeToAuthoritative.has(inviteCode)) {
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
    { deep: true }
  )

  watch(
    currentEvent,
    (cur) => {
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
    { deep: true }
  )

  const isHost = computed(() => {
    const conn = useConnectionStore()
    if (conn.rtcService && typeof conn.rtcService.isHostMode === 'function' && conn.rtcService.isHostMode()) {
      return true
    }
    if (!isDesktopHost()) {
      return false
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
      const synced = await syncExternalEvent(event)
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
        localStorage.removeItem(`sp27_team_tags_${eventId}`)
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
      if (eId.startsWith('evt-') && authInviteCode && eCode === authInviteCode) return false
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
              key.startsWith('sp_outbox_'))
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
    clearError,
    restoreFromCache,
    deleteEvent,
    migratePlaceholder,
    clearAllLocalCache,
  }
})

