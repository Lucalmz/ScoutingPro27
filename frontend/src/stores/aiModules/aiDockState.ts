import { ref } from 'vue'
import type { AiAssistantMode, AiThinkingMode } from '@/types'
import { DEFAULT_DOCK_WIDTH, MAX_DOCK_WIDTH, MIN_DOCK_WIDTH } from '@/components/ai/constants'

const KEY_DOCK_OPEN = 'sp27_ai_dock_open'
const KEY_DOCK_WIDTH = 'sp27_ai_dock_width'
const KEY_DOCK_EXPANDED = 'sp27_ai_dock_expanded'
const KEY_MY_TEAM_MAP = 'sp27_ai_my_team_by_event'
const KEY_AI_MODE = 'sp27_ai_mode'
const KEY_THINKING_MODE = 'sp27_ai_thinking_mode'

function normalizeThinkingMode(raw: string | null): AiThinkingMode {
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'off') {
    return raw
  }
  return 'off'
}

function normalizeAiMode(raw: string | null): AiAssistantMode {
  return raw === 'turbo' ? 'turbo' : 'ask'
}

export function readAiStorage(key: string): string | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(key)
    }
  } catch {
    // ignore storage restriction
  }
  return null
}

export function writeAiStorage(key: string, val: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, val)
    }
  } catch {
    // ignore storage restriction
  }
}

export function removeAiStorage(key: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(key)
    }
  } catch {
    // ignore storage restriction
  }
}

function budgetToThinkingMode(budget?: number | null): AiThinkingMode {
  if (typeof budget !== 'number' || !Number.isFinite(budget)) return 'medium'
  if (budget <= 1024) return 'low'
  if (budget >= 8192) return 'high'
  return 'medium'
}

export function clampDockWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DOCK_WIDTH
  return Math.max(MIN_DOCK_WIDTH, Math.min(MAX_DOCK_WIDTH, Math.round(width)))
}

export function createAiDockState() {
  const isDockOpen = ref<boolean>(readAiStorage(KEY_DOCK_OPEN) === '1')
  const dockWidth = ref<number>(clampDockWidth(Number(readAiStorage(KEY_DOCK_WIDTH) || DEFAULT_DOCK_WIDTH)))
  const isDockExpanded = ref<boolean>(readAiStorage(KEY_DOCK_EXPANDED) === '1')
  const settingsModalOpen = ref(false)
  const settingsModalTargetProfileId = ref<string | null>(null)
  const threadSidebarOpen = ref(false)
  const aiMode = ref<AiAssistantMode>(normalizeAiMode(readAiStorage(KEY_AI_MODE)))
  const initialRawThinking = readAiStorage(KEY_THINKING_MODE)
  const thinkingMode = ref<AiThinkingMode>(normalizeThinkingMode(initialRawThinking))
  let hasManualThinkingOverride = initialRawThinking !== null

  const initialMyTeamMap = (() => {
    try {
      const raw = readAiStorage(KEY_MY_TEAM_MAP)
      return raw ? (JSON.parse(raw) as Record<string, number | null>) : {}
    } catch {
      return {}
    }
  })()
  const myTeamNumberByEvent = ref<Record<string, number | null>>(initialMyTeamMap)

  function setDockOpen(open: boolean) {
    isDockOpen.value = open
    writeAiStorage(KEY_DOCK_OPEN, open ? '1' : '0')
  }

  function toggleDock() {
    setDockOpen(!isDockOpen.value)
  }

  function setDockWidth(width: number) {
    const clamped = clampDockWidth(width)
    dockWidth.value = clamped
    writeAiStorage(KEY_DOCK_WIDTH, String(clamped))
  }

  function resetDockWidth() {
    setDockWidth(DEFAULT_DOCK_WIDTH)
  }

  function setDockExpanded(expanded: boolean) {
    isDockExpanded.value = expanded
    writeAiStorage(KEY_DOCK_EXPANDED, expanded ? '1' : '0')
  }

  function openSettingsModal(profileId?: string) {
    settingsModalTargetProfileId.value = profileId || null
    settingsModalOpen.value = true
  }

  function closeSettingsModal() {
    settingsModalOpen.value = false
  }

  function setAiMode(mode: AiAssistantMode) {
    const normalized = normalizeAiMode(mode)
    aiMode.value = normalized
    writeAiStorage(KEY_AI_MODE, normalized)
  }

  function setThinkingMode(mode: AiThinkingMode) {
    const normalized = normalizeThinkingMode(mode)
    hasManualThinkingOverride = true
    thinkingMode.value = normalized
    writeAiStorage(KEY_THINKING_MODE, normalized)
  }

  function syncThinkingModeFromProfile(profile: { enableThinking?: boolean; thinkingBudget?: number } | null) {
    if (hasManualThinkingOverride || !profile) return
    thinkingMode.value = profile.enableThinking ? budgetToThinkingMode(profile.thinkingBudget) : 'off'
  }

  function resetUserSession() {
    settingsModalOpen.value = false
    settingsModalTargetProfileId.value = null
    threadSidebarOpen.value = false
    const raw = readAiStorage(KEY_THINKING_MODE)
    hasManualThinkingOverride = raw !== null
    thinkingMode.value = normalizeThinkingMode(raw)
  }

  function getMyTeamNumber(eventId: string): number | null {
    return myTeamNumberByEvent.value[eventId] ?? null
  }

  function setMyTeamNumber(eventId: string, teamNum: number | null) {
    if (!eventId) return
    const next = { ...myTeamNumberByEvent.value }
    if (teamNum && Number.isFinite(teamNum) && teamNum > 0) {
      next[eventId] = Math.round(teamNum)
    } else {
      delete next[eventId]
    }
    myTeamNumberByEvent.value = next
    writeAiStorage(KEY_MY_TEAM_MAP, JSON.stringify(next))
  }

  return {
    isDockOpen,
    dockWidth,
    isDockExpanded,
    settingsModalOpen,
    settingsModalTargetProfileId,
    threadSidebarOpen,
    myTeamNumberByEvent,
    aiMode,
    thinkingMode,
    setDockOpen,
    toggleDock,
    setDockWidth,
    resetDockWidth,
    setDockExpanded,
    openSettingsModal,
    closeSettingsModal,
    setAiMode,
    setThinkingMode,
    syncThinkingModeFromProfile,
    resetUserSession,
    getMyTeamNumber,
    setMyTeamNumber
  }
}
