import { ref, computed } from 'vue'
import type { CustomFieldDefinition, ScoutingRecord } from '@/types'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { useCustomFieldsStore } from '@/stores/customFields'
import { hapticLight } from '@/utils/haptics'

export interface TeamCustomStat {
  value: number
  display: string
  count: number
}

export function parseCustomFields(
  record: { customFields?: Record<string, any>; rawData?: string } | null | undefined
): Record<string, any> {
  if (!record) return {}
  if (record.customFields && Object.keys(record.customFields).length > 0) {
    return record.customFields
  }
  if (record.rawData) {
    try {
      const parsed = typeof record.rawData === 'string' ? JSON.parse(record.rawData) : record.rawData
      return parsed.customFields || {}
    } catch {
      return {}
    }
  }
  return {}
}

export function computeTeamCustomStatsMap(
  records: ScoutingRecord[],
  fields: CustomFieldDefinition[]
): Map<number, Record<string, TeamCustomStat>> {
  const map = new Map<number, Record<string, TeamCustomStat>>()
  if (fields.length === 0) return map

  const teamRecords = new Map<number, ScoutingRecord[]>()
  for (const r of records) {
    if (!teamRecords.has(r.teamNumber)) {
      teamRecords.set(r.teamNumber, [])
    }
    teamRecords.get(r.teamNumber)!.push(r)
  }

  for (const [teamNum, recs] of teamRecords.entries()) {
    const stats: Record<string, TeamCustomStat> = {}

    for (const f of fields) {
      if (f.fieldType === 'number' || f.fieldType === 'level') {
        let sum = 0
        let count = 0
        for (const r of recs) {
          const cf = parseCustomFields(r)
          const val = cf[f.fieldKey]
          if (val !== undefined && val !== null && val !== '') {
            const num = Number(val)
            if (!isNaN(num)) {
              sum += num
              count++
            }
          }
        }
        if (count > 0) {
          const avg = sum / count
          stats[f.fieldKey] = {
            value: avg,
            display: avg.toFixed(1),
            count
          }
        }
      } else if (f.fieldType === 'boolean') {
        let trueCount = 0
        let count = 0
        for (const r of recs) {
          const cf = parseCustomFields(r)
          const val = cf[f.fieldKey]
          if (val !== undefined && val !== null) {
            count++
            if (val === true || val === 'true' || val === 1) {
              trueCount++
            }
          }
        }
        if (count > 0) {
          const rate = (trueCount / count) * 100
          stats[f.fieldKey] = {
            value: rate,
            display: `${rate.toFixed(0)}%`,
            count
          }
        }
      }
    }
    map.set(teamNum, stats)
  }
  return map
}

export function loadCustomColKeys(): string[] {
  try {
    const raw = localStorage.getItem('scoutingpro_rankings_custom_cols')
    if (raw) return JSON.parse(raw)
  } catch {}
  return []
}

export function saveCustomColKeys(keys: string[]) {
  try {
    localStorage.setItem('scoutingpro_rankings_custom_cols', JSON.stringify(keys))
  } catch {}
}

export function useRankingsCustomColumns() {
  const eventStore = useEventStore()
  const recordStore = useRecordStore()
  const customFieldsStore = useCustomFieldsStore()

  const availableCustomFields = computed<CustomFieldDefinition[]>(() => {
    const eventId = eventStore.currentEvent?.id
    if (!eventId) return []
    return customFieldsStore.getActiveFields(eventId, 'MATCH').filter(
      f => f.fieldType === 'number' || f.fieldType === 'level' || f.fieldType === 'boolean'
    )
  })

  const showCustomColsDropdown = ref(false)
  const selectedCustomKeys = ref<string[]>(loadCustomColKeys())

  function toggleCustomCol(key: string) {
    hapticLight()
    const idx = selectedCustomKeys.value.indexOf(key)
    if (idx !== -1) {
      selectedCustomKeys.value.splice(idx, 1)
    } else {
      selectedCustomKeys.value.push(key)
    }
    saveCustomColKeys(selectedCustomKeys.value)
  }

  function selectAllCustomCols() {
    hapticLight()
    selectedCustomKeys.value = availableCustomFields.value.map(f => f.fieldKey)
    saveCustomColKeys(selectedCustomKeys.value)
  }

  function clearAllCustomCols() {
    hapticLight()
    selectedCustomKeys.value = []
    saveCustomColKeys([])
  }

  const visibleCustomFields = computed(() => {
    return availableCustomFields.value.filter(f => selectedCustomKeys.value.includes(f.fieldKey))
  })

  const teamCustomStats = computed(() => {
    const eventId = eventStore.currentEvent?.id
    const records = recordStore.activeRecords.filter(r => !eventId || r.eventId === eventId)
    return computeTeamCustomStatsMap(records, availableCustomFields.value)
  })

  return {
    availableCustomFields,
    showCustomColsDropdown,
    selectedCustomKeys,
    visibleCustomFields,
    teamCustomStats,
    toggleCustomCol,
    selectAllCustomCols,
    clearAllCustomCols
  }
}
