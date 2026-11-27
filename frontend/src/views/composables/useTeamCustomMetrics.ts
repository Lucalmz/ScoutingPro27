import type {
  CustomFieldAggregationMode,
  CustomFieldDefinition,
  PitScoutingRecord,
  RankingRow,
  ScoutingRecord
} from '@/types'
import {
  aggregateNumericValues,
  computeTierBadge,
  formatCustomStatValue,
  hasWeightedOptions,
  parseCustomFields,
  type TierBadgeLevel
} from '@/components/rankings/useRankingsCustomColumns'
import {
  buildMatchFormulaContext,
  buildPitFormulaContext,
  buildTeamFormulaContext,
  evaluateFormula,
  resolveCustomFieldNumericValue,
  topologicalSortFormulas
} from '@/utils/formula'

export { parseCustomFields }

export interface CustomMetricSummary {
  definition: CustomFieldDefinition
  fieldType: string
  avg?: number | null
  max?: number | null
  aggregatedValue?: number | null
  aggregatedDisplay?: string | null
  aggregationMode?: CustomFieldAggregationMode
  tier?: TierBadgeLevel
  rate?: number | null
  trueCount?: number
  totalCount?: number
  distribution?: { label: string; count: number; percentage: number; color?: string }[]
  textEntries?: { matchNumber: number; text: string }[]
  error?: string | null
}

export interface MatchCustomBadge {
  key: string
  name: string
  value: string
  type: string
  color?: string
}

export function computeTeamMatchCustomMetrics(
  fields: CustomFieldDefinition[],
  matches: ScoutingRecord[],
  allFields?: CustomFieldDefinition[]
): CustomMetricSummary[] {
  if (!fields || fields.length === 0) return []
  const result: CustomMetricSummary[] = []
  const fieldPool = allFields && allFields.length > 0 ? allFields : fields

  const { sorted: sortedFormulas, cyclicKeys } = topologicalSortFormulas(fieldPool)
  const cyclicSet = new Set(cyclicKeys)
  const matchFormulas = sortedFormulas.filter((f) => f.target === 'MATCH')

  // Pre-evaluate MATCH formulas per match in topological order
  const activeMatches = matches.filter((m) => !m.isDeleted)
  const nonBrokenMatches = activeMatches
    .filter((m) => !m.isBroken)
    .slice()
    .sort((a, b) => a.matchNumber - b.matchNumber)

  const formulaValuesByField = new Map<string, number[]>()
  const formulaErrorsByField = new Map<string, string>()
  for (const ck of cyclicKeys) {
    formulaErrorsByField.set(ck, 'CIRCULAR_DEPENDENCY')
  }

  if (matchFormulas.length > 0) {
    for (const m of nonBrokenMatches) {
      const cf = parseCustomFields(m)
      const perMatchValues: Record<string, number | null> = {}
      for (const mf of matchFormulas) {
        if (cyclicSet.has(mf.fieldKey)) {
          perMatchValues[mf.fieldKey] = null
          formulaErrorsByField.set(mf.fieldKey, 'CIRCULAR_DEPENDENCY')
          continue
        }
        if (!mf.formulaExpr?.trim()) {
          perMatchValues[mf.fieldKey] = null
          continue
        }
        const ctx = buildMatchFormulaContext({
          record: m,
          customFieldValues: cf,
          fieldDefinitions: fieldPool,
          formulaValues: perMatchValues
        })
        const res = evaluateFormula(mf.formulaExpr, ctx, {
          target: 'MATCH',
          fieldKey: mf.fieldKey
        })
        perMatchValues[mf.fieldKey] = res.value
        if (res.value !== null && Number.isFinite(res.value)) {
          if (!formulaValuesByField.has(mf.fieldKey)) {
            formulaValuesByField.set(mf.fieldKey, [])
          }
          formulaValuesByField.get(mf.fieldKey)!.push(res.value)
        } else if (res.error) {
          formulaErrorsByField.set(mf.fieldKey, res.error)
        }
      }
    }
  }

  for (const field of fields) {
    if (field.fieldType === 'number' || field.fieldType === 'level' || field.fieldType === 'timer') {
      const values: number[] = []
      for (const m of activeMatches) {
        const cf = parseCustomFields(m)
        const val = cf[field.fieldKey]
        if (val !== undefined && val !== null && val !== '') {
          const num = Number(val)
          if (!isNaN(num) && Number.isFinite(num)) {
            values.push(num)
          }
        }
      }
      if (values.length > 0) {
        const sum = values.reduce((a, b) => a + b, 0)
        const mode: CustomFieldAggregationMode = field.aggregationMode ?? 'avg'
        const agg = aggregateNumericValues(values, mode)
        result.push({
          definition: field,
          fieldType: field.fieldType,
          avg: sum / values.length,
          max: Math.max(...values),
          aggregatedValue: agg,
          aggregatedDisplay: agg !== null ? formatCustomStatValue(agg, field) : null,
          aggregationMode: mode,
          tier: agg !== null ? computeTierBadge(agg, field) : null,
          totalCount: values.length
        })
      }
    } else if (field.fieldType === 'boolean') {
      let trueCount = 0
      let totalCount = 0
      for (const m of activeMatches) {
        const cf = parseCustomFields(m)
        const val = cf[field.fieldKey]
        if (val !== undefined && val !== null) {
          totalCount++
          if (val === true || val === 'true' || val === 1) {
            trueCount++
          }
        }
      }
      if (totalCount > 0) {
        result.push({
          definition: field,
          fieldType: 'boolean',
          rate: (trueCount / totalCount) * 100,
          trueCount,
          totalCount
        })
      }
    } else if (field.fieldType === 'select' || field.fieldType === 'multi_select') {
      const optionMap: Record<string, number> = {}
      const numericVals: number[] = []
      let totalEvals = 0
      for (const m of activeMatches) {
        const cf = parseCustomFields(m)
        const val = cf[field.fieldKey]
        if (val !== undefined && val !== null && val !== '') {
          if (Array.isArray(val)) {
            for (const item of val) {
              if (item) {
                optionMap[item] = (optionMap[item] || 0) + 1
                totalEvals++
              }
            }
          } else {
            optionMap[val] = (optionMap[val] || 0) + 1
            totalEvals++
          }
          const numVal = resolveCustomFieldNumericValue(val, field)
          if (numVal !== null && Number.isFinite(numVal)) {
            numericVals.push(numVal)
          }
        }
      }
      if (totalEvals > 0) {
        const dist = (field.options || [])
          .map((opt) => {
            const count = optionMap[opt.value] || optionMap[opt.label] || 0
            return {
              label: opt.label,
              count,
              percentage: totalEvals > 0 ? (count / totalEvals) * 100 : 0,
              color: opt.color || 'blue'
            }
          })
          .filter((d) => d.count > 0)

        for (const [k, count] of Object.entries(optionMap)) {
          if (!dist.some((d) => d.label === k)) {
            dist.push({
              label: k,
              count,
              percentage: (count / totalEvals) * 100,
              color: 'gray'
            })
          }
        }

        const isWeighted = hasWeightedOptions(field) && numericVals.length > 0
        const mode: CustomFieldAggregationMode = field.aggregationMode ?? 'avg'
        const agg = isWeighted ? aggregateNumericValues(numericVals, mode) : null

        result.push({
          definition: field,
          fieldType: field.fieldType,
          distribution: dist,
          aggregatedValue: agg,
          aggregatedDisplay: agg !== null ? formatCustomStatValue(agg, field) : null,
          aggregationMode: isWeighted ? mode : undefined,
          tier: agg !== null ? computeTierBadge(agg, field) : null,
          totalCount: totalEvals
        })
      }
    } else if (field.fieldType === 'text') {
      const textEntries: { matchNumber: number; text: string }[] = []
      for (const m of activeMatches) {
        const cf = parseCustomFields(m)
        const val = cf[field.fieldKey]
        if (typeof val === 'string' && val.trim().length > 0) {
          textEntries.push({ matchNumber: m.matchNumber, text: val.trim() })
        }
      }
      if (textEntries.length > 0) {
        result.push({
          definition: field,
          fieldType: 'text',
          textEntries,
          totalCount: textEntries.length
        })
      }
    } else if (field.fieldType === 'formula') {
      const vals = formulaValuesByField.get(field.fieldKey) ?? []
      const err = formulaErrorsByField.get(field.fieldKey) ?? null
      if (vals.length > 0) {
        const mode: CustomFieldAggregationMode = field.aggregationMode ?? 'avg'
        const agg = aggregateNumericValues(vals, mode)
        result.push({
          definition: field,
          fieldType: 'formula',
          avg: vals.reduce((a, b) => a + b, 0) / vals.length,
          max: Math.max(...vals),
          aggregatedValue: agg,
          aggregatedDisplay: agg !== null ? formatCustomStatValue(agg, field) : null,
          aggregationMode: mode,
          tier: agg !== null ? computeTierBadge(agg, field) : null,
          totalCount: vals.length,
          error: err
        })
      } else if (err) {
        result.push({
          definition: field,
          fieldType: 'formula',
          aggregatedValue: null,
          aggregatedDisplay: null,
          totalCount: 0,
          error: err
        })
      }
    }
  }

  return result
}

export interface ComputeTeamFormulaMetricsOptions {
  rankingRow?: Partial<RankingRow>
  pitRecord?: Partial<PitScoutingRecord> | null
  matchRecords?: ScoutingRecord[]
  allFields?: CustomFieldDefinition[]
}

export function computeTeamFormulaMetrics(
  teamFields: CustomFieldDefinition[],
  options: ComputeTeamFormulaMetricsOptions
): CustomMetricSummary[] {
  if (!teamFields || teamFields.length === 0) return []
  const allFields = options.allFields && options.allFields.length > 0 ? options.allFields : teamFields
  const { sorted, cyclicKeys } = topologicalSortFormulas(allFields)
  const cyclicSet = new Set(cyclicKeys)
  const nonBrokenMatches = (options.matchRecords ?? [])
    .filter((m) => !m.isDeleted && !m.isBroken)
    .slice()
    .sort((a, b) => a.matchNumber - b.matchNumber)

  // Seed aggregated MATCH formula values & PIT formula values
  const formulaValues: Record<string, number | null> = {}
  const matchFormulas = sorted.filter((f) => f.target === 'MATCH')
  for (const mf of matchFormulas) {
    if (cyclicSet.has(mf.fieldKey) || !mf.formulaExpr?.trim()) {
      formulaValues[mf.fieldKey] = null
      continue
    }
    const vals: number[] = []
    for (const m of nonBrokenMatches) {
      const ctx = buildMatchFormulaContext({
        record: m,
        fieldDefinitions: allFields,
        formulaValues
      })
      const res = evaluateFormula(mf.formulaExpr, ctx, { target: 'MATCH', fieldKey: mf.fieldKey })
      if (res.value !== null && Number.isFinite(res.value)) vals.push(res.value)
    }
    formulaValues[mf.fieldKey] = aggregateNumericValues(vals, mf.aggregationMode ?? 'avg')
  }

  const pitFormulas = sorted.filter((f) => f.target === 'PIT')
  if (options.pitRecord) {
    for (const pf of pitFormulas) {
      if (cyclicSet.has(pf.fieldKey) || !pf.formulaExpr?.trim()) {
        formulaValues[pf.fieldKey] = null
        continue
      }
      const ctx = buildPitFormulaContext({
        pitRecord: options.pitRecord,
        fieldDefinitions: allFields,
        formulaValues
      })
      const res = evaluateFormula(pf.formulaExpr, ctx, { target: 'PIT', fieldKey: pf.fieldKey })
      formulaValues[pf.fieldKey] = res.value
    }
  }

  const teamFormulas = sorted.filter((f) => f.target === 'TEAM')
  const errorsByKey = new Map<string, string>()
  for (const ck of cyclicKeys) {
    errorsByKey.set(ck, 'CIRCULAR_DEPENDENCY')
  }

  for (const tf of teamFormulas) {
    if (cyclicSet.has(tf.fieldKey)) {
      formulaValues[tf.fieldKey] = null
      errorsByKey.set(tf.fieldKey, 'CIRCULAR_DEPENDENCY')
      continue
    }
    if (!tf.formulaExpr?.trim()) {
      formulaValues[tf.fieldKey] = null
      continue
    }
    const ctx = buildTeamFormulaContext({
      rankingRow: options.rankingRow,
      pitRecord: options.pitRecord ?? undefined,
      matchRecords: nonBrokenMatches,
      fieldDefinitions: allFields,
      formulaValues
    })
    const res = evaluateFormula(tf.formulaExpr, ctx, {
      target: 'TEAM',
      fieldKey: tf.fieldKey
    })
    formulaValues[tf.fieldKey] = res.value
    if (res.error && res.value === null) {
      errorsByKey.set(tf.fieldKey, res.error)
    }
  }

  const result: CustomMetricSummary[] = []
  for (const tf of teamFields) {
    const val = formulaValues[tf.fieldKey]
    const err = errorsByKey.get(tf.fieldKey) ?? null
    if (typeof val === 'number' && Number.isFinite(val)) {
      result.push({
        definition: tf,
        fieldType: 'formula',
        aggregatedValue: val,
        aggregatedDisplay: formatCustomStatValue(val, tf),
        tier: computeTierBadge(val, tf),
        totalCount: nonBrokenMatches.length,
        error: null
      })
    } else if (err) {
      result.push({
        definition: tf,
        fieldType: 'formula',
        aggregatedValue: null,
        aggregatedDisplay: null,
        totalCount: 0,
        error: err
      })
    }
  }

  return result
}

export function computeTeamPitCustomSpecs(
  fields: CustomFieldDefinition[],
  pitRecord: { customFields?: Record<string, any>; rawData?: string } | null | undefined,
  t: (key: string) => string,
  allFields?: CustomFieldDefinition[]
): { field: CustomFieldDefinition; displayValue: string }[] {
  if (!fields || fields.length === 0 || !pitRecord) return []
  const cf = parseCustomFields(pitRecord)
  const list: { field: CustomFieldDefinition; displayValue: string }[] = []

  const fieldPool = allFields && allFields.length > 0 ? allFields : fields
  const { sorted, cyclicKeys } = topologicalSortFormulas(fieldPool)
  const cyclicSet = new Set(cyclicKeys)
  const pitFormulaValues: Record<string, number | null> = {}

  for (const pf of sorted.filter((f) => f.target === 'PIT')) {
    if (cyclicSet.has(pf.fieldKey) || !pf.formulaExpr?.trim()) {
      pitFormulaValues[pf.fieldKey] = null
      continue
    }
    const ctx = buildPitFormulaContext({
      pitRecord: pitRecord as Partial<PitScoutingRecord>,
      customFieldValues: cf,
      fieldDefinitions: fieldPool,
      formulaValues: pitFormulaValues
    })
    const res = evaluateFormula(pf.formulaExpr, ctx, { target: 'PIT', fieldKey: pf.fieldKey })
    pitFormulaValues[pf.fieldKey] = res.value
  }

  for (const f of fields) {
    if (f.fieldType === 'formula') {
      const val = pitFormulaValues[f.fieldKey]
      if (cyclicSet.has(f.fieldKey)) {
        list.push({ field: f, displayValue: '⚠' })
      } else if (typeof val === 'number' && Number.isFinite(val)) {
        const formatted = formatCustomStatValue(val, f)
        list.push({ field: f, displayValue: f.unit ? `${formatted} ${f.unit}` : formatted })
      }
      continue
    }

    const val = cf[f.fieldKey]
    if (val !== undefined && val !== null && val !== '') {
      let displayValue = String(val)
      if (f.fieldType === 'boolean') {
        displayValue =
          val === true || val === 'true'
            ? t('custom_fields.renderer.bool_yes')
            : t('custom_fields.renderer.bool_no')
      } else if (f.fieldType === 'level') {
        displayValue = `${val} ${t('custom_fields.renderer.level_unit')}`
      } else if (f.fieldType === 'timer') {
        displayValue = `${Number(val).toFixed(1)} ${f.unit || 's'}`
      } else if (f.fieldType === 'select') {
        const opt = f.options?.find((o) => o.value === val || o.label === val)
        displayValue = opt ? opt.label : String(val)
      } else if (f.fieldType === 'multi_select' && Array.isArray(val)) {
        displayValue = val
          .map((v) => {
            const opt = f.options?.find((o) => o.value === v || o.label === v)
            return opt ? opt.label : v
          })
          .join(', ')
      }
      if (f.unit && f.fieldType === 'number') {
        displayValue += ` ${f.unit}`
      }
      list.push({ field: f, displayValue })
    }
  }
  return list
}

export function buildMatchCustomBadges(
  fields: CustomFieldDefinition[],
  match: ScoutingRecord,
  t: (key: string) => string,
  allFields?: CustomFieldDefinition[]
): MatchCustomBadge[] {
  if (!fields || fields.length === 0) return []
  const cf = parseCustomFields(match)
  const badges: MatchCustomBadge[] = []
  const fieldPool = allFields && allFields.length > 0 ? allFields : fields
  const { sorted, cyclicKeys } = topologicalSortFormulas(fieldPool)
  const cyclicSet = new Set(cyclicKeys)
  const matchFormulaValues: Record<string, number | null> = {}

  for (const mf of sorted.filter((f) => f.target === 'MATCH')) {
    if (cyclicSet.has(mf.fieldKey) || !mf.formulaExpr?.trim()) {
      matchFormulaValues[mf.fieldKey] = null
      continue
    }
    const ctx = buildMatchFormulaContext({
      record: match,
      customFieldValues: cf,
      fieldDefinitions: fieldPool,
      formulaValues: matchFormulaValues
    })
    const res = evaluateFormula(mf.formulaExpr, ctx, { target: 'MATCH', fieldKey: mf.fieldKey })
    matchFormulaValues[mf.fieldKey] = res.value
  }

  for (const f of fields) {
    if (f.fieldType === 'formula') {
      const val = matchFormulaValues[f.fieldKey]
      if (cyclicSet.has(f.fieldKey)) {
        badges.push({
          key: f.fieldKey,
          name: f.name,
          value: '⚠',
          type: 'formula',
          color: 'red'
        })
      } else if (typeof val === 'number' && Number.isFinite(val)) {
        const formatted = formatCustomStatValue(val, f)
        badges.push({
          key: f.fieldKey,
          name: f.name,
          value: `${formatted}${f.unit ? ' ' + f.unit : ''}`,
          type: 'formula',
          color: 'purple'
        })
      }
      continue
    }

    const val = cf[f.fieldKey]
    if (val !== undefined && val !== null && val !== '') {
      let displayValue = String(val)
      let color = 'gray'
      if (f.fieldType === 'boolean') {
        const isTrue = val === true || val === 'true' || val === 1
        displayValue = isTrue ? '✓' : '✕'
        color = isTrue ? 'green' : 'gray'
      } else if (f.fieldType === 'level') {
        displayValue = `${val} ${t('custom_fields.renderer.level_unit')}`
        color = val >= 4 ? 'green' : val >= 2 ? 'blue' : 'orange'
      } else if (f.fieldType === 'timer') {
        displayValue = `${Number(val).toFixed(1)}${f.unit || 's'}`
        color = 'blue'
      } else if (f.fieldType === 'number') {
        displayValue = `${val}${f.unit ? ' ' + f.unit : ''}`
        color = 'blue'
      } else if (f.fieldType === 'select') {
        const opt = f.options?.find((o) => o.value === val || o.label === val)
        displayValue = opt ? opt.label : String(val)
        color = opt?.color || 'blue'
      } else if (f.fieldType === 'multi_select' && Array.isArray(val)) {
        const labels = val.map((v) => {
          const opt = f.options?.find((o) => o.value === v || o.label === v)
          return opt ? opt.label : v
        })
        displayValue = labels.join(', ')
        color = 'purple'
      } else if (f.fieldType === 'text') {
        displayValue = String(val)
        color = 'gray'
      }
      badges.push({
        key: f.fieldKey,
        name: f.name,
        value: displayValue,
        type: f.fieldType,
        color
      })
    }
  }
  return badges
}
