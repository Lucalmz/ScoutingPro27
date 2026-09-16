<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
import { useScheduleStore } from '@/stores/schedule'
import { usePitScoutStore } from '@/stores/pitScout'
import { useCustomFieldsStore } from '@/stores/customFields'
import {
  hapticFeedback,
  hapticLight,
  hapticMedium,
  hapticSelection,
  hapticSuccess,
  hapticWarning
} from '@/utils/haptics'
import type { ScoutingRecord, ScoutingFormData } from '@/types'
import DynamicFieldsRenderer from '@/components/customFields/DynamicFieldsRenderer.vue'
import TagPicker from '@/components/common/TagPicker.vue'
import { isAssignmentCompleted, getRecordTournamentLevel } from '@/utils/tournament'
import { formatUserFriendlyError } from '@/utils/errorHelper'

const { t, te } = useI18n()

const props = defineProps<{
  eventId: string
  scoutId: string
  scoutName: string
  editRecord?: ScoutingRecord | null
  assignedTask?: { matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue'; tournamentLevel?: string } | null
}>()

const emit = defineEmits<{
  submit: [record: ScoutingRecord | ScoutingRecord[]]
  cancelEdit: []
}>()

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
  { id: 4, labelKey: 'scouting.total_score', defaultLabel: '核对提交', icon: 'fact_check' }
]

// Form State
const matchNumber = ref('1')
const allianceColor = ref<'none' | 'red' | 'blue'>('none')
const currentTournamentLevel = ref<string>('QUALIFICATION')

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

interface TeamScoutData {
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

function createEmptyTeam(): TeamScoutData {
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

const team = ref<TeamScoutData>(createEmptyTeam())

// Tap window grouping for TeleOp rapid tapping
let lastTeleopTapTime = 0
const TELEOP_TAP_WINDOW_MS = 2000

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

const customDefinitions = computed(() => {
  return [
    ...(customFieldsStore.getActiveFields?.(props.eventId, 'MATCH', 'endgame') || []),
    ...(customFieldsStore.getActiveFields?.(props.eventId, 'MATCH', 'overall') || [])
  ]
})

// Auto & TeleOp calculations
function syncAutoBalls() {
  team.value.autoBalls = team.value.autoCycles.reduce((sum, b) => sum + b, 0)
}

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

// Auto phase actions
function addAutoBall() {
  hapticMedium()
  if (team.value.autoCycles.length === 0) {
    team.value.autoCycles.push(1)
  } else {
    const lastIdx = team.value.autoCycles.length - 1
    const cur = team.value.autoCycles[lastIdx]
    if (cur !== undefined && cur < 4) {
      team.value.autoCycles[lastIdx] = cur + 1
    } else {
      team.value.autoCycles.push(1)
    }
  }
  syncAutoBalls()
}

function addAutoMiss() {
  hapticLight()
  if (team.value.autoMissedCycles.length === 0) {
    team.value.autoMissedCycles.push(1)
  } else {
    const lastIdx = team.value.autoMissedCycles.length - 1
    const cur = team.value.autoMissedCycles[lastIdx] || 0
    team.value.autoMissedCycles[lastIdx] = cur + 1
  }
}

function undoAuto() {
  hapticLight()
  if (team.value.autoCycles.length > 0) {
    const lastIdx = team.value.autoCycles.length - 1
    const cur = team.value.autoCycles[lastIdx]
    if (cur !== undefined && cur > 1) {
      team.value.autoCycles[lastIdx] = cur - 1
    } else {
      team.value.autoCycles.pop()
    }
    syncAutoBalls()
  }
}

// TeleOp Phase Actions
function addTeleopCycleShot() {
  hapticMedium()
  const now = Date.now()
  const isWithinWindow = (now - lastTeleopTapTime) < TELEOP_TAP_WINDOW_MS && team.value.teleopCycles.length > 0
  lastTeleopTapTime = now

  if (isWithinWindow) {
    const lastIdx = team.value.teleopCycles.length - 1
    const current = team.value.teleopCycles[lastIdx] ?? 0
    if (current < 4) {
      team.value.teleopCycles[lastIdx] = current + 1
      return
    }
  }
  // Start new cycle with 1 ball
  team.value.teleopCycles.push(1)
}

function addTeleopMiss() {
  hapticLight()
  if (team.value.teleopMissedCycles.length === 0) {
    team.value.teleopMissedCycles.push(1)
  } else {
    const lastIdx = team.value.teleopMissedCycles.length - 1
    const cur = team.value.teleopMissedCycles[lastIdx] || 0
    team.value.teleopMissedCycles[lastIdx] = cur + 1
  }
}

function undoTeleop() {
  hapticLight()
  if (team.value.teleopCycles.length > 0) {
    const lastIdx = team.value.teleopCycles.length - 1
    const cur = team.value.teleopCycles[lastIdx]
    if (cur !== undefined && cur > 1) {
      team.value.teleopCycles[lastIdx] = cur - 1
    } else {
      team.value.teleopCycles.pop()
    }
  }
}

function removeCycleAtIndex(index: number) {
  hapticLight()
  if (index >= 0 && index < team.value.teleopCycles.length) {
    team.value.teleopCycles.splice(index, 1)
  }
}

function decrementCycleAtIndex(index: number) {
  hapticLight()
  if (index >= 0 && index < team.value.teleopCycles.length) {
    const cur = team.value.teleopCycles[index] ?? 1
    if (cur > 1) {
      team.value.teleopCycles[index] = cur - 1
    } else {
      team.value.teleopCycles.splice(index, 1)
    }
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
      scoutId: props.scoutId,
      scoutName: props.scoutName,
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

    if (!props.editRecord) {
      matchNumber.value = String(matchNum + 1)
      allianceColor.value = 'none'
      team.value = createEmptyTeam()
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
</script>

<template>
  <div class="mobile-wizard-container" :class="[`color-${allianceColor}`, `step-${currentStep}`]">
    <!-- Edit Mode Header Banner -->
    <div v-if="editRecord" class="edit-mode-bar">
      <div class="edit-mode-info">
        <span class="material-icons" style="font-size: 16px; color: #f59e0b;">edit_note</span>
        <span>{{ t('history.btn_edit') }} (Match #{{ editRecord.matchNumber }} • #{{ editRecord.teamNumber }})</span>
      </div>
      <button type="button" class="btn-cancel-edit-chip" @click="emit('cancelEdit')">
        <span class="material-icons" style="font-size: 14px;">close</span>
        <span>{{ t('wizard.cancel_edit') }}</span>
      </button>
    </div>

    <!-- Step Progress Tabs Bar -->
    <div class="wizard-stepper">
      <button
        v-for="st in steps"
        :key="st.id"
        type="button"
        class="stepper-step"
        :class="{
          'is-active': currentStep === st.id,
          'is-completed': currentStep > st.id,
          'is-disabled': st.id > currentStep && currentStep === 0 && !canGoToAuto
        }"
        @click="goToStep(st.id)"
      >
        <div class="step-num-bubble">
          <span v-if="currentStep > st.id" class="material-icons" style="font-size: 13px;">check</span>
          <span v-else>{{ st.id + 1 }}</span>
        </div>
        <span class="step-label-text">{{ te(st.labelKey) ? t(st.labelKey) : st.defaultLabel }}</span>
      </button>
    </div>

    <!-- Wizard Content Body -->
    <div class="wizard-body">
      <!-- STEP 0: PRE-MATCH SETUP -->
      <section v-if="currentStep === 0" class="step-pane step-pre-match">
        <div class="pane-header">
          <h2 class="pane-title">{{ t('wizard.pre_match') }}</h2>
          <span class="pane-subtitle">{{ t('wizard.pre_match_sub') }}</span>
        </div>

        <!-- Assigned Task Card (if available) -->
        <div v-if="nextPendingAssignment" class="assigned-task-card" @click="applyTask(nextPendingAssignment)">
          <div class="task-card-icon">
            <span class="material-icons" style="color: #39ff14;">assignment_ind</span>
          </div>
          <div class="task-card-content">
            <div class="task-card-badge">{{ t('wizard.assigned_task') }}</div>
            <div class="task-card-title">
              Match #{{ nextPendingAssignment.matchNumber }} • Team #{{ nextPendingAssignment.teamNumber }}
              <span :class="nextPendingAssignment.allianceColor === 'red' ? 'text-red' : 'text-blue'">
                ({{ nextPendingAssignment.allianceColor === 'red' ? t('scouting.red') : t('scouting.blue') }})
              </span>
            </div>
          </div>
          <button type="button" class="btn-task-apply">{{ t('wizard.apply_task') }}</button>
        </div>

        <!-- Alliance Color Huge Selection Cards -->
        <div class="input-block">
          <label class="field-label">{{ t('scouting.alliance_color') }} *</label>
          <div class="alliance-grid">
            <button
              type="button"
              class="alliance-btn red-btn"
              :class="{ 'is-selected': allianceColor === 'red' }"
              @click="allianceColor = 'red'; hapticSelection()"
            >
              <div class="alliance-tag">RED ALLIANCE</div>
              <div class="alliance-label-row">
                <span class="alliance-dot red"></span>
                <span class="alliance-name">{{ t('scouting.red') }}</span>
              </div>
              <span v-if="allianceColor === 'red'" class="material-icons check-mark">check_circle</span>
            </button>

            <button
              type="button"
              class="alliance-btn blue-btn"
              :class="{ 'is-selected': allianceColor === 'blue' }"
              @click="allianceColor = 'blue'; hapticSelection()"
            >
              <div class="alliance-tag">BLUE ALLIANCE</div>
              <div class="alliance-label-row">
                <span class="alliance-dot blue"></span>
                <span class="alliance-name">{{ t('scouting.blue') }}</span>
              </div>
              <span v-if="allianceColor === 'blue'" class="material-icons check-mark">check_circle</span>
            </button>
          </div>
        </div>

        <!-- Tournament Level Switcher (Qual / Playoff) -->
        <div class="input-block">
          <label class="field-label">{{ t('wizard.tournament_level') }}</label>
          <div class="segmented-level-grid">
            <button
              type="button"
              class="btn-level-seg"
              :class="{ 'is-active': currentTournamentLevel === 'QUALIFICATION' }"
              @click="currentTournamentLevel = 'QUALIFICATION'; hapticSelection()"
            >
              {{ t('wizard.level_qual') }}
            </button>
            <button
              type="button"
              class="btn-level-seg"
              :class="{ 'is-active': currentTournamentLevel === 'PLAYOFF' }"
              @click="currentTournamentLevel = 'PLAYOFF'; hapticSelection()"
            >
              {{ t('wizard.level_playoff') }}
            </button>
          </div>
        </div>

        <!-- Match & Team Number Inputs -->
        <div class="input-row-grid">
          <div class="input-block">
            <label class="field-label">{{ t('wizard.match_no') }} *</label>
            <div class="number-stepper-wrap">
              <button
                type="button"
                class="btn-stepper btn-stepper-minus"
                @click="decrementMatch"
                :disabled="parseInt(matchNumber) <= 1"
              >-</button>
              <input
                type="number"
                inputmode="numeric"
                v-model="matchNumber"
                class="giant-num-input num-input-stepper"
                placeholder="1"
              />
              <button
                type="button"
                class="btn-stepper btn-stepper-plus"
                @click="incrementMatch"
              >+</button>
            </div>
          </div>

          <div class="input-block">
            <label class="field-label">{{ t('wizard.team_no') }} *</label>
            <div class="number-input-wrap">
              <input
                type="number"
                inputmode="numeric"
                v-model="team.teamNumber"
                class="giant-num-input"
                placeholder=""
              />
            </div>
          </div>
        </div>

        <!-- Banned Team Warning (Weak Team) -->
        <div v-if="recordStore.bannedTeams.includes(parseInt(team.teamNumber))" class="banned-warning-card">
          <span class="material-icons" style="font-size: 16px; color: #ef4444;">warning</span>
          <span>{{ t('scouting.banned_warning') }}</span>
        </div>

        <!-- Pit Scout Preview Pill (if available) -->
        <div v-if="pitSummary" class="pit-scout-pill">
          <span class="material-icons" style="font-size: 16px; color: #39ff14;">inventory_2</span>
          <span>{{ t('wizard.pit_preview') }}: {{ t('wizard.drivetrain') }} <strong>{{ pitSummary.drivetrain }}</strong> • {{ t('wizard.claimed_auto') }} <strong>{{ pitSummary.autoScore }}</strong> {{ t('wizard.pts_unit') }} • {{ t('wizard.claimed_teleop') }} <strong>{{ pitSummary.teleopCycles }}</strong> {{ t('wizard.cycles_unit') }}</span>
        </div>
      </section>

      <!-- STEP 1: AUTONOMOUS (30s) -->
      <section v-else-if="currentStep === 1" class="step-pane step-auto">
        <div class="pane-header">
          <div class="pane-header-row">
            <div>
              <h2 class="pane-title">{{ t('scouting.autonomous') }} (30s)</h2>
              <span class="pane-subtitle">{{ t('wizard.auto_sub') }}</span>
            </div>
            <div class="phase-score-badge">
              <span class="score-val">{{ autoScore }}</span>
              <span class="score-unit">{{ t('wizard.pts_unit') }}</span>
            </div>
          </div>
        </div>

        <!-- Giant Auto Scored Button (76px) -->
        <div class="hero-button-wrap">
          <button type="button" class="btn-hero-hit auto-hero-hit" @click="addAutoBall">
            <div class="hero-btn-inner">
              <span class="material-icons hero-icon">sports_baseball</span>
              <div class="hero-text-col">
                <span class="hero-btn-title">{{ t('wizard.auto_hit_btn') }}</span>
                <span class="hero-btn-subtitle">{{ t('wizard.auto_hit_sub', { count: team.autoBalls, pts: team.autoBalls * 3 }) }}</span>
              </div>
            </div>
          </button>
        </div>

        <!-- Secondary Controls Row (Miss & Undo) -->
        <div class="secondary-actions-grid">
          <button type="button" class="btn-secondary-action btn-miss" @click="addAutoMiss">
            <span class="material-icons" style="font-size: 18px;">close</span>
            <span>{{ t('wizard.miss_btn') }}</span>
            <span v-if="team.autoMissedCycles.length > 0" class="mini-count-badge">
              {{ team.autoMissedCycles.reduce((a, b) => a + b, 0) }}
            </span>
          </button>
          <button type="button" class="btn-secondary-action btn-undo" @click="undoAuto">
            <span class="material-icons" style="font-size: 18px;">undo</span>
            <span>{{ t('wizard.undo_btn') }}</span>
          </button>
        </div>

        <!-- Giant Toggle Cards: Leave & Park -->
        <div class="toggle-cards-group">
          <button
            type="button"
            class="toggle-card"
            :class="{ 'is-checked': team.autoLeave }"
            @click="team.autoLeave = !team.autoLeave; hapticSelection()"
          >
            <div class="toggle-card-left">
              <span class="material-icons toggle-icon">directions_run</span>
              <div class="toggle-text-wrap">
                <span class="toggle-title">{{ t('scouting.auto_leave') }}</span>
                <span class="toggle-pts">{{ t('wizard.leave_pts') }}</span>
              </div>
            </div>
            <div class="toggle-check-box">
              <span v-if="team.autoLeave" class="material-icons">check</span>
            </div>
          </button>

          <button
            type="button"
            class="toggle-card"
            :class="{ 'is-checked': team.autoPark }"
            @click="team.autoPark = !team.autoPark; hapticSelection()"
          >
            <div class="toggle-card-left">
              <span class="material-icons toggle-icon">local_parking</span>
              <div class="toggle-text-wrap">
                <span class="toggle-title">{{ t('scouting.auto_park') }}</span>
                <span class="toggle-pts">{{ t('wizard.park_pts') }}</span>
              </div>
            </div>
            <div class="toggle-check-box">
              <span v-if="team.autoPark" class="material-icons">check</span>
            </div>
          </button>
        </div>
      </section>

      <!-- STEP 2: TELEOP (120s - 盲操核心) -->
      <section v-else-if="currentStep === 2" class="step-pane step-teleop">
        <div class="pane-header">
          <div class="pane-header-row">
            <div>
              <h2 class="pane-title">{{ t('scouting.teleop') }} (120s)</h2>
              <span class="pane-subtitle">{{ t('wizard.teleop_sub') }}</span>
            </div>
            <div class="phase-score-badge">
              <span class="score-val">{{ teleopScore }}</span>
              <span class="score-unit">{{ t('wizard.pts_unit') }}</span>
            </div>
          </div>
        </div>

        <!-- Live Cycles Ticker -->
        <div class="cycles-ticker-bar">
          <div class="ticker-stat">
            <span class="ticker-label">{{ t('wizard.total_scored') }}</span>
            <span class="ticker-val text-green">{{ getTeleopBallsTotal() }}</span>
          </div>
          <div class="ticker-divider"></div>
          <div class="ticker-stat">
            <span class="ticker-label">{{ t('wizard.completed_cycles') }}</span>
            <span class="ticker-val">{{ team.teleopCycles.length }} {{ t('wizard.cycles_unit') }}</span>
          </div>
          <div class="ticker-divider"></div>
          <div class="ticker-stat">
            <span class="ticker-label">{{ t('wizard.missed_balls') }}</span>
            <span class="ticker-val text-red">{{ getTeleopMissedTotal() }}</span>
          </div>
        </div>

        <!-- Cycle History Chips Row (clickable to adjust/delete) -->
        <div v-if="team.teleopCycles.length > 0" class="cycle-chips-scroll">
          <button
            v-for="(balls, idx) in team.teleopCycles"
            :key="'c-' + idx"
            type="button"
            class="cycle-chip"
            @click="decrementCycleAtIndex(idx)"
            :title="t('wizard.undo_btn')"
          >
            <span class="chip-idx">#{{ idx + 1 }}</span>
            <span class="chip-val">{{ balls }} {{ t('wizard.balls_unit') }}</span>
            <span class="material-icons chip-remove-icon" @click.stop="removeCycleAtIndex(idx)">close</span>
          </button>
        </div>

        <!-- 96px HERO BUTTON FOR BLIND TAPPING -->
        <div class="hero-button-wrap hero-teleop-wrap">
          <button
            type="button"
            class="btn-hero-hit teleop-hero-hit"
            @click="addTeleopCycleShot"
          >
            <div class="hero-btn-inner">
              <span class="material-icons hero-icon-giant">sports_score</span>
              <div class="hero-text-col">
                <span class="hero-giant-title">{{ t('wizard.teleop_giant_hit') }}</span>
                <span class="hero-giant-subtitle">{{ t('wizard.teleop_giant_sub') }}</span>
              </div>
            </div>
          </button>
        </div>

        <!-- Physical Separation: Miss & Undo Actions -->
        <div class="secondary-actions-grid">
          <button type="button" class="btn-secondary-action btn-miss" @click="addTeleopMiss">
            <span class="material-icons" style="font-size: 20px;">cancel</span>
            <span>{{ t('wizard.teleop_miss') }}</span>
            <span v-if="getTeleopMissedTotal() > 0" class="mini-count-badge">{{ getTeleopMissedTotal() }}</span>
          </button>
          <button type="button" class="btn-secondary-action btn-undo" @click="undoTeleop">
            <span class="material-icons" style="font-size: 20px;">undo</span>
            <span>{{ t('wizard.teleop_undo') }}</span>
          </button>
        </div>
      </section>

      <!-- STEP 3: ENDGAME (30s) -->
      <section v-else-if="currentStep === 3" class="step-pane step-endgame">
        <div class="pane-header">
          <div class="pane-header-row">
            <div>
              <h2 class="pane-title">{{ t('scouting.endgame') }} (30s)</h2>
              <span class="pane-subtitle">{{ t('wizard.endgame_sub') }}</span>
            </div>
            <div class="phase-score-badge">
              <span class="score-val">{{ endgameScore }}</span>
              <span class="score-unit">{{ t('wizard.pts_unit') }}</span>
            </div>
          </div>
        </div>

        <!-- Toggle Group -->
        <div class="toggle-cards-group">
          <button
            type="button"
            class="toggle-card"
            :class="{ 'is-checked': team.flowerPlaced }"
            @click="team.flowerPlaced = !team.flowerPlaced; hapticSelection()"
          >
            <div class="toggle-card-left">
              <span class="material-icons toggle-icon" style="color: #ec4899;">local_florist</span>
              <div class="toggle-text-wrap">
                <span class="toggle-title">{{ t('scouting.flower_placed') }}</span>
                <span class="toggle-pts">{{ t('wizard.flower_pts') }}</span>
              </div>
            </div>
            <div class="toggle-check-box">
              <span v-if="team.flowerPlaced" class="material-icons">check</span>
            </div>
          </button>

          <button
            type="button"
            class="toggle-card"
            :class="{ 'is-checked': team.flowerBottomBonus }"
            @click="team.flowerBottomBonus = !team.flowerBottomBonus; hapticSelection()"
          >
            <div class="toggle-card-left">
              <span class="material-icons toggle-icon" style="color: #10b981;">spa</span>
              <div class="toggle-text-wrap">
                <span class="toggle-title">{{ t('scouting.flower_bottom_bonus') }}</span>
                <span class="toggle-pts">{{ t('wizard.park_pts') }}</span>
              </div>
            </div>
            <div class="toggle-check-box">
              <span v-if="team.flowerBottomBonus" class="material-icons">check</span>
            </div>
          </button>

          <button
            type="button"
            class="toggle-card"
            :class="{ 'is-checked': team.teleopPark }"
            @click="team.teleopPark = !team.teleopPark; hapticSelection()"
          >
            <div class="toggle-card-left">
              <span class="material-icons toggle-icon" style="color: #3b82f6;">local_parking</span>
              <div class="toggle-text-wrap">
                <span class="toggle-title">{{ t('scouting.teleop_park') }}</span>
                <span class="toggle-pts">{{ t('wizard.park_pts') }}</span>
              </div>
            </div>
            <div class="toggle-check-box">
              <span v-if="team.teleopPark" class="material-icons">check</span>
            </div>
          </button>

          <!-- Robot Broken Warning Switch -->
          <button
            type="button"
            class="toggle-card broken-toggle-card"
            :class="{ 'is-broken-checked': team.isBroken }"
            @click="team.isBroken = !team.isBroken; hapticWarning()"
          >
            <div class="toggle-card-left">
              <span class="material-icons toggle-icon" style="color: #ef4444;">healing</span>
              <div class="toggle-text-wrap">
                <span class="toggle-title">{{ t('scouting.is_broken') }}</span>
                <span class="toggle-pts" style="color: #ef4444;">{{ t('wizard.broken_sub') }}</span>
              </div>
            </div>
            <div class="toggle-check-box broken-check">
              <span v-if="team.isBroken" class="material-icons">warning</span>
            </div>
          </button>
        </div>

        <!-- Quick Notes Chips -->
        <div class="notes-section">
          <label class="field-label">{{ t('wizard.quick_notes') }}</label>
          <div class="quick-notes-grid">
            <button
              v-for="chip in quickNotesPresets"
              :key="chip.key"
              type="button"
              class="quick-note-chip"
              :class="{ 'is-active': team.notes.includes(chip.label) }"
              @click="toggleQuickNote(chip.label)"
            >
              {{ chip.label }}
            </button>
          </div>

          <div class="textarea-wrap" style="margin-top: 10px;">
            <textarea
              v-model="team.notes"
              class="notes-textarea"
              rows="3"
              :placeholder="t('scouting.notes_placeholder')"
            ></textarea>
          </div>
        </div>

        <!-- Team TagPicker (Shared Tags) -->
        <div v-if="parseInt(team.teamNumber) > 0" class="team-tags-container">
          <label class="field-label">{{ t('scouting.team_tags') }} (#{{ team.teamNumber }})</label>
          <TagPicker
            :event-id="props.eventId"
            :team-number="parseInt(team.teamNumber)"
          />
        </div>

        <!-- Custom Fields (if defined) -->
        <div v-if="customDefinitions.length > 0" class="custom-fields-box">
          <DynamicFieldsRenderer :definitions="customDefinitions" v-model="team.customFields" />
        </div>
      </section>

      <!-- STEP 4: SUMMARY & SUBMIT -->
      <section v-else-if="currentStep === 4" class="step-pane step-summary">
        <div class="pane-header">
          <h2 class="pane-title">{{ t('scouting.total_score') }}</h2>
          <span class="pane-subtitle">{{ t('wizard.summary_sub') }}</span>
        </div>

        <!-- Grand Score Card -->
        <div class="summary-hero-card" :class="`alliance-${allianceColor}`">
          <div class="summary-hero-top">
            <span class="summary-match-badge">Match #{{ matchNumber }}</span>
            <span class="summary-alliance-badge" :class="allianceColor">
              <span class="alliance-dot mini" :class="allianceColor"></span>
              <span>{{ allianceColor === 'red' ? t('scouting.red') : t('scouting.blue') }}</span>
            </span>
            <span class="summary-team-badge">Team #{{ team.teamNumber }}</span>
          </div>

          <div class="summary-total-row">
            <div class="total-label-col">
              <span class="total-label-text">{{ t('wizard.total_predicted') }}</span>
              <span class="total-label-sub">{{ t('wizard.predicted_sub') }}</span>
            </div>
            <div class="total-score-val">{{ totalScore }}</div>
          </div>

          <div class="summary-breakdown-grid">
            <div class="breakdown-col">
              <span class="breakdown-label">{{ t('wizard.auto_stage') }}</span>
              <span class="breakdown-val">{{ autoScore }} {{ t('wizard.pts_unit') }}</span>
              <span class="breakdown-sub">{{ t('wizard.auto_summary_sub', { balls: team.autoBalls, leave: team.autoLeave ? '✓' : '✕' }) }}</span>
            </div>
            <div class="breakdown-col">
              <span class="breakdown-label">{{ t('wizard.teleop_stage') }}</span>
              <span class="breakdown-val">{{ teleopScore }} {{ t('wizard.pts_unit') }}</span>
              <span class="breakdown-sub">{{ t('wizard.teleop_summary_sub', { balls: getTeleopBallsTotal(), cycles: team.teleopCycles.length }) }}</span>
            </div>
            <div class="breakdown-col">
              <span class="breakdown-label">{{ t('wizard.endgame_stage') }}</span>
              <span class="breakdown-val">{{ endgameScore }} {{ t('wizard.pts_unit') }}</span>
              <span class="breakdown-sub">{{ t('wizard.endgame_summary_sub', { flower: team.flowerPlaced ? '✓' : '✕', park: team.teleopPark ? '✓' : '✕' }) }}</span>
            </div>
          </div>

          <div v-if="team.isBroken" class="broken-alert-banner">
            <span class="material-icons" style="font-size: 18px;">warning</span>
            <span>{{ t('wizard.broken_alert') }}</span>
          </div>

          <div v-if="team.notes" class="notes-preview-box">
            <span class="notes-preview-title">{{ t('wizard.notes_prefix') }}</span>
            <span>{{ team.notes }}</span>
          </div>
        </div>

        <!-- Error Feedback Banner -->
        <div v-if="submitStatus === 'error'" class="submit-error-banner">
          <span class="material-icons">error_outline</span>
          <span>{{ submitErrorMsg }}</span>
        </div>
      </section>
    </div>

    <!-- Sticky Bottom Wizard Action Bar -->
    <div class="wizard-bottom-bar">
      <!-- Step 0 Next -->
      <template v-if="currentStep === 0">
        <button
          v-if="editRecord"
          type="button"
          class="btn-wizard-nav btn-wizard-cancel"
          @click="emit('cancelEdit')"
        >
          <span class="material-icons" style="margin-right: 4px;">close</span>
          <span>{{ t('wizard.cancel_edit') }}</span>
        </button>
        <button
          type="button"
          class="btn-wizard-nav btn-wizard-primary"
          :disabled="!canGoToAuto"
          @click="nextStep"
        >
          <span>{{ t('wizard.start_auto') }}</span>
          <span class="material-icons" style="margin-left: 6px;">arrow_forward</span>
        </button>
      </template>

      <!-- Step 1-3 Previous & Next -->
      <template v-else-if="currentStep >= 1 && currentStep <= 3">
        <button type="button" class="btn-wizard-nav btn-wizard-prev" @click="prevStep">
          <span class="material-icons" style="margin-right: 4px;">arrow_back</span>
          <span>{{ t('wizard.prev_step') }}</span>
        </button>
        <button type="button" class="btn-wizard-nav btn-wizard-primary" @click="nextStep">
          <span>{{ currentStep === 3 ? t('wizard.to_summary') : t('wizard.next_step') }}</span>
          <span class="material-icons" style="margin-left: 4px;">arrow_forward</span>
        </button>
      </template>

      <!-- Step 4 Submit & Cancel -->
      <template v-else-if="currentStep === 4">
        <button
          v-if="editRecord"
          type="button"
          class="btn-wizard-nav btn-wizard-cancel"
          @click="emit('cancelEdit')"
        >
          <span class="material-icons" style="margin-right: 4px;">close</span>
          <span>{{ t('wizard.cancel_edit') }}</span>
        </button>
        <button v-else type="button" class="btn-wizard-nav btn-wizard-prev" @click="prevStep">
          <span class="material-icons" style="margin-right: 4px;">arrow_back</span>
          <span>{{ t('wizard.modify') }}</span>
        </button>

        <button
          type="button"
          class="btn-wizard-nav btn-wizard-submit"
          :disabled="submitting"
          @click="handleSubmit"
        >
          <span class="material-icons" style="margin-right: 6px;">
            {{ submitting ? 'hourglass_top' : 'check_circle' }}
          </span>
          <span>{{ editRecord ? (t('history.btn_save') || '保存修改') : t('wizard.confirm_submit') }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.mobile-wizard-container {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 120px);
  padding-bottom: 74px;
  position: relative;
  user-select: none;
  -webkit-user-select: none;
}

/* Edit Mode Top Bar */
.edit-mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 10px;
  padding: 6px 12px;
  margin-bottom: 10px;
}

.edit-mode-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #f59e0b;
}

.btn-cancel-edit-chip {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #ffffff;
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 2px;
}

/* Stepper Progress Bar */
.wizard-stepper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(22, 27, 34, 0.7);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 8px 6px;
  margin-bottom: 12px;
}

.stepper-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex: 1;
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 2px;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.step-num-bubble {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.1);
  color: #8b949e;
  transition: all 0.25s ease;
}

.step-label-text {
  font-size: 10px;
  color: #8b949e;
  font-weight: 500;
  white-space: nowrap;
}

.stepper-step.is-active .step-num-bubble {
  background: var(--primary, #39ff14);
  color: #000000;
  box-shadow: 0 0 10px rgba(57, 255, 20, 0.45);
}

.stepper-step.is-active .step-label-text {
  color: #ffffff;
  font-weight: 700;
}

.stepper-step.is-completed .step-num-bubble {
  background: rgba(57, 255, 20, 0.2);
  color: #39ff14;
}

.stepper-step.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Wizard Body Panes */
.wizard-body {
  flex: 1;
}

.step-pane {
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: pane-fade 0.22s ease-out;
}

@keyframes pane-fade {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.pane-header {
  margin-bottom: 2px;
}

.pane-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pane-title {
  font-size: 1.15rem;
  font-weight: 700;
  color: #ffffff;
  margin: 0;
}

.pane-subtitle {
  font-size: 11px;
  color: #8b949e;
}

.phase-score-badge {
  display: flex;
  align-items: baseline;
  gap: 2px;
  background: rgba(57, 255, 20, 0.12);
  border: 1px solid rgba(57, 255, 20, 0.3);
  padding: 4px 10px;
  border-radius: 12px;
}

.score-val {
  font-size: 1.25rem;
  font-weight: 800;
  color: #39ff14;
  font-family: monospace;
}

.score-unit {
  font-size: 11px;
  color: #8b949e;
}

/* Assigned Task Card */
.assigned-task-card {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(57, 255, 20, 0.08);
  border: 1px solid rgba(57, 255, 20, 0.3);
  border-radius: 12px;
  padding: 10px 12px;
  cursor: pointer;
}

.task-card-content {
  flex: 1;
}

.task-card-badge {
  font-size: 10px;
  font-weight: 700;
  color: #39ff14;
  letter-spacing: 0.5px;
}

.task-card-title {
  font-size: 13px;
  font-weight: 600;
  color: #ffffff;
}

.btn-task-apply {
  background: rgba(57, 255, 20, 0.2);
  border: 1px solid rgba(57, 255, 20, 0.4);
  color: #39ff14;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

/* Inputs & Form controls */
.field-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #c9d1d9;
  margin-bottom: 6px;
}

.alliance-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.alliance-btn {
  height: 64px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  border-radius: 14px;
  border: 1.5px solid rgba(255, 255, 255, 0.12);
  background: rgba(22, 27, 34, 0.8);
  cursor: pointer;
  position: relative;
  transition: all 0.25s ease;
}

.alliance-tag {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 1px;
  opacity: 0.7;
}

.alliance-label-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.alliance-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

.alliance-dot.red {
  background: #ef4444;
  box-shadow: 0 0 6px #ef4444;
}

.alliance-dot.blue {
  background: #3b82f6;
  box-shadow: 0 0 6px #3b82f6;
}

.alliance-dot.mini {
  width: 6px;
  height: 6px;
  margin-right: 4px;
}

.alliance-name {
  font-size: 15px;
  font-weight: 800;
}

.alliance-btn.red-btn {
  color: #f87171;
}

.alliance-btn.blue-btn {
  color: #60a5fa;
}

.alliance-btn.red-btn.is-selected {
  background: rgba(239, 68, 68, 0.2);
  border-color: #ef4444;
  box-shadow: 0 0 16px rgba(239, 68, 68, 0.4);
}

.alliance-btn.blue-btn.is-selected {
  background: rgba(59, 130, 246, 0.2);
  border-color: #3b82f6;
  box-shadow: 0 0 16px rgba(59, 130, 246, 0.4);
}

.check-mark {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 16px;
}

/* Tournament Level Switcher */
.segmented-level-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.btn-level-seg {
  height: 38px;
  border-radius: 10px;
  background: rgba(22, 27, 34, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #8b949e;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-level-seg.is-active {
  background: rgba(57, 255, 20, 0.15);
  border-color: #39ff14;
  color: #39ff14;
  font-weight: 700;
}

/* Stepper Input Wrap */
.number-stepper-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
}

.btn-stepper {
  width: 40px;
  height: 52px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #ffffff;
  font-size: 1.2rem;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.btn-stepper:active {
  background: rgba(57, 255, 20, 0.2);
  border-color: #39ff14;
}

.btn-stepper:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.num-input-stepper {
  flex: 1;
}

.input-row-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.giant-num-input {
  width: 100%;
  box-sizing: border-box;
  height: 52px;
  background: rgba(22, 27, 34, 0.9);
  border: 1.5px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  color: #ffffff;
  font-size: 1.3rem;
  font-weight: 800;
  text-align: center;
  font-family: monospace;
}

.giant-num-input:focus {
  outline: none;
  border-color: var(--primary, #39ff14);
  box-shadow: 0 0 12px rgba(57, 255, 20, 0.3);
}

.banned-warning-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: 10px;
  color: #f87171;
  font-size: 12px;
  font-weight: 600;
}

.pit-scout-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 12px;
  color: #8b949e;
}

/* HERO BUTTONS (Auto 76px, TeleOp 96px) */
.hero-button-wrap {
  width: 100%;
}

.btn-hero-hit {
  width: 100%;
  border-radius: 16px;
  border: 1.5px solid rgba(57, 255, 20, 0.5);
  background: linear-gradient(135deg, rgba(57, 255, 20, 0.22) 0%, rgba(34, 197, 94, 0.12) 100%);
  color: #ffffff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 0 16px rgba(57, 255, 20, 0.2);
  transition: transform 0.12s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.12s;
  box-sizing: border-box;
  padding: 0 16px;
}

.btn-hero-hit:active {
  transform: scale(0.97);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35), 0 0 24px rgba(57, 255, 20, 0.45);
}

.auto-hero-hit {
  height: 76px;
}

.teleop-hero-hit {
  height: 96px;
  border-width: 2px;
  border-color: rgba(57, 255, 20, 0.7);
  background: linear-gradient(135deg, rgba(57, 255, 20, 0.28) 0%, rgba(16, 185, 129, 0.18) 100%);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4), 0 0 24px rgba(57, 255, 20, 0.3);
}

.hero-btn-inner {
  display: flex;
  align-items: center;
  gap: 14px;
}

.hero-icon {
  font-size: 32px;
  color: #39ff14;
}

.hero-icon-giant {
  font-size: 42px;
  color: #39ff14;
  filter: drop-shadow(0 0 6px rgba(57, 255, 20, 0.6));
}

.hero-text-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.hero-btn-title {
  font-size: 1.15rem;
  font-weight: 800;
  color: #ffffff;
}

.hero-btn-subtitle {
  font-size: 11px;
  color: #a7f3d0;
  margin-top: 2px;
}

.hero-giant-title {
  font-size: 1.35rem;
  font-weight: 900;
  letter-spacing: 0.5px;
  color: #ffffff;
}

.hero-giant-subtitle {
  font-size: 12px;
  color: #86efac;
  margin-top: 3px;
}

/* Secondary Actions Grid (Missed & Undo) */
.secondary-actions-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.btn-secondary-action {
  height: 50px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  background: rgba(22, 27, 34, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #c9d1d9;
  transition: all 0.18s ease;
}

.btn-secondary-action:active {
  transform: scale(0.96);
}

.btn-miss {
  border-color: rgba(239, 68, 68, 0.35);
  color: #f87171;
}

.btn-miss:active {
  background: rgba(239, 68, 68, 0.2);
}

.mini-count-badge {
  background: #ef4444;
  color: #ffffff;
  font-size: 11px;
  font-weight: 800;
  border-radius: 9999px;
  padding: 1px 6px;
  margin-left: 2px;
}

/* Toggle Cards Group */
.toggle-cards-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.toggle-card {
  width: 100%;
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  background: rgba(22, 27, 34, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
  box-sizing: border-box;
}

.toggle-card-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toggle-icon {
  font-size: 24px;
  color: #8b949e;
}

.toggle-text-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.toggle-title {
  font-size: 13px;
  font-weight: 700;
  color: #ffffff;
}

.toggle-pts {
  font-size: 11px;
  color: #8b949e;
}

.toggle-check-box {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  border: 1.5px solid rgba(255, 255, 255, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #000000;
  transition: all 0.2s ease;
}

.toggle-card.is-checked {
  background: rgba(57, 255, 20, 0.1);
  border-color: rgba(57, 255, 20, 0.4);
}

.toggle-card.is-checked .toggle-icon {
  color: #39ff14;
}

.toggle-card.is-checked .toggle-pts {
  color: #39ff14;
}

.toggle-card.is-checked .toggle-check-box {
  background: #39ff14;
  border-color: #39ff14;
}

.broken-toggle-card.is-broken-checked {
  background: rgba(239, 68, 68, 0.15);
  border-color: #ef4444;
}

.broken-check {
  border-color: rgba(239, 68, 68, 0.4);
  color: #ef4444;
}

.broken-toggle-card.is-broken-checked .broken-check {
  background: #ef4444;
  color: #ffffff;
}

/* TeleOp Ticker & Chips */
.cycles-ticker-bar {
  display: flex;
  align-items: center;
  justify-content: space-around;
  background: rgba(22, 27, 34, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 8px 10px;
}

.ticker-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.ticker-label {
  font-size: 10px;
  color: #8b949e;
}

.ticker-val {
  font-size: 15px;
  font-weight: 800;
  font-family: monospace;
}

.ticker-divider {
  width: 1px;
  height: 24px;
  background: rgba(255, 255, 255, 0.1);
}

.cycle-chips-scroll {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 4px 0;
  scrollbar-width: none;
}

.cycle-chips-scroll::-webkit-scrollbar {
  display: none;
}

.cycle-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(57, 255, 20, 0.15);
  border: 1px solid rgba(57, 255, 20, 0.35);
  border-radius: 8px;
  padding: 3px 8px;
  font-size: 12px;
  white-space: nowrap;
  color: #ffffff;
  cursor: pointer;
}

.cycle-chip:active {
  background: rgba(239, 68, 68, 0.2);
  border-color: #ef4444;
}

.chip-idx {
  color: #8b949e;
  font-size: 10px;
}

.chip-val {
  color: #39ff14;
  font-weight: 700;
}

.chip-remove-icon {
  font-size: 12px;
  color: #8b949e;
  margin-left: 2px;
}

/* Notes & TagPicker & Custom Fields */
.quick-notes-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.quick-note-chip {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
  padding: 5px 12px;
  font-size: 12px;
  color: #c9d1d9;
  cursor: pointer;
  transition: all 0.2s ease;
}

.quick-note-chip.is-active {
  background: rgba(57, 255, 20, 0.2);
  border-color: #39ff14;
  color: #39ff14;
  font-weight: 700;
}

.notes-textarea {
  width: 100%;
  box-sizing: border-box;
  background: rgba(22, 27, 34, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  color: #ffffff;
  padding: 10px 12px;
  font-size: 13px;
  resize: vertical;
}

.notes-textarea:focus {
  outline: none;
  border-color: #39ff14;
}

.team-tags-container {
  margin-top: 6px;
  padding: 12px;
  background: rgba(22, 27, 34, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
}

/* Summary Card */
.summary-hero-card {
  background: rgba(22, 27, 34, 0.95);
  border: 1.5px solid rgba(255, 255, 255, 0.15);
  border-radius: 16px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.summary-hero-card.alliance-red {
  border-color: rgba(239, 68, 68, 0.4);
  box-shadow: 0 0 20px rgba(239, 68, 68, 0.15);
}

.summary-hero-card.alliance-blue {
  border-color: rgba(59, 130, 246, 0.4);
  box-shadow: 0 0 20px rgba(59, 130, 246, 0.15);
}

.summary-hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.summary-match-badge,
.summary-team-badge {
  font-size: 13px;
  font-weight: 700;
  color: #ffffff;
}

.summary-alliance-badge {
  font-size: 11px;
  font-weight: 800;
  padding: 2px 8px;
  border-radius: 6px;
}

.summary-alliance-badge.red {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.4);
}

.summary-alliance-badge.blue {
  background: rgba(59, 130, 246, 0.2);
  color: #60a5fa;
  border: 1px solid rgba(59, 130, 246, 0.4);
}

.summary-total-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: rgba(57, 255, 20, 0.1);
  border: 1px solid rgba(57, 255, 20, 0.25);
  border-radius: 12px;
}

.total-label-text {
  font-size: 14px;
  font-weight: 700;
  color: #ffffff;
  display: block;
}

.total-label-sub {
  font-size: 9px;
  color: #8b949e;
  letter-spacing: 0.5px;
}

.total-score-val {
  font-size: 2.2rem;
  font-weight: 900;
  color: #39ff14;
  font-family: monospace;
}

.summary-breakdown-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}

.breakdown-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 4px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  text-align: center;
}

.breakdown-label {
  font-size: 10px;
  color: #8b949e;
}

.breakdown-val {
  font-size: 14px;
  font-weight: 800;
  color: #ffffff;
  margin: 2px 0;
}

.breakdown-sub {
  font-size: 9px;
  color: #8b949e;
}

.broken-alert-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: rgba(239, 68, 68, 0.2);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 8px;
  color: #f87171;
  font-size: 12px;
  font-weight: 600;
}

.notes-preview-box {
  font-size: 12px;
  color: #c9d1d9;
  background: rgba(255, 255, 255, 0.04);
  padding: 8px 10px;
  border-radius: 8px;
}

.notes-preview-title {
  color: #8b949e;
  font-weight: 600;
}

.submit-error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(239, 68, 68, 0.25);
  border: 1px solid #ef4444;
  border-radius: 10px;
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
}

/* Sticky Bottom Wizard Action Bar */
.wizard-bottom-bar {
  position: fixed;
  bottom: calc(56px + var(--sab, env(safe-area-inset-bottom, 0px)));
  left: 0;
  right: 0;
  padding: 8px 12px;
  background: rgba(18, 18, 22, 0.94);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  gap: 10px;
  z-index: 840;
}

.btn-wizard-nav {
  height: 50px;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.18s ease;
  user-select: none;
}

.btn-wizard-nav:active {
  transform: scale(0.97);
}

.btn-wizard-prev {
  flex: 0.35;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #ffffff;
}

.btn-wizard-cancel {
  flex: 0.35;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: #f87171;
}

.btn-wizard-primary {
  flex: 1;
  background: #39ff14;
  border: none;
  color: #000000;
  font-weight: 800;
  box-shadow: 0 4px 14px rgba(57, 255, 20, 0.35);
}

.btn-wizard-primary:disabled {
  background: rgba(255, 255, 255, 0.12);
  color: #8b949e;
  box-shadow: none;
  cursor: not-allowed;
}

.btn-wizard-submit {
  flex: 1;
  height: 52px;
  background: linear-gradient(135deg, #39ff14 0%, #10b981 100%);
  border: none;
  color: #000000;
  font-size: 15px;
  font-weight: 900;
  box-shadow: 0 6px 20px rgba(57, 255, 20, 0.4);
}

.btn-wizard-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.text-red { color: #f87171; }
.text-blue { color: #60a5fa; }
.text-green { color: #39ff14; }
</style>
