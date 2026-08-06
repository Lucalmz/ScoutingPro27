import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { listEvents, createEvent, joinEvent } from '@/services/api'
import { useUserStore } from '@/stores/user'
import type { ScoutingEvent } from '@/types'

export const useEventStore = defineStore('events', () => {
  const events = ref<ScoutingEvent[]>([])
  const currentEvent = ref<ScoutingEvent | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  
  const userStore = useUserStore()

  const isHost = computed(() => {
    return currentEvent.value?.hostId === userStore.userId
  })

  async function fetchEvents(userId: string) {
    loading.value = true
    error.value = null
    try {
      events.value = await listEvents(userId)
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load events'
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
      events.value.push(evt)
      currentEvent.value = evt
      return evt
    } catch (e: any) {
      error.value = e.message ?? 'Failed to create event'
      return null
    } finally {
      loading.value = false
    }
  }

  async function join(inviteCode: string, eventName: string): Promise<ScoutingEvent | null> {
    loading.value = true
    error.value = null
    try {
      const evt = await joinEvent(inviteCode)
      // Note: we can ignore eventName since the real name comes from evt
      events.value.push(evt)
      currentEvent.value = evt
      return evt
    } catch (e: any) {
      error.value = e.message ?? 'Failed to join event'
      return null
    } finally {
      loading.value = false
    }
  }

  function setCurrentEvent(evt: ScoutingEvent | null) {
    currentEvent.value = evt
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
    setCurrentEvent,
    clearError,
  }
})
