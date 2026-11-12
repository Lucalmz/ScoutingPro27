import { ref, computed, watch, onMounted, onUnmounted, type Ref } from 'vue'
import type { ScoutingRecord } from '@/types'

export interface TeamScoutData {
  teamNumber: string
  // Auto
  autoLeave: boolean
  autoBalls: number
  autoCycles: number[]
  autoMissedCycles: number[]
  autoPark: boolean

  // TeleOp (Cycle Tracker)
  teleopCycles: number[]
  teleopMissedCycles: number[]

  // Endgame
  flowerPlaced: boolean
  flowerBottomBonus: boolean
  teleopPark: boolean

  isBroken: boolean
  notes: string
  customFields: Record<string, any>
}

export function createEmptyTeam(): TeamScoutData {
  return {
    teamNumber: '',
    autoLeave: false,
    autoBalls: 0,
    autoCycles: [],
    autoMissedCycles: [],
    autoPark: false,
    teleopCycles: [],
    teleopMissedCycles: [],
    flowerPlaced: false,
    flowerBottomBonus: false,
    teleopPark: false,
    isBroken: false,
    notes: '',
    customFields: {}
  }
}

export function hasAnyScoutData(t: TeamScoutData): boolean {
  if (!t) return false
  return Boolean(
    t.teamNumber ||
    t.autoLeave ||
    t.autoBalls > 0 ||
    t.autoCycles.length > 0 ||
    t.autoMissedCycles.length > 0 ||
    t.autoPark ||
    t.teleopCycles.length > 0 ||
    t.teleopMissedCycles.length > 0 ||
    t.flowerPlaced ||
    t.flowerBottomBonus ||
    t.teleopPark ||
    t.isBroken ||
    (t.notes && t.notes.trim()) ||
    (t.customFields && Object.keys(t.customFields).length > 0)
  )
}

export interface UseScoutingDraftOptions {
  getEventId: () => string
  getEditRecord: () => ScoutingRecord | null | undefined
  getAssignedTask: () => { matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue'; tournamentLevel?: string } | null | undefined
  submitting: Ref<boolean>
  scoutMode: Ref<'single' | 'alliance'>
  allianceColor: Ref<'none' | 'red' | 'blue'>
  matchNumber: Ref<string>
  currentTournamentLevel: Ref<string>
  teamsData: Ref<TeamScoutData[]>
}

export function useScoutingDraft(options: UseScoutingDraftOptions) {
  const {
    getEventId,
    getEditRecord,
    getAssignedTask,
    submitting,
    scoutMode,
    allianceColor,
    matchNumber,
    currentTournamentLevel,
    teamsData
  } = options

  const draftKey = computed(() => `sp27_active_draft_${getEventId()}`)
  const isDraftRestored = ref(false)
  let draftDebounceTimer: any = null

  function saveDraft() {
    if (getEditRecord()) return
    if (typeof localStorage === 'undefined') return
    clearTimeout(draftDebounceTimer)
    draftDebounceTimer = setTimeout(() => {
      try {
        const activeTeams = scoutMode.value === 'single' ? teamsData.value.slice(0, 1) : teamsData.value
        const hasData = activeTeams.some(hasAnyScoutData)
        if (!hasData) {
          localStorage.removeItem(draftKey.value)
          return
        }
        const draftPayload = {
          matchNumber: matchNumber.value,
          allianceColor: allianceColor.value,
          currentTournamentLevel: currentTournamentLevel.value,
          scoutMode: scoutMode.value,
          teamsData: teamsData.value,
          savedAt: Date.now()
        }
        localStorage.setItem(draftKey.value, JSON.stringify(draftPayload))
      } catch {}
    }, 400)
  }

  function restoreDraft() {
    if (getEditRecord() || getAssignedTask()) return
    if (typeof localStorage === 'undefined') return
    try {
      const raw = localStorage.getItem(draftKey.value)
      if (!raw) return
      const parsed = JSON.parse(raw)
      // 24小时TTL过期失效保护
      if (parsed.savedAt && Date.now() - parsed.savedAt > 24 * 60 * 60 * 1000) {
        localStorage.removeItem(draftKey.value)
        return
      }
      if (parsed && Array.isArray(parsed.teamsData) && parsed.teamsData.length > 0) {
        matchNumber.value = parsed.matchNumber || '1'
        allianceColor.value = parsed.allianceColor || 'none'
        currentTournamentLevel.value = parsed.currentTournamentLevel || 'QUALIFICATION'
        scoutMode.value = parsed.scoutMode || 'single'
        teamsData.value = parsed.teamsData
        isDraftRestored.value = true
      }
    } catch {}
  }

  function clearDraft() {
    clearTimeout(draftDebounceTimer)
    draftDebounceTimer = null
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(draftKey.value)
    }
    isDraftRestored.value = false
  }

  onMounted(() => {
    restoreDraft()
  })

  onUnmounted(() => {
    if (draftDebounceTimer) {
      clearTimeout(draftDebounceTimer)
      // 卸载前若有未落盘防抖变更，立即同步刷入本地缓存，杜绝切Tab/息屏前400ms窗口丢失数据
      try {
        const activeTeams = scoutMode.value === 'single' ? teamsData.value.slice(0, 1) : teamsData.value
        const hasData = activeTeams.some(hasAnyScoutData)
        if (hasData && !getEditRecord() && typeof localStorage !== 'undefined') {
          const draftPayload = {
            matchNumber: matchNumber.value,
            allianceColor: allianceColor.value,
            currentTournamentLevel: currentTournamentLevel.value,
            scoutMode: scoutMode.value,
            teamsData: teamsData.value,
            savedAt: Date.now()
          }
          localStorage.setItem(draftKey.value, JSON.stringify(draftPayload))
        }
      } catch {}
      draftDebounceTimer = null
    }
  })

  watch(
    [matchNumber, allianceColor, currentTournamentLevel, scoutMode, teamsData],
    () => {
      saveDraft()
    },
    { deep: true }
  )

  return {
    draftKey,
    isDraftRestored,
    saveDraft,
    restoreDraft,
    clearDraft
  }
}
