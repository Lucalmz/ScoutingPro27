import type {
  CustomFieldAggregationMode,
  CustomFieldConfig,
  CustomFieldDisplayFormat,
  CustomFieldOption,
  CustomFieldPhase,
  CustomFieldTarget,
  CustomFieldType
} from '@/types'

export interface FormulaFieldTemplate {
  id: string
  name: string
  description: string
  target: CustomFieldTarget
  phase: CustomFieldPhase
  fieldKey: string
  fieldType: CustomFieldType
  formulaExpr?: string
  aggregationMode?: CustomFieldAggregationMode
  displayFormat?: CustomFieldDisplayFormat
  unit?: string
  config?: CustomFieldConfig
  options?: CustomFieldOption[]
}

export const FORMULA_TEMPLATES: FormulaFieldTemplate[] = [
  {
    id: 'sp_np_opr_team_power',
    name: 'SP-NP OPR Power Index',
    description: 'Combined power index blending SP-NP OPR with advancement points',
    target: 'TEAM',
    phase: 'overall',
    fieldKey: 'team_power_index',
    fieldType: 'formula',
    formulaExpr: 'ROUND(opr.np * 0.7 + NORM(COALESCE(official.advancementPoints, 0), 0, 100) * 0.3, 1)',
    displayFormat: 'number',
    config: { decimalPlaces: 1 }
  },
  {
    id: 'stability_weighted_opr',
    name: 'Stability-Weighted OPR',
    description: 'Penalizes SP-NP OPR by broken match rate across scouted matches',
    target: 'TEAM',
    phase: 'overall',
    fieldKey: 'stable_opr',
    fieldType: 'formula',
    formulaExpr: 'ROUND(opr.np * (1 - SAFE_DIV(match.brokenCount, match.matchCount, 0) * 0.5), 1)',
    displayFormat: 'number',
    config: { decimalPlaces: 1 }
  },
  {
    id: 'official_vs_scout_delta_pct',
    name: 'Official vs Scout Delta %',
    description: 'Percentage difference between SP-NP OPR and Scout average rating',
    target: 'TEAM',
    phase: 'overall',
    fieldKey: 'opr_scout_delta_pct',
    fieldType: 'formula',
    formulaExpr: 'ROUND(SAFE_DIV(opr.np - match.avgRating, match.avgRating, 0) * 100, 1)',
    displayFormat: 'percent',
    unit: '%',
    config: { decimalPlaces: 1 }
  },
  {
    id: 'recent3_trend_delta',
    name: 'Recent-3 vs Season Trend',
    description: 'Difference between recent 3-match average and trimmed season average',
    target: 'TEAM',
    phase: 'overall',
    fieldKey: 'recent3_trend',
    fieldType: 'formula',
    formulaExpr: 'ROUND(RECENT_AVG(match_cf.balls, 3) - TRIMMED_AVG(match_cf.balls), 1)',
    displayFormat: 'number',
    config: { decimalPlaces: 1 }
  },
  {
    id: 'auto_teleop_cycle_efficiency',
    name: 'Auto / TeleOp Cycle Efficiency',
    description: 'Match-level scoring efficiency per second across Auto and TeleOp cycle times',
    target: 'MATCH',
    phase: 'overall',
    fieldKey: 'cycle_efficiency',
    fieldType: 'formula',
    formulaExpr: 'ROUND(SAFE_DIV(match.autoScore, match.autoCycleTime, 0) + SAFE_DIV(match.teleopScore, match.teleopCycleTime, 0), 2)',
    displayFormat: 'number',
    config: { decimalPlaces: 2 }
  },
  {
    id: 'timer_endgame_park_sec',
    name: 'Endgame Align Timer (s)',
    description: 'Stopwatch field measuring robot alignment duration in Endgame',
    target: 'MATCH',
    phase: 'endgame',
    fieldKey: 'endgame_align_sec',
    fieldType: 'timer',
    aggregationMode: 'avg',
    displayFormat: 'number',
    unit: 's',
    config: { decimalPlaces: 1 }
  },
  {
    id: 'weighted_defense_select',
    name: 'Defense Capability Tier',
    description: 'Weighted select field assigning numeric defense scores for formula use',
    target: 'MATCH',
    phase: 'teleop',
    fieldKey: 'defense_tier',
    fieldType: 'select',
    aggregationMode: 'avg',
    displayFormat: 'number',
    config: { selectStyle: 'chips' },
    options: [
      { label: 'None', value: 'none', color: 'gray', numericValue: 0 },
      { label: 'Light', value: 'light', color: 'blue', numericValue: 3 },
      { label: 'Strong', value: 'strong', color: 'green', numericValue: 7 },
      { label: 'Shutdown', value: 'shutdown', color: 'purple', numericValue: 10 }
    ]
  }
]
