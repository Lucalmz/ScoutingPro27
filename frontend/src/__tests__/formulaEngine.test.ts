import { describe, expect, it } from 'vitest'
import conformanceCases from '../../../shared/formula-conformance-cases.json'
import type { CustomFieldDefinition, CustomFieldTarget } from '@/types'
import {
  buildMatchFormulaContext,
  buildPitFormulaContext,
  buildTeamFormulaContext,
  evaluateFormula,
  findDependentFormulas,
  FORMULA_TEMPLATES,
  parseFormula,
  topologicalSortFormulas,
  validateFormulaGraph
} from '@/utils/formula'

function materializeExpr(c: { expr?: string; exprRepeat?: Record<string, any> }): string {
  if (typeof c.expr === 'string') return c.expr
  const rep = c.exprRepeat!
  if (typeof rep.unit === 'string') {
    return `${rep.prefix ?? ''}${rep.unit.repeat(rep.count)}`
  }
  return `${rep.open.repeat(rep.count)}${rep.core}${rep.close.repeat(rep.count)}`
}

describe('Formula Engine - Shared Conformance Suite', () => {
  describe('validCases', () => {
    for (const tc of conformanceCases.validCases) {
      it(tc.name, () => {
        const target = tc.target as CustomFieldTarget
        const parsed = parseFormula(tc.expr, target)
        expect(parsed.valid).toBe(true)
        expect(parsed.dependencies).toEqual(tc.expectedDeps)

        const evaluated = evaluateFormula(tc.expr, tc.context as any, { target })
        expect(evaluated.value).not.toBeNull()
        expect(evaluated.value!).toBeCloseTo(tc.expectedValue, 6)
      })
    }
  })

  describe('invalidCases', () => {
    for (const tc of conformanceCases.invalidCases) {
      it(tc.name, () => {
        const target = tc.target as CustomFieldTarget
        const expr = materializeExpr(tc as any)
        const parsed = parseFormula(expr, target)
        expect(parsed.valid).toBe(false)
        expect(parsed.errorCode).toBe(tc.expectedErrorCode)
      })
    }
  })

  describe('graphCases', () => {
    for (const tc of conformanceCases.graphCases) {
      it(tc.name, () => {
        const existingFields: CustomFieldDefinition[] = (tc.existingFields ?? []).map((f: any, idx: number) => ({
          id: `existing-${idx}`,
          eventId: 'evt-1',
          target: f.target as CustomFieldTarget,
          phase: 'overall',
          name: f.fieldKey,
          fieldKey: f.fieldKey,
          fieldType: f.fieldType,
          required: false,
          formulaExpr: f.formulaExpr,
          orderSeq: idx + 1,
          isActive: true
        }))

        const result = validateFormulaGraph(tc.candidate as Partial<CustomFieldDefinition>, existingFields)
        expect(result.valid).toBe(tc.expectedValid)
        if (!tc.expectedValid) {
          expect(result.errorCode).toBe((tc as any).expectedErrorCode)
          if (Array.isArray((tc as any).expectedCycleContains)) {
            for (const node of (tc as any).expectedCycleContains as string[]) {
              expect(result.cyclePath).toContain(node)
            }
            expect(result.cyclePath!.length).toBeGreaterThanOrEqual(2)
            expect(result.cyclePath![0]).toBe(result.cyclePath![result.cyclePath!.length - 1])
          }
        }
      })
    }
  })
})

describe('Formula Engine - Runtime Safety, Graph & DataSources', () => {
  it('enforces stepBudget=500 and runtime evaluatingStack cycle/depth guards', () => {
    // Small stepBudget triggers STEP_BUDGET_EXCEEDED
    const budgetFail = evaluateFormula('1 + 2 + 3 + 4 + 5', {}, { stepBudget: 3 })
    expect(budgetFail.value).toBeNull()
    expect(budgetFail.reason).toBe('STEP_BUDGET_EXCEEDED')

    // Direct self-cycle in evaluatingStack
    const cycleFail = evaluateFormula('1 + 1', {}, { fieldKey: 'f_a', evaluatingStack: ['f_a'] })
    expect(cycleFail.value).toBeNull()
    expect(cycleFail.reason).toBe('CIRCULAR_DEPENDENCY_RUNTIME')

    // Max depth 16 guard
    const deepStack = Array.from({ length: 16 }, (_, i) => `f_${i}`)
    const depthFail = evaluateFormula('1 + 1', {}, { evaluatingStack: deepStack })
    expect(depthFail.value).toBeNull()
    expect(depthFail.reason).toBe('MAX_EVAL_DEPTH_EXCEEDED')

    // Division by zero returns null with DIV_BY_ZERO reason
    const divZero = evaluateFormula('10 / 0', {})
    expect(divZero.value).toBeNull()
    expect(divZero.reason).toBe('DIV_BY_ZERO')
  })

  it('builds Match, Pit, and Team contexts and resolves select/multi_select numericValue weights', () => {
    const selectDef: CustomFieldDefinition = {
      id: 'cf-def-1',
      eventId: 'evt-1',
      target: 'MATCH',
      phase: 'teleop',
      name: 'Defense Tier',
      fieldKey: 'defense_tier',
      fieldType: 'select',
      required: false,
      options: [
        { label: 'None', value: 'none', numericValue: 0 },
        { label: 'Strong', value: 'strong', numericValue: 7 }
      ],
      aggregationMode: 'avg',
      orderSeq: 1,
      isActive: true
    }

    const multiDef: CustomFieldDefinition = {
      id: 'cf-def-2',
      eventId: 'evt-1',
      target: 'PIT',
      phase: 'hardware',
      name: 'Sensors',
      fieldKey: 'sensors',
      fieldType: 'multi_select',
      required: false,
      options: [
        { label: 'Color', value: 'color', numericValue: 2 },
        { label: 'AprilTag', value: 'apriltag', numericValue: 5 }
      ],
      orderSeq: 2,
      isActive: true
    }

    const matchCtx = buildMatchFormulaContext({
      formData: {
        autoBalls: 4,
        autoCycleTimeSec: 3.5,
        predictCycleTimeSec: 6.0,
        customFields: { defense_tier: 'strong' }
      },
      record: { autoScore: 21, teleopScore: 30, endgameScore: 10, totalScore: 61 },
      fieldDefinitions: [selectDef]
    })
    expect(matchCtx.match?.autoCycleTime).toBe(3.5)
    expect(matchCtx.match?.teleopCycleTime).toBe(6.0)
    expect(matchCtx.match?.predictCycleTime).toBe(6.0)
    expect(matchCtx.cf?.defense_tier).toBe(7)

    const pitCtx = buildPitFormulaContext({
      pitRecord: { weightLbs: 32, claimedTotalScore: 90, customFields: { sensors: ['color', 'apriltag'] } },
      fieldDefinitions: [multiDef]
    })
    expect(pitCtx.pit?.claimedTotalScore).toBe(90)
    expect(pitCtx.pit_cf?.sensors).toBe(7)

    const teamCtx = buildTeamFormulaContext({
      rankingRow: { teamNumber: 123, spNpOpr: 48.5, avgRating: 45, matchCount: 4, brokenCount: 1 },
      pitRecord: { weightLbs: 32, claimedTotalScore: 90, customFields: { sensors: ['apriltag'] } },
      matchRecords: [
        { rawData: JSON.stringify({ customFields: { defense_tier: 'strong' } }), isBroken: false } as any,
        { rawData: JSON.stringify({ customFields: { defense_tier: 'none' } }), isBroken: false } as any
      ],
      fieldDefinitions: [selectDef, multiDef]
    })
    expect(teamCtx.opr?.np).toBe(48.5)
    expect(teamCtx.match_cf?.defense_tier).toEqual([7, 0])
    expect(teamCtx.cf?.defense_tier).toBe(3.5)
    expect(teamCtx.pit_cf?.sensors).toBe(5)
  })

  it('topologicalSortFormulas orders dependencies and findDependentFormulas finds transitive dependents', () => {
    const fields: CustomFieldDefinition[] = [
      {
        id: '1',
        eventId: 'e1',
        target: 'TEAM',
        phase: 'overall',
        name: 'Top',
        fieldKey: 'top_score',
        fieldType: 'formula',
        formulaExpr: 'formula.mid_score * 2',
        required: false,
        orderSeq: 1,
        isActive: true
      },
      {
        id: '2',
        eventId: 'e1',
        target: 'TEAM',
        phase: 'overall',
        name: 'Mid',
        fieldKey: 'mid_score',
        fieldType: 'formula',
        formulaExpr: 'formula.base_score + 5',
        required: false,
        orderSeq: 2,
        isActive: true
      },
      {
        id: '3',
        eventId: 'e1',
        target: 'TEAM',
        phase: 'overall',
        name: 'Base',
        fieldKey: 'base_score',
        fieldType: 'formula',
        formulaExpr: 'opr.np + 1',
        required: false,
        orderSeq: 3,
        isActive: true
      }
    ]

    const { sorted, cyclicKeys } = topologicalSortFormulas(fields)
    expect(cyclicKeys).toEqual([])
    expect(sorted.map((f) => f.fieldKey)).toEqual(['base_score', 'mid_score', 'top_score'])

    const dependents = findDependentFormulas('base_score', fields)
    expect(dependents.map((f) => f.fieldKey)).toEqual(['mid_score', 'top_score'])
  })

  it('validates all curated FORMULA_TEMPLATES cleanly', () => {
    for (const tpl of FORMULA_TEMPLATES) {
      if (tpl.fieldType === 'formula' && tpl.formulaExpr) {
        const res = parseFormula(tpl.formulaExpr, tpl.target)
        expect(res.valid).toBe(true)
      }
    }
  })
})
