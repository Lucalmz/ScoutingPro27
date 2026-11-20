<script setup lang="ts">
import { watch, onBeforeUnmount } from 'vue'
import type { ScoutingRecord } from '@/types'
import { useMobileWizardForm } from './useMobileWizardForm'
import { useScoutAllianceHalo } from '@/composables/useScoutAllianceHalo'
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

const { setScoutAllianceHalo, clearScoutAllianceHalo } = useScoutAllianceHalo()
const haloOwner = Symbol('mobile-wizard-form')

watch(
  allianceColor,
  (color) => {
    setScoutAllianceHalo(color, haloOwner)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  clearScoutAllianceHalo(haloOwner)
})
</script>

<template>
  <div class="mobile-wizard-container" :class="[`color-${allianceColor}`, `step-${currentStep}`]">
    <!-- Edit Mode Header Banner -->
    <div v-if="editRecord" class="edit-mode-bar">
      <div class="edit-mode-info">
        <span class="material-icons" style="font-size: 16px; color: var(--status-warning);">edit_note</span>
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
  --wizard-accent: var(--primary);
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 120px);
  padding-bottom: 78px;
  position: relative;
  user-select: none;
  -webkit-user-select: none;
}

.mobile-wizard-container.color-red {
  --wizard-accent: var(--alliance-red);
}

.mobile-wizard-container.color-blue {
  --wizard-accent: var(--alliance-blue);
}

/* Edit Mode Top Bar */
.edit-mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--status-warning-bg);
  border: 1px solid var(--status-warning-border);
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
  color: var(--status-warning);
  font-variant-numeric: tabular-nums;
}

.btn-cancel-edit-chip {
  background: var(--surface-elevated);
  border: 1px solid var(--border-strong);
  color: var(--foreground);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 2px;
}

/* Stepper Progress Bar — Pit Wall Flat Dark */
.wizard-stepper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--card);
  border: 1px solid var(--border);
  border-top: 2px solid var(--wizard-accent, var(--primary));
  border-radius: 12px;
  padding: 8px 6px;
  margin-bottom: 12px;
  box-shadow: var(--shadow-2);
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
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), opacity var(--motion-duration-fast) var(--motion-ease-out);
}

.step-num-bubble {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  font-weight: 700;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  transition: background-color var(--motion-duration-moderate) var(--motion-ease-out), border-color var(--motion-duration-moderate) var(--motion-ease-out), color var(--motion-duration-moderate) var(--motion-ease-out);
}

.step-label-text {
  font-size: 10px;
  color: var(--muted-foreground);
  font-weight: 600;
  white-space: nowrap;
}

.stepper-step.is-active .step-num-bubble {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--on-primary);
  box-shadow: none;
}

.stepper-step.is-active .step-label-text {
  color: var(--foreground);
  font-weight: 800;
}

.stepper-step.is-completed .step-num-bubble {
  background: var(--status-success-bg);
  border-color: var(--status-success-border);
  color: var(--primary);
}

.stepper-step.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Wizard Body Panes */
.wizard-body {
  flex: 1;
}

/* Sticky Bottom Wizard Action Bar — Pit Wall Flat Dark */
.wizard-bottom-bar {
  position: fixed;
  bottom: calc(56px + var(--sab, env(safe-area-inset-bottom, 0px)));
  left: 0;
  right: 0;
  padding: 8px 12px;
  background: var(--card);
  border-top: 1px solid var(--border);
  box-shadow: var(--shadow-2);
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
  transition: transform var(--motion-duration-fast) var(--motion-ease-out), background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
  user-select: none;
}

.btn-wizard-nav:active {
  transform: scale(0.97);
}

.btn-wizard-prev {
  flex: 0.38;
  background: var(--surface-elevated);
  border: 1px solid var(--border-strong);
  color: var(--foreground);
}

.btn-wizard-cancel {
  flex: 0.38;
  background: var(--status-error-bg);
  border: 1px solid var(--status-error-border);
  color: var(--status-error);
}

.btn-wizard-primary {
  flex: 1;
  background: var(--primary);
  border: 1px solid var(--primary);
  color: var(--on-primary);
  font-weight: 800;
  box-shadow: var(--shadow-1);
}

.btn-wizard-primary:disabled {
  background: var(--surface-hover);
  border-color: var(--border);
  color: var(--g-500);
  box-shadow: none;
  cursor: not-allowed;
}

.btn-wizard-submit {
  flex: 1;
  height: 50px;
  background: var(--primary);
  border: 1px solid var(--primary);
  color: var(--on-primary);
  font-size: 15px;
  font-weight: 900;
  box-shadow: var(--shadow-1);
}

.btn-wizard-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
