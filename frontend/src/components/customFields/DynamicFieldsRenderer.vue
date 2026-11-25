<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  CustomFieldConfig,
  CustomFieldDefinition,
  CustomFieldOption
} from '@/types'
import {
  buildCustomFieldNamespace,
  evaluateFormula,
  topologicalSortFormulas,
  type FormulaContext,
  type FormulaContextValue
} from '@/utils/formula'
import { hapticSelection, hapticMedium, hapticLight } from '@/utils/haptics'

let t = (key: string, values?: any): string => {
  const fallbackMap: Record<string, string> = {
    'custom_fields.renderer.bool_on': '已开启 / 是',
    'custom_fields.renderer.bool_off': '未开启 / 否',
    'custom_fields.renderer.bool_unset': '未填写',
    'custom_fields.renderer.level_low': '弱',
    'custom_fields.renderer.level_high': '顶',
    'custom_fields.renderer.timer_start': '开始',
    'custom_fields.renderer.timer_pause': '暂停',
    'custom_fields.renderer.timer_lap': '计圈',
    'custom_fields.renderer.timer_reset': '重置',
    'custom_fields.renderer.counter_undo': '撤销',
    'custom_fields.renderer.select_placeholder': '请选择...',
    'custom_fields.renderer.formula_readonly': '实时公式计算',
    'custom_fields.renderer.formula_cycle_error': '公式存在循环依赖',
    'custom_fields.renderer.formula_eval_error': '公式计算异常',
    'custom_fields.renderer.formula_empty': '—'
  }
  if (key === 'custom_fields.renderer.placeholder' && values?.name) {
    return `请输入${values.name}...`
  }
  return fallbackMap[key] ?? key
}

try {
  const i18n = useI18n()
  t = i18n.t
} catch {
  // Fallback for isolated unit tests mounted without i18n plugin
}

const props = defineProps<{
  definitions: CustomFieldDefinition[]
  modelValue?: Record<string, any>
  formulaContext?: FormulaContext | Record<string, any>
  allDefinitions?: CustomFieldDefinition[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, any>): void
}>()

const values = computed({
  get: () => props.modelValue || {},
  set: (val: Record<string, any>) => emit('update:modelValue', val)
})

function getConfig(field: CustomFieldDefinition): CustomFieldConfig {
  if (field.config && typeof field.config === 'object') {
    return field.config
  }
  if (typeof field.configJson === 'string' && field.configJson.trim()) {
    try {
      const parsed = JSON.parse(field.configJson)
      if (parsed && typeof parsed === 'object') return parsed as CustomFieldConfig
    } catch {
      return {}
    }
  }
  return {}
}

function getOptions(field: CustomFieldDefinition): CustomFieldOption[] {
  if (Array.isArray(field.options) && field.options.length > 0) {
    return field.options
  }
  if (typeof field.optionsJson === 'string' && field.optionsJson.trim()) {
    try {
      const parsed = JSON.parse(field.optionsJson)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function parseDefaultValue(field: CustomFieldDefinition): any {
  const raw = field.defaultVal
  if (raw === undefined || raw === null || raw === '') return undefined
  switch (field.fieldType) {
    case 'boolean':
      if (raw === 'true') return true
      if (raw === 'false') return false
      return undefined
    case 'number':
    case 'timer':
    case 'level': {
      const n = Number(raw)
      return Number.isFinite(n) ? n : undefined
    }
    case 'multi_select': {
      if (raw.startsWith('[')) {
        try {
          const parsed = JSON.parse(raw)
          return Array.isArray(parsed) ? parsed : undefined
        } catch {
          return undefined
        }
      }
      return raw.split(',').map((s) => s.trim()).filter(Boolean)
    }
    case 'formula':
      return undefined
    default:
      return raw
  }
}

watch(
  () => props.definitions,
  (defs) => {
    if (!defs || defs.length === 0) return
    const current = props.modelValue || {}
    let changed = false
    const next = { ...current }
    for (const field of defs) {
      if (field.fieldType === 'formula') continue
      if (next[field.fieldKey] === undefined && field.defaultVal !== undefined && field.defaultVal !== null && field.defaultVal !== '') {
        const parsed = parseDefaultValue(field)
        if (parsed !== undefined) {
          next[field.fieldKey] = parsed
          changed = true
        }
      }
    }
    if (changed) {
      emit('update:modelValue', next)
    }
  },
  { immediate: true }
)

function getValue(key: string, defaultVal: any = undefined): any {
  if (values.value[key] !== undefined) {
    return values.value[key]
  }
  return defaultVal
}

function setValue(key: string, val: any) {
  const updated = { ...values.value, [key]: val }
  emit('update:modelValue', updated)
}

// BOOLEAN 开关交互
function toggleBoolean(field: CustomFieldDefinition) {
  hapticSelection()
  const cur = !!getValue(field.fieldKey, field.defaultVal === 'true')
  setValue(field.fieldKey, !cur)
}

function setTristateBoolean(field: CustomFieldDefinition, val: boolean | null) {
  hapticSelection()
  setValue(field.fieldKey, val)
}

// NUMBER 数值步进交互
function stepNumber(field: CustomFieldDefinition, delta: number) {
  const min = field.minVal !== null && field.minVal !== undefined ? field.minVal : -Infinity
  const max = field.maxVal !== null && field.maxVal !== undefined ? field.maxVal : Infinity
  const cur = Number(getValue(field.fieldKey, field.defaultVal ? Number(field.defaultVal) : (min !== -Infinity ? min : 0)))

  let next = cur + delta
  if (next < min) next = min
  if (next > max) next = max

  // 保留合理小数位防浮点误差
  next = Math.round(next * 1000) / 1000

  if (next !== cur) {
    hapticMedium()
    setValue(field.fieldKey, next)
  } else {
    hapticLight()
  }
}

function stepNumberDir(field: CustomFieldDefinition, dir: 1 | -1) {
  const step = field.stepVal || 1
  stepNumber(field, dir * step)
}

function onNumberInput(field: CustomFieldDefinition, event: Event) {
  const target = event.target as HTMLInputElement
  const raw = parseFloat(target.value)
  if (isNaN(raw)) {
    setValue(field.fieldKey, field.minVal ?? 0)
    return
  }
  let clamped = raw
  if (field.minVal !== null && field.minVal !== undefined && clamped < field.minVal) clamped = field.minVal
  if (field.maxVal !== null && field.maxVal !== undefined && clamped > field.maxVal) clamped = field.maxVal
  setValue(field.fieldKey, clamped)
}

function getSliderMid(field: CustomFieldDefinition): number {
  const min = field.minVal ?? 0
  const max = field.maxVal ?? 100
  return Math.round(((min + max) / 2) * 10) / 10
}

// TIMER 秒表交互（基于 Date.now() 墙钟差值，抗移动端后台休眠）
interface TimerState {
  running: boolean
  startedAtMs: number | null
  accumulatedMs: number
  displayMs: number
  laps: number[]
}

const timerStates = reactive<Record<string, TimerState>>({})
let rafId: number | null = null

function ensureTimerState(field: CustomFieldDefinition): TimerState {
  const key = field.fieldKey
  if (!timerStates[key]) {
    const initialSec = Number(getValue(key, field.defaultVal ? Number(field.defaultVal) : 0))
    const initialMs = Number.isFinite(initialSec) && initialSec > 0 ? Math.round(initialSec * 1000) : 0
    timerStates[key] = {
      running: false,
      startedAtMs: null,
      accumulatedMs: initialMs,
      displayMs: initialMs,
      laps: []
    }
  } else if (!timerStates[key].running) {
    const modelSec = getValue(key)
    if (typeof modelSec === 'number' && Number.isFinite(modelSec)) {
      const modelMs = Math.max(0, Math.round(modelSec * 1000))
      if (Math.abs(modelMs - timerStates[key].accumulatedMs) > 20) {
        timerStates[key].accumulatedMs = modelMs
        timerStates[key].displayMs = modelMs
      }
    }
  }
  return timerStates[key]!
}

function tickTimers() {
  const now = Date.now()
  let anyRunning = false
  for (const st of Object.values(timerStates)) {
    if (st.running && st.startedAtMs !== null) {
      st.displayMs = st.accumulatedMs + Math.max(0, now - st.startedAtMs)
      anyRunning = true
    }
  }
  if (anyRunning && typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(tickTimers)
  } else {
    rafId = null
  }
}

function ensureRafLoop() {
  if (rafId === null && typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(tickTimers)
  }
}

function roundTimerSec(ms: number): number {
  return Math.round((ms / 1000) * 100) / 100
}

function formatTimerDisplay(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  if (mins > 0) {
    return `${mins}:${secs.toFixed(1).padStart(4, '0')}`
  }
  return `${secs.toFixed(2)}s`
}

function startTimer(field: CustomFieldDefinition) {
  hapticMedium()
  const st = ensureTimerState(field)
  if (st.running) return
  st.startedAtMs = Date.now()
  st.running = true
  ensureRafLoop()
}

function pauseTimer(field: CustomFieldDefinition) {
  hapticMedium()
  const st = ensureTimerState(field)
  if (!st.running) return
  const now = Date.now()
  const elapsed = st.accumulatedMs + (st.startedAtMs !== null ? Math.max(0, now - st.startedAtMs) : 0)
  st.accumulatedMs = elapsed
  st.displayMs = elapsed
  st.startedAtMs = null
  st.running = false
  setValue(field.fieldKey, roundTimerSec(elapsed))
}

function lapTimer(field: CustomFieldDefinition) {
  hapticSelection()
  const st = ensureTimerState(field)
  const currentMs = st.running && st.startedAtMs !== null
    ? st.accumulatedMs + Math.max(0, Date.now() - st.startedAtMs)
    : st.displayMs
  st.laps.push(roundTimerSec(currentMs))
}

function resetTimer(field: CustomFieldDefinition) {
  hapticLight()
  const st = ensureTimerState(field)
  st.running = false
  st.startedAtMs = null
  st.accumulatedMs = 0
  st.displayMs = 0
  st.laps = []
  setValue(field.fieldKey, 0)
}

function tweakTimer(field: CustomFieldDefinition, deltaSec: number) {
  hapticSelection()
  const st = ensureTimerState(field)
  const deltaMs = Math.round(deltaSec * 1000)
  if (st.running && st.startedAtMs !== null) {
    const now = Date.now()
    const current = st.accumulatedMs + Math.max(0, now - st.startedAtMs)
    const nextTotal = Math.max(0, current + deltaMs)
    st.accumulatedMs = nextTotal
    st.startedAtMs = now
    st.displayMs = nextTotal
  } else {
    const nextMs = Math.max(0, st.accumulatedMs + deltaMs)
    st.accumulatedMs = nextMs
    st.displayMs = nextMs
    setValue(field.fieldKey, roundTimerSec(nextMs))
  }
}

// CRITICAL: Flush running stopwatch elapsed seconds into modelValue BEFORE cancelling RAF
onBeforeUnmount(() => {
  const now = Date.now()
  let flushed = false
  const updated = { ...values.value }
  for (const [key, st] of Object.entries(timerStates)) {
    if (st.running && st.startedAtMs !== null) {
      const elapsed = st.accumulatedMs + Math.max(0, now - st.startedAtMs)
      st.accumulatedMs = elapsed
      st.displayMs = elapsed
      st.startedAtMs = null
      st.running = false
      updated[key] = roundTimerSec(elapsed)
      flushed = true
    }
  }
  if (flushed) {
    emit('update:modelValue', updated)
  }
  if (rafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(rafId)
    rafId = null
  }
})

// LEVEL 水平评级交互 (3/5/7/10档)
function getLevelCount(field: CustomFieldDefinition): number {
  const raw = Math.round(field.maxVal || 5)
  return Math.max(3, Math.min(10, raw))
}

function selectLevel(field: CustomFieldDefinition, level: number) {
  hapticSelection()
  const cur = getValue(field.fieldKey)
  if (cur === level && !field.required) {
    setValue(field.fieldKey, 0)
  } else {
    setValue(field.fieldKey, level)
  }
}

// SELECT 单选交互
function selectOption(field: CustomFieldDefinition, val: string) {
  hapticSelection()
  const cur = getValue(field.fieldKey, field.defaultVal)
  if (cur === val && !field.required) {
    setValue(field.fieldKey, null)
  } else {
    setValue(field.fieldKey, val)
  }
}

function onSelectDropdownChange(field: CustomFieldDefinition, event: Event) {
  const target = event.target as HTMLSelectElement
  hapticSelection()
  setValue(field.fieldKey, target.value || null)
}

// MULTI_SELECT 多选标签交互
function toggleMultiOption(field: CustomFieldDefinition, val: string) {
  hapticSelection()
  const curList: string[] = Array.isArray(getValue(field.fieldKey)) ? [...getValue(field.fieldKey)] : []
  const idx = curList.indexOf(val)
  if (idx !== -1) {
    curList.splice(idx, 1)
  } else {
    curList.push(val)
  }
  setValue(field.fieldKey, curList)
}

function isMultiSelected(field: CustomFieldDefinition, val: string): boolean {
  const curList = getValue(field.fieldKey)
  return Array.isArray(curList) && curList.includes(val)
}

function onTextInput(field: CustomFieldDefinition, event: Event) {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement
  setValue(field.fieldKey, target.value)
}

// FORMULA 实时只读预览求值
interface FormulaDisplayResult {
  display: string
  errorMsg?: string
  isCycle?: boolean
  tierClass?: string
}

const evaluatedFormulas = computed<Record<string, FormulaDisplayResult>>(() => {
  if (!props.definitions.some((d) => d.fieldType === 'formula')) return {}
  const allDefs = props.allDefinitions && props.allDefinitions.length > 0
    ? props.allDefinitions
    : props.definitions
  const formulaFields = allDefs.filter((d) => d.fieldType === 'formula' && d.fieldKey)
  if (formulaFields.length === 0) return {}

  const { sorted, cyclicKeys } = topologicalSortFormulas(allDefs)
  const cyclicSet = new Set(cyclicKeys)
  const baseCtx: FormulaContext = props.formulaContext
    ? { ...(props.formulaContext as FormulaContext) }
    : {}

  const targetHint = props.definitions[0]?.target
  const localCf = buildCustomFieldNamespace(values.value, allDefs, targetHint)
  const mergedCf = { ...(baseCtx.cf ?? {}), ...localCf }
  const formulaCache: Record<string, FormulaContextValue> = { ...(baseCtx.formula ?? {}) }
  const results: Record<string, FormulaDisplayResult> = {}

  for (const key of cyclicKeys) {
    results[key] = {
      display: t('custom_fields.renderer.formula_empty'),
      errorMsg: t('custom_fields.renderer.formula_cycle_error'),
      isCycle: true
    }
  }

  for (const field of sorted) {
    const expr = field.formulaExpr?.trim() ?? ''
    if (!expr) {
      results[field.fieldKey] = {
        display: t('custom_fields.renderer.formula_empty'),
        errorMsg: t('custom_fields.renderer.formula_eval_error')
      }
      continue
    }

    const ctx: FormulaContext = {
      ...baseCtx,
      cf: mergedCf,
      pit_cf: targetHint === 'PIT' ? { ...(baseCtx.pit_cf ?? {}), ...localCf } : baseCtx.pit_cf,
      formula: formulaCache
    }

    const res = evaluateFormula(expr, ctx, {
      target: field.target,
      fieldKey: field.fieldKey
    })

    if (res.error || res.reason === 'CIRCULAR_DEPENDENCY_RUNTIME') {
      const isCycle = res.reason === 'CIRCULAR_DEPENDENCY_RUNTIME' || res.errorCode === 'CIRCULAR_DEPENDENCY'
      results[field.fieldKey] = {
        display: t('custom_fields.renderer.formula_empty'),
        errorMsg: isCycle ? t('custom_fields.renderer.formula_cycle_error') : (res.error || t('custom_fields.renderer.formula_eval_error')),
        isCycle
      }
      formulaCache[field.fieldKey] = null
      continue
    }

    formulaCache[field.fieldKey] = res.value
    results[field.fieldKey] = formatFormulaValue(res.value, field)
  }

  for (const f of formulaFields) {
    if (!results[f.fieldKey] && cyclicSet.has(f.fieldKey)) {
      results[f.fieldKey] = {
        display: t('custom_fields.renderer.formula_empty'),
        errorMsg: t('custom_fields.renderer.formula_cycle_error'),
        isCycle: true
      }
    }
  }

  return results
})

function formatFormulaValue(val: number | null, field: CustomFieldDefinition): FormulaDisplayResult {
  if (val === null || !Number.isFinite(val)) {
    return { display: t('custom_fields.renderer.formula_empty') }
  }
  const cfg = getConfig(field)
  const fmt = field.displayFormat || 'number'
  const dp = typeof cfg.decimalPlaces === 'number' ? Math.max(0, Math.min(4, cfg.decimalPlaces)) : 2

  switch (fmt) {
    case 'boolean':
      return { display: val !== 0 ? t('custom_fields.renderer.bool_on') : t('custom_fields.renderer.bool_off') }
    case 'integer':
      return { display: String(Math.round(val)) }
    case 'percent':
      return { display: `${val.toFixed(Math.min(dp, 1))}%` }
    case 'tier': {
      const th = cfg.tierThresholds
      let tierClass = 'tier-mid'
      if (th && typeof th.high === 'number' && typeof th.mid === 'number') {
        const lowerBetter = th.direction === 'lower_better'
        if (lowerBetter ? val <= th.high : val >= th.high) tierClass = 'tier-high'
        else if (lowerBetter ? val >= th.mid : val <= th.mid) tierClass = 'tier-low'
      }
      return { display: val.toFixed(dp), tierClass }
    }
    case 'number':
    default:
      return { display: Number.isInteger(val) ? String(val) : val.toFixed(dp) }
  }
}
</script>

<template>
  <div v-if="definitions && definitions.length > 0" class="dynamic-custom-fields">
    <div
      v-for="field in definitions"
      :key="field.id || field.fieldKey"
      class="dynamic-field-item"
      :class="`type-${field.fieldType}`"
    >
      <!-- 字段头部标题与单位标签 -->
      <div class="field-meta">
        <span class="field-title">
          {{ field.name }}
          <span v-if="field.required" class="required-star">*</span>
        </span>
        <span v-if="field.unit" class="field-unit-badge">{{ field.unit }}</span>
      </div>
      <p v-if="field.description" class="field-description">{{ field.description }}</p>

      <!-- 1. BOOLEAN 开关卡片 / 三态开关 -->
      <template v-if="field.fieldType === 'boolean'">
        <div v-if="getConfig(field).tristate" class="boolean-tristate-group">
          <button
            type="button"
            class="tristate-btn"
            :class="{ 'is-active': getValue(field.fieldKey) === true }"
            @click="setTristateBoolean(field, true)"
          >
            {{ getConfig(field).trueLabel || t('custom_fields.renderer.bool_on') }}
          </button>
          <button
            type="button"
            class="tristate-btn"
            :class="{ 'is-active-unset': getValue(field.fieldKey) === null || getValue(field.fieldKey) === undefined }"
            @click="setTristateBoolean(field, null)"
          >
            {{ t('custom_fields.renderer.bool_unset') }}
          </button>
          <button
            type="button"
            class="tristate-btn"
            :class="{ 'is-active-false': getValue(field.fieldKey) === false }"
            @click="setTristateBoolean(field, false)"
          >
            {{ getConfig(field).falseLabel || t('custom_fields.renderer.bool_off') }}
          </button>
        </div>
        <div
          v-else
          class="boolean-toggle-card"
          :class="{ 'is-active': !!getValue(field.fieldKey, field.defaultVal === 'true') }"
          @click="toggleBoolean(field)"
        >
          <div class="toggle-indicator">
            <span class="material-icons indicator-icon">
              {{ !!getValue(field.fieldKey, field.defaultVal === 'true') ? 'check_circle' : 'radio_button_unchecked' }}
            </span>
            <span class="indicator-label">
              {{
                !!getValue(field.fieldKey, field.defaultVal === 'true')
                  ? (getConfig(field).trueLabel || t('custom_fields.renderer.bool_on'))
                  : (getConfig(field).falseLabel || t('custom_fields.renderer.bool_off'))
              }}
            </span>
          </div>
        </div>
      </template>

      <!-- 2. NUMBER 计数 / 数值步进器 / 滑块 / 大按钮计数器 / 直接输入 -->
      <template v-else-if="field.fieldType === 'number'">
        <!-- Slider mode -->
        <div v-if="getConfig(field).inputMode === 'slider'" class="number-slider-container">
          <div class="slider-row">
            <input
              type="range"
              class="number-slider-input"
              :value="getValue(field.fieldKey, field.defaultVal ? Number(field.defaultVal) : (field.minVal ?? 0))"
              :min="field.minVal ?? 0"
              :max="field.maxVal ?? 100"
              :step="field.stepVal ?? 1"
              @input="onNumberInput(field, $event)"
            />
            <span class="slider-value-badge">
              {{ getValue(field.fieldKey, field.defaultVal ? Number(field.defaultVal) : (field.minVal ?? 0)) }}
              <template v-if="field.unit">{{ field.unit }}</template>
            </span>
          </div>
          <div v-if="getConfig(field).showTicks" class="slider-ticks">
            <span>{{ field.minVal ?? 0 }}</span>
            <span>{{ getSliderMid(field) }}</span>
            <span>{{ field.maxVal ?? 100 }}</span>
          </div>
        </div>

        <!-- Counter mode -->
        <div v-else-if="getConfig(field).inputMode === 'counter'" class="number-counter-container">
          <button
            type="button"
            class="counter-plus-btn"
            @click="stepNumberDir(field, 1)"
          >
            <span class="material-icons">add</span>
            <span>+{{ field.stepVal || 1 }}</span>
          </button>
          <div class="counter-value-box">
            <span class="counter-value-num">
              {{ getValue(field.fieldKey, field.defaultVal ? Number(field.defaultVal) : (field.minVal ?? 0)) }}
            </span>
            <span v-if="field.unit" class="display-unit">{{ field.unit }}</span>
          </div>
          <button
            type="button"
            class="counter-undo-btn"
            @click="stepNumberDir(field, -1)"
          >
            <span class="material-icons">undo</span>
            <span>{{ t('custom_fields.renderer.counter_undo') }}</span>
          </button>
        </div>

        <!-- Direct input mode -->
        <div v-else-if="getConfig(field).inputMode === 'direct'" class="number-direct-container">
          <input
            type="number"
            class="direct-number-input"
            :value="getValue(field.fieldKey, field.defaultVal ? Number(field.defaultVal) : (field.minVal ?? 0))"
            :min="field.minVal ?? undefined"
            :max="field.maxVal ?? undefined"
            :step="field.stepVal ?? 1"
            @change="onNumberInput(field, $event)"
          />
          <span v-if="field.unit" class="display-unit">{{ field.unit }}</span>
        </div>

        <!-- Default Stepper mode (with optional quickSteps) -->
        <div v-else class="number-stepper-wrapper">
          <div class="number-stepper-container">
            <button
              type="button"
              class="stepper-btn btn-dec"
              @click="stepNumberDir(field, -1)"
              aria-label="Decrease"
            >
              <span class="material-icons">remove</span>
            </button>
            <div class="stepper-display">
              <input
                type="number"
                class="stepper-input"
                :value="getValue(field.fieldKey, field.defaultVal ? Number(field.defaultVal) : (field.minVal ?? 0))"
                :min="field.minVal ?? undefined"
                :max="field.maxVal ?? undefined"
                :step="field.stepVal ?? 1"
                @change="onNumberInput(field, $event)"
              />
              <span v-if="field.unit" class="display-unit">{{ field.unit }}</span>
            </div>
            <button
              type="button"
              class="stepper-btn btn-inc"
              @click="stepNumberDir(field, 1)"
              aria-label="Increase"
            >
              <span class="material-icons">add</span>
            </button>
          </div>
          <div v-if="getConfig(field).quickSteps && getConfig(field).quickSteps!.length > 0" class="quick-steps-row">
            <button
              v-for="qs in getConfig(field).quickSteps"
              :key="`dec-${qs}`"
              type="button"
              class="quick-step-btn is-dec"
              @click="stepNumber(field, -qs)"
            >
              -{{ qs }}
            </button>
            <button
              v-for="qs in getConfig(field).quickSteps"
              :key="`inc-${qs}`"
              type="button"
              class="quick-step-btn is-inc"
              @click="stepNumber(field, qs)"
            >
              +{{ qs }}
            </button>
          </div>
        </div>
      </template>

      <!-- 2b. TIMER 秒表控件 -->
      <div v-else-if="field.fieldType === 'timer'" class="timer-widget-container">
        <div class="timer-display-row">
          <span class="timer-clock-value" :class="{ 'is-running': ensureTimerState(field).running }">
            {{ formatTimerDisplay(ensureTimerState(field).displayMs) }}
          </span>
          <div class="timer-tweak-group">
            <button type="button" class="timer-tweak-btn" @click="tweakTimer(field, -1)">-1s</button>
            <button type="button" class="timer-tweak-btn" @click="tweakTimer(field, 1)">+1s</button>
          </div>
        </div>
        <div class="timer-controls-row">
          <button
            v-if="!ensureTimerState(field).running"
            type="button"
            class="timer-btn timer-btn-start"
            @click="startTimer(field)"
          >
            <span class="material-icons">play_arrow</span>
            {{ t('custom_fields.renderer.timer_start') }}
          </button>
          <button
            v-else
            type="button"
            class="timer-btn timer-btn-pause"
            @click="pauseTimer(field)"
          >
            <span class="material-icons">pause</span>
            {{ t('custom_fields.renderer.timer_pause') }}
          </button>
          <button
            type="button"
            class="timer-btn timer-btn-lap"
            @click="lapTimer(field)"
          >
            <span class="material-icons">flag</span>
            {{ t('custom_fields.renderer.timer_lap') }}
          </button>
          <button
            type="button"
            class="timer-btn timer-btn-reset"
            @click="resetTimer(field)"
          >
            <span class="material-icons">replay</span>
            {{ t('custom_fields.renderer.timer_reset') }}
          </button>
        </div>
        <div v-if="ensureTimerState(field).laps.length > 0" class="timer-laps-row">
          <span v-for="(lap, idx) in ensureTimerState(field).laps" :key="idx" class="timer-lap-chip">
            #{{ idx + 1 }} {{ lap.toFixed(2) }}s
          </span>
        </div>
      </div>

      <!-- 3. LEVEL 水平 / 强度评级 (3/5/7/10 档，支持色块/星级) -->
      <div v-else-if="field.fieldType === 'level'" class="level-rating-container">
        <div
          class="level-ticks"
          :style="{ gridTemplateColumns: `repeat(${getLevelCount(field)}, 1fr)` }"
        >
          <button
            v-for="lvl in getLevelCount(field)"
            :key="lvl"
            type="button"
            class="level-tick-btn"
            :class="{
              'is-active': getValue(field.fieldKey) === lvl,
              'is-below': getValue(field.fieldKey) >= lvl,
              'is-stars': getConfig(field).levelStyle === 'stars'
            }"
            @click="selectLevel(field, lvl)"
          >
            <span v-if="getConfig(field).levelStyle === 'stars'" class="material-icons star-icon">
              {{ getValue(field.fieldKey) >= lvl ? 'star' : 'star_border' }}
            </span>
            <span v-else class="tick-num">{{ lvl }}</span>
            <span class="tick-label">
              {{
                lvl === 1
                  ? (getConfig(field).levelLowLabel || t('custom_fields.renderer.level_low'))
                  : (lvl === getLevelCount(field)
                    ? (getConfig(field).levelHighLabel || t('custom_fields.renderer.level_high'))
                    : '')
              }}
            </span>
          </button>
        </div>
      </div>

      <!-- 4. SELECT 单选胶囊 / 下拉框 -->
      <template v-else-if="field.fieldType === 'select'">
        <div v-if="getConfig(field).selectStyle === 'dropdown'" class="select-dropdown-container">
          <select
            class="dynamic-select-dropdown"
            :value="getValue(field.fieldKey, field.defaultVal) ?? ''"
            @change="onSelectDropdownChange(field, $event)"
          >
            <option value="">{{ t('custom_fields.renderer.select_placeholder') }}</option>
            <option
              v-for="opt in getOptions(field)"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}{{ opt.numericValue !== null && opt.numericValue !== undefined ? ` (${opt.numericValue})` : '' }}
            </option>
          </select>
        </div>
        <div v-else class="select-chips-container">
          <button
            v-for="opt in getOptions(field)"
            :key="opt.value"
            type="button"
            class="capsule-chip"
            :class="[
              `chip-${opt.color || 'blue'}`,
              { 'is-selected': getValue(field.fieldKey, field.defaultVal) === opt.value }
            ]"
            @click="selectOption(field, opt.value)"
          >
            <span class="chip-dot" />
            <span class="chip-text">{{ opt.label }}</span>
            <span
              v-if="opt.numericValue !== null && opt.numericValue !== undefined"
              class="chip-numeric-weight"
            >
              {{ opt.numericValue }}
            </span>
          </button>
        </div>
      </template>

      <!-- 5. MULTI_SELECT 多选标签 -->
      <div v-else-if="field.fieldType === 'multi_select'" class="multi-select-container">
        <button
          v-for="opt in getOptions(field)"
          :key="opt.value"
          type="button"
          class="tag-flow-badge"
          :class="[
            `tag-${opt.color || 'green'}`,
            { 'is-selected': isMultiSelected(field, opt.value) }
          ]"
          @click="toggleMultiOption(field, opt.value)"
        >
          <span class="material-icons tag-icon">
            {{ isMultiSelected(field, opt.value) ? 'check' : 'add' }}
          </span>
          <span>{{ opt.label }}</span>
          <span
            v-if="opt.numericValue !== null && opt.numericValue !== undefined"
            class="chip-numeric-weight"
          >
            {{ opt.numericValue }}
          </span>
        </button>
      </div>

      <!-- 6. FORMULA 实时只读预览卡片 -->
      <div v-else-if="field.fieldType === 'formula'" class="formula-preview-card">
        <div class="formula-preview-left">
          <span class="material-icons formula-fx-icon">functions</span>
          <span class="formula-readonly-hint">{{ t('custom_fields.renderer.formula_readonly') }}</span>
        </div>
        <div class="formula-preview-right">
          <span
            v-if="evaluatedFormulas[field.fieldKey]?.errorMsg"
            class="formula-error-badge"
            :class="{ 'is-cycle': evaluatedFormulas[field.fieldKey]?.isCycle }"
          >
            {{ evaluatedFormulas[field.fieldKey]?.errorMsg }}
          </span>
          <span
            v-else
            class="formula-result-value"
            :class="evaluatedFormulas[field.fieldKey]?.tierClass"
          >
            {{ evaluatedFormulas[field.fieldKey]?.display ?? t('custom_fields.renderer.formula_empty') }}
            <template v-if="field.unit && evaluatedFormulas[field.fieldKey]?.display !== t('custom_fields.renderer.formula_empty')">
              {{ field.unit }}
            </template>
          </span>
        </div>
      </div>

      <!-- 7. TEXT 文本输入（单行/多行） -->
      <div v-else class="text-input-container">
        <input
          v-if="getConfig(field).multiline === false"
          type="text"
          class="dynamic-text-input"
          :placeholder="getConfig(field).placeholder || t('custom_fields.renderer.placeholder', { name: field.name })"
          :maxlength="getConfig(field).maxLength || undefined"
          :value="getValue(field.fieldKey, field.defaultVal || '')"
          @input="onTextInput(field, $event)"
        />
        <textarea
          v-else
          class="dynamic-textarea"
          rows="2"
          :placeholder="getConfig(field).placeholder || t('custom_fields.renderer.placeholder', { name: field.name })"
          :maxlength="getConfig(field).maxLength || undefined"
          :value="getValue(field.fieldKey, field.defaultVal || '')"
          @input="onTextInput(field, $event)"
        ></textarea>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dynamic-custom-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 10px 0;
  width: 100%;
}

.dynamic-field-item {
  background: color-mix(in srgb, var(--g-50) 2%, transparent);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out);
}

.dynamic-field-item:focus-within {
  border-color: color-mix(in srgb, var(--primary) 40%, transparent);
}

.field-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.field-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  display: flex;
  align-items: center;
  gap: 4px;
}

.field-description {
  margin: -2px 0 2px;
  font-size: 11px;
  color: var(--muted-foreground);
  line-height: 1.4;
}

.required-star {
  color: var(--destructive);
  font-size: 14px;
}

.field-unit-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--surface-hover);
  color: var(--muted-foreground);
}

/* BOOLEAN */
.boolean-toggle-card {
  padding: 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--g-50) 3%, transparent);
  border: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              transform var(--motion-duration-fast) var(--motion-ease-out);
}

.boolean-toggle-card:active {
  transform: scale(0.98);
}

.boolean-toggle-card.is-active {
  background: var(--status-success-bg);
  border-color: var(--primary);
}

.toggle-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
}

.indicator-icon {
  font-size: 20px;
  color: var(--muted-foreground);
}

.boolean-toggle-card.is-active .indicator-icon {
  color: var(--primary);
}

.indicator-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
}

.boolean-tristate-group {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.tristate-btn {
  padding: 9px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--g-50) 3%, transparent);
  color: var(--muted-foreground);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.tristate-btn.is-active {
  background: var(--status-success-bg);
  border-color: var(--primary);
  color: var(--primary);
}

.tristate-btn.is-active-unset {
  background: var(--surface-hover);
  border-color: var(--border-strong, var(--border));
  color: var(--foreground);
}

.tristate-btn.is-active-false {
  background: var(--status-error-bg);
  border-color: var(--status-error);
  color: var(--status-error);
}

/* NUMBER STEPPER / SLIDER / COUNTER / DIRECT */
.number-stepper-wrapper {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.number-stepper-container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  height: 48px;
}

.stepper-btn {
  width: 54px;
  height: 100%;
  background: var(--surface-elevated);
  border: none;
  color: var(--foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
}

.stepper-btn:active {
  background: color-mix(in srgb, var(--primary) 20%, transparent);
  color: var(--primary);
}

.stepper-display {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.stepper-input {
  width: 70px;
  background: transparent;
  border: none;
  font-size: 18px;
  font-weight: 700;
  color: var(--primary);
  text-align: center;
  outline: none;
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.display-unit {
  font-size: 12px;
  color: var(--muted-foreground);
}

.quick-steps-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.quick-step-btn {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-elevated);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.quick-step-btn.is-inc {
  color: var(--primary);
}

.quick-step-btn.is-dec {
  color: var(--muted-foreground);
}

.number-slider-container {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.number-slider-input {
  flex: 1;
  accent-color: var(--primary);
}

.slider-value-badge {
  min-width: 48px;
  text-align: center;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  font-weight: 700;
  font-size: 13px;
  color: var(--primary);
  font-family: var(--font-numeric);
}

.slider-ticks {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--muted-foreground);
}

.number-counter-container {
  display: flex;
  align-items: center;
  gap: 10px;
}

.counter-plus-btn {
  flex: 1;
  height: 48px;
  border-radius: 10px;
  border: 1px solid var(--primary);
  background: var(--status-success-bg);
  color: var(--primary);
  font-size: 16px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
}

.counter-value-box {
  min-width: 72px;
  height: 48px;
  padding: 0 12px;
  border-radius: 10px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.counter-value-num {
  font-size: 20px;
  font-weight: 800;
  color: var(--foreground);
  font-family: var(--font-numeric);
}

.counter-undo-btn {
  height: 48px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface-elevated);
  color: var(--muted-foreground);
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.number-direct-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.direct-number-input {
  flex: 1;
  height: 40px;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0 10px;
  color: var(--foreground);
  font-size: 15px;
  font-weight: 600;
  font-family: var(--font-numeric);
}

/* TIMER */
.timer-widget-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 10px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
}

.timer-display-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.timer-clock-value {
  font-size: 22px;
  font-weight: 800;
  color: var(--foreground);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.timer-clock-value.is-running {
  color: var(--primary);
}

.timer-tweak-group {
  display: flex;
  gap: 4px;
}

.timer-tweak-btn {
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-elevated);
  color: var(--muted-foreground);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.timer-controls-row {
  display: flex;
  gap: 6px;
}

.timer-btn {
  flex: 1;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-elevated);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
}

.timer-btn .material-icons {
  font-size: 16px;
}

.timer-btn-start {
  background: var(--status-success-bg);
  border-color: var(--primary);
  color: var(--primary);
}

.timer-btn-pause {
  background: var(--status-warning-bg);
  border-color: var(--status-warning);
  color: var(--status-warning);
}

.timer-laps-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.timer-lap-chip {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--surface-hover);
  color: var(--muted-foreground);
  font-family: var(--font-numeric);
}

/* LEVEL RATING */
.level-rating-container {
  width: 100%;
}

.level-ticks {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
}

.level-tick-btn {
  background: color-mix(in srgb, var(--g-50) 3%, transparent);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  color: var(--muted-foreground);
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out),
              transform var(--motion-duration-fast) var(--motion-ease-out);
}

.level-tick-btn:active {
  transform: scale(0.95);
}

.tick-num {
  font-size: 16px;
  font-weight: 700;
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.star-icon {
  font-size: 20px;
}

.tick-label {
  font-size: 10px;
  min-height: 14px;
}

.level-tick-btn.is-below {
  border-color: var(--status-success-border);
  color: var(--foreground);
}

.level-tick-btn.is-below.is-stars .star-icon {
  color: var(--status-warning);
}

.level-tick-btn.is-active {
  background: var(--status-success-bg);
  border-color: var(--primary);
  color: var(--primary);
}

/* SELECT CAPSULES & DROPDOWN */
.select-chips-container {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.dynamic-select-dropdown {
  width: 100%;
  height: 40px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--input);
  color: var(--foreground);
  padding: 0 10px;
  font-size: 13px;
}

.capsule-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 20px;
  background: color-mix(in srgb, var(--g-50) 4%, transparent);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out),
              transform var(--motion-duration-fast) var(--motion-ease-out);
}

.capsule-chip:active {
  transform: scale(0.96);
}

.chip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--chip-accent, currentColor);
}

.chip-numeric-weight {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--surface-recessed);
  color: var(--muted-foreground);
  font-family: var(--font-numeric);
}

.chip-green { --chip-accent: var(--status-success); --chip-bg: var(--status-success-bg); --chip-border: var(--status-success-border); }
.chip-blue  { --chip-accent: var(--status-info);    --chip-bg: var(--status-info-bg);    --chip-border: var(--status-info-border); }
.chip-red   { --chip-accent: var(--status-error);   --chip-bg: var(--status-error-bg);   --chip-border: var(--status-error-border); }
.chip-orange{ --chip-accent: var(--status-warning); --chip-bg: var(--status-warning-bg); --chip-border: var(--status-warning-border); }
.chip-purple{ --chip-accent: var(--status-ai);      --chip-bg: var(--status-ai-bg);      --chip-border: var(--status-ai-border); }
.chip-gray  { --chip-accent: var(--g-300);          --chip-bg: var(--g-800);             --chip-border: var(--g-600); }

.capsule-chip.is-selected {
  background: var(--chip-bg, var(--surface-hover));
  color: var(--chip-accent, var(--foreground));
  border-color: var(--chip-accent, var(--primary));
}

/* MULTI SELECT */
.multi-select-container {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag-flow-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--g-50) 3%, transparent);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  font-size: 13px;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out),
              transform var(--motion-duration-fast) var(--motion-ease-out);
}

.tag-flow-badge:active {
  transform: scale(0.96);
}

.tag-icon {
  font-size: 14px;
}

.tag-flow-badge.is-selected {
  background: var(--status-success-bg);
  border-color: var(--primary);
  color: var(--primary);
}

/* FORMULA PREVIEW */
.formula-preview-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--surface-recessed);
  border: 1px dashed var(--border);
}

.formula-preview-left {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted-foreground);
  font-size: 12px;
}

.formula-fx-icon {
  font-size: 18px;
  color: var(--primary);
}

.formula-result-value {
  font-size: 16px;
  font-weight: 800;
  color: var(--primary);
  font-family: var(--font-numeric);
}

.formula-result-value.tier-high {
  color: var(--status-success);
}

.formula-result-value.tier-mid {
  color: var(--status-warning);
}

.formula-result-value.tier-low {
  color: var(--status-error);
}

.formula-error-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--status-error-bg);
  color: var(--status-error);
}

/* TEXTAREA / INPUT */
.text-input-container {
  width: 100%;
}

.dynamic-text-input,
.dynamic-textarea {
  width: 100%;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--foreground);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}

.dynamic-textarea {
  resize: vertical;
}

.dynamic-text-input:focus,
.dynamic-textarea:focus {
  border-color: var(--primary);
  box-shadow: var(--focus-ring-sm);
}
</style>
