<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRecordStore } from '@/stores/records'
import { useScheduleStore } from '@/stores/schedule'
import { usePitScoutStore } from '@/stores/pitScout'
import { hapticFeedback } from '@/utils/haptics'
import type { ScoutingRecord, ScoutingFormData } from '@/types'
import TagPicker from '@/components/common/TagPicker.vue'
import PitStatusIndicator from '@/components/pit/PitStatusIndicator.vue'

const { t } = useI18n()

const props = defineProps<{
  eventId: string
  scoutId: string
  scoutName: string
  editRecord?: ScoutingRecord | null
  assignedTask?: { matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue' } | null
}>()

const emit = defineEmits<{
  submit: [record: ScoutingRecord | ScoutingRecord[]]
  cancelEdit: []
}>()

const scheduleStore = useScheduleStore()
const pitStore = usePitScoutStore()

function getPitSummary(teamNumStr: string) {
  const num = parseInt(teamNumStr)
  if (!num) return null
  const u = pitStore.getUnifiedTeam(num)
  if (!u?.pitRecord) return null
  const r = u.pitRecord
  return {
    drivetrain: r.drivetrainType,
    autoScore: r.claimedAutoScore,
    hangLevel: r.claimedEndgameHangLevel
  }
}

// --- Form State ---
const scoutMode = ref<'single' | 'alliance'>('single')
const allianceColor = ref<'none' | 'red' | 'blue'>('none')
const matchNumber = ref('1')

interface TeamScoutData {
  teamNumber: string
  autoClassified: number
  autoOverflow: number
  autoPatterns: number
  autoMovementScore: string
  teleopClassified: number
  teleopOverflow: number
  gatesTriggered: number
  baseScore: number
  supportMultiplier: number
  isBroken: boolean
  notes: string
}

function createEmptyTeam(): TeamScoutData {
  return {
    teamNumber: '',
    autoClassified: 0,
    autoOverflow: 0,
    autoPatterns: 0,
    autoMovementScore: '',
    teleopClassified: 0,
    teleopOverflow: 0,
    gatesTriggered: 0,
    baseScore: 5,
    supportMultiplier: 0,
    isBroken: false,
    notes: ''
  }
}

const teamsData = ref<TeamScoutData[]>([createEmptyTeam()])

function decrement(team: any, field: keyof TeamScoutData) {
  if (typeof team[field] === 'number' && (team[field] as number) > 0) {
    (team[field] as number)--
    hapticFeedback(10)
  }
}

function increment(team: any, field: keyof TeamScoutData, max: number = 99) {
  if (typeof team[field] === 'number' && (team[field] as number) < max) {
    (team[field] as number)++
    hapticFeedback(10)
  }
}

watch(scoutMode, (mode) => {
  if (mode === 'alliance' && teamsData.value.length === 1) {
    teamsData.value.push(createEmptyTeam())
  }
})

const submitting = ref(false)
const submitStatus = ref<'none' | 'success' | 'error'>('none')
const submitErrorMsg = ref('')
const previousScoutMode = ref<'single' | 'alliance'>('single')

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
    teamsData.value = [{
      teamNumber: String(rec.teamNumber),
      autoClassified: raw.autoClassified ?? 0,
      autoOverflow: raw.autoOverflow ?? 0,
      autoPatterns: raw.autoPatterns ?? 0,
      autoMovementScore: String(raw.autoMovementScore ?? 0),
      teleopClassified: raw.teleopClassified ?? 0,
      teleopOverflow: raw.teleopOverflow ?? 0,
      gatesTriggered: raw.gatesTriggered ?? 0,
      baseScore: raw.baseScore ?? 5,
      supportMultiplier: raw.supportMultiplier ?? 0,
      isBroken: raw.isBroken ?? false,
      notes: rec.notes || ''
    }]
  }
}, { immediate: true })

function applyTask(task: { matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue' }) {
  if (scoutMode.value !== 'single') {
    scoutMode.value = 'single'
  }
  matchNumber.value = String(task.matchNumber)
  allianceColor.value = task.allianceColor
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
    const isDone = recordStore.activeRecords.some(
      (r) => r.matchNumber === t.matchNumber && r.teamNumber === t.teamNumber && r.scoutId === props.scoutId
    )
    if (!isDone) {
      const color: 'red' | 'blue' = t.station.startsWith('red') ? 'red' : 'blue'
      return {
        matchNumber: t.matchNumber,
        teamNumber: t.teamNumber,
        allianceColor: color,
        station: t.station
      }
    }
  }
  return null
})

function calcTeamTotal(team: TeamScoutData) {
  const auto = (3 * team.autoClassified) + (1 * team.autoOverflow) + (2 * team.autoPatterns) + (parseInt(team.autoMovementScore) || 0)
  const teleop = (3 * team.teleopClassified) + (1 * team.teleopOverflow) + (1.5 * team.gatesTriggered)
  const endgame = team.baseScore + (team.supportMultiplier * 18)
  return auto + teleop + endgame
}

const isFormValid = computed(() => {
  const isMatchValid = /^\d{1,8}$/.test(matchNumber.value) && parseInt(matchNumber.value) > 0
  const activeTeams = scoutMode.value === 'single' ? teamsData.value.slice(0, 1) : teamsData.value
  const areTeamsValid = activeTeams.every(t => /^\d{1,8}$/.test(t.teamNumber) && parseInt(t.teamNumber) > 0)
  const areMovementValid = activeTeams.every(t => t.autoMovementScore === '' || /^\d{1,8}$/.test(t.autoMovementScore))
  const isColorValid = allianceColor.value !== 'none'
  const isUnique = new Set(activeTeams.map(t => t.teamNumber)).size === activeTeams.length
  return isMatchValid && areTeamsValid && areMovementValid && isColorValid && isUnique
})

function isInvalidFormat(val: string) {
  if (!val) return false
  return !/^\d{1,8}$/.test(val)
}

async function handleSubmit() {
  if (!isFormValid.value) {
    submitStatus.value = 'error'
    submitErrorMsg.value = '包含非法字符或长度超限，请检查标红的输入框'
    setTimeout(() => { submitStatus.value = 'none' }, 2000)
    return
  }
  
  const recordStore = useRecordStore()
  const activeTeams = scoutMode.value === 'single' ? teamsData.value.slice(0, 1) : teamsData.value

  for (const team of activeTeams) {
    const matchNum = parseInt(matchNumber.value)
    const teamNum = parseInt(team.teamNumber)
    const existing = recordStore.activeRecords.find(r => 
      r.matchNumber === matchNum && 
      r.teamNumber === teamNum && 
      r.scoutId === props.scoutId &&
      (!props.editRecord || r.id !== props.editRecord.id)
    )
    if (existing) {
      submitStatus.value = 'error'
      submitErrorMsg.value = t('toast.conflict_error', { match: matchNum, team: teamNum })
      setTimeout(() => { submitStatus.value = 'none' }, 4000)
      return
    }
  }

  submitting.value = true
  submitStatus.value = 'none'

  try {
    const records: ScoutingRecord[] = activeTeams.map(team => {
      const auto = (3 * team.autoClassified) + (1 * team.autoOverflow) + (2 * team.autoPatterns) + (parseInt(team.autoMovementScore) || 0)
      const teleop = (3 * team.teleopClassified) + (1 * team.teleopOverflow) + (1.5 * team.gatesTriggered)
      const endgame = team.baseScore + (team.supportMultiplier * 18)
      const total = auto + teleop + endgame

      const formData: ScoutingFormData = {
        matchNumber: parseInt(matchNumber.value),
        teamNumber: parseInt(team.teamNumber),
        allianceColor: allianceColor.value,
        autoClassified: team.autoClassified,
        autoOverflow: team.autoOverflow,
        autoPatterns: team.autoPatterns,
        autoMovementScore: parseInt(team.autoMovementScore) || 0,
        teleopClassified: team.teleopClassified,
        teleopOverflow: team.teleopOverflow,
        gatesTriggered: team.gatesTriggered,
        baseScore: team.baseScore,
        supportMultiplier: team.supportMultiplier,
        isBroken: team.isBroken
      }

      return {
        id: props.editRecord ? props.editRecord.id : (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`),
        eventId: props.eventId,
        scoutId: props.scoutId,
        scoutName: props.scoutName,
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
        version: props.editRecord ? (props.editRecord.version || 0) : 0,  // addRecord 会将其 +1
        hostSeq: props.editRecord ? props.editRecord.hostSeq : undefined,
      }
    })

    if (records.length === 1) {
      emit('submit', records[0]!)
    } else {
      emit('submit', records)
    }

    submitStatus.value = 'success'
    matchNumber.value = String(parseInt(matchNumber.value) + 1)
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
    submitStatus.value = 'error'
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

const recordStore = useRecordStore()
</script>

<template>
  <div :class="wrapperClass">
    <form class="scouting-form" @submit.prevent="handleSubmit">
      
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
            <button type="button" :class="{ active: scoutMode === 'single' }" :disabled="!!editRecord" @click="scoutMode = 'single'">{{ t('scouting.single_team') }}</button>
            <button type="button" :class="{ active: scoutMode === 'alliance' }" :disabled="!!editRecord" @click="scoutMode = 'alliance'">{{ t('scouting.alliance') }}</button>
          </div>
        </div>
        <div class="setting-group">
          <span>{{ t('scouting.alliance_color') }}</span>
          <div class="spdt-switch" :class="'pos-' + allianceColor">
            <div class="spdt-thumb" v-show="allianceColor !== 'none'"></div>
            <div class="spdt-labels">
              <span @click="allianceColor = 'red'" :class="{ active: allianceColor === 'red' }">{{ t('scouting.red') }}</span>
              <span @click="allianceColor = 'blue'" :class="{ active: allianceColor === 'blue' }">{{ t('scouting.blue') }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Match Info (Shared) -->
      <section class="form-section">
        <h3><span class="material-icons">push_pin</span> {{ t('scouting.match_info') }}</h3>
        <div class="field-row">
          <label class="field">
            <span>{{ t('scouting.match_number') }}</span>
            <input v-model="matchNumber" type="text" inputmode="numeric" placeholder="1-999" :class="{ 'invalid-field': isInvalidFormat(matchNumber) }" />
          </label>
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
                  <span>展位自述：{{ getPitSummary(team.teamNumber)?.drivetrain }} | 自主 {{ getPitSummary(team.teamNumber)?.autoScore }}分 | 悬挂 L{{ getPitSummary(team.teamNumber)?.hangLevel }}</span>
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
            <h3><span class="material-icons">smart_toy</span> {{ t('scouting.autonomous') }}</h3>
            <div class="field-row">
              <label class="field">
                <span>{{ t('scouting.movement') }}</span>
                <input v-model="team.autoMovementScore" type="text" inputmode="numeric" placeholder="0" :class="{ 'invalid-field': isInvalidFormat(team.autoMovementScore) }" />
              </label>
              <div class="counter-field">
                <span class="counter-label">{{ t('scouting.patterns') }}</span>
                <div class="counter-controls">
                  <button type="button" class="counter-btn" @click="decrement(team, 'autoPatterns')">-</button>
                  <span class="counter-val">{{ team.autoPatterns }}</span>
                  <button type="button" class="counter-btn" @click="increment(team, 'autoPatterns')">+</button>
                </div>
              </div>
            </div>
            <div class="field-row split" style="margin-top: 12px">
              <div class="counter-field">
                <span class="counter-label">{{ t('scouting.classified') }}</span>
                <div class="counter-controls">
                  <button type="button" class="counter-btn" @click="decrement(team, 'autoClassified')">-</button>
                  <span class="counter-val">{{ team.autoClassified }}</span>
                  <button type="button" class="counter-btn" @click="increment(team, 'autoClassified')">+</button>
                </div>
              </div>
              <div class="counter-field">
                <span class="counter-label">{{ t('scouting.overflow') }}</span>
                <div class="counter-controls">
                  <button type="button" class="counter-btn" @click="decrement(team, 'autoOverflow')">-</button>
                  <span class="counter-val">{{ team.autoOverflow }}</span>
                  <button type="button" class="counter-btn" @click="increment(team, 'autoOverflow')">+</button>
                </div>
              </div>
            </div>
          </section>

          <!-- TeleOp -->
          <section class="form-section">
            <h3><span class="material-icons">sports_esports</span> {{ t('scouting.teleop') }}</h3>
            <div class="field-row">
              <div class="counter-field">
                <span class="counter-label">{{ t('scouting.gates') }}</span>
                <div class="counter-controls">
                  <button type="button" class="counter-btn" @click="decrement(team, 'gatesTriggered')">-</button>
                  <span class="counter-val">{{ team.gatesTriggered }}</span>
                  <button type="button" class="counter-btn" @click="increment(team, 'gatesTriggered')">+</button>
                </div>
              </div>
            </div>
            <div class="field-row split" style="margin-top: 12px">
              <div class="counter-field">
                <span class="counter-label">{{ t('scouting.classified') }}</span>
                <div class="counter-controls">
                  <button type="button" class="counter-btn" @click="decrement(team, 'teleopClassified')">-</button>
                  <span class="counter-val">{{ team.teleopClassified }}</span>
                  <button type="button" class="counter-btn" @click="increment(team, 'teleopClassified')">+</button>
                </div>
              </div>
              <div class="counter-field">
                <span class="counter-label">{{ t('scouting.overflow') }}</span>
                <div class="counter-controls">
                  <button type="button" class="counter-btn" @click="decrement(team, 'teleopOverflow')">-</button>
                  <span class="counter-val">{{ team.teleopOverflow }}</span>
                  <button type="button" class="counter-btn" @click="increment(team, 'teleopOverflow')">+</button>
                </div>
              </div>
            </div>
          </section>

          <!-- Endgame -->
          <section class="form-section">
            <h3><span class="material-icons">flag</span> {{ t('scouting.endgame') }}</h3>
            <div class="field">
              <span>{{ t('scouting.base_score') }}</span>
              <select v-model.number="team.baseScore">
                <option :value="5">5 pts</option>
                <option :value="10">10 pts</option>
              </select>
            </div>
            <label class="toggle" style="margin-top: 10px">
              <input v-model="team.supportMultiplier" :true-value="1" :false-value="0" type="checkbox" />
              <span>{{ t('scouting.support') }}</span>
            </label>
            <label class="toggle" style="margin-top: 10px; color: var(--status-error);">
              <input v-model="team.isBroken" type="checkbox" />
              <span style="color: var(--status-error); font-weight: bold;">{{ t('scouting.is_broken') }}</span>
            </label>
            
            <div class="field" style="margin-top: 16px;">
              <span>{{ t('scouting.notes') }}</span>
              <textarea 
                v-model="team.notes" 
                class="notes-input" 
                :placeholder="t('scouting.notes_placeholder')"
                rows="2"
              ></textarea>
            </div>
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

<style scoped src="./ScoutingForm.css"></style>
