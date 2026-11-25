<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  CustomFieldDefinition,
  CustomFieldTarget
} from '@/types'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useToastStore } from '@/stores/toast'
import { useConfirm } from '@/composables/useConfirm'
import { FORMULA_TEMPLATES, findDependentFormulas, type FormulaFieldTemplate } from '@/utils/formula'
import { hapticLight, hapticSuccess } from '@/utils/haptics'
import CustomFieldBuilderForm from './CustomFieldBuilderForm.vue'

const props = defineProps<{
  visible: boolean
  eventId: string
}>()

const emit = defineEmits<{
  (e: 'update:visible', val: boolean): void
}>()

const { t, te } = useI18n()
const store = useCustomFieldsStore()
const toast = useToastStore()
const { showConfirm } = useConfirm()

const activeTab = ref<CustomFieldTarget>('MATCH')
const isEditing = ref(false)
const isSaving = ref(false)
const showTemplatesDrawer = ref(false)
const editingField = ref<CustomFieldDefinition | null>(null)

const allEventFields = computed(() => {
  return store.getFields(props.eventId)
})

const targetFields = computed(() => {
  return store.getFields(props.eventId, activeTab.value)
})

const existingKeySet = computed(() => {
  return new Set(allEventFields.value.map((f) => `${f.target}:${f.fieldKey}`))
})

watch(
  () => props.visible,
  (val) => {
    if (val && props.eventId) {
      store.fetchFields(props.eventId)
      isEditing.value = false
      showTemplatesDrawer.value = false
      editingField.value = null
    }
  }
)

function openCreateDrawer() {
  hapticLight()
  editingField.value = null
  showTemplatesDrawer.value = false
  isEditing.value = true
}

function openEditDrawer(f: CustomFieldDefinition) {
  hapticLight()
  editingField.value = f
  showTemplatesDrawer.value = false
  isEditing.value = true
}

function cancelDrawer() {
  isEditing.value = false
  editingField.value = null
}

async function importTemplate(tpl: FormulaFieldTemplate) {
  isSaving.value = true
  try {
    const payload: Partial<CustomFieldDefinition> = {
      eventId: props.eventId,
      target: tpl.target,
      phase: tpl.phase,
      name: tpl.name,
      description: tpl.description,
      fieldKey: tpl.fieldKey,
      fieldType: tpl.fieldType,
      formulaExpr: tpl.formulaExpr ?? null,
      aggregationMode: tpl.aggregationMode ?? 'avg',
      displayFormat: tpl.displayFormat ?? 'number',
      unit: tpl.unit ?? null,
      configJson: tpl.config ? JSON.stringify(tpl.config) : null,
      optionsJson: tpl.options ? JSON.stringify(tpl.options) : null,
      isActive: true
    }
    await store.createField(props.eventId, payload)
    activeTab.value = tpl.target
    showTemplatesDrawer.value = false
    toast.showToast(t('custom_fields.toast_template_imported', { name: tpl.name }), 'success')
    hapticSuccess()
  } catch (err: any) {
    toast.showError(err, t('custom_fields.toast_save_failed'))
  } finally {
    isSaving.value = false
  }
}

async function handleSaveField(payload: Partial<CustomFieldDefinition>, editingId: string | null) {
  isSaving.value = true
  try {
    if (editingId) {
      await store.updateField(props.eventId, editingId, payload)
      toast.showToast(t('custom_fields.toast_edit_success'), 'success')
    } else {
      await store.createField(props.eventId, payload)
      toast.showToast(t('custom_fields.toast_create_success'), 'success')
    }
    hapticSuccess()
    isEditing.value = false
    editingField.value = null
  } catch (err: any) {
    toast.showError(err, t('custom_fields.toast_save_failed'))
  } finally {
    isSaving.value = false
  }
}

async function handleDeleteField(f: CustomFieldDefinition) {
  const dependents = findDependentFormulas(f.fieldKey, allEventFields.value)
  const impactedNames = dependents.map((d) => d.name).join(', ')
  const message = dependents.length > 0
    ? (te('custom_fields.delete_impacted_msg')
      ? t('custom_fields.delete_impacted_msg', { name: f.name, formulas: impactedNames })
      : `${t('custom_fields.delete_confirm_msg', { name: f.name })} (${impactedNames})`)
    : t('custom_fields.delete_confirm_msg', { name: f.name })

  const ok = await showConfirm({
    title: t('custom_fields.delete_title'),
    message,
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

async function handleToggleActive(f: CustomFieldDefinition) {
  if (f.isActive) {
    const dependents = findDependentFormulas(f.fieldKey, allEventFields.value)
    if (dependents.length > 0) {
      const impactedNames = dependents.map((d) => d.name).join(', ')
      const ok = await showConfirm({
        title: te('custom_fields.deactivate_title') ? t('custom_fields.deactivate_title') : t('custom_fields.inactive_status'),
        message: te('custom_fields.deactivate_impacted_msg')
          ? t('custom_fields.deactivate_impacted_msg', {
              name: f.name,
              formulas: impactedNames
            })
          : `${f.name} (${impactedNames})`,
        confirmText: t('common.confirm'),
        cancelText: t('common.cancel'),
        type: 'warning'
      })
      if (!ok) return
    }
  }

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
          @click="activeTab = 'MATCH'; isEditing = false; showTemplatesDrawer = false;"
        >
          <span class="material-icons">sports_score</span>
          {{ t('custom_fields.tab_match') }}
        </button>
        <button
          type="button"
          class="cf-tab-btn"
          :class="{ 'is-active': activeTab === 'PIT' }"
          @click="activeTab = 'PIT'; isEditing = false; showTemplatesDrawer = false;"
        >
          <span class="material-icons">engineering</span>
          {{ t('custom_fields.tab_pit') }}
        </button>
        <button
          type="button"
          class="cf-tab-btn"
          :class="{ 'is-active': activeTab === 'TEAM' }"
          @click="activeTab = 'TEAM'; isEditing = false; showTemplatesDrawer = false;"
        >
          <span class="material-icons">functions</span>
          {{ t('custom_fields.tab_team') }}
        </button>
      </div>

      <!-- 字段管理主区域 -->
      <div class="cf-modal-body">
        <!-- 模板导入抽屉 -->
        <div v-if="showTemplatesDrawer" class="templates-drawer">
          <div class="templates-header">
            <h4>{{ t('custom_fields.templates_title') }}</h4>
            <button type="button" class="btn-back" @click="showTemplatesDrawer = false">
              <span class="material-icons">arrow_back</span>
              {{ t('custom_fields.btn_back_list') }}
            </button>
          </div>
          <div class="templates-list">
            <div v-for="tpl in FORMULA_TEMPLATES" :key="tpl.id" class="template-card">
              <div class="template-info">
                <div class="template-title-row">
                  <span class="template-name">{{ tpl.name }}</span>
                  <span class="cf-badge-phase">{{ tpl.target }}</span>
                  <span class="cf-badge-type">{{ tpl.fieldType }}</span>
                </div>
                <p class="template-desc">{{ tpl.description }}</p>
                <code v-if="tpl.formulaExpr" class="template-expr">{{ tpl.formulaExpr }}</code>
              </div>
              <button
                type="button"
                class="btn-import-tpl"
                :disabled="isSaving || existingKeySet.has(`${tpl.target}:${tpl.fieldKey}`)"
                @click="importTemplate(tpl)"
              >
                {{ existingKeySet.has(`${tpl.target}:${tpl.fieldKey}`) ? t('custom_fields.template_added') : t('custom_fields.btn_import_template') }}
              </button>
            </div>
          </div>
        </div>

        <!-- 字段列表视图 -->
        <div v-else-if="!isEditing" class="fields-list-view">
          <div class="list-action-bar">
            <span class="list-summary">
              {{ t('custom_fields.configured_count', { count: targetFields.length }) }}
            </span>
            <div class="action-bar-btns">
              <button type="button" class="btn-templates" @click="showTemplatesDrawer = true">
                <span class="material-icons">auto_awesome</span>
                {{ t('custom_fields.btn_import_templates') }}
              </button>
              <button class="btn-create-field" @click="openCreateDrawer">
                <span class="material-icons">add</span>
                {{ t('custom_fields.btn_create') }}
              </button>
            </div>
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
                  <span v-if="f.aggregationMode" class="cf-badge-agg">{{ f.aggregationMode }}</span>
                  <span v-if="f.displayFormat && f.displayFormat !== 'number'" class="cf-badge-fmt">{{ f.displayFormat }}</span>
                  <span v-if="f.unit" class="cf-badge-unit">{{ f.unit }}</span>
                </div>
                <div class="cf-card-sub">
                  <code>{{ f.fieldKey }}</code>
                  <span v-if="f.fieldType === 'formula' && f.formulaExpr" class="formula-expr-preview">
                    {{ f.formulaExpr }}
                  </span>
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
        <CustomFieldBuilderForm
          v-else
          :event-id="eventId"
          :active-tab="activeTab"
          :editing-field="editingField"
          :is-saving="isSaving"
          :existing-fields="allEventFields"
          @save="handleSaveField"
          @cancel="cancelDrawer"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.cf-modal-backdrop {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--g-950) 82%, transparent);
  z-index: 1050;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.cf-modal-card {
  width: 100%;
  max-width: 780px;
  max-height: 90vh;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow-3);
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
  border-bottom: 1px solid var(--border);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-icon {
  color: var(--primary);
  font-size: 22px;
}

.cf-modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--foreground);
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}

.btn-close:hover {
  color: var(--foreground);
  background: var(--surface-hover);
}

/* Tabs */
.cf-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--surface-recessed);
}

.cf-tab-btn {
  flex: 1;
  height: 46px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--muted-foreground);
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out),
              border-color var(--motion-duration-fast) var(--motion-ease-out),
              color var(--motion-duration-fast) var(--motion-ease-out);
}

.cf-tab-btn.is-active {
  color: var(--primary);
  border-bottom-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 6%, transparent);
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
  gap: 8px;
  flex-wrap: wrap;
}

.action-bar-btns {
  display: flex;
  align-items: center;
  gap: 8px;
}

.list-summary {
  font-size: 13px;
  color: var(--muted-foreground);
}

.btn-templates {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--surface-elevated);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.btn-create-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--primary);
  color: var(--on-primary);
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: opacity var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-create-field:hover {
  opacity: 0.9;
}

.templates-drawer {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.templates-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 10px;
}

.templates-header h4 {
  margin: 0;
  font-size: 15px;
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

.templates-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.template-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface-recessed);
}

.template-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.template-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.template-name {
  font-weight: 700;
  font-size: 13px;
}

.template-desc {
  margin: 0;
  font-size: 12px;
  color: var(--muted-foreground);
}

.template-expr {
  font-size: 11px;
  color: var(--primary);
}

.btn-import-tpl {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--primary);
  background: var(--status-success-bg);
  color: var(--primary);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}

.btn-import-tpl:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cf-empty-state {
  text-align: center;
  padding: 40px 10px;
  color: var(--muted-foreground);
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
  background: color-mix(in srgb, var(--g-50) 2%, transparent);
  border: 1px solid var(--border);
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
  color: var(--foreground);
}

.cf-badge-phase, .cf-badge-type, .cf-badge-unit, .cf-badge-agg, .cf-badge-fmt {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}

.cf-badge-phase {
  background: var(--status-info-bg);
  color: var(--status-info);
}

.cf-badge-type {
  background: var(--status-success-bg);
  color: var(--primary);
}

.cf-badge-agg {
  background: var(--status-ai-bg, var(--surface-hover));
  color: var(--status-ai, var(--primary));
}

.cf-badge-fmt,
.cf-badge-unit {
  background: var(--surface-hover);
  color: var(--muted-foreground);
}

.cf-card-sub {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--muted-foreground);
  flex-wrap: wrap;
}

.cf-card-sub code {
  font-family: var(--font-mono);
}

.formula-expr-preview {
  font-family: monospace;
  color: var(--primary);
}

.required-text {
  color: var(--destructive);
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
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-icon:hover {
  color: var(--foreground);
  background: var(--surface-hover);
}

.del-btn:hover {
  color: var(--destructive);
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
  background-color: var(--g-700);
  transition: background-color var(--motion-duration-moderate) var(--motion-ease-out);
  border-radius: 20px;
}

.slider:before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background-color: var(--g-100);
  transition: transform var(--motion-duration-moderate) var(--motion-ease-out),
              background-color var(--motion-duration-moderate) var(--motion-ease-out);
  border-radius: 50%;
}

input:checked + .slider {
  background-color: var(--primary);
}

input:checked + .slider:before {
  transform: translateX(18px);
  background-color: var(--on-primary);
}
</style>
