<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  CustomFieldDefinition,
  CustomFieldDisplayFormat,
  CustomFieldTarget
} from '@/types'
import {
  ALLOWED_FORMULA_FUNCTIONS,
  FORMULA_VARIABLE_GROUPS,
  buildMatchFormulaContext,
  buildPitFormulaContext,
  buildTeamFormulaContext,
  evaluateFormula,
  topologicalSortFormulas,
  validateFormulaGraph,
  type FormulaContext,
  type FormulaContextValue,
  type FormulaValidationResult
} from '@/utils/formula'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'

const props = defineProps<{
  modelValue: string
  target: CustomFieldTarget
  fieldKey?: string
  existingFields: CustomFieldDefinition[]
  displayFormat?: CustomFieldDisplayFormat | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: string): void
  (e: 'validation-change', result: FormulaValidationResult): void
}>()

let t = (key: string, values?: any): string => {
  const fallback: Record<string, string> = {
    'custom_fields.formula_editor.expr_label': '公式表达式',
    'custom_fields.formula_editor.expr_placeholder': '例如: ROUND(opr.np * 0.7 + match.avgRating * 0.3, 1)',
    'custom_fields.formula_editor.valid_badge': '语法与依赖校验通过',
    'custom_fields.formula_editor.variables_title': '可用变量（点击插入）',
    'custom_fields.formula_editor.functions_title': '安全函数（点击插入）',
    'custom_fields.formula_editor.preview_title': '实时试算预览',
    'custom_fields.formula_editor.sample_context': '示例数据',
    'custom_fields.formula_editor.custom_fields_group': '赛事自定义字段',
    'custom_fields.formula_editor.preview_empty': '—'
  }
  if (key === 'custom_fields.formula_editor.team_option' && values?.team) {
    return `Team #${values.team}`
  }
  return fallback[key] ?? key
}

try {
  const i18n = useI18n()
  t = i18n.t
} catch {
  // Isolated test fallback
}

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const selectedTeamNumber = ref<number | 'sample'>('sample')

let recordStore: ReturnType<typeof useRecordStore> | null = null
let pitStore: ReturnType<typeof usePitScoutStore> | null = null
try {
  recordStore = useRecordStore()
  pitStore = usePitScoutStore()
} catch {
  // Pinia not installed in isolated component test
}

const validation = computed<FormulaValidationResult>(() => {
  return validateFormulaGraph(
    {
      target: props.target,
      fieldKey: props.fieldKey || '__candidate__',
      fieldType: 'formula',
      formulaExpr: props.modelValue
    },
    props.existingFields
  )
})

watch(
  validation,
  (res) => {
    emit('validation-change', res)
  },
  { immediate: true }
)

const builtInGroups = computed(() => {
  return FORMULA_VARIABLE_GROUPS.filter((g) => g.allowedTargets.includes(props.target))
})

const customFieldChips = computed(() => {
  const chips: Array<{ fullKey: string; label: string; description: string }> = []
  const fields = props.existingFields || []

  for (const f of fields) {
    if (!f.fieldKey || f.fieldKey === props.fieldKey) continue
    if (f.fieldType === 'formula') {
      if (props.target === 'TEAM' || f.target === props.target) {
        chips.push({
          fullKey: `formula.${f.fieldKey}`,
          label: `${f.name} (formula)`,
          description: f.description || f.formulaExpr || f.fieldKey
        })
      }
      continue
    }

    if (props.target === 'MATCH' && f.target === 'MATCH') {
      chips.push({
        fullKey: `cf.${f.fieldKey}`,
        label: f.name,
        description: f.description || f.fieldKey
      })
    } else if (props.target === 'PIT' && f.target === 'PIT') {
      chips.push({
        fullKey: `pit_cf.${f.fieldKey}`,
        label: f.name,
        description: f.description || f.fieldKey
      })
    } else if (props.target === 'TEAM') {
      if (f.target === 'MATCH') {
        chips.push({
          fullKey: `cf.${f.fieldKey}`,
          label: `${f.name} (${f.aggregationMode || 'avg'})`,
          description: `Aggregated MATCH field: cf.${f.fieldKey}`
        })
        chips.push({
          fullKey: `match_cf.${f.fieldKey}`,
          label: `${f.name} []`,
          description: `Per-match array: match_cf.${f.fieldKey}`
        })
      } else if (f.target === 'PIT') {
        chips.push({
          fullKey: `pit_cf.${f.fieldKey}`,
          label: `${f.name} (Pit)`,
          description: `PIT field: pit_cf.${f.fieldKey}`
        })
      }
    }
  }

  return chips
})

const functionList = computed(() => Array.from(ALLOWED_FORMULA_FUNCTIONS))

const availableTeams = computed(() => {
  const teams = new Set<number>()
  for (const r of recordStore?.rankings ?? []) {
    if (r.teamNumber) teams.add(r.teamNumber)
  }
  for (const p of pitStore?.activeRecords ?? []) {
    if (p.teamNumber) teams.add(p.teamNumber)
  }
  return Array.from(teams).sort((a, b) => a - b)
})

watch(
  availableTeams,
  (list) => {
    if (selectedTeamNumber.value === 'sample' && list.length > 0) {
      selectedTeamNumber.value = list[0]!
    }
  },
  { immediate: true }
)

const sampleContext: FormulaContext = {
  opr: {
    np: 48.5,
    rawNp: 46.2,
    auto: 14.1,
    teleop: 26.4,
    endgame: 8.0,
    delta: 2.3,
    confidenceScore: 88,
    officialMatches: 8,
    brokenExcluded: 0
  },
  match: {
    autoScore: 16,
    teleopScore: 30,
    endgameScore: 10,
    totalScore: 56,
    avgAutoScore: 15.2,
    avgTeleopScore: 28.5,
    avgEndgameScore: 9.0,
    avgRating: 52.7,
    maxScore: 68,
    matchCount: 6,
    brokenCount: 0,
    autoCycleTime: 3.4,
    teleopCycleTime: 4.8,
    predictCycleTime: 4.8,
    estimatedMaxCycles: 18
  },
  official: {
    advancementPoints: 64,
    advancementRank: 3
  },
  pit: {
    weightLbs: 38.5,
    claimedAutoScore: 18,
    claimedTeleopCycles: 10,
    claimedTeleopScore: 32,
    claimedEndgameScore: 10,
    claimedTotalScore: 60,
    hasColorSensor: true,
    hasDescoreMech: true,
    hasApriltagVision: true
  },
  cf: {},
  pit_cf: {},
  match_cf: {},
  formula: {}
}

const previewResult = computed(() => {
  const expr = props.modelValue.trim()
  if (!expr) return { display: t('custom_fields.formula_editor.preview_empty'), error: null as string | null }
  if (!validation.value.valid) {
    return { display: t('custom_fields.formula_editor.preview_empty'), error: validation.value.error || 'Invalid' }
  }

  let ctx: FormulaContext = sampleContext
  if (selectedTeamNumber.value !== 'sample') {
    const teamNum = selectedTeamNumber.value
    const teamRow = recordStore?.rankings.find((r) => r.teamNumber === teamNum)
    const teamMatches = (recordStore?.activeRecords ?? []).filter((r) => r.teamNumber === teamNum)
    const teamPit = (pitStore?.activeRecords ?? []).find((p) => p.teamNumber === teamNum)

    if (props.target === 'MATCH') {
      ctx = buildMatchFormulaContext({
        record: teamMatches[0],
        fieldDefinitions: props.existingFields
      })
    } else if (props.target === 'PIT') {
      ctx = buildPitFormulaContext({
        pitRecord: teamPit,
        fieldDefinitions: props.existingFields
      })
    } else {
      ctx = buildTeamFormulaContext({
        rankingRow: teamRow,
        pitRecord: teamPit,
        matchRecords: teamMatches,
        fieldDefinitions: props.existingFields
      })
    }
  }

  // Evaluate referenced formulas in topological order
  const { sorted } = topologicalSortFormulas(props.existingFields)
  const formulaVals: Record<string, FormulaContextValue> = { ...(ctx.formula ?? {}) }
  for (const f of sorted) {
    if (!f.formulaExpr || f.fieldKey === props.fieldKey) continue
    const subRes = evaluateFormula(
      f.formulaExpr,
      { ...ctx, formula: formulaVals },
      { target: f.target, fieldKey: f.fieldKey }
    )
    formulaVals[f.fieldKey] = subRes.value
  }

  const res = evaluateFormula(
    expr,
    { ...ctx, formula: formulaVals },
    { target: props.target, fieldKey: props.fieldKey || '__candidate__' }
  )

  if (res.error) {
    return { display: t('custom_fields.formula_editor.preview_empty'), error: res.error }
  }
  if (res.value === null) {
    return { display: 'null', error: null }
  }
  const formatted = props.displayFormat === 'percent'
    ? `${res.value.toFixed(1)}%`
    : props.displayFormat === 'integer'
      ? String(Math.round(res.value))
      : props.displayFormat === 'boolean'
        ? (res.value !== 0 ? 'true' : 'false')
        : (Number.isInteger(res.value) ? String(res.value) : res.value.toFixed(2))
  return { display: formatted, error: null }
})

function insertText(snippet: string, cursorOffsetBack = 0) {
  const el = textareaRef.value
  const current = props.modelValue || ''
  if (!el) {
    emit('update:modelValue', current ? `${current} ${snippet}` : snippet)
    return
  }
  const start = el.selectionStart ?? current.length
  const end = el.selectionEnd ?? current.length
  const next = current.slice(0, start) + snippet + current.slice(end)
  emit('update:modelValue', next)
  requestAnimationFrame(() => {
    el.focus()
    const pos = Math.max(0, start + snippet.length - cursorOffsetBack)
    el.setSelectionRange(pos, pos)
  })
}
</script>

<template>
  <div class="formula-editor-panel">
    <div class="formula-expr-header">
      <label class="formula-label">{{ t('custom_fields.formula_editor.expr_label') }} <span class="required">*</span></label>
      <span v-if="validation.valid" class="formula-status-badge is-valid">
        <span class="material-icons">check_circle</span>
        {{ t('custom_fields.formula_editor.valid_badge') }}
      </span>
      <span v-else-if="modelValue.trim()" class="formula-status-badge is-error">
        <span class="material-icons">error</span>
        {{ validation.errorCode || 'INVALID' }}
      </span>
    </div>

    <textarea
      ref="textareaRef"
      class="formula-textarea"
      rows="3"
      :value="modelValue"
      :placeholder="t('custom_fields.formula_editor.expr_placeholder')"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    ></textarea>

    <div v-if="!validation.valid && modelValue.trim()" class="formula-error-box">
      <div class="error-msg">{{ validation.error }}</div>
      <div v-if="validation.cyclePath && validation.cyclePath.length" class="cycle-path">
        {{ validation.cyclePath.join(' -> ') }}
      </div>
    </div>

    <!-- Live Preview -->
    <div class="formula-preview-bar">
      <div class="preview-left">
        <span class="preview-title">{{ t('custom_fields.formula_editor.preview_title') }}</span>
        <select v-model="selectedTeamNumber" class="preview-team-select">
          <option value="sample">{{ t('custom_fields.formula_editor.sample_context') }}</option>
          <option v-for="tm in availableTeams" :key="tm" :value="tm">
            {{ t('custom_fields.formula_editor.team_option', { team: tm }) }}
          </option>
        </select>
      </div>
      <div class="preview-result">
        <span class="preview-value">{{ previewResult.display }}</span>
      </div>
    </div>

    <!-- Variables -->
    <div class="chips-section">
      <div class="chips-section-title">{{ t('custom_fields.formula_editor.variables_title') }}</div>
      <div v-for="group in builtInGroups" :key="group.namespace" class="var-group">
        <div class="var-group-label">{{ group.label }}</div>
        <div class="chips-wrap">
          <button
            v-for="v in group.variables"
            :key="v.fullKey"
            type="button"
            class="insert-chip var-chip"
            :title="v.description"
            @click="insertText(v.fullKey)"
          >
            <code>{{ v.fullKey }}</code>
            <span class="chip-sub">{{ v.label }}</span>
          </button>
        </div>
      </div>

      <div v-if="customFieldChips.length > 0" class="var-group">
        <div class="var-group-label">{{ t('custom_fields.formula_editor.custom_fields_group') }}</div>
        <div class="chips-wrap">
          <button
            v-for="cf in customFieldChips"
            :key="cf.fullKey"
            type="button"
            class="insert-chip cf-chip"
            :title="cf.description"
            @click="insertText(cf.fullKey)"
          >
            <code>{{ cf.fullKey }}</code>
            <span class="chip-sub">{{ cf.label }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Functions -->
    <div class="chips-section">
      <div class="chips-section-title">{{ t('custom_fields.formula_editor.functions_title') }}</div>
      <div class="chips-wrap">
        <button
          v-for="fn in functionList"
          :key="fn"
          type="button"
          class="insert-chip fn-chip"
          @click="insertText(`${fn}()`, 1)"
        >
          {{ fn }}()
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.formula-editor-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 10px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
}

.formula-expr-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.formula-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
}

.required {
  color: var(--destructive);
}

.formula-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
}

.formula-status-badge .material-icons {
  font-size: 14px;
}

.formula-status-badge.is-valid {
  background: var(--status-success-bg);
  color: var(--status-success);
}

.formula-status-badge.is-error {
  background: var(--status-error-bg);
  color: var(--status-error);
}

.formula-textarea {
  width: 100%;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--input);
  color: var(--foreground);
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  resize: vertical;
}

.formula-error-box {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--status-error-bg);
  color: var(--status-error);
  font-size: 12px;
}

.cycle-path {
  margin-top: 4px;
  font-family: monospace;
  font-weight: 700;
}

.formula-preview-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
}

.preview-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
}

.preview-team-select {
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--input);
  color: var(--foreground);
  font-size: 12px;
  padding: 0 6px;
}

.preview-value {
  font-size: 16px;
  font-weight: 800;
  color: var(--primary);
  font-family: var(--font-numeric);
}

.chips-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chips-section-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted-foreground);
  text-transform: uppercase;
}

.var-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.var-group-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--foreground);
}

.chips-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.insert-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-elevated);
  color: var(--foreground);
  font-size: 11px;
  cursor: pointer;
}

.insert-chip:hover {
  border-color: var(--primary);
}

.insert-chip code {
  color: var(--primary);
  font-weight: 600;
}

.chip-sub {
  color: var(--muted-foreground);
}

.fn-chip {
  font-family: monospace;
  font-weight: 600;
  color: var(--status-ai, var(--primary));
}
</style>
