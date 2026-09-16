<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  CustomFieldDefinition,
  CustomFieldTarget,
  CustomFieldType,
  CustomFieldPhase,
  CustomFieldOption
} from '@/types'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useToastStore } from '@/stores/toast'
import { useConfirm } from '@/composables/useConfirm'
import { hapticLight, hapticSuccess } from '@/utils/haptics'

const props = defineProps<{
  visible: boolean
  eventId: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', val: boolean): void
}>()

const { t } = useI18n()
const store = useCustomFieldsStore()
const toast = useToastStore()
const { showConfirm } = useConfirm()

const activeTab = ref<CustomFieldTarget>('MATCH')
const isEditing = ref(false)
const isSaving = ref(false)

// 当前正在编辑或新建的字段表单状态
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

const COLOR_PRESETS = ['blue', 'green', 'orange', 'red', 'purple', 'gray']

const targetFields = computed(() => {
  return store.getFields(props.eventId, activeTab.value)
})

watch(
  () => props.visible,
  (val) => {
    if (val && props.eventId) {
      store.fetchFields(props.eventId)
      isEditing.value = false
    }
  }
)

function openCreateDrawer() {
  hapticLight()
  editingId.value = null
  formName.value = ''
  formKey.value = ''
  formPhase.value = activeTab.value === 'MATCH' ? 'teleop' : 'hardware'
  formType.value = 'number'
  formRequired.value = false
  formUnit.value = ''
  formMin.value = 0
  formMax.value = null
  formStep.value = 1
  formLevelCount.value = 5
  formOptions.value = []
  newOptionLabel.value = ''
  newOptionColor.value = 'blue'
  isEditing.value = true
}

function openEditDrawer(f: CustomFieldDefinition) {
  hapticLight()
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
  newOptionLabel.value = ''
  newOptionColor.value = 'blue'
  isEditing.value = true
}

function cancelDrawer() {
  isEditing.value = false
  editingId.value = null
}

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

async function handleSaveField() {
  const name = formName.value.trim()
  if (!name) {
    toast.showToast(t('custom_fields.err_name_required'), 'error')
    return
  }

  // 自动派生 Key
  let key = formKey.value.trim().toLowerCase()
  if (!key) {
    key = 'field_' + Math.random().toString(36).substring(2, 8)
  }

  isSaving.value = true
  try {
    const payload: Partial<CustomFieldDefinition> = {
      eventId: props.eventId,
      target: activeTab.value,
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

    if (editingId.value) {
      await store.updateField(props.eventId, editingId.value, payload)
      toast.showToast(t('custom_fields.toast_edit_success'), 'success')
    } else {
      await store.createField(props.eventId, payload)
      toast.showToast(t('custom_fields.toast_create_success'), 'success')
    }
    hapticSuccess()
    isEditing.value = false
  } catch (err: any) {
    toast.showError(err, t('custom_fields.toast_save_failed'))
  } finally {
    isSaving.value = false
  }
}

async function handleDeleteField(f: CustomFieldDefinition) {
  const ok = await showConfirm({
    title: t('custom_fields.delete_title'),
    message: t('custom_fields.delete_confirm_msg', { name: f.name }),
    confirmText: t('custom_fields.btn_delete_confirm'),
    cancelText: t('common.cancel'),
    type: 'danger'
  })
  if (!ok) return

  try {
    await store.deleteField(props.eventId, f.id)
    toast.showToast(t('custom_fields.toast_deleted', { name: f.name }), 'info')
    hapticLight()
  } catch (e: any) {
    toast.showError(e, t('custom_fields.toast_delete_failed'))
  }
}

function handleToggleActive(f: CustomFieldDefinition) {
  store.toggleFieldActive(props.eventId, f.id).catch((err) => {
    toast.showError(err, t('custom_fields.toast_toggle_failed'))
  })
}

function handleMove(f: CustomFieldDefinition, dir: 'up' | 'down') {
  store.moveFieldOrder(props.eventId, f.id, dir, activeTab.value).catch((err) => {
    toast.showError(err, t('custom_fields.toast_reorder_failed'))
  })
}

function closeModal() {
  emit('update:visible', false)
}
</script>

<template>
  <div v-if="visible" class="cf-modal-backdrop" @click.self="closeModal">
    <div class="cf-modal-card">
      <!-- 头部 -->
      <div class="cf-modal-header">
        <div class="header-left">
          <span class="material-icons header-icon">tune</span>
          <h3>{{ t('custom_fields.builder_title') }}</h3>
        </div>
        <button class="btn-close" @click="closeModal">
          <span class="material-icons">close</span>
        </button>
      </div>

      <!-- Tab 切换 -->
      <div class="cf-tabs">
        <button
          type="button"
          class="cf-tab-btn"
          :class="{ 'is-active': activeTab === 'MATCH' }"
          @click="activeTab = 'MATCH'; isEditing = false;"
        >
          <span class="material-icons">sports_score</span>
          {{ t('custom_fields.tab_match') }}
        </button>
        <button
          type="button"
          class="cf-tab-btn"
          :class="{ 'is-active': activeTab === 'PIT' }"
          @click="activeTab = 'PIT'; isEditing = false;"
        >
          <span class="material-icons">engineering</span>
          {{ t('custom_fields.tab_pit') }}
        </button>
      </div>

      <!-- 字段管理主区域 -->
      <div class="cf-modal-body">
        <!-- 字段列表视图 -->
        <div v-if="!isEditing" class="fields-list-view">
          <div class="list-action-bar">
            <span class="list-summary">
              {{ t('custom_fields.configured_count', { count: targetFields.length }) }}
            </span>
            <button class="btn-create-field" @click="openCreateDrawer">
              <span class="material-icons">add</span>
              {{ t('custom_fields.btn_create') }}
            </button>
          </div>

          <div v-if="targetFields.length === 0" class="cf-empty-state">
            <span class="material-icons empty-icon">layers_clear</span>
            <p>{{ t('custom_fields.empty_state_title') }}</p>
            <span class="empty-hint">{{ t('custom_fields.empty_state_hint') }}</span>
          </div>

          <div v-else class="cf-cards-grid">
            <div
              v-for="(f, idx) in targetFields"
              :key="f.id"
              class="cf-card"
              :class="{ 'is-inactive': !f.isActive }"
            >
              <div class="cf-card-left">
                <div class="cf-card-title-row">
                  <span class="cf-card-title">{{ f.name }}</span>
                  <span class="cf-badge-phase">{{ t(`custom_fields.badge_phase_${f.phase}`) || f.phase }}</span>
                  <span class="cf-badge-type">{{ t(`custom_fields.badge_type_${f.fieldType}`) || f.fieldType }}</span>
                  <span v-if="f.unit" class="cf-badge-unit">{{ f.unit }}</span>
                </div>
                <div class="cf-card-sub">
                  <code>{{ f.fieldKey }}</code>
                  <span v-if="f.required" class="required-text">{{ t('custom_fields.badge_required') }}</span>
                </div>
              </div>

              <div class="cf-card-actions">
                <!-- 排序微调按键 -->
                <div class="order-btns">
                  <button
                    class="btn-icon"
                    :disabled="idx === 0"
                    :title="t('custom_fields.order_up')"
                    @click="handleMove(f, 'up')"
                  >
                    <span class="material-icons">keyboard_arrow_up</span>
                  </button>
                  <button
                    class="btn-icon"
                    :disabled="idx === targetFields.length - 1"
                    :title="t('custom_fields.order_down')"
                    @click="handleMove(f, 'down')"
                  >
                    <span class="material-icons">keyboard_arrow_down</span>
                  </button>
                </div>

                <!-- 激活/停用 Switch -->
                <label class="switch-toggle" :title="f.isActive ? t('custom_fields.active_status') : t('custom_fields.inactive_status')">
                  <input
                    type="checkbox"
                    :checked="f.isActive"
                    @change="handleToggleActive(f)"
                  />
                  <span class="slider" />
                </label>

                <!-- 编辑 -->
                <button class="btn-icon edit-btn" :title="t('common.edit')" @click="openEditDrawer(f)">
                  <span class="material-icons">edit</span>
                </button>

                <!-- 删除 -->
                <button class="btn-icon del-btn" :title="t('common.delete')" @click="handleDeleteField(f)">
                  <span class="material-icons">delete</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 字段构建抽屉 / 表单 -->
        <div v-else class="field-builder-form">
          <div class="builder-header">
            <h4>{{ editingId ? t('custom_fields.modal_edit_title') : t('custom_fields.modal_create_title') }}</h4>
            <button class="btn-back" @click="cancelDrawer">
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
            <button class="btn-cancel" :disabled="isSaving" @click="cancelDrawer">
              {{ t('common.cancel') }}
            </button>
            <button class="btn-save" :disabled="isSaving" @click="handleSaveField">
              {{ isSaving ? t('common.saving') : (editingId ? t('custom_fields.btn_save_edit') : t('custom_fields.btn_save_create')) }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cf-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  z-index: 1050;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.cf-modal-card {
  width: 100%;
  max-width: 760px;
  max-height: 90vh;
  background: var(--card, #0a0a0a);
  border: 1px solid var(--border, #262626);
  border-radius: 16px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.9), 0 0 24px rgba(57, 255, 20, 0.08);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.cf-modal-header {
  height: 56px;
  padding: 0 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border, #262626);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-icon {
  color: var(--primary, #39ff14);
  font-size: 22px;
}

.cf-modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--foreground, #f1f5f9);
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--muted-foreground, #a3a3a3);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}

.btn-close:hover {
  color: var(--foreground, #f1f5f9);
  background: rgba(255, 255, 255, 0.05);
}

/* Tabs */
.cf-tabs {
  display: flex;
  border-bottom: 1px solid var(--border, #262626);
  background: rgba(255, 255, 255, 0.01);
}

.cf-tab-btn {
  flex: 1;
  height: 46px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--muted-foreground, #a3a3a3);
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.cf-tab-btn.is-active {
  color: var(--primary, #39ff14);
  border-bottom-color: var(--primary, #39ff14);
  background: rgba(57, 255, 20, 0.05);
}

.cf-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

/* List view */
.list-action-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.list-summary {
  font-size: 13px;
  color: var(--muted-foreground, #a3a3a3);
}

.btn-create-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--primary, #39ff14);
  color: #000;
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.2s;
}

.btn-create-field:hover {
  opacity: 0.9;
}

.cf-empty-state {
  text-align: center;
  padding: 40px 10px;
  color: var(--muted-foreground, #a3a3a3);
}

.empty-icon {
  font-size: 48px;
  opacity: 0.3;
  margin-bottom: 8px;
}

.empty-hint {
  font-size: 12px;
  opacity: 0.7;
}

/* Cards */
.cf-cards-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cf-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border, #262626);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.cf-card.is-inactive {
  opacity: 0.5;
}

.cf-card-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cf-card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cf-card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--foreground, #f1f5f9);
}

.cf-badge-phase, .cf-badge-type, .cf-badge-unit {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}

.cf-badge-phase {
  background: rgba(59, 130, 246, 0.15);
  color: #60a5fa;
}

.cf-badge-type {
  background: rgba(57, 255, 20, 0.15);
  color: var(--primary, #39ff14);
}

.cf-badge-unit {
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted-foreground, #a3a3a3);
}

.cf-card-sub {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--muted-foreground, #a3a3a3);
}

.cf-card-sub code {
  font-family: monospace;
}

.required-text {
  color: var(--destructive, #ef4444);
}

.cf-card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.order-btns {
  display: flex;
  flex-direction: column;
}

.order-btns .btn-icon {
  padding: 0;
  height: 18px;
  line-height: 18px;
}

.btn-icon {
  background: transparent;
  border: none;
  color: var(--muted-foreground, #a3a3a3);
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-icon:hover {
  color: var(--foreground, #f1f5f9);
  background: rgba(255, 255, 255, 0.06);
}

.del-btn:hover {
  color: var(--destructive, #ef4444);
}

/* Switch Toggle */
.switch-toggle {
  position: relative;
  display: inline-block;
  width: 38px;
  height: 20px;
}

.switch-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background-color: #262626;
  transition: 0.3s;
  border-radius: 20px;
}

.slider:before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .slider {
  background-color: var(--primary, #39ff14);
}

input:checked + .slider:before {
  transform: translateX(18px);
  background-color: #000;
}

/* Builder Form */
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

.form-group input, .form-group select {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border, #262626);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--foreground, #f1f5f9);
  font-size: 13px;
  outline: none;
}

.form-group input:focus, .form-group select:focus {
  border-color: var(--primary, #39ff14);
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
