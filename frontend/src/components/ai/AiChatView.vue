<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore } from '@/stores/ai'
import { useUserStore } from '@/stores/user'
import { useRecordStore } from '@/stores/records'
import { useEventStore } from '@/stores/events'
import { useNavigationStore } from '@/stores/navigation'
import { usePitScoutStore } from '@/stores/pitScout'
import type { AiSettings } from '@/types'
import AiSettingsPanel from './AiSettingsPanel.vue'
import { buildEventDataContext } from './contextBuilder'
import { renderMarkdown } from '@/utils/markdown'
import { buildTeamRegex, applyTeamChipsToHtml } from './teamMatcher'
import TeamDetailDrawer from '@/components/common/TeamDetailDrawer.vue'
import { useAiChatStream, type ChatMessage } from './useAiChatStream'

const props = defineProps<{
  eventId: string
}>()

const { t, te } = useI18n()
const aiStore = useAiStore()
const userStore = useUserStore()
const recordStore = useRecordStore()
const eventStore = useEventStore()
const navStore = useNavigationStore()
const pitScoutStore = usePitScoutStore()

const activeTab = ref<'chat' | 'settings'>('chat')
const attachDataContext = ref(true)

const activeRecordsCount = computed(() => {
  return recordStore.records.filter(r => !r.isDeleted).length
})
const trackedTeamsCount = computed(() => {
  return recordStore.rankings.length
})
const activeTagsCount = computed(() => {
  return recordStore.teamTags.length
})

const systemPrompt = ref('You are a helpful AI assistant for the ScoutingPro27 application. You help users analyze FTC scouting data.')

function loadSystemPrompt() {
  const s = aiStore.getSettingsForProvider(aiStore.activeProvider || 'OPENAI')
  if (s && s.systemPrompt) {
    systemPrompt.value = s.systemPrompt
  }
}

function onSettingsSaved(settings: Partial<AiSettings>) {
  if (settings.systemPrompt) {
    systemPrompt.value = settings.systemPrompt
  }
}

// ── 提示词设置与便捷编辑 ──
const isPromptExpanded = ref(false)

async function saveCurrentPrompt() {
  const provider = aiStore.activeProvider || 'OPENAI'
  const current = aiStore.getSettingsForProvider(provider) || {}
  const success = await aiStore.saveSettings({
    ...current,
    provider,
    systemPrompt: systemPrompt.value
  })
  if (success) {
    isPromptExpanded.value = false
  }
}

const chatHistory = ref<ChatMessage[]>([])
const chatInput = ref('')
const chatContainerRef = ref<HTMLElement | null>(null)
const keyLostError = ref(false)

let saveTimeout: number | null = null
function debouncedSaveHistory() {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = window.setTimeout(() => {
    aiStore.saveChatHistory(props.eventId, chatHistory.value)
  }, 1000)
}

function isNearBottom(): boolean {
  if (!chatContainerRef.value) return true
  const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.value
  return scrollHeight - scrollTop - clientHeight < 80
}

function scrollToBottom(force = false) {
  nextTick(() => {
    if (chatContainerRef.value && (force || isNearBottom())) {
      chatContainerRef.value.scrollTop = chatContainerRef.value.scrollHeight
    }
  })
}

const {
  isSending,
  isStreaming,
  streamingMessageId,
  stopGenerating,
  sendMessage
} = useAiChatStream({
  chatHistory,
  chatInput,
  systemPrompt,
  attachDataContext,
  keyLostError,
  getDataContext: () =>
    buildEventDataContext({
      event: eventStore.currentEvent,
      rankings: recordStore.rankings,
      records: recordStore.records,
      bannedTeams: recordStore.bannedTeams,
      tags: recordStore.teamTags,
      pitRecords: pitScoutStore.records
    }),
  getToken: () => userStore.token,
  getActiveProvider: () => aiStore.activeProvider || 'OPENAI',
  onSaveHistory: debouncedSaveHistory,
  onScrollToBottom: scrollToBottom,
  t: (key: string) => t(key)
})

// ── 用户历史提问提示词在线编辑与回滚重发 ──
const editingMessageId = ref<string | null>(null)
const editingText = ref<string>('')

function startEditMessage(msg: ChatMessage) {
  editingMessageId.value = msg.id
  editingText.value = msg.content
  nextTick(() => {
    const textarea = document.querySelector(`.edit-prompt-textarea-${msg.id}`) as HTMLTextAreaElement | null
    textarea?.focus()
  })
}

function cancelEditMessage() {
  editingMessageId.value = null
  editingText.value = ''
}

async function submitEditMessage(msgId: string) {
  const newContent = editingText.value.trim()
  if (!newContent) return

  const msgIndex = chatHistory.value.findIndex(m => m.id === msgId)
  if (msgIndex === -1) return

  chatHistory.value = chatHistory.value.slice(0, msgIndex)
  debouncedSaveHistory()

  editingMessageId.value = null
  editingText.value = ''

  chatInput.value = newContent
  await sendMessage()
}

// ── Team Chip 高亮（Phase 1）──────────────────────────────────────────────────

/** 当前赛事所有已知队伍编号字符串集合（白名单，来自 rankings，V1）*/
const knownTeams = computed<Set<string>>(() =>
  new Set(recordStore.rankings.map(r => String(r.teamNumber)))
)

/** 缓存的正则实例，仅在 knownTeams 变化时重建（V22）*/
const cachedTeamRegex = ref<RegExp | null>(null)
watch(
  knownTeams,
  (teams) => {
    cachedTeamRegex.value = buildTeamRegex(teams)
  },
  { immediate: true }
)

/** 当前打开的 Team Detail Drawer 的队伍编号（null = 关闭）*/
const drawerTeamNumber = ref<number | null>(null)

/** 消息列表区域的根 DOM 引用（用于事件委托，V5）*/
const messageAreaRef = ref<HTMLElement | null>(null)

/**
 * 事件委托：处理消息区域内所有 .team-chip 的点击（V5）。
 * 无需在每个 chip span 上单独绑定 Vue 事件监听器。
 */
function onMessageAreaClick(e: MouseEvent) {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-team]')
  if (chip?.dataset['team']) {
    drawerTeamNumber.value = Number(chip.dataset['team'])
  }
}

function renderMarkdownContent(content: string): string {
  if (!content) return ''
  try {
    const rawHtml = renderMarkdown(content)
    return applyTeamChipsToHtml(rawHtml, cachedTeamRegex.value)
  } catch (e) {
    return content
  }
}

function renderUserText(content: string): string {
  if (!content) return ''
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return applyTeamChipsToHtml(escaped, cachedTeamRegex.value)
}

onMounted(async () => {
  await aiStore.fetchSettings()
  loadSystemPrompt()
  
  const history = await aiStore.fetchChatHistory(props.eventId)
  if (history && Array.isArray(history)) {
    chatHistory.value = history
    const savedPos = navStore.getEventPosition(props.eventId)
    if (savedPos && typeof savedPos.aiChatScrollTop === 'number' && savedPos.aiChatScrollTop >= 0) {
      nextTick(() => {
        if (chatContainerRef.value) {
          chatContainerRef.value.scrollTop = savedPos.aiChatScrollTop!
        }
      })
    } else {
      scrollToBottom(true)
    }
  }
})

function deleteMessage(index: number) {
  // 如果正在编辑的消息被删除，退出编辑态
  const deletedMsg = chatHistory.value[index]
  if (deletedMsg && deletedMsg.id === editingMessageId.value) {
    cancelEditMessage()
  }
  chatHistory.value.splice(index, 1)
  debouncedSaveHistory()
}

function copyMessage(content: string) {
  navigator.clipboard.writeText(content).then(() => {
    // Copied
  }).catch(e => {
    console.error('Failed to copy', e)
  })
}

function clearChat() {
  if (confirm(t('ai.clear_confirm'))) {
    cancelEditMessage()
    chatHistory.value = []
    debouncedSaveHistory()
  }
}
</script>

<template>
  <div class="ai-chat-view">
    <div class="inner-tabs">
      <button :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">{{ $t('ai.tab_chat') }}</button>
      <button :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">{{ $t('ai.tab_settings') }}</button>
    </div>

    <Transition name="tab-fade" mode="out-in">
      <div v-if="activeTab === 'chat'" key="chat" class="chat-container">
      <!-- 顶部紧凑控制栏与提示词手风琴 -->
      <div class="chat-header" :class="{ expanded: isPromptExpanded }">
        <div class="compact-header-bar">
          <div class="compact-left">
            <button 
              class="btn-toggle-prompt" 
              @click="isPromptExpanded = !isPromptExpanded"
              :class="{ active: isPromptExpanded }"
              :title="isPromptExpanded ? $t('ai.prompt_toggle_collapse') : $t('ai.prompt_toggle_expand')"
            >
              <span class="material-icons prompt-icon">tune</span>
              <span class="prompt-title">{{ $t('ai.persona_label') }}</span>
              <span class="material-icons chevron-icon">{{ isPromptExpanded ? 'expand_less' : 'expand_more' }}</span>
            </button>

            <div class="data-badge" :class="{ empty: activeRecordsCount === 0 && activeTagsCount === 0 }">
              <span class="material-icons" style="font-size: 14px;">analytics</span>
              <span>
                {{ (activeRecordsCount > 0 || activeTagsCount > 0)
                  ? (activeTagsCount > 0
                      ? $t('ai.data_context_badge_with_tags', { teams: trackedTeamsCount, records: activeRecordsCount, tags: activeTagsCount })
                      : $t('ai.data_context_badge', { teams: trackedTeamsCount, records: activeRecordsCount }))
                  : $t('ai.data_context_empty') }}
              </span>
            </div>
          </div>

          <div class="header-actions">
            <label class="attach-toggle">
              <input type="checkbox" v-model="attachDataContext" />
              <span>{{ $t('ai.include_data_label') }}</span>
            </label>
            <button class="btn-clear" @click="clearChat" :title="$t('ai.btn_clear')">
              <span class="material-icons" style="font-size: 16px;">delete_sweep</span>
              <span>{{ $t('ai.btn_clear') }}</span>
            </button>
          </div>
        </div>

        <!-- 展开的提示词编辑面板 -->
        <transition name="accordion">
          <div v-if="isPromptExpanded" class="expanded-prompt-panel">
            <div class="prompt-textarea-wrapper">
              <textarea 
                v-model="systemPrompt" 
                rows="3" 
                :placeholder="$t('ai.persona_placeholder')"
              ></textarea>
              <div class="prompt-footer-row">
                <span class="prompt-hint">{{ $t('ai.prompt_hint') }}</span>
                <button class="btn-apply-prompt" @click="saveCurrentPrompt">
                  <span class="material-icons" style="font-size: 14px;">check</span>
                  {{ $t('ai.btn_apply_prompt') }}
                </button>
              </div>
            </div>
          </div>
        </transition>
      </div>

      <div class="chat-messages" ref="chatContainerRef">
        <div v-if="chatHistory.length === 0" class="empty-chat">
          <span class="material-icons">chat_bubble_outline</span>
          <p>{{ $t('ai.empty_chat') }}</p>
        </div>
        
        <!-- ref + 事件委托：处理消息区域内所有 .team-chip 的点击（V5）-->
        <div
          ref="messageAreaRef"
          class="messages-list"
          @click.capture="onMessageAreaClick"
        >
          <div 
            v-for="(msg, index) in chatHistory" 
            :key="msg.id"
            class="message-wrapper"
            :class="[msg.role, { streaming: isStreaming && msg.id === streamingMessageId, editing: editingMessageId === msg.id }]"
          >
            <div class="message-bubble">
              <div class="message-content">
                <span v-if="!msg.content && isStreaming && msg.id === streamingMessageId" class="typing-indicator">
                  <span></span><span></span><span></span>
                </span>
                <div v-else-if="msg.role === 'assistant'" class="markdown-body" v-html="renderMarkdownContent(msg.content)"></div>
                <template v-else>
                  <!-- 正常展示态：带队伍编号高亮 -->
                  <div v-if="editingMessageId !== msg.id" class="user-text" v-html="renderUserText(msg.content)"></div>
                  <!-- 修改提示词编辑态 -->
                  <div v-else class="inline-prompt-editor">
                    <textarea 
                      v-model="editingText" 
                      :class="`edit-prompt-textarea-${msg.id}`"
                      rows="2"
                      @keydown.enter.exact.prevent="submitEditMessage(msg.id)"
                      @keydown.esc="cancelEditMessage"
                    ></textarea>
                    <div class="inline-editor-actions">
                      <button class="btn-editor-cancel" @click="cancelEditMessage">{{ $t('ai.btn_cancel_edit') }}</button>
                      <button class="btn-editor-submit" :disabled="!editingText.trim()" @click="submitEditMessage(msg.id)">
                        <span class="material-icons" style="font-size: 14px;">send</span>
                        {{ $t('ai.btn_submit_edit') }}
                      </button>
                    </div>
                  </div>
                </template>
                <span v-if="isStreaming && msg.id === streamingMessageId && msg.content" class="typing-cursor"></span>
              </div>
              <div v-if="!(isStreaming && msg.id === streamingMessageId) && editingMessageId !== msg.id" class="message-actions">
                <button v-if="msg.role === 'user'" @click="startEditMessage(msg)" :title="$t('ai.btn_edit_prompt')">
                  <span class="material-icons">edit</span>
                </button>
                <button @click="copyMessage(msg.content)" :title="$t('ai.btn_copy')">
                  <span class="material-icons">content_copy</span>
                </button>
                <button @click="deleteMessage(index)" :title="$t('ai.btn_delete')">
                  <span class="material-icons">delete</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Team Detail Drawer（Phase 1, V6/V8/V24）-->
      <TeamDetailDrawer
        :team-number="drawerTeamNumber"
        :event-id="props.eventId"
        @close="drawerTeamNumber = null"
      />

      <div class="chat-input-area">
        <textarea 
          v-model="chatInput" 
          :placeholder="$t('ai.input_placeholder')"
          @keydown.enter.exact.prevent="sendMessage"
          rows="2"
        ></textarea>
        <div class="input-buttons">
          <button 
            v-if="isSending" 
            class="btn-stop" 
            @click="stopGenerating" 
            :title="$t('ai.btn_stop')"
          >
            <span class="material-icons">stop_circle</span>
            <span>{{ $t('ai.btn_stop') }}</span>
          </button>
          <button 
            v-else 
            class="btn-send" 
            @click="sendMessage" 
            :disabled="!chatInput.trim()"
            :title="$t('ai.btn_send')"
          >
            <span class="material-icons">send</span>
          </button>
        </div>
      </div>
      </div>
      <AiSettingsPanel
        v-else-if="activeTab === 'settings'"
        key="settings"
        v-model:systemPrompt="systemPrompt"
        @saved="onSettingsSaved"
      />
    </Transition>
  </div>
</template>

<style scoped src="./AiChatView.css"></style>
<style scoped src="./AiChatMessages.css"></style>
