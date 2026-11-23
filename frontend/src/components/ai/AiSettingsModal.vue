<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore, type ConnectionCheckResponse } from '@/stores/ai'
import { useToastStore } from '@/stores/toast'
import type { AiProtocol, AiProviderProfile } from '@/types'
import {
  AI_PROFILE_DEFAULTS,
  API_KEY_ERR_LOST,
  DEFAULT_ANTHROPIC_VERSION,
  isZhLocale
} from '@/components/ai/constants'
import {
  PROTOCOL_META,
  GEMINI_DEFAULT_MODELS,
  getPresetsForProtocol,
  getPresetById,
  findPresetByBaseUrl,
  detectKeyProtocolMismatch,
  isLocalBaseUrl,
  type OpenAiPreset,
  type VendorProtocolGuideRow
} from '@/components/ai/presets'
import AiProfileRoster from './settings/AiProfileRoster.vue'
import AiVendorGuideCard from './settings/AiVendorGuideCard.vue'
import AiModelChipInput from './settings/AiModelChipInput.vue'

const { t, te, locale } = useI18n()
const aiStore = useAiStore()
const toastStore = useToastStore()

const isZh = computed(() => isZhLocale(locale.value))
const dialogRef = ref<HTMLDialogElement | null>(null)
let pointerStartedOutside = false

const editingProfileId = ref<string>('')
const isCreatingNew = ref(false)

const name = ref('')
const presetId = ref('deepseek')
const protocol = ref<AiProtocol>('OPENAI')
const baseUrl = ref('')
const apiKey = ref('')
const showApiKey = ref(false)
const keyLostError = ref(false)
const modelName = ref('')
const customModels = ref<string[]>([])
const proxyHost = ref('')
const proxyPort = ref<number | string | null>(null)
const systemPrompt = ref('')
const temperature = ref<number>(AI_PROFILE_DEFAULTS.temperature)
const maxTokens = ref<number>(AI_PROFILE_DEFAULTS.maxTokens)
const enableThinking = ref<boolean>(AI_PROFILE_DEFAULTS.enableThinking)
const thinkingBudget = ref<number>(AI_PROFILE_DEFAULTS.thinkingBudget)
const anthropicVersion = ref<string>(DEFAULT_ANTHROPIC_VERSION)
const maxContextMsgs = ref<number>(AI_PROFILE_DEFAULTS.maxContextMsgs)
const isActiveProfile = ref<boolean>(true)

const showVendorGuide = ref(false)
const showAdvanced = ref(false)
const showModelPicker = ref(false)
const fetchedModels = ref<string[]>([])
const isSaving = ref(false)
const isTesting = ref(false)
const isFetchingModels = ref(false)
const testResult = ref<ConnectionCheckResponse | null>(null)

const protocolPresets = computed<OpenAiPreset[]>(() => getPresetsForProtocol(protocol.value))
const currentPreset = computed<OpenAiPreset>(() => getPresetById(presetId.value, protocol.value))
const protocolMeta = computed(() => PROTOCOL_META[protocol.value])
const isLocalLoopback = computed(() => isLocalBaseUrl(baseUrl.value))
const requiresApiKey = computed(() => {
  if (protocol.value === 'OPENAI' && (isLocalLoopback.value || currentPreset.value.requiresApiKey === false)) {
    return false
  }
  return true
})
const keyMismatch = computed(() => detectKeyProtocolMismatch(apiKey.value, protocol.value))

const combinedDatalistModels = computed<string[]>(() => {
  const set = new Set<string>()
  for (const m of customModels.value) set.add(m)
  for (const m of currentPreset.value.models) set.add(m)
  for (const m of fetchedModels.value) set.add(m)
  if (protocol.value === 'GEMINI') {
    for (const m of GEMINI_DEFAULT_MODELS) set.add(m)
  }
  return Array.from(set)
})

function presetDescText(preset: OpenAiPreset): string {
  const key = 'ai.presets.' + preset.id + '_desc'
  return te(key) ? t(key) : (preset.description || '')
}

function formatProbeFeedback(res: ConnectionCheckResponse | null): string {
  if (!res) return ''
  const codeMap: Record<string, string> = {
    PROBE_AUTH_OK: 'ai.probe_auth_ok',
    PROBE_REACHABLE_OK: 'ai.probe_reachable_ok',
    PROBE_MODELS_UNSUPPORTED: 'ai.probe_models_unsupported',
    PROBE_NEEDS_KEY: 'ai.probe_needs_key',
    PROBE_AUTH_FAILED: 'ai.probe_auth_failed',
    PROBE_HTTP_ERROR: 'ai.probe_http_error'
  }
  const i18nKey = res.messageCode ? codeMap[res.messageCode] : undefined
  if (i18nKey) {
    return t(i18nKey, { status: res.statusCode ?? '' })
  }
  return res.success
    ? (res.message || t('ai.test_success'))
    : (res.error || res.message || t('ai.test_failed'))
}

function hydrateFormFromProfile(profile: AiProviderProfile) {
  isCreatingNew.value = false
  editingProfileId.value = profile.id
  name.value = profile.name
  protocol.value = profile.protocol
  presetId.value = profile.presetId || findPresetByBaseUrl(profile.baseUrl, profile.protocol).id
  baseUrl.value = profile.baseUrl || ''
  keyLostError.value = profile.apiKeyEncrypted === API_KEY_ERR_LOST
  apiKey.value = keyLostError.value ? '' : profile.apiKeyEncrypted || ''
  modelName.value = profile.modelName || ''
  customModels.value =
    profile.customModels && profile.customModels.length > 0
      ? [...profile.customModels]
      : profile.protocol === 'GEMINI'
        ? [...GEMINI_DEFAULT_MODELS]
        : []
  proxyHost.value = profile.proxyHost || ''
  proxyPort.value = profile.proxyPort
  systemPrompt.value = profile.systemPrompt || ''
  temperature.value = profile.temperature ?? AI_PROFILE_DEFAULTS.temperature
  maxTokens.value = profile.maxTokens ?? AI_PROFILE_DEFAULTS.maxTokens
  enableThinking.value = profile.enableThinking !== false
  thinkingBudget.value = profile.thinkingBudget ?? AI_PROFILE_DEFAULTS.thinkingBudget
  anthropicVersion.value = profile.anthropicVersion || DEFAULT_ANTHROPIC_VERSION
  maxContextMsgs.value = profile.maxContextMsgs ?? AI_PROFILE_DEFAULTS.maxContextMsgs
  isActiveProfile.value = Boolean(profile.isActive)
  testResult.value = null
  fetchedModels.value = []
  showModelPicker.value = false
  showApiKey.value = false
}

function startNewProfile(targetProtocol: AiProtocol = 'OPENAI') {
  isCreatingNew.value = true
  editingProfileId.value = ''
  protocol.value = targetProtocol
  const presets = getPresetsForProtocol(targetProtocol)
  const def = presets[0]!
  presetId.value = def.id
  name.value =
    targetProtocol === 'GEMINI'
      ? 'Google Gemini'
      : targetProtocol === 'ANTHROPIC'
        ? 'Anthropic Claude'
        : def.name
  baseUrl.value = def.baseUrl
  modelName.value = def.defaultModel
  customModels.value = targetProtocol === 'GEMINI' ? [...GEMINI_DEFAULT_MODELS] : [...def.models]
  apiKey.value = ''
  keyLostError.value = false
  proxyHost.value = ''
  proxyPort.value = null
  systemPrompt.value = ''
  temperature.value = AI_PROFILE_DEFAULTS.temperature
  maxTokens.value = AI_PROFILE_DEFAULTS.maxTokens
  enableThinking.value = AI_PROFILE_DEFAULTS.enableThinking
  thinkingBudget.value = AI_PROFILE_DEFAULTS.thinkingBudget
  anthropicVersion.value = DEFAULT_ANTHROPIC_VERSION
  maxContextMsgs.value = AI_PROFILE_DEFAULTS.maxContextMsgs
  isActiveProfile.value = true
  testResult.value = null
  fetchedModels.value = []
  showModelPicker.value = false
  showApiKey.value = false
}

function switchProtocol(nextProtocol: AiProtocol) {
  if (protocol.value === nextProtocol) return
  const oldPreset = getPresetById(presetId.value, protocol.value)
  protocol.value = nextProtocol
  const presets = getPresetsForProtocol(nextProtocol)
  const def = presets[0]!
  presetId.value = def.id
  const shouldOverwriteFields =
    isCreatingNew.value || !baseUrl.value.trim() || baseUrl.value.trim() === oldPreset.baseUrl
  if (shouldOverwriteFields) {
    baseUrl.value = def.baseUrl
    modelName.value = def.defaultModel
  }
  if (nextProtocol === 'GEMINI') {
    const merged = new Set([...GEMINI_DEFAULT_MODELS])
    if (shouldOverwriteFields) {
      customModels.value = Array.from(merged)
      if (!modelName.value) modelName.value = GEMINI_DEFAULT_MODELS[0]!
    } else {
      for (const m of customModels.value) merged.add(m)
      customModels.value = Array.from(merged)
    }
  } else if (shouldOverwriteFields) {
    customModels.value = [...def.models]
  }
  if (isCreatingNew.value || name.value === oldPreset.name || !name.value.trim()) {
    name.value =
      nextProtocol === 'GEMINI'
        ? 'Google Gemini'
        : nextProtocol === 'ANTHROPIC'
          ? 'Anthropic Claude'
          : def.name
  }
  testResult.value = null
  fetchedModels.value = []
  showModelPicker.value = false
}

function onPresetChange() {
  const p = getPresetById(presetId.value, protocol.value)
  if (!p.id.endsWith('custom')) {
    baseUrl.value = p.baseUrl
    if (p.defaultModel) modelName.value = p.defaultModel
    const pool = protocol.value === 'GEMINI' ? [...GEMINI_DEFAULT_MODELS, ...p.models] : p.models
    const merged = new Set([...pool, ...customModels.value.filter(m => !p.models.includes(m))])
    customModels.value = Array.from(merged)
    if (isCreatingNew.value || !name.value.trim() || name.value === 'OpenAI Compatible') {
      name.value = p.name
    }
  }
  testResult.value = null
}

function onBaseUrlInput() {
  const matched = findPresetByBaseUrl(baseUrl.value, protocol.value)
  if (
    matched.baseUrl &&
    matched.baseUrl.replace(/\/+$/, '').toLowerCase() === baseUrl.value.trim().replace(/\/+$/, '').toLowerCase()
  ) {
    presetId.value = matched.id
  } else if (protocol.value === 'GEMINI') {
    presetId.value = 'gemini-custom'
  } else if (protocol.value === 'ANTHROPIC') {
    presetId.value = 'anthropic-custom'
  } else {
    presetId.value = 'custom'
  }
}

function applyVendorGuideRow(row: VendorProtocolGuideRow) {
  protocol.value = row.protocol
  const matched = findPresetByBaseUrl(row.baseUrl, row.protocol)
  presetId.value = matched.id
  baseUrl.value = row.baseUrl
  if (matched.defaultModel) modelName.value = matched.defaultModel
  if (row.protocol === 'GEMINI') {
    customModels.value = [...GEMINI_DEFAULT_MODELS]
  } else if (matched.models.length > 0) {
    customModels.value = [...matched.models]
  }
  if (isCreatingNew.value || !name.value.trim()) {
    name.value = isZh.value ? row.vendorZh : row.vendorEn
  }
  showVendorGuide.value = false
  testResult.value = null
}

function addCurrentModelToChips() {
  const m = modelName.value.trim()
  if (!m) return
  if (!customModels.value.includes(m)) {
    customModels.value = [...customModels.value, m]
  }
}

function removeCustomModelChip(model: string) {
  customModels.value = customModels.value.filter(m => m !== model)
}

function selectModelChip(model: string) {
  modelName.value = model
}

function applySuggestedProtocol(nextProto: AiProtocol) {
  const currentKey = apiKey.value
  const currentName = name.value
  switchProtocol(nextProto)
  apiKey.value = currentKey
  if (currentName) name.value = currentName
}

function openNativeDialog() {
  const dlg = dialogRef.value
  if (!dlg || dlg.open) return
  if (typeof dlg.showModal === 'function') {
    try {
      dlg.showModal()
    } catch {
      dlg.setAttribute('open', '')
    }
  } else {
    dlg.setAttribute('open', '')
  }
}

function closeNativeDialog() {
  const dlg = dialogRef.value
  if (!dlg || !dlg.open) return
  if (typeof dlg.close === 'function') {
    dlg.close()
  } else {
    dlg.removeAttribute('open')
  }
}

watch(
  () => aiStore.settingsModalOpen,
  async (isOpen) => {
    if (isOpen) {
      if (aiStore.profiles.length === 0) await aiStore.fetchProfiles()
      const targetId = aiStore.settingsModalTargetProfileId
      const targetProfile =
        (targetId && aiStore.profiles.find(p => p.id === targetId)) ||
        aiStore.activeProfile ||
        aiStore.profiles[0]
      if (targetProfile) {
        hydrateFormFromProfile(targetProfile)
      } else {
        startNewProfile('OPENAI')
      }
      await nextTick()
      openNativeDialog()
    } else {
      closeNativeDialog()
    }
  },
  { immediate: true }
)

function handleCancel(e: Event) {
  e.preventDefault()
  aiStore.closeSettingsModal()
}

function handleNativeClose() {
  if (aiStore.settingsModalOpen) aiStore.closeSettingsModal()
}

function isPointOutsideDialog(e: PointerEvent): boolean {
  const dlg = dialogRef.value
  if (!dlg) return false
  const rect = dlg.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  return e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom
}

function onBackdropPointerDown(e: PointerEvent) {
  pointerStartedOutside = e.target === dialogRef.value && isPointOutsideDialog(e)
}

function onBackdropPointerUp(e: PointerEvent) {
  if (pointerStartedOutside && e.target === dialogRef.value && isPointOutsideDialog(e)) {
    aiStore.closeSettingsModal()
  }
  pointerStartedOutside = false
}

function buildProbeParams() {
  return {
    profileId: editingProfileId.value || undefined,
    protocol: protocol.value,
    apiKey: apiKey.value,
    baseUrl: baseUrl.value,
    proxyHost: proxyHost.value,
    proxyPort: proxyPort.value === '' || proxyPort.value == null ? null : Number(proxyPort.value),
    anthropicVersion: anthropicVersion.value
  }
}

async function handleFetchModels() {
  isFetchingModels.value = true
  testResult.value = null
  const res = await aiStore.fetchModels(buildProbeParams())
  isFetchingModels.value = false
  testResult.value = res
  if (res.models && res.models.length > 0) {
    fetchedModels.value = res.models
    showModelPicker.value = true
  } else {
    showModelPicker.value = false
  }
}

async function handleTestConnection() {
  isTesting.value = true
  testResult.value = null
  const res = await aiStore.testConnection(buildProbeParams())
  isTesting.value = false
  testResult.value = res
  if (res.models && res.models.length > 0) {
    fetchedModels.value = res.models
  }
}

async function handleSave() {
  const trimmedModel = modelName.value.trim()
  const finalCustomModels = [...customModels.value]
  if (trimmedModel && !finalCustomModels.includes(trimmedModel)) {
    finalCustomModels.unshift(trimmedModel)
  }

  isSaving.value = true
  const res = await aiStore.saveProfile({
    id: editingProfileId.value || undefined,
    name: name.value.trim() || undefined,
    presetId: presetId.value,
    protocol: protocol.value,
    apiKeyEncrypted: apiKey.value,
    baseUrl: baseUrl.value.trim(),
    modelName: trimmedModel,
    customModels: finalCustomModels,
    systemPrompt: systemPrompt.value,
    temperature: Number(temperature.value),
    maxTokens: Number(maxTokens.value) || AI_PROFILE_DEFAULTS.maxTokens,
    enableThinking: enableThinking.value,
    thinkingBudget: Number(thinkingBudget.value) || AI_PROFILE_DEFAULTS.thinkingBudget,
    anthropicVersion: anthropicVersion.value.trim() || DEFAULT_ANTHROPIC_VERSION,
    maxContextMsgs: Number(maxContextMsgs.value) || AI_PROFILE_DEFAULTS.maxContextMsgs,
    proxyHost: proxyHost.value.trim(),
    proxyPort: proxyPort.value === '' || proxyPort.value == null ? null : Number(proxyPort.value),
    isActive: isActiveProfile.value
  })
  isSaving.value = false

  if (res.ok && res.profile) {
    toastStore.showToast(t('ai.save_success'), 'success')
    hydrateFormFromProfile(res.profile)
    aiStore.closeSettingsModal()
  } else {
    toastStore.showError(res.error || t('ai.save_failed'))
  }
}

async function handleDeleteProfile(profileIdToDelete: string) {
  const ok = await aiStore.deleteProfile(profileIdToDelete)
  if (ok) {
    toastStore.showToast(t('ai.profile_deleted'), 'info')
    if (aiStore.activeProfile) {
      hydrateFormFromProfile(aiStore.activeProfile)
    } else {
      startNewProfile('OPENAI')
    }
  }
}

function selectFetchedModel(m: string, alsoPin: boolean) {
  modelName.value = m
  if (alsoPin && !customModels.value.includes(m)) {
    customModels.value = [...customModels.value, m]
  }
  showModelPicker.value = false
}
</script>

<template>
  <dialog
    ref="dialogRef"
    class="ai-settings-dialog"
    closedby="any"
    :aria-label="t('ai.config_title')"
    @cancel="handleCancel"
    @close="handleNativeClose"
    @pointerdown="onBackdropPointerDown"
    @pointerup="onBackdropPointerUp"
  >
    <div class="dialog-shell">
      <header class="dialog-header">
        <div class="header-title-group">
          <span class="material-icons header-ai-icon">auto_awesome</span>
          <div>
            <h2>{{ t('ai.config_title') }}</h2>
            <p class="header-subtitle">{{ t('ai.config_subtitle') }}</p>
          </div>
        </div>
        <button
          type="button"
          class="btn-dialog-close"
          :aria-label="t('team_drawer.close')"
          @click="aiStore.closeSettingsModal()"
        >
          <span class="material-icons">close</span>
        </button>
      </header>

      <div class="dialog-body">
        <AiProfileRoster
          :profiles="aiStore.profiles"
          :editing-profile-id="editingProfileId"
          :is-creating-new="isCreatingNew"
          :active-protocol="protocol"
          @select="hydrateFormFromProfile"
          @create="startNewProfile"
          @delete="handleDeleteProfile"
        />

        <div class="config-form-pane">
          <div class="form-row-two">
            <div class="form-field">
              <label for="ai-profile-name">{{ t('ai.profile_name') }}</label>
              <input
                id="ai-profile-name"
                v-model="name"
                type="text"
                :placeholder="t('ai.profile_name_placeholder')"
              />
            </div>
            <div class="form-field active-toggle-field">
              <label>{{ t('ai.activate_on_save') }}</label>
              <label class="switch-row">
                <input type="checkbox" v-model="isActiveProfile" />
                <span>{{ isActiveProfile ? t('ai.profile_is_active') : t('ai.profile_standby') }}</span>
              </label>
            </div>
          </div>

          <!-- Three-Protocol Switcher -->
          <div class="form-field">
            <div class="field-label-row">
              <label>{{ t('ai.provider_protocol') }}</label>
              <button type="button" class="btn-link-guide" @click="showVendorGuide = !showVendorGuide">
                <span class="material-icons">help_outline</span>
                <span>{{ t('ai.vendor_guide_toggle') }}</span>
              </button>
            </div>
            <div class="protocol-tabs">
              <button
                v-for="proto in (['OPENAI', 'GEMINI', 'ANTHROPIC'] as const)"
                :key="proto"
                type="button"
                class="proto-tab-btn"
                :class="{ active: protocol === proto }"
                @click="switchProtocol(proto)"
              >
                <span class="proto-badge-mini" :class="`proto-${proto.toLowerCase()}`">{{ PROTOCOL_META[proto].badge }}</span>
                <span class="proto-tab-title">{{ isZh ? PROTOCOL_META[proto].labelZh : PROTOCOL_META[proto].labelEn }}</span>
              </button>
            </div>
            <p class="protocol-summary-bar">
              <code>{{ protocolMeta.authHeader }}</code>
              <span>· {{ isZh ? protocolMeta.vendorsSummaryZh : protocolMeta.vendorsSummaryEn }}</span>
            </p>
          </div>

          <AiVendorGuideCard v-if="showVendorGuide" @fill="applyVendorGuideRow" />

          <!-- Preset Selector + Base URL -->
          <div class="form-row-two">
            <div class="form-field">
              <label for="ai-preset-select">{{ t('ai.provider_preset') }}</label>
              <select id="ai-preset-select" v-model="presetId" @change="onPresetChange">
                <option v-for="p in protocolPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <span class="field-hint">{{ presetDescText(currentPreset) }}</span>
            </div>

            <div class="form-field">
              <div class="field-label-row">
                <label for="ai-base-url">{{ t('ai.base_url') }}</label>
                <span v-if="isLocalLoopback" class="local-bypass-badge">{{ t('ai.local_bypass_badge') }}</span>
              </div>
              <input
                id="ai-base-url"
                v-model="baseUrl"
                type="text"
                :placeholder="protocolMeta.defaultBaseUrl"
                @input="onBaseUrlInput"
              />
              <span class="field-hint">{{ t('ai.base_url_hint') }}</span>
            </div>
          </div>

          <!-- API Key with Format Guide & Non-blocking Mismatch Nudge -->
          <div class="form-field">
            <div class="field-label-row">
              <label for="ai-api-key">
                {{ t('ai.api_key') }}
                <span v-if="!requiresApiKey" class="optional-tag">({{ t('ai.key_optional_local') }})</span>
              </label>
              <a
                v-if="currentPreset.apiKeyUrl"
                :href="currentPreset.apiKeyUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="get-key-link"
              >
                {{ t('ai.get_key') }} ↗
              </a>
            </div>

            <div v-if="keyLostError" class="key-lost-banner">
              <span class="material-icons">warning</span>
              <span>{{ t('ai.key_lost_warning') }}</span>
            </div>

            <div class="input-with-action">
              <input
                id="ai-api-key"
                v-model="apiKey"
                :type="showApiKey ? 'text' : 'password'"
                :placeholder="protocolMeta.keyPlaceholder"
                autocomplete="off"
              />
              <button
                type="button"
                class="btn-inline-icon"
                :title="showApiKey ? t('ai.hide_key') : t('ai.show_key')"
                @click="showApiKey = !showApiKey"
              >
                <span class="material-icons">{{ showApiKey ? 'visibility_off' : 'visibility' }}</span>
              </button>
            </div>
            <span class="field-hint">{{ isZh ? protocolMeta.keyFormatHintZh : protocolMeta.keyFormatHintEn }}</span>

            <div v-if="keyMismatch" class="mismatch-nudge">
              <span class="material-icons">tips_and_updates</span>
              <span class="mismatch-text">{{ t(keyMismatch.reasonKey) }}</span>
              <button type="button" class="btn-switch-suggested" @click="applySuggestedProtocol(keyMismatch.suggestedProtocol)">
                {{ t('ai.switch_to_protocol', { protocol: PROTOCOL_META[keyMismatch.suggestedProtocol].badge }) }}
              </button>
            </div>
          </div>

          <AiModelChipInput
            v-model="modelName"
            v-model:show-picker="showModelPicker"
            :protocol="protocol"
            :custom-models="customModels"
            :combined-datalist-models="combinedDatalistModels"
            :fetched-models="fetchedModels"
            :is-fetching-models="isFetchingModels"
            @pin-current="addCurrentModelToChips"
            @fetch-models="handleFetchModels"
            @select-chip="selectModelChip"
            @remove-chip="removeCustomModelChip"
            @select-fetched="selectFetchedModel"
          />

          <!-- Proxy Row -->
          <div class="form-row-two">
            <div class="form-field">
              <label for="ai-proxy-host">{{ t('ai.proxy_host') }}</label>
              <input id="ai-proxy-host" v-model="proxyHost" type="text" placeholder="127.0.0.1" />
            </div>
            <div class="form-field">
              <label for="ai-proxy-port">{{ t('ai.proxy_port') }}</label>
              <input id="ai-proxy-port" v-model="proxyPort" type="number" :placeholder="t('ai.proxy_port_placeholder')" />
            </div>
          </div>

          <!-- Collapsible Advanced Parameters -->
          <div class="advanced-section">
            <button type="button" class="btn-advanced-toggle" @click="showAdvanced = !showAdvanced">
              <span class="material-icons">{{ showAdvanced ? 'expand_less' : 'expand_more' }}</span>
              <span>{{ t('ai.advanced_params') }}</span>
            </button>

            <div v-if="showAdvanced" class="advanced-grid">
              <div class="form-field">
                <label>{{ t('ai.temperature') }} ({{ temperature }})</label>
                <input v-model.number="temperature" type="range" min="0" max="1.5" step="0.05" />
              </div>
              <div class="form-field">
                <label>{{ t('ai.max_tokens') }}</label>
                <input v-model.number="maxTokens" type="number" min="256" max="65536" step="256" />
              </div>
              <div class="form-field">
                <label>{{ t('ai.max_context_msgs') }}</label>
                <input v-model.number="maxContextMsgs" type="number" min="2" max="60" />
              </div>
              <div class="form-field">
                <label class="switch-row" style="margin-top: 22px;">
                  <input type="checkbox" v-model="enableThinking" />
                  <span>{{ t('ai.enable_thinking') }}</span>
                </label>
              </div>
              <div v-if="protocol === 'ANTHROPIC' && enableThinking" class="form-field">
                <label>{{ t('ai.thinking_budget') }}</label>
                <input v-model.number="thinkingBudget" type="number" min="1024" max="32768" step="512" />
              </div>
              <div v-if="protocol === 'ANTHROPIC'" class="form-field">
                <label>{{ t('ai.anthropic_version_label') }}</label>
                <input v-model="anthropicVersion" type="text" :placeholder="DEFAULT_ANTHROPIC_VERSION" />
              </div>
              <div class="form-field full-span">
                <label>{{ t('ai.system_prompt') }}</label>
                <textarea v-model="systemPrompt" rows="3" :placeholder="t('ai.persona_placeholder')"></textarea>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer class="dialog-footer">
        <div class="footer-status">
          <div v-if="testResult" class="test-pill" :class="{ ok: testResult.success, err: !testResult.success }">
            <span class="material-icons">{{ testResult.success ? 'check_circle' : 'error' }}</span>
            <span class="test-pill-text">
              {{ formatProbeFeedback(testResult) }}
              <template v-if="testResult.latencyMs !== undefined"> ({{ testResult.latencyMs }}ms)</template>
              <template v-if="testResult.models && testResult.models.length > 0">
                · {{ t('ai.models_found_count', { count: testResult.models.length }) }}
              </template>
            </span>
          </div>
        </div>
        <div class="footer-actions">
          <button type="button" class="btn-secondary" :disabled="isTesting" @click="handleTestConnection">
            {{ isTesting ? t('ai.btn_testing') : t('ai.btn_test') }}
          </button>
          <button type="button" class="btn-ghost" @click="aiStore.closeSettingsModal()">
            {{ t('ai.btn_cancel_edit') }}
          </button>
          <button type="button" class="btn-primary-save" :disabled="isSaving" @click="handleSave">
            {{ isSaving ? t('ai.btn_saving') : t('ai.btn_save') }}
          </button>
        </div>
      </footer>
    </div>
  </dialog>
</template>

<style scoped src="./AiSettingsModal.css"></style>
