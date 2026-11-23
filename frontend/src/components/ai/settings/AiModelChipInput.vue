<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AiProtocol } from '@/types'
import { isZhLocale } from '@/components/ai/constants'
import { GEMINI_MODEL_TIERS } from '@/components/ai/presets'

const props = defineProps<{
  modelValue: string
  protocol: AiProtocol
  customModels: string[]
  combinedDatalistModels: string[]
  fetchedModels: string[]
  showPicker: boolean
  isFetchingModels: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:showPicker': [value: boolean]
  'pin-current': []
  'fetch-models': []
  'select-chip': [model: string]
  'remove-chip': [model: string]
  'select-fetched': [model: string, alsoPin: boolean]
}>()

const { t, locale } = useI18n()
const isZh = computed(() => isZhLocale(locale.value))
const modelFilter = ref('')

const filteredFetchedModels = computed<string[]>(() => {
  const q = modelFilter.value.trim().toLowerCase()
  if (!q) return props.fetchedModels
  return props.fetchedModels.filter(m => m.toLowerCase().includes(q))
})

function modelChipLabel(model: string): string {
  if (props.protocol === 'GEMINI' && GEMINI_MODEL_TIERS[model]) {
    return `${model} (${isZh.value ? GEMINI_MODEL_TIERS[model].zh : GEMINI_MODEL_TIERS[model].en})`
  }
  return model
}

function onInputChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}

function onTriggerFetch() {
  modelFilter.value = ''
  emit('fetch-models')
}
</script>

<template>
  <div class="form-field">
    <div class="field-label-row">
      <label for="ai-model-name">
        {{ t('ai.model_name') }}
        <span class="free-input-pill">{{ t('ai.model_free_input_badge') }}</span>
      </label>
      <div class="model-label-actions">
        <button
          type="button"
          class="btn-mini-action"
          :disabled="!modelValue.trim()"
          @click="emit('pin-current')"
        >
          + {{ t('ai.pin_custom_model') }}
        </button>
        <button
          type="button"
          class="btn-mini-action fetch-btn"
          :disabled="isFetchingModels"
          @click="onTriggerFetch"
        >
          <span class="material-icons" :class="{ spin: isFetchingModels }">sync</span>
          <span>{{ isFetchingModels ? t('ai.fetching_models') : t('ai.fetch_models') }}</span>
        </button>
      </div>
    </div>

    <input
      id="ai-model-name"
      :value="modelValue"
      type="text"
      list="ai-settings-model-datalist"
      :placeholder="t('ai.model_placeholder_any')"
      @input="onInputChange"
    />
    <datalist id="ai-settings-model-datalist">
      <option v-for="m in combinedDatalistModels" :key="m" :value="m">{{ modelChipLabel(m) }}</option>
    </datalist>

    <!-- Custom / Favorite Model Chips Pool -->
    <div v-if="customModels.length > 0" class="custom-model-chips">
      <div
        v-for="m in customModels"
        :key="m"
        class="model-chip"
        :class="{ active: modelValue.trim() === m }"
      >
        <button type="button" class="model-chip-select" @click="emit('select-chip', m)">
          {{ modelChipLabel(m) }}
        </button>
        <button
          type="button"
          class="model-chip-remove"
          :title="t('ai.remove_custom_model')"
          @click="emit('remove-chip', m)"
        >
          ×
        </button>
      </div>
    </div>

    <!-- Live Fetched Models Popover List -->
    <div v-if="showPicker && fetchedModels.length > 0" class="fetched-models-drawer">
      <div class="fetched-header">
        <input v-model="modelFilter" type="text" :placeholder="t('ai.filter_models_placeholder')" />
        <button type="button" class="btn-close-picker" @click="emit('update:showPicker', false)">
          <span class="material-icons">close</span>
        </button>
      </div>
      <div class="fetched-list">
        <div v-for="fm in filteredFetchedModels" :key="fm" class="fetched-row">
          <button type="button" class="fetched-select" @click="emit('select-fetched', fm, false)">
            {{ modelChipLabel(fm) }}
          </button>
          <button
            type="button"
            class="fetched-pin"
            :title="t('ai.pin_custom_model')"
            @click="emit('select-fetched', fm, true)"
          >
            +
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-field label {
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
}

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.form-field input[type='text'] {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--input);
  color: var(--foreground);
  font-size: 13px;
  font-family: inherit;
}

.form-field input:focus {
  outline: none;
  border-color: var(--status-ai);
}

.free-input-pill {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  font-weight: 600;
  background: var(--status-ai-bg);
  color: var(--status-ai);
  border: 1px solid var(--status-ai-border);
  margin-left: 6px;
}

.model-label-actions {
  display: flex;
  gap: 6px;
}

.btn-mini-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-elevated);
  color: var(--foreground);
  cursor: pointer;
}

.btn-mini-action:hover:not(:disabled) {
  border-color: var(--status-ai);
  color: var(--status-ai);
}

.btn-mini-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-mini-action .material-icons {
  font-size: 14px;
}

.spin {
  animation: aiSpin 1s linear infinite;
}

@keyframes aiSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.custom-model-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.model-chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-recessed);
  overflow: hidden;
}

.model-chip.active {
  border-color: var(--status-ai);
  background: var(--status-ai-bg);
}

.model-chip-select {
  background: transparent;
  border: none;
  color: var(--foreground);
  font-size: 11px;
  padding: 3px 8px;
  cursor: pointer;
}

.model-chip-remove {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-size: 13px;
  padding: 2px 7px 2px 2px;
  cursor: pointer;
}

.model-chip-remove:hover {
  color: var(--status-error);
}

.fetched-models-drawer {
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--popover);
  margin-top: 4px;
  overflow: hidden;
}

.fetched-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle);
}

.fetched-header input {
  flex: 1;
  padding: 4px 8px;
  font-size: 12px;
}

.btn-close-picker {
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
  display: inline-flex;
}

.fetched-list {
  max-height: 160px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.fetched-row {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
}

.fetched-select {
  flex: 1;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--foreground);
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}

.fetched-select:hover {
  background: var(--surface-hover);
}

.fetched-pin {
  background: transparent;
  border: none;
  color: var(--status-ai);
  padding: 6px 12px;
  font-weight: 700;
  cursor: pointer;
}
</style>
