<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  CustomFieldDefinition,
  CustomFieldTarget,
  CustomFieldType,
  CustomFieldPhase,
  CustomFieldOption
} from '@/types'
import { useToastStore } from '@/stores/toast'
import { hapticLight } from '@/utils/haptics'

const props = defineProps<{
  eventId: string
  activeTab: CustomFieldTarget
  editingField: CustomFieldDefinition | null
  isSaving: boolean
}>()

const emit = defineEmits<{
  (e: 'save', payload: Partial<CustomFieldDefinition>, editingId: string | null): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()
const toast = useToastStore()

const COLOR_PRESETS = ['blue', 'green', 'orange', 'red', 'purple', 'gray']

const editingId = ref<string | null>(null)
const formName = ref('')
const formKey = ref('')
const formPhase = ref<CustomFieldPhase>('overall')
const formType = ref<CustomFieldType>('number')
const formRequired = ref(false)
const formUnit = ref('')
const formMin = ref<number | null>(null)
const formMax = ref<number | null>(null)
const formStep = ref<number | null>(1)
const formLevelCount = ref(5)
const formOptions = ref<CustomFieldOption[]>([])
const newOptionLabel = ref('')
const newOptionColor = ref('blue')

function initForm(f: CustomFieldDefinition | null) {
  if (f) {
    editingId.value = f.id
    formName.value = f.name
    formKey.value = f.fieldKey
    formPhase.value = f.phase
    formType.value = f.fieldType
    formRequired.value = f.required
    formUnit.value = f.unit || ''
    formMin.value = f.minVal ?? null
    formMax.value = f.maxVal ?? null
    formStep.value = f.stepVal ?? 1
    formLevelCount.value = f.maxVal ? Math.round(f.maxVal) : 5
    formOptions.value = f.options ? JSON.parse(JSON.stringify(f.options)) : []
  } else {
    editingId.value = null
    formName.value = ''
    formKey.value = ''
    formPhase.value = props.activeTab === 'MATCH' ? 'teleop' : 'hardware'
    formType.value = 'number'
    formRequired.value = false
    formUnit.value = ''
    formMin.value = 0
    formMax.value = null
    formStep.value = 1
    formLevelCount.value = 5
    formOptions.value = []
  }
  newOptionLabel.value = ''
  newOptionColor.value = 'blue'
}

watch(
  () => props.editingField,
  (f) => {
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
    color: newOptionColor.value
  })
  newOptionLabel.value = ''
  hapticLight()
}

function removeOption(idx: number) {
  formOptions.value.splice(idx, 1)
  hapticLight()
}

function submitForm() {
  const name = formName.value.trim()
  if (!name) {
    toast.showToast(t('custom_fields.err_name_required'), 'error')
    return
  }

  let key = formKey.value.trim().toLowerCase()
  if (!key) {
    key = 'field_' + Math.random().toString(36).substring(2, 8)
  }

  const payload: Partial<CustomFieldDefinition> = {
    eventId: props.eventId,
    target: props.activeTab,
    phase: formPhase.value,
    name,
    fieldKey: key,
    fieldType: formType.value,
    required: formRequired.value,
    unit: formUnit.value.trim() || null,
    minVal: formType.value === 'number' ? formMin.value : null,
    maxVal: formType.value === 'number' ? formMax.value : (formType.value === 'level' ? formLevelCount.value : null),
    stepVal: formType.value === 'number' ? formStep.value : null,
    optionsJson: (formType.value === 'select' || formType.value === 'multi_select') ? JSON.stringify(formOptions.value) : null,
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
          maxlength="50"
        />
      </div>

      <!-- 数据标识 Key -->
      <div class="form-group">
        <label>{{ t('custom_fields.field_key_desc') }}</label>
        <input
          v-model="formKey"
          type="text"
          :placeholder="t('custom_fields.field_key_placeholder')"
        />
      </div>

      <!-- 挂载阶段 -->
      <div class="form-group">
        <label>{{ t('custom_fields.field_phase') }}</label>
        <select v-model="formPhase">
          <template v-if="activeTab === 'MATCH'">
            <option value="auto">{{ t('custom_fields.phase_auto') }}</option>
            <option value="teleop">{{ t('custom_fields.phase_teleop') }}</option>
            <option value="endgame">{{ t('custom_fields.phase_endgame') }}</option>
            <option value="overall">{{ t('custom_fields.phase_overall') }}</option>
          </template>
          <template v-else>
            <option value="hardware">{{ t('custom_fields.phase_hardware') }}</option>
            <option value="strategy">{{ t('custom_fields.phase_strategy') }}</option>
            <option value="overall">{{ t('custom_fields.phase_pit_overall') }}</option>
          </template>
        </select>
      </div>

      <!-- 控件类型选择 -->
      <div class="form-group full-width">
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
        </div>
      </div>

      <!-- NUMBER 专属配置 -->
      <template v-if="formType === 'number'">
        <div class="form-group">
          <label>{{ t('custom_fields.unit_label') }}</label>
          <input
            v-model="formUnit"
            type="text"
            :placeholder="t('custom_fields.unit_placeholder')"
          />
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

      <!-- LEVEL 专属配置 -->
      <template v-if="formType === 'level'">
        <div class="form-group">
          <label>{{ t('custom_fields.level_count_label') }}</label>
          <select v-model.number="formLevelCount">
            <option :value="3">{{ t('custom_fields.level_3_desc') }}</option>
            <option :value="5">{{ t('custom_fields.level_5_desc') }}</option>
            <option :value="7">{{ t('custom_fields.level_7_desc') }}</option>
          </select>
        </div>
      </template>

      <!-- SELECT / MULTI_SELECT 专属配置 -->
      <template v-if="formType === 'select' || formType === 'multi_select'">
        <div class="form-group full-width">
          <label>{{ t('custom_fields.options_section_title') }}</label>
          
          <div class="option-add-row">
            <input
              v-model="newOptionLabel"
              type="text"
              :placeholder="t('custom_fields.option_input_placeholder')"
              @keyup.enter="addOption"
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
              <button type="button" class="btn-opt-del" @click="removeOption(oIdx)">
                <span class="material-icons">close</span>
              </button>
            </div>
          </div>
        </div>
      </template>

      <!-- 必填设置 -->
      <div class="form-group full-width">
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
  border-bottom: 1px solid var(--border, #262626);
  padding-bottom: 10px;
}

.builder-header h4 {
  margin: 0;
  font-size: 15px;
  color: var(--foreground, #f1f5f9);
}

.btn-back {
  background: transparent;
  border: none;
  color: var(--primary, #39ff14);
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
  color: var(--muted-foreground, #a3a3a3);
}

.form-group label .required {
  color: var(--destructive, #ef4444);
}

.form-group input {
  background: var(--input, #090908);
  border: 1px solid var(--border, #262624);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--foreground, #f0efe9);
  font-size: 13px;
  outline: none;
}

.form-group select {
  background: var(--input, #090908);
  border: 1px solid var(--border, #262624);
  border-radius: 8px;
  padding: 8px 30px 8px 12px;
  color: var(--foreground, #f0efe9);
  font-size: 13px;
  outline: none;
  cursor: pointer;
  color-scheme: dark;
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%238e8d87' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  background-size: 13px 13px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.form-group input:focus {
  border-color: var(--primary, #39ff14);
}

.form-group select:focus {
  border-color: var(--primary, #39ff14);
  box-shadow: 0 0 0 1px var(--primary, #39ff14), 0 0 8px rgba(57, 255, 20, 0.2);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2339ff14' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
}

.form-group select option {
  background-color: #141413;
  color: #f0efe9;
  padding: 8px 12px;
}

.types-selector-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.type-choice-btn {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border, #262626);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  cursor: pointer;
  color: var(--muted-foreground, #a3a3a3);
  transition: all 0.2s;
}

.type-choice-btn.is-active {
  background: rgba(57, 255, 20, 0.08);
  border-color: var(--primary, #39ff14);
  color: var(--primary, #39ff14);
}

.choice-title {
  font-size: 12px;
  font-weight: 700;
}

.choice-desc {
  font-size: 10px;
  color: var(--muted-foreground, #a3a3a3);
}

.option-add-row {
  display: flex;
  align-items: center;
  gap: 8px;
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
  border-color: #fff;
}

.dot-blue   { background: #3b82f6; }
.dot-green  { background: #39ff14; }
.dot-orange { background: #f97316; }
.dot-red    { background: #ef4444; }
.dot-purple { background: #a855f7; }
.dot-gray   { background: #9ca3af; }

.btn-add-opt {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--border, #262626);
  color: var(--foreground, #f1f5f9);
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
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--border, #262626);
  font-size: 12px;
}

.btn-opt-del {
  background: transparent;
  border: none;
  color: var(--muted-foreground, #a3a3a3);
  cursor: pointer;
  padding: 0;
  display: flex;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--foreground, #f1f5f9);
}

.builder-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 10px;
}

.btn-cancel {
  background: transparent;
  border: 1px solid var(--border, #262626);
  color: var(--foreground, #f1f5f9);
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
}

.btn-save {
  background: var(--primary, #39ff14);
  color: #000;
  border: none;
  padding: 8px 20px;
  border-radius: 8px;
  font-weight: 700;
  cursor: pointer;
}
</style>
