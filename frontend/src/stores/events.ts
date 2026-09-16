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

  function restoreFromCache() {
    if (typeof localStorage === 'undefined') return
    try {
      const rawEvents = localStorage.getItem('scoutingpro_events')
      if (rawEvents && events.value.length === 0) {
        events.value = JSON.parse(rawEvents)
      }
      const rawCurrent = localStorage.getItem('scoutingpro_current_event')
      if (rawCurrent && !currentEvent.value) {
        currentEvent.value = JSON.parse(rawCurrent)
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
    if (conn.rtcService && typeof conn.rtcService.isHostMode === 'function') {
      return conn.rtcService.isHostMode()
    }
    if (!isDesktopHost()) {
      return false
    }
    return currentEvent.value?.hostId === userStore.userId
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
        events.value = Array.from(map.values())
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
  }
})

