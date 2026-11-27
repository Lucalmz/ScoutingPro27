<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  CustomFieldAggregationMode,
  CustomFieldConfig,
  CustomFieldDefinition,
  CustomFieldDisplayFormat,
  CustomFieldOption,
  CustomFieldPhase,
  CustomFieldTarget,
  CustomFieldType
} from '@/types'
import type { FormulaValidationResult } from '@/utils/formula'
import { useToastStore } from '@/stores/toast'
import { hapticLight } from '@/utils/haptics'
import FormulaEditorPanel from './FormulaEditorPanel.vue'

const props = defineProps<{
  eventId: string
  activeTab: CustomFieldTarget
  editingField: CustomFieldDefinition | null
  isSaving: boolean
  existingFields?: CustomFieldDefinition[]
}>()

const emit = defineEmits<{
  (e: 'save', payload: Partial<CustomFieldDefinition>, editingId: string | null): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()
const toast = useToastStore()

const COLOR_PRESETS = ['blue', 'green', 'orange', 'red', 'purple', 'gray']
const AGGREGATION_MODES: CustomFieldAggregationMode[] = [
  'avg',
  'median',
  'max',
  'min',
  'sum',
  'last3',
  'trimmed_avg',
  'stddev',
  'rate'
]
const DISPLAY_FORMATS: CustomFieldDisplayFormat[] = ['number', 'integer', 'percent', 'boolean', 'tier']

const editingId = ref<string | null>(null)
const formName = ref('')
const formKey = ref('')
const formPhase = ref<CustomFieldPhase>('overall')
const formType = ref<CustomFieldType>('number')
const formRequired = ref(false)
const formUnit = ref('')
const formDescription = ref('')
const formDefaultVal = ref('')
const formMin = ref<number | null>(null)
const formMax = ref<number | null>(null)
const formStep = ref<number | null>(1)
const formLevelCount = ref(5)
const formOptions = ref<CustomFieldOption[]>([])
const newOptionLabel = ref('')
const newOptionColor = ref('blue')
const newOptionNumeric = ref<number | null>(null)

const formAggregationMode = ref<CustomFieldAggregationMode>('avg')
const formDisplayFormat = ref<CustomFieldDisplayFormat>('number')
const formFormulaExpr = ref('')
const formulaValidation = ref<FormulaValidationResult | null>(null)

// Config fields
const cfgInputMode = ref<'stepper' | 'slider' | 'counter' | 'direct'>('stepper')
const cfgQuickStepsStr = ref('')
const cfgShowTicks = ref(false)
const cfgTristate = ref(false)
const cfgTrueLabel = ref('')
const cfgFalseLabel = ref('')
const cfgLevelStyle = ref<'blocks' | 'stars'>('blocks')
const cfgLevelLowLabel = ref('')
const cfgLevelHighLabel = ref('')
const cfgSelectStyle = ref<'chips' | 'dropdown'>('chips')
const cfgMultiline = ref(true)
const cfgPlaceholder = ref('')
const cfgMaxLength = ref<number | null>(null)
const cfgDecimalPlaces = ref<number | null>(null)
const cfgTierHigh = ref<number | null>(null)
const cfgTierMid = ref<number | null>(null)
const cfgTierDirection = ref<'higher_better' | 'lower_better'>('higher_better')

const isTeamTarget = computed(() => props.activeTab === 'TEAM')

function parseConfig(f: CustomFieldDefinition): CustomFieldConfig {
  if (f.config && typeof f.config === 'object') return f.config
  if (typeof f.configJson === 'string' && f.configJson.trim()) {
    try {
      const parsed = JSON.parse(f.configJson)
      if (parsed && typeof parsed === 'object') return parsed as CustomFieldConfig
    } catch {
      return {}
    }
  }
  return {}
}

function initForm(f: CustomFieldDefinition | null) {
  if (f) {
    editingId.value = f.id
    formName.value = f.name
    formKey.value = f.fieldKey
    formPhase.value = f.phase
    formType.value = props.activeTab === 'TEAM' ? 'formula' : f.fieldType
    formRequired.value = f.required
    formUnit.value = f.unit || ''
    formDescription.value = f.description || ''
    formDefaultVal.value = f.defaultVal ?? ''
    formMin.value = f.minVal ?? null
    formMax.value = f.maxVal ?? null
    formStep.value = f.stepVal ?? 1
    formLevelCount.value = f.maxVal ? Math.round(f.maxVal) : 5
    formOptions.value = f.options ? JSON.parse(JSON.stringify(f.options)) : []
    formAggregationMode.value = f.aggregationMode || 'avg'
    formDisplayFormat.value = f.displayFormat || 'number'
    formFormulaExpr.value = f.formulaExpr || ''

    const cfg = parseConfig(f)
    cfgInputMode.value = cfg.inputMode || 'stepper'
    cfgQuickStepsStr.value = Array.isArray(cfg.quickSteps) ? cfg.quickSteps.join(', ') : ''
    cfgShowTicks.value = !!cfg.showTicks
    cfgTristate.value = !!cfg.tristate
    cfgTrueLabel.value = cfg.trueLabel || ''
    cfgFalseLabel.value = cfg.falseLabel || ''
    cfgLevelStyle.value = cfg.levelStyle || 'blocks'
    cfgLevelLowLabel.value = cfg.levelLowLabel || ''
    cfgLevelHighLabel.value = cfg.levelHighLabel || ''
    cfgSelectStyle.value = cfg.selectStyle || 'chips'
    cfgMultiline.value = cfg.multiline !== false
    cfgPlaceholder.value = cfg.placeholder || ''
    cfgMaxLength.value = cfg.maxLength ?? null
    cfgDecimalPlaces.value = cfg.decimalPlaces ?? null
    cfgTierHigh.value = cfg.tierThresholds?.high ?? null
    cfgTierMid.value = cfg.tierThresholds?.mid ?? null
    cfgTierDirection.value = cfg.tierThresholds?.direction || 'higher_better'
  } else {
    editingId.value = null
    formName.value = ''
    formKey.value = ''
    formPhase.value = props.activeTab === 'MATCH' ? 'teleop' : (props.activeTab === 'PIT' ? 'hardware' : 'overall')
    formType.value = props.activeTab === 'TEAM' ? 'formula' : 'number'
    formRequired.value = false
    formUnit.value = ''
    formDescription.value = ''
    formDefaultVal.value = ''
    formMin.value = 0
    formMax.value = null
    formStep.value = 1
    formLevelCount.value = 5
    formOptions.value = []
    formAggregationMode.value = 'avg'
    formDisplayFormat.value = 'number'
    formFormulaExpr.value = ''

    cfgInputMode.value = 'stepper'
    cfgQuickStepsStr.value = ''
    cfgShowTicks.value = false
    cfgTristate.value = false
    cfgTrueLabel.value = ''
    cfgFalseLabel.value = ''
    cfgLevelStyle.value = 'blocks'
    cfgLevelLowLabel.value = ''
    cfgLevelHighLabel.value = ''
    cfgSelectStyle.value = 'chips'
    cfgMultiline.value = true
    cfgPlaceholder.value = ''
    cfgMaxLength.value = null
    cfgDecimalPlaces.value = null
    cfgTierHigh.value = null
    cfgTierMid.value = null
    cfgTierDirection.value = 'higher_better'
  }
  newOptionLabel.value = ''
  newOptionColor.value = 'blue'
  newOptionNumeric.value = null
}

watch(
  () => [props.editingField, props.activeTab] as const,
  ([f]) => {
    initForm(f)
  },
  { immediate: true }
)

function addOption() {
  const lbl = newOptionLabel.value.trim()
  if (!lbl) return
  const val = 'opt_' + Math.random().toString(36).substring(2, 7)
  formOptions.value.push({
    label: lbl,
    value: val,
    color: newOptionColor.value,
    numericValue: typeof newOptionNumeric.value === 'number' && Number.isFinite(newOptionNumeric.value)
      ? newOptionNumeric.value
      : null
  })
  newOptionLabel.value = ''
  newOptionNumeric.value = null
  hapticLight()
}

function removeOption(idx: number) {
  formOptions.value.splice(idx, 1)
  hapticLight()
}

function buildConfigObject(): CustomFieldConfig {
  const cfg: CustomFieldConfig = {}
  if (formType.value === 'number') {
    cfg.inputMode = cfgInputMode.value
    const steps = cfgQuickStepsStr.value
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (steps.length > 0) cfg.quickSteps = steps
    if (cfgInputMode.value === 'slider' && cfgShowTicks.value) cfg.showTicks = true
  } else if (formType.value === 'boolean') {
    if (cfgTristate.value) cfg.tristate = true
    if (cfgTrueLabel.value.trim()) cfg.trueLabel = cfgTrueLabel.value.trim()
    if (cfgFalseLabel.value.trim()) cfg.falseLabel = cfgFalseLabel.value.trim()
  } else if (formType.value === 'level') {
    cfg.levelStyle = cfgLevelStyle.value
    if (cfgLevelLowLabel.value.trim()) cfg.levelLowLabel = cfgLevelLowLabel.value.trim()
    if (cfgLevelHighLabel.value.trim()) cfg.levelHighLabel = cfgLevelHighLabel.value.trim()
  } else if (formType.value === 'select') {
    cfg.selectStyle = cfgSelectStyle.value
  } else if (formType.value === 'text') {
    cfg.multiline = cfgMultiline.value
    if (cfgPlaceholder.value.trim()) cfg.placeholder = cfgPlaceholder.value.trim()
    const parsedMaxLen = parseOptionalNumber(cfgMaxLength.value)
    if (parsedMaxLen !== null && parsedMaxLen > 0) cfg.maxLength = Math.trunc(parsedMaxLen)
  }

  const parsedDecimals = parseOptionalNumber(cfgDecimalPlaces.value)
  if (parsedDecimals !== null) {
    cfg.decimalPlaces = Math.max(0, Math.min(4, Math.trunc(parsedDecimals)))
  }

  const parsedTierHigh = parseOptionalNumber(cfgTierHigh.value)
  const parsedTierMid = parseOptionalNumber(cfgTierMid.value)
  if (formDisplayFormat.value === 'tier' && (parsedTierHigh !== null || parsedTierMid !== null)) {
    cfg.tierThresholds = {
      high: parsedTierHigh ?? undefined,
      mid: parsedTierMid ?? undefined,
      direction: cfgTierDirection.value
    }
  }

  return cfg
}

function parseOptionalNumber(val: unknown): number | null {
  if (val === '' || val === null || val === undefined) return null
  const num = Number(val)
  return Number.isFinite(num) ? num : null
}

function submitForm() {
  const name = formName.value.trim()
  if (!name) {
    toast.showToast(t('custom_fields.err_name_required'), 'error')
    return
  }

  const effectiveType: CustomFieldType = isTeamTarget.value ? 'formula' : formType.value
  if (effectiveType === 'formula') {
    if (!formFormulaExpr.value.trim()) {
      toast.showToast(t('custom_fields.err_formula_required'), 'error')
      return
    }
    if (formulaValidation.value && !formulaValidation.value.valid) {
      toast.showToast(formulaValidation.value.error || t('custom_fields.err_formula_invalid'), 'error')
      return
    }
  }

  let key = formKey.value.trim().toLowerCase()
  if (!key) {
    key = 'field_' + Math.random().toString(36).substring(2, 8)
  }

  const configObj = buildConfigObject()
  const configJson = Object.keys(configObj).length > 0 ? JSON.stringify(configObj) : null
  const sanitizedOptions = formOptions.value.map((opt) => ({
    ...opt,
    numericValue: parseOptionalNumber(opt.numericValue)
  }))

  const payload: Partial<CustomFieldDefinition> = {
    eventId: props.eventId,
    target: props.activeTab,
    phase: isTeamTarget.value ? 'overall' : formPhase.value,
    name,
    fieldKey: key,
    fieldType: effectiveType,
    required: effectiveType === 'formula' ? false : formRequired.value,
    defaultVal: effectiveType === 'formula' ? null : (formDefaultVal.value.trim() || null),
    unit: formUnit.value.trim() || null,
    description: formDescription.value.trim() || null,
    configJson,
    minVal: effectiveType === 'number' ? parseOptionalNumber(formMin.value) : null,
    maxVal: effectiveType === 'number'
      ? parseOptionalNumber(formMax.value)
      : (effectiveType === 'level' ? parseOptionalNumber(formLevelCount.value) : null),
    stepVal: effectiveType === 'number' ? parseOptionalNumber(formStep.value) : null,
    optionsJson: (effectiveType === 'select' || effectiveType === 'multi_select') ? JSON.stringify(sanitizedOptions) : null,
    formulaExpr: effectiveType === 'formula' ? formFormulaExpr.value.trim() : null,
    aggregationMode: formAggregationMode.value,
    displayFormat: formDisplayFormat.value,
    dependenciesJson: effectiveType === 'formula' && formulaValidation.value
      ? JSON.stringify(formulaValidation.value.dependencies)
      : null,
    isActive: true
  }

  emit('save', payload, editingId.value)
}
</script>

<template>
  <div class="field-builder-form">
    <div class="builder-header">
      <h4>{{ editingId ? t('custom_fields.modal_edit_title') : t('custom_fields.modal_create_title') }}</h4>
      <button class="btn-back" @click="emit('cancel')">
        <span class="material-icons">arrow_back</span>
        {{ t('custom_fields.btn_back_list') }}
      </button>
    </div>

    <div class="form-grid">
      <!-- 字段名称 -->
      <div class="form-group full-width">
        <label>{{ t('custom_fields.field_name') }} <span class="required">*</span></label>
        <input
          v-model="formName"
          type="text"
          :placeholder="t('custom_fields.field_name_placeholder')"
          maxlength="100"
        />
      </div>

      <!-- 说明 -->
      <div class="form-group full-width">
        <label>{{ t('custom_fields.field_description') }}</label>
        <input
          v-model="formDescription"
          type="text"
          :placeholder="t('custom_fields.field_description_placeholder')"
          maxlength="300"
        />
      </div>

      <!-- 数据标识 Key -->
      <div class="form-group">
        <label>{{ t('custom_fields.field_key_desc') }}</label>
        <input
          v-model="formKey"
          type="text"
          :disabled="!!editingId"
          :placeholder="t('custom_fields.field_key_placeholder')"
        />
      </div>

      <!-- 挂载阶段 -->
      <div class="form-group">
        <label>{{ t('custom_fields.field_phase') }}</label>
        <select v-model="formPhase" :disabled="isTeamTarget">
          <template v-if="activeTab === 'MATCH'">
            <option value="auto">{{ t('custom_fields.phase_auto') }}</option>
            <option value="teleop">{{ t('custom_fields.phase_teleop') }}</option>
            <option value="endgame">{{ t('custom_fields.phase_endgame') }}</option>
            <option value="overall">{{ t('custom_fields.phase_overall') }}</option>
          </template>
          <template v-else-if="activeTab === 'PIT'">
            <option value="hardware">{{ t('custom_fields.phase_hardware') }}</option>
            <option value="strategy">{{ t('custom_fields.phase_strategy') }}</option>
            <option value="overall">{{ t('custom_fields.phase_pit_overall') }}</option>
          </template>
          <template v-else>
            <option value="overall">{{ t('custom_fields.phase_overall') }}</option>
          </template>
        </select>
      </div>

      <!-- 控件类型选择 -->
      <div v-if="!isTeamTarget" class="form-group full-width">
        <label>{{ t('custom_fields.field_type') }}</label>
        <div class="types-selector-grid">
          <button
            type="button"
            class="type-choice-btn"
            :class="{ 'is-active': formType === 'boolean' }"
            @click="formType = 'boolean'"
          >
            <span class="material-icons">toggle_on</span>
            <span class="choice-title">{{ t('custom_fields.type_boolean') }}</span>
            <span class="choice-desc">{{ t('custom_fields.type_boolean_desc') }}</span>
          </button>

          <button
            type="button"
            class="type-choice-btn"
            :class="{ 'is-active': formType === 'number' }"
            @click="formType = 'number'"
          >
            <span class="material-icons">pin</span>
            <span class="choice-title">{{ t('custom_fields.type_number') }}</span>
            <span class="choice-desc">{{ t('custom_fields.type_number_desc') }}</span>
          </button>

          <button
            type="button"
            class="type-choice-btn"
            :class="{ 'is-active': formType === 'timer' }"
            @click="formType = 'timer'"
          >
            <span class="material-icons">timer</span>
            <span class="choice-title">{{ t('custom_fields.type_timer') }}</span>
            <span class="choice-desc">{{ t('custom_fields.type_timer_desc') }}</span>
          </button>

          <button
            type="button"
            class="type-choice-btn"
            :class="{ 'is-active': formType === 'level' }"
            @click="formType = 'level'"
          >
            <span class="material-icons">stars</span>
            <span class="choice-title">{{ t('custom_fields.type_level') }}</span>
            <span class="choice-desc">{{ t('custom_fields.type_level_desc') }}</span>
          </button>

          <button
            type="button"
            class="type-choice-btn"
            :class="{ 'is-active': formType === 'select' }"
            @click="formType = 'select'"
          >
            <span class="material-icons">radio_button_checked</span>
            <span class="choice-title">{{ t('custom_fields.type_select') }}</span>
            <span class="choice-desc">{{ t('custom_fields.type_select_desc') }}</span>
          </button>

          <button
            type="button"
            class="type-choice-btn"
            :class="{ 'is-active': formType === 'multi_select' }"
            @click="formType = 'multi_select'"
          >
            <span class="material-icons">checklist</span>
            <span class="choice-title">{{ t('custom_fields.type_multi_select') }}</span>
            <span class="choice-desc">{{ t('custom_fields.type_multi_select_desc') }}</span>
          </button>

          <button
            type="button"
            class="type-choice-btn"
            :class="{ 'is-active': formType === 'text' }"
            @click="formType = 'text'"
          >
            <span class="material-icons">notes</span>
            <span class="choice-title">{{ t('custom_fields.type_text') }}</span>
            <span class="choice-desc">{{ t('custom_fields.type_text_desc') }}</span>
          </button>

          <button
            type="button"
            class="type-choice-btn"
            :class="{ 'is-active': formType === 'formula' }"
            @click="formType = 'formula'"
          >
            <span class="material-icons">functions</span>
            <span class="choice-title">{{ t('custom_fields.type_formula') }}</span>
            <span class="choice-desc">{{ t('custom_fields.type_formula_desc') }}</span>
          </button>
        </div>
      </div>

      <!-- FORMULA 编辑器 -->
      <div v-if="formType === 'formula' || isTeamTarget" class="form-group full-width">
        <FormulaEditorPanel
          v-model="formFormulaExpr"
          :target="activeTab"
          :field-key="formKey"
          :existing-fields="existingFields || []"
          :display-format="formDisplayFormat"
          @validation-change="formulaValidation = $event"
        />
      </div>

      <!-- 默认值 / 单位 -->
      <div v-if="formType !== 'formula' && !isTeamTarget" class="form-group">
        <label>{{ t('custom_fields.default_val_label') }}</label>
        <input
          v-model="formDefaultVal"
          type="text"
          :placeholder="t('custom_fields.default_val_placeholder')"
        />
      </div>

      <div class="form-group">
        <label>{{ t('custom_fields.unit_label') }}</label>
        <input
          v-model="formUnit"
          type="text"
          :placeholder="t('custom_fields.unit_placeholder')"
        />
      </div>

      <!-- 聚合方式 & 展示格式 -->
      <div class="form-group">
        <label>{{ t('custom_fields.aggregation_mode_label') }}</label>
        <select v-model="formAggregationMode">
          <option v-for="m in AGGREGATION_MODES" :key="m" :value="m">
            {{ t(`custom_fields.agg_${m}`) }}
          </option>
        </select>
      </div>

      <div class="form-group">
        <label>{{ t('custom_fields.display_format_label') }}</label>
        <select v-model="formDisplayFormat">
          <option v-for="fmt in DISPLAY_FORMATS" :key="fmt" :value="fmt">
            {{ t(`custom_fields.fmt_${fmt}`) }}
          </option>
        </select>
      </div>

      <!-- TIER 阈值配置 -->
      <template v-if="formDisplayFormat === 'tier'">
        <div class="form-group">
          <label>{{ t('custom_fields.tier_high_label') }}</label>
          <input v-model.number="cfgTierHigh" type="number" step="0.1" />
        </div>
        <div class="form-group">
          <label>{{ t('custom_fields.tier_mid_label') }}</label>
          <input v-model.number="cfgTierMid" type="number" step="0.1" />
        </div>
        <div class="form-group">
          <label>{{ t('custom_fields.tier_direction_label') }}</label>
          <select v-model="cfgTierDirection">
            <option value="higher_better">{{ t('custom_fields.tier_higher_better') }}</option>
            <option value="lower_better">{{ t('custom_fields.tier_lower_better') }}</option>
          </select>
        </div>
      </template>

      <!-- NUMBER 专属配置 -->
      <template v-if="formType === 'number'">
        <div class="form-group">
          <label>{{ t('custom_fields.input_mode_label') }}</label>
          <select v-model="cfgInputMode">
            <option value="stepper">{{ t('custom_fields.input_mode_stepper') }}</option>
            <option value="slider">{{ t('custom_fields.input_mode_slider') }}</option>
            <option value="counter">{{ t('custom_fields.input_mode_counter') }}</option>
            <option value="direct">{{ t('custom_fields.input_mode_direct') }}</option>
          </select>
        </div>
        <div v-if="cfgInputMode === 'stepper'" class="form-group">
          <label>{{ t('custom_fields.quick_steps_label') }}</label>
          <input v-model="cfgQuickStepsStr" type="text" placeholder="5, 10" />
        </div>
        <div v-if="cfgInputMode === 'slider'" class="form-group">
          <label class="checkbox-label">
            <input v-model="cfgShowTicks" type="checkbox" />
            <span>{{ t('custom_fields.show_ticks_label') }}</span>
          </label>
        </div>
        <div class="form-group">
          <label>{{ t('custom_fields.min_val') }}</label>
          <input v-model.number="formMin" type="number" :placeholder="t('custom_fields.min_placeholder')" />
        </div>
        <div class="form-group">
          <label>{{ t('custom_fields.max_val') }}</label>
          <input v-model.number="formMax" type="number" :placeholder="t('custom_fields.max_placeholder')" />
        </div>
        <div class="form-group">
          <label>{{ t('custom_fields.step_val') }}</label>
          <input v-model.number="formStep" type="number" :placeholder="t('custom_fields.step_placeholder')" />
        </div>
      </template>

      <!-- BOOLEAN 专属配置 -->
      <template v-if="formType === 'boolean'">
        <div class="form-group full-width">
          <label class="checkbox-label">
            <input v-model="cfgTristate" type="checkbox" />
            <span>{{ t('custom_fields.tristate_label') }}</span>
          </label>
        </div>
        <div class="form-group">
          <label>{{ t('custom_fields.true_label') }}</label>
          <input v-model="cfgTrueLabel" type="text" />
        </div>
        <div class="form-group">
          <label>{{ t('custom_fields.false_label') }}</label>
          <input v-model="cfgFalseLabel" type="text" />
        </div>
      </template>

      <!-- LEVEL 专属配置 -->
      <template v-if="formType === 'level'">
        <div class="form-group">
          <label>{{ t('custom_fields.level_count_label') }}</label>
          <select v-model.number="formLevelCount">
            <option :value="3">{{ t('custom_fields.level_3_desc') }}</option>
            <option :value="5">{{ t('custom_fields.level_5_desc') }}</option>
            <option :value="7">{{ t('custom_fields.level_7_desc') }}</option>
            <option :value="10">10</option>
          </select>
        </div>
        <div class="form-group">
          <label>{{ t('custom_fields.level_style_label') }}</label>
          <select v-model="cfgLevelStyle">
            <option value="blocks">{{ t('custom_fields.level_style_blocks') }}</option>
            <option value="stars">{{ t('custom_fields.level_style_stars') }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>{{ t('custom_fields.level_low_label') }}</label>
          <input v-model="cfgLevelLowLabel" type="text" />
        </div>
        <div class="form-group">
          <label>{{ t('custom_fields.level_high_label') }}</label>
          <input v-model="cfgLevelHighLabel" type="text" />
        </div>
      </template>

      <!-- SELECT / MULTI_SELECT 专属配置 -->
      <template v-if="formType === 'select' || formType === 'multi_select'">
        <div v-if="formType === 'select'" class="form-group">
          <label>{{ t('custom_fields.select_style_label') }}</label>
          <select v-model="cfgSelectStyle">
            <option value="chips">{{ t('custom_fields.select_style_chips') }}</option>
            <option value="dropdown">{{ t('custom_fields.select_style_dropdown') }}</option>
          </select>
        </div>

        <div class="form-group full-width">
          <label>{{ t('custom_fields.options_section_title') }}</label>

          <div class="option-add-row">
            <input
              v-model="newOptionLabel"
              type="text"
              :placeholder="t('custom_fields.option_input_placeholder')"
              @keyup.enter="addOption"
            />
            <input
              v-model.number="newOptionNumeric"
              type="number"
              step="0.5"
              class="option-numeric-input"
              :placeholder="t('custom_fields.option_numeric_placeholder')"
            />
            <div class="color-picker-chips">
              <span
                v-for="c in COLOR_PRESETS"
                :key="c"
                class="color-dot"
                :class="[`dot-${c}`, { 'is-selected': newOptionColor === c }]"
                @click="newOptionColor = c"
              />
            </div>
            <button type="button" class="btn-add-opt" @click="addOption">
              <span class="material-icons">add</span>
              {{ t('custom_fields.btn_add_opt') }}
            </button>
          </div>

          <div v-if="formOptions.length > 0" class="options-preview-list">
            <div
              v-for="(opt, oIdx) in formOptions"
              :key="opt.value"
              class="opt-preview-chip"
              :class="`chip-${opt.color || 'blue'}`"
            >
              <span class="opt-label">{{ opt.label }}</span>
              <input
                v-model.number="opt.numericValue"
                type="number"
                step="0.5"
                class="opt-inline-numeric"
                :placeholder="t('custom_fields.option_numeric_short')"
              />
              <button type="button" class="btn-opt-del" @click="removeOption(oIdx)">
                <span class="material-icons">close</span>
              </button>
            </div>
          </div>
        </div>
      </template>

      <!-- TEXT 专属配置 -->
      <template v-if="formType === 'text'">
        <div class="form-group">
          <label class="checkbox-label">
            <input v-model="cfgMultiline" type="checkbox" />
            <span>{{ t('custom_fields.multiline_label') }}</span>
          </label>
        </div>
        <div class="form-group">
          <label>{{ t('custom_fields.max_length_label') }}</label>
          <input v-model.number="cfgMaxLength" type="number" min="1" />
        </div>
        <div class="form-group full-width">
          <label>{{ t('custom_fields.placeholder_label') }}</label>
          <input v-model="cfgPlaceholder" type="text" />
        </div>
      </template>

      <!-- 必填设置 -->
      <div v-if="formType !== 'formula' && !isTeamTarget" class="form-group full-width">
        <label class="checkbox-label">
          <input v-model="formRequired" type="checkbox" />
          <span>{{ t('custom_fields.required_hint') }}</span>
        </label>
      </div>
    </div>

    <!-- 保存与取消 -->
    <div class="builder-actions">
      <button class="btn-cancel" :disabled="isSaving" @click="emit('cancel')">
        {{ t('common.cancel') }}
      </button>
      <button class="btn-save" :disabled="isSaving" @click="submitForm">
        {{ isSaving ? t('common.saving') : (editingId ? t('custom_fields.btn_save_edit') : t('custom_fields.btn_save_create')) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.field-builder-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.builder-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 10px;
}

.builder-header h4 {
  margin: 0;
  font-size: 15px;
  color: var(--foreground);
}

.btn-back {
  background: transparent;
  border: none;
  color: var(--primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group.full-width {
  grid-column: 1 / -1;
}

.form-group label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
}

.form-group label .required {
  color: var(--destructive);
}

.form-group input {
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--foreground);
  font-size: 13px;
  outline: none;
}

.form-group select {
  background-color: var(--input);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 30px 8px 12px;
  color: var(--foreground);
  font-size: 13px;
  outline: none;
  cursor: pointer;
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out),
              box-shadow var(--motion-duration-fast) var(--motion-ease-out);
}

.form-group input:focus {
  border-color: var(--primary);
  box-shadow: var(--focus-ring-sm);
}

.form-group select:focus {
  border-color: var(--primary);
  box-shadow: var(--focus-ring-sm);
}

.form-group select option {
  background-color: var(--g-800);
  color: var(--foreground);
  padding: 8px 12px;
}

.types-selector-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.type-choice-btn {
  background: color-mix(in srgb, var(--g-50) 2%, transparent);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  cursor: pointer;
  color: var(--muted-foreground);
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
}

.type-choice-btn.is-active {
  background: var(--status-success-bg);
  border-color: var(--primary);
  color: var(--primary);
}

.choice-title {
  font-size: 12px;
  font-weight: 700;
}

.choice-desc {
  font-size: 10px;
  color: var(--muted-foreground);
}

.option-add-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.option-numeric-input {
  width: 90px;
}

.color-picker-chips {
  display: flex;
  gap: 6px;
}

.color-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
}

.color-dot.is-selected {
  border-color: var(--g-50);
}

.dot-blue   { background: var(--status-info); }
.dot-green  { background: var(--status-success); }
.dot-orange { background: var(--status-warning); }
.dot-red    { background: var(--status-error); }
.dot-purple { background: var(--status-ai); }
.dot-gray   { background: var(--g-300); }

.btn-add-opt {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--surface-hover);
  border: 1px solid var(--border);
  color: var(--foreground);
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}

.options-preview-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.opt-preview-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 12px;
  background: var(--surface-hover);
  border: 1px solid var(--border);
  font-size: 12px;
}

.opt-inline-numeric {
  width: 56px;
  padding: 2px 4px !important;
  font-size: 11px !important;
}

.btn-opt-del {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 0;
  display: flex;
}

.checkbox-label {
  display: flex;
  flex-direction: row !important;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--foreground);
}

.builder-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 10px;
}

.btn-cancel {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--foreground);
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
}

.btn-save {
  background: var(--primary);
  color: var(--on-primary);
  border: none;
  padding: 8px 20px;
  border-radius: 8px;
  font-weight: 700;
  cursor: pointer;
}
</style>
