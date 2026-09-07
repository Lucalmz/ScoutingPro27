import { ref, type Ref } from 'vue'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export interface UseAiChatStreamOptions {
  chatHistory: Ref<ChatMessage[]>
  chatInput: Ref<string>
  systemPrompt: Ref<string>
  attachDataContext: Ref<boolean>
  keyLostError: Ref<boolean>
  getDataContext: () => string
  getToken: () => string | null
  getActiveProvider: () => string
  onSaveHistory: () => void
  onScrollToBottom: (force?: boolean) => void
  t: (key: string) => string
}

export function useAiChatStream(options: UseAiChatStreamOptions) {
  const isSending = ref(false)
  const isStreaming = ref(false)
  const streamingMessageId = ref<string | null>(null)
  const currentAbortController = ref<AbortController | null>(null)

  function stopGenerating() {
    if (currentAbortController.value) {
      currentAbortController.value.abort()
      currentAbortController.value = null
    }
    isSending.value = false
    isStreaming.value = false
    streamingMessageId.value = null
    options.onSaveHistory()
  }

  async function sendMessage() {
    if (!options.chatInput.value.trim() || isSending.value) return
    if (options.keyLostError.value) {
      alert(options.t('ai.key_lost_alert'))
      return
    }

    const content = options.chatInput.value.trim()
    options.chatInput.value = ''

    const userMessage: ChatMessage = {
      id: 'user_' + Date.now().toString(),
      role: 'user',
      content
    }
    options.chatHistory.value.push(userMessage)

    // Create empty placeholder assistant message for streaming
    const assistantMessageId = 'assistant_' + Date.now().toString()
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: ''
    }
    options.chatHistory.value.push(assistantMessage)
    streamingMessageId.value = assistantMessageId
    isSending.value = true
    isStreaming.value = true
    options.onScrollToBottom(true)
    options.onSaveHistory()

    // Sliding window: last 10 messages to prevent token explosion
    const MAX_CONTEXT_MESSAGES = 10
    const allHistory = options.chatHistory.value
      .filter((m) => m.id !== assistantMessageId)
      .map((m) => ({
        role: m.role,
        content: m.content
      }))
    const messagesPayload =
      allHistory.length > MAX_CONTEXT_MESSAGES
        ? allHistory.slice(-MAX_CONTEXT_MESSAGES)
        : allHistory

    let effectiveSystemPrompt = options.systemPrompt.value.trim()
    if (options.attachDataContext.value) {
      const dataContext = options.getDataContext()
      effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${dataContext}`
    }

    const abortController = new AbortController()
    currentAbortController.value = abortController

    try {
      const res = await fetch('/api/ai/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.getToken()}`,
          Accept: 'text/event-stream'
        },
        body: JSON.stringify({
          provider: options.getActiveProvider() || 'OPENAI',
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
          errMsg = (await res.text()) || 'HTTP ' + res.status
        }

        // Rollback both messages on pre-flight non-SSE failure
        const asstIdx = options.chatHistory.value.indexOf(assistantMessage)
        if (asstIdx !== -1) options.chatHistory.value.splice(asstIdx, 1)
        const userIdx = options.chatHistory.value.indexOf(userMessage)
        if (userIdx !== -1) options.chatHistory.value.splice(userIdx, 1)
        options.onSaveHistory()

        options.chatInput.value = content // restore input for retry
        alert(options.t('ai.error_prefix') + errMsg)
        return
      }

      if (!res.body) {
        throw new Error('ReadableStream not supported on this response')
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let lineBuffer = ''

      const getAssistantMessage = () =>
        options.chatHistory.value.find((m) => m.id === assistantMessageId)

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          const tail = decoder.decode()
          if (tail) lineBuffer += tail
          break
        }

        lineBuffer += decoder.decode(value, { stream: true })
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) {
            continue
          }
          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.substring(5).trim()
            if (dataStr === '[DONE]') {
              break
            }
            try {
              const parsed = JSON.parse(dataStr)
              const target = getAssistantMessage()
              if (parsed.error) {
                if (target) {
                  target.content +=
                    (target.content ? '\n\n' : '') +
                    `[${options.t('ai.error_prefix')}${parsed.error}]`
                }
              } else if (parsed.text) {
                if (target) {
                  target.content += parsed.text
                  options.onScrollToBottom()
                }
              }
            } catch (e) {
              // Ignore malformed JSON event
            }
          }
        }
      }

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
      options.onSaveHistory()
    } catch (e: any) {
      const target = options.chatHistory.value.find((m) => m.id === assistantMessageId)
      if (e.name === 'AbortError') {
        if (target && !target.content.trim()) {
          target.content = options.t('ai.stopped_by_user')
        }
        options.onSaveHistory()
      } else {
        if (!target || !target.content) {
          const asstIdx = options.chatHistory.value.findIndex((m) => m.id === assistantMessageId)
          if (asstIdx !== -1) options.chatHistory.value.splice(asstIdx, 1)
          const userIdx = options.chatHistory.value.findIndex((m) => m.id === userMessage.id)
          if (userIdx !== -1) options.chatHistory.value.splice(userIdx, 1)
          options.onSaveHistory()
          options.chatInput.value = content
          alert(options.t('ai.network_error_prefix') + e.message)
        } else {
          target.content += `\n\n[${options.t('ai.network_error_prefix')}${e.message}]`
          options.onSaveHistory()
        }
      }
    } finally {
      isSending.value = false
      isStreaming.value = false
      streamingMessageId.value = null
      currentAbortController.value = null
      options.onScrollToBottom()
    }
  }

  return {
    isSending,
    isStreaming,
    streamingMessageId,
    currentAbortController,
    stopGenerating,
    sendMessage
  }
}
