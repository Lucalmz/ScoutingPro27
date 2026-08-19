<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue'
import { useAiStore } from '@/stores/ai'
import { useUserStore } from '@/stores/user'
import type { AiSettings } from '@/types'

const props = defineProps<{
  eventId: string
}>()

const aiStore = useAiStore()
const userStore = useUserStore()

const activeTab = ref<'chat' | 'settings'>('chat')

const provider = ref<'OPENAI' | 'GEMINI'>('OPENAI')
const apiKey = ref('')
const modelName = ref('')
const baseUrl = ref('')
const proxyHost = ref('127.0.0.1')
const proxyPort = ref<number | string | null>(null)
const systemPrompt = ref('You are a helpful AI assistant for the ScoutingPro27 application. You help users analyze FTC scouting data.')

const isSaving = ref(false)
const isTesting = ref(false)
const testResult = ref<{success: boolean, statusCode?: number, latencyMs?: number, message?: string, error?: string} | null>(null)

// Chat state
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}
const chatHistory = ref<ChatMessage[]>([])
const chatInput = ref('')
const isSending = ref(false)
const chatContainerRef = ref<HTMLElement | null>(null)
const keyLostError = ref(false)

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
    modelName.value = s.modelName || (provider.value === 'GEMINI' ? 'gemini-flash-latest' : '')
    baseUrl.value = s.baseUrl || ''
    proxyHost.value = s.proxyHost || '127.0.0.1'
    proxyPort.value = s.proxyPort
    systemPrompt.value = s.systemPrompt || 'You are a helpful AI assistant for the ScoutingPro27 application. You help users analyze FTC scouting data.'
  } else {
    apiKey.value = ''
    modelName.value = provider.value === 'GEMINI' ? 'gemini-flash-latest' : ''
    baseUrl.value = ''
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
    scrollToBottom()
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
    alert('AI Settings saved successfully!')
    loadFormForProvider() // refresh the mask
  } else {
    alert('Failed to save AI settings.')
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
function scrollToBottom() {
  nextTick(() => {
    if (chatContainerRef.value) {
      chatContainerRef.value.scrollTop = chatContainerRef.value.scrollHeight
    }
  })
}

async function sendMessage() {
  if (!chatInput.value.trim() || isSending.value) return
  if (keyLostError.value) {
    alert('Please re-enter your API key in Settings. The encryption key was reset.')
    return
  }
  
  const content = chatInput.value.trim()
  chatInput.value = ''
  
  const userMessage: ChatMessage = {
    id: Date.now().toString(),
    role: 'user',
    content
  }
  chatHistory.value.push(userMessage)
  scrollToBottom()
  debouncedSaveHistory()
  
  isSending.value = true
  
  // Format payload
  const messagesPayload = chatHistory.value.map(m => ({
    role: m.role,
    content: m.content
  }))

  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userStore.token}`
      },
      body: JSON.stringify({
        provider: provider.value,
        systemPrompt: systemPrompt.value,
        messages: messagesPayload
      })
    })
    
    if (res.ok) {
      const data = await res.json()
      chatHistory.value.push({
        id: Date.now().toString(),
        role: 'assistant',
        content: data.reply || '[Empty response]'
      })
      debouncedSaveHistory()
    } else {
      let errMsg = 'Failed to get AI response'
      try {
        const errJson = await res.json()
        errMsg = errJson.error || errJson.message || JSON.stringify(errJson)
      } catch {
        errMsg = await res.text() || ('HTTP ' + res.status)
      }
      
      // Rollback user message from chat history to avoid corrupting multi-turn conversation flow
      const idx = chatHistory.value.indexOf(userMessage)
      if (idx !== -1) {
        chatHistory.value.splice(idx, 1)
        debouncedSaveHistory()
      }
      chatInput.value = content // restore input for easy edit/retry
      alert('AI Request Failed: ' + errMsg)
    }
  } catch (e: any) {
    // Rollback user message on network failure
    const idx = chatHistory.value.indexOf(userMessage)
    if (idx !== -1) {
      chatHistory.value.splice(idx, 1)
      debouncedSaveHistory()
    }
    chatInput.value = content // restore input
    alert('Network error: ' + e.message)
  } finally {
    isSending.value = false
    scrollToBottom()
  }
}

function deleteMessage(index: number) {
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
  if (confirm('Are you sure you want to clear the entire chat context?')) {
    chatHistory.value = []
    debouncedSaveHistory()
  }
}
</script>

<template>
  <div class="ai-chat-view">
    <div class="inner-tabs">
      <button :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">Chat</button>
      <button :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">Settings</button>
    </div>

    <div v-if="activeTab === 'chat'" class="chat-container">
      <div class="chat-header">
        <div class="system-prompt-editor">
          <label>System Persona / Prompt (Context for AI)</label>
          <textarea v-model="systemPrompt" rows="2" placeholder="Define the AI's behavior here..."></textarea>
        </div>
        <button class="btn-clear" @click="clearChat" title="Clear all context">
          <span class="material-icons" style="font-size: 18px;">delete_sweep</span> Clear Context
        </button>
      </div>

      <div class="chat-messages" ref="chatContainerRef">
        <div v-if="chatHistory.length === 0" class="empty-chat">
          <span class="material-icons">chat_bubble_outline</span>
          <p>No messages yet. Start a conversation below.</p>
        </div>
        
        <div 
          v-for="(msg, index) in chatHistory" 
          :key="msg.id"
          class="message-wrapper"
          :class="msg.role"
        >
          <div class="message-bubble">
            <div class="message-content">{{ msg.content }}</div>
            <div class="message-actions">
              <button @click="copyMessage(msg.content)" title="Copy text"><span class="material-icons">content_copy</span></button>
              <button @click="deleteMessage(index)" title="Remove from context"><span class="material-icons">delete</span></button>
            </div>
          </div>
        </div>
        
        <div v-if="isSending" class="message-wrapper assistant loading">
          <div class="message-bubble">
            <div class="message-content">
              <span class="typing-indicator"><span></span><span></span><span></span></span>
            </div>
          </div>
        </div>
      </div>

      <div class="chat-input-area">
        <textarea 
          v-model="chatInput" 
          placeholder="Type your message here... (Shift+Enter for new line)"
          @keydown.enter.exact.prevent="sendMessage"
          rows="3"
        ></textarea>
        <button class="btn-send" @click="sendMessage" :disabled="isSending || !chatInput.trim()">
          <span class="material-icons">send</span>
        </button>
      </div>
    </div>

    <div v-if="activeTab === 'settings'" class="settings-panel">
      <h2>AI Configuration</h2>
      <p class="subtitle">Configure your AI provider to enable smart data analysis and chat features.</p>
      
      <div class="settings-form">
        <div v-if="keyLostError" class="alert-error">
          <span class="material-icons">warning</span>
          Your encryption master key was reset. Please re-enter your API key.
        </div>
        <div class="form-row">
          <div class="form-group" style="flex: 1;">
            <label>AI Provider</label>
            <select v-model="provider" :disabled="isSaving || isTesting">
              <option value="OPENAI">OpenAI (or Compatible, e.g. DeepSeek/SiliconFlow)</option>
              <option value="GEMINI">Google Gemini</option>
            </select>
          </div>
          <div class="form-group" style="flex: 1;">
            <label>Model Name <span v-if="provider === 'OPENAI'">(Required)</span></label>
            <input v-if="provider === 'OPENAI'" type="text" v-model="modelName" placeholder="e.g. gpt-4o, deepseek-chat" :disabled="isSaving || isTesting" />
            <select v-else v-model="modelName" :disabled="isSaving || isTesting">
              <option value="gemini-flash-latest">gemini-flash-latest</option>
              <option value="gemini-flash-lite-latest">gemini-flash-lite-latest</option>
              <option value="gemini-pro-latest">gemini-pro-latest</option>
            </select>
          </div>
        </div>

        <div v-if="provider === 'OPENAI'" class="form-group">
          <label>Base URL (Optional, for DeepSeek / SiliconFlow / Ollama)</label>
          <input type="text" v-model="baseUrl" placeholder="https://api.deepseek.com/v1 (Leave empty for default OpenAI)" :disabled="isSaving || isTesting" />
        </div>
        
        <div class="form-group">
          <label>API Key</label>
          <input type="password" v-model="apiKey" autocomplete="new-password" placeholder="sk-... / AIzaSy..." :disabled="isSaving || isTesting" />
          <small v-if="apiKey && (apiKey === '****' || apiKey.includes('***'))" class="hint">Your key is saved. Enter a new one to change it, or leave as is to keep it.</small>
        </div>

        <div class="form-row">
          <div class="form-group" style="flex: 2;">
            <label>Proxy Host (HTTP Only)</label>
            <input type="text" v-model="proxyHost" placeholder="127.0.0.1" :disabled="isSaving || isTesting" />
          </div>
          <div class="form-group" style="flex: 1;">
            <label>Proxy Port (Optional)</label>
            <input type="number" v-model="proxyPort" placeholder="e.g. 7890" :disabled="isSaving || isTesting" />
          </div>
        </div>

        <div class="form-group">
          <label>System Prompt (Initial Persona)</label>
          <textarea v-model="systemPrompt" rows="4" :disabled="isSaving || isTesting"></textarea>
        </div>

        <div class="button-group">
          <button class="btn-primary" @click="saveSettings" :disabled="isSaving || isTesting">
            {{ isSaving ? 'Saving...' : 'Save Settings' }}
          </button>
          <button class="btn-secondary" @click="testConnection" :disabled="isSaving || isTesting">
            {{ isTesting ? 'Testing...' : 'Test Connection' }}
          </button>
        </div>

        <div v-if="testResult" class="test-result" :class="{ success: testResult.success, error: !testResult.success }">
          <strong>{{ testResult.success ? 'Connection Successful!' : 'Connection Failed!' }}</strong>
          <span v-if="testResult.latencyMs"> ({{ testResult.latencyMs }}ms)</span>
          <p v-if="testResult.message">{{ testResult.message }}</p>
          <p v-else-if="testResult.error">{{ testResult.error }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-chat-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 900px;
  margin: 0 auto;
  height: calc(100vh - 160px);
}

.inner-tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}

.inner-tabs button {
  padding: 8px 16px;
  background: transparent;
  border: none;
  font-weight: 500;
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
}

/* Chat Styles */
.chat-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.chat-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  background: var(--background);
}

.system-prompt-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.system-prompt-editor label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
}
.system-prompt-editor textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px;
  font-size: 13px;
  background: var(--input);
  color: var(--foreground);
  font-family: inherit;
  resize: vertical;
}

.btn-clear {
  background: rgba(231, 76, 60, 0.1);
  color: #e74c3c;
  border: 1px solid rgba(231, 76, 60, 0.2);
  border-radius: 6px;
  padding: 6px 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  font-size: 13px;
  margin-top: 20px;
}
.btn-clear:hover {
  background: #e74c3c;
  color: white;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
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
}

.message-wrapper {
  display: flex;
  flex-direction: column;
  max-width: 85%;
}

.message-wrapper.user {
  align-self: flex-end;
}
.message-wrapper.user .message-bubble {
  background: var(--primary);
  color: var(--primary-foreground);
  border-bottom-right-radius: 2px;
}

.message-wrapper.assistant {
  align-self: flex-start;
}
.message-wrapper.assistant .message-bubble {
  background: var(--background);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-bottom-left-radius: 2px;
}

.message-bubble {
  position: relative;
  padding: 12px 16px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.5;
}

.message-content {
  white-space: pre-wrap;
  word-break: break-word;
}

/* Hover actions */
.message-actions {
  position: absolute;
  bottom: -28px;
  right: 0;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  z-index: 10;
}
.message-wrapper.user .message-actions {
  right: auto;
  left: 0;
}
.message-wrapper:hover .message-actions {
  opacity: 1;
}
.message-actions button {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  color: var(--muted-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
}
.message-actions button:hover {
  background: var(--background);
  color: var(--foreground);
}
.message-actions .material-icons {
  font-size: 16px;
}

.chat-input-area {
  padding: 16px;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 12px;
  background: var(--background);
}
.chat-input-area textarea {
  flex: 1;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input);
  color: var(--foreground);
  font-family: inherit;
  resize: none;
  font-size: 14px;
}
.btn-send {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  border-radius: 8px;
  width: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.2s;
}
.btn-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
