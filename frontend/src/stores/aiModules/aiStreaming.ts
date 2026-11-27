import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { useUserStore } from '@/stores/user'
import { useEventStore } from '@/stores/events'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { isDesktopHost } from '@/services/photoStorage'
import { isMobileDevice } from '@/composables/useIsMobile'
import { i18n } from '@/i18n'
import type {
  AiAssistantMode,
  AiChatMessage,
  AiChatThread,
  AiContextFocusMatch,
  AiProviderProfile,
  AiThinkingMode,
  MatchScheduleItem
} from '@/types'
import { DEFAULT_THREAD_TITLES, THINKING_MODE_CONFIG } from '@/components/ai/constants'
import { DEFAULT_PRESET } from '@/components/ai/presets'
import { buildMatchBriefPrompt, buildTeamAnalysisPrompt } from '@/components/ai/personas'
import { streamAiChat } from '@/components/ai/useAiChatStream'
import { executeTurboActions, extractTurboActionsFromContent, stripTurboActionBlocks } from '@/components/ai/turboAgent'
import { normalizeContextConfig, type createAiThreadsModule } from './aiThreads'

export function createAiStreamingModule(deps: {
  userStore: ReturnType<typeof useUserStore>
  activeProfile: ComputedRef<AiProviderProfile | null>
  canSendWithActiveProfile: ComputedRef<boolean>
  aiMode?: Ref<AiAssistantMode>
  thinkingMode?: Ref<AiThinkingMode>
  setDockOpen: (open: boolean) => void
  openSettingsModal: (profileId?: string) => void
  threads: ReturnType<typeof createAiThreadsModule>
}) {
  const { userStore, activeProfile, canSendWithActiveProfile, aiMode, thinkingMode, setDockOpen, openSettingsModal, threads } = deps

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

  function isHostForEvent(eventId: string): boolean {
    if (isMobileDevice() || !isDesktopHost()) {
      return false
    }
    const eventStore = useEventStore()
    const targetEvent =
      eventStore.events.find(e => e.id === eventId) ||
      (eventStore.currentEvent?.id === eventId ? eventStore.currentEvent : null)
    if (!targetEvent) return false
    if (targetEvent.hostId && targetEvent.hostId === userStore.userId) {
      return true
    }
    if (eventStore.currentEvent?.id === eventId) {
      const conn = useConnectionStore()
      if (conn.rtcService && typeof conn.rtcService.isHostMode === 'function' && conn.rtcService.isHostMode()) {
        return true
      }
    }
    return false
  }

  async function runAssistantTurn(params: {
    eventId: string
    thread: AiChatThread
    effectiveSystemPrompt: string
    contextSummary?: string
    aiMode?: AiAssistantMode
    thinkingMode?: AiThinkingMode
    rollbackUserMessageOnPreflight?: { messageId: string; originalContent: string }
    rollbackMessagesSnapshot?: { messages: AiChatMessage[]; updatedAt?: string }
    errorPrefix?: string
  }): Promise<boolean> {
    const { thread, effectiveSystemPrompt, contextSummary, errorPrefix = '' } = params
    const effectiveAiMode: AiAssistantMode = params.aiMode ?? aiMode?.value ?? 'ask'
    const effectiveThinkingMode: AiThinkingMode = params.thinkingMode ?? thinkingMode?.value ?? 'off'
    const thinkingCfg = THINKING_MODE_CONFIG[effectiveThinkingMode] || THINKING_MODE_CONFIG.off
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
      contextSummary,
      aiMode: effectiveAiMode
    }
    thread.messages.push(assistantMsg)

    const maxMsgs = profile.maxContextMsgs > 0 ? profile.maxContextMsgs : 16
    const payloadMessages = thread.messages
      .filter(m => m.id !== asstMsgId && !m.error)
      .map(m => {
        if (m.role !== 'assistant') {
          return { role: m.role, content: m.content }
        }
        const clean = stripTurboActionBlocks(m.content || '').displayContent
        if (clean) {
          return { role: m.role, content: clean }
        }
        if (m.turboActions && m.turboActions.length > 0) {
          const actionLine = m.turboActions.map(a => `${a.type}: ${a.summary}`).join('; ')
          return { role: m.role, content: `[Executed actions: ${actionLine}]` }
        }
        return { role: m.role, content: '' }
      })
      .slice(-maxMsgs)

    const abortController = new AbortController()
    abortControllersByThread.set(thread.id, abortController)
    streamingByThread.value = {
      ...streamingByThread.value,
      [thread.id]: { messageId: asstMsgId, startedAt: Date.now() }
    }
    threads.syncSummaryFromThread(thread)

    const findAsst = () => thread.messages.find(m => m.id === asstMsgId)

    const profileBudget = profile.thinkingBudget >= 1024 ? profile.thinkingBudget : 4096
    const effectiveThinkingBudget =
      effectiveThinkingMode === 'off'
        ? 0
        : effectiveThinkingMode === 'low'
          ? thinkingCfg.thinkingBudget
          : effectiveThinkingMode === 'medium'
            ? profileBudget
            : Math.max(thinkingCfg.thinkingBudget, profileBudget)

    const res = await streamAiChat(
      {
        token,
        profileId: profile.id,
        provider: profile.protocol,
        modelName: profile.modelName,
        temperature: profile.temperature,
        enableThinking: thinkingCfg.enableThinking,
        thinkingBudget: effectiveThinkingBudget,
        reasoningEffort: thinkingCfg.reasoningEffort,
        systemPrompt: effectiveSystemPrompt,
        messages: payloadMessages,
        signal: abortController.signal,
        onRefreshedToken: newToken => {
          if (userStore.user) {
            userStore.user = { ...userStore.user, token: newToken }
          }
        }
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
          if (params.rollbackMessagesSnapshot) {
            thread.messages = [...params.rollbackMessagesSnapshot.messages]
            thread.updatedAt = params.rollbackMessagesSnapshot.updatedAt
            threads.syncSummaryFromThread(thread)
          } else if (params.rollbackUserMessageOnPreflight) {
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
          finalTarget.content = stripTurboActionBlocks(finalTarget.content).displayContent
        } else {
          if (effectiveAiMode === 'turbo' && !res.error && finalTarget.content.trim()) {
            const parsedActions = extractTurboActionsFromContent(finalTarget.content)
            if (parsedActions.length > 0) {
              const actingUser = userStore.username || 'User'
              finalTarget.turboActions = parsedActions.map((act, idx) => ({
                id: `pending_${idx}`,
                type: act.type,
                status: 'pending' as const,
                summary: act.type,
                actedAsUsername: actingUser
              }))
              const executed = await executeTurboActions({
                eventId: params.eventId,
                actions: parsedActions,
                userId: userStore.userId,
                username: actingUser,
                isHost: isHostForEvent(params.eventId),
                locale: i18n.global.locale.value
              })
              finalTarget.turboActions = executed
              const okCount = executed.filter(item => item.status === 'success').length
              const errCount = executed.filter(item => item.status === 'error').length
              const toastStore = useToastStore()
              if (errCount === 0 && okCount > 0) {
                toastStore.showToast(
                  i18n.global.t('ai.turbo_toast_success', { count: okCount }),
                  'success'
                )
              } else if (okCount > 0 && errCount > 0) {
                toastStore.showToast(
                  i18n.global.t('ai.turbo_toast_partial', { ok: okCount, fail: errCount }),
                  'warning'
                )
              } else if (errCount > 0) {
                toastStore.showToast(
                  i18n.global.t('ai.turbo_toast_failed', { fail: errCount }),
                  'error'
                )
              }
            }
          }

          const strippedProse = stripTurboActionBlocks(finalTarget.content).displayContent
          const hasExecutedActions = Boolean(finalTarget.turboActions && finalTarget.turboActions.length > 0)
          if (!strippedProse && !hasExecutedActions && !finalTarget.error && !finalTarget.reasoning?.trim()) {
            finalTarget.content = i18n.global.t('ai.no_content_returned')
          } else {
            finalTarget.content = strippedProse
          }
        }
      }
      if (threads.threadDetailsById.value[thread.id]) {
        await threads.persistThreadNow(thread)
      }
      return !res.error
    }

    return false
  }

  async function sendChatMessage(params: {
    eventId: string
    prompt: string
    effectiveSystemPrompt: string
    contextSummary?: string
    aiMode?: AiAssistantMode
    thinkingMode?: AiThinkingMode
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
      aiMode: params.aiMode,
      thinkingMode: params.thinkingMode,
      rollbackUserMessageOnPreflight: { messageId: userMsg.id, originalContent: clean },
      errorPrefix: params.errorPrefix
    })
  }

  async function regenerateAssistantMessage(params: {
    eventId: string
    messageId: string
    effectiveSystemPrompt: string
    contextSummary?: string
    aiMode?: AiAssistantMode
    thinkingMode?: AiThinkingMode
    errorPrefix?: string
  }): Promise<boolean> {
    const thread = threads.getActiveThread(params.eventId)
    if (!thread || isThreadStreaming(thread.id)) return false
    const idx = thread.messages.findIndex(m => m.id === params.messageId)
    if (idx === -1) return false

    const prevMessages = [...thread.messages]
    const prevUpdatedAt = thread.updatedAt
    thread.messages = thread.messages.slice(0, idx)
    threads.scheduleSaveThread(thread)

    return await runAssistantTurn({
      eventId: params.eventId,
      thread,
      effectiveSystemPrompt: params.effectiveSystemPrompt,
      contextSummary: params.contextSummary,
      aiMode: params.aiMode,
      thinkingMode: params.thinkingMode,
      rollbackMessagesSnapshot: { messages: prevMessages, updatedAt: prevUpdatedAt },
      errorPrefix: params.errorPrefix
    })
  }

  async function editAndResendUserMessage(params: {
    eventId: string
    messageId: string
    newContent: string
    effectiveSystemPrompt: string
    contextSummary?: string
    aiMode?: AiAssistantMode
    thinkingMode?: AiThinkingMode
    errorPrefix?: string
  }): Promise<boolean> {
    const clean = params.newContent.trim()
    if (!clean) return false
    const thread = threads.getActiveThread(params.eventId)
    if (!thread || isThreadStreaming(thread.id)) return false
    const idx = thread.messages.findIndex(m => m.id === params.messageId)
    if (idx === -1) return false

    const prevMessages = [...thread.messages]
    const prevUpdatedAt = thread.updatedAt
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
      aiMode: params.aiMode,
      thinkingMode: params.thinkingMode,
      rollbackMessagesSnapshot: { messages: prevMessages, updatedAt: prevUpdatedAt },
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
