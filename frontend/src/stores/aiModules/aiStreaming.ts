import { computed, ref, type ComputedRef } from 'vue'
import type { useUserStore } from '@/stores/user'
import { useToastStore } from '@/stores/toast'
import { i18n } from '@/i18n'
import type {
  AiChatMessage,
  AiChatThread,
  AiContextFocusMatch,
  AiProviderProfile,
  MatchScheduleItem
} from '@/types'
import { DEFAULT_THREAD_TITLES } from '@/components/ai/constants'
import { DEFAULT_PRESET } from '@/components/ai/presets'
import { buildMatchBriefPrompt, buildTeamAnalysisPrompt } from '@/components/ai/personas'
import { streamAiChat } from '@/components/ai/useAiChatStream'
import { normalizeContextConfig, type createAiThreadsModule } from './aiThreads'

export function createAiStreamingModule(deps: {
  userStore: ReturnType<typeof useUserStore>
  activeProfile: ComputedRef<AiProviderProfile | null>
  canSendWithActiveProfile: ComputedRef<boolean>
  setDockOpen: (open: boolean) => void
  openSettingsModal: (profileId?: string) => void
  threads: ReturnType<typeof createAiThreadsModule>
}) {
  const { userStore, activeProfile, canSendWithActiveProfile, setDockOpen, openSettingsModal, threads } = deps

  const streamingByThread = ref<Record<string, { messageId: string; startedAt: number }>>({})
  const abortControllersByThread = new Map<string, AbortController>()

  const isAnyStreaming = computed(() => Object.keys(streamingByThread.value).length > 0)

  function isThreadStreaming(threadId?: string | null): boolean {
    if (!threadId) return false
    return Boolean(streamingByThread.value[threadId])
  }

  function getStreamingMessageId(threadId?: string | null): string | null {
    if (!threadId) return null
    return streamingByThread.value[threadId]?.messageId || null
  }

  function stopStreaming(threadId?: string | null) {
    if (threadId) {
      const ctrl = abortControllersByThread.get(threadId)
      if (ctrl) {
        ctrl.abort()
        abortControllersByThread.delete(threadId)
      }
      const next = { ...streamingByThread.value }
      delete next[threadId]
      streamingByThread.value = next
      return
    }
    for (const [id, ctrl] of abortControllersByThread.entries()) {
      ctrl.abort()
      abortControllersByThread.delete(id)
    }
    streamingByThread.value = {}
  }

  function maybeAutoTitleThread(thread: AiChatThread, userText: string) {
    const isDefaultTitle =
      !thread.title.trim() ||
      DEFAULT_THREAD_TITLES.includes(thread.title as (typeof DEFAULT_THREAD_TITLES)[number])
    if (thread.messages.filter(m => m.role === 'user').length <= 1 && isDefaultTitle) {
      const cleaned = userText.replace(/\s+/g, ' ').trim()
      thread.title = cleaned.length > 36 ? cleaned.slice(0, 36) + '...' : cleaned
    }
  }

  async function runAssistantTurn(params: {
    eventId: string
    thread: AiChatThread
    effectiveSystemPrompt: string
    contextSummary?: string
    rollbackUserMessageOnPreflight?: { messageId: string; originalContent: string }
    errorPrefix?: string
  }): Promise<boolean> {
    const { thread, effectiveSystemPrompt, contextSummary, errorPrefix = '' } = params
    const token = userStore.token
    if (!token) return false

    const profile = activeProfile.value
    if (!profile) {
      openSettingsModal()
      return false
    }

    if (isThreadStreaming(thread.id)) {
      return false
    }

    const asstMsgId = `asst_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const assistantMsg: AiChatMessage = {
      id: asstMsgId,
      role: 'assistant',
      content: '',
      reasoning: '',
      createdAt: new Date().toISOString(),
      modelName: profile.modelName || DEFAULT_PRESET.defaultModel,
      profileName: profile.name,
      contextSummary
    }
    thread.messages.push(assistantMsg)

    const maxMsgs = profile.maxContextMsgs > 0 ? profile.maxContextMsgs : 16
    const payloadMessages = thread.messages
      .filter(m => m.id !== asstMsgId && !m.error)
      .map(m => ({ role: m.role, content: m.content }))
      .slice(-maxMsgs)

    const abortController = new AbortController()
    abortControllersByThread.set(thread.id, abortController)
    streamingByThread.value = {
      ...streamingByThread.value,
      [thread.id]: { messageId: asstMsgId, startedAt: Date.now() }
    }
    threads.syncSummaryFromThread(thread)

    const findAsst = () => thread.messages.find(m => m.id === asstMsgId)

    const res = await streamAiChat(
      {
        token,
        profileId: profile.id,
        provider: profile.protocol,
        modelName: profile.modelName,
        temperature: profile.temperature,
        systemPrompt: effectiveSystemPrompt,
        messages: payloadMessages,
        signal: abortController.signal
      },
      {
        onDelta(delta) {
          const target = findAsst()
          if (!target) return
          if (delta.reasoning) target.reasoning = (target.reasoning || '') + delta.reasoning
          if (delta.text) target.content += delta.text
          if (delta.usage) target.usage = delta.usage
          if (delta.reasoningDurationMs !== undefined) {
            target.reasoningDurationMs = delta.reasoningDurationMs
          }
        },
        onPreflightError(msg) {
          const aIdx = thread.messages.findIndex(m => m.id === asstMsgId)
          if (aIdx !== -1) thread.messages.splice(aIdx, 1)
          if (params.rollbackUserMessageOnPreflight) {
            const uIdx = thread.messages.findIndex(m => m.id === params.rollbackUserMessageOnPreflight!.messageId)
            if (uIdx !== -1) thread.messages.splice(uIdx, 1)
            threads.draftPromptByEvent.value = {
              ...threads.draftPromptByEvent.value,
              [params.eventId]: params.rollbackUserMessageOnPreflight.originalContent
            }
          }
          useToastStore().showError(`${errorPrefix}${msg}`)
          threads.scheduleSaveThread(thread)
        },
        onStreamError(msg) {
          const target = findAsst()
          if (target) {
            target.error = msg
          }
          useToastStore().showError(`${errorPrefix}${msg}`)
        }
      }
    )

    if (abortControllersByThread.get(thread.id) === abortController) {
      abortControllersByThread.delete(thread.id)
    }
    const nextStream = { ...streamingByThread.value }
    delete nextStream[thread.id]
    streamingByThread.value = nextStream

    if (!res.preflightFailed) {
      const finalTarget = findAsst()
      if (finalTarget) {
        finalTarget.durationMs = res.durationMs
        if (res.reasoningDurationMs !== undefined) {
          finalTarget.reasoningDurationMs = res.reasoningDurationMs
        }
        if (res.usage) {
          finalTarget.usage = res.usage
        }
        if (res.cancelled) {
          finalTarget.stopped = true
        } else if (!finalTarget.content.trim() && !finalTarget.error && !finalTarget.reasoning?.trim()) {
          finalTarget.content = i18n.global.t('ai.no_content_returned')
        }
      }
      await threads.persistThreadNow(thread)
      return !res.error
    }

    return false
  }

  async function sendChatMessage(params: {
    eventId: string
    prompt: string
    effectiveSystemPrompt: string
    contextSummary?: string
    errorPrefix?: string
  }): Promise<boolean> {
    const clean = params.prompt.trim()
    if (!clean) return false
    if (!activeProfile.value) {
      openSettingsModal()
      return false
    }
    const thread = await threads.ensureActiveThread(params.eventId)
    if (!thread) return false
    if (isThreadStreaming(thread.id)) return false

    const userMsg: AiChatMessage = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      content: clean,
      createdAt: new Date().toISOString()
    }
    thread.messages.push(userMsg)
    maybeAutoTitleThread(thread, clean)
    threads.scheduleSaveThread(thread)

    return await runAssistantTurn({
      eventId: params.eventId,
      thread,
      effectiveSystemPrompt: params.effectiveSystemPrompt,
      contextSummary: params.contextSummary,
      rollbackUserMessageOnPreflight: { messageId: userMsg.id, originalContent: clean },
      errorPrefix: params.errorPrefix
    })
  }

  async function regenerateAssistantMessage(params: {
    eventId: string
    messageId: string
    effectiveSystemPrompt: string
    contextSummary?: string
    errorPrefix?: string
  }): Promise<boolean> {
    const thread = threads.getActiveThread(params.eventId)
    if (!thread || isThreadStreaming(thread.id)) return false
    const idx = thread.messages.findIndex(m => m.id === params.messageId)
    if (idx === -1) return false

    thread.messages = thread.messages.slice(0, idx)
    threads.scheduleSaveThread(thread)

    return await runAssistantTurn({
      eventId: params.eventId,
      thread,
      effectiveSystemPrompt: params.effectiveSystemPrompt,
      contextSummary: params.contextSummary,
      errorPrefix: params.errorPrefix
    })
  }

  async function editAndResendUserMessage(params: {
    eventId: string
    messageId: string
    newContent: string
    effectiveSystemPrompt: string
    contextSummary?: string
    errorPrefix?: string
  }): Promise<boolean> {
    const clean = params.newContent.trim()
    if (!clean) return false
    const thread = threads.getActiveThread(params.eventId)
    if (!thread || isThreadStreaming(thread.id)) return false
    const idx = thread.messages.findIndex(m => m.id === params.messageId)
    if (idx === -1) return false

    thread.messages = thread.messages.slice(0, idx)
    const editedMsg: AiChatMessage = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      content: clean,
      createdAt: new Date().toISOString()
    }
    thread.messages.push(editedMsg)
    threads.scheduleSaveThread(thread)

    return await runAssistantTurn({
      eventId: params.eventId,
      thread,
      effectiveSystemPrompt: params.effectiveSystemPrompt,
      contextSummary: params.contextSummary,
      rollbackUserMessageOnPreflight: { messageId: editedMsg.id, originalContent: clean },
      errorPrefix: params.errorPrefix
    })
  }

  function clearPendingAutoSend(eventId: string) {
    const next = { ...threads.pendingAutoSendByEvent.value }
    delete next[eventId]
    threads.pendingAutoSendByEvent.value = next
  }

  async function openCopilotForTeam(
    eventId: string,
    teamNumber: number,
    customPrompt?: string,
    locale = 'zh'
  ) {
    if (!eventId || !teamNumber) return
    setDockOpen(true)
    const thread = await threads.ensureActiveThread(eventId)
    if (thread) {
      thread.contextConfig = normalizeContextConfig({
        ...thread.contextConfig,
        enabled: true,
        focusTeams: [teamNumber]
      })
      threads.scheduleSaveThread(thread)
    }

    const prompt = customPrompt || buildTeamAnalysisPrompt(teamNumber, locale)
    if (canSendWithActiveProfile.value) {
      threads.pendingAutoSendByEvent.value = {
        ...threads.pendingAutoSendByEvent.value,
        [eventId]: { prompt, focusTeams: [teamNumber] }
      }
    } else {
      threads.draftPromptByEvent.value = { ...threads.draftPromptByEvent.value, [eventId]: prompt }
    }
  }

  async function openCopilotForMatch(
    eventId: string,
    sched: MatchScheduleItem,
    customPrompt?: string,
    locale = 'zh'
  ) {
    if (!eventId || !sched) return
    setDockOpen(true)
    const teams = [sched.red1, sched.red2, sched.blue1, sched.blue2].filter(n => n > 0)
    const focusMatch: AiContextFocusMatch = {
      matchNumber: sched.matchNumber,
      tournamentLevel: sched.tournamentLevel || 'QUALIFICATION'
    }
    const thread = await threads.ensureActiveThread(eventId)
    if (thread) {
      thread.personaId = 'match_coach'
      thread.contextConfig = normalizeContextConfig({
        ...thread.contextConfig,
        enabled: true,
        focusTeams: teams,
        focusMatch
      })
      threads.scheduleSaveThread(thread)
    }

    const prompt = customPrompt || buildMatchBriefPrompt(sched, locale)
    if (canSendWithActiveProfile.value) {
      threads.pendingAutoSendByEvent.value = {
        ...threads.pendingAutoSendByEvent.value,
        [eventId]: { prompt, focusTeams: teams, focusMatch }
      }
    } else {
      threads.draftPromptByEvent.value = { ...threads.draftPromptByEvent.value, [eventId]: prompt }
    }
  }

  return {
    streamingByThread,
    isAnyStreaming,
    isThreadStreaming,
    getStreamingMessageId,
    stopStreaming,
    sendChatMessage,
    regenerateAssistantMessage,
    editAndResendUserMessage,
    clearPendingAutoSend,
    openCopilotForTeam,
    openCopilotForMatch
  }
}
