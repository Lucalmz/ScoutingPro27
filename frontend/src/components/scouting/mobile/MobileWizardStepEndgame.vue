<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { hapticSelection, hapticWarning } from '@/utils/haptics'
import DynamicFieldsRenderer from '@/components/customFields/DynamicFieldsRenderer.vue'
import TagPicker from '@/components/common/TagPicker.vue'
import type { CustomFieldDefinition } from '@/types'
import type { MobileTeamScoutData } from './useMobileWizardForm'

const props = defineProps<{
  eventId: string
  team: MobileTeamScoutData
  endgameScore: number
  quickNotesPresets: Array<{ key: string; label: string }>
  customDefinitions: CustomFieldDefinition[]
}>()

const emit = defineEmits<{
  toggleQuickNote: [noteText: string]
}>()

const { t } = useI18n()

type EndgameCounterField =
  | 'flowerNectars'
  | 'flowerBottomBonusCount'
  | 'flowerPollens'
  | 'gardenBalls'

function setCounter(field: EndgameCounterField, rawValue: number) {
  const num = Number.isFinite(rawValue) ? Math.round(rawValue) : 0
  if (field === 'flowerNectars') {
    const clamped = Math.max(0, Math.min(8, num))
    props.team.flowerNectars = clamped
    props.team.flowerBottomBonusCount = Math.min(props.team.flowerBottomBonusCount, clamped)
    props.team.flowerPlaced = clamped > 0
    props.team.flowerBottomBonus = props.team.flowerBottomBonusCount > 0
  } else if (field === 'flowerBottomBonusCount') {
    const cap = Math.min(4, props.team.flowerNectars)
    const clamped = Math.max(0, Math.min(cap, num))
    props.team.flowerBottomBonusCount = clamped
    props.team.flowerBottomBonus = clamped > 0
  } else if (field === 'flowerPollens') {
    props.team.flowerPollens = Math.max(0, Math.min(12, num))
  } else if (field === 'gardenBalls') {
    props.team.gardenBalls = Math.max(0, Math.min(12, num))
  }
  hapticSelection()
}

function adjustCounter(field: EndgameCounterField, delta: number) {
  setCounter(field, (props.team[field] || 0) + delta)
}
</script>

<template>
  <section class="step-pane step-endgame">
    <div class="pane-header phase-endgame">
      <div class="pane-header-row">
        <div>
          <h2 class="pane-title">
            <span class="material-icons phase-title-icon">flag</span>
            <span>{{ t('scouting.endgame') }}</span>
          </h2>
          <span class="pane-subtitle">{{ t('wizard.endgame_header_tag') }}</span>
        </div>
        <div class="phase-score-badge">
          <span class="score-val">{{ endgameScore }}</span>
          <span class="score-unit">{{ t('wizard.pts_unit') }}</span>
        </div>
      </div>
    </div>

    <!-- BIOBUZZ Flower & Garden Steppers -->
    <div class="mobile-endgame-steppers">
      <!-- Flower Nectars (0..8) -->
      <div class="mobile-stepper-card">
        <div class="stepper-header">
          <div class="stepper-title-wrap">
            <span class="material-icons toggle-icon icon-nectar">local_florist</span>
            <div>
              <div class="toggle-title">{{ t('scouting.flower_nectars') }}</div>
              <div class="toggle-pts">{{ t('wizard.nectar_pts') }}</div>
            </div>
          </div>
          <div class="stepper-ctrl">
            <button type="button" class="btn-step" :disabled="team.flowerNectars <= 0" @click="adjustCounter('flowerNectars', -1)">-</button>
            <span class="step-val">{{ team.flowerNectars }}</span>
            <button type="button" class="btn-step" :disabled="team.flowerNectars >= 8" @click="adjustCounter('flowerNectars', 1)">+</button>
          </div>
        </div>
        <div class="chip-row">
          <button
            v-for="chip in [0, 1, 2, 4, 8]"
            :key="chip"
            type="button"
            class="chip-btn"
            :class="{ 'is-active': team.flowerNectars === chip }"
            @click="setCounter('flowerNectars', chip)"
          >{{ chip }}</button>
        </div>
      </div>

      <!-- Bottom Nectar Bonus (0..4 <= Nectars) -->
      <div class="mobile-stepper-card">
        <div class="stepper-header">
          <div class="stepper-title-wrap">
            <span class="material-icons toggle-icon icon-bonus">spa</span>
            <div>
              <div class="toggle-title">{{ t('scouting.flower_bottom_bonus_count') }}</div>
              <div class="toggle-pts">{{ t('wizard.bottom_bonus_pts') }}</div>
            </div>
          </div>
          <div class="stepper-ctrl">
            <button type="button" class="btn-step" :disabled="team.flowerBottomBonusCount <= 0" @click="adjustCounter('flowerBottomBonusCount', -1)">-</button>
            <span class="step-val">{{ team.flowerBottomBonusCount }}</span>
            <button type="button" class="btn-step" :disabled="team.flowerBottomBonusCount >= Math.min(4, team.flowerNectars)" @click="adjustCounter('flowerBottomBonusCount', 1)">+</button>
          </div>
        </div>
        <div class="chip-row">
          <button
            v-for="chip in [0, 1, 2, 4]"
            :key="chip"
            type="button"
            class="chip-btn"
            :class="{ 'is-active': team.flowerBottomBonusCount === chip }"
            :disabled="chip > team.flowerNectars"
            @click="setCounter('flowerBottomBonusCount', chip)"
          >{{ chip }}</button>
        </div>
      </div>

      <!-- Flower Pollens (0..12) -->
      <div class="mobile-stepper-card">
        <div class="stepper-header">
          <div class="stepper-title-wrap">
            <span class="material-icons toggle-icon icon-pollen">grain</span>
            <div>
              <div class="toggle-title">{{ t('scouting.flower_pollens') }}</div>
              <div class="toggle-pts">{{ t('wizard.pollen_pts') }}</div>
            </div>
          </div>
          <div class="stepper-ctrl">
            <button type="button" class="btn-step" :disabled="team.flowerPollens <= 0" @click="adjustCounter('flowerPollens', -1)">-</button>
            <span class="step-val">{{ team.flowerPollens }}</span>
            <button type="button" class="btn-step" :disabled="team.flowerPollens >= 12" @click="adjustCounter('flowerPollens', 1)">+</button>
          </div>
        </div>
        <div class="chip-row">
          <button
            v-for="chip in [0, 2, 4, 6, 8]"
            :key="chip"
            type="button"
            class="chip-btn"
            :class="{ 'is-active': team.flowerPollens === chip }"
            @click="setCounter('flowerPollens', chip)"
          >{{ chip }}</button>
        </div>
        <div v-if="team.flowerPollens > 0 && team.flowerNectars === 0" class="mobile-unowned-hint">
          <span class="material-icons" style="font-size: 14px;">info</span>
          <span>{{ t('scouting.flower_pollen_unowned_hint') }}</span>
        </div>
      </div>

      <!-- Garden Balls (0..12) -->
      <div class="mobile-stepper-card">
        <div class="stepper-header">
          <div class="stepper-title-wrap">
            <span class="material-icons toggle-icon icon-garden">yard</span>
            <div>
              <div class="toggle-title">{{ t('scouting.garden_balls') }}</div>
              <div class="toggle-pts">{{ t('wizard.garden_pts') }}</div>
            </div>
          </div>
          <div class="stepper-ctrl">
            <button type="button" class="btn-step" :disabled="team.gardenBalls <= 0" @click="adjustCounter('gardenBalls', -1)">-</button>
            <span class="step-val">{{ team.gardenBalls }}</span>
            <button type="button" class="btn-step" :disabled="team.gardenBalls >= 12" @click="adjustCounter('gardenBalls', 1)">+</button>
          </div>
        </div>
        <div class="chip-row">
          <button
            v-for="chip in [0, 2, 4, 6]"
            :key="chip"
            type="button"
            class="chip-btn"
            :class="{ 'is-active': team.gardenBalls === chip }"
            @click="setCounter('gardenBalls', chip)"
          >{{ chip }}</button>
        </div>
      </div>
    </div>

    <!-- Toggle Group -->
    <div class="toggle-cards-group">
      <button
        type="button"
        class="toggle-card"
        :class="{ 'is-checked': team.teleopPark }"
        @click="team.teleopPark = !team.teleopPark; hapticSelection()"
      >
        <div class="toggle-card-left">
          <span class="material-icons toggle-icon icon-park">local_parking</span>
          <div class="toggle-text-wrap">
            <span class="toggle-title">{{ t('scouting.teleop_park') }}</span>
            <span class="toggle-pts">{{ t('wizard.park_pts') }}</span>
          </div>
        </div>
        <div class="toggle-check-box">
          <span v-if="team.teleopPark" class="material-icons">check</span>
        </div>
      </button>

      <button
        type="button"
        class="toggle-card"
        :class="{ 'is-checked': team.flowerDescore }"
        @click="team.flowerDescore = !team.flowerDescore; hapticSelection()"
      >
        <div class="toggle-card-left">
          <span class="material-icons toggle-icon icon-descore">cleaning_services</span>
          <div class="toggle-text-wrap">
            <span class="toggle-title">{{ t('scouting.flower_descore') }}</span>
            <span class="toggle-pts">{{ t('scouting.flower_descore_desc') }}</span>
          </div>
        </div>
        <div class="toggle-check-box">
          <span v-if="team.flowerDescore" class="material-icons">check</span>
        </div>
      </button>

      <button
        type="button"
        class="toggle-card g410-toggle-card"
        :class="{ 'is-g410-checked': team.g410EarlyFlowerFoul }"
        @click="team.g410EarlyFlowerFoul = !team.g410EarlyFlowerFoul; hapticWarning()"
      >
        <div class="toggle-card-left">
          <span class="material-icons toggle-icon">gavel</span>
          <div class="toggle-text-wrap">
            <span class="toggle-title">{{ t('scouting.g410_early_flower_foul') }}</span>
            <span class="toggle-pts">{{ t('scouting.g410_early_flower_foul_desc') }}</span>
          </div>
        </div>
        <div class="toggle-check-box g410-check">
          <span v-if="team.g410EarlyFlowerFoul" class="material-icons">warning</span>
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
          <span class="material-icons toggle-icon">healing</span>
          <div class="toggle-text-wrap">
            <span class="toggle-title">{{ t('scouting.is_broken') }}</span>
            <span class="toggle-pts">{{ t('wizard.broken_sub') }}</span>
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
          @click="emit('toggleQuickNote', chip.label)"
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
        :event-id="eventId"
        :team-number="parseInt(team.teamNumber)"
      />
    </div>

    <!-- Custom Fields (if defined) -->
    <div v-if="customDefinitions.length > 0" class="custom-fields-box">
      <DynamicFieldsRenderer :definitions="customDefinitions" v-model="team.customFields" />
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

.step-endgame {
  --phase-color: var(--phase-endgame);
}

@keyframes pane-fade {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.pane-header {
  margin-bottom: 2px;
  background: var(--card);
  border: 1px solid var(--border);
  border-left: 3px solid var(--phase-color);
  border-radius: 12px;
  padding: 10px 12px;
}

.pane-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pane-title {
  font-size: 1.1rem;
  font-weight: 800;
  color: var(--foreground);
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.phase-title-icon {
  font-size: 18px;
  color: var(--phase-color);
}

.pane-subtitle {
  font-size: 11px;
  color: var(--muted-foreground);
}

.phase-score-badge {
  display: flex;
  align-items: baseline;
  gap: 3px;
  background: var(--surface-recessed);
  border: 1px solid color-mix(in srgb, var(--phase-color) 35%, var(--border));
  padding: 4px 12px;
  border-radius: 10px;
}

.score-val {
  font-size: 1.25rem;
  font-weight: 800;
  color: var(--phase-color);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.score-unit {
  font-size: 11px;
  color: var(--muted-foreground);
}

.field-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
  margin-bottom: 6px;
}

/* Toggle Cards Group */
.toggle-cards-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toggle-card {
  width: 100%;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out);
  box-sizing: border-box;
}

.toggle-card-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toggle-icon {
  font-size: 24px;
  color: var(--muted-foreground);
}

.icon-nectar { color: var(--phase-endgame); }
.icon-bonus { color: var(--s-400); }
.icon-pollen { color: var(--status-warning); }
.icon-garden { color: var(--s-300); }
.icon-park { color: var(--status-info); }
.icon-descore { color: var(--status-ai); }

.toggle-text-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.toggle-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--foreground);
}

.toggle-pts {
  font-size: 11px;
  color: var(--muted-foreground);
}

.toggle-check-box {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1.5px solid var(--border-strong);
  background: var(--surface-recessed);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--on-primary);
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}

.toggle-card.is-checked {
  background: var(--status-success-bg);
  border-color: var(--primary);
}

.toggle-card.is-checked .toggle-icon {
  color: var(--primary);
}

.toggle-card.is-checked .toggle-pts {
  color: var(--primary);
}

.toggle-card.is-checked .toggle-check-box {
  background: var(--primary);
  border-color: var(--primary);
}

.broken-toggle-card .toggle-icon {
  color: var(--status-error);
}

.broken-toggle-card .toggle-pts {
  color: var(--status-error-text);
}

.broken-toggle-card.is-broken-checked {
  background: var(--status-error-bg);
  border-color: var(--status-error);
}

.broken-check {
  border-color: var(--status-error-border);
  color: var(--status-error);
}

.broken-toggle-card.is-broken-checked .broken-check {
  background: var(--status-error);
  color: var(--destructive-foreground);
}

/* Notes & TagPicker */
.quick-notes-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.quick-note-chip {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--foreground);
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}

.quick-note-chip.is-active {
  background: var(--status-success-bg);
  border-color: var(--primary);
  color: var(--primary);
  font-weight: 700;
}

.notes-textarea {
  width: 100%;
  box-sizing: border-box;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--foreground);
  padding: 10px 12px;
  font-size: 13px;
  resize: vertical;
  transition: border-color var(--motion-duration-fast) var(--motion-ease-out), box-shadow var(--motion-duration-fast) var(--motion-ease-out);
}

.notes-textarea:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: var(--focus-ring-sm);
}

.team-tags-container {
  margin-top: 6px;
  padding: 12px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.mobile-endgame-steppers {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mobile-stepper-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stepper-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.stepper-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.stepper-ctrl {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.btn-step {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--surface-hover);
  color: var(--foreground);
  font-size: 18px;
  font-weight: 700;
  cursor: pointer;
}

.btn-step:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.step-val {
  min-width: 22px;
  text-align: center;
  font-size: 16px;
  font-weight: 800;
  color: var(--foreground);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip-btn {
  flex: 1;
  min-width: 38px;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface-recessed);
  color: var(--muted-foreground);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.chip-btn.is-active {
  background: var(--status-success-bg);
  border-color: var(--primary);
  color: var(--primary);
}

.chip-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.mobile-unowned-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--status-warning-bg);
  border: 1px solid var(--status-warning-border);
  color: var(--status-warning);
  font-size: 11px;
  line-height: 1.35;
}

.g410-toggle-card .toggle-icon,
.g410-toggle-card .toggle-pts {
  color: var(--status-warning);
}

.g410-toggle-card.is-g410-checked {
  background: var(--status-warning-bg);
  border-color: var(--status-warning);
}

.g410-check {
  border-color: var(--status-warning-border);
  color: var(--status-warning);
}

.g410-toggle-card.is-g410-checked .g410-check {
  background: var(--status-warning);
  color: var(--on-primary);
}
</style>
