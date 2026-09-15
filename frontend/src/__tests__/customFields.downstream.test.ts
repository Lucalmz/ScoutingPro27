import { describe, it, expect } from 'vitest'
import type { CustomFieldDefinition, ScoutingRecord } from '../types'

function parseCustomFields(
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

interface CustomMetricSummary {
  definition: CustomFieldDefinition
  fieldType: string
  avg?: number | null
  max?: number | null
  rate?: number | null
  trueCount?: number
  totalCount?: number
  distribution?: { label: string; count: number; percentage: number; color?: string }[]
}

function calculateTeamCustomMetrics(
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

        result.push({
          definition: field,
          fieldType: field.fieldType,
          distribution: dist,
          totalCount: totalEvals
        })
      }
    }
  }

  return result
}

function customSortComparator(
  aTeamNum: number,
  bTeamNum: number,
  fieldKey: string,
  teamCustomStats: Map<number, Record<string, { value: number; display: string }>>,
  sortDir: 'asc' | 'desc'
): number {
  const aStat = teamCustomStats.get(aTeamNum)?.[fieldKey]
  const bStat = teamCustomStats.get(bTeamNum)?.[fieldKey]
  const aHas = aStat !== undefined
  const bHas = bStat !== undefined
  if (!aHas && !bHas) return 0
  if (!aHas) return 1
  if (!bHas) return -1
  return sortDir === 'asc' ? aStat.value - bStat.value : bStat.value - aStat.value
}

const mockField = (overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition => ({
  id: 'cf-1',
  eventId: 'evt-1',
  target: 'MATCH',
  phase: 'teleop',
  name: 'Sample Field',
  fieldKey: 'sample_key',
  fieldType: 'number',
  required: false,
  options: [],
  orderSeq: 1,
  isActive: true,
  createdAt: '2026-09-15T00:00:00Z',
  updatedAt: '2026-09-15T00:00:00Z',
  ...overrides
})

const mockMatch = (overrides: Partial<ScoutingRecord> = {}): ScoutingRecord => ({
  id: 'rec-1',
  eventId: 'evt-1',
  matchNumber: 1,
  teamNumber: 27570,
  alliance: 'RED',
  scoutName: 'Alice',
  preMatch: {} as any,
  auto: {} as any,
  teleOp: {} as any,
  endgame: {} as any,
  postMatch: {} as any,
  customFields: {},
  createdAt: '2026-09-15T00:00:00Z',
  ...overrides
})

describe('Custom Fields Downstream Processing & Aggregations', () => {
  describe('parseCustomFields Boundary Cases', () => {
    it('returns empty object when record is null or undefined', () => {
      expect(parseCustomFields(null)).toEqual({})
      expect(parseCustomFields(undefined)).toEqual({})
    })

    it('returns direct customFields object if present', () => {
      const rec = mockMatch({ customFields: { hang_level: 4 } })
      expect(parseCustomFields(rec)).toEqual({ hang_level: 4 })
    })

    it('falls back to rawData JSON parsing when direct customFields is empty', () => {
      const rec = mockMatch({
        customFields: {},
        rawData: JSON.stringify({ customFields: { auto_score: 42 } })
      })
      expect(parseCustomFields(rec)).toEqual({ auto_score: 42 })
    })

    it('handles malformed rawData JSON gracefully without throwing', () => {
      const rec = mockMatch({
        customFields: {},
        rawData: '{"customFields": {malformed-json'
      })
      expect(parseCustomFields(rec)).toEqual({})
    })

    it('handles rawData lacking customFields key', () => {
      const rec = mockMatch({
        customFields: {},
        rawData: JSON.stringify({ telemetry: 'ok' })
      })
      expect(parseCustomFields(rec)).toEqual({})
    })
  })

  describe('Number and Level Metric Aggregations', () => {
    const numField = mockField({ fieldKey: 'cycles', fieldType: 'number' })
    const levelField = mockField({ fieldKey: 'climb_level', fieldType: 'level' })

    it('returns empty metrics when team has 0 matches', () => {
      const res = calculateTeamCustomMetrics([numField], [])
      expect(res).toHaveLength(0)
    })

    it('calculates average and max correctly across valid numeric entries', () => {
      const matches = [
        mockMatch({ customFields: { cycles: 10 } }),
        mockMatch({ customFields: { cycles: 20 } }),
        mockMatch({ customFields: { cycles: 30 } })
      ]
      const res = calculateTeamCustomMetrics([numField], matches)
      expect(res).toHaveLength(1)
      expect(res[0].avg).toBe(20)
      expect(res[0].max).toBe(30)
      expect(res[0].totalCount).toBe(3)
    })

    it('filters out null, undefined, empty strings, and non-numeric garbage strings (no NaN)', () => {
      const matches = [
        mockMatch({ customFields: { cycles: 12 } }),
        mockMatch({ customFields: { cycles: null } }),
        mockMatch({ customFields: { cycles: undefined } }),
        mockMatch({ customFields: { cycles: '' } }),
        mockMatch({ customFields: { cycles: 'not-a-number' } }),
        mockMatch({ customFields: { cycles: '18' } })
      ]
      const res = calculateTeamCustomMetrics([numField], matches)
      expect(res).toHaveLength(1)
      expect(res[0].avg).toBe(15)
      expect(res[0].max).toBe(18)
      expect(res[0].totalCount).toBe(2)
    })

    it('calculates level field (1~5 bars) metrics correctly', () => {
      const matches = [
        mockMatch({ customFields: { climb_level: 2 } }),
        mockMatch({ customFields: { climb_level: 4 } }),
        mockMatch({ customFields: { climb_level: 5 } })
      ]
      const res = calculateTeamCustomMetrics([levelField], matches)
      expect(res).toHaveLength(1)
      expect(res[0].fieldType).toBe('level')
      expect(res[0].avg).toBeCloseTo(3.67, 2)
      expect(res[0].max).toBe(5)
    })
  })

  describe('Boolean Metric Aggregations', () => {
    const boolField = mockField({ fieldKey: 'climb_success', fieldType: 'boolean' })

    it('calculates true percentage rate accurately across diverse truthy/falsy formats', () => {
      const matches = [
        mockMatch({ customFields: { climb_success: true } }),
        mockMatch({ customFields: { climb_success: 'true' } }),
        mockMatch({ customFields: { climb_success: 1 } }),
        mockMatch({ customFields: { climb_success: false } }),
        mockMatch({ customFields: { climb_success: 'false' } }),
        mockMatch({ customFields: { climb_success: 0 } })
      ]
      const res = calculateTeamCustomMetrics([boolField], matches)
      expect(res).toHaveLength(1)
      expect(res[0].fieldType).toBe('boolean')
      expect(res[0].trueCount).toBe(3)
      expect(res[0].totalCount).toBe(6)
      expect(res[0].rate).toBe(50)
    })

    it('ignores matches where boolean field is undefined or null', () => {
      const matches = [
        mockMatch({ customFields: { climb_success: true } }),
        mockMatch({ customFields: {} }),
        mockMatch({ customFields: { climb_success: null } })
      ]
      const res = calculateTeamCustomMetrics([boolField], matches)
      expect(res[0].totalCount).toBe(1)
      expect(res[0].trueCount).toBe(1)
      expect(res[0].rate).toBe(100)
    })
  })

  describe('Select & Multi-Select Option Distributions', () => {
    const selectField = mockField({
      fieldKey: 'intake_speed',
      fieldType: 'select',
      options: [
        { label: 'Slow', value: 'slow', color: 'red' },
        { label: 'Medium', value: 'med', color: 'amber' },
        { label: 'Fast', value: 'fast', color: 'emerald' }
      ]
    })

    const multiSelectField = mockField({
      fieldKey: 'capabilities',
      fieldType: 'multi_select',
      options: [
        { label: 'Autonomous Submersible', value: 'auto_sub', color: 'blue' },
        { label: 'High Basket Specialist', value: 'high_basket', color: 'purple' },
        { label: 'Deep Climb Capable', value: 'deep_climb', color: 'green' }
      ]
    })

    it('calculates percentage distribution for single select', () => {
      const matches = [
        mockMatch({ customFields: { intake_speed: 'fast' } }),
        mockMatch({ customFields: { intake_speed: 'fast' } }),
        mockMatch({ customFields: { intake_speed: 'slow' } })
      ]
      const res = calculateTeamCustomMetrics([selectField], matches)
      expect(res).toHaveLength(1)
      const dist = res[0].distribution!
      const fastItem = dist.find((d) => d.label === 'Fast')
      const slowItem = dist.find((d) => d.label === 'Slow')
      expect(fastItem?.count).toBe(2)
      expect(fastItem?.percentage).toBeCloseTo(66.67, 1)
      expect(slowItem?.count).toBe(1)
      expect(slowItem?.percentage).toBeCloseTo(33.33, 1)
    })

    it('flattens array values for multi_select and counts multiple tags per match', () => {
      const matches = [
        mockMatch({ customFields: { capabilities: ['auto_sub', 'deep_climb'] } }),
        mockMatch({ customFields: { capabilities: ['deep_climb'] } }),
        mockMatch({ customFields: { capabilities: [] } })
      ]
      const res = calculateTeamCustomMetrics([multiSelectField], matches)
      expect(res).toHaveLength(1)
      const dist = res[0].distribution!
      const deepClimb = dist.find((d) => d.label === 'Deep Climb Capable')
      const autoSub = dist.find((d) => d.label === 'Autonomous Submersible')
      expect(deepClimb?.count).toBe(2)
      expect(autoSub?.count).toBe(1)
    })

    it('gracefully handles unexpected/custom write-in values not present in field options', () => {
      const matches = [
        mockMatch({ customFields: { intake_speed: 'hyper_drive' } })
      ]
      const res = calculateTeamCustomMetrics([selectField], matches)
      expect(res).toHaveLength(1)
      const dist = res[0].distribution!
      expect(dist).toHaveLength(1)
      expect(dist[0].label).toBe('hyper_drive')
      expect(dist[0].color).toBe('gray')
      expect(dist[0].count).toBe(1)
    })
  })

  describe('RankingsTable Custom Column Sorting Edge Cases', () => {
    it('sorts teams with valid custom stats in asc and desc directions', () => {
      const stats = new Map<number, Record<string, { value: number; display: string }>>([
        [1001, { auto_pts: { value: 35, display: '35.0' } }],
        [1002, { auto_pts: { value: 50, display: '50.0' } }],
        [1003, { auto_pts: { value: 20, display: '20.0' } }]
      ])

      const teams = [1001, 1002, 1003]

      const desc = [...teams].sort((a, b) => customSortComparator(a, b, 'auto_pts', stats, 'desc'))
      expect(desc).toEqual([1002, 1001, 1003])

      const asc = [...teams].sort((a, b) => customSortComparator(a, b, 'auto_pts', stats, 'asc'))
      expect(asc).toEqual([1003, 1001, 1002])
    })

    it('places teams with missing custom stats at the bottom in both asc and desc modes', () => {
      const stats = new Map<number, Record<string, { value: number; display: string }>>([
        [1001, { auto_pts: { value: 35, display: '35.0' } }],
        [1003, { auto_pts: { value: 20, display: '20.0' } }]
      ])

      const teams = [1002, 1001, 1003]

      const desc = [...teams].sort((a, b) => customSortComparator(a, b, 'auto_pts', stats, 'desc'))
      expect(desc).toEqual([1001, 1003, 1002])

      const asc = [...teams].sort((a, b) => customSortComparator(a, b, 'auto_pts', stats, 'asc'))
      expect(asc).toEqual([1003, 1001, 1002])
    })

    it('preserves relative order (no NaN comparator behavior) when both teams lack data', () => {
      const stats = new Map<number, Record<string, { value: number; display: string }>>([])
      const cmp = customSortComparator(2001, 2002, 'missing_field', stats, 'desc')
      expect(cmp).toBe(0)
      expect(isNaN(cmp)).toBe(false)
    })
  })
})
