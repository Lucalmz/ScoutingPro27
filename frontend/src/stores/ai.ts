import { watch } from 'vue'
import { defineStore } from 'pinia'
import { registerBeforeLogoutHook, useUserStore } from './user'
import { useEventStore } from './events'
import { DEFAULT_DOCK_WIDTH, MAX_DOCK_WIDTH, MIN_DOCK_WIDTH } from '@/components/ai/constants'
import { clampDockWidth, createAiDockState } from './aiModules/aiDockState'
import {
  createAiProfilesModule,
  type ConnectionCheckParams,
  type ConnectionCheckResponse
} from './aiModules/aiProfiles'
import {
  createAiThreadsModule,
  createDefaultContextConfig,
  type PendingAutoSendRequest
} from './aiModules/aiThreads'
import { createAiStreamingModule } from './aiModules/aiStreaming'

export { MIN_DOCK_WIDTH, MAX_DOCK_WIDTH, DEFAULT_DOCK_WIDTH, clampDockWidth, createDefaultContextConfig }
export type { ConnectionCheckParams, ConnectionCheckResponse, PendingAutoSendRequest }

export const useAiStore = defineStore('ai', () => {
  const userStore = useUserStore()
  const eventStore = useEventStore()

  const dock = createAiDockState()
  const profilesMod = createAiProfilesModule(userStore, {
    onActiveProfileChanged: profile => dock.syncThinkingModeFromProfile(profile)
  })

  let stopStreamingFn: (threadId?: string | null) => void = () => {}
  const threadsMod = createAiThreadsModule(userStore, {
    onBeforeDeleteOrClearThread: id => stopStreamingFn(id)
  })

  const streamingMod = createAiStreamingModule({
    userStore,
    activeProfile: profilesMod.activeProfile,
    canSendWithActiveProfile: profilesMod.canSendWithActiveProfile,
    aiMode: dock.aiMode,
    thinkingMode: dock.thinkingMode,
    setDockOpen: dock.setDockOpen,
    openSettingsModal: dock.openSettingsModal,
    threads: threadsMod
  })
  stopStreamingFn = streamingMod.stopStreaming

  function resetUserSession() {
    streamingMod.stopStreaming()
    threadsMod.resetUserSession()
    profilesMod.resetUserSession()
    dock.resetUserSession()
  }

  registerBeforeLogoutHook(async () => {
    await threadsMod.flushPendingSaves(undefined, false)
  })

  watch(
    () => userStore.userId,
    (newId, oldId) => {
      if (newId !== oldId) {
        resetUserSession()
      }
    },
    { flush: 'sync' }
  )

  watch(
    () => eventStore.currentEvent,
    (newEvt, oldEvt) => {
      if (
        oldEvt &&
        newEvt &&
        oldEvt.id !== newEvt.id &&
        oldEvt.inviteCode &&
        newEvt.inviteCode &&
        oldEvt.inviteCode === newEvt.inviteCode &&
        (oldEvt.id.startsWith('evt-') || oldEvt.id.startsWith('ext_')) &&
        !(newEvt.id.startsWith('evt-') || newEvt.id.startsWith('ext_'))
      ) {
        const oldMyTeam = dock.getMyTeamNumber(oldEvt.id)
        if (oldMyTeam && !dock.getMyTeamNumber(newEvt.id)) {
          dock.setMyTeamNumber(newEvt.id, oldMyTeam)
        }
        void threadsMod.migratePlaceholderEvent(oldEvt.id, newEvt.id)
      }
    },
    { flush: 'sync' }
  )

  return {
    // Dock & workspace UI state
    ...dock,

    // Multi-profile state & actions (+ backwards-compatible settings bridge)
    ...profilesMod,

    // Event threads & persistence actions
    threadsByEvent: threadsMod.threadsByEvent,
    threadDetailsById: threadsMod.threadDetailsById,
    activeThreadIdByEvent: threadsMod.activeThreadIdByEvent,
    loadingThreads: threadsMod.loadingThreads,
    draftPromptByEvent: threadsMod.draftPromptByEvent,
    pendingAutoSendByEvent: threadsMod.pendingAutoSendByEvent,
    getThreadsForEvent: threadsMod.getThreadsForEvent,
    getActiveThread: threadsMod.getActiveThread,
    loadEventThreads: threadsMod.loadEventThreads,
    createThread: threadsMod.createThread,
    ensureActiveThread: threadsMod.ensureActiveThread,
    selectThread: threadsMod.selectThread,
    renameThread: threadsMod.renameThread,
    togglePinThread: threadsMod.togglePinThread,
    deleteThread: threadsMod.deleteThread,
    updateThreadContextConfig: threadsMod.updateThreadContextConfig,
    updateThreadPersona: threadsMod.updateThreadPersona,
    deleteThreadMessage: threadsMod.deleteThreadMessage,
    clearThreadMessages: threadsMod.clearThreadMessages,
    scheduleSaveThread: threadsMod.scheduleSaveThread,
    flushPendingSaves: threadsMod.flushPendingSaves,
    fetchChatHistory: threadsMod.fetchChatHistory,
    saveChatHistory: threadsMod.saveChatHistory,

    // Streaming & workflow shortcuts
    ...streamingMod,

    resetUserSession
  }
})
