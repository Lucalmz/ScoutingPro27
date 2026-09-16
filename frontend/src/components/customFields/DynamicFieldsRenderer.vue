<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CustomFieldDefinition } from '@/types'
import { hapticSelection, hapticMedium, hapticLight } from '@/utils/haptics'

let t = (key: string, values?: any): string => {
  if (key === 'custom_fields.renderer.bool_on') return '已开启 / 是'
  if (key === 'custom_fields.renderer.bool_off') return '未开启 / 否'
  if (key === 'custom_fields.renderer.level_low') return '弱'
  if (key === 'custom_fields.renderer.level_high') return '顶'
  if (key === 'custom_fields.renderer.placeholder' && values?.name) return `请输入${values.name}...`
  return key
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
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, any>): void
}>()

const values = computed({
  get: () => props.modelValue || {},
  set: (val: Record<string, any>) => emit('update:modelValue', val)
})

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

// NUMBER 数值步进交互
function stepNumber(field: CustomFieldDefinition, dir: 1 | -1) {
  const min = field.minVal !== null && field.minVal !== undefined ? field.minVal : -Infinity
  const max = field.maxVal !== null && field.maxVal !== undefined ? field.maxVal : Infinity
  const step = field.stepVal || 1
  const cur = Number(getValue(field.fieldKey, field.defaultVal ? Number(field.defaultVal) : (min !== -Infinity ? min : 0)))
  
  let next = dir > 0 ? cur + step : cur - step
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

// LEVEL 水平评级交互 (1~5档)
function selectLevel(field: CustomFieldDefinition, level: number) {
  hapticSelection()
  const cur = getValue(field.fieldKey)
  if (cur === level && !field.required) {
    setValue(field.fieldKey, 0)
  } else {
    setValue(field.fieldKey, level)
  }
}

// SELECT 单选胶囊交互
function selectOption(field: CustomFieldDefinition, val: string) {
  hapticSelection()
  const cur = getValue(field.fieldKey, field.defaultVal)
  if (cur === val && !field.required) {
    setValue(field.fieldKey, null)
  } else {
    setValue(field.fieldKey, val)
  }
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

      <!-- 1. BOOLEAN 开关卡片 -->
      <div
        v-if="field.fieldType === 'boolean'"
        class="boolean-toggle-card"
        :class="{ 'is-active': !!getValue(field.fieldKey, field.defaultVal === 'true') }"
        @click="toggleBoolean(field)"
      >
        <div class="toggle-indicator">
          <span class="material-icons indicator-icon">
            {{ !!getValue(field.fieldKey, field.defaultVal === 'true') ? 'check_circle' : 'radio_button_unchecked' }}
          </span>
          <span class="indicator-label">
            {{ !!getValue(field.fieldKey, field.defaultVal === 'true') ? t('custom_fields.renderer.bool_on') : t('custom_fields.renderer.bool_off') }}
          </span>
        </div>
      </div>

      <!-- 2. NUMBER 计数 / 数值步进器 -->
      <div v-else-if="field.fieldType === 'number'" class="number-stepper-container">
        <button
          type="button"
          class="stepper-btn btn-dec"
          @click="stepNumber(field, -1)"
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
          @click="stepNumber(field, 1)"
          aria-label="Increase"
        >
          <span class="material-icons">add</span>
        </button>
      </div>

      <!-- 3. LEVEL 水平 / 强度评级 (1~5 档) -->
      <div v-else-if="field.fieldType === 'level'" class="level-rating-container">
        <div class="level-ticks">
          <button
            v-for="lvl in Math.max(3, Math.min(7, Math.round(field.maxVal || 5)))"
            :key="lvl"
            type="button"
            class="level-tick-btn"
            :class="{
              'is-active': getValue(field.fieldKey) === lvl,
              'is-below': getValue(field.fieldKey) >= lvl
            }"
            @click="selectLevel(field, lvl)"
          >
            <span class="tick-num">{{ lvl }}</span>
            <span class="tick-label">
              {{ lvl === 1 ? t('custom_fields.renderer.level_low') : (lvl === Math.round(field.maxVal || 5) ? t('custom_fields.renderer.level_high') : '') }}
            </span>
          </button>
        </div>
      </div>

      <!-- 4. SELECT 单选胶囊 -->
      <div v-else-if="field.fieldType === 'select'" class="select-chips-container">
        <button
          v-for="opt in (field.options || [])"
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
        </button>
      </div>

      <!-- 5. MULTI_SELECT 多选标签 -->
      <div v-else-if="field.fieldType === 'multi_select'" class="multi-select-container">
        <button
          v-for="opt in (field.options || [])"
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
        </button>
      </div>

      <!-- 6. TEXT 文本输入 -->
      <div v-else class="text-input-container">
        <textarea
          class="dynamic-textarea"
          rows="2"
          :placeholder="t('custom_fields.renderer.placeholder', { name: field.name })"
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
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border, #262626);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color var(--motion-duration-fast, 150ms) ease;
}

.dynamic-field-item:focus-within {
  border-color: rgba(57, 255, 20, 0.4);
}

.field-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.field-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground, #f1f5f9);
  display: flex;
  align-items: center;
  gap: 4px;
}

.required-star {
  color: var(--destructive, #ef4444);
  font-size: 14px;
}

.field-unit-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted-foreground, #a3a3a3);
}

/* BOOLEAN */
.boolean-toggle-card {
  padding: 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border, #262626);
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  transition: all 0.2s ease;
}

.boolean-toggle-card:active {
  transform: scale(0.98);
}

.boolean-toggle-card.is-active {
  background: rgba(57, 255, 20, 0.1);
  border-color: var(--primary, #39ff14);
  box-shadow: 0 0 12px rgba(57, 255, 20, 0.15);
}

.toggle-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
}

.indicator-icon {
  font-size: 20px;
  color: var(--muted-foreground, #a3a3a3);
}

.boolean-toggle-card.is-active .indicator-icon {
  color: var(--primary, #39ff14);
}

.indicator-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground, #f1f5f9);
}

/* NUMBER STEPPER */
.number-stepper-container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border, #262626);
  border-radius: 10px;
  overflow: hidden;
  height: 48px;
}

.stepper-btn {
  width: 54px;
  height: 100%;
  background: rgba(255, 255, 255, 0.05);
  border: none;
  color: var(--foreground, #f1f5f9);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 0.15s;
}

.stepper-btn:active {
  background: rgba(57, 255, 20, 0.2);
  color: var(--primary, #39ff14);
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
  color: var(--primary, #39ff14);
  text-align: center;
  outline: none;
  font-family: monospace;
}

.display-unit {
  font-size: 12px;
  color: var(--muted-foreground, #a3a3a3);
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
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border, #262626);
  border-radius: 8px;
  padding: 8px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  color: var(--muted-foreground, #a3a3a3);
  transition: all 0.2s ease;
}

.level-tick-btn:active {
  transform: scale(0.95);
}

.tick-num {
  font-size: 16px;
  font-weight: 700;
  font-family: monospace;
}

.tick-label {
  font-size: 10px;
  min-height: 14px;
}

.level-tick-btn.is-below {
  border-color: rgba(57, 255, 20, 0.3);
  color: var(--foreground, #f1f5f9);
}

.level-tick-btn.is-active {
  background: rgba(57, 255, 20, 0.15);
  border-color: var(--primary, #39ff14);
  color: var(--primary, #39ff14);
  box-shadow: 0 0 10px rgba(57, 255, 20, 0.2);
}

/* SELECT CAPSULES */
.select-chips-container {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.capsule-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border, #262626);
  color: var(--muted-foreground, #a3a3a3);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.capsule-chip:active {
  transform: scale(0.96);
}

.chip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.chip-green { --chip-glow: rgba(57, 255, 20, 0.8); }
.chip-blue  { --chip-glow: rgba(59, 130, 246, 0.8); }
.chip-red   { --chip-glow: rgba(239, 68, 68, 0.8); }
.chip-orange{ --chip-glow: rgba(249, 115, 22, 0.8); }
.chip-purple{ --chip-glow: rgba(168, 85, 247, 0.8); }
.chip-gray  { --chip-glow: rgba(156, 163, 175, 0.8); }

.capsule-chip.is-selected {
  background: rgba(255, 255, 255, 0.1);
  color: var(--foreground, #f1f5f9);
  border-color: var(--chip-glow, var(--primary, #39ff14));
  box-shadow: 0 0 10px var(--chip-glow, rgba(57, 255, 20, 0.3));
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
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border, #262626);
  color: var(--muted-foreground, #a3a3a3);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.tag-flow-badge:active {
  transform: scale(0.96);
}

.tag-icon {
  font-size: 14px;
}

.tag-flow-badge.is-selected {
  background: rgba(57, 255, 20, 0.1);
  border-color: var(--primary, #39ff14);
  color: var(--primary, #39ff14);
}

/* TEXTAREA */
.text-input-container {
  width: 100%;
}

.dynamic-textarea {
  width: 100%;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border, #262626);
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--foreground, #f1f5f9);
  font-size: 13px;
  resize: vertical;
  outline: none;
  box-sizing: border-box;
}

.dynamic-textarea:focus {
  border-color: var(--primary, #39ff14);
}
</style>
