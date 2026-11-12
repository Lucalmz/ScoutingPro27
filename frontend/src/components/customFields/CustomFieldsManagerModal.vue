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
import { hapticLight, hapticSuccess } from '@/utils/haptics'
import CustomFieldBuilderForm from './CustomFieldBuilderForm.vue'

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
const editingField = ref<CustomFieldDefinition | null>(null)

const targetFields = computed(() => {
  return store.getFields(props.eventId, activeTab.value)
})

watch(
  () => props.visible,
  (val) => {
    if (val && props.eventId) {
      store.fetchFields(props.eventId)
      isEditing.value = false
      editingField.value = null
    }
  }
)

function openCreateDrawer() {
  hapticLight()
  editingField.value = null
  isEditing.value = true
}

function openEditDrawer(f: CustomFieldDefinition) {
  hapticLight()
  editingField.value = f
  isEditing.value = true
}

function cancelDrawer() {
  isEditing.value = false
  editingField.value = null
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
        <CustomFieldBuilderForm
          v-else
          :event-id="eventId"
          :active-tab="activeTab"
          :editing-field="editingField"
          :is-saving="isSaving"
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
  background: rgba(8, 8, 7, 0.82);
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
</style>
