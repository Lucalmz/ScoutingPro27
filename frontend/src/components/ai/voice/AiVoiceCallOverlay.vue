<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AiProviderProfile } from '@/types'
import { isZhLocale } from '@/components/ai/constants'
import type { VoiceSessionStatus } from './useAiVoiceSession'
import type {
  VoiceCapability,
  VoiceEngineKind,
  VoiceInputMode,
  VoiceModelOption,
  VoiceSpeakerOption
} from './voiceCatalog'

const props = defineProps<{
  isActive: boolean
  isMinimized: boolean
  status: VoiceSessionStatus
  engine: VoiceEngineKind
  capability: VoiceCapability
  isNativeLive: boolean
  inputMode: VoiceInputMode
  isMuted: boolean
  isPttHolding: boolean
  inputLevel: number
  outputLevel: number
  elapsedSeconds: number
  selectedModel: string
  selectedVoice: string
  sttHelperProfileId: string
  sttHelpers: AiProviderProfile[]
  activeSttProfile: AiProviderProfile | null
  autoSpeakTurnVoice: boolean
  forceOpenAiRealtime: boolean
  canUseBrowserSpeechRec: boolean
  liveUserTranscript: string
  liveAssistantTranscript: string
  lastCompletedTurn: { user: string; assistant: string } | null
  errorMessage: string | null
  goAwayWarning: string | null
}>()

const emit = defineEmits<{
  'update:isMinimized': [val: boolean]
  'update:inputMode': [val: VoiceInputMode]
  'update:selectedModel': [val: string]
  'update:selectedVoice': [val: string]
  'update:sttHelperProfileId': [val: string]
  'update:autoSpeakTurnVoice': [val: boolean]
  toggleForceRealtime: [val: boolean]
  applyAndReconnect: []
  retry: []
  stop: []
  toggleMute: []
  beginPtt: []
  endPtt: []
  interrupt: []
  sendText: [text: string]
}>()

const { t, locale } = useI18n()
const isZh = computed(() => isZhLocale(locale.value))

const showSettings = ref(false)
const quickText = ref('')
const customModelDraft = ref('')
const showCustomModelInput = ref(false)

const formattedTimer = computed(() => {
  const m = Math.floor(props.elapsedSeconds / 60)
  const s = props.elapsedSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})

const engineLabel = computed(() => {
  if (props.engine === 'gemini-live') return t('ai.voice.engine_gemini')
  if (props.engine === 'openai-realtime') return t('ai.voice.engine_openai')
  return t('ai.voice.engine_turn')
})

const statusLabel = computed(() => {
  if (props.isMuted && props.status === 'listening') return t('ai.voice.status_muted')
  switch (props.status) {
    case 'connecting':
      return t('ai.voice.status_connecting')
    case 'recording':
      return t('ai.voice.status_recording')
    case 'transcribing':
      return t('ai.voice.status_transcribing')
    case 'thinking':
      return t('ai.voice.status_thinking')
    case 'speaking':
      return t('ai.voice.status_speaking')
    case 'error':
      return t('ai.voice.status_error')
    default:
      return props.inputMode === 'ptt'
        ? t('ai.voice.status_ready_ptt')
        : t('ai.voice.status_listening')
  }
})

const orbScale = computed(() => {
  const activeLvl = props.status === 'speaking' ? props.outputLevel : props.inputLevel
  return (1 + Math.min(0.28, activeLvl * 0.28)).toFixed(3)
})

const modelOptions = computed<VoiceModelOption[]>(() => props.capability.models)
const voiceOptions = computed<VoiceSpeakerOption[]>(() => props.capability.voices)

const isPresetModel = computed(() =>
  modelOptions.value.some(m => m.id === props.selectedModel)
)

function onModelSelectChange(evt: Event) {
  const val = (evt.target as HTMLSelectElement).value
  if (val === '__custom__') {
    showCustomModelInput.value = true
    customModelDraft.value = props.selectedModel
    return
  }
  showCustomModelInput.value = false
  emit('update:selectedModel', val)
  emit('applyAndReconnect')
}

function applyCustomModel() {
  const clean = customModelDraft.value.trim()
  if (!clean) return
  showCustomModelInput.value = false
  emit('update:selectedModel', clean)
  emit('applyAndReconnect')
}

function onVoiceSelectChange(evt: Event) {
  const val = (evt.target as HTMLSelectElement).value
  emit('update:selectedVoice', val)
  emit('applyAndReconnect')
}

function submitQuickText() {
  const clean = quickText.value.trim()
  if (!clean) return
  quickText.value = ''
  emit('sendText', clean)
}

function onPttPointerDown(e: PointerEvent) {
  e.preventDefault()
  emit('beginPtt')
}

function onPttPointerUp() {
  if (props.isPttHolding) {
    emit('endPtt')
  }
}

function handleGlobalKeydown(e: KeyboardEvent) {
  if (!props.isActive || props.isMinimized || props.inputMode !== 'ptt') return
  if (e.code !== 'Space' || e.repeat) return
  const activeTag = (document.activeElement?.tagName || '').toUpperCase()
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return
  if (activeTag === 'BUTTON' && !(document.activeElement as HTMLElement)?.classList.contains('btn-ptt-hold')) {
    return
  }
  e.preventDefault()
  emit('beginPtt')
}

function handleGlobalKeyup(e: KeyboardEvent) {
  if (!props.isActive || props.inputMode !== 'ptt') return
  if (e.code !== 'Space') return
  if (props.isPttHolding) {
    e.preventDefault()
    emit('endPtt')
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('keyup', handleGlobalKeyup)
  window.addEventListener('pointerup', onPttPointerUp)
  window.addEventListener('blur', onPttPointerUp)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('keyup', handleGlobalKeyup)
  window.removeEventListener('pointerup', onPttPointerUp)
  window.removeEventListener('blur', onPttPointerUp)
})

const miniSnippet = computed(() => {
  if (props.liveAssistantTranscript) return props.liveAssistantTranscript
  if (props.liveUserTranscript) return props.liveUserTranscript
  if (props.errorMessage) return props.errorMessage
  return statusLabel.value
})
</script>

<template>
  <template v-if="isActive">
    <!-- Expanded Full Voice Stage inside Copilot Workspace -->
    <section
      v-if="!isMinimized"
      class="voice-stage-overlay"
      role="dialog"
      aria-modal="false"
      :aria-label="t('ai.voice.stage_title')"
    >
      <header class="voice-stage-header">
        <div class="voice-hdr-meta">
          <span class="voice-engine-badge" :class="engine">
            <span class="engine-dot" aria-hidden="true"></span>
            <span>{{ engineLabel }}</span>
          </span>
          <span class="voice-timer" aria-label="Call duration">{{ formattedTimer }}</span>
        </div>

        <div class="voice-hdr-actions">
          <button
            type="button"
            class="voice-hdr-btn"
            :class="{ active: showSettings }"
            :aria-expanded="showSettings"
            :aria-label="t('ai.voice.settings_title')"
            :title="t('ai.voice.settings_title')"
            @click="showSettings = !showSettings"
          >
            <span class="material-icons" aria-hidden="true">tune</span>
          </button>
          <button
            type="button"
            class="voice-hdr-btn"
            :aria-label="t('ai.voice.minimize')"
            :title="t('ai.voice.minimize')"
            @click="emit('update:isMinimized', true)"
          >
            <span class="material-icons" aria-hidden="true">close_fullscreen</span>
          </button>
        </div>
      </header>

      <!-- Voice Configuration Drawer -->
      <div v-if="showSettings" class="voice-settings-panel">
        <template v-if="isNativeLive">
          <div class="voice-setting-row">
            <label for="voice-model-select">{{ t('ai.voice.model_label') }}</label>
            <select
              id="voice-model-select"
              :value="isPresetModel && !showCustomModelInput ? selectedModel : '__custom__'"
              @change="onModelSelectChange"
            >
              <option v-for="m in modelOptions" :key="m.id" :value="m.id">
                {{ isZh ? m.labelZh : m.labelEn }}
              </option>
              <option value="__custom__">{{ t('ai.voice.custom_model_option') }}</option>
            </select>
          </div>

          <div v-if="showCustomModelInput || !isPresetModel" class="voice-custom-model-row">
            <input
              v-model="customModelDraft"
              type="text"
              :placeholder="selectedModel"
              :aria-label="t('ai.voice.custom_model_option')"
              @keydown.enter.prevent="applyCustomModel"
            />
            <button type="button" class="btn-voice-apply" @click="applyCustomModel">
              {{ t('ai.voice.apply_reconnect') }}
            </button>
          </div>

          <div class="voice-setting-row">
            <label for="voice-speaker-select">{{ t('ai.voice.voice_label') }}</label>
            <select
              id="voice-speaker-select"
              :value="selectedVoice"
              @change="onVoiceSelectChange"
            >
              <option v-for="v in voiceOptions" :key="v.id" :value="v.id">
                {{ isZh ? v.labelZh : v.labelEn }}
              </option>
            </select>
          </div>
        </template>

        <template v-else>
          <div class="voice-setting-row">
            <label for="voice-stt-select">{{ t('ai.voice.stt_source_label') }}</label>
            <select
              id="voice-stt-select"
              :value="sttHelperProfileId"
              @change="emit('update:sttHelperProfileId', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                {{
                  activeSttProfile
                    ? t('ai.voice.stt_auto_profile', { name: activeSttProfile.name })
                    : t('ai.voice.stt_auto_browser')
                }}
              </option>
              <option v-for="h in sttHelpers" :key="h.id" :value="h.id">
                {{ h.name }} ({{ h.protocol }})
              </option>
              <option v-if="canUseBrowserSpeechRec" value="browser">
                {{ t('ai.voice.stt_browser_webspeech') }}
              </option>
            </select>
          </div>

          <label class="voice-setting-toggle">
            <input
              type="checkbox"
              :checked="autoSpeakTurnVoice"
              @change="emit('update:autoSpeakTurnVoice', ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ t('ai.voice.auto_speak_replies') }}</span>
          </label>
        </template>

        <label v-if="capability.canForceOpenAiRealtime" class="voice-setting-toggle">
          <input
            type="checkbox"
            :checked="forceOpenAiRealtime"
            @change="
              emit('toggleForceRealtime', ($event.target as HTMLInputElement).checked);
              emit('applyAndReconnect')
            "
          />
          <span>{{ t('ai.voice.force_openai_realtime') }}</span>
        </label>
      </div>

      <div v-if="goAwayWarning" class="voice-banner-warn" role="status">
        <span class="material-icons" aria-hidden="true">schedule</span>
        <span>{{ goAwayWarning }}</span>
      </div>

      <div v-if="errorMessage" class="voice-banner-error" role="alert">
        <span class="material-icons" aria-hidden="true">error_outline</span>
        <span class="err-msg-text">{{ errorMessage }}</span>
        <button type="button" class="btn-retry-inline" @click="emit('retry')">
          {{ t('ai.voice.retry') }}
        </button>
      </div>

      <!-- Centerpiece Reactive Voice Orb -->
      <div class="voice-stage-center">
        <div
          class="voice-orb-shell"
          :class="[`state-${status}`, { 'is-muted': isMuted && status === 'listening' }]"
          :style="{ '--orb-scale': orbScale }"
          aria-hidden="true"
        >
          <div class="voice-orb-ring"></div>
          <div class="voice-orb-core">
            <span class="material-icons voice-orb-icon">
              {{
                status === 'speaking'
                  ? 'graphic_eq'
                  : status === 'thinking' || status === 'transcribing'
                    ? 'psychology'
                    : isMuted
                      ? 'mic_off'
                      : 'mic'
              }}
            </span>
          </div>
        </div>

        <div class="voice-status-text" aria-live="polite">
          {{ statusLabel }}
        </div>
        <div class="voice-sub-hint">
          <template v-if="isNativeLive">
            {{
              inputMode === 'vad'
                ? t('ai.voice.hint_vad')
                : t('ai.voice.hint_ptt')
            }}
          </template>
          <template v-else>
            {{
              activeSttProfile
                ? t('ai.voice.hint_turn_stt', { name: activeSttProfile.name })
                : t('ai.voice.hint_turn_browser')
            }}
          </template>
        </div>

        <!-- Live Subtitle / Caption Stream -->
        <div class="voice-captions-box">
          <div v-if="liveUserTranscript || liveAssistantTranscript" class="caption-turn">
            <div v-if="liveUserTranscript" class="caption-line is-user">
              <span class="cap-tag">{{ t('ai.role_you') }}</span>
              <span>{{ liveUserTranscript }}</span>
            </div>
            <div v-if="liveAssistantTranscript" class="caption-line is-ai">
              <span class="cap-tag">{{ t('ai.role_copilot') }}</span>
              <span>{{ liveAssistantTranscript }}</span>
            </div>
          </div>
          <div v-else-if="lastCompletedTurn" class="caption-turn is-past">
            <div v-if="lastCompletedTurn.user" class="caption-line is-user">
              <span class="cap-tag">{{ t('ai.role_you') }}</span>
              <span>{{ lastCompletedTurn.user }}</span>
            </div>
            <div v-if="lastCompletedTurn.assistant" class="caption-line is-ai">
              <span class="cap-tag">{{ t('ai.role_copilot') }}</span>
              <span>{{ lastCompletedTurn.assistant }}</span>
            </div>
          </div>
          <div v-else class="caption-placeholder">
            {{ t('ai.voice.caption_placeholder') }}
          </div>
        </div>
      </div>

      <!-- Mid-call silent text input -->
      <form class="voice-text-inject" @submit.prevent="submitQuickText">
        <input
          v-model="quickText"
          type="text"
          :placeholder="t('ai.voice.text_inject_placeholder')"
          :aria-label="t('ai.voice.text_inject_placeholder')"
        />
        <button
          type="submit"
          class="btn-voice-send-text"
          :disabled="!quickText.trim()"
          :aria-label="t('ai.btn_send')"
        >
          <span class="material-icons" aria-hidden="true">send</span>
        </button>
      </form>

      <!-- Bottom Call Controls -->
      <footer class="voice-controls-footer">
        <div v-if="isNativeLive" class="voice-mode-pills" role="group" :aria-label="t('ai.voice.input_mode_label')">
          <button
            type="button"
            class="mode-pill"
            :class="{ active: inputMode === 'vad' }"
            :aria-pressed="inputMode === 'vad'"
            @click="emit('update:inputMode', 'vad')"
          >
            {{ t('ai.voice.mode_vad') }}
          </button>
          <button
            type="button"
            class="mode-pill"
            :class="{ active: inputMode === 'ptt' }"
            :aria-pressed="inputMode === 'ptt'"
            @click="emit('update:inputMode', 'ptt')"
          >
            {{ t('ai.voice.mode_ptt') }}
          </button>
        </div>

        <div class="voice-action-dock">
          <button
            v-if="isNativeLive && inputMode === 'vad'"
            type="button"
            class="voice-ctrl-btn"
            :class="{ muted: isMuted }"
            :aria-pressed="isMuted"
            :aria-label="isMuted ? t('ai.voice.unmute') : t('ai.voice.mute')"
            :title="isMuted ? t('ai.voice.unmute') : t('ai.voice.mute')"
            @click="emit('toggleMute')"
          >
            <span class="material-icons" aria-hidden="true">{{ isMuted ? 'mic_off' : 'mic' }}</span>
          </button>

          <button
            v-else
            type="button"
            class="btn-ptt-hold"
            :class="{ holding: isPttHolding }"
            :aria-pressed="isPttHolding"
            @pointerdown="onPttPointerDown"
            @pointerup="onPttPointerUp"
            @pointercancel="onPttPointerUp"
            @pointerleave="onPttPointerUp"
          >
            <span class="material-icons" aria-hidden="true">{{ isPttHolding ? 'graphic_eq' : 'mic' }}</span>
            <span>{{ isPttHolding ? t('ai.voice.ptt_release') : t('ai.voice.ptt_hold') }}</span>
          </button>

          <button
            v-if="status === 'speaking' || status === 'thinking'"
            type="button"
            class="voice-ctrl-btn interrupt"
            :aria-label="t('ai.voice.interrupt')"
            :title="t('ai.voice.interrupt')"
            @click="emit('interrupt')"
          >
            <span class="material-icons" aria-hidden="true">front_hand</span>
          </button>

          <button
            type="button"
            class="voice-ctrl-btn hangup"
            :aria-label="t('ai.voice.hangup')"
            :title="t('ai.voice.hangup')"
            @click="emit('stop')"
          >
            <span class="material-icons" aria-hidden="true">call_end</span>
          </button>
        </div>
      </footer>
    </section>

    <!-- Minimized Floating Bar docked above Composer -->
    <div
      v-else
      class="voice-mini-bar"
      role="region"
      :aria-label="t('ai.voice.mini_bar_label')"
    >
      <div class="mini-left" @click="emit('update:isMinimized', false)">
        <span class="mini-status-dot" :class="`state-${status}`" aria-hidden="true"></span>
        <div class="mini-copy">
          <span class="mini-title">{{ engineLabel }} · {{ formattedTimer }}</span>
          <span class="mini-sub">{{ miniSnippet }}</span>
        </div>
      </div>

      <div class="mini-actions">
        <button
          v-if="isNativeLive && inputMode === 'vad'"
          type="button"
          class="mini-btn"
          :class="{ muted: isMuted }"
          :aria-pressed="isMuted"
          :aria-label="isMuted ? t('ai.voice.unmute') : t('ai.voice.mute')"
          @click="emit('toggleMute')"
        >
          <span class="material-icons" aria-hidden="true">{{ isMuted ? 'mic_off' : 'mic' }}</span>
        </button>

        <button
          v-else
          type="button"
          class="mini-btn ptt"
          :class="{ holding: isPttHolding }"
          :aria-pressed="isPttHolding"
          :aria-label="t('ai.voice.ptt_hold')"
          @pointerdown="onPttPointerDown"
          @pointerup="onPttPointerUp"
          @pointercancel="onPttPointerUp"
          @pointerleave="onPttPointerUp"
        >
          <span class="material-icons" aria-hidden="true">mic</span>
        </button>

        <button
          v-if="status === 'speaking' || status === 'thinking'"
          type="button"
          class="mini-btn"
          :aria-label="t('ai.voice.interrupt')"
          @click="emit('interrupt')"
        >
          <span class="material-icons" aria-hidden="true">front_hand</span>
        </button>

        <button
          type="button"
          class="mini-btn"
          :aria-label="t('ai.voice.expand')"
          @click="emit('update:isMinimized', false)"
        >
          <span class="material-icons" aria-hidden="true">open_in_full</span>
        </button>

        <button
          type="button"
          class="mini-btn hangup"
          :aria-label="t('ai.voice.hangup')"
          @click="emit('stop')"
        >
          <span class="material-icons" aria-hidden="true">call_end</span>
        </button>
      </div>
    </div>
  </template>
</template>

<style scoped src="./AiVoiceCallOverlay.css"></style>
