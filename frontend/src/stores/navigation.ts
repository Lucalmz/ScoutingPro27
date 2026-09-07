import { defineStore } from 'pinia'
import { ref } from 'vue'

export type EventTab = 'scout' | 'rankings' | 'history' | 'schedule' | 'scouts' | 'ai' | 'pit'

export interface EventNavigationState {
  eventId: string
  fromTab: EventTab
  contentScrollTop: number
  contentScrollLeft: number
  tableScrollLeft: number
  teamNumber: number | null
  aiChatScrollTop: number | null
  timestamp: number
}

const STORAGE_PREFIX = 'sp27_nav_pos_'

function loadFromStorage(eventId: string): EventNavigationState | null {
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${eventId}`)
    if (raw) {
      return JSON.parse(raw) as EventNavigationState
    }
  } catch {
    // ignore parse error
  }
  return null
}

function saveToStorage(state: EventNavigationState) {
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${state.eventId}`, JSON.stringify(state))
  } catch {
    // ignore storage error
  }
}

function removeFromStorage(eventId: string) {
  try {
    sessionStorage.removeItem(`${STORAGE_PREFIX}${eventId}`)
  } catch {
    // ignore storage error
  }
}

export const useNavigationStore = defineStore('navigation', () => {
  const savedPositions = ref<Record<string, EventNavigationState>>({})

  function saveEventPosition(params: {
    eventId: string
    fromTab: EventTab
    contentScrollTop?: number
    contentScrollLeft?: number
    tableScrollLeft?: number
    teamNumber?: number | null
    aiChatScrollTop?: number | null
  }) {
    const state: EventNavigationState = {
      eventId: params.eventId,
      fromTab: params.fromTab,
      contentScrollTop: params.contentScrollTop ?? 0,
      contentScrollLeft: params.contentScrollLeft ?? 0,
      tableScrollLeft: params.tableScrollLeft ?? 0,
      teamNumber: params.teamNumber ?? null,
      aiChatScrollTop: params.aiChatScrollTop ?? null,
      timestamp: Date.now()
    }
    savedPositions.value[params.eventId] = state
    saveToStorage(state)
  }

  function getEventPosition(eventId: string): EventNavigationState | null {
    if (savedPositions.value[eventId]) {
      return savedPositions.value[eventId]
    }
    const fromStorage = loadFromStorage(eventId)
    if (fromStorage) {
      savedPositions.value[eventId] = fromStorage
      return fromStorage
    }
    return null
  }

  function consumeEventPosition(eventId: string): EventNavigationState | null {
    const pos = getEventPosition(eventId)
    if (pos) {
      delete savedPositions.value[eventId]
      removeFromStorage(eventId)
      return pos
    }
    return null
  }

  function clearEventPosition(eventId: string) {
    delete savedPositions.value[eventId]
    removeFromStorage(eventId)
  }

  return {
    savedPositions,
    saveEventPosition,
    getEventPosition,
    consumeEventPosition,
    clearEventPosition,
  }
})
