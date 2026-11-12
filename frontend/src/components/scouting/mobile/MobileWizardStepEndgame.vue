<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { hapticSelection, hapticWarning } from '@/utils/haptics'
import DynamicFieldsRenderer from '@/components/customFields/DynamicFieldsRenderer.vue'
import TagPicker from '@/components/common/TagPicker.vue'
import type { CustomFieldDefinition } from '@/types'
import type { MobileTeamScoutData } from './useMobileWizardForm'

defineProps<{
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
</script>

<template>
  <section class="step-pane step-endgame">
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
  font-size: 1.1rem;
  font-weight: 800;
  color: var(--foreground, #f0efe9);
  margin: 0;
}

.pane-subtitle {
  font-size: 11px;
  color: var(--muted-foreground, #8e8d87);
}

.phase-score-badge {
  display: flex;
  align-items: baseline;
  gap: 3px;
  background: #141413;
  border: 1px solid rgba(57, 255, 20, 0.4);
  padding: 4px 12px;
  border-radius: 10px;
}

.score-val {
  font-size: 1.25rem;
  font-weight: 800;
  color: #39ff14;
  font-family: 'Orbitron', monospace;
  font-variant-numeric: tabular-nums;
}

.score-unit {
  font-size: 11px;
  color: var(--muted-foreground, #8e8d87);
}

.field-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground, #8e8d87);
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
  background: #141413;
  border: 1px solid #262624;
  border-radius: 12px;
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
  color: var(--muted-foreground, #8e8d87);
}

.toggle-text-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.toggle-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--foreground, #f0efe9);
}

.toggle-pts {
  font-size: 11px;
  color: var(--muted-foreground, #8e8d87);
}

.toggle-check-box {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1.5px solid #353532;
  background: #080807;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #080807;
  transition: all 0.2s ease;
}

.toggle-card.is-checked {
  background: #121a10;
  border-color: #39ff14;
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
  background: #1b1111;
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

/* Notes & TagPicker */
.quick-notes-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.quick-note-chip {
  background: #141413;
  border: 1px solid #262624;
  border-radius: 16px;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--foreground, #f0efe9);
  cursor: pointer;
  transition: all 0.2s ease;
}

.quick-note-chip.is-active {
  background: #141d12;
  border-color: #39ff14;
  color: #39ff14;
  font-weight: 700;
}

.notes-textarea {
  width: 100%;
  box-sizing: border-box;
  background: #080807;
  border: 1px solid #262624;
  border-radius: 12px;
  color: var(--foreground, #f0efe9);
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
  background: #141413;
  border: 1px solid #262624;
  border-radius: 12px;
}
</style>
