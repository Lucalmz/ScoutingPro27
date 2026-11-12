<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { CustomFieldDefinition } from '@/types'
import { hapticLight, hapticSelection } from '@/utils/haptics'

defineProps<{
  availableFilterTags: string[]
  selectedTagFilter: string | null
  availableCustomFields: CustomFieldDefinition[]
  visibleCustomFields: CustomFieldDefinition[]
  selectedCustomKeys: string[]
  showCustomColsDropdown: boolean
}>()

const emit = defineEmits<{
  (e: 'update:selectedTagFilter', val: string | null): void
  (e: 'update:showCustomColsDropdown', val: boolean): void
  (e: 'toggleCustomCol', key: string): void
  (e: 'selectAllCustomCols'): void
  (e: 'clearAllCustomCols'): void
}>()

const { t } = useI18n()

function formatTagLabel(tagKey?: string | null): string {
  return tagKey || ''
}
</script>

<template>
  <div class="table-toolbar">
    <!-- 战术标签筛选栏 -->
    <div v-if="availableFilterTags.length > 0" class="tag-filter-bar">
      <span class="filter-title">{{ t('tags.filter_by_tag') }}:</span>
      <button
        class="filter-chip"
        :class="{ active: selectedTagFilter === null }"
        @click="emit('update:selectedTagFilter', null); hapticSelection()"
      >
        {{ t('tags.all') }}
      </button>
      <button
        v-for="tagKey in availableFilterTags"
        :key="tagKey"
        class="filter-chip"
        :class="{ active: selectedTagFilter === tagKey }"
        @click="emit('update:selectedTagFilter', selectedTagFilter === tagKey ? null : tagKey); hapticSelection()"
      >
        {{ formatTagLabel(tagKey) }}
      </button>
    </div>

    <!-- 自定义列下拉选择器 -->
    <div v-if="availableCustomFields.length > 0" class="custom-cols-picker-wrapper">
      <button
        type="button"
        class="btn-custom-cols"
        :class="{ 'has-selected': visibleCustomFields.length > 0 }"
        @click="emit('update:showCustomColsDropdown', !showCustomColsDropdown); hapticLight()"
      >
        <span class="material-icons" style="font-size: 16px;">view_column</span>
        <span>{{ t('custom_fields.rankings_custom_cols_btn') }}</span>
        <span v-if="visibleCustomFields.length > 0" class="badge-col-count">({{ visibleCustomFields.length }})</span>
        <span class="material-icons" style="font-size: 16px;">{{ showCustomColsDropdown ? 'expand_less' : 'expand_more' }}</span>
      </button>

      <div v-if="showCustomColsDropdown" class="cols-dropdown-card">
        <div class="dropdown-header">
          <span class="dropdown-title">{{ t('custom_fields.rankings_custom_cols_title') }}</span>
          <div class="header-links">
            <button type="button" class="btn-link" @click="emit('selectAllCustomCols')">{{ t('custom_fields.select_all') }}</button>
            <span class="sep">/</span>
            <button type="button" class="btn-link" @click="emit('clearAllCustomCols')">{{ t('custom_fields.clear_all') }}</button>
          </div>
        </div>
        <div class="dropdown-options">
          <label
            v-for="f in availableCustomFields"
            :key="f.fieldKey"
            class="col-option-row"
          >
            <input
              type="checkbox"
              :checked="selectedCustomKeys.includes(f.fieldKey)"
              @change="emit('toggleCustomCol', f.fieldKey)"
            />
            <span class="opt-name">{{ f.name }}</span>
            <span class="opt-tag">{{ f.fieldType === 'boolean' ? '%' : (f.unit || t('custom_fields.renderer.numeric_unit')) }}</span>
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── 表格工具栏与自定义列选择器 ── */
.table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.table-toolbar .tag-filter-bar {
  margin-bottom: 0;
  flex: 1;
}

.custom-cols-picker-wrapper {
  position: relative;
  display: inline-block;
}

.btn-custom-cols {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-custom-cols:hover {
  border-color: var(--primary);
  color: var(--foreground);
}

.btn-custom-cols.has-selected {
  border-color: rgba(57, 255, 20, 0.4);
  color: var(--primary, #39ff14);
}

.badge-col-count {
  font-weight: 700;
  color: var(--primary, #39ff14);
}

.cols-dropdown-card {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 100;
  width: 260px;
  background: var(--card, #121212);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dropdown-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.dropdown-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
  text-transform: uppercase;
}

.header-links {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

.header-links .sep {
  color: var(--muted-foreground);
}

.btn-link {
  background: none;
  border: none;
  color: var(--primary, #39ff14);
  padding: 0;
  font-size: 11px;
  cursor: pointer;
}

.btn-link:hover {
  text-decoration: underline;
}

.dropdown-options {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.col-option-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s ease;
}

.col-option-row:hover {
  background: rgba(255, 255, 255, 0.05);
}

.col-option-row input[type="checkbox"] {
  accent-color: var(--primary, #39ff14);
}

.col-option-row .opt-name {
  flex: 1;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-option-row .opt-tag {
  font-size: 10px;
  color: var(--muted-foreground);
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 4px;
  border-radius: 3px;
}

/* ── 战术标签筛选栏 ── */
.tag-filter-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 10px 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 12px;
}

.filter-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--muted-foreground);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-right: 4px;
}

.filter-chip {
  padding: 3px 9px;
  border-radius: 12px;
  font-size: 0.75rem;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  cursor: pointer;
  transition: all 0.15s ease;
}

.filter-chip:hover {
  border-color: var(--primary);
  color: var(--foreground);
}

.filter-chip.active {
  background: var(--primary);
  color: var(--primary-foreground);
  border-color: var(--primary);
  font-weight: 600;
}

@media (max-width: 680px) {
  .tag-filter-bar {
    padding: 8px 10px;
    gap: 4px;
  }
  .filter-chip {
    padding: 4px 8px;
    font-size: 0.7rem;
  }
}
</style>
