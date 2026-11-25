import type {
  CustomFieldAggregationMode,
  CustomFieldDefinition,
  CustomFieldOption,
  CustomFieldTarget,
  PitScoutingRecord,
  RankingRow,
  ScoutingFormData,
  ScoutingRecord
} from '@/types'
import { calcMatchAutoCycleTime, calcMatchPredictCycleTime } from '@/utils/analytics/predictCycleTime'
import { parseScoutRawData } from '@/utils/analytics/rankings'
import type { FormulaContext, FormulaNamespace } from './types'

export interface FormulaVariableMeta {
  key: string
  namespace: FormulaNamespace
  fullKey: string
  label: string
  description: string
  isArray?: boolean
}

export interface FormulaVariableGroup {
  namespace: FormulaNamespace
  label: string
  allowedTargets: CustomFieldTarget[]
  variables: FormulaVariableMeta[]
}

export const FORMULA_VARIABLE_GROUPS: FormulaVariableGroup[] = [
  {
    namespace: 'opr',
    label: 'SP-NP OPR',
    allowedTargets: ['TEAM'],
    variables: [
      { key: 'np', namespace: 'opr', fullKey: 'opr.np', label: 'SP-NP OPR', description: 'Scout-Prior Non-Penalty OPR' },
      { key: 'rawNp', namespace: 'opr', fullKey: 'opr.rawNp', label: 'Raw NP OPR', description: 'Pure FTCScout NP OPR' },
      { key: 'auto', namespace: 'opr', fullKey: 'opr.auto', label: 'SP-NP Auto', description: 'Auto OPR share' },
      { key: 'teleop', namespace: 'opr', fullKey: 'opr.teleop', label: 'SP-NP TeleOp', description: 'TeleOp OPR share' },
      { key: 'endgame', namespace: 'opr', fullKey: 'opr.endgame', label: 'SP-NP Endgame', description: 'Endgame OPR share' },
      { key: 'delta', namespace: 'opr', fullKey: 'opr.delta', label: 'OPR Delta', description: 'SP-NP OPR minus Raw NP OPR' },
      { key: 'confidenceScore', namespace: 'opr', fullKey: 'opr.confidenceScore', label: 'Confidence Score', description: '0-100 confidence score' },
      { key: 'officialMatches', namespace: 'opr', fullKey: 'opr.officialMatches', label: 'Official Matches', description: 'Count of official matches' },
      { key: 'brokenExcluded', namespace: 'opr', fullKey: 'opr.brokenExcluded', label: 'Broken Excluded', description: 'Broken matches excluded from prior' }
    ]
  },
  {
    namespace: 'match',
    label: 'Match Metrics',
    allowedTargets: ['MATCH', 'TEAM'],
    variables: [
      { key: 'autoScore', namespace: 'match', fullKey: 'match.autoScore', label: 'Auto Score', description: 'Autonomous score' },
      { key: 'teleopScore', namespace: 'match', fullKey: 'match.teleopScore', label: 'TeleOp Score', description: 'TeleOp score' },
      { key: 'endgameScore', namespace: 'match', fullKey: 'match.endgameScore', label: 'Endgame Score', description: 'Endgame score' },
      { key: 'totalScore', namespace: 'match', fullKey: 'match.totalScore', label: 'Total Score', description: 'Total scouted score' },
      { key: 'autoCycleTime', namespace: 'match', fullKey: 'match.autoCycleTime', label: 'Auto Cycle Time', description: 'Auto average cycle time (sec)' },
      { key: 'teleopCycleTime', namespace: 'match', fullKey: 'match.teleopCycleTime', label: 'TeleOp Cycle Time', description: 'TeleOp predict cycle time (sec)' },
      { key: 'predictCycleTime', namespace: 'match', fullKey: 'match.predictCycleTime', label: 'Predict Cycle Time', description: 'Alias of TeleOp predict cycle time (sec)' },
      { key: 'avgRating', namespace: 'match', fullKey: 'match.avgRating', label: 'Team Avg Score', description: 'Team weighted average score (TEAM)' },
      { key: 'maxScore', namespace: 'match', fullKey: 'match.maxScore', label: 'Team Max Score', description: 'Team max score (TEAM)' },
      { key: 'matchCount', namespace: 'match', fullKey: 'match.matchCount', label: 'Match Count', description: 'Scouted match count (TEAM)' },
      { key: 'brokenCount', namespace: 'match', fullKey: 'match.brokenCount', label: 'Broken Count', description: 'Broken match count (TEAM)' },
      { key: 'estimatedMaxCycles', namespace: 'match', fullKey: 'match.estimatedMaxCycles', label: 'Est. Max Cycles', description: 'Theoretical max cycles in 90s (TEAM)' }
    ]
  },
  {
    namespace: 'official',
    label: 'Official FTC Data',
    allowedTargets: ['TEAM'],
    variables: [
      { key: 'advancementPoints', namespace: 'official', fullKey: 'official.advancementPoints', label: 'Advancement Points', description: 'Total advancement points' },
      { key: 'advancementRank', namespace: 'official', fullKey: 'official.advancementRank', label: 'Advancement Rank', description: 'Current advancement rank' }
    ]
  },
  {
    namespace: 'pit',
    label: 'Pit Scouting',
    allowedTargets: ['PIT', 'TEAM'],
    variables: [
      { key: 'weightLbs', namespace: 'pit', fullKey: 'pit.weightLbs', label: 'Weight (lbs)', description: 'Robot weight in lbs' },
      { key: 'claimedAutoScore', namespace: 'pit', fullKey: 'pit.claimedAutoScore', label: 'Claimed Auto', description: 'Self-reported auto score' },
      { key: 'claimedTeleopCycles', namespace: 'pit', fullKey: 'pit.claimedTeleopCycles', label: 'Claimed TeleOp Cycles', description: 'Self-reported teleop cycles' },
      { key: 'claimedTeleopScore', namespace: 'pit', fullKey: 'pit.claimedTeleopScore', label: 'Claimed TeleOp', description: 'Self-reported teleop score' },
      { key: 'claimedEndgameScore', namespace: 'pit', fullKey: 'pit.claimedEndgameScore', label: 'Claimed Endgame', description: 'Self-reported endgame score' },
      { key: 'claimedTotalScore', namespace: 'pit', fullKey: 'pit.claimedTotalScore', label: 'Claimed Total', description: 'Self-reported total score' },
      { key: 'hasColorSensor', namespace: 'pit', fullKey: 'pit.hasColorSensor', label: 'Has Color Sensor', description: '1 if true, 0 if false' },
      { key: 'hasDescoreMech', namespace: 'pit', fullKey: 'pit.hasDescoreMech', label: 'Has Descore Mech', description: '1 if true, 0 if false' },
      { key: 'hasApriltagVision', namespace: 'pit', fullKey: 'pit.hasApriltagVision', label: 'Has AprilTag Vision', description: '1 if true, 0 if false' }
    ]
  }
]

function parseOptions(def?: CustomFieldDefinition): CustomFieldOption[] {
  if (!def) return []
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

/**
 * Resolves a raw custom field value into a finite number (or null),
 * automatically mapping `select` / `multi_select` option `numericValue` weights.
 */
export function resolveCustomFieldNumericValue(
  rawValue: unknown,
  def?: CustomFieldDefinition
): number | null {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null

  if (typeof rawValue === 'boolean') {
    return rawValue ? 1 : 0
  }

  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? rawValue : null
  }

  if (def && (def.fieldType === 'select' || def.fieldType === 'multi_select')) {
    const options = parseOptions(def)
    if (options.length > 0) {
      if (def.fieldType === 'select' && typeof rawValue === 'string') {
        const opt = options.find((o) => o.value === rawValue)
        if (opt && typeof opt.numericValue === 'number' && Number.isFinite(opt.numericValue)) {
          return opt.numericValue
        }
      }
      if (def.fieldType === 'multi_select' && Array.isArray(rawValue)) {
        let sum = 0
        let count = 0
        for (const item of rawValue) {
          const opt = options.find((o) => o.value === item)
          if (opt && typeof opt.numericValue === 'number' && Number.isFinite(opt.numericValue)) {
            sum += opt.numericValue
            count++
          }
        }
        return count > 0 ? sum : null
      }
    }
  }

  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim()
    if (trimmed === 'true') return 1
    if (trimmed === 'false') return 0
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function aggregateValues(values: number[], mode: CustomFieldAggregationMode = 'avg'): number | null {
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

export function buildCustomFieldNamespace(
  values: Record<string, unknown> | undefined,
  fieldDefinitions: CustomFieldDefinition[] | undefined,
  target?: CustomFieldTarget
): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  const defByKey = new Map<string, CustomFieldDefinition>()
  for (const def of fieldDefinitions ?? []) {
    if (!target || def.target === target) {
      defByKey.set(def.fieldKey, def)
    }
  }

  if (values) {
    for (const [k, rawVal] of Object.entries(values)) {
      const def = defByKey.get(k)
      out[k] = resolveCustomFieldNumericValue(rawVal, def)
    }
  }
  return out
}

export interface MatchFormulaContextInput {
  formData?: Partial<ScoutingFormData>
  record?: Partial<ScoutingRecord>
  customFieldValues?: Record<string, unknown>
  fieldDefinitions?: CustomFieldDefinition[]
  formulaValues?: Record<string, number | null>
}

export function buildMatchFormulaContext(input: MatchFormulaContextInput): FormulaContext {
  const form = input.formData
  const rec = input.record
  const parsedRaw = rec?.rawData ? parseScoutRawData(rec.rawData) : undefined

  const autoCycleTimestamps = form?.autoCycleTimestamps ?? parsedRaw?.autoCycleTimestamps
  const autoCycles = form?.autoCycles ?? parsedRaw?.autoCycles
  const teleopCycleTimestamps = form?.teleopCycleTimestamps ?? parsedRaw?.teleopCycleTimestamps
  const teleopCycles = form?.teleopCycles ?? parsedRaw?.teleopCycles

  const autoCycleTime =
    form?.autoCycleTimeSec ??
    parsedRaw?.autoCycleTimeSec ??
    calcMatchAutoCycleTime(autoCycles, autoCycleTimestamps)
  const teleopCycleTime =
    form?.predictCycleTimeSec ??
    parsedRaw?.predictCycleTimeSec ??
    calcMatchPredictCycleTime(teleopCycles, teleopCycleTimestamps)

  const cfValues =
    input.customFieldValues ??
    form?.customFields ??
    (rec?.rawData ? (() => {
      try {
        const p = JSON.parse(rec.rawData)
        return p?.customFields as Record<string, unknown> | undefined
      } catch {
        return undefined
      }
    })() : undefined)

  return {
    match: {
      autoScore: rec?.autoScore ?? null,
      teleopScore: rec?.teleopScore ?? null,
      endgameScore: rec?.endgameScore ?? null,
      totalScore: rec?.totalScore ?? null,
      autoBalls: form?.autoBalls ?? parsedRaw?.autoBalls ?? null,
      autoCyclesCount: autoCycles?.length ?? 0,
      teleopCyclesCount: teleopCycles?.length ?? 0,
      autoLeave: form?.autoLeave ?? parsedRaw?.autoLeave ?? false,
      autoPark: form?.autoPark ?? parsedRaw?.autoPark ?? false,
      teleopPark: form?.teleopPark ?? parsedRaw?.endgame.teleopPark ?? false,
      flowerNectars: form?.flowerNectars ?? parsedRaw?.endgame.flowerNectars ?? 0,
      flowerBottomBonusCount: form?.flowerBottomBonusCount ?? parsedRaw?.endgame.flowerBottomBonusCount ?? 0,
      flowerPollens: form?.flowerPollens ?? parsedRaw?.endgame.flowerPollens ?? 0,
      gardenBalls: form?.gardenBalls ?? parsedRaw?.endgame.gardenBalls ?? 0,
      isBroken: form?.isBroken ?? rec?.isBroken ?? false,
      autoCycleTime,
      teleopCycleTime,
      predictCycleTime: teleopCycleTime
    },
    cf: buildCustomFieldNamespace(cfValues, input.fieldDefinitions, 'MATCH'),
    formula: { ...(input.formulaValues ?? {}) }
  }
}

export interface PitFormulaContextInput {
  pitRecord?: Partial<PitScoutingRecord>
  customFieldValues?: Record<string, unknown>
  fieldDefinitions?: CustomFieldDefinition[]
  formulaValues?: Record<string, number | null>
}

export function buildPitFormulaContext(input: PitFormulaContextInput): FormulaContext {
  const pit = input.pitRecord
  const cfValues = input.customFieldValues ?? pit?.customFields
  const resolvedCf = buildCustomFieldNamespace(cfValues, input.fieldDefinitions, 'PIT')

  return {
    pit: {
      weightLbs: pit?.weightLbs ?? null,
      claimedAutoScore: pit?.claimedAutoScore ?? null,
      claimedTeleopCycles: pit?.claimedTeleopCycles ?? null,
      claimedTeleopScore: pit?.claimedTeleopScore ?? null,
      claimedEndgameScore: pit?.claimedEndgameScore ?? null,
      claimedTotalScore: pit?.claimedTotalScore ?? null,
      hasColorSensor: pit?.hasColorSensor ?? false,
      hasDescoreMech: pit?.hasDescoreMech ?? false,
      hasApriltagVision: pit?.hasApriltagVision ?? false
    },
    pit_cf: resolvedCf,
    cf: resolvedCf,
    formula: { ...(input.formulaValues ?? {}) }
  }
}

export interface TeamFormulaContextInput {
  rankingRow?: Partial<RankingRow>
  pitRecord?: Partial<PitScoutingRecord>
  matchRecords?: Array<Partial<ScoutingRecord>>
  fieldDefinitions?: CustomFieldDefinition[]
  formulaValues?: Record<string, number | null>
}

export function buildTeamFormulaContext(input: TeamFormulaContextInput): FormulaContext {
  const row = input.rankingRow
  const pit = input.pitRecord
  const defs = input.fieldDefinitions ?? []

  const matchFieldDefs = defs.filter((d) => d.target === 'MATCH' && d.fieldType !== 'formula')
  const matchCfArrays: Record<string, number[]> = {}
  const cfAggregated: Record<string, number | null> = {}

  for (const def of matchFieldDefs) {
    matchCfArrays[def.fieldKey] = []
  }

  for (const rec of input.matchRecords ?? []) {
    if (rec.isDeleted || rec.isBroken) continue
    let customFields: Record<string, unknown> | undefined
    if (typeof rec.rawData === 'string' && rec.rawData.trim()) {
      try {
        const parsed = JSON.parse(rec.rawData)
        if (parsed && typeof parsed === 'object' && parsed.customFields) {
          customFields = parsed.customFields
        }
      } catch {
        // Ignore malformed rawData
      }
    }
    if (!customFields) continue

    for (const [key, rawVal] of Object.entries(customFields)) {
      const def = matchFieldDefs.find((d) => d.fieldKey === key)
      const num = resolveCustomFieldNumericValue(rawVal, def)
      if (num !== null) {
        if (!matchCfArrays[key]) matchCfArrays[key] = []
        matchCfArrays[key]!.push(num)
      }
    }
  }

  for (const [key, arr] of Object.entries(matchCfArrays)) {
    const def = matchFieldDefs.find((d) => d.fieldKey === key)
    cfAggregated[key] = aggregateValues(arr, def?.aggregationMode ?? 'avg')
  }

  const pitCf = buildCustomFieldNamespace(pit?.customFields, defs, 'PIT')

  return {
    opr: {
      np: row?.spNpOpr ?? null,
      rawNp: row?.rawNpOpr ?? null,
      auto: row?.spNpOprAuto ?? null,
      teleop: row?.spNpOprTeleop ?? null,
      endgame: row?.spNpOprEndgame ?? null,
      delta: row?.spNpOprDelta ?? null,
      confidenceScore: row?.spNpOprConfidenceScore ?? null,
      officialMatches: row?.spNpOprOfficialMatches ?? null,
      brokenExcluded: row?.spNpOprBrokenExcluded ?? null
    },
    match: {
      avgAutoScore: row?.avgAutoScore ?? null,
      avgTeleopScore: row?.avgTeleopScore ?? null,
      avgEndgameScore: row?.avgEndgameScore ?? null,
      avgRating: row?.avgRating ?? null,
      maxScore: row?.maxScore ?? null,
      matchCount: row?.matchCount ?? null,
      brokenCount: row?.brokenCount ?? null,
      avgTipsPerMatch: row?.avgTipsPerMatch ?? null,
      teleopParkRate: row?.teleopParkRate ?? null,
      avgMobilityRpPts: row?.avgMobilityRpPts ?? null,
      avgFlowerNectars: row?.avgFlowerNectars ?? null,
      avgFlowerBottomBonus: row?.avgFlowerBottomBonus ?? null,
      avgFlowerPollens: row?.avgFlowerPollens ?? null,
      avgGardenBalls: row?.avgGardenBalls ?? null,
      descoreRate: row?.descoreRate ?? null,
      g410FoulRate: row?.g410FoulRate ?? null,
      autoCycleTime: row?.autoCycleTime ?? null,
      autoCycleMatches: row?.autoCycleMatches ?? null,
      teleopCycleTime: row?.teleopCycleTime ?? row?.predictCycleTime ?? null,
      predictCycleTime: row?.predictCycleTime ?? null,
      predictCycleMatches: row?.predictCycleMatches ?? null,
      predictCycleSpread: row?.predictCycleSpread ?? null,
      estimatedMaxCycles: row?.estimatedMaxCycles ?? null,
      minCycles: row?.minCycles ?? null,
      cycleVariance: row?.cycleVariance ?? null
    },
    official: {
      advancementPoints: row?.advancementPoints ?? null,
      advancementRank: row?.advancementRank ?? null
    },
    pit: {
      weightLbs: pit?.weightLbs ?? null,
      claimedAutoScore: pit?.claimedAutoScore ?? null,
      claimedTeleopCycles: pit?.claimedTeleopCycles ?? null,
      claimedTeleopScore: pit?.claimedTeleopScore ?? null,
      claimedEndgameScore: pit?.claimedEndgameScore ?? null,
      claimedTotalScore: pit?.claimedTotalScore ?? null,
      hasColorSensor: pit?.hasColorSensor ?? false,
      hasDescoreMech: pit?.hasDescoreMech ?? false,
      hasApriltagVision: pit?.hasApriltagVision ?? false
    },
    pit_cf: pitCf,
    match_cf: matchCfArrays,
    cf: cfAggregated,
    formula: { ...(input.formulaValues ?? {}) }
  }
}
