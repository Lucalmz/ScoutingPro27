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
    ballCompatibility: string
    autoScore: number
    teleopCycles: number
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

const { t } = useI18n()

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
      <span class="material-icons" style="font-size: 16px; color: #ef4444;">warning</span>
      <span>{{ t('scouting.banned_warning') }}</span>
    </div>

    <!-- Pit Scout Preview Pill (if available) -->
    <div v-if="pitSummary" class="pit-scout-pill">
      <span class="material-icons" style="font-size: 16px; color: #39ff14;">inventory_2</span>
      <span>{{ t('wizard.pit_preview') }}: {{ t('wizard.drivetrain') }} <strong>{{ pitSummary.drivetrain }}</strong> • {{ t('wizard.claimed_auto') }} <strong>{{ pitSummary.autoScore }}</strong> {{ t('wizard.pts_unit') }} • {{ t('wizard.claimed_teleop') }} <strong>{{ pitSummary.teleopCycles }}</strong> {{ t('wizard.cycles_unit') }}</span>
    </div>
  </section>
</template>

<style scoped>
.step-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: pane-fade 0.22s ease-out;
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
  color: var(--foreground, #f0efe9);
  margin: 0;
}

.pane-subtitle {
  font-size: 11px;
  color: var(--muted-foreground, #8e8d87);
}

/* Draft Restored Banner */
.draft-restored-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #0f1622;
  border: 1px solid rgba(56, 189, 248, 0.4);
  border-radius: 10px;
  margin-bottom: 12px;
  color: #38bdf8;
  font-size: 12px;
  font-weight: 600;
}

.draft-restored-content {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn-clear-draft {
  background: #141413;
  border: 1px solid #262624;
  color: #38bdf8;
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
  background: #11170e;
  border: 1px solid rgba(57, 255, 20, 0.35);
  border-left: 3px solid #39ff14;
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
  color: var(--foreground, #f0efe9);
}

.btn-task-apply {
  background: #141413;
  border: 1px solid #39ff14;
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
  color: var(--muted-foreground, #8e8d87);
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
  border: 1.5px solid #262624;
  background: #141413;
  cursor: pointer;
  position: relative;
  transition: all 0.22s ease;
}

.alliance-tag {
  font-family: 'Orbitron', sans-serif;
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
  background: #ef4444;
  box-shadow: 0 0 8px #ef4444;
}

.alliance-dot.blue {
  background: #38bdf8;
  box-shadow: 0 0 8px #38bdf8;
}

.alliance-name {
  font-size: 15px;
  font-weight: 800;
}

.alliance-btn.red-btn {
  color: #f87171;
}

.alliance-btn.blue-btn {
  color: #38bdf8;
}

.alliance-btn.red-btn.is-selected {
  background: #1b1111;
  border-color: #ef4444;
  color: #ffffff;
  box-shadow: 0 0 18px rgba(239, 68, 68, 0.35), inset 0 2px 0 #f97316;
}

.alliance-btn.blue-btn.is-selected {
  background: #0f1622;
  border-color: #38bdf8;
  color: #ffffff;
  box-shadow: 0 0 18px rgba(56, 189, 248, 0.35), inset 0 2px 0 #3b82f6;
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
  background: #141413;
  border: 1px solid #262624;
  color: var(--muted-foreground, #8e8d87);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-level-seg.is-active {
  background: #161d13;
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
  background: #141413;
  border: 1px solid #262624;
  color: var(--foreground, #f0efe9);
  font-size: 1.2rem;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.btn-stepper:active {
  background: #1c1c1a;
  border-color: #39ff14;
  color: #39ff14;
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
  background: #080807;
  border: 1.5px solid #262624;
  border-radius: 10px;
  color: var(--foreground, #f0efe9);
  font-size: 1.3rem;
  font-weight: 800;
  text-align: center;
  font-family: 'Orbitron', monospace;
  font-variant-numeric: tabular-nums;
}

.giant-num-input:focus {
  outline: none;
  border-color: var(--primary, #39ff14);
  box-shadow: 0 0 12px rgba(57, 255, 20, 0.25);
}

.banned-warning-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #1b1111;
  border: 1px solid rgba(239, 68, 68, 0.45);
  border-radius: 10px;
  color: #f87171;
  font-size: 12px;
  font-weight: 600;
}

.pit-scout-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #141413;
  border: 1px solid #262624;
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--muted-foreground, #8e8d87);
}

.text-red { color: #f87171; }
.text-blue { color: #38bdf8; }
</style>
