<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore } from '@/stores/ai'
import { useUserStore } from '@/stores/user'
import { useRecordStore } from '@/stores/records'
import { useEventStore } from '@/stores/events'
import type { AiSettings } from '@/types'
import { OPENAI_PRESETS, DEFAULT_PRESET, findPresetByBaseUrl, getPresetById } from './presets'
import { buildEventDataContext } from './contextBuilder'
import { renderMarkdown } from '@/utils/markdown'
import { buildTeamRegex, applyTeamChipsToHtml } from './teamMatcher'
import TeamDetailDrawer from '@/components/common/TeamDetailDrawer.vue'

const props = defineProps<{
  eventId: string
}>()

const { t, te } = useI18n()
const aiStore = useAiStore()
const userStore = useUserStore()
const recordStore = useRecordStore()
const eventStore = useEventStore()

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

const GEMINI_API_KEY_URL = 'https://aistudio.google.com/app/apikey'

const provider = ref<'OPENAI' | 'GEMINI'>('OPENAI')
const selectedPresetId = ref('deepseek')
const currentPreset = computed(() => getPresetById(selectedPresetId.value))
const currentPresetDesc = computed(() => {
  const key = 'ai.presets.' + currentPreset.value.id + '_desc'
  return te(key) ? t(key) : (currentPreset.value.description || '')
})
const apiKeyConsoleUrl = computed(() => {
  if (provider.value === 'GEMINI') {
    return GEMINI_API_KEY_URL
  }
  return currentPreset.value.apiKeyUrl || ''
})

const apiKey = ref('')
const modelName = ref('')
const baseUrl = ref('')
const proxyHost = ref('127.0.0.1')
const proxyPort = ref<number | string | null>(null)
const systemPrompt = ref('You are a helpful AI assistant for the ScoutingPro27 application. You help users analyze FTC scouting data.')

const isSaving = ref(false)
const isTesting = ref(false)
const testResult = ref<{success: boolean, statusCode?: number, latencyMs?: number, message?: string, error?: string} | null>(null)

// ── 提示词设置与便捷编辑 ──
const isPromptExpanded = ref(false)

async function saveCurrentPrompt() {
  await aiStore.saveSettings({
    provider: provider.value,
    apiKeyEncrypted: apiKey.value,
    modelName: modelName.value,
    baseUrl: baseUrl.value,
    proxyHost: proxyHost.value,
    proxyPort: proxyPort.value === '' || proxyPort.value == null ? null : Number(proxyPort.value),
    systemPrompt: systemPrompt.value
  })
}

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

  // 找到当前要修改的消息位置
  const msgIndex = chatHistory.value.findIndex(m => m.id === msgId)
  if (msgIndex === -1) return

  // 自动把上一轮提问及其之后的所有上下文全部删掉（干净回滚到修改节点）
  chatHistory.value = chatHistory.value.slice(0, msgIndex)
  debouncedSaveHistory()

  // 退出编辑态
  editingMessageId.value = null
  editingText.value = ''

  // 把修改后的新提示词作为输入发送
  chatInput.value = newContent
  await sendMessage()
}

// Chat state
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}
const chatHistory = ref<ChatMessage[]>([])
const chatInput = ref('')
const isSending = ref(false)
const isStreaming = ref(false)
const streamingMessageId = ref<string | null>(null)
const currentAbortController = ref<AbortController | null>(null)
const chatContainerRef = ref<HTMLElement | null>(null)
const keyLostError = ref(false)

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
    // cachedTeamRegex 变化后，Vue 响应式会自动触发
    // renderMarkdownContent / renderUserText 重新执行，
    // 无需额外 DOM 遍历（V28：字符串层替换取代 DOM 层后处理）
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

function onPresetChange() {
  const preset = currentPreset.value
  if (preset.id !== 'custom') {
    baseUrl.value = preset.baseUrl
    const isModelEmptyOrPresetDefault = !modelName.value || OPENAI_PRESETS.some(p => p.defaultModel === modelName.value)
    if (isModelEmptyOrPresetDefault && preset.defaultModel) {
      modelName.value = preset.defaultModel
    }
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

// Load settings into form when provider changes or initial load
function loadFormForProvider() {
  keyLostError.value = false
  const s = aiStore.getSettingsForProvider(provider.value)
  if (s) {
    if (s.apiKeyEncrypted === 'ERR_KEY_LOST') {
      keyLostError.value = true
      apiKey.value = ''
    } else {
      apiKey.value = s.apiKeyEncrypted // this is the masked key or real key
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
    systemPrompt.value = s.systemPrompt || 'You are a helpful AI assistant for the ScoutingPro27 application. You help users analyze FTC scouting data.'
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
    systemPrompt.value = 'You are a helpful AI assistant for the ScoutingPro27 application. You help users analyze FTC scouting data.'
  }
}

watch(provider, () => {
  aiStore.activeProvider = provider.value
  loadFormForProvider()
})

onMounted(async () => {
  await aiStore.fetchSettings()
  loadFormForProvider()
  
  // Load chat history
  const history = await aiStore.fetchChatHistory(props.eventId)
  if (history && Array.isArray(history)) {
    chatHistory.value = history
    scrollToBottom(true)
  }
})

let saveTimeout: number | null = null
function debouncedSaveHistory() {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = window.setTimeout(() => {
    aiStore.saveChatHistory(props.eventId, chatHistory.value)
  }, 1000)
}

async function saveSettings() {
  isSaving.value = true
  const success = await aiStore.saveSettings({
    provider: provider.value,
    apiKeyEncrypted: apiKey.value,
    modelName: modelName.value,
    baseUrl: baseUrl.value,
    proxyHost: proxyHost.value,
    proxyPort: proxyPort.value === '' || proxyPort.value == null ? null : Number(proxyPort.value),
    systemPrompt: systemPrompt.value
  })
  isSaving.value = false
  if (success) {
    alert(t('ai.save_success'))
    loadFormForProvider() // refresh the mask
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

// Chat functions
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

function stopGenerating() {
  if (currentAbortController.value) {
    currentAbortController.value.abort()
    currentAbortController.value = null
  }
  isSending.value = false
  isStreaming.value = false
  streamingMessageId.value = null
  debouncedSaveHistory()
}

async function sendMessage() {
  if (!chatInput.value.trim() || isSending.value) return
  if (keyLostError.value) {
    alert(t('ai.key_lost_alert'))
    return
  }
  
  const content = chatInput.value.trim()
  chatInput.value = ''
  
  const userMessage: ChatMessage = {
    id: 'user_' + Date.now().toString(),
    role: 'user',
    content
  }
  chatHistory.value.push(userMessage)

  // Create empty placeholder assistant message for streaming
  const assistantMessageId = 'assistant_' + Date.now().toString()
  const assistantMessage: ChatMessage = {
    id: assistantMessageId,
    role: 'assistant',
    content: ''
  }
  chatHistory.value.push(assistantMessage)
  streamingMessageId.value = assistantMessageId
  isSending.value = true
  isStreaming.value = true
  scrollToBottom(true)
  debouncedSaveHistory()
  
  // Format payload without current streaming assistant placeholder
  const messagesPayload = chatHistory.value
    .filter(m => m.id !== assistantMessageId)
    .map(m => ({
      role: m.role,
      content: m.content
    }))

  let effectiveSystemPrompt = systemPrompt.value.trim()
  if (attachDataContext.value) {
    const dataContext = buildEventDataContext({
      event: eventStore.currentEvent,
      rankings: recordStore.rankings,
      records: recordStore.records,
      bannedTeams: recordStore.bannedTeams,
      tags: recordStore.teamTags
    })
    effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${dataContext}`
  }

  const abortController = new AbortController()
  currentAbortController.value = abortController

  try {
    const res = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userStore.token}`,
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        provider: provider.value,
        systemPrompt: effectiveSystemPrompt,
        messages: messagesPayload
      }),
      signal: abortController.signal
    })
    
    const contentType = res.headers.get('content-type') || ''
    if (!res.ok || !contentType.includes('text/event-stream')) {
      let errMsg = 'Failed to get AI response'
      try {
        const errJson = await res.json()
        errMsg = errJson.error || errJson.message || JSON.stringify(errJson)
      } catch {
        errMsg = (await res.text()) || ('HTTP ' + res.status)
      }
      
      // Rollback both messages on pre-flight non-SSE failure
      const asstIdx = chatHistory.value.indexOf(assistantMessage)
      if (asstIdx !== -1) chatHistory.value.splice(asstIdx, 1)
      const userIdx = chatHistory.value.indexOf(userMessage)
      if (userIdx !== -1) chatHistory.value.splice(userIdx, 1)
      debouncedSaveHistory()
      
      chatInput.value = content // restore input for easy retry
      alert(t('ai.error_prefix') + errMsg)
      return
    }

    if (!res.body) {
      throw new Error('ReadableStream not supported on this response')
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let lineBuffer = ''

    const getAssistantMessage = () => chatHistory.value.find(m => m.id === assistantMessageId)

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        // Flush any remaining decoder buffer
        const tail = decoder.decode()
        if (tail) lineBuffer += tail
        break
      }

      // Stream decode chunk with { stream: true } to prevent multi-byte UTF-8 split corruption
      lineBuffer += decoder.decode(value, { stream: true })

      const lines = lineBuffer.split('\n')
      // The last line may be incomplete, save it back to lineBuffer
      lineBuffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) {
          // Heartbeat comment or blank line -> ignore
          continue
        }
        if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.substring(5).trim()
          if (dataStr === '[DONE]') {
            break
          }
          try {
            const parsed = JSON.parse(dataStr)
            const target = getAssistantMessage()
            if (parsed.error) {
              if (target) {
                target.content += (target.content ? '\n\n' : '') + `[${t('ai.error_prefix')}${parsed.error}]`
              }
            } else if (parsed.text) {
              if (target) {
                target.content += parsed.text
                scrollToBottom()
              }
            }
          } catch (e) {
            // Ignore malformed JSON event
          }
        }
      }
    }

    // If leftover buffer has DONE or data
    if (lineBuffer.trim().startsWith('data:')) {
      const dataStr = lineBuffer.trim().substring(5).trim()
      if (dataStr !== '[DONE]') {
        try {
          const parsed = JSON.parse(dataStr)
          const target = getAssistantMessage()
          if (parsed.text && target) target.content += parsed.text
        } catch (e) {}
      }
    }

    const finalTarget = getAssistantMessage()
    if (finalTarget && !finalTarget.content.trim()) {
      finalTarget.content = '[No Content Returned]'
    }
    debouncedSaveHistory()
  } catch (e: any) {
    const target = chatHistory.value.find(m => m.id === assistantMessageId)
    if (e.name === 'AbortError') {
      // User aborted generation
      if (target && !target.content.trim()) {
        target.content = t('ai.stopped_by_user')
      }
      debouncedSaveHistory()
    } else {
      // Network or stream error
      if (!target || !target.content) {
        // Rollback both if nothing was produced
        const asstIdx = chatHistory.value.findIndex(m => m.id === assistantMessageId)
        if (asstIdx !== -1) chatHistory.value.splice(asstIdx, 1)
        const userIdx = chatHistory.value.findIndex(m => m.id === userMessage.id)
        if (userIdx !== -1) chatHistory.value.splice(userIdx, 1)
        debouncedSaveHistory()
        chatInput.value = content
        alert(t('ai.network_error_prefix') + e.message)
      } else {
        target.content += `\n\n[${t('ai.network_error_prefix')}${e.message}]`
        debouncedSaveHistory()
      }
    }
  } finally {
    isSending.value = false
    isStreaming.value = false
    streamingMessageId.value = null
    currentAbortController.value = null
    scrollToBottom(true)
  }
}

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

    <div v-if="activeTab === 'chat'" class="chat-container">
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

    <div v-if="activeTab === 'settings'" class="settings-panel">
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
          <textarea v-model="systemPrompt" rows="4" :disabled="isSaving || isTesting"></textarea>
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
  </div>
</template>

<style scoped>
/* Chat Styles */
.ai-chat-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 1100px;
  width: 100%;
  margin: 0 auto;
  height: calc(100vh - 145px);
  min-height: 480px;
}

.inner-tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
  flex-shrink: 0;
}

.inner-tabs button {
  padding: 6px 14px;
  background: transparent;
  border: none;
  font-weight: 600;
  font-size: 13px;
  color: var(--muted-foreground);
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.2s;
}

.inner-tabs button.active {
  background: var(--primary);
  color: var(--primary-foreground);
}

.inner-tabs button:hover:not(.active) {
  background: var(--card);
  color: var(--foreground);
}

.chat-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}

/* Header & Collapsible Prompt Bar */
.chat-header {
  background: var(--popover);
  border-bottom: 1px solid var(--border);
  padding: 8px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: all 0.25s ease-in-out;
  flex-shrink: 0;
}

.compact-header-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.compact-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.btn-toggle-prompt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease-in-out;
}

.btn-toggle-prompt:hover,
.btn-toggle-prompt.active {
  background: rgba(57, 255, 20, 0.12);
  border-color: rgba(57, 255, 20, 0.35);
  color: var(--primary);
}

.btn-toggle-prompt .prompt-icon {
  font-size: 16px;
  color: var(--primary);
}

.btn-toggle-prompt .chevron-icon {
  font-size: 16px;
  transition: transform 0.2s;
}

.data-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(57, 255, 20, 0.08);
  color: var(--primary);
  border: 1px solid rgba(57, 255, 20, 0.25);
  border-radius: 12px;
  padding: 3px 10px;
  font-size: 11.5px;
  font-weight: 500;
}

.data-badge.empty {
  background: rgba(163, 163, 163, 0.1);
  color: var(--muted-foreground);
  border-color: rgba(163, 163, 163, 0.2);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.attach-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted-foreground);
  cursor: pointer;
  user-select: none;
}

.attach-toggle:hover {
  color: var(--foreground);
}

.attach-toggle input[type="checkbox"] {
  cursor: pointer;
  accent-color: var(--primary);
}

.btn-clear {
  background: rgba(239, 68, 68, 0.08);
  color: var(--destructive);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 6px;
  padding: 4px 10px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: all 0.15s;
}

.btn-clear:hover {
  background: var(--destructive);
  color: #ffffff;
}

/* Expanded Prompt Panel */
.expanded-prompt-panel {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.prompt-textarea-wrapper {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.prompt-textarea-wrapper textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font-size: 13px;
  background: var(--input);
  color: var(--foreground);
  font-family: inherit;
  resize: vertical;
  line-height: 1.45;
}

.prompt-textarea-wrapper textarea:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--primary);
}

.prompt-footer-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.prompt-hint {
  font-size: 11px;
  color: var(--muted-foreground);
}

.btn-apply-prompt {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-apply-prompt:hover {
  background: #32e012;
}

/* Chat Messages */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.empty-chat {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted-foreground);
  gap: 8px;
}

.empty-chat .material-icons {
  font-size: 48px;
  opacity: 0.5;
  color: var(--primary);
}

.message-wrapper {
  display: flex;
  flex-direction: column;
  max-width: 90%;
}

.message-wrapper.user {
  align-self: flex-end;
}

.message-wrapper.user .message-bubble {
  background: var(--primary);
  color: var(--primary-foreground);
  border-bottom-right-radius: 2px;
  font-weight: 500;
}

.message-wrapper.user.editing .message-bubble {
  background: var(--popover);
  color: var(--foreground);
  border: 1px solid var(--border);
  min-width: 320px;
}

.message-wrapper.assistant {
  align-self: flex-start;
}

.message-wrapper.assistant .message-bubble {
  background: var(--popover);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-bottom-left-radius: 2px;
}

.message-bubble {
  position: relative;
  padding: 12px 16px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}

.message-content {
  white-space: pre-wrap;
  word-break: break-word;
}

/* Inline Prompt Editor */
.inline-prompt-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  min-width: 280px;
}

.inline-prompt-editor textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--input);
  color: var(--foreground);
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.45;
  resize: vertical;
}

.inline-prompt-editor textarea:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--primary);
}

.inline-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn-editor-cancel {
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-editor-cancel:hover {
  background: rgba(255, 255, 255, 0.15);
  color: var(--foreground);
}

.btn-editor-submit {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  box-shadow: var(--glow-primary);
  transition: all 0.15s;
}

.btn-editor-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}

.btn-editor-submit:hover:not(:disabled) {
  box-shadow: var(--glow-primary-hover);
}

/* Hover actions */
.message-actions {
  position: absolute;
  top: -12px;
  right: 6px;
  display: flex;
  gap: 3px;
  opacity: 0;
  transition: opacity 0.15s ease-in-out;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.4);
  z-index: 10;
}

.message-wrapper.user .message-actions {
  right: auto;
  left: 6px;
}

.message-wrapper:hover .message-actions {
  opacity: 1;
}

.message-actions button {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 3px 5px;
  border-radius: 4px;
  color: var(--muted-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.message-actions button:hover {
  background: var(--popover);
  color: var(--primary);
}

.message-actions .material-icons {
  font-size: 15px;
}

/* Markdown Body Styles */
.user-text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}

:deep(.markdown-body) {
  font-size: 14px;
  line-height: 1.7;
  color: var(--foreground);
  word-break: break-word;
}

:deep(.markdown-body p) {
  margin: 0 0 16px 0;
}
:deep(.markdown-body p:last-child) {
  margin-bottom: 0;
}

:deep(.markdown-body h1),
:deep(.markdown-body h2),
:deep(.markdown-body h3),
:deep(.markdown-body h4),
:deep(.markdown-body h5),
:deep(.markdown-body h6) {
  margin: 18px 0 8px 0;
  font-weight: 600;
  line-height: 1.35;
  color: var(--foreground);
}
:deep(.markdown-body h1) { font-size: 1.35em; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
:deep(.markdown-body h2) { font-size: 1.2em; border-bottom: 1px solid var(--border); padding-bottom: 3px; }
:deep(.markdown-body h3) { font-size: 1.08em; }
:deep(.markdown-body h4) { font-size: 1.0em; }

:deep(.markdown-body ul),
:deep(.markdown-body ol) {
  margin: 8px 0 16px 0;
  padding-left: 20px;
}
:deep(.markdown-body li) {
  margin: 5px 0;
}

:deep(.markdown-body blockquote) {
  margin: 10px 0;
  padding: 6px 12px;
  border-left: 3px solid var(--primary, #3498db);
  background: rgba(255, 255, 255, 0.04);
  border-radius: 0 6px 6px 0;
  color: var(--muted-foreground);
}

:deep(.markdown-body pre.hljs) {
  margin: 10px 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: #181a1f !important;
  border: 1px solid rgba(255, 255, 255, 0.1);
  overflow-x: auto;
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, Monaco, monospace;
  font-size: 13px;
  line-height: 1.45;
}

:deep(.markdown-body code:not(pre code)) {
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  color: #f39c12;
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, Monaco, monospace;
  font-size: 12.5px;
}

:deep(.markdown-body table) {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
  font-size: 13.5px;
}
:deep(.markdown-body th),
:deep(.markdown-body td) {
  border: 1px solid var(--border);
  padding: 7px 10px;
  text-align: left;
}
:deep(.markdown-body th) {
  background: rgba(255, 255, 255, 0.06);
  font-weight: 600;
}
:deep(.markdown-body tr:nth-child(even)) {
  background: rgba(255, 255, 255, 0.02);
}

:deep(.markdown-body a) {
  color: var(--primary, #3498db);
  text-decoration: underline;
  text-underline-offset: 2px;
  transition: opacity 0.2s;
}
:deep(.markdown-body a:hover) {
  opacity: 0.8;
}

:deep(.markdown-body hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}

:deep(.team-chip) {
  display: inline;
  color: var(--primary, #39ff14);
  font-weight: 700;
  font-family: 'Orbitron', monospace;
  text-decoration: underline;
  text-decoration-color: var(--primary, #39ff14);
  text-decoration-thickness: 1.5px;
  text-underline-offset: 3px;
  cursor: pointer;
  user-select: none;
  transition: all 0.15s ease-in-out;
  padding: 1px 3px;
  margin: 0 1px;
  border-radius: 4px;
}

:deep(.team-chip:hover) {
  color: var(--primary, #39ff14);
  text-shadow: 0 0 8px rgba(57, 255, 20, 0.7);
  text-decoration-color: #ffffff;
  background: rgba(57, 255, 20, 0.12);
}

:deep(.team-chip:active) {
  opacity: 0.8;
}

/* 用户气泡（绿底黑字）内的队伍标记：深色下划线与高对比度文字适配 */
.message-wrapper.user .message-bubble :deep(.team-chip) {
  color: #000000;
  text-decoration-color: #000000;
  font-weight: 800;
}

.message-wrapper.user .message-bubble :deep(.team-chip:hover) {
  color: #000000;
  text-decoration-color: #000000;
  background: rgba(0, 0, 0, 0.15);
  text-shadow: none;
}

.chat-input-area {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 10px;
  background: var(--popover);
  flex-shrink: 0;
}

.chat-input-area textarea {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input);
  color: var(--foreground);
  font-family: inherit;
  resize: none;
  font-size: 13.5px;
  line-height: 1.45;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.chat-input-area textarea:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--primary);
}

.input-buttons {
  display: flex;
  align-items: flex-end;
}

.btn-send {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  border-radius: 8px;
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--glow-primary);
  transition: opacity 0.15s, transform 0.1s, box-shadow 0.15s;
}

.btn-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}

.btn-send:hover:not(:disabled) {
  box-shadow: var(--glow-primary-hover);
  transform: translateY(-1px);
}

.btn-stop {
  background: var(--destructive, #ef4444);
  color: white;
  border: none;
  border-radius: 8px;
  padding: 0 12px;
  height: 42px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: opacity 0.15s, transform 0.1s;
  white-space: nowrap;
}

.btn-stop:hover {
  opacity: 0.9;
}

.btn-stop:active {
  transform: scale(0.97);
}

.typing-cursor {
  display: inline-block;
  width: 7px;
  height: 15px;
  background-color: var(--primary, #3498db);
  margin-left: 3px;
  vertical-align: -2px;
  animation: cursor-blink 0.8s infinite;
}

@keyframes cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.typing-indicator {
  display: inline-flex;
  gap: 4px;
  padding: 4px 0;
}
.typing-indicator span {
  width: 6px;
  height: 6px;
  background: var(--muted-foreground);
  border-radius: 50%;
  animation: typing 1s infinite alternate;
}
.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
@keyframes typing {
  0% { transform: translateY(0); opacity: 0.5; }
  100% { transform: translateY(-4px); opacity: 1; }
}

/* Settings Styles */
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
