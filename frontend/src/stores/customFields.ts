import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  CustomFieldDefinition,
  CustomFieldTarget,
  CustomFieldPhase,
  WebRtcCustomFieldUpdate,
  WebRtcCustomFieldsFullSync
} from '@/types'
import {
  fetchCustomFields as apiFetchCustomFields,
  createCustomField as apiCreateCustomField,
  updateCustomField as apiUpdateCustomField,
  deleteCustomField as apiDeleteCustomField
} from '@/services/api'
import { useConnectionStore } from './connection'
import { useEventStore } from './events'

const STORAGE_PREFIX = 'sp27_custom_fields_'

export const useCustomFieldsStore = defineStore('customFields', () => {
  const fieldsByEvent = ref<Record<string, CustomFieldDefinition[]>>({})
  const loading = ref<boolean>(false)
  const error = ref<string | null>(null)

  function loadFromLocalStorage(eventId: string) {
    if (!eventId) return
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}${eventId}`)
      if (raw) {
        fieldsByEvent.value[eventId] = JSON.parse(raw)
      }
    } catch (e) {
      console.warn('[CustomFieldsStore] Error reading localStorage:', e)
    }
  }

  function saveToLocalStorage(eventId: string) {
    if (!eventId) return
    try {
      const list = fieldsByEvent.value[eventId] || []
      localStorage.setItem(`${STORAGE_PREFIX}${eventId}`, JSON.stringify(list))
    } catch (e) {
      console.warn('[CustomFieldsStore] Error saving to localStorage:', e)
    }
  }

  function parseFieldOptions(field: CustomFieldDefinition): CustomFieldDefinition {
    if (field.optionsJson && (!field.options || field.options.length === 0)) {
      try {
        field.options = JSON.parse(field.optionsJson)
      } catch {
        field.options = []
      }
    }
    return field
  }

  function getFields(
    eventId: string,
    target?: CustomFieldTarget,
    phase?: CustomFieldPhase
  ): CustomFieldDefinition[] {
    if (!eventId) return []
    if (!fieldsByEvent.value[eventId]) {
      loadFromLocalStorage(eventId)
    }
    const list = fieldsByEvent.value[eventId] || []
    return list
      .map(parseFieldOptions)
      .filter((f) => {
        if (target && f.target !== target) return false
        if (phase && f.phase !== phase) return false
        return true
      })
      .sort((a, b) => a.orderSeq - b.orderSeq)
  }

  function getActiveFields(
    eventId: string,
    target: CustomFieldTarget,
    phase?: CustomFieldPhase
  ): CustomFieldDefinition[] {
    return getFields(eventId, target, phase).filter((f) => f.isActive)
  }

  async function fetchFields(eventId: string): Promise<CustomFieldDefinition[]> {
    if (!eventId) return []
    loadFromLocalStorage(eventId)
    loading.value = true
    error.value = null

    try {
      const res = await apiFetchCustomFields(eventId)
      const parsed = res.map(parseFieldOptions)
      fieldsByEvent.value[eventId] = parsed
      saveToLocalStorage(eventId)
      return parsed
    } catch (e: any) {
      // 离线环境平滑回退至本地缓存
      error.value = e?.message || 'Failed to fetch custom fields'
      return fieldsByEvent.value[eventId] || []
    } finally {
      loading.value = false
    }
  }

  function broadcastFieldUpdate(
    eventId: string,
    field: CustomFieldDefinition,
    action: 'CREATE' | 'UPDATE' | 'DELETE'
  ) {
    const connStore = useConnectionStore()
    const eventStore = useEventStore()
    if (eventStore.isHost && connStore.rtcService) {
      const msg: WebRtcCustomFieldUpdate = {
        type: 'CUSTOM_FIELD_UPDATE',
        eventId,
        field,
        action
      }
      connStore.rtcService.sendMessage(msg)
    }
  }

  async function createField(
    eventId: string,
    def: Partial<CustomFieldDefinition>,
    broadcast = true
  ): Promise<CustomFieldDefinition> {
    const created = await apiCreateCustomField(eventId, def)
    parseFieldOptions(created)
    if (!fieldsByEvent.value[eventId]) {
      fieldsByEvent.value[eventId] = []
    }
    fieldsByEvent.value[eventId].push(created)
    saveToLocalStorage(eventId)

    if (broadcast) {
      broadcastFieldUpdate(eventId, created, 'CREATE')
    }
    return created
  }

  async function updateField(
    eventId: string,
    id: string,
    def: Partial<CustomFieldDefinition>,
    broadcast = true
  ): Promise<CustomFieldDefinition> {
    const updated = await apiUpdateCustomField(eventId, id, def)
    parseFieldOptions(updated)
    const list = fieldsByEvent.value[eventId] || []
    const idx = list.findIndex((f) => f.id === id)
    if (idx !== -1) {
      list[idx] = updated
    } else {
      list.push(updated)
    }
    fieldsByEvent.value[eventId] = [...list]
    saveToLocalStorage(eventId)

    if (broadcast) {
      broadcastFieldUpdate(eventId, updated, 'UPDATE')
    }
    return updated
  }

  async function deleteField(
    eventId: string,
    id: string,
    broadcast = true
  ): Promise<void> {
    await apiDeleteCustomField(eventId, id)
    const list = fieldsByEvent.value[eventId] || []
    const targetField = list.find((f) => f.id === id)
    fieldsByEvent.value[eventId] = list.filter((f) => f.id !== id)
    saveToLocalStorage(eventId)

    if (broadcast && targetField) {
      broadcastFieldUpdate(eventId, targetField, 'DELETE')
    }
  }

  async function toggleFieldActive(
    eventId: string,
    id: string,
    broadcast = true
  ): Promise<CustomFieldDefinition | null> {
    const list = fieldsByEvent.value[eventId] || []
    const target = list.find((f) => f.id === id)
    if (!target) return null
    return updateField(eventId, id, { ...target, isActive: !target.isActive }, broadcast)
  }

  async function moveFieldOrder(
    eventId: string,
    id: string,
    direction: 'up' | 'down',
    target: CustomFieldTarget
  ): Promise<void> {
    const list = getFields(eventId, target)
    const idx = list.findIndex((f) => f.id === id)
    if (idx === -1) return

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= list.length) return

    const curr = list[idx]!
    const other = list[swapIdx]!

    const currSeq = curr.orderSeq
    const otherSeq = other.orderSeq

    // 交换顺序
    curr.orderSeq = otherSeq
    other.orderSeq = currSeq

    await updateField(eventId, curr.id, { ...curr, orderSeq: curr.orderSeq })
    await updateField(eventId, other.id, { ...other, orderSeq: other.orderSeq })
  }

  // WebRTC 同步接入方法
  function applyFullSync(eventId: string, incomingFields: CustomFieldDefinition[]) {
    if (!eventId || !Array.isArray(incomingFields)) return
    const parsed = incomingFields.map(parseFieldOptions)
    fieldsByEvent.value[eventId] = parsed
    saveToLocalStorage(eventId)
  }

  function applyRemoteUpdate(
    eventId: string,
    field: CustomFieldDefinition,
    action: 'CREATE' | 'UPDATE' | 'DELETE'
  ) {
    if (!eventId || !field) return
    parseFieldOptions(field)
    if (!fieldsByEvent.value[eventId]) {
      loadFromLocalStorage(eventId)
      if (!fieldsByEvent.value[eventId]) {
        fieldsByEvent.value[eventId] = []
      }
    }
    const list = fieldsByEvent.value[eventId]!
    const idx = list.findIndex((f) => f.id === field.id)

    if (action === 'CREATE') {
      if (idx === -1) {
        list.push(field)
      } else {
        list[idx] = field
      }
    } else if (action === 'UPDATE') {
      if (idx !== -1) {
        list[idx] = field
      } else {
        list.push(field)
      }
    } else if (action === 'DELETE') {
      if (idx !== -1) {
        list.splice(idx, 1)
      }
    }
    fieldsByEvent.value[eventId] = [...list]
    saveToLocalStorage(eventId)
  }

  return {
    fieldsByEvent,
    loading,
    error,
    loadFromLocalStorage,
    saveToLocalStorage,
    getFields,
    getActiveFields,
    fetchFields,
    createField,
    updateField,
    deleteField,
    toggleFieldActive,
    moveFieldOrder,
    applyFullSync,
    applyRemoteUpdate
  }
})
