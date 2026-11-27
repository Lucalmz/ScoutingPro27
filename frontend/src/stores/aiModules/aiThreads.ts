import { ref } from 'vue'
import type { useUserStore } from '@/stores/user'
import { i18n } from '@/i18n'
import type { AiChatThread, AiContextConfig, AiContextFocusMatch, AiThreadSummary } from '@/types'
import { DEFAULT_PERSONA_ID } from '@/components/ai/personas'
import { aiFetch } from '@/components/ai/constants'
import { stripTurboActionBlocks } from '@/components/ai/turboAgent'

export interface PendingAutoSendRequest {
  prompt: string
  focusTeams?: number[]
  focusMatch?: AiContextFocusMatch | null
}

export function createDefaultContextConfig(): AiContextConfig {
  return {
    enabled: true,
    sections: {
      rankings: true,
      schedule: true,
      pit: true,
      matches: true,
      tags: true
    },
    focusTeams: [],
    focusMatch: null
  }
}

export function normalizeContextConfig(raw?: Partial<AiContextConfig> | null): AiContextConfig {
  const def = createDefaultContextConfig()
  if (!raw || typeof raw !== 'object') return def
  return {
    enabled: raw.enabled !== false,
    sections: {
      rankings: raw.sections?.rankings !== false,
      schedule: raw.sections?.schedule !== false,
      pit: raw.sections?.pit !== false,
      matches: raw.sections?.matches !== false,
      tags: raw.sections?.tags !== false
    },
    focusTeams: Array.isArray(raw.focusTeams)
      ? Array.from(new Set(raw.focusTeams.map(Number).filter(n => !isNaN(n) && n > 0)))
      : [],
    focusMatch:
      raw.focusMatch && typeof raw.focusMatch.matchNumber === 'number'
        ? {
            matchNumber: raw.focusMatch.matchNumber,
            tournamentLevel: raw.focusMatch.tournamentLevel
          }
        : null
  }
}

export function createAiThreadsModule(
  userStore: ReturnType<typeof useUserStore>,
  hooks: { onBeforeDeleteOrClearThread: (threadId: string) => void }
) {
  const threadsByEvent = ref<Record<string, AiThreadSummary[]>>({})
  const threadDetailsById = ref<Record<string, AiChatThread>>({})
  const activeThreadIdByEvent = ref<Record<string, string>>({})
  const loadingThreads = ref(false)
  const draftPromptByEvent = ref<Record<string, string>>({})
  const pendingAutoSendByEvent = ref<Record<string, PendingAutoSendRequest | null>>({})

  const pendingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const dirtyThreadEventMap = new Map<string, string>()
  const inFlightPutControllers = new Map<string, AbortController>()
  const deletedThreadIds = new Set<string>()

  const onRefreshedToken = (newToken: string) => {
    if (userStore.user) {
      userStore.user = { ...userStore.user, token: newToken }
    }
  }

  function getUtf8ByteLength(str: string): number {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str).length
    }
    return str.length * 3
  }

  function getThreadsForEvent(eventId: string): AiThreadSummary[] {
    return threadsByEvent.value[eventId] || []
  }

  function getActiveThread(eventId: string): AiChatThread | null {
    const tid = activeThreadIdByEvent.value[eventId]
    if (!tid) return null
    return threadDetailsById.value[tid] || null
  }

  function normalizeThread(raw: any): AiChatThread {
    return {
      id: String(raw.id),
      userId: raw.userId,
      eventId: String(raw.eventId),
      title: String(raw.title || i18n.global.t('ai.default_thread_title')),
      personaId: String(raw.personaId || DEFAULT_PERSONA_ID),
      pinned: Boolean(raw.pinned),
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      contextConfig: normalizeContextConfig(raw.contextConfig),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt
    }
  }

  function syncSummaryFromThread(thread: AiChatThread) {
    const list = [...(threadsByEvent.value[thread.eventId] || [])]
    const lastMsg = thread.messages[thread.messages.length - 1]
    const cleanLast = lastMsg?.content
      ? stripTurboActionBlocks(lastMsg.content).displayContent.replace(/\s+/g, ' ').trim()
      : ''
    const fallbackAction =
      !cleanLast && lastMsg?.turboActions && lastMsg.turboActions.length > 0
        ? `[Turbo] ${lastMsg.turboActions[0]!.summary}`.replace(/\s+/g, ' ').trim()
        : ''
    const preview = (cleanLast || fallbackAction).slice(0, 80)
    const nowIso = new Date().toISOString()
    thread.updatedAt = nowIso
    const summary: AiThreadSummary = {
      id: thread.id,
      eventId: thread.eventId,
      title: thread.title,
      personaId: thread.personaId,
      pinned: thread.pinned,
      messageCount: thread.messages.length,
      lastMessagePreview: preview,
      createdAt: thread.createdAt,
      updatedAt: nowIso
    }
    const idx = list.findIndex(t => t.id === thread.id)
    if (idx >= 0) {
      list[idx] = summary
    } else {
      list.unshift(summary)
    }
    list.sort((a, b) => {
      const pinDiff = Number(b.pinned) - Number(a.pinned)
      if (pinDiff !== 0) return pinDiff
      return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')
    })
    threadsByEvent.value = { ...threadsByEvent.value, [thread.eventId]: list }
  }

  async function persistThreadNow(thread: AiChatThread, keepalive = false): Promise<boolean> {
    if (!userStore.token || !thread?.eventId || !thread?.id) return false
    if (deletedThreadIds.has(thread.id)) return false
    dirtyThreadEventMap.delete(thread.id)

    const prevCtrl = inFlightPutControllers.get(thread.id)
    if (prevCtrl) {
      prevCtrl.abort()
    }
    const ctrl = new AbortController()
    inFlightPutControllers.set(thread.id, ctrl)

    const bodyStr = JSON.stringify({
      title: thread.title,
      personaId: thread.personaId,
      pinned: thread.pinned,
      messages: thread.messages,
      contextConfig: thread.contextConfig
    })
    const safeKeepalive = keepalive && getUtf8ByteLength(bodyStr) < 56_000

    try {
      const res = await aiFetch(`/api/events/${thread.eventId}/ai-threads/${thread.id}`, {
        method: 'PUT',
        token: userStore.token,
        onRefreshedToken,
        headers: {
          'Content-Type': 'application/json'
        },
        body: bodyStr,
        keepalive: safeKeepalive,
        signal: ctrl.signal
      })
      if (deletedThreadIds.has(thread.id)) return false
      if (res.ok) {
        const updatedRaw = await res.json().catch(() => null)
        if (updatedRaw && updatedRaw.id && !deletedThreadIds.has(thread.id)) {
          syncSummaryFromThread(thread)
        }
        return true
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.error('Failed to persist AI thread', e)
      }
    } finally {
      if (inFlightPutControllers.get(thread.id) === ctrl) {
        inFlightPutControllers.delete(thread.id)
      }
    }
    return false
  }

  function scheduleSaveThread(thread: AiChatThread) {
    if (!thread?.id || !thread?.eventId) return
    syncSummaryFromThread(thread)
    dirtyThreadEventMap.set(thread.id, thread.eventId)
    const oldTimer = pendingSaveTimers.get(thread.id)
    if (oldTimer) clearTimeout(oldTimer)
    const timer = setTimeout(() => {
      pendingSaveTimers.delete(thread.id)
      const latest = threadDetailsById.value[thread.id]
      if (latest) {
        void persistThreadNow(latest)
      }
    }, 650)
    pendingSaveTimers.set(thread.id, timer)
  }

  async function flushPendingSaves(specificThreadId?: string, keepalive = false): Promise<void> {
    const ids = specificThreadId
      ? dirtyThreadEventMap.has(specificThreadId) || pendingSaveTimers.has(specificThreadId)
        ? [specificThreadId]
        : []
      : Array.from(new Set([...pendingSaveTimers.keys(), ...dirtyThreadEventMap.keys()]))

    await Promise.all(
      ids.map(async id => {
        const timer = pendingSaveTimers.get(id)
        if (timer) {
          clearTimeout(timer)
          pendingSaveTimers.delete(id)
        }
        const thread = threadDetailsById.value[id]
        if (thread) {
          await persistThreadNow(thread, keepalive)
        }
      })
    )
  }

  async function fetchThreadDetail(eventId: string, threadId: string): Promise<AiChatThread | null> {
    const reqUserId = userStore.userId
    if (!userStore.token || !eventId || !threadId) return null
    try {
      const res = await aiFetch(`/api/events/${eventId}/ai-threads/${threadId}`, {
        token: userStore.token,
        onRefreshedToken
      })
      if (userStore.userId !== reqUserId || !userStore.token || deletedThreadIds.has(threadId)) return null
      if (res.ok) {
        const raw = await res.json()
        if (userStore.userId !== reqUserId || !userStore.token || deletedThreadIds.has(threadId)) return null
        const thread = normalizeThread(raw)
        threadDetailsById.value = { ...threadDetailsById.value, [thread.id]: thread }
        return thread
      }
    } catch (e) {
      console.error('Failed to fetch thread detail', e)
    }
    return null
  }

  async function loadEventThreads(eventId: string): Promise<AiThreadSummary[]> {
    const reqUserId = userStore.userId
    if (!userStore.token || !eventId) return []
    loadingThreads.value = true
    try {
      const res = await aiFetch(`/api/events/${eventId}/ai-threads`, {
        token: userStore.token,
        onRefreshedToken
      })
      if (userStore.userId !== reqUserId || !userStore.token) return []
      if (res.ok) {
        const list = (await res.json()) as AiThreadSummary[]
        if (userStore.userId !== reqUserId || !userStore.token) return []
        threadsByEvent.value = { ...threadsByEvent.value, [eventId]: list }
        const currentActiveId = activeThreadIdByEvent.value[eventId]
        if (list.length > 0) {
          const targetId = list.some(t => t.id === currentActiveId) ? currentActiveId! : list[0]!.id
          activeThreadIdByEvent.value = { ...activeThreadIdByEvent.value, [eventId]: targetId }
          if (!threadDetailsById.value[targetId]) {
            await fetchThreadDetail(eventId, targetId)
          }
        } else if (currentActiveId !== undefined) {
          const nextMap = { ...activeThreadIdByEvent.value }
          delete nextMap[eventId]
          activeThreadIdByEvent.value = nextMap
        }
        return list
      }
    } catch (e) {
      console.error('Failed to load event AI threads', e)
    } finally {
      loadingThreads.value = false
    }
    return []
  }

  async function createThread(
    eventId: string,
    opts?: {
      title?: string
      personaId?: string
      contextConfig?: Partial<AiContextConfig>
    }
  ): Promise<AiChatThread | null> {
    const reqUserId = userStore.userId
    if (!userStore.token || !eventId) return null
    const currentId = activeThreadIdByEvent.value[eventId]
    if (currentId) {
      await flushPendingSaves(currentId)
    }
    if (userStore.userId !== reqUserId || !userStore.token) return null
    try {
      const res = await aiFetch(`/api/events/${eventId}/ai-threads`, {
        method: 'POST',
        token: userStore.token,
        onRefreshedToken,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: opts?.title || i18n.global.t('ai.default_thread_title'),
          personaId: opts?.personaId || DEFAULT_PERSONA_ID,
          contextConfig: normalizeContextConfig(opts?.contextConfig)
        })
      })
      if (userStore.userId !== reqUserId || !userStore.token) return null
      if (res.ok) {
        const raw = await res.json()
        if (userStore.userId !== reqUserId || !userStore.token) return null
        const created = normalizeThread(raw)
        deletedThreadIds.delete(created.id)
        threadDetailsById.value = { ...threadDetailsById.value, [created.id]: created }
        syncSummaryFromThread(created)
        activeThreadIdByEvent.value = { ...activeThreadIdByEvent.value, [eventId]: created.id }
        return created
      }
    } catch (e) {
      console.error('Failed to create AI thread', e)
    }
    return null
  }

  async function ensureActiveThread(eventId: string): Promise<AiChatThread | null> {
    const existing = getActiveThread(eventId)
    if (existing) return existing
    const summaries = await loadEventThreads(eventId)
    if (summaries.length > 0) {
      const loaded = getActiveThread(eventId)
      if (loaded) return loaded
    }
    return await createThread(eventId)
  }

  async function selectThread(eventId: string, threadId: string): Promise<AiChatThread | null> {
    const prevId = activeThreadIdByEvent.value[eventId]
    if (prevId && prevId !== threadId) {
      await flushPendingSaves(prevId)
    }
    activeThreadIdByEvent.value = { ...activeThreadIdByEvent.value, [eventId]: threadId }
    if (threadDetailsById.value[threadId]) {
      return threadDetailsById.value[threadId]!
    }
    return await fetchThreadDetail(eventId, threadId)
  }

  async function renameThread(eventId: string, threadId: string, newTitle: string): Promise<void> {
    const clean = newTitle.trim()
    if (!clean) return
    const thread = threadDetailsById.value[threadId] || (await fetchThreadDetail(eventId, threadId))
    if (!thread) return
    const prevTitle = thread.title
    const prevUpdatedAt = thread.updatedAt
    thread.title = clean
    syncSummaryFromThread(thread)
    const ok = await persistThreadNow(thread)
    if (!ok) {
      thread.title = prevTitle
      thread.updatedAt = prevUpdatedAt
      syncSummaryFromThread(thread)
    }
  }

  async function togglePinThread(eventId: string, threadId: string): Promise<void> {
    const thread = threadDetailsById.value[threadId] || (await fetchThreadDetail(eventId, threadId))
    if (!thread) return
    const prevPinned = thread.pinned
    const prevUpdatedAt = thread.updatedAt
    thread.pinned = !thread.pinned
    syncSummaryFromThread(thread)
    const ok = await persistThreadNow(thread)
    if (!ok) {
      thread.pinned = prevPinned
      thread.updatedAt = prevUpdatedAt
      syncSummaryFromThread(thread)
    }
  }

  async function deleteThread(eventId: string, threadId: string): Promise<boolean> {
    if (!userStore.token) return false
    hooks.onBeforeDeleteOrClearThread(threadId)
    deletedThreadIds.add(threadId)
    const timer = pendingSaveTimers.get(threadId)
    if (timer) {
      clearTimeout(timer)
      pendingSaveTimers.delete(threadId)
    }
    dirtyThreadEventMap.delete(threadId)
    const inFlightPut = inFlightPutControllers.get(threadId)
    if (inFlightPut) {
      inFlightPut.abort()
      inFlightPutControllers.delete(threadId)
    }

    try {
      const res = await aiFetch(`/api/events/${eventId}/ai-threads/${threadId}`, {
        method: 'DELETE',
        token: userStore.token,
        onRefreshedToken
      })
      if (res.ok || res.status === 404) {
        const nextDetails = { ...threadDetailsById.value }
        delete nextDetails[threadId]
        threadDetailsById.value = nextDetails

        const nextList = (threadsByEvent.value[eventId] || []).filter(t => t.id !== threadId)
        threadsByEvent.value = { ...threadsByEvent.value, [eventId]: nextList }

        if (activeThreadIdByEvent.value[eventId] === threadId) {
          if (nextList.length > 0) {
            await selectThread(eventId, nextList[0]!.id)
          } else {
            const nextMap = { ...activeThreadIdByEvent.value }
            delete nextMap[eventId]
            activeThreadIdByEvent.value = nextMap
          }
        }
        return true
      }
      deletedThreadIds.delete(threadId)
    } catch (e) {
      deletedThreadIds.delete(threadId)
      console.error('Failed to delete AI thread', e)
    }
    return false
  }

  function updateThreadContextConfig(eventId: string, patch: Partial<AiContextConfig>) {
    const thread = getActiveThread(eventId)
    if (!thread) return
    thread.contextConfig = normalizeContextConfig({
      ...thread.contextConfig,
      ...patch,
      sections: patch.sections
        ? { ...thread.contextConfig.sections, ...patch.sections }
        : thread.contextConfig.sections
    })
    scheduleSaveThread(thread)
  }

  function updateThreadPersona(eventId: string, personaId: string) {
    const thread = getActiveThread(eventId)
    if (!thread) return
    thread.personaId = personaId
    scheduleSaveThread(thread)
  }

  function deleteThreadMessage(eventId: string, messageId: string) {
    const thread = getActiveThread(eventId)
    if (!thread) return
    const idx = thread.messages.findIndex(m => m.id === messageId)
    if (idx !== -1) {
      thread.messages.splice(idx, 1)
      scheduleSaveThread(thread)
    }
  }

  async function clearThreadMessages(eventId: string) {
    const thread = getActiveThread(eventId)
    if (!thread) return
    hooks.onBeforeDeleteOrClearThread(thread.id)
    const timer = pendingSaveTimers.get(thread.id)
    if (timer) {
      clearTimeout(timer)
      pendingSaveTimers.delete(thread.id)
    }
    dirtyThreadEventMap.delete(thread.id)
    const inFlightPut = inFlightPutControllers.get(thread.id)
    if (inFlightPut) {
      inFlightPut.abort()
      inFlightPutControllers.delete(thread.id)
    }
    thread.messages = []
    await persistThreadNow(thread)
  }

  async function migratePlaceholderEvent(oldEventId: string, newEventId: string): Promise<void> {
    if (!oldEventId || !newEventId || oldEventId === newEventId) return
    if (draftPromptByEvent.value[oldEventId] && !draftPromptByEvent.value[newEventId]) {
      const nextDraft = { ...draftPromptByEvent.value, [newEventId]: draftPromptByEvent.value[oldEventId]! }
      delete nextDraft[oldEventId]
      draftPromptByEvent.value = nextDraft
    } else if (draftPromptByEvent.value[oldEventId] !== undefined) {
      const nextDraft = { ...draftPromptByEvent.value }
      delete nextDraft[oldEventId]
      draftPromptByEvent.value = nextDraft
    }
    if (pendingAutoSendByEvent.value[oldEventId] && !pendingAutoSendByEvent.value[newEventId]) {
      const nextAuto = { ...pendingAutoSendByEvent.value, [newEventId]: pendingAutoSendByEvent.value[oldEventId]! }
      delete nextAuto[oldEventId]
      pendingAutoSendByEvent.value = nextAuto
    } else if (pendingAutoSendByEvent.value[oldEventId] !== undefined) {
      const nextAuto = { ...pendingAutoSendByEvent.value }
      delete nextAuto[oldEventId]
      pendingAutoSendByEvent.value = nextAuto
    }
    if (threadsByEvent.value[oldEventId]) {
      const nextByEvent = { ...threadsByEvent.value }
      delete nextByEvent[oldEventId]
      threadsByEvent.value = nextByEvent
    }
    if (activeThreadIdByEvent.value[oldEventId]) {
      const nextActive = { ...activeThreadIdByEvent.value }
      delete nextActive[oldEventId]
      activeThreadIdByEvent.value = nextActive
    }
    await loadEventThreads(newEventId)
  }

  function resetUserSession() {
    for (const timer of pendingSaveTimers.values()) {
      clearTimeout(timer)
    }
    pendingSaveTimers.clear()
    dirtyThreadEventMap.clear()
    for (const ctrl of inFlightPutControllers.values()) {
      ctrl.abort()
    }
    inFlightPutControllers.clear()
    deletedThreadIds.clear()
    threadsByEvent.value = {}
    threadDetailsById.value = {}
    activeThreadIdByEvent.value = {}
    draftPromptByEvent.value = {}
    pendingAutoSendByEvent.value = {}
    loadingThreads.value = false
  }

  // Legacy event chat bridge
  async function fetchChatHistory(eventId: string) {
    if (!userStore.token) return []
    try {
      const res = await aiFetch(`/api/events/${eventId}/ai-chat`, {
        token: userStore.token,
        onRefreshedToken
      })
      if (res.ok) {
        return await res.json()
      }
    } catch (e) {
      console.error('Failed to fetch chat history', e)
    }
    return []
  }

  async function saveChatHistory(eventId: string, chatArray: any[]) {
    if (!userStore.token) return false
    try {
      const res = await aiFetch(`/api/events/${eventId}/ai-chat`, {
        method: 'PUT',
        token: userStore.token,
        onRefreshedToken,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(chatArray)
      })
      return res.ok
    } catch (e) {
      console.error('Failed to save chat history', e)
      return false
    }
  }

  return {
    threadsByEvent,
    threadDetailsById,
    activeThreadIdByEvent,
    loadingThreads,
    draftPromptByEvent,
    pendingAutoSendByEvent,
    getThreadsForEvent,
    getActiveThread,
    loadEventThreads,
    createThread,
    ensureActiveThread,
    selectThread,
    renameThread,
    togglePinThread,
    deleteThread,
    updateThreadContextConfig,
    updateThreadPersona,
    deleteThreadMessage,
    clearThreadMessages,
    scheduleSaveThread,
    flushPendingSaves,
    persistThreadNow,
    syncSummaryFromThread,
    fetchChatHistory,
    saveChatHistory,
    migratePlaceholderEvent,
    resetUserSession
  }
}
