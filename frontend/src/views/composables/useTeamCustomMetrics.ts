import type { CustomFieldDefinition, ScoutingRecord } from '@/types'
import { parseCustomFields } from '@/components/rankings/useRankingsCustomColumns'

export { parseCustomFields }

export interface CustomMetricSummary {
  definition: CustomFieldDefinition
  fieldType: string
  avg?: number | null
  max?: number | null
  rate?: number | null
  trueCount?: number
  totalCount?: number
  distribution?: { label: string; count: number; percentage: number; color?: string }[]
  textEntries?: { matchNumber: number; text: string }[]
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
  matches: ScoutingRecord[]
): CustomMetricSummary[] {
  if (!fields || fields.length === 0) return []
  const result: CustomMetricSummary[] = []

  for (const field of fields) {
    if (field.fieldType === 'number' || field.fieldType === 'level') {
      const values: number[] = []
      for (const m of matches) {
        const cf = parseCustomFields(m)
        const val = cf[field.fieldKey]
        if (val !== undefined && val !== null && val !== '') {
          const num = Number(val)
          if (!isNaN(num)) {
            values.push(num)
          }
        }
      }
      if (values.length > 0) {
        const sum = values.reduce((a, b) => a + b, 0)
        result.push({
          definition: field,
          fieldType: field.fieldType,
          avg: sum / values.length,
          max: Math.max(...values),
          totalCount: values.length
        })
      }
    } else if (field.fieldType === 'boolean') {
      let trueCount = 0
      let totalCount = 0
      for (const m of matches) {
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
      let totalEvals = 0
      for (const m of matches) {
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
        }
      }
      if (totalEvals > 0) {
        const dist = (field.options || [])
          .map(opt => {
            const count = optionMap[opt.value] || optionMap[opt.label] || 0
            return {
              label: opt.label,
              count,
              percentage: totalEvals > 0 ? (count / totalEvals) * 100 : 0,
              color: opt.color || 'blue'
            }
          })
          .filter(d => d.count > 0)

        for (const [k, count] of Object.entries(optionMap)) {
          if (!dist.some(d => d.label === k)) {
            dist.push({
              label: k,
              count,
              percentage: (count / totalEvals) * 100,
              color: 'gray'
            })
          }
        }

        result.push({
          definition: field,
          fieldType: field.fieldType,
          distribution: dist,
          totalCount: totalEvals
        })
      }
    } else if (field.fieldType === 'text') {
      const textEntries: { matchNumber: number; text: string }[] = []
      for (const m of matches) {
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
    }
  }

  return result
}

export function computeTeamPitCustomSpecs(
  fields: CustomFieldDefinition[],
  pitRecord: { customFields?: Record<string, any>; rawData?: string } | null | undefined,
  t: (key: string) => string
): { field: CustomFieldDefinition; displayValue: string }[] {
  if (!fields || fields.length === 0 || !pitRecord) return []
  const cf = parseCustomFields(pitRecord)
  const list: { field: CustomFieldDefinition; displayValue: string }[] = []

  for (const f of fields) {
    const val = cf[f.fieldKey]
    if (val !== undefined && val !== null && val !== '') {
      let displayValue = String(val)
      if (f.fieldType === 'boolean') {
        displayValue = (val === true || val === 'true') ? t('custom_fields.renderer.bool_yes') : t('custom_fields.renderer.bool_no')
      } else if (f.fieldType === 'level') {
        displayValue = `${val} ${t('custom_fields.renderer.level_unit')}`
      } else if (f.fieldType === 'select') {
        const opt = f.options?.find(o => o.value === val || o.label === val)
        displayValue = opt ? opt.label : String(val)
      } else if (f.fieldType === 'multi_select' && Array.isArray(val)) {
        displayValue = val.map(v => {
          const opt = f.options?.find(o => o.value === v || o.label === v)
          return opt ? opt.label : v
        }).join(', ')
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
  t: (key: string) => string
): MatchCustomBadge[] {
  if (!fields || fields.length === 0) return []
  const cf = parseCustomFields(match)
  const badges: MatchCustomBadge[] = []

  for (const f of fields) {
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
      } else if (f.fieldType === 'number') {
        displayValue = `${val}${f.unit ? ' ' + f.unit : ''}`
        color = 'blue'
      } else if (f.fieldType === 'select') {
        const opt = f.options?.find(o => o.value === val || o.label === val)
        displayValue = opt ? opt.label : String(val)
        color = opt?.color || 'blue'
      } else if (f.fieldType === 'multi_select' && Array.isArray(val)) {
        const labels = val.map(v => {
          const opt = f.options?.find(o => o.value === v || o.label === v)
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
