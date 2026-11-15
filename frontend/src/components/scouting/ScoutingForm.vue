<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
import { useScheduleStore } from '@/stores/schedule'
import { usePitScoutStore } from '@/stores/pitScout'
import {
  hapticFeedback,
  hapticSelection,
  hapticSuccess,
  hapticWarning
} from '@/utils/haptics'
import type { ScoutingRecord, ScoutingFormData } from '@/types'
import TagPicker from '@/components/common/TagPicker.vue'
import PitStatusIndicator from '@/components/pit/PitStatusIndicator.vue'
import PhaseCycleTracker from './PhaseCycleTracker.vue'
import DynamicFieldsRenderer from '@/components/customFields/DynamicFieldsRenderer.vue'
import { useCustomFieldsStore } from '@/stores/customFields'
import { isAssignmentCompleted, getRecordTournamentLevel } from '@/utils/tournament'
import { formatUserFriendlyError } from '@/utils/errorHelper'
import { useScreenWakeLock } from '@/utils/wakeLock'
import {
  createEmptyTeam,
  hasAnyScoutData,
  useScoutingDraft,
  type TeamScoutData
} from './composables/useScoutingDraft'
import { useScoutingFormCycles } from './composables/useScoutingFormCycles'
import { calcBiobuzzEndgameScore, parseBiobuzzEndgame } from '@/utils/analytics/rankings'
import { calcMatchPredictCycleTime } from '@/utils/analytics/predictCycleTime'

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

function formatDrivetrain(dt?: string) {
  if (!dt) return '-'
  const key = 'pit_scout.drivetrain.' + dt
  return te(key) ? t(key) : dt
}

function formatBallCompat(bc?: string) {
  if (!bc) return '-'
  const key = 'pit_scout.ball_compatibility.' + bc
  return te(key) ? t(key) : bc
}

function formatChassisSize(size?: string) {
  if (!size) return ''
  const key = 'pit_scout.chassis_size_presets.' + size
  return te(key) ? t(key) : size
}

function formatFlowerMech(mech?: string) {
  if (!mech) return ''
  const key = 'pit_scout.flower_presets.' + mech
  return te(key) ? t(key) : mech
}

function getPitSummary(teamNumStr: string) {
  const num = parseInt(teamNumStr)
  if (!num) return null
  const u = pitStore.getUnifiedTeam(num)
  if (!u?.pitRecord) return null
  const r = u.pitRecord
  return {
    drivetrain: r.drivetrainType,
    chassisSize: r.chassisSize || '',
    flowerMechanism: r.flowerMechanism || '',
    ballCompatibility: r.ballCompatibility || 'universal',
    autoScore: r.claimedAutoScore,
    teleopCycles: r.claimedTeleopCycles || 0,
    claimedEndgameScore: r.claimedEndgameScore || 0
  }
}

type EndgameCounterField =
  | 'flowerNectars'
  | 'flowerBottomBonusCount'
  | 'flowerPollens'
  | 'gardenBalls'

function setEndgameField(team: TeamScoutData, field: EndgameCounterField, rawValue: number) {
  const num = Number.isFinite(rawValue) ? Math.round(rawValue) : 0
  if (field === 'flowerNectars') {
    const clamped = Math.max(0, Math.min(8, num))
    team.flowerNectars = clamped
    team.flowerBottomBonusCount = Math.min(team.flowerBottomBonusCount, clamped)
    team.flowerPlaced = clamped > 0
    team.flowerBottomBonus = team.flowerBottomBonusCount > 0
  } else if (field === 'flowerBottomBonusCount') {
    const cap = Math.min(4, team.flowerNectars)
    const clamped = Math.max(0, Math.min(cap, num))
    team.flowerBottomBonusCount = clamped
    team.flowerBottomBonus = clamped > 0
  } else if (field === 'flowerPollens') {
    team.flowerPollens = Math.max(0, Math.min(12, num))
  } else if (field === 'gardenBalls') {
    team.gardenBalls = Math.max(0, Math.min(12, num))
  }
  hapticSelection()
}

function adjustEndgameField(team: TeamScoutData, field: EndgameCounterField, delta: number) {
  setEndgameField(team, field, (team[field] || 0) + delta)
}

function getTeamPredictCycleTime(team: TeamScoutData): number | null {
  return calcMatchPredictCycleTime(team.teleopCycles, team.teleopCycleTimestamps)
}

// --- Form State ---
const scoutMode = ref<'single' | 'alliance'>('single')
const allianceColor = ref<'none' | 'red' | 'blue'>('none')
const matchNumber = ref('1')
const currentTournamentLevel = ref<string>('QUALIFICATION')
const teamsData = ref<TeamScoutData[]>([createEmptyTeam()])

const submitting = ref(false)
const submitStatus = ref<'none' | 'success' | 'error'>('none')
const submitErrorMsg = ref('')
const previousScoutMode = ref<'single' | 'alliance'>('single')

// 1. 移动端打分期间常亮保活，防止意外息屏导致记分中断
useScreenWakeLock()

// 2. 表单草稿自动保存与息屏杀后台恢复机制
const {
  draftKey,
  isDraftRestored,
  saveDraft,
  restoreDraft,
  clearDraft
} = useScoutingDraft({
  getEventId: () => props.eventId,
  getEditRecord: () => props.editRecord,
  getAssignedTask: () => props.assignedTask,
  submitting,
  scoutMode,
  allianceColor,
  matchNumber,
  currentTournamentLevel,
  teamsData
})

// 3. Cycle 记分与球数控制逻辑
const {
  bump,
  getBumpClass,
  clearBump,
  activeCycleTap,
  syncAutoBalls,
  isCycleTapping,
  getLastCycleBalls,
  addCycle,
  setLastCycleBalls,
  undoLastCycle,
  incrementCycle,
  decrementCycle,
  getCycleBallsTotal,
  getAvgBallsPerCycle,
  incrementAutoBalls,
  decrementAutoBalls,
  setAutoBalls,
  calcTeamTotal
} = useScoutingFormCycles()

watch(scoutMode, (mode) => {
  if (mode === 'alliance' && teamsData.value.length === 1) {
    teamsData.value.push(createEmptyTeam())
  }
})

watch(() => props.editRecord, (rec: ScoutingRecord | null | undefined) => {
  if (rec) {
    if (scoutMode.value !== 'single') {
      previousScoutMode.value = scoutMode.value
      scoutMode.value = 'single'
    }
    let raw: Partial<ScoutingFormData> = {}
    try {
      raw = JSON.parse(rec.rawData) as Partial<ScoutingFormData>
    } catch {
      // Fallback to empty if corrupted
    }
    matchNumber.value = String(rec.matchNumber)
    allianceColor.value = raw.allianceColor || 'none'
    currentTournamentLevel.value = raw.tournamentLevel || 'QUALIFICATION'
    const legacyAutoBalls = (raw.autoPreload ? 1 : 0) + (raw.autoSecondary ? 1 : 0)
    const autoBalls = typeof raw.autoBalls === 'number' ? raw.autoBalls : legacyAutoBalls
    const autoCycles = Array.isArray(raw.autoCycles)
      ? [...raw.autoCycles]
      : (autoBalls > 0 ? [autoBalls] : [])
    const autoMissedCycles = Array.isArray(raw.autoMissedCycles) ? [...raw.autoMissedCycles] : []
    const teleopMissedCycles = Array.isArray(raw.teleopMissedCycles) ? [...raw.teleopMissedCycles] : []
    const parsedEndgame = parseBiobuzzEndgame(raw)
    teamsData.value = [{
      teamNumber: String(rec.teamNumber),
      autoLeave: raw.autoLeave ?? false,
      autoBalls: autoBalls,
      autoCycles: autoCycles,
      autoMissedCycles: autoMissedCycles,
      autoPark: raw.autoPark ?? false,
      teleopCycles: Array.isArray(raw.teleopCycles) ? [...raw.teleopCycles] : [],
      teleopMissedCycles: teleopMissedCycles,
      teleopCycleTimestamps: Array.isArray(raw.teleopCycleTimestamps) ? [...raw.teleopCycleTimestamps] : [],
      ...parsedEndgame,
      isBroken: raw.isBroken ?? false,
      notes: rec.notes || '',
      customFields: raw.customFields ? { ...raw.customFields } : {}
    }]
  }
}, { immediate: true })

function applyTask(task: { matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue'; tournamentLevel?: string }) {
  if (scoutMode.value !== 'single') {
    scoutMode.value = 'single'
  }
  matchNumber.value = String(task.matchNumber)
  allianceColor.value = task.allianceColor
  currentTournamentLevel.value = task.tournamentLevel || 'QUALIFICATION'
  if (teamsData.value[0]) {
    teamsData.value[0].teamNumber = String(task.teamNumber)
  }
  hapticFeedback(20)
}

watch(
  () => props.assignedTask,
  (task) => {
    if (task) {
      applyTask(task)
    }
  },
  { immediate: true }
)

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

const isFormValid = computed(() => {
  const isMatchValid = /^\d{1,8}$/.test(matchNumber.value) && parseInt(matchNumber.value) > 0
  const activeTeams = scoutMode.value === 'single' ? teamsData.value.slice(0, 1) : teamsData.value
  const areTeamsValid = activeTeams.every(t => /^\d{1,8}$/.test(t.teamNumber) && parseInt(t.teamNumber) > 0)
  const isColorValid = allianceColor.value !== 'none'
  const isUnique = new Set(activeTeams.map(t => t.teamNumber)).size === activeTeams.length
  return isMatchValid && areTeamsValid && isColorValid && isUnique
})

function isInvalidFormat(val: string) {
  if (!val) return false
  return !/^\d{1,8}$/.test(val)
}

async function handleSubmit() {
  if (submitting.value) return
  if (!isFormValid.value) {
    hapticWarning()
    submitStatus.value = 'error'
    submitErrorMsg.value = t('scouting.invalid_input_hint')
    setTimeout(() => { submitStatus.value = 'none' }, 2000)
    return
  }

  const activeTeams = scoutMode.value === 'single' ? teamsData.value.slice(0, 1) : teamsData.value

  for (const team of activeTeams) {
    const matchNum = parseInt(matchNumber.value)
    const teamNum = parseInt(team.teamNumber)
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
  }

  submitting.value = true
  submitStatus.value = 'none'

  try {
    const records: ScoutingRecord[] = activeTeams.map(team => {
      const auto = (team.autoLeave ? 3 : 0) +
                   ((team.autoBalls || 0) * 3) +
                   (team.autoPark ? 5 : 0)
      const totalBalls = getCycleBallsTotal(team)
      const teleop = totalBalls * 2
      const parsedEndgame = parseBiobuzzEndgame(team)
      const endgame = calcBiobuzzEndgameScore(parsedEndgame)
      const total = auto + teleop + endgame
      const teleopTimestamps = Array.isArray(team.teleopCycleTimestamps)
        ? [...team.teleopCycleTimestamps]
        : []
      const predictCycleTimeSec = calcMatchPredictCycleTime(team.teleopCycles, teleopTimestamps)

      const formData: ScoutingFormData = {
        matchNumber: parseInt(matchNumber.value),
        tournamentLevel: currentTournamentLevel.value,
        teamNumber: parseInt(team.teamNumber),
        allianceColor: allianceColor.value,
        isBroken: team.isBroken,
        autoLeave: team.autoLeave,
        autoBalls: team.autoBalls || 0,
        autoCycles: [...team.autoCycles],
        autoMissedCycles: [...team.autoMissedCycles],
        autoPreload: (team.autoBalls || 0) > 0,
        autoPark: team.autoPark,
        teleopCycles: [...team.teleopCycles],
        teleopMissedCycles: [...team.teleopMissedCycles],
        teleopCycleTimestamps: teleopTimestamps,
        predictCycleTimeSec,
        flowerNectars: parsedEndgame.flowerNectars,
        flowerBottomBonusCount: parsedEndgame.flowerBottomBonusCount,
        flowerPollens: parsedEndgame.flowerPollens,
        gardenBalls: parsedEndgame.gardenBalls,
        flowerDescore: parsedEndgame.flowerDescore,
        g410EarlyFlowerFoul: parsedEndgame.g410EarlyFlowerFoul,
        flowerPlaced: parsedEndgame.flowerPlaced,
        flowerBottomBonus: parsedEndgame.flowerBottomBonus,
        teleopPark: parsedEndgame.teleopPark,
        customFields: { ...team.customFields }
      }

      return {
        id: props.editRecord ? props.editRecord.id : (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`),
        eventId: props.eventId,
        scoutId: props.editRecord ? (props.editRecord.scoutId || props.scoutId) : props.scoutId,
        scoutName: props.editRecord ? (props.editRecord.scoutName || props.scoutName) : props.scoutName,
        matchNumber: parseInt(matchNumber.value),
        teamNumber: parseInt(team.teamNumber),
        autoScore: auto,
        teleopScore: teleop,
        endgameScore: endgame,
        totalScore: total,
        notes: team.notes,
        rawData: JSON.stringify(formData),
        syncStatus: 'PENDING',
        createdAt: props.editRecord ? props.editRecord.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isBroken: team.isBroken,
        version: props.editRecord ? (props.editRecord.version || 0) : 0,
        hostSeq: props.editRecord ? props.editRecord.hostSeq : undefined
      }
    })

    if (records.length === 1) {
      emit('submit', records[0]!)
    } else {
      emit('submit', records)
    }

    submitStatus.value = 'success'
    hapticSuccess()
    clearDraft()
    if (!props.editRecord) {
      matchNumber.value = String(parseInt(matchNumber.value) + 1)
    }
    // reset teams
    if (props.editRecord && previousScoutMode.value === 'alliance') {
      scoutMode.value = 'alliance'
      teamsData.value = [createEmptyTeam(), createEmptyTeam()]
    } else {
      teamsData.value = teamsData.value.map(() => createEmptyTeam())
    }
    if (!props.editRecord) {
      allianceColor.value = 'none'
    }

    if (props.editRecord) {
      emit('cancelEdit')
    }

  } catch (err) {
    hapticWarning()
    submitStatus.value = 'error'
    const { message } = formatUserFriendlyError(err, t('scouting.submit_failed') || '提交失败，请重试')
    submitErrorMsg.value = message
  } finally {
    submitting.value = false
    setTimeout(() => {
      submitStatus.value = 'none'
    }, 2000)
  }
}

const allianceFlowerCapWarning = computed(() => {
  if (scoutMode.value !== 'alliance' || teamsData.value.length < 2) return false
  const t1 = teamsData.value[0]!
  const t2 = teamsData.value[1]!
  return (t1.flowerNectars + t2.flowerNectars > 8) ||
         (t1.flowerBottomBonusCount + t2.flowerBottomBonusCount > 4)
})

const wrapperClass = computed(() => {
  return [
    'scouting-wrapper',
    `color-${allianceColor.value}`,
    `status-${submitStatus.value}`,
    scoutMode.value === 'alliance' ? 'alliance-mode' : ''
  ]
})
</script>

<template>
  <div :class="wrapperClass">
    <form class="scouting-form" @submit.prevent="handleSubmit">
      
      <!-- Draft Restored Banner -->
      <div v-if="isDraftRestored" class="assigned-task-banner draft-restored-banner" style="border-color: rgba(59, 130, 246, 0.4); background: rgba(59, 130, 246, 0.1);">
        <div class="task-info">
          <span class="material-icons task-icon" style="color: #60a5fa;">restore_page</span>
          <span>{{ t('scouting.draft_restored') }}</span>
        </div>
        <button type="button" class="btn-load-task" @click="clearDraft">
          <span class="material-icons">close</span>
          <span>{{ t('common.dismiss') }}</span>
        </button>
      </div>

      <!-- Assigned Task Banner -->
      <div v-if="nextPendingAssignment" class="assigned-task-banner">
        <div class="task-info">
          <span class="material-icons task-icon">assignment_ind</span>
          <span>{{ t('schedule.assigned_task_hint', { match: nextPendingAssignment.matchNumber, team: nextPendingAssignment.teamNumber, alliance: nextPendingAssignment.allianceColor === 'red' ? t('scouting.red') : t('scouting.blue') }) }}</span>
        </div>
        <button type="button" class="btn-load-task" @click="applyTask(nextPendingAssignment)">
          <span class="material-icons">download_done</span>
          <span>{{ t('schedule.btn_load_task') }}</span>
        </button>
      </div>

      <!-- Top Settings (Mode & Color) -->
      <section class="form-section settings-section">
        <div class="setting-group">
          <span>{{ t('scouting.mode') }}</span>
          <div class="segmented-control">
            <button type="button" :class="{ active: scoutMode === 'single' }" :disabled="!!editRecord" @click="scoutMode = 'single'; hapticSelection()">{{ t('scouting.single_team') }}</button>
            <button type="button" :class="{ active: scoutMode === 'alliance' }" :disabled="!!editRecord" @click="scoutMode = 'alliance'; hapticSelection()">{{ t('scouting.alliance') }}</button>
          </div>
        </div>
        <div class="setting-group">
          <span>{{ t('scouting.alliance_color') }}</span>
          <div class="spdt-switch" :class="'pos-' + allianceColor">
            <div class="spdt-thumb" v-show="allianceColor !== 'none'"></div>
            <div class="spdt-labels">
              <span @click="allianceColor = 'red'; hapticSelection()" :class="{ active: allianceColor === 'red' }">{{ t('scouting.red') }}</span>
              <span @click="allianceColor = 'blue'; hapticSelection()" :class="{ active: allianceColor === 'blue' }">{{ t('scouting.blue') }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Match Info (Shared) -->
      <section class="form-section">
        <h3><span class="material-icons">push_pin</span> {{ t('scouting.match_info') }}</h3>
        <div class="field-row" style="display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;">
          <label class="field" style="flex: 1; min-width: 140px;">
            <span>{{ t('scouting.match_number') }}</span>
            <input v-model="matchNumber" type="text" inputmode="numeric" placeholder="1-999" :class="{ 'invalid-field': isInvalidFormat(matchNumber) }" />
          </label>
          <div class="setting-group" style="margin-bottom: 2px;">
            <span style="font-size: 12px; color: var(--muted-foreground); margin-right: 8px;">{{ t('wizard.tournament_level') }}</span>
            <div class="segmented-control">
              <button type="button" :class="{ active: currentTournamentLevel === 'QUALIFICATION' }" @click="currentTournamentLevel = 'QUALIFICATION'; hapticSelection()">
                {{ t('wizard.level_qual') }}
              </button>
              <button type="button" :class="{ active: currentTournamentLevel === 'PLAYOFF' }" @click="currentTournamentLevel = 'PLAYOFF'; hapticSelection()">
                {{ t('wizard.level_playoff') }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <div class="teams-grid" :class="{ 'alliance-grid': scoutMode === 'alliance' }">
        <div v-for="(team, index) in (scoutMode === 'single' ? teamsData.slice(0, 1) : teamsData)" :key="index" class="team-column">
          <h2 class="team-header" v-if="scoutMode === 'alliance'">
            {{ index === 0 ? t('scouting.team_1') : t('scouting.team_2') }}: #{{ team.teamNumber || '?' }}
          </h2>

          <section class="form-section">
            <div class="field-row">
              <label class="field">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span>{{ t('scouting.team_number') }}</span>
                  <PitStatusIndicator v-if="parseInt(team.teamNumber) > 0" :team-number="parseInt(team.teamNumber)" :show-label="true" />
                </div>
                <input v-model="team.teamNumber" type="text" inputmode="numeric" placeholder="e.g. 12345" :class="{ 'invalid-field': isInvalidFormat(team.teamNumber) }" />
                <div v-if="getPitSummary(team.teamNumber)" class="pit-quick-hint" style="font-size: 11px; color: var(--color-primary, #38bdf8); margin-top: 4px; display: flex; flex-direction: column; gap: 3px;">
                  <div style="display: inline-flex; align-items: center; gap: 4px;">
                    <span class="material-icons" style="font-size: 13px;">lightbulb</span>
                    <span>{{ t('pit_scout.quick_summary_v2', { drivetrain: formatDrivetrain(getPitSummary(team.teamNumber)?.drivetrain), ball: formatBallCompat(getPitSummary(team.teamNumber)?.ballCompatibility), auto: getPitSummary(team.teamNumber)?.autoScore ?? 0, teleop: getPitSummary(team.teamNumber)?.teleopCycles ?? 0, endgame: getPitSummary(team.teamNumber)?.claimedEndgameScore ?? 0 }) }}</span>
                  </div>
                  <div v-if="getPitSummary(team.teamNumber)?.chassisSize || getPitSummary(team.teamNumber)?.flowerMechanism" class="pit-spec-chips">
                    <span v-if="getPitSummary(team.teamNumber)?.chassisSize" class="pit-spec-chip">
                      {{ t('pit_scout.detail_card.spec_chassis_size', { val: formatChassisSize(getPitSummary(team.teamNumber)?.chassisSize) }) }}
                    </span>
                    <span v-if="getPitSummary(team.teamNumber)?.flowerMechanism" class="pit-spec-chip">
                      {{ t('pit_scout.detail_card.spec_flower', { val: formatFlowerMech(getPitSummary(team.teamNumber)?.flowerMechanism) }) }}
                    </span>
                  </div>
                </div>
                <span v-if="recordStore.bannedTeams.includes(parseInt(team.teamNumber))" class="banned-warning">
                  <span class="material-icons" style="font-size: 14px; vertical-align: middle;">warning</span> 
                  {{ t('scouting.banned_warning') }}
                </span>
              </label>
            </div>

            <!-- Team Tags Directly on Scouting Form -->
            <div v-if="parseInt(team.teamNumber) > 0" class="team-tags-section">
              <div class="team-tags-header">
                <span class="material-icons" style="font-size: 15px;">label</span>
                <span>{{ t('scouting.team_tags') }} (#{{ team.teamNumber }})</span>
              </div>
              <TagPicker
                :event-id="props.eventId"
                :team-number="parseInt(team.teamNumber)"
              />
            </div>
          </section>

          <!-- Autonomous -->
          <section class="form-section">
            <PhaseCycleTracker
              phase="auto"
              :title="t('scouting.autonomous')"
              icon="smart_toy"
              :rate-text="t('scouting.auto_balls_rate')"
              v-model="team.autoCycles"
              v-model:missed-value="team.autoMissedCycles"
              @change="syncAutoBalls(team)"
            />

            <!-- Auto Toggles (Leave & Park) -->
            <div class="biobuzz-toggles-grid" style="margin-top: 12px;">
              <label class="toggle-card" :class="{ 'is-active': team.autoLeave }">
                <input v-model="team.autoLeave" type="checkbox" @change="hapticSelection" />
                <span class="material-icons check-icon">{{ team.autoLeave ? 'check_box' : 'check_box_outline_blank' }}</span>
                <div class="toggle-info">
                  <span class="toggle-title">{{ t('scouting.auto_leave') }}</span>
                </div>
              </label>

              <label class="toggle-card" :class="{ 'is-active': team.autoPark }">
                <input v-model="team.autoPark" type="checkbox" @change="hapticSelection" />
                <span class="material-icons check-icon">{{ team.autoPark ? 'check_box' : 'check_box_outline_blank' }}</span>
                <div class="toggle-info">
                  <span class="toggle-title">{{ t('scouting.auto_park') }}</span>
                </div>
              </label>
            </div>

            <!-- Custom Fields (Auto) -->
            <DynamicFieldsRenderer
              :definitions="customFieldsStore.getActiveFields(props.eventId, 'MATCH', 'auto')"
              v-model="team.customFields"
            />
          </section>

          <!-- TeleOp (Cycle Tracker) -->
          <section class="form-section">
            <PhaseCycleTracker
              phase="teleop"
              :title="t('scouting.teleop')"
              icon="sports_esports"
              :rate-text="'+2 ' + t('scouting.unit_balls')"
              v-model="team.teleopCycles"
              v-model:missed-value="team.teleopMissedCycles"
              v-model:timestamps-value="team.teleopCycleTimestamps"
            />

            <div v-if="team.teleopCycles.length > 0" class="teleop-predict-bar">
              <span class="predict-label">
                <span class="material-icons" style="font-size: 14px;">speed</span>
                {{ t('scouting.predict_cycle_time') }}:
              </span>
              <span
                class="predict-val"
                :class="{ 'is-insufficient': getTeamPredictCycleTime(team) === null }"
              >
                {{
                  getTeamPredictCycleTime(team) !== null
                    ? t('scouting.predict_cycle_value', { sec: getTeamPredictCycleTime(team) })
                    : t('scouting.predict_cycle_insufficient')
                }}
              </span>
            </div>

            <!-- Custom Fields (TeleOp) -->
            <DynamicFieldsRenderer
              :definitions="customFieldsStore.getActiveFields(props.eventId, 'MATCH', 'teleop')"
              v-model="team.customFields"
            />
          </section>

          <!-- Endgame -->
          <section class="form-section">
            <h3><span class="material-icons">flag</span> {{ t('scouting.endgame') }}</h3>
            <p class="endgame-subtitle">{{ t('scouting.endgame_sub') }}</p>

            <div v-if="allianceFlowerCapWarning" class="endgame-warn-banner">
              <span class="material-icons" style="font-size: 16px;">warning_amber</span>
              <span>{{ t('scouting.flower_alliance_cap_warning') }}</span>
            </div>

            <div class="biobuzz-endgame-steppers">
              <!-- Flower Nectars (0..8, +2/ball) -->
              <div class="endgame-stepper-card">
                <div class="endgame-stepper-head">
                  <span class="endgame-stepper-title">{{ t('scouting.flower_nectars') }}</span>
                  <span class="endgame-stepper-rate">{{ t('scouting.flower_nectars_rate') }}</span>
                </div>
                <div class="counter-controls">
                  <button type="button" class="counter-btn" :disabled="team.flowerNectars <= 0" @click="adjustEndgameField(team, 'flowerNectars', -1)">-</button>
                  <span class="counter-val">{{ team.flowerNectars }}</span>
                  <button type="button" class="counter-btn" :disabled="team.flowerNectars >= 8" @click="adjustEndgameField(team, 'flowerNectars', 1)">+</button>
                </div>
                <div class="quick-ball-chips">
                  <button
                    v-for="chip in [0, 1, 2, 4, 8]"
                    :key="chip"
                    type="button"
                    class="quick-ball-btn"
                    :class="{ 'is-selected': team.flowerNectars === chip }"
                    @click="setEndgameField(team, 'flowerNectars', chip)"
                  >{{ chip }}</button>
                </div>
              </div>

              <!-- Bottom Nectar Bonus Count (0..4, <= flowerNectars, +5/flower) -->
              <div class="endgame-stepper-card">
                <div class="endgame-stepper-head">
                  <span class="endgame-stepper-title">{{ t('scouting.flower_bottom_bonus_count') }}</span>
                  <span class="endgame-stepper-rate">{{ t('scouting.flower_bottom_bonus_rate') }}</span>
                </div>
                <div class="counter-controls">
                  <button type="button" class="counter-btn" :disabled="team.flowerBottomBonusCount <= 0" @click="adjustEndgameField(team, 'flowerBottomBonusCount', -1)">-</button>
                  <span class="counter-val">{{ team.flowerBottomBonusCount }}</span>
                  <button type="button" class="counter-btn" :disabled="team.flowerBottomBonusCount >= Math.min(4, team.flowerNectars)" @click="adjustEndgameField(team, 'flowerBottomBonusCount', 1)">+</button>
                </div>
                <div class="quick-ball-chips">
                  <button
                    v-for="chip in [0, 1, 2, 4]"
                    :key="chip"
                    type="button"
                    class="quick-ball-btn"
                    :class="{ 'is-selected': team.flowerBottomBonusCount === chip }"
                    :disabled="chip > team.flowerNectars"
                    @click="setEndgameField(team, 'flowerBottomBonusCount', chip)"
                  >{{ chip }}</button>
                </div>
              </div>

              <!-- Flower Pollens (0..12, +2/ball) -->
              <div class="endgame-stepper-card">
                <div class="endgame-stepper-head">
                  <span class="endgame-stepper-title">{{ t('scouting.flower_pollens') }}</span>
                  <span class="endgame-stepper-rate">{{ t('scouting.flower_pollens_rate') }}</span>
                </div>
                <div class="counter-controls">
                  <button type="button" class="counter-btn" :disabled="team.flowerPollens <= 0" @click="adjustEndgameField(team, 'flowerPollens', -1)">-</button>
                  <span class="counter-val">{{ team.flowerPollens }}</span>
                  <button type="button" class="counter-btn" :disabled="team.flowerPollens >= 12" @click="adjustEndgameField(team, 'flowerPollens', 1)">+</button>
                </div>
                <div class="quick-ball-chips">
                  <button
                    v-for="chip in [0, 2, 4, 6, 8]"
                    :key="chip"
                    type="button"
                    class="quick-ball-btn"
                    :class="{ 'is-selected': team.flowerPollens === chip }"
                    @click="setEndgameField(team, 'flowerPollens', chip)"
                  >{{ chip }}</button>
                </div>
                <div v-if="team.flowerPollens > 0 && team.flowerNectars === 0" class="endgame-hint-banner">
                  <span class="material-icons" style="font-size: 14px;">info</span>
                  <span>{{ t('scouting.flower_pollen_unowned_hint') }}</span>
                </div>
              </div>

              <!-- Garden Balls (0..12, +1/ball) -->
              <div class="endgame-stepper-card">
                <div class="endgame-stepper-head">
                  <span class="endgame-stepper-title">{{ t('scouting.garden_balls') }}</span>
                  <span class="endgame-stepper-rate">{{ t('scouting.garden_balls_rate') }}</span>
                </div>
                <div class="counter-controls">
                  <button type="button" class="counter-btn" :disabled="team.gardenBalls <= 0" @click="adjustEndgameField(team, 'gardenBalls', -1)">-</button>
                  <span class="counter-val">{{ team.gardenBalls }}</span>
                  <button type="button" class="counter-btn" :disabled="team.gardenBalls >= 12" @click="adjustEndgameField(team, 'gardenBalls', 1)">+</button>
                </div>
                <div class="quick-ball-chips">
                  <button
                    v-for="chip in [0, 2, 4, 6]"
                    :key="chip"
                    type="button"
                    class="quick-ball-btn"
                    :class="{ 'is-selected': team.gardenBalls === chip }"
                    @click="setEndgameField(team, 'gardenBalls', chip)"
                  >{{ chip }}</button>
                </div>
              </div>
            </div>

            <div class="biobuzz-toggles-grid" style="margin-top: 12px;">
              <label class="toggle-card" :class="{ 'is-active': team.teleopPark }">
                <input v-model="team.teleopPark" type="checkbox" @change="hapticSelection" />
                <span class="material-icons check-icon">{{ team.teleopPark ? 'check_box' : 'check_box_outline_blank' }}</span>
                <div class="toggle-info">
                  <span class="toggle-title">{{ t('scouting.teleop_park') }}</span>
                </div>
              </label>

              <label class="toggle-card" :class="{ 'is-active': team.flowerDescore }">
                <input v-model="team.flowerDescore" type="checkbox" @change="hapticSelection" />
                <span class="material-icons check-icon">{{ team.flowerDescore ? 'check_box' : 'check_box_outline_blank' }}</span>
                <div class="toggle-info">
                  <span class="toggle-title">{{ t('scouting.flower_descore') }}</span>
                  <span class="toggle-sub">{{ t('scouting.flower_descore_desc') }}</span>
                </div>
              </label>

              <label class="toggle-card is-g410-card" :class="{ 'is-active': team.g410EarlyFlowerFoul }">
                <input v-model="team.g410EarlyFlowerFoul" type="checkbox" @change="hapticSelection" />
                <span class="material-icons check-icon" :style="team.g410EarlyFlowerFoul ? 'color: #f59e0b;' : ''">{{ team.g410EarlyFlowerFoul ? 'check_box' : 'check_box_outline_blank' }}</span>
                <div class="toggle-info">
                  <span class="toggle-title" style="color: #fbbf24;">{{ t('scouting.g410_early_flower_foul') }}</span>
                  <span class="toggle-sub">{{ t('scouting.g410_early_flower_foul_desc') }}</span>
                </div>
              </label>

              <label class="toggle-card is-broken-card" :class="{ 'is-active': team.isBroken }">
                <input v-model="team.isBroken" type="checkbox" @change="hapticSelection" />
                <span class="material-icons check-icon" style="color: var(--status-error);">{{ team.isBroken ? 'check_box' : 'check_box_outline_blank' }}</span>
                <div class="toggle-info">
                  <span class="toggle-title" style="color: var(--status-error); font-weight: bold;">{{ t('scouting.is_broken') }}</span>
                </div>
              </label>
            </div>

            <!-- Custom Fields (Endgame) -->
            <DynamicFieldsRenderer
              :definitions="customFieldsStore.getActiveFields(props.eventId, 'MATCH', 'endgame')"
              v-model="team.customFields"
            />
            
            <div class="field" style="margin-top: 16px;">
              <span>{{ t('scouting.notes') }}</span>
              <textarea 
                v-model="team.notes" 
                class="notes-input" 
                :placeholder="t('scouting.notes_placeholder')"
                rows="2"
              ></textarea>
            </div>

            <!-- Custom Fields (Overall) -->
            <DynamicFieldsRenderer
              :definitions="customFieldsStore.getActiveFields(props.eventId, 'MATCH', 'overall')"
              v-model="team.customFields"
            />
          </section>
          
          <div class="total-score-inline">
            <span class="total-label">{{ t('scouting.total_score') }}</span>
            <span class="total-value">{{ calcTeamTotal(team) }}</span>
          </div>
        </div>
      </div>

      <!-- Submit area -->
      <div class="submit-area">
        <div class="submit-status-msg" v-if="submitStatus === 'success'"><span class="material-icons">check_circle</span> {{ t('scouting.submitted') }}</div>
        <div class="submit-status-msg error" v-else-if="submitStatus === 'error'"><span class="material-icons">error</span> {{ submitErrorMsg || t('scouting.submit_failed') }}</div>
        <div v-else></div>

        <div style="display: flex; gap: 12px;">
          <button v-if="editRecord" type="button" class="btn-cancel" @click="$emit('cancelEdit')">
            <span class="material-icons">close</span> Cancel
          </button>

          <button 
            type="submit" 
            :disabled="submitting" 
            class="btn-submit" 
            :class="{ 'btn-edit-mode': !!editRecord }"
          >
            <span class="material-icons" v-if="!submitting">{{ editRecord ? 'edit' : 'cloud_upload' }}</span>
            <template v-if="editRecord">
              {{ submitting ? t('scouting.saving') : t('history.btn_save') }}
            </template>
            <template v-else>
              {{ submitting ? t('scouting.saving') : t('scouting.submit') }}
            </template>
          </button>
        </div>
      </div>
    </form>
  </div>
</template>

<style scoped>
.pit-spec-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pit-spec-chip {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(56, 189, 248, 0.14);
  border: 1px solid rgba(56, 189, 248, 0.28);
  color: var(--color-primary, #38bdf8);
}

.teleop-predict-bar {
  margin-top: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
  font-size: 12px;
}

.predict-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary, #94a3b8);
}

.predict-val {
  font-weight: 700;
  color: var(--color-primary, #38bdf8);
}

.predict-val.is-insufficient {
  font-weight: 500;
  color: var(--text-muted, #64748b);
}

.endgame-subtitle {
  margin: -4px 0 12px;
  font-size: 12px;
  color: var(--text-secondary, #94a3b8);
}

.biobuzz-endgame-steppers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}

@media (min-width: 680px) {
  .biobuzz-endgame-steppers {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.endgame-stepper-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
}

.endgame-stepper-card .quick-ball-chips {
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  padding: 4px 6px;
  max-width: 100%;
  box-sizing: border-box;
}

.endgame-stepper-card .quick-ball-btn {
  min-width: 38px;
  flex: 1 1 38px;
  height: 38px;
  font-size: 14px;
}

.endgame-stepper-card .quick-ball-btn:disabled {
  opacity: 0.32;
  cursor: not-allowed;
  transform: none;
}

.endgame-stepper-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.endgame-stepper-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #f8fafc);
}

.endgame-stepper-rate {
  font-size: 11px;
  color: var(--text-secondary, #94a3b8);
}

.endgame-warn-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
  border-radius: 10px;
  background: rgba(245, 158, 11, 0.14);
  border: 1px solid rgba(245, 158, 11, 0.4);
  color: #fbbf24;
  font-size: 12px;
  font-weight: 600;
}

.endgame-hint-banner {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: #fbbf24;
  font-size: 11px;
  line-height: 1.35;
}

.toggle-sub {
  display: block;
  font-size: 11px;
  color: var(--text-secondary, #94a3b8);
  margin-top: 2px;
}

.is-g410-card.is-active {
  border-color: rgba(245, 158, 11, 0.55);
  background: rgba(245, 158, 11, 0.12);
}
</style>

<style scoped src="./ScoutingForm.css"></style>
