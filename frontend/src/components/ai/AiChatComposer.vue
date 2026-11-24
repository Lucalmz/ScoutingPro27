<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { SLASH_COMMANDS, type SlashCommandItem } from '@/components/ai/personas'

export interface KnownTeamOption {
  teamNumber: number
  name?: string
}

const props = defineProps<{
  modelValue: string
  isStreaming: boolean
  disabled?: boolean
  knownTeams: KnownTeamOption[]
  activeProfileLabel?: string
  voiceSupported?: boolean
  voiceActive?: boolean
  voiceTooltip?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [val: string]
  send: [text: string]
  stop: []
  addFocusTeam: [teamNumber: number]
  startVoice: []
}>()

const { t, locale } = useI18n()
const isZh = computed(() => (locale.value || 'zh').toLowerCase().startsWith('zh'))

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const isComposing = ref(false)
const activeSuggestionIndex = ref(0)

function resizeTextarea() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  const maxHeight = 148
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
}

watch(
  () => props.modelValue,
  () => nextTick(resizeTextarea),
  { immediate: true }
)

// Detect `@team` autocomplete at tail or `/` slash command at start
const atMatch = computed(() => {
  const val = props.modelValue
  const m = val.match(/(?:^|\s)@(\d{0,6})$/)
  return m ? m[1] || '' : null
})

const slashMatch = computed(() => {
  const val = props.modelValue
  if (!val.startsWith('/') || val.includes(' ') || val.includes('\n')) return null
  return val.toLowerCase()
})

const teamSuggestions = computed(() => {
  if (atMatch.value === null) return []
  const q = atMatch.value
  const list = props.knownTeams.filter(tm =>
    !q ? true : String(tm.teamNumber).startsWith(q) || (tm.name || '').toLowerCase().includes(q.toLowerCase())
  )
  return list.slice(0, 8)
})

const slashSuggestions = computed<SlashCommandItem[]>(() => {
  if (slashMatch.value === null) return []
  return SLASH_COMMANDS.filter(cmd => cmd.command.startsWith(slashMatch.value!))
})

const showingPopover = computed<'at' | 'slash' | null>(() => {
  if (teamSuggestions.value.length > 0 && atMatch.value !== null) return 'at'
  if (slashSuggestions.value.length > 0 && slashMatch.value !== null) return 'slash'
  return null
})

watch(showingPopover, () => {
  activeSuggestionIndex.value = 0
})

function pickTeamSuggestion(opt: KnownTeamOption) {
  const replaced = props.modelValue.replace(/@(\d{0,6})$/, `#${opt.teamNumber} `)
  emit('update:modelValue', replaced)
  emit('addFocusTeam', opt.teamNumber)
  nextTick(() => {
    textareaRef.value?.focus()
    resizeTextarea()
  })
}

function pickSlashSuggestion(cmd: SlashCommandItem) {
  const text = isZh.value ? cmd.templateZh : cmd.templateEn
  emit('update:modelValue', text)
  nextTick(() => {
    textareaRef.value?.focus()
    resizeTextarea()
  })
}

function handleKeydown(e: KeyboardEvent) {
  if (isComposing.value) return

  if (showingPopover.value === 'at') {
    const len = teamSuggestions.value.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      activeSuggestionIndex.value = (activeSuggestionIndex.value + 1) % len
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      activeSuggestionIndex.value = (activeSuggestionIndex.value - 1 + len) % len
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const hit = teamSuggestions.value[activeSuggestionIndex.value]
      if (hit) pickTeamSuggestion(hit)
      return
    }
  } else if (showingPopover.value === 'slash') {
    const len = slashSuggestions.value.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      activeSuggestionIndex.value = (activeSuggestionIndex.value + 1) % len
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      activeSuggestionIndex.value = (activeSuggestionIndex.value - 1 + len) % len
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const hit = slashSuggestions.value[activeSuggestionIndex.value]
      if (hit) pickSlashSuggestion(hit)
      return
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (!props.isStreaming && props.modelValue.trim()) {
      emit('send', props.modelValue)
    }
  }
}

function handleSendClick() {
  if (props.isStreaming) {
    emit('stop')
    return
  }
  if (props.modelValue.trim()) {
    emit('send', props.modelValue)
  }
}
</script>

<template>
  <div class="composer-wrap">
    <!-- @ Team Autocomplete Popover -->
    <div v-if="showingPopover === 'at'" class="composer-popover">
      <div class="popover-caption">{{ t('ai.composer_at_hint') }}</div>
      <button
        v-for="(tm, idx) in teamSuggestions"
        :key="tm.teamNumber"
        type="button"
        class="popover-item"
        :class="{ active: idx === activeSuggestionIndex }"
        @mousedown.prevent="pickTeamSuggestion(tm)"
      >
        <span class="pop-team-num">#{{ tm.teamNumber }}</span>
        <span class="pop-team-name">{{ tm.name || '' }}</span>
      </button>
    </div>

    <!-- / Slash Command Popover -->
    <div v-else-if="showingPopover === 'slash'" class="composer-popover">
      <div class="popover-caption">{{ t('ai.composer_slash_hint') }}</div>
      <button
        v-for="(cmd, idx) in slashSuggestions"
        :key="cmd.command"
        type="button"
        class="popover-item"
        :class="{ active: idx === activeSuggestionIndex }"
        @mousedown.prevent="pickSlashSuggestion(cmd)"
      >
        <code class="pop-cmd">{{ cmd.command }}</code>
        <span class="pop-cmd-label">{{ isZh ? cmd.labelZh : cmd.labelEn }}</span>
        <span class="pop-cmd-desc">{{ isZh ? cmd.descZh : cmd.descEn }}</span>
      </button>
    </div>

    <div class="composer-box">
      <textarea
        ref="textareaRef"
        :value="modelValue"
        rows="1"
        :disabled="disabled"
        :placeholder="t('ai.input_placeholder_v2')"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value); resizeTextarea()"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
        @keydown="handleKeydown"
      ></textarea>

      <div class="composer-bottom">
        <span class="composer-hints">
          <template v-if="activeProfileLabel">{{ activeProfileLabel }} · </template>
          {{ t('ai.composer_shortcut_hint') }}
        </span>

        <div class="composer-actions">
          <button
            v-if="voiceSupported !== false"
            type="button"
            class="btn-voice-launch"
            :class="{ active: voiceActive }"
            :disabled="disabled"
            :aria-label="voiceTooltip || t('ai.voice.btn_start')"
            :title="voiceTooltip || t('ai.voice.btn_start')"
            @click="emit('startVoice')"
          >
            <span class="material-icons" aria-hidden="true">graphic_eq</span>
            <span>{{ voiceActive ? t('ai.voice.btn_live_active') : t('ai.voice.btn_short') }}</span>
          </button>

          <button
            type="button"
            class="btn-send-stop"
            :class="{ stop: isStreaming }"
            :disabled="!isStreaming && (!modelValue.trim() || disabled)"
            @click="handleSendClick"
            :title="isStreaming ? t('ai.btn_stop') : t('ai.btn_send')"
          >
            <span class="material-icons">{{ isStreaming ? 'stop_circle' : 'arrow_upward' }}</span>
            <span>{{ isStreaming ? t('ai.btn_stop') : t('ai.btn_send') }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer-wrap {
  position: relative;
  padding: 8px 12px max(10px, var(--sab, env(safe-area-inset-bottom, 0px)));
  border-top: 1px solid var(--border);
  background: var(--popover);
  flex-shrink: 0;
}

.composer-popover {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% + 4px);
  max-height: 220px;
  overflow-y: auto;
  background: var(--popover);
  border: 1px solid var(--status-ai-border);
  border-radius: 10px;
  box-shadow: var(--shadow-2);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 40;
}

.popover-caption {
  font-size: 10.5px;
  color: var(--muted-foreground);
  padding: 2px 6px 4px;
}

.popover-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--foreground);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.popover-item:hover,
.popover-item.active {
  background: var(--status-ai-bg);
}

.pop-team-num {
  font-family: var(--font-numeric);
  font-weight: 700;
  color: var(--status-ai);
}

.pop-team-name {
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pop-cmd {
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--primary);
}

.pop-cmd-label {
  font-weight: 600;
}

.pop-cmd-desc {
  color: var(--muted-foreground);
  font-size: 11px;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--input);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 8px 10px;
  transition: border-color 0.15s ease;
}

.composer-box:focus-within {
  border-color: var(--status-ai);
}

.composer-box textarea {
  width: 100%;
  box-sizing: border-box;
  border: none;
  background: transparent;
  color: var(--foreground);
  font-size: 13.5px;
  line-height: 1.45;
  font-family: inherit;
  resize: none;
  outline: none;
  min-height: 22px;
  max-height: 148px;
}

.composer-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.composer-hints {
  font-size: 11px;
  color: var(--muted-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.composer-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.btn-voice-launch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--status-ai-bg);
  color: var(--status-ai);
  border: 1px solid var(--status-ai-border);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.btn-voice-launch:hover:not(:disabled),
.btn-voice-launch.active {
  border-color: var(--status-ai);
  background: color-mix(in srgb, var(--status-ai) 22%, var(--surface-elevated));
}

.btn-voice-launch:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn-voice-launch .material-icons {
  font-size: 16px;
}

.btn-send-stop {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: 8px;
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
}

.btn-send-stop.stop {
  background: var(--status-error);
  color: var(--destructive-foreground);
}

.btn-send-stop:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn-send-stop .material-icons {
  font-size: 16px;
}
</style>
