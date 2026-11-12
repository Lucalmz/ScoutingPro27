import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
import { useScheduleStore } from '@/stores/schedule'
import { usePitScoutStore } from '@/stores/pitScout'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useScreenWakeLock } from '@/utils/wakeLock'
import {
  hapticFeedback,
  hapticLight,
  hapticMedium,
  hapticSelection,
  hapticSuccess,
  hapticWarning
} from '@/utils/haptics'
import type { ScoutingRecord, ScoutingFormData } from '@/types'
import { isAssignmentCompleted, getRecordTournamentLevel } from '@/utils/tournament'
import { formatUserFriendlyError } from '@/utils/errorHelper'

export interface MobileTeamScoutData {
  teamNumber: string
  // Auto
  autoLeave: boolean
  autoBalls: number
  autoCycles: number[]
  autoMissedCycles: number[]
  autoPark: boolean

  // TeleOp
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

export function createEmptyMobileTeam(): MobileTeamScoutData {
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

export function hasAnyMobileScoutData(t: MobileTeamScoutData): boolean {
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

export interface MobileWizardFormProps {
  eventId: string
  scoutId: string
  scoutName: string
  editRecord?: ScoutingRecord | null
  assignedTask?: { matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue'; tournamentLevel?: string } | null
}

export function useMobileWizardForm(
  props: MobileWizardFormProps,
  emit: {
    (e: 'submit', record: ScoutingRecord | ScoutingRecord[]): void
    (e: 'cancelEdit'): void
  }
) {
  const { t, te } = useI18n()
  const scheduleStore = useScheduleStore()
  const pitStore = usePitScoutStore()
  const customFieldsStore = useCustomFieldsStore()
  const recordStore = useRecordStore()

  // Wizard Navigation Step: 0 = Pre-match, 1 = Auto, 2 = TeleOp, 3 = Endgame, 4 = Summary
  const currentStep = ref<number>(0)

  const steps = [
    { id: 0, labelKey: 'wizard.pre_match', defaultLabel: '赛前准备', icon: 'flag' },
    { id: 1, labelKey: 'scouting.autonomous', defaultLabel: '自动阶段', icon: 'smart_toy' },
    { id: 2, labelKey: 'scouting.teleop', defaultLabel: '手动驾驶', icon: 'sports_esports' },
    { id: 3, labelKey: 'scouting.endgame', defaultLabel: '残局阶段', icon: 'timer' },
    { id: 4, labelKey: 'wizard.review_submit', defaultLabel: '核对提交', icon: 'fact_check' }
  ]

  // Form State
  const matchNumber = ref('1')
  const allianceColor = ref<'none' | 'red' | 'blue'>('none')
  const currentTournamentLevel = ref<string>('QUALIFICATION')
  const team = ref<MobileTeamScoutData>(createEmptyMobileTeam())

  // Screen WakeLock for continuous display during matches
  useScreenWakeLock()

  function incrementMatch() {
    const n = parseInt(matchNumber.value) || 0
    matchNumber.value = String(n + 1)
    hapticSelection()
  }

  function decrementMatch() {
    const n = parseInt(matchNumber.value) || 1
    if (n > 1) {
      matchNumber.value = String(n - 1)
      hapticSelection()
    }
  }

  // Operation history stack for precise undo ('hit' | 'miss')
  const autoCycleHistory = ref<('hit' | 'miss')[]>([])
  const teleopCycleHistory = ref<('hit' | 'miss')[]>([])

  // Pulsing glow flags for "+ 下一轮" button when 4 balls cap is reached
  const autoPulsingGlow = ref(false)
  const teleopPulsingGlow = ref(false)
  let autoGlowTimer: any = null
  let teleopGlowTimer: any = null

  function triggerPulsingGlow(phase: 'auto' | 'teleop') {
    if (phase === 'auto') {
      autoPulsingGlow.value = true
      if (autoGlowTimer) clearTimeout(autoGlowTimer)
      autoGlowTimer = setTimeout(() => { autoPulsingGlow.value = false }, 3500)
    } else {
      teleopPulsingGlow.value = true
      if (teleopGlowTimer) clearTimeout(teleopGlowTimer)
      teleopGlowTimer = setTimeout(() => { teleopPulsingGlow.value = false }, 3500)
    }
  }

  function clearPulsingGlow(phase: 'auto' | 'teleop') {
    if (phase === 'auto') {
      autoPulsingGlow.value = false
      if (autoGlowTimer) clearTimeout(autoGlowTimer)
    } else {
      teleopPulsingGlow.value = false
      if (teleopGlowTimer) clearTimeout(teleopGlowTimer)
    }
  }

  // Draft Auto-Save & Restore across screen lock/reload
  const draftKey = computed(() => `sp27_mobile_active_draft_${props.eventId}`)
  const isDraftRestored = ref(false)
  let draftDebounceTimer: any = null

  function syncAutoBalls() {
    team.value.autoBalls = team.value.autoCycles.reduce((sum, b) => sum + b, 0)
  }

  function saveDraft() {
    if (props.editRecord) return
    if (typeof localStorage === 'undefined') return
    clearTimeout(draftDebounceTimer)
    draftDebounceTimer = setTimeout(() => {
      if (typeof localStorage === 'undefined') return
      if (!hasAnyMobileScoutData(team.value) && allianceColor.value === 'none') {
        localStorage.removeItem(draftKey.value)
        return
      }
      const draftPayload = {
        matchNumber: matchNumber.value,
        allianceColor: allianceColor.value,
        currentTournamentLevel: currentTournamentLevel.value,
        team: team.value,
        currentStep: currentStep.value,
        savedAt: Date.now()
      }
      localStorage.setItem(draftKey.value, JSON.stringify(draftPayload))
    }, 500)
  }

  function restoreDraft() {
    if (props.editRecord || props.assignedTask) return
    if (typeof localStorage === 'undefined') return
    try {
      const raw = localStorage.getItem(draftKey.value)
      if (!raw) return
      const draft = JSON.parse(raw)
      if (draft.savedAt && Date.now() - draft.savedAt > 24 * 60 * 60 * 1000) {
        localStorage.removeItem(draftKey.value)
        return
      }
      if (draft && draft.team) {
        matchNumber.value = draft.matchNumber || matchNumber.value
        allianceColor.value = draft.allianceColor || allianceColor.value
        currentTournamentLevel.value = draft.currentTournamentLevel || currentTournamentLevel.value
        team.value = { ...createEmptyMobileTeam(), ...draft.team }
        syncAutoBalls()
        currentStep.value = typeof draft.currentStep === 'number' ? draft.currentStep : 0
        isDraftRestored.value = true
      }
    } catch (e) {
      console.warn('[MobileScout] Failed to restore draft:', e)
    }
  }

  onUnmounted(() => {
    if (draftDebounceTimer) {
      clearTimeout(draftDebounceTimer)
      try {
        if (hasAnyMobileScoutData(team.value) && !props.editRecord && typeof localStorage !== 'undefined') {
          const draftPayload = {
            matchNumber: matchNumber.value,
            allianceColor: allianceColor.value,
            currentTournamentLevel: currentTournamentLevel.value,
            team: team.value,
            currentStep: currentStep.value,
            savedAt: Date.now()
          }
          localStorage.setItem(draftKey.value, JSON.stringify(draftPayload))
        }
      } catch {}
      draftDebounceTimer = null
    }
  })

  function clearDraft() {
    clearTimeout(draftDebounceTimer)
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(draftKey.value)
    }
    isDraftRestored.value = false
  }

  onMounted(() => {
    restoreDraft()
  })

  watch(
    [matchNumber, allianceColor, currentTournamentLevel, team, currentStep],
    () => {
      saveDraft()
    },
    { deep: true }
  )

  // Localized Quick notes presets
  const quickNotesPresets = computed(() => [
    { key: 'defense', label: t('wizard.tag_defense') || '防守强' },
    { key: 'slipping', label: t('wizard.tag_slipping') || '底盘打滑' },
    { key: 'mechanics', label: t('wizard.tag_mechanics') || '掉链/脱困' },
    { key: 'accuracy', label: t('wizard.tag_accuracy') || '高命中率' },
    { key: 'fouls', label: t('wizard.tag_fouls') || '违规判罚' },
    { key: 'synergy', label: t('wizard.tag_synergy') || '配合默契' }
  ])

  function toggleQuickNote(noteText: string) {
    hapticSelection()
    const current = team.value.notes.trim()
    if (!current) {
      team.value.notes = noteText
      return
    }
    const parts = current.split(/[,，\s]+/)
    if (parts.includes(noteText)) {
      team.value.notes = parts.filter(p => p !== noteText).join('，')
    } else {
      team.value.notes = `${current}，${noteText}`
    }
  }

  // Pit Scout Summary for Team
  const pitSummary = computed(() => {
    const num = parseInt(team.value.teamNumber)
    if (!num) return null
    const u = pitStore.getUnifiedTeam(num)
    if (!u?.pitRecord) return null
    const r = u.pitRecord
    return {
      drivetrain: r.drivetrainType || '-',
      ballCompatibility: r.ballCompatibility || 'universal',
      autoScore: r.claimedAutoScore ?? 0,
      teleopCycles: r.claimedTeleopCycles ?? 0
    }
  })

  const autoCustomDefinitions = computed(() => {
    return customFieldsStore.getActiveFields?.(props.eventId, 'MATCH', 'auto') || []
  })

  const teleopCustomDefinitions = computed(() => {
    return customFieldsStore.getActiveFields?.(props.eventId, 'MATCH', 'teleop') || []
  })

  const customDefinitions = computed(() => {
    return [
      ...(customFieldsStore.getActiveFields?.(props.eventId, 'MATCH', 'endgame') || []),
      ...(customFieldsStore.getActiveFields?.(props.eventId, 'MATCH', 'overall') || [])
    ]
  })

  function getTeleopBallsTotal(): number {
    return team.value.teleopCycles.reduce((sum, b) => sum + b, 0)
  }

  function getTeleopMissedTotal(): number {
    return team.value.teleopMissedCycles.reduce((sum, b) => sum + b, 0)
  }

  const autoScore = computed(() => {
    return (team.value.autoLeave ? 3 : 0) +
           ((team.value.autoBalls || 0) * 3) +
           (team.value.autoPark ? 5 : 0)
  })

  const teleopScore = computed(() => {
    return getTeleopBallsTotal() * 2
  })

  const endgameScore = computed(() => {
    return (team.value.flowerPlaced ? 10 : 0) +
           (team.value.flowerBottomBonus ? 5 : 0) +
           (team.value.teleopPark ? 5 : 0)
  })

  const totalScore = computed(() => {
    return autoScore.value + teleopScore.value + endgameScore.value
  })

  // Auto cycle helpers
  const lastAutoCycleIndex = computed(() => team.value.autoCycles.length - 1)
  const currentAutoHits = computed(() => {
    if (team.value.autoCycles.length === 0) return 0
    return team.value.autoCycles[lastAutoCycleIndex.value] ?? 0
  })
  const currentAutoMisses = computed(() => {
    if (team.value.autoMissedCycles.length === 0) return 0
    return team.value.autoMissedCycles[lastAutoCycleIndex.value] ?? 0
  })
  const currentAutoAttempts = computed(() => currentAutoHits.value + currentAutoMisses.value)
  const canStartNewAutoCycle = computed(() => {
    if (team.value.autoCycles.length === 0) return true
    return currentAutoAttempts.value > 0
  })

  // TeleOp cycle helpers
  const lastTeleopCycleIndex = computed(() => team.value.teleopCycles.length - 1)
  const currentTeleopHits = computed(() => {
    if (team.value.teleopCycles.length === 0) return 0
    return team.value.teleopCycles[lastTeleopCycleIndex.value] ?? 0
  })
  const currentTeleopMisses = computed(() => {
    if (team.value.teleopMissedCycles.length === 0) return 0
    return team.value.teleopMissedCycles[lastTeleopCycleIndex.value] ?? 0
  })
  const currentTeleopAttempts = computed(() => currentTeleopHits.value + currentTeleopMisses.value)
  const canStartNewTeleopCycle = computed(() => {
    if (team.value.teleopCycles.length === 0) return true
    return currentTeleopAttempts.value > 0
  })
  const teleopAccuracy = computed(() => {
    const attempts = getTeleopBallsTotal() + getTeleopMissedTotal()
    if (attempts === 0) return '--'
    return `${Math.round((getTeleopBallsTotal() / attempts) * 100)}%`
  })

  // Auto phase actions
  function addAutoBall() {
    if (team.value.autoCycles.length === 0) {
      team.value.autoCycles.push(1)
      team.value.autoMissedCycles.push(0)
      autoCycleHistory.value.push('hit')
      hapticMedium()
      syncAutoBalls()
      return
    }

    const idx = lastAutoCycleIndex.value
    const curHits = team.value.autoCycles[idx] ?? 0
    const curMisses = team.value.autoMissedCycles[idx] ?? 0

    if (curHits + curMisses < 4) {
      team.value.autoCycles[idx] = curHits + 1
      autoCycleHistory.value.push('hit')
      hapticMedium()
      if (curHits + 1 + curMisses >= 4) {
        triggerPulsingGlow('auto')
      }
      syncAutoBalls()
    } else {
      hapticWarning()
      triggerPulsingGlow('auto')
    }
  }

  function addAutoMiss() {
    if (team.value.autoCycles.length === 0) {
      team.value.autoCycles.push(0)
      team.value.autoMissedCycles.push(1)
      autoCycleHistory.value.push('miss')
      hapticWarning()
      return
    }

    const idx = lastAutoCycleIndex.value
    const curHits = team.value.autoCycles[idx] ?? 0
    const curMisses = team.value.autoMissedCycles[idx] ?? 0

    if (curHits + curMisses < 4) {
      team.value.autoMissedCycles[idx] = curMisses + 1
      autoCycleHistory.value.push('miss')
      hapticWarning()
      if (curHits + curMisses + 1 >= 4) {
        triggerPulsingGlow('auto')
      }
    } else {
      hapticWarning()
      triggerPulsingGlow('auto')
    }
  }

  function setAutoPresetBalls(val: number) {
    if (team.value.autoCycles.length === 0) {
      team.value.autoCycles.push(val)
      team.value.autoMissedCycles.push(0)
      autoCycleHistory.value = []
      if (val >= 4) triggerPulsingGlow('auto')
      hapticSelection()
      syncAutoBalls()
      return
    }
    const idx = lastAutoCycleIndex.value
    const curMisses = team.value.autoMissedCycles[idx] ?? 0
    const newHits = val
    const newMisses = Math.min(curMisses, 4 - val)
    team.value.autoCycles[idx] = newHits
    team.value.autoMissedCycles[idx] = newMisses
    autoCycleHistory.value = []
    if (newHits + newMisses >= 4) {
      triggerPulsingGlow('auto')
    } else {
      clearPulsingGlow('auto')
    }
    hapticSelection()
    syncAutoBalls()
  }

  function handleNewAutoCycle() {
    if (!canStartNewAutoCycle.value) {
      hapticWarning()
      return
    }
    team.value.autoCycles.push(0)
    team.value.autoMissedCycles.push(0)
    autoCycleHistory.value = []
    clearPulsingGlow('auto')
    hapticMedium()
  }

  function undoAuto() {
    if (team.value.autoCycles.length === 0) return

    const idx = lastAutoCycleIndex.value
    const curHits = team.value.autoCycles[idx] ?? 0
    const curMisses = team.value.autoMissedCycles[idx] ?? 0

    if (autoCycleHistory.value.length > 0) {
      const lastAction = autoCycleHistory.value.pop()
      if (lastAction === 'hit' && curHits > 0) {
        team.value.autoCycles[idx] = curHits - 1
        clearPulsingGlow('auto')
        hapticLight()
        syncAutoBalls()
        return
      } else if (lastAction === 'miss' && curMisses > 0) {
        team.value.autoMissedCycles[idx] = curMisses - 1
        clearPulsingGlow('auto')
        hapticLight()
        return
      }
    }

    if (curHits > 0) {
      team.value.autoCycles[idx] = curHits - 1
      clearPulsingGlow('auto')
      hapticLight()
      syncAutoBalls()
      return
    } else if (curMisses > 0) {
      team.value.autoMissedCycles[idx] = curMisses - 1
      clearPulsingGlow('auto')
      hapticLight()
      return
    }

    if (team.value.autoCycles.length > 0) {
      team.value.autoCycles.pop()
      team.value.autoMissedCycles.pop()
      autoCycleHistory.value = []
      clearPulsingGlow('auto')
      hapticLight()
      syncAutoBalls()
    }
  }

  // TeleOp Phase Actions
  function addTeleopCycleShot() {
    if (team.value.teleopCycles.length === 0) {
      team.value.teleopCycles.push(1)
      team.value.teleopMissedCycles.push(0)
      teleopCycleHistory.value.push('hit')
      hapticMedium()
      return
    }

    const idx = lastTeleopCycleIndex.value
    const curHits = team.value.teleopCycles[idx] ?? 0
    const curMisses = team.value.teleopMissedCycles[idx] ?? 0

    if (curHits + curMisses < 4) {
      team.value.teleopCycles[idx] = curHits + 1
      teleopCycleHistory.value.push('hit')
      hapticMedium()
      if (curHits + 1 + curMisses >= 4) {
        triggerPulsingGlow('teleop')
      }
    } else {
      hapticWarning()
      triggerPulsingGlow('teleop')
    }
  }

  function addTeleopMiss() {
    if (team.value.teleopCycles.length === 0) {
      team.value.teleopCycles.push(0)
      team.value.teleopMissedCycles.push(1)
      teleopCycleHistory.value.push('miss')
      hapticWarning()
      return
    }

    const idx = lastTeleopCycleIndex.value
    const curHits = team.value.teleopCycles[idx] ?? 0
    const curMisses = team.value.teleopMissedCycles[idx] ?? 0

    if (curHits + curMisses < 4) {
      team.value.teleopMissedCycles[idx] = curMisses + 1
      teleopCycleHistory.value.push('miss')
      hapticWarning()
      if (curHits + curMisses + 1 >= 4) {
        triggerPulsingGlow('teleop')
      }
    } else {
      hapticWarning()
      triggerPulsingGlow('teleop')
    }
  }

  function setTeleopPresetBalls(val: number) {
    if (team.value.teleopCycles.length === 0) {
      team.value.teleopCycles.push(val)
      team.value.teleopMissedCycles.push(0)
      teleopCycleHistory.value = []
      if (val >= 4) triggerPulsingGlow('teleop')
      hapticSelection()
      return
    }
    const idx = lastTeleopCycleIndex.value
    const curMisses = team.value.teleopMissedCycles[idx] ?? 0
    const newHits = val
    const newMisses = Math.min(curMisses, 4 - val)
    team.value.teleopCycles[idx] = newHits
    team.value.teleopMissedCycles[idx] = newMisses
    teleopCycleHistory.value = []
    if (newHits + newMisses >= 4) {
      triggerPulsingGlow('teleop')
    } else {
      clearPulsingGlow('teleop')
    }
    hapticSelection()
  }

  function handleNewTeleopCycle() {
    if (!canStartNewTeleopCycle.value) {
      hapticWarning()
      return
    }
    team.value.teleopCycles.push(0)
    team.value.teleopMissedCycles.push(0)
    teleopCycleHistory.value = []
    clearPulsingGlow('teleop')
    hapticMedium()
  }

  function undoTeleop() {
    if (team.value.teleopCycles.length === 0) return

    const idx = lastTeleopCycleIndex.value
    const curHits = team.value.teleopCycles[idx] ?? 0
    const curMisses = team.value.teleopMissedCycles[idx] ?? 0

    if (teleopCycleHistory.value.length > 0) {
      const lastAction = teleopCycleHistory.value.pop()
      if (lastAction === 'hit' && curHits > 0) {
        team.value.teleopCycles[idx] = curHits - 1
        clearPulsingGlow('teleop')
        hapticLight()
        return
      } else if (lastAction === 'miss' && curMisses > 0) {
        team.value.teleopMissedCycles[idx] = curMisses - 1
        clearPulsingGlow('teleop')
        hapticLight()
        return
      }
    }

    if (curHits > 0) {
      team.value.teleopCycles[idx] = curHits - 1
      clearPulsingGlow('teleop')
      hapticLight()
      return
    } else if (curMisses > 0) {
      team.value.teleopMissedCycles[idx] = curMisses - 1
      clearPulsingGlow('teleop')
      hapticLight()
      return
    }

    if (team.value.teleopCycles.length > 0) {
      team.value.teleopCycles.pop()
      team.value.teleopMissedCycles.pop()
      teleopCycleHistory.value = []
      clearPulsingGlow('teleop')
      hapticLight()
    }
  }

  function removeCycleAtIndex(index: number, phase: 'auto' | 'teleop' = 'teleop') {
    hapticLight()
    const targetCycles = phase === 'auto' ? team.value.autoCycles : team.value.teleopCycles
    const targetMissed = phase === 'auto' ? team.value.autoMissedCycles : team.value.teleopMissedCycles
    if (index >= 0 && index < targetCycles.length) {
      targetCycles.splice(index, 1)
      if (index < targetMissed.length) {
        targetMissed.splice(index, 1)
      }
      if (phase === 'auto') syncAutoBalls()
    }
  }

  function decrementCycleAtIndex(index: number, phase: 'auto' | 'teleop' = 'teleop') {
    hapticLight()
    const targetCycles = phase === 'auto' ? team.value.autoCycles : team.value.teleopCycles
    const targetMissed = phase === 'auto' ? team.value.autoMissedCycles : team.value.teleopMissedCycles
    if (index >= 0 && index < targetCycles.length) {
      const cur = targetCycles[index] ?? 1
      if (cur > 1) {
        targetCycles[index] = cur - 1
      } else {
        targetCycles.splice(index, 1)
        if (index < targetMissed.length) {
          targetMissed.splice(index, 1)
        }
      }
      if (phase === 'auto') syncAutoBalls()
    }
  }

  // Schedule Task Matching
  const nextPendingAssignment = computed(() => {
    if (!props.scoutId) return null
    const myTasks = scheduleStore.myAssignments(props.scoutId)
    for (const t of myTasks) {
      const isDone = isAssignmentCompleted(
        { matchNumber: t.matchNumber, teamNumber: t.teamNumber, tournamentLevel: t.assignment.tournamentLevel },
        props.scoutId,
        recordStore.activeRecords,
        { matchAnyScout: true }
      )
      if (!isDone) {
        const color: 'red' | 'blue' = t.station.startsWith('red') ? 'red' : 'blue'
        return {
          matchNumber: t.matchNumber,
          teamNumber: t.teamNumber,
          allianceColor: color,
          station: t.station,
          tournamentLevel: t.assignment.tournamentLevel
        }
      }
    }
    return null
  })

  function applyTask(task: { matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue'; tournamentLevel?: string }) {
    matchNumber.value = String(task.matchNumber)
    allianceColor.value = task.allianceColor
    currentTournamentLevel.value = task.tournamentLevel || 'QUALIFICATION'
    team.value.teamNumber = String(task.teamNumber)
    hapticFeedback(20)
  }

  watch(() => props.assignedTask, (task) => {
    if (task) {
      applyTask(task)
    }
  }, { immediate: true })

  // Watch editRecord
  watch(() => props.editRecord, (rec: ScoutingRecord | null | undefined) => {
    if (rec) {
      let raw: Partial<ScoutingFormData> = {}
      try {
        raw = JSON.parse(rec.rawData) as Partial<ScoutingFormData>
      } catch {
        // Fallback
      }
      matchNumber.value = String(rec.matchNumber)
      allianceColor.value = raw.allianceColor || 'none'
      currentTournamentLevel.value = raw.tournamentLevel || 'QUALIFICATION'
      const legacyAutoBalls = (raw.autoPreload ? 1 : 0) + (raw.autoSecondary ? 1 : 0)
      const rawAutoBalls = typeof raw.autoBalls === 'number' ? raw.autoBalls : legacyAutoBalls
      const autoCycles = Array.isArray(raw.autoCycles)
        ? [...raw.autoCycles]
        : (rawAutoBalls > 0 ? [rawAutoBalls] : [])

      team.value = {
        teamNumber: String(rec.teamNumber),
        autoLeave: raw.autoLeave ?? false,
        autoBalls: rawAutoBalls,
        autoCycles: autoCycles,
        autoMissedCycles: Array.isArray(raw.autoMissedCycles) ? [...raw.autoMissedCycles] : [],
        autoPark: raw.autoPark ?? false,
        teleopCycles: Array.isArray(raw.teleopCycles) ? [...raw.teleopCycles] : [],
        teleopMissedCycles: Array.isArray(raw.teleopMissedCycles) ? [...raw.teleopMissedCycles] : [],
        flowerPlaced: raw.flowerPlaced ?? false,
        flowerBottomBonus: raw.flowerBottomBonus ?? false,
        teleopPark: raw.teleopPark ?? false,
        isBroken: raw.isBroken ?? false,
        notes: rec.notes || '',
        customFields: raw.customFields ? { ...raw.customFields } : {}
      }
      currentStep.value = 0
    }
  }, { immediate: true })

  // Step Navigation Guards
  const canGoToAuto = computed(() => {
    const isMatchValid = /^\d{1,8}$/.test(matchNumber.value) && parseInt(matchNumber.value) > 0
    const isTeamValid = /^\d{1,8}$/.test(team.value.teamNumber) && parseInt(team.value.teamNumber) > 0
    const isColorValid = allianceColor.value !== 'none'
    return isMatchValid && isTeamValid && isColorValid
  })

  function goToStep(step: number) {
    if (step > currentStep.value && currentStep.value === 0 && !canGoToAuto.value) {
      hapticWarning()
      return
    }
    hapticLight()
    currentStep.value = step
  }

  function nextStep() {
    if (currentStep.value === 0 && !canGoToAuto.value) {
      hapticWarning()
      return
    }
    if (currentStep.value < 4) {
      hapticMedium()
      currentStep.value++
    }
  }

  function prevStep() {
    if (currentStep.value > 0) {
      hapticLight()
      currentStep.value--
    }
  }

  // Submit Handling
  const submitting = ref(false)
  const submitStatus = ref<'none' | 'success' | 'error'>('none')
  const submitErrorMsg = ref('')

  async function handleSubmit() {
    if (submitting.value) return
    if (!canGoToAuto.value) {
      hapticWarning()
      submitStatus.value = 'error'
      submitErrorMsg.value = t('scouting.invalid_input_hint') || '请完善赛前基本信息'
      currentStep.value = 0
      setTimeout(() => { submitStatus.value = 'none' }, 2500)
      return
    }

    const matchNum = parseInt(matchNumber.value)
    const teamNum = parseInt(team.value.teamNumber)
    const curLevel = (currentTournamentLevel.value || 'QUALIFICATION').toUpperCase()

    const isEditingOriginalMatchAndTeam =
      props.editRecord &&
      props.editRecord.matchNumber === matchNum &&
      props.editRecord.teamNumber === teamNum &&
      getRecordTournamentLevel(props.editRecord) === curLevel

    if (!isEditingOriginalMatchAndTeam) {
      const existing = recordStore.activeRecords.find(r => {
        if (r.matchNumber !== matchNum || r.teamNumber !== teamNum || r.scoutId !== props.scoutId) return false
        if (props.editRecord && r.id === props.editRecord.id) return false
        return getRecordTournamentLevel(r) === curLevel
      })

      if (existing) {
        hapticWarning()
        submitStatus.value = 'error'
        submitErrorMsg.value = t('toast.conflict_error', { match: matchNum, team: teamNum })
        setTimeout(() => { submitStatus.value = 'none' }, 4000)
        return
      }
    }

    submitting.value = true
    submitStatus.value = 'none'

    try {
      const formData: ScoutingFormData = {
        matchNumber: matchNum,
        tournamentLevel: currentTournamentLevel.value,
        teamNumber: teamNum,
        allianceColor: allianceColor.value,
        isBroken: team.value.isBroken,
        autoLeave: team.value.autoLeave,
        autoBalls: team.value.autoBalls || 0,
        autoCycles: [...team.value.autoCycles],
        autoMissedCycles: [...team.value.autoMissedCycles],
        autoPreload: (team.value.autoBalls || 0) > 0,
        autoPark: team.value.autoPark,
        teleopCycles: [...team.value.teleopCycles],
        teleopMissedCycles: [...team.value.teleopMissedCycles],
        flowerPlaced: team.value.flowerPlaced,
        flowerBottomBonus: team.value.flowerBottomBonus,
        teleopPark: team.value.teleopPark,
        customFields: { ...team.value.customFields }
      }

      const record: ScoutingRecord = {
        id: props.editRecord ? props.editRecord.id : (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`),
        eventId: props.eventId,
        scoutId: props.editRecord ? (props.editRecord.scoutId || props.scoutId) : props.scoutId,
        scoutName: props.editRecord ? (props.editRecord.scoutName || props.scoutName) : props.scoutName,
        matchNumber: matchNum,
        teamNumber: teamNum,
        autoScore: autoScore.value,
        teleopScore: teleopScore.value,
        endgameScore: endgameScore.value,
        totalScore: totalScore.value,
        notes: team.value.notes,
        rawData: JSON.stringify(formData),
        syncStatus: 'PENDING',
        createdAt: props.editRecord ? props.editRecord.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isBroken: team.value.isBroken,
        version: props.editRecord ? (props.editRecord.version || 0) : 0,
        hostSeq: props.editRecord ? props.editRecord.hostSeq : undefined,
      }

      emit('submit', record)
      submitStatus.value = 'success'
      hapticSuccess()
      clearDraft()

      if (!props.editRecord) {
        matchNumber.value = String(matchNum + 1)
        allianceColor.value = 'none'
        team.value = createEmptyMobileTeam()
        currentStep.value = 0
      } else {
        emit('cancelEdit')
      }
    } catch (err) {
      hapticWarning()
      submitStatus.value = 'error'
      const { message } = formatUserFriendlyError(err, t('scouting.submit_failed') || '提交失败，请重试')
      submitErrorMsg.value = message
    } finally {
      setTimeout(() => {
        submitting.value = false
      }, 800)
      setTimeout(() => {
        submitStatus.value = 'none'
      }, 2500)
    }
  }

  return {
    t,
    te,
    recordStore,
    currentStep,
    steps,
    matchNumber,
    allianceColor,
    currentTournamentLevel,
    team,
    incrementMatch,
    decrementMatch,
    autoPulsingGlow,
    teleopPulsingGlow,
    isDraftRestored,
    clearDraft,
    quickNotesPresets,
    toggleQuickNote,
    pitSummary,
    autoCustomDefinitions,
    teleopCustomDefinitions,
    customDefinitions,
    getTeleopBallsTotal,
    getTeleopMissedTotal,
    autoScore,
    teleopScore,
    endgameScore,
    totalScore,
    lastAutoCycleIndex,
    currentAutoHits,
    currentAutoMisses,
    currentAutoAttempts,
    canStartNewAutoCycle,
    lastTeleopCycleIndex,
    currentTeleopHits,
    currentTeleopMisses,
    currentTeleopAttempts,
    canStartNewTeleopCycle,
    teleopAccuracy,
    addAutoBall,
    addAutoMiss,
    setAutoPresetBalls,
    handleNewAutoCycle,
    undoAuto,
    addTeleopCycleShot,
    addTeleopMiss,
    setTeleopPresetBalls,
    handleNewTeleopCycle,
    undoTeleop,
    removeCycleAtIndex,
    decrementCycleAtIndex,
    nextPendingAssignment,
    applyTask,
    canGoToAuto,
    goToStep,
    nextStep,
    prevStep,
    submitting,
    submitStatus,
    submitErrorMsg,
    handleSubmit
  }
}
