import { defineStore } from 'pinia'
import { useUserStore } from './user'
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

  const dock = createAiDockState()
  const profilesMod = createAiProfilesModule(userStore)

  let stopStreamingFn: (threadId?: string | null) => void = () => {}
  const threadsMod = createAiThreadsModule(userStore, {
    onBeforeDeleteOrClearThread: id => stopStreamingFn(id)
  })

  const streamingMod = createAiStreamingModule({
    userStore,
    activeProfile: profilesMod.activeProfile,
    canSendWithActiveProfile: profilesMod.canSendWithActiveProfile,
    setDockOpen: dock.setDockOpen,
    openSettingsModal: dock.openSettingsModal,
    threads: threadsMod
  })
  stopStreamingFn = streamingMod.stopStreaming

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
    ...streamingMod
  }
})
