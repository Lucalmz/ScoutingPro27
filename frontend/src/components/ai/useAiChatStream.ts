import { i18n } from '@/i18n'
import type { AiTokenUsage } from '@/types'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  usage?: AiTokenUsage
}

export interface StreamAiChatRequest {
  token: string
  profileId?: string
  provider?: string
  modelName?: string
  temperature?: number
  systemPrompt: string
  messages: Array<{ role: string; content: string }>
  signal: AbortSignal
}

export interface StreamAiChatDelta {
  reasoning?: string
  text?: string
  usage?: AiTokenUsage
  reasoningDurationMs?: number
}

export interface StreamAiChatHandlers {
  onDelta: (delta: StreamAiChatDelta) => void
  onPreflightError?: (message: string) => void
  onStreamError?: (message: string) => void
}

export interface StreamAiChatResult {
  preflightFailed: boolean
  cancelled: boolean
  hadText: boolean
  hadReasoning: boolean
  usage?: AiTokenUsage
  reasoningDurationMs?: number
  durationMs: number
  error?: string
}

const requestFrame = (cb: () => void): number => {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(() => cb())
  }
  return setTimeout(cb, 16) as unknown as number
}

const cancelFrame = (id: number): void => {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(id)
  } else {
    clearTimeout(id)
  }
}

/**
 * Unified rAF-throttled SSE client for OpenAI, Gemini & Anthropic streams.
 * Coalesces high-frequency reasoning/text deltas per animation frame to prevent UI thrash.
 */
export async function streamAiChat(
  req: StreamAiChatRequest,
  handlers: StreamAiChatHandlers
): Promise<StreamAiChatResult> {
  const startedAt = Date.now()
  let firstReasoningAt: number | null = null
  let reasoningDurationMs: number | undefined
  let finalUsage: AiTokenUsage | undefined
  let hadText = false
  let hadReasoning = false
  let streamErrMsg: string | undefined

  let pendingText = ''
  let pendingReasoning = ''
  let pendingUsage: AiTokenUsage | undefined
  let rafId: number | null = null

  const flushPending = () => {
    if (rafId !== null) {
      cancelFrame(rafId)
      rafId = null
    }
    if (!pendingText && !pendingReasoning && !pendingUsage && reasoningDurationMs === undefined) {
      return
    }
    const delta: StreamAiChatDelta = {}
    if (pendingReasoning) {
      delta.reasoning = pendingReasoning
      pendingReasoning = ''
    }
    if (pendingText) {
      delta.text = pendingText
      pendingText = ''
    }
    if (pendingUsage) {
      delta.usage = pendingUsage
      pendingUsage = undefined
    }
    if (reasoningDurationMs !== undefined) {
      delta.reasoningDurationMs = reasoningDurationMs
    }
    handlers.onDelta(delta)
  }

  const scheduleFlush = () => {
    if (rafId === null) {
      rafId = requestFrame(() => {
        rafId = null
        flushPending()
      })
    }
  }

  const finalizeReasoningTimer = () => {
    if (firstReasoningAt !== null && reasoningDurationMs === undefined) {
      reasoningDurationMs = Math.max(100, Date.now() - firstReasoningAt)
    }
  }

  try {
    const res = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.token}`,
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        profileId: req.profileId || undefined,
        provider: req.provider || undefined,
        modelName: req.modelName || undefined,
        temperature: req.temperature,
        systemPrompt: req.systemPrompt,
        messages: req.messages
      }),
      signal: req.signal
    })

    const contentType = res.headers.get('content-type') || ''
    if (!res.ok || !contentType.includes('text/event-stream')) {
      let errMsg = i18n.global.t('ai.err_connect_failed')
      try {
        const errJson = await res.json()
        errMsg = errJson.error || errJson.message || JSON.stringify(errJson)
      } catch {
        errMsg = (await res.text().catch(() => '')) || `HTTP ${res.status}`
      }
      handlers.onPreflightError?.(errMsg)
      return {
        preflightFailed: true,
        cancelled: false,
        hadText: false,
        hadReasoning: false,
        durationMs: Date.now() - startedAt,
        error: errMsg
      }
    }

    if (!res.body) {
      throw new Error('ReadableStream not supported on this response')
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let lineBuffer = ''
    let seenDone = false

    const handleDataLine = (rawLine: string) => {
      const trimmed = rawLine.trim()
      if (!trimmed || trimmed.startsWith(':')) return
      if (!trimmed.startsWith('data:')) return
      const dataStr = trimmed.substring(5).trim()
      if (dataStr === '[DONE]') {
        seenDone = true
        return
      }
      try {
        const parsed = JSON.parse(dataStr)
        if (parsed.error) {
          streamErrMsg = String(parsed.error)
          flushPending()
          handlers.onStreamError?.(streamErrMsg)
          return
        }
        if (typeof parsed.reasoning === 'string' && parsed.reasoning.length > 0) {
          hadReasoning = true
          if (firstReasoningAt === null) firstReasoningAt = Date.now()
          pendingReasoning += parsed.reasoning
          scheduleFlush()
        }
        if (typeof parsed.text === 'string' && parsed.text.length > 0) {
          hadText = true
          finalizeReasoningTimer()
          pendingText += parsed.text
          scheduleFlush()
        }
        if (parsed.usage && typeof parsed.usage === 'object') {
          finalUsage = {
            promptTokens: parsed.usage.promptTokens ?? parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completionTokens ?? parsed.usage.completion_tokens ?? 0,
            totalTokens: parsed.usage.totalTokens ?? parsed.usage.total_tokens ?? 0,
            thoughtsTokens: parsed.usage.thoughtsTokens
          }
          pendingUsage = finalUsage
          scheduleFlush()
        }
      } catch {
        // Ignore malformed SSE JSON fragment
      }
    }

    while (!seenDone) {
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
        handleDataLine(line)
        if (seenDone) break
      }
    }

    if (lineBuffer.trim()) {
      handleDataLine(lineBuffer)
    }

    finalizeReasoningTimer()
    flushPending()

    return {
      preflightFailed: false,
      cancelled: false,
      hadText,
      hadReasoning,
      usage: finalUsage,
      reasoningDurationMs,
      durationMs: Date.now() - startedAt,
      error: streamErrMsg
    }
  } catch (err: any) {
    finalizeReasoningTimer()
    flushPending()
    if (err?.name === 'AbortError' || req.signal.aborted) {
      return {
        preflightFailed: false,
        cancelled: true,
        hadText,
        hadReasoning,
        usage: finalUsage,
        reasoningDurationMs,
        durationMs: Date.now() - startedAt
      }
    }
    const msg = err?.message || String(err)
    handlers.onStreamError?.(msg)
    return {
      preflightFailed: false,
      cancelled: false,
      hadText,
      hadReasoning,
      usage: finalUsage,
      reasoningDurationMs,
      durationMs: Date.now() - startedAt,
      error: msg
    }
  }
}
