<script setup lang="ts">
import { computed, ref, watch, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToastStore } from '@/stores/toast'
import type { AiChatMessage } from '@/types'
import { renderMarkdown } from '@/utils/markdown'
import { applyTeamChipsToHtml } from '@/components/ai/teamMatcher'

const props = defineProps<{
  message: AiChatMessage
  isStreaming: boolean
  isLatestAssistant: boolean
  knownTeamRegex: RegExp | null
  followUpSuggestions?: Array<{ label: string; prompt: string }>
}>()

const emit = defineEmits<{
  teamClick: [teamNumber: number]
  teamHover: [payload: { teamNumber: number; anchorRect: DOMRect }]
  teamLeave: []
  regenerate: [messageId: string]
  editResend: [payload: { messageId: string; newContent: string }]
  deleteMessage: [messageId: string]
  sendFollowUp: [prompt: string]
}>()

const { t } = useI18n()
const toastStore = useToastStore()

// Thinking panel toggle + live elapsed timer while reasoning streams
const hasAutoCollapsed = ref(false)
const thinkingExpanded = ref(props.isStreaming && !props.message.content)
const thinkingElapsedMs = ref(0)
let thinkingTimer: ReturnType<typeof setInterval> | null = null
let thinkingStartMs: number | null = null

watch(
  () => [props.isStreaming, props.message.reasoning, props.message.content] as const,
  ([streaming, reasoning, content]) => {
    if (streaming && reasoning && !content) {
      if (!thinkingStartMs) thinkingStartMs = Date.now()
      if (!thinkingExpanded.value && !hasAutoCollapsed.value) {
        thinkingExpanded.value = true
      }
      if (!thinkingTimer) {
        thinkingTimer = setInterval(() => {
          if (thinkingStartMs) {
            thinkingElapsedMs.value = Date.now() - thinkingStartMs
          }
        }, 200)
      }
    } else {
      if (thinkingTimer) {
        clearInterval(thinkingTimer)
        thinkingTimer = null
      }
      if (content && thinkingExpanded.value && !hasAutoCollapsed.value) {
        thinkingExpanded.value = false
        hasAutoCollapsed.value = true
      }
      if (!streaming && !hasAutoCollapsed.value && reasoning) {
        thinkingExpanded.value = false
        hasAutoCollapsed.value = true
      }
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  if (thinkingTimer) clearInterval(thinkingTimer)
})

const displayThinkingSec = computed(() => {
  const ms = props.message.reasoningDurationMs ?? thinkingElapsedMs.value
  return (Math.max(100, ms) / 1000).toFixed(1)
})

const isReasoningPhase = computed(
  () => props.isStreaming && Boolean(props.message.reasoning) && !props.message.content
)

// Render HTML safely: skip heavy team-chip regex overlay while streaming (V4), apply as soon as idle
const renderedAssistantHtml = computed(() => {
  const content = props.message.content || ''
  if (!content) return ''
  try {
    const html = renderMarkdown(content, { copyLabel: t('ai.btn_copy_code') })
    return props.isStreaming ? html : applyTeamChipsToHtml(html, props.knownTeamRegex)
  } catch {
    return content
  }
})

const renderedUserHtml = computed(() => {
  const content = props.message.content || ''
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return applyTeamChipsToHtml(escaped, props.knownTeamRegex)
})

// Copy message state
const copied = ref(false)
async function copyWholeMessage() {
  try {
    await navigator.clipboard.writeText(props.message.content || '')
    copied.value = true
    toastStore.showToast(t('ai.msg_copied'), 'success')
    setTimeout(() => {
      copied.value = false
    }, 1800)
  } catch (e) {
    console.error('Copy failed', e)
  }
}

// Inline edit state
const isEditing = ref(false)
const editText = ref('')
const editTextareaRef = ref<HTMLTextAreaElement | null>(null)

function startEditing() {
  isEditing.value = true
  editText.value = props.message.content
  nextTick(() => editTextareaRef.value?.focus())
}

function cancelEditing() {
  isEditing.value = false
  editText.value = ''
}

function submitEdit() {
  const clean = editText.value.trim()
  if (!clean) return
  isEditing.value = false
  emit('editResend', { messageId: props.message.id, newContent: clean })
}

// Event delegation on message body: team chips & fenced code copy buttons
function onBubbleClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (!target) return

  const copyBtn = target.closest<HTMLButtonElement>('[data-code-copy]')
  if (copyBtn) {
    const block = copyBtn.closest('.md-code-block')
    const codeText = block?.querySelector('pre code')?.textContent || ''
    navigator.clipboard.writeText(codeText).then(() => {
      const orig = copyBtn.textContent || t('ai.btn_copy_code')
      copyBtn.textContent = t('ai.code_copied_short')
      toastStore.showToast(t('ai.code_copied'), 'success')
      setTimeout(() => {
        copyBtn.textContent = orig
      }, 1500)
    }).catch(() => {})
    return
  }

  const chip = target.closest<HTMLElement>('[data-team]')
  if (chip?.dataset['team']) {
    emit('teamClick', Number(chip.dataset['team']))
  }
}

function onBubbleKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const target = e.target as HTMLElement | null
  const chip = target?.closest<HTMLElement>('[data-team]')
  if (chip?.dataset['team']) {
    e.preventDefault()
    emit('teamClick', Number(chip.dataset['team']))
  }
}

function onBubbleMouseOver(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  const chip = target?.closest<HTMLElement>('[data-team]')
  if (chip?.dataset['team']) {
    emit('teamHover', {
      teamNumber: Number(chip.dataset['team']),
      anchorRect: chip.getBoundingClientRect()
    })
  }
}

function onBubbleMouseOut(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (target?.closest('[data-team]')) {
    emit('teamLeave')
  }
}

const durationText = computed(() => {
  if (!props.message.durationMs) return ''
  return `${(props.message.durationMs / 1000).toFixed(1)}s`
})
</script>

<template>
  <article
    class="copilot-message"
    :class="message.role === 'user' ? 'is-user' : 'is-assistant'"
  >
    <!-- Role & Model Meta Header -->
    <div class="msg-role-bar">
      <span class="msg-role-dot"></span>
      <span class="msg-role-label">
        {{ message.role === 'user' ? t('ai.role_you') : (message.profileName || t('ai.role_copilot')) }}
      </span>
      <span v-if="message.role === 'assistant' && message.modelName" class="msg-model-pill">
        {{ message.modelName }}
      </span>
      <span v-if="message.contextSummary && message.role === 'assistant'" class="msg-ctx-pill">
        · {{ message.contextSummary }}
      </span>
    </div>

    <!-- Main Bubble -->
    <div
      class="msg-bubble"
      @click="onBubbleClick"
      @keydown="onBubbleKeydown"
      @mouseover="onBubbleMouseOver"
      @mouseout="onBubbleMouseOut"
    >
      <!-- Inline Edit Mode (User) -->
      <div v-if="isEditing" class="inline-edit-box">
        <textarea
          ref="editTextareaRef"
          v-model="editText"
          class="inline-edit-textarea"
          rows="3"
          @keydown.ctrl.enter.prevent="submitEdit"
          @keydown.meta.enter.prevent="submitEdit"
          @keydown.esc="cancelEditing"
        ></textarea>
        <div class="inline-edit-actions">
          <button type="button" class="btn-edit-cancel" @click="cancelEditing">{{ t('ai.btn_cancel_edit') }}</button>
          <button type="button" class="btn-edit-resend" @click="submitEdit">{{ t('ai.btn_submit_edit') }}</button>
        </div>
      </div>

      <!-- User Message -->
      <div v-else-if="message.role === 'user'" class="user-text" v-html="renderedUserHtml"></div>

      <!-- Assistant Message -->
      <template v-else>
        <!-- Deep Thinking Accordion -->
        <div v-if="message.reasoning" class="thinking-accordion">
          <button
            type="button"
            class="thinking-toggle"
            :aria-expanded="thinkingExpanded"
            @click="thinkingExpanded = !thinkingExpanded"
          >
            <span v-if="isReasoningPhase" class="thinking-pulse"></span>
            <span class="material-icons" style="font-size: 14px;">psychology</span>
            <span>
              {{
                isReasoningPhase
                  ? t('ai.thinking_live', { sec: displayThinkingSec })
                  : t('ai.thinking_done', { sec: displayThinkingSec })
              }}
            </span>
            <span class="material-icons thinking-chevron">
              {{ thinkingExpanded ? 'expand_less' : 'expand_more' }}
            </span>
          </button>
          <div v-if="thinkingExpanded" class="thinking-body">{{ message.reasoning }}</div>
        </div>

        <!-- Waiting indicator before first token -->
        <div v-if="isStreaming && !message.content && !message.reasoning" class="thinking-toggle" style="padding: 2px 0;">
          <span class="thinking-pulse"></span>
          <span>{{ t('ai.generating') }}</span>
        </div>

        <!-- Rendered Markdown Answer -->
        <div v-if="message.content" class="markdown-body" v-html="renderedAssistantHtml"></div>
        <span v-if="isStreaming && message.content" class="streaming-caret" aria-hidden="true"></span>

        <div v-if="message.stopped" class="msg-stopped-note">{{ t('ai.stopped_by_user') }}</div>

        <div v-if="message.error" class="msg-error-banner">
          <span class="material-icons" style="font-size: 15px;">error_outline</span>
          <span>{{ message.error }}</span>
        </div>
      </template>
    </div>

    <!-- Bottom Action Bar & Usage Stats -->
    <div v-if="!isEditing" class="msg-footer-bar">
      <div v-if="message.role === 'assistant' && !isStreaming" class="msg-meta-stats">
        <span v-if="durationText">{{ durationText }}</span>
        <span
          v-if="message.usage && (message.usage.totalTokens || message.usage.promptTokens)"
          :title="message.usage.thoughtsTokens ? t('ai.usage_thinking_tokens', { tokens: message.usage.thoughtsTokens }) : undefined"
        >
          {{ t('ai.usage_io', { in: message.usage.promptTokens || 0, out: message.usage.completionTokens || 0 }) }}
        </span>
      </div>

      <div v-if="!isStreaming" class="msg-actions-row">
        <button
          v-if="message.role === 'user'"
          type="button"
          class="btn-msg-act"
          :title="t('ai.btn_edit_prompt')"
          @click="startEditing"
        >
          <span class="material-icons">edit</span>
        </button>
        <button
          v-if="message.content"
          type="button"
          class="btn-msg-act"
          :class="{ copied }"
          :title="t('ai.btn_copy')"
          @click="copyWholeMessage"
        >
          <span class="material-icons">{{ copied ? 'check' : 'content_copy' }}</span>
        </button>
        <button
          v-if="message.role === 'assistant'"
          type="button"
          class="btn-msg-act"
          :title="t('ai.btn_regenerate')"
          @click="emit('regenerate', message.id)"
        >
          <span class="material-icons">refresh</span>
        </button>
        <button
          type="button"
          class="btn-msg-act"
          :title="t('ai.btn_delete')"
          @click="emit('deleteMessage', message.id)"
        >
          <span class="material-icons">delete_outline</span>
        </button>
      </div>
    </div>

    <!-- Instant Contextual Follow-Up Chips -->
    <div
      v-if="isLatestAssistant && !isStreaming && followUpSuggestions && followUpSuggestions.length > 0"
      class="followup-chips"
    >
      <button
        v-for="s in followUpSuggestions"
        :key="s.label"
        type="button"
        class="followup-chip"
        @click="emit('sendFollowUp', s.prompt)"
      >
        <span class="material-icons">subdirectory_arrow_right</span>
        <span>{{ s.label }}</span>
      </button>
    </div>
  </article>
</template>

<style scoped src="./AiMessageItem.css"></style>
