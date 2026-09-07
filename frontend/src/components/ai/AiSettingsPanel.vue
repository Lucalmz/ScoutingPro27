<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore } from '@/stores/ai'
import { OPENAI_PRESETS, DEFAULT_PRESET, getPresetById, findPresetByBaseUrl } from '@/components/ai/presets'
import type { AiSettings } from '@/types'

const props = defineProps<{
  systemPrompt?: string
}>()

const emit = defineEmits<{
  'update:systemPrompt': [value: string]
  saved: [settings: Partial<AiSettings>]
}>()

const { t, te } = useI18n()
const aiStore = useAiStore()

const GEMINI_API_KEY_URL = 'https://aistudio.google.com/app/apikey'

const provider = ref<'OPENAI' | 'GEMINI'>(aiStore.activeProvider || 'OPENAI')
const selectedPresetId = ref('deepseek')
const currentPreset = computed(() => getPresetById(selectedPresetId.value))
const currentPresetDesc = computed(() => {
  const key = 'ai.presets.' + currentPreset.value.id + '_desc'
  return te(key) ? t(key) : currentPreset.value.description
})
const apiKeyConsoleUrl = computed(() => {
  if (provider.value === 'GEMINI') return GEMINI_API_KEY_URL
  return currentPreset.value.apiKeyUrl
})

const apiKey = ref('')
const modelName = ref('')
const baseUrl = ref('')
const proxyHost = ref('127.0.0.1')
const proxyPort = ref<number | string | null>(null)
const systemPromptState = ref(props.systemPrompt || 'You are a helpful AI assistant for the ScoutingPro27 application. You help users analyze FTC scouting data.')
const isSaving = ref(false)
const isTesting = ref(false)
const testResult = ref<{success: boolean, statusCode?: number, latencyMs?: number, message?: string, error?: string} | null>(null)
const keyLostError = ref(false)

watch(() => props.systemPrompt, (newVal) => {
  if (newVal !== undefined && newVal !== systemPromptState.value) {
    systemPromptState.value = newVal
  }
})

watch(systemPromptState, (val) => {
  emit('update:systemPrompt', val)
})

function onPresetChange() {
  const preset = currentPreset.value
  if (preset.id !== 'custom') {
    baseUrl.value = preset.baseUrl
    modelName.value = preset.defaultModel
  }
}

function onBaseUrlInput() {
  const matched = findPresetByBaseUrl(baseUrl.value)
  if (matched.id !== 'custom' && matched.baseUrl.toLowerCase() === baseUrl.value.trim().replace(/\/+$/, '').toLowerCase()) {
    selectedPresetId.value = matched.id
  } else {
    selectedPresetId.value = 'custom'
  }
}

function loadFormForProvider() {
  keyLostError.value = false
  const s = aiStore.getSettingsForProvider(provider.value)
  if (s) {
    if (s.apiKeyEncrypted === 'ERR_KEY_LOST') {
      keyLostError.value = true
      apiKey.value = ''
    } else {
      apiKey.value = s.apiKeyEncrypted
    }
    baseUrl.value = s.baseUrl || ''
    if (provider.value === 'OPENAI') {
      const matched = findPresetByBaseUrl(s.baseUrl)
      selectedPresetId.value = matched.id
      modelName.value = s.modelName || matched.defaultModel || 'deepseek-chat'
      if (!baseUrl.value && matched.baseUrl) {
        baseUrl.value = matched.baseUrl
      }
    } else {
      modelName.value = s.modelName || 'gemini-flash-latest'
    }
    proxyHost.value = s.proxyHost || '127.0.0.1'
    proxyPort.value = s.proxyPort
    systemPromptState.value = s.systemPrompt || 'You are a helpful AI assistant for the ScoutingPro27 application. You help users analyze FTC scouting data.'
  } else {
    apiKey.value = ''
    if (provider.value === 'OPENAI') {
      const defaultPreset = DEFAULT_PRESET
      selectedPresetId.value = defaultPreset.id
      baseUrl.value = defaultPreset.baseUrl
      modelName.value = defaultPreset.defaultModel
    } else {
      baseUrl.value = ''
      modelName.value = 'gemini-flash-latest'
    }
    proxyHost.value = '127.0.0.1'
    proxyPort.value = null
    systemPromptState.value = 'You are a helpful AI assistant for the ScoutingPro27 application. You help users analyze FTC scouting data.'
  }
}

watch(provider, () => {
  aiStore.activeProvider = provider.value
  loadFormForProvider()
})

onMounted(async () => {
  if (aiStore.settingsList.length === 0) {
    await aiStore.fetchSettings()
  }
  loadFormForProvider()
})

async function saveSettings() {
  isSaving.value = true
  const payload: Partial<AiSettings> = {
    provider: provider.value,
    apiKeyEncrypted: apiKey.value,
    modelName: modelName.value,
    baseUrl: baseUrl.value,
    proxyHost: proxyHost.value,
    proxyPort: proxyPort.value === '' || proxyPort.value == null ? null : Number(proxyPort.value),
    systemPrompt: systemPromptState.value
  }
  const success = await aiStore.saveSettings(payload)
  isSaving.value = false
  if (success) {
    alert(t('ai.save_success'))
    loadFormForProvider()
    emit('saved', payload)
  } else {
    alert(t('ai.save_failed'))
  }
}

async function testConnection() {
  isTesting.value = true
  testResult.value = null
  const parsedPort = proxyPort.value === '' || proxyPort.value == null ? undefined : Number(proxyPort.value)
  const result = await aiStore.testConnection(provider.value, apiKey.value, proxyHost.value, parsedPort, baseUrl.value)
  testResult.value = result
  isTesting.value = false
}
</script>

<template>
  <div class="settings-panel">
    <h2>{{ $t('ai.config_title') }}</h2>
    <p class="subtitle">{{ $t('ai.config_subtitle') }}</p>
    
    <div class="settings-form">
      <div v-if="keyLostError" class="alert-error">
        <span class="material-icons">warning</span>
        {{ $t('ai.key_lost_warning') }}
      </div>
      <div class="form-row">
        <div class="form-group" style="flex: 1;">
          <div class="label-with-link">
            <label>{{ $t('ai.provider_protocol') }}</label>
            <a 
              v-if="provider === 'GEMINI'" 
              :href="GEMINI_API_KEY_URL" 
              target="_blank" 
              rel="noopener noreferrer" 
              class="api-link" 
              :title="$t('ai.get_key')"
            >
              <span class="material-icons" style="font-size: 13px;">open_in_new</span> {{ $t('ai.get_key') }}
            </a>
          </div>
          <select v-model="provider" :disabled="isSaving || isTesting">
            <option value="OPENAI">{{ $t('ai.provider_openai_compatible') }}</option>
            <option value="GEMINI">{{ $t('ai.provider_gemini') }}</option>
          </select>
        </div>
        <div v-if="provider === 'OPENAI'" class="form-group" style="flex: 1;">
          <div class="label-with-link">
            <label>{{ $t('ai.provider_preset') }}</label>
            <a 
              v-if="currentPreset.apiKeyUrl" 
              :href="currentPreset.apiKeyUrl" 
              target="_blank" 
              rel="noopener noreferrer" 
              class="api-link" 
              :title="$t('ai.get_key')"
            >
              <span class="material-icons" style="font-size: 13px;">open_in_new</span> {{ $t('ai.get_key') }}
            </a>
          </div>
          <select v-model="selectedPresetId" @change="onPresetChange" :disabled="isSaving || isTesting">
            <option v-for="p in OPENAI_PRESETS" :key="p.id" :value="p.id">
              {{ $te('ai.presets.' + p.id) ? $t('ai.presets.' + p.id) : p.name }}
            </option>
          </select>
        </div>
        <div v-else class="form-group" style="flex: 1;">
          <label>{{ $t('ai.model_name') }}</label>
          <select v-model="modelName" :disabled="isSaving || isTesting">
            <option value="gemini-flash-latest">gemini-flash-latest</option>
            <option value="gemini-flash-lite-latest">gemini-flash-lite-latest</option>
            <option value="gemini-pro-latest">gemini-pro-latest</option>
          </select>
        </div>
      </div>

      <div v-if="provider === 'OPENAI'" class="form-group">
        <label>{{ $t('ai.base_url') }}</label>
        <input 
          type="text" 
          v-model="baseUrl" 
          @input="onBaseUrlInput" 
          :placeholder="$t('ai.base_url_placeholder')" 
          :disabled="isSaving || isTesting" 
        />
        <small v-if="currentPresetDesc" class="hint">{{ currentPresetDesc }}</small>
      </div>

      <div v-if="provider === 'OPENAI'" class="form-group">
        <label>{{ $t('ai.model_name') }} <span>{{ $t('ai.model_required') }}</span></label>
        <input 
          type="text" 
          v-model="modelName" 
          list="preset-model-list" 
          :placeholder="$t('ai.model_placeholder')" 
          :disabled="isSaving || isTesting" 
        />
        <datalist id="preset-model-list">
          <option v-for="m in currentPreset.models" :key="m" :value="m">{{ m }}</option>
        </datalist>
      </div>
      
      <div class="form-group">
        <div class="label-with-link">
          <label>{{ $t('ai.api_key') }}</label>
          <a 
            v-if="apiKeyConsoleUrl" 
            :href="apiKeyConsoleUrl" 
            target="_blank" 
            rel="noopener noreferrer" 
            class="api-link" 
            :title="$t('ai.get_key')"
          >
            <span class="material-icons" style="font-size: 13px;">open_in_new</span> {{ $t('ai.get_key') }}
          </a>
        </div>
        <input type="password" v-model="apiKey" autocomplete="new-password" :placeholder="$t('ai.api_key_placeholder')" :disabled="isSaving || isTesting" />
        <small v-if="apiKey && (apiKey === '****' || apiKey.includes('***'))" class="hint">{{ $t('ai.api_key_saved_hint') }}</small>
      </div>

      <div class="form-row">
        <div class="form-group" style="flex: 2;">
          <label>{{ $t('ai.proxy_host') }}</label>
          <input type="text" v-model="proxyHost" placeholder="127.0.0.1" :disabled="isSaving || isTesting" />
        </div>
        <div class="form-group" style="flex: 1;">
          <label>{{ $t('ai.proxy_port') }}</label>
          <input type="number" v-model="proxyPort" :placeholder="$t('ai.proxy_port_placeholder')" :disabled="isSaving || isTesting" />
        </div>
      </div>

      <div class="form-group">
        <label>{{ $t('ai.system_prompt') }}</label>
        <textarea v-model="systemPromptState" rows="4" :disabled="isSaving || isTesting"></textarea>
      </div>

      <div class="button-group">
        <button class="btn-primary" @click="saveSettings" :disabled="isSaving || isTesting">
          {{ isSaving ? $t('ai.btn_saving') : $t('ai.btn_save') }}
        </button>
        <button class="btn-secondary" @click="testConnection" :disabled="isSaving || isTesting">
          {{ isTesting ? $t('ai.btn_testing') : $t('ai.btn_test') }}
        </button>
      </div>

      <div v-if="testResult" class="test-result" :class="{ success: testResult.success, error: !testResult.success }">
        <strong>{{ testResult.success ? $t('ai.test_success') : $t('ai.test_failed') }}</strong>
        <span v-if="testResult.latencyMs"> ({{ testResult.latencyMs }}ms)</span>
        <p v-if="testResult.message">{{ testResult.message }}</p>
        <p v-else-if="testResult.error">{{ testResult.error }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-panel {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 24px;
  overflow-y: auto;
  flex: 1;
}
.subtitle {
  color: var(--muted-foreground);
  font-size: 14px;
  margin-bottom: 20px;
}
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.form-row {
  display: flex;
  gap: 16px;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.form-group label {
  font-size: 14px;
  font-weight: 500;
}
.label-with-link {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.api-link {
  font-size: 12px;
  color: var(--primary);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-weight: 500;
}
.api-link:hover {
  text-decoration: underline;
}
.form-group input, .form-group select, .form-group textarea {
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--input);
  color: var(--foreground);
  font-family: inherit;
}
.hint {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-top: 4px;
}
.button-group {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}
.btn-primary, .btn-secondary {
  padding: 10px 20px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  border: none;
}
.btn-primary { background: var(--primary); color: var(--primary-foreground); }
.btn-secondary { background: var(--border); color: var(--foreground); }
.btn-primary:disabled, .btn-secondary:disabled { opacity: 0.6; cursor: not-allowed; }
.test-result {
  margin-top: 12px;
  padding: 12px;
  border-radius: 6px;
  font-size: 14px;
}
.test-result.success { background: rgba(46, 204, 113, 0.1); border: 1px solid #2ecc71; color: #27ae60; }
.test-result.error { background: rgba(231, 76, 60, 0.1); border: 1px solid #e74c3c; color: #c0392b; }
.alert-error {
  background: rgba(231, 76, 60, 0.1);
  border: 1px solid #e74c3c;
  color: #c0392b;
  padding: 12px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
</style>
