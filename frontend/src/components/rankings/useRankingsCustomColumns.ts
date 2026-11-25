import { ref, computed, type Ref } from 'vue'
import type {
  CustomFieldAggregationMode,
  CustomFieldDefinition,
  CustomFieldOption,
  PitScoutingRecord,
  RankingRow,
  ScoutingRecord
} from '@/types'
import { useEventStore } from '@/stores/events'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import { useCustomFieldsStore } from '@/stores/customFields'
import { hapticLight } from '@/utils/haptics'
import {
  buildMatchFormulaContext,
  buildPitFormulaContext,
  buildTeamFormulaContext,
  evaluateFormula,
  resolveCustomFieldNumericValue,
  topologicalSortFormulas
} from '@/utils/formula'

export type TierBadgeLevel = 'high' | 'mid' | 'low' | null

export interface TeamCustomStat {
  value: number
  display: string
  count: number
  tier?: TierBadgeLevel
  error?: string | null
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

function parseFieldOptions(def: CustomFieldDefinition): CustomFieldOption[] {
  if (Array.isArray(def.options) && def.options.length > 0) return def.options
  if (typeof def.optionsJson === 'string' && def.optionsJson.trim()) {
    try {
      const parsed = JSON.parse(def.optionsJson)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

export function hasWeightedOptions(def: CustomFieldDefinition): boolean {
  if (def.fieldType !== 'select' && def.fieldType !== 'multi_select') return false
  return parseFieldOptions(def).some(
    (opt) => typeof opt.numericValue === 'number' && Number.isFinite(opt.numericValue)
  )
}

export function isSelectableCustomColumnField(def: CustomFieldDefinition): boolean {
  if (!def.isActive) return false
  if (def.target === 'TEAM') {
    return def.fieldType === 'formula'
  }
  if (def.target === 'MATCH' || def.target === 'PIT') {
    if (
      def.fieldType === 'number' ||
      def.fieldType === 'timer' ||
      def.fieldType === 'level' ||
      def.fieldType === 'boolean' ||
      def.fieldType === 'formula'
    ) {
      return true
    }
    if (def.fieldType === 'select' || def.fieldType === 'multi_select') {
      return hasWeightedOptions(def)
    }
  }
  return false
}

export function aggregateNumericValues(
  values: number[],
  mode: CustomFieldAggregationMode = 'avg'
): number | null {
  if (values.length === 0) return null
  switch (mode) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0)
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
    case 'median': {
      const s = values.slice().sort((a, b) => a - b)
      const mid = Math.floor(s.length / 2)
      return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
    }
    case 'last3': {
      const recent = values.slice(-3)
      return recent.reduce((a, b) => a + b, 0) / recent.length
    }
    case 'trimmed_avg': {
      const s = values.slice().sort((a, b) => a - b)
      const sliced = s.length >= 3 ? s.slice(1, s.length - 1) : s
      return sliced.reduce((a, b) => a + b, 0) / sliced.length
    }
    case 'stddev': {
      const mean = values.reduce((a, b) => a + b, 0) / values.length
      const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length
      return Math.sqrt(variance)
    }
    case 'rate': {
      const hits = values.filter((v) => v > 0).length
      return hits / values.length
    }
    case 'avg':
    default:
      return values.reduce((a, b) => a + b, 0) / values.length
  }
}

export function computeTierBadge(val: number, field: CustomFieldDefinition): TierBadgeLevel {
  const thresholds = field.config?.tierThresholds
  if (!thresholds || (thresholds.high === undefined && thresholds.mid === undefined)) {
    return null
  }
  const direction = thresholds.direction ?? 'higher_better'
  if (direction === 'lower_better') {
    if (thresholds.high !== undefined && val <= thresholds.high) return 'high'
    if (thresholds.mid !== undefined && val <= thresholds.mid) return 'mid'
    return 'low'
  }
  if (thresholds.high !== undefined && val >= thresholds.high) return 'high'
  if (thresholds.mid !== undefined && val >= thresholds.mid) return 'mid'
  return 'low'
}

export function formatCustomStatValue(val: number, field: CustomFieldDefinition): string {
  const format =
    field.displayFormat ?? (field.fieldType === 'boolean' && field.target === 'MATCH' ? 'percent' : 'number')
  const decimals = field.config?.decimalPlaces

  switch (format) {
    case 'integer':
      return Math.round(val).toString()
    case 'percent': {
      const pctDecimals = decimals ?? (field.fieldType === 'boolean' ? 0 : 1)
      return `${(val * 100).toFixed(pctDecimals)}%`
    }
    case 'boolean':
      return val >= 0.5 ? (field.config?.trueLabel || '✓') : (field.config?.falseLabel || '✗')
    case 'tier':
    case 'number':
    default: {
      const numDecimals = decimals ?? 1
      return val.toFixed(numDecimals)
    }
  }
}

export interface ComputeTeamCustomStatsOptions {
  rankings?: RankingRow[]
  pitRecords?: PitScoutingRecord[]
  allFields?: CustomFieldDefinition[]
}

export function computeTeamCustomStatsMap(
  records: ScoutingRecord[],
  fields: CustomFieldDefinition[],
  options: ComputeTeamCustomStatsOptions = {}
): Map<number, Record<string, TeamCustomStat>> {
  const map = new Map<number, Record<string, TeamCustomStat>>()
  if (fields.length === 0) return map

  const allFields = options.allFields && options.allFields.length > 0 ? options.allFields : fields
  const { sorted: sortedFormulas, cyclicKeys } = topologicalSortFormulas(allFields)
  const cyclicSet = new Set(cyclicKeys)

  const matchFormulas = sortedFormulas.filter((f) => f.target === 'MATCH')
  const pitFormulas = sortedFormulas.filter((f) => f.target === 'PIT')
  const teamFormulas = sortedFormulas.filter((f) => f.target === 'TEAM')

  const rankingByTeam = new Map<number, RankingRow>()
  for (const row of options.rankings ?? []) {
    rankingByTeam.set(row.teamNumber, row)
  }

  const pitByTeam = new Map<number, PitScoutingRecord>()
  for (const pit of options.pitRecords ?? []) {
    if (!pit.isDeleted) {
      pitByTeam.set(pit.teamNumber, pit)
    }
  }

  const teamRecords = new Map<number, ScoutingRecord[]>()
  for (const r of records) {
    if (r.isDeleted) continue
    if (!teamRecords.has(r.teamNumber)) {
      teamRecords.set(r.teamNumber, [])
    }
    teamRecords.get(r.teamNumber)!.push(r)
  }

  const allTeamNumbers = new Set<number>([
    ...teamRecords.keys(),
    ...rankingByTeam.keys(),
    ...pitByTeam.keys()
  ])

  const matchTargetFields = fields.filter((f) => f.target === 'MATCH')
  const pitTargetFields = fields.filter((f) => f.target === 'PIT')
  const teamTargetFields = fields.filter((f) => f.target === 'TEAM')

  for (const teamNum of allTeamNumbers) {
    const stats: Record<string, TeamCustomStat> = {}
    const rawRecs = (teamRecords.get(teamNum) ?? [])
      .filter((r) => !r.isBroken)
      .slice()
      .sort((a, b) => a.matchNumber - b.matchNumber)

    // 1. Evaluate MATCH formulas per match and collect all MATCH field values
    const matchValuesByKey = new Map<string, number[]>()
    const matchFormulaErrors = new Map<string, string>()
    for (const ck of cyclicKeys) {
      matchFormulaErrors.set(ck, 'CIRCULAR_DEPENDENCY')
    }

    for (const r of rawRecs) {
      const cf = parseCustomFields(r)
      const perMatchFormulaValues: Record<string, number | null> = {}

      for (const mf of matchFormulas) {
        if (cyclicSet.has(mf.fieldKey)) {
          perMatchFormulaValues[mf.fieldKey] = null
          matchFormulaErrors.set(mf.fieldKey, 'CIRCULAR_DEPENDENCY')
          continue
        }
        if (!mf.formulaExpr?.trim()) {
          perMatchFormulaValues[mf.fieldKey] = null
          continue
        }
        const ctx = buildMatchFormulaContext({
          record: r,
          customFieldValues: cf,
          fieldDefinitions: allFields,
          formulaValues: perMatchFormulaValues
        })
        const res = evaluateFormula(mf.formulaExpr, ctx, {
          target: 'MATCH',
          fieldKey: mf.fieldKey
        })
        perMatchFormulaValues[mf.fieldKey] = res.value
        if (res.error && res.value === null) {
          matchFormulaErrors.set(mf.fieldKey, res.error)
        }
      }

      for (const f of matchTargetFields) {
        let num: number | null = null
        if (f.fieldType === 'formula') {
          num = perMatchFormulaValues[f.fieldKey] ?? null
        } else {
          num = resolveCustomFieldNumericValue(cf[f.fieldKey], f)
        }
        if (num !== null && Number.isFinite(num)) {
          if (!matchValuesByKey.has(f.fieldKey)) {
            matchValuesByKey.set(f.fieldKey, [])
          }
          matchValuesByKey.get(f.fieldKey)!.push(num)
        }
      }
    }

    const aggregatedMatchFormulaValues: Record<string, number | null> = {}
    for (const f of matchTargetFields) {
      const vals = matchValuesByKey.get(f.fieldKey) ?? []
      if (vals.length > 0) {
        const defaultMode: CustomFieldAggregationMode =
          f.fieldType === 'boolean' ? 'rate' : 'avg'
        const agg = aggregateNumericValues(vals, f.aggregationMode ?? defaultMode)
        if (agg !== null && Number.isFinite(agg)) {
          if (f.fieldType === 'formula') {
            aggregatedMatchFormulaValues[f.fieldKey] = agg
          }
          stats[f.fieldKey] = {
            value: agg,
            display: formatCustomStatValue(agg, f),
            count: vals.length,
            tier: computeTierBadge(agg, f)
          }
        }
      } else if (f.fieldType === 'formula' && matchFormulaErrors.has(f.fieldKey)) {
        stats[f.fieldKey] = {
          value: Number.NaN,
          display: '⚠',
          count: 0,
          error: matchFormulaErrors.get(f.fieldKey)
        }
      }
    }

    // 2. Evaluate PIT fields and PIT formulas
    const pitRecord = pitByTeam.get(teamNum)
    const pitFormulaValues: Record<string, number | null> = {}
    const pitFormulaErrors = new Map<string, string>()
    for (const ck of cyclicKeys) {
      pitFormulaErrors.set(ck, 'CIRCULAR_DEPENDENCY')
    }

    if (pitRecord) {
      for (const pf of pitFormulas) {
        if (cyclicSet.has(pf.fieldKey)) {
          pitFormulaValues[pf.fieldKey] = null
          pitFormulaErrors.set(pf.fieldKey, 'CIRCULAR_DEPENDENCY')
          continue
        }
        if (!pf.formulaExpr?.trim()) {
          pitFormulaValues[pf.fieldKey] = null
          continue
        }
        const ctx = buildPitFormulaContext({
          pitRecord,
          fieldDefinitions: allFields,
          formulaValues: pitFormulaValues
        })
        const res = evaluateFormula(pf.formulaExpr, ctx, {
          target: 'PIT',
          fieldKey: pf.fieldKey
        })
        pitFormulaValues[pf.fieldKey] = res.value
        if (res.error && res.value === null) {
          pitFormulaErrors.set(pf.fieldKey, res.error)
        }
      }

      for (const f of pitTargetFields) {
        let num: number | null = null
        if (f.fieldType === 'formula') {
          num = pitFormulaValues[f.fieldKey] ?? null
        } else {
          num = resolveCustomFieldNumericValue(pitRecord.customFields?.[f.fieldKey], f)
        }
        if (num !== null && Number.isFinite(num)) {
          stats[f.fieldKey] = {
            value: num,
            display: formatCustomStatValue(num, f),
            count: 1,
            tier: computeTierBadge(num, f)
          }
        } else if (f.fieldType === 'formula' && pitFormulaErrors.has(f.fieldKey)) {
          stats[f.fieldKey] = {
            value: Number.NaN,
            display: '⚠',
            count: 0,
            error: pitFormulaErrors.get(f.fieldKey)
          }
        }
      }
    }

    // 3. Evaluate TEAM formulas in topological order
    if (teamTargetFields.length > 0 || teamFormulas.length > 0) {
      const teamFormulaValues: Record<string, number | null> = {
        ...aggregatedMatchFormulaValues,
        ...pitFormulaValues
      }
      const teamFormulaErrors = new Map<string, string>()
      for (const ck of cyclicKeys) {
        teamFormulaErrors.set(ck, 'CIRCULAR_DEPENDENCY')
      }
      const rankingRow = rankingByTeam.get(teamNum)

      for (const tf of teamFormulas) {
        if (cyclicSet.has(tf.fieldKey)) {
          teamFormulaValues[tf.fieldKey] = null
          teamFormulaErrors.set(tf.fieldKey, 'CIRCULAR_DEPENDENCY')
          continue
        }
        if (!tf.formulaExpr?.trim()) {
          teamFormulaValues[tf.fieldKey] = null
          continue
        }
        const ctx = buildTeamFormulaContext({
          rankingRow,
          pitRecord,
          matchRecords: rawRecs,
          fieldDefinitions: allFields,
          formulaValues: teamFormulaValues
        })
        const res = evaluateFormula(tf.formulaExpr, ctx, {
          target: 'TEAM',
          fieldKey: tf.fieldKey
        })
        teamFormulaValues[tf.fieldKey] = res.value
        if (res.error && res.value === null) {
          teamFormulaErrors.set(tf.fieldKey, res.error)
        }
      }

      for (const f of teamTargetFields) {
        const val = teamFormulaValues[f.fieldKey]
        if (typeof val === 'number' && Number.isFinite(val)) {
          stats[f.fieldKey] = {
            value: val,
            display: formatCustomStatValue(val, f),
            count: rawRecs.length,
            tier: computeTierBadge(val, f)
          }
        } else if (teamFormulaErrors.has(f.fieldKey)) {
          stats[f.fieldKey] = {
            value: Number.NaN,
            display: '⚠',
            count: 0,
            error: teamFormulaErrors.get(f.fieldKey)
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

export function useRankingsCustomColumns(rankingsRef?: Ref<RankingRow[]>) {
  const eventStore = useEventStore()
  const recordStore = useRecordStore()
  const pitStore = usePitScoutStore()
  const customFieldsStore = useCustomFieldsStore()

  const allActiveEventFields = computed<CustomFieldDefinition[]>(() => {
    const eventId = eventStore.currentEvent?.id
    if (!eventId) return []
    return [
      ...customFieldsStore.getActiveFields(eventId, 'MATCH'),
      ...customFieldsStore.getActiveFields(eventId, 'TEAM'),
      ...customFieldsStore.getActiveFields(eventId, 'PIT')
    ]
  })

  const availableCustomFields = computed<CustomFieldDefinition[]>(() => {
    return allActiveEventFields.value.filter(isSelectableCustomColumnField)
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
    selectedCustomKeys.value = availableCustomFields.value.map((f) => f.fieldKey)
    saveCustomColKeys(selectedCustomKeys.value)
  }

  function clearAllCustomCols() {
    hapticLight()
    selectedCustomKeys.value = []
    saveCustomColKeys([])
  }

  const visibleCustomFields = computed(() => {
    return availableCustomFields.value.filter((f) => selectedCustomKeys.value.includes(f.fieldKey))
  })

  const teamCustomStats = computed(() => {
    const eventId = eventStore.currentEvent?.id
    const records = recordStore.activeRecords.filter((r) => !eventId || r.eventId === eventId)
    const pitRecords = pitStore.activeRecords.filter((p) => !eventId || p.eventId === eventId)
    return computeTeamCustomStatsMap(records, availableCustomFields.value, {
      rankings: rankingsRef?.value,
      pitRecords,
      allFields: allActiveEventFields.value
    })
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
