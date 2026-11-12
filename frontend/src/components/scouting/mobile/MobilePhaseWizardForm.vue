<script setup lang="ts">
import type { ScoutingRecord } from '@/types'
import { useMobileWizardForm } from './useMobileWizardForm'
import MobileWizardStepPreMatch from './MobileWizardStepPreMatch.vue'
import MobileWizardStepAuto from './MobileWizardStepAuto.vue'
import MobileWizardStepTeleop from './MobileWizardStepTeleop.vue'
import MobileWizardStepEndgame from './MobileWizardStepEndgame.vue'
import MobileWizardStepSummary from './MobileWizardStepSummary.vue'

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

const {
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
} = useMobileWizardForm(props, emit)
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
      <MobileWizardStepPreMatch
        v-if="currentStep === 0"
        :is-draft-restored="isDraftRestored"
        :next-pending-assignment="nextPendingAssignment"
        :alliance-color="allianceColor"
        :current-tournament-level="currentTournamentLevel"
        :match-number="matchNumber"
        :team="team"
        :banned-teams="recordStore.bannedTeams"
        :pit-summary="pitSummary"
        @clear-draft="clearDraft"
        @apply-task="applyTask"
        @update:alliance-color="allianceColor = $event"
        @update:current-tournament-level="currentTournamentLevel = $event"
        @update:match-number="matchNumber = $event"
        @increment-match="incrementMatch"
        @decrement-match="decrementMatch"
      />

      <!-- STEP 1: AUTONOMOUS (30s) -->
      <MobileWizardStepAuto
        v-else-if="currentStep === 1"
        :team="team"
        :auto-score="autoScore"
        :last-auto-cycle-index="lastAutoCycleIndex"
        :current-auto-hits="currentAutoHits"
        :current-auto-misses="currentAutoMisses"
        :current-auto-attempts="currentAutoAttempts"
        :can-start-new-auto-cycle="canStartNewAutoCycle"
        :auto-pulsing-glow="autoPulsingGlow"
        :auto-custom-definitions="autoCustomDefinitions"
        @add-auto-ball="addAutoBall"
        @add-auto-miss="addAutoMiss"
        @set-auto-preset-balls="setAutoPresetBalls"
        @handle-new-auto-cycle="handleNewAutoCycle"
        @undo-auto="undoAuto"
        @decrement-cycle-at-index="decrementCycleAtIndex($event, 'auto')"
        @remove-cycle-at-index="removeCycleAtIndex($event, 'auto')"
      />

      <!-- STEP 2: TELEOP (120s) -->
      <MobileWizardStepTeleop
        v-else-if="currentStep === 2"
        :team="team"
        :teleop-score="teleopScore"
        :teleop-balls-total="getTeleopBallsTotal()"
        :teleop-missed-total="getTeleopMissedTotal()"
        :teleop-accuracy="teleopAccuracy"
        :last-teleop-cycle-index="lastTeleopCycleIndex"
        :current-teleop-hits="currentTeleopHits"
        :current-teleop-misses="currentTeleopMisses"
        :current-teleop-attempts="currentTeleopAttempts"
        :can-start-new-teleop-cycle="canStartNewTeleopCycle"
        :teleop-pulsing-glow="teleopPulsingGlow"
        :teleop-custom-definitions="teleopCustomDefinitions"
        @add-teleop-cycle-shot="addTeleopCycleShot"
        @add-teleop-miss="addTeleopMiss"
        @set-teleop-preset-balls="setTeleopPresetBalls"
        @handle-new-teleop-cycle="handleNewTeleopCycle"
        @undo-teleop="undoTeleop"
        @decrement-cycle-at-index="decrementCycleAtIndex($event, 'teleop')"
        @remove-cycle-at-index="removeCycleAtIndex($event, 'teleop')"
      />

      <!-- STEP 3: ENDGAME (30s) -->
      <MobileWizardStepEndgame
        v-else-if="currentStep === 3"
        :event-id="eventId"
        :team="team"
        :endgame-score="endgameScore"
        :quick-notes-presets="quickNotesPresets"
        :custom-definitions="customDefinitions"
        @toggle-quick-note="toggleQuickNote"
      />

      <!-- STEP 4: SUMMARY & SUBMIT -->
      <MobileWizardStepSummary
        v-else-if="currentStep === 4"
        :match-number="matchNumber"
        :alliance-color="allianceColor"
        :team="team"
        :auto-score="autoScore"
        :teleop-score="teleopScore"
        :endgame-score="endgameScore"
        :total-score="totalScore"
        :teleop-balls-total="getTeleopBallsTotal()"
        :submit-status="submitStatus"
        :submit-error-msg="submitErrorMsg"
      />
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
  --wizard-accent: #39ff14;
  --wizard-accent-glow: rgba(57, 255, 20, 0.28);
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 120px);
  padding-bottom: 78px;
  position: relative;
  user-select: none;
  -webkit-user-select: none;
}

.mobile-wizard-container.color-red {
  --wizard-accent: #ef4444;
  --wizard-accent-glow: rgba(239, 68, 68, 0.28);
}

.mobile-wizard-container.color-blue {
  --wizard-accent: #38bdf8;
  --wizard-accent-glow: rgba(56, 189, 248, 0.28);
}

/* Edit Mode Top Bar */
.edit-mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #1c160d;
  border: 1px solid rgba(245, 158, 11, 0.45);
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
  background: #141413;
  border: 1px solid #353532;
  color: var(--foreground, #f0efe9);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 2px;
}

/* Stepper Progress Bar — Claude Matte Flat Dark (No Blur) */
.wizard-stepper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #141413;
  border: 1px solid #262624;
  border-top: 2px solid var(--wizard-accent, #39ff14);
  border-radius: 12px;
  padding: 8px 6px;
  margin-bottom: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
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
  font-family: 'Orbitron', monospace;
  font-size: 11px;
  font-weight: 700;
  background: #080807;
  border: 1px solid #262624;
  color: var(--muted-foreground, #8e8d87);
  transition: all 0.25s ease;
}

.step-label-text {
  font-size: 10px;
  color: var(--muted-foreground, #8e8d87);
  font-weight: 600;
  white-space: nowrap;
}

.stepper-step.is-active .step-num-bubble {
  background: var(--primary, #39ff14);
  border-color: var(--primary, #39ff14);
  color: #080807;
  box-shadow: 0 0 10px rgba(57, 255, 20, 0.45);
}

.stepper-step.is-active .step-label-text {
  color: var(--foreground, #f0efe9);
  font-weight: 800;
}

.stepper-step.is-completed .step-num-bubble {
  background: rgba(57, 255, 20, 0.14);
  border-color: rgba(57, 255, 20, 0.4);
  color: #39ff14;
}

.stepper-step.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Wizard Body Panes */
.wizard-body {
  flex: 1;
}

/* Sticky Bottom Wizard Action Bar — Claude Matte Flat Dark (Zero Blur) */
.wizard-bottom-bar {
  position: fixed;
  bottom: calc(56px + var(--sab, env(safe-area-inset-bottom, 0px)));
  left: 0;
  right: 0;
  padding: 8px 12px;
  background: #141413;
  border-top: 1px solid #262624;
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  gap: 10px;
  z-index: 840;
}

.btn-wizard-nav {
  height: 48px;
  border-radius: 10px;
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
  flex: 0.38;
  background: #1c1c1a;
  border: 1px solid #353532;
  color: var(--foreground, #f0efe9);
}

.btn-wizard-cancel {
  flex: 0.38;
  background: #1b1111;
  border: 1px solid rgba(239, 68, 68, 0.45);
  color: #f87171;
}

.btn-wizard-primary {
  flex: 1;
  background: #39ff14;
  border: 1px solid #39ff14;
  color: #080807;
  font-weight: 800;
  box-shadow: 0 4px 14px rgba(57, 255, 20, 0.28);
}

.btn-wizard-primary:disabled {
  background: #1c1c1a;
  border-color: #262624;
  color: var(--muted-foreground, #8e8d87);
  box-shadow: none;
  cursor: not-allowed;
}

.btn-wizard-submit {
  flex: 1;
  height: 50px;
  background: #39ff14;
  border: 1px solid #39ff14;
  color: #080807;
  font-size: 15px;
  font-weight: 900;
  box-shadow: 0 6px 20px rgba(57, 255, 20, 0.35);
}

.btn-wizard-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
