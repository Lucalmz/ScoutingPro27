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

function getPitSummary(teamNumStr: string) {
  const num = parseInt(teamNumStr)
  if (!num) return null
  const u = pitStore.getUnifiedTeam(num)
  if (!u?.pitRecord) return null
  const r = u.pitRecord
  return {
    drivetrain: r.drivetrainType,
    ballCompatibility: r.ballCompatibility || 'universal',
    autoScore: r.claimedAutoScore,
    teleopCycles: r.claimedTeleopCycles || 0
  }
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
    teamsData.value = [{
      teamNumber: String(rec.teamNumber),
      autoLeave: raw.autoLeave ?? false,
      autoBalls: autoBalls,
      autoCycles: autoCycles,
      autoMissedCycles: autoMissedCycles,
      autoPark: raw.autoPark ?? false,
      teleopCycles: Array.isArray(raw.teleopCycles) ? [...raw.teleopCycles] : [],
      teleopMissedCycles: teleopMissedCycles,
      flowerPlaced: raw.flowerPlaced ?? false,
      flowerBottomBonus: raw.flowerBottomBonus ?? false,
      teleopPark: raw.teleopPark ?? false,
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
      const endgame = (team.flowerPlaced ? 10 : 0) +
                      (team.flowerBottomBonus ? 5 : 0) +
                      (team.teleopPark ? 5 : 0)
      const total = auto + teleop + endgame

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
        flowerPlaced: team.flowerPlaced,
        flowerBottomBonus: team.flowerBottomBonus,
        teleopPark: team.teleopPark,
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
                <span v-if="getPitSummary(team.teamNumber)" class="pit-quick-hint" style="font-size: 11px; color: var(--color-primary, #38bdf8); margin-top: 2px; display: inline-flex; align-items: center; gap: 4px;">
                  <span class="material-icons" style="font-size: 13px;">lightbulb</span>
                  <span>{{ t('pit_scout.quick_summary', { drivetrain: formatDrivetrain(getPitSummary(team.teamNumber)?.drivetrain), ball: formatBallCompat(getPitSummary(team.teamNumber)?.ballCompatibility), auto: getPitSummary(team.teamNumber)?.autoScore ?? 0, teleop: getPitSummary(team.teamNumber)?.teleopCycles ?? 0 }) }}</span>
                </span>
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
            />

            <!-- Custom Fields (TeleOp) -->
            <DynamicFieldsRenderer
              :definitions="customFieldsStore.getActiveFields(props.eventId, 'MATCH', 'teleop')"
              v-model="team.customFields"
            />
          </section>

          <!-- Endgame -->
          <section class="form-section">
            <h3><span class="material-icons">flag</span> {{ t('scouting.endgame') }}</h3>
            <div class="biobuzz-toggles-grid">
              <label class="toggle-card" :class="{ 'is-active': team.flowerPlaced }">
                <input v-model="team.flowerPlaced" type="checkbox" @change="hapticSelection" />
                <span class="material-icons check-icon">{{ team.flowerPlaced ? 'check_box' : 'check_box_outline_blank' }}</span>
                <div class="toggle-info">
                  <span class="toggle-title">{{ t('scouting.flower_placed') }}</span>
                </div>
              </label>

              <label class="toggle-card" :class="{ 'is-active': team.flowerBottomBonus }">
                <input v-model="team.flowerBottomBonus" type="checkbox" @change="hapticSelection" />
                <span class="material-icons check-icon">{{ team.flowerBottomBonus ? 'check_box' : 'check_box_outline_blank' }}</span>
                <div class="toggle-info">
                  <span class="toggle-title">{{ t('scouting.flower_bottom_bonus') }}</span>
                </div>
              </label>

              <label class="toggle-card" :class="{ 'is-active': team.teleopPark }">
                <input v-model="team.teleopPark" type="checkbox" @change="hapticSelection" />
                <span class="material-icons check-icon">{{ team.teleopPark ? 'check_box' : 'check_box_outline_blank' }}</span>
                <div class="toggle-info">
                  <span class="toggle-title">{{ t('scouting.teleop_park') }}</span>
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
