<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { hapticSelection } from '@/utils/haptics'
import type { MobileTeamScoutData } from './useMobileWizardForm'

const props = defineProps<{
  isDraftRestored: boolean
  nextPendingAssignment: {
    matchNumber: number
    teamNumber: number
    allianceColor: 'red' | 'blue'
    station: string
    tournamentLevel?: string
  } | null
  allianceColor: 'none' | 'red' | 'blue'
  currentTournamentLevel: string
  matchNumber: string
  team: MobileTeamScoutData
  bannedTeams: number[]
  pitSummary: {
    drivetrain: string
    chassisSize?: string
    flowerMechanism?: string
    ballCompatibility: string
    autoScore: number
    teleopCycles: number
    claimedEndgameScore?: number
  } | null
}>()

const emit = defineEmits<{
  clearDraft: []
  applyTask: [task: { matchNumber: number; teamNumber: number; allianceColor: 'red' | 'blue'; tournamentLevel?: string }]
  'update:allianceColor': [color: 'none' | 'red' | 'blue']
  'update:currentTournamentLevel': [level: string]
  'update:matchNumber': [val: string]
  incrementMatch: []
  decrementMatch: []
}>()

const { t, te } = useI18n()

function formatChassisSize(val?: string) {
  if (!val) return ''
  const key = 'pit_scout.chassis_size_presets.' + val
  return te(key) ? t(key) : val
}

function formatFlowerMech(val?: string) {
  if (!val) return ''
  const key = 'pit_scout.flower_presets.' + val
  return te(key) ? t(key) : val
}

function selectAlliance(color: 'red' | 'blue') {
  emit('update:allianceColor', color)
  hapticSelection()
}

function selectLevel(level: string) {
  emit('update:currentTournamentLevel', level)
  hapticSelection()
}
</script>

<template>
  <section class="step-pane step-pre-match">
    <!-- Draft Restored Banner -->
    <div v-if="isDraftRestored" class="draft-restored-banner">
      <div class="draft-restored-content">
        <span class="material-icons" style="font-size: 16px;">restore</span>
        <span>{{ t('scouting.draft_restored') }}</span>
      </div>
      <button type="button" class="btn-clear-draft" @click="emit('clearDraft')">
        <span class="material-icons" style="font-size: 14px;">close</span>
        <span>{{ t('wizard.dismiss_draft') }}</span>
      </button>
    </div>

    <div class="pane-header">
      <h2 class="pane-title">{{ t('wizard.pre_match') }}</h2>
      <span class="pane-subtitle">{{ t('wizard.pre_match_sub') }}</span>
    </div>

    <!-- Assigned Task Card (if available) -->
    <div v-if="nextPendingAssignment" class="assigned-task-card" @click="emit('applyTask', nextPendingAssignment)">
      <div class="task-card-icon">
        <span class="material-icons" style="color: var(--primary);">assignment_ind</span>
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
          @click="selectAlliance('red')"
        >
          <div class="alliance-tag">{{ t('schedule.red_alliance') }}</div>
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
          @click="selectAlliance('blue')"
        >
          <div class="alliance-tag">{{ t('schedule.blue_alliance') }}</div>
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
          @click="selectLevel('QUALIFICATION')"
        >
          {{ t('wizard.level_qual') }}
        </button>
        <button
          type="button"
          class="btn-level-seg"
          :class="{ 'is-active': currentTournamentLevel === 'PLAYOFF' }"
          @click="selectLevel('PLAYOFF')"
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
            @click="emit('decrementMatch')"
            :disabled="parseInt(matchNumber) <= 1"
          >-</button>
          <input
            type="number"
            inputmode="numeric"
            :value="matchNumber"
            @input="emit('update:matchNumber', ($event.target as HTMLInputElement).value)"
            class="giant-num-input num-input-stepper"
            placeholder="1"
          />
          <button
            type="button"
            class="btn-stepper btn-stepper-plus"
            @click="emit('incrementMatch')"
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
    <div v-if="bannedTeams.includes(parseInt(team.teamNumber))" class="banned-warning-card">
      <span class="material-icons" style="font-size: 16px; color: var(--status-error);">warning</span>
      <span>{{ t('scouting.banned_warning') }}</span>
    </div>

    <!-- Pit Scout Preview Pill (if available) -->
    <div v-if="pitSummary" class="pit-scout-pill">
      <span class="material-icons" style="font-size: 16px; color: var(--primary);">inventory_2</span>
      <span>
        {{ t('wizard.pit_preview') }}:
        {{ t('wizard.drivetrain') }} <strong>{{ pitSummary.drivetrain }}</strong>
        <template v-if="pitSummary.chassisSize"> • <strong>{{ formatChassisSize(pitSummary.chassisSize) }}</strong></template>
        <template v-if="pitSummary.flowerMechanism"> • {{ t('wizard.flower_mech') }} <strong>{{ formatFlowerMech(pitSummary.flowerMechanism) }}</strong></template>
        • {{ t('wizard.claimed_auto') }} <strong>{{ pitSummary.autoScore }}</strong> {{ t('wizard.pts_unit') }}
        • {{ t('wizard.claimed_teleop') }} <strong>{{ pitSummary.teleopCycles }}</strong> {{ t('wizard.cycles_unit') }}
        <template v-if="pitSummary.claimedEndgameScore !== undefined"> • {{ t('wizard.claimed_endgame') }} <strong>{{ pitSummary.claimedEndgameScore }}</strong> {{ t('wizard.pts_unit') }}</template>
      </span>
    </div>
  </section>
</template>

<style scoped>
.step-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: pane-fade var(--motion-duration-moderate) var(--motion-ease-out);
}

@keyframes pane-fade {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.pane-header {
  margin-bottom: 2px;
}

.pane-title {
  font-size: 1.1rem;
  font-weight: 800;
  color: var(--foreground);
  margin: 0;
}

.pane-subtitle {
  font-size: 11px;
  color: var(--muted-foreground);
}

/* Draft Restored Banner */
.draft-restored-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--status-info-bg);
  border: 1px solid var(--status-info-border);
  border-radius: 10px;
  margin-bottom: 12px;
  color: var(--status-info);
  font-size: 12px;
  font-weight: 600;
}

.draft-restored-content {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn-clear-draft {
  background: var(--surface-elevated);
  border: 1px solid var(--status-info-border);
  color: var(--status-info);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
}

/* Assigned Task Card */
.assigned-task-card {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--status-success-bg);
  border: 1px solid var(--status-success-border);
  border-left: 3px solid var(--primary);
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
  color: var(--primary);
  letter-spacing: 0.5px;
}

.task-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.btn-task-apply {
  background: var(--card);
  border: 1px solid var(--primary);
  color: var(--primary);
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
  color: var(--muted-foreground);
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
  border-radius: 12px;
  border: 1.5px solid var(--border);
  background: var(--card);
  cursor: pointer;
  position: relative;
  transition: background-color var(--motion-duration-moderate) var(--motion-ease-out), border-color var(--motion-duration-moderate) var(--motion-ease-out), color var(--motion-duration-moderate) var(--motion-ease-out);
}

.alliance-tag {
  font-family: var(--font-sans);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 1px;
  opacity: 0.75;
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
  background: var(--alliance-red);
  box-shadow: none;
}

.alliance-dot.blue {
  background: var(--alliance-blue);
  box-shadow: none;
}

.alliance-name {
  font-size: 15px;
  font-weight: 800;
}

.alliance-btn.red-btn {
  color: var(--red-300);
}

.alliance-btn.blue-btn {
  color: var(--alliance-blue);
}

.alliance-btn.red-btn.is-selected {
  background: var(--alliance-red-bg);
  border-color: var(--alliance-red);
  border-top: 3px solid var(--alliance-red);
  color: var(--g-50);
  box-shadow: var(--shadow-1);
}

.alliance-btn.blue-btn.is-selected {
  background: var(--alliance-blue-bg);
  border-color: var(--alliance-blue);
  border-top: 3px solid var(--alliance-blue);
  color: var(--g-50);
  box-shadow: var(--shadow-1);
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
  height: 40px;
  border-radius: 10px;
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-level-seg.is-active {
  background: var(--status-success-bg);
  border-color: var(--primary);
  color: var(--primary);
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
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 1.2rem;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.btn-stepper:active {
  background: var(--surface-hover);
  border-color: var(--primary);
  color: var(--primary);
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
  background: var(--surface-recessed);
  border: 1.5px solid var(--border);
  border-radius: 10px;
  color: var(--foreground);
  font-size: 1.3rem;
  font-weight: 800;
  text-align: center;
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.giant-num-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: var(--focus-ring-sm);
}

.banned-warning-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--status-error-bg);
  border: 1px solid var(--status-error-border);
  border-radius: 10px;
  color: var(--status-error-text);
  font-size: 12px;
  font-weight: 600;
}

.pit-scout-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.pit-scout-pill strong {
  font-variant-numeric: tabular-nums;
}

.text-red { color: var(--alliance-red); }
.text-blue { color: var(--alliance-blue); }
</style>
