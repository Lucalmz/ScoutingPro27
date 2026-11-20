<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { hapticSelection } from '@/utils/haptics'
import DynamicFieldsRenderer from '@/components/customFields/DynamicFieldsRenderer.vue'
import type { CustomFieldDefinition } from '@/types'
import type { MobileTeamScoutData } from './useMobileWizardForm'

defineProps<{
  team: MobileTeamScoutData
  autoScore: number
  lastAutoCycleIndex: number
  currentAutoHits: number
  currentAutoMisses: number
  currentAutoAttempts: number
  canStartNewAutoCycle: boolean
  autoPulsingGlow: boolean
  autoCustomDefinitions: CustomFieldDefinition[]
}>()

const emit = defineEmits<{
  addAutoBall: []
  addAutoMiss: []
  setAutoPresetBalls: [val: number]
  handleNewAutoCycle: []
  undoAuto: []
  decrementCycleAtIndex: [idx: number]
  removeCycleAtIndex: [idx: number]
}>()

const { t } = useI18n()
</script>

<template>
  <section class="step-pane step-auto">
    <div class="pane-header phase-auto">
      <div class="pane-header-row">
        <div>
          <h2 class="pane-title">
            <span class="material-icons phase-title-icon">smart_toy</span>
            <span>{{ t('scouting.autonomous') }} (30s)</span>
          </h2>
          <span class="pane-subtitle">{{ t('wizard.auto_sub') }}</span>
        </div>
        <div class="phase-score-badge">
          <span class="score-val">{{ autoScore }}</span>
          <span class="score-unit">{{ t('wizard.pts_unit') }}</span>
        </div>
      </div>
    </div>

    <!-- Live Cycles Ticker for Auto -->
    <div class="cycles-ticker-bar">
      <div class="ticker-stat">
        <span class="ticker-label">{{ t('wizard.total_scored') }}</span>
        <span class="ticker-val text-green">{{ team.autoBalls }}</span>
      </div>
      <div class="ticker-divider"></div>
      <div class="ticker-stat">
        <span class="ticker-label">{{ t('wizard.completed_cycles') }}</span>
        <span class="ticker-val">{{ team.autoCycles.length }} {{ t('wizard.cycles_unit') }}</span>
      </div>
      <div class="ticker-divider"></div>
      <div class="ticker-stat">
        <span class="ticker-label">{{ t('wizard.missed_balls') }}</span>
        <span class="ticker-val text-red">{{ team.autoMissedCycles.reduce((a, b) => a + b, 0) }}</span>
      </div>
    </div>

    <!-- Cycle History Chips Row for Auto -->
    <div v-if="team.autoCycles.length > 0" class="cycle-chips-scroll">
      <button
        v-for="(balls, idx) in team.autoCycles"
        :key="'ac-' + idx"
        type="button"
        class="cycle-chip"
        :class="{ 'is-current': idx === lastAutoCycleIndex }"
        @click="emit('decrementCycleAtIndex', idx)"
        :title="t('wizard.undo_btn')"
      >
        <span class="chip-idx">#{{ idx + 1 }}</span>
        <span class="chip-val">{{ balls }} {{ t('wizard.balls_unit') }}</span>
        <span v-if="(team.autoMissedCycles[idx] || 0) > 0" class="chip-miss-val text-red">
          ({{ team.autoMissedCycles[idx] }}{{ t('wizard.missed_short') }})
        </span>
        <span class="material-icons chip-remove-icon" @click.stop="emit('removeCycleAtIndex', idx)">close</span>
      </button>
    </div>

    <!-- Current Cycle Indicator & Preset Capsules for Auto -->
    <div class="current-cycle-status-card">
      <div class="current-cycle-meta">
        <span class="cycle-badge">
          {{ t('wizard.cycle_in_progress', { cycle: team.autoCycles.length || 1 }) }}
        </span>
        <div class="ball-slots-row">
          <span
            v-for="dotIdx in 4"
            :key="'auto-dot-' + dotIdx"
            class="slot-dot"
            :class="{
              'is-hit': dotIdx <= currentAutoHits,
              'is-miss': dotIdx > currentAutoHits && dotIdx <= currentAutoHits + currentAutoMisses
            }"
          ></span>
        </div>
      </div>

      <!-- 4 Quick Preset Capsules with Safety Truncation -->
      <div class="preset-capsules-grid">
        <button
          v-for="k in [1, 2, 3, 4]"
          :key="'auto-preset-' + k"
          type="button"
          class="btn-preset-capsule"
          :class="{ 'is-active': currentAutoHits === k }"
          @click="emit('setAutoPresetBalls', k)"
        >
          {{ t('wizard.preset_balls', { count: k }) }}
        </button>
      </div>
    </div>

    <!-- Tactical Thumb Cockpit Deck for Auto (HIT + MISS / UNDO + NEXT CYCLE) -->
    <div class="mobile-tactical-deck">
      <div class="tactical-trigger-grid hero-button-wrap">
        <button type="button" class="btn-hero-hit auto-hero-hit" @click="emit('addAutoBall')">
          <div class="hero-btn-inner">
            <span class="material-icons hero-icon">gps_fixed</span>
            <div class="hero-text-col">
              <span class="hero-btn-title">{{ t('wizard.auto_hit_btn') }}</span>
              <span class="hero-btn-subtitle">
                {{ currentAutoAttempts >= 4 ? t('wizard.cap_reached_tip') : t('wizard.auto_hit_sub', { count: team.autoBalls, pts: team.autoBalls * 3 }) }}
              </span>
            </div>
          </div>
          <span class="hero-readout-pill tabular-nums">{{ currentAutoHits }}</span>
        </button>

        <button type="button" class="btn-secondary-action btn-miss" @click="emit('addAutoMiss')">
          <div class="miss-btn-top">
            <span class="material-icons" style="font-size: 20px;">close</span>
            <span>{{ t('wizard.miss_btn') }}</span>
          </div>
          <span class="miss-readout-pill tabular-nums">
            {{ team.autoMissedCycles.reduce((a, b) => a + b, 0) }}
          </span>
          <span v-if="team.autoMissedCycles.reduce((a, b) => a + b, 0) > 0" class="mini-count-badge" style="display: none;">
            {{ team.autoMissedCycles.reduce((a, b) => a + b, 0) }}
          </span>
        </button>
      </div>

      <div class="tactical-cycle-control-row secondary-actions-grid next-cycle-action-row">
        <button type="button" class="btn-secondary-action btn-undo" @click="emit('undoAuto')">
          <span class="material-icons" style="font-size: 18px;">undo</span>
          <span>{{ t('wizard.undo_btn') }}</span>
        </button>

        <button
          type="button"
          class="btn-new-cycle"
          :class="{
            'pulsing-glow': autoPulsingGlow,
            'is-disabled-soft': !canStartNewAutoCycle
          }"
          @click="emit('handleNewAutoCycle')"
        >
          <span class="material-icons">skip_next</span>
          <span class="new-cycle-text">{{ t('wizard.next_cycle_btn') }}</span>
          <span class="new-cycle-hint">({{ t('wizard.next_cycle_sub') }})</span>
        </button>
      </div>
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

    <!-- Custom Fields (Auto) -->
    <div v-if="autoCustomDefinitions.length > 0" class="custom-fields-box">
      <DynamicFieldsRenderer :definitions="autoCustomDefinitions" v-model="team.customFields" />
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

.step-auto {
  --phase-color: var(--phase-auto);
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

/* Ticker & Chips */
.cycles-ticker-bar {
  display: flex;
  align-items: center;
  justify-content: space-around;
  background: var(--card);
  border: 1px solid var(--border);
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
  color: var(--muted-foreground);
}

.ticker-val {
  font-size: 15px;
  font-weight: 800;
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
}

.ticker-divider {
  width: 1px;
  height: 24px;
  background: var(--border-subtle);
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
  background: var(--card);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  white-space: nowrap;
  color: var(--foreground);
  cursor: pointer;
}

.cycle-chip:active {
  background: var(--status-error-bg);
  border-color: var(--status-error);
}

.cycle-chip.is-current {
  border-color: color-mix(in srgb, var(--phase-color) 45%, var(--border));
  background: color-mix(in srgb, var(--phase-color) 9%, var(--surface-recessed));
}

.chip-idx {
  color: var(--muted-foreground);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
}

.chip-val {
  color: var(--primary);
  font-weight: 700;
}

.chip-miss-val {
  font-size: 11px;
  font-weight: 600;
}

.chip-remove-icon {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-left: 2px;
}

/* Current Cycle Status Card & Preset Capsules */
.current-cycle-status-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
}

.current-cycle-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.cycle-badge {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 700;
  color: var(--phase-color);
}

.ball-slots-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 999px;
}

.slot-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  background: var(--g-750);
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out);
}

.slot-dot.is-hit {
  background: var(--primary);
  border-color: var(--primary);
}

.slot-dot.is-miss {
  background: var(--status-error);
  border-color: var(--status-error);
}

.preset-capsules-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.btn-preset-capsule {
  height: 34px;
  border-radius: 8px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), transform var(--motion-duration-fast) var(--motion-ease-out);
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-preset-capsule:active {
  transform: scale(0.95);
}

.btn-preset-capsule.is-active {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--on-primary);
  box-shadow: none;
}

/* Tactical Deck */
.mobile-tactical-deck {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 10px;
}

.tactical-trigger-grid {
  display: grid;
  grid-template-columns: 1.45fr 1fr;
  gap: 10px;
  width: 100%;
}

.btn-hero-hit {
  position: relative;
  width: 100%;
  min-height: 84px;
  border-radius: 12px;
  border: 1.5px solid var(--status-success-border);
  background: var(--status-success-bg);
  color: var(--primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: var(--shadow-1);
  transition: transform var(--motion-duration-fast) var(--motion-ease-out), box-shadow var(--motion-duration-fast) var(--motion-ease-out), background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out);
  box-sizing: border-box;
  padding: 10px 12px 10px 16px;
  overflow: hidden;
}

.btn-hero-hit::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--primary);
}

.btn-hero-hit:active {
  transform: scale(0.96);
  background: var(--s-800);
  border-color: var(--primary);
}

.hero-btn-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.hero-icon {
  font-size: 26px;
  color: var(--primary);
  flex-shrink: 0;
}

.hero-text-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
  min-width: 0;
}

.hero-btn-title {
  font-size: 1.05rem;
  font-weight: 900;
  letter-spacing: 0.02em;
  color: var(--s-200);
  line-height: 1.15;
}

.hero-btn-subtitle {
  font-size: 10px;
  color: var(--muted-foreground);
  margin-top: 2px;
  line-height: 1.2;
}

.hero-readout-pill {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 22px;
  font-weight: 900;
  color: var(--primary);
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  min-width: 38px;
  text-align: center;
  flex-shrink: 0;
}

.btn-secondary-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  background: var(--card);
  border: 1px solid var(--border);
  color: var(--foreground);
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), transform var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-secondary-action:active {
  transform: scale(0.96);
}

.btn-miss {
  position: relative;
  min-height: 84px;
  flex-direction: row;
  justify-content: space-between;
  padding: 10px 12px 10px 14px;
  background: var(--status-error-bg);
  border: 1.5px solid var(--status-error-border);
  color: var(--status-error-text);
  overflow: hidden;
  box-shadow: var(--shadow-1);
}

.btn-miss::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--status-error);
}

.btn-miss:active {
  background: color-mix(in srgb, var(--status-error) 22%, var(--status-error-bg));
  border-color: var(--status-error);
}

.miss-btn-top {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  font-weight: 800;
  font-size: 13px;
}

.miss-readout-pill {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 20px;
  font-weight: 900;
  color: var(--status-error);
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 9px;
  min-width: 34px;
  text-align: center;
}

.tactical-cycle-control-row {
  display: grid;
  grid-template-columns: 1fr 1.65fr;
  gap: 10px;
  margin-top: 0;
}

.btn-undo {
  height: 46px;
  background: var(--card);
  border: 1px solid var(--border-strong);
  color: var(--foreground);
  border-radius: 10px;
}

.btn-undo:active {
  background: var(--status-warning-bg);
  border-color: var(--status-warning-border);
  color: var(--status-warning);
}

.btn-new-cycle {
  width: 100%;
  height: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 10px;
  background: var(--card);
  border: 1.5px solid var(--primary);
  color: var(--primary);
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), transform var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-new-cycle:active {
  transform: scale(0.97);
}

.btn-new-cycle .new-cycle-hint {
  font-size: 10px;
  font-weight: 500;
  color: var(--muted-foreground);
}

.btn-new-cycle.is-disabled-soft {
  opacity: 0.4;
  border-color: var(--border-strong);
  color: var(--muted-foreground);
}

@keyframes pulsing-glow {
  0%, 100% {
    background: var(--primary);
    border-color: var(--primary);
    box-shadow: var(--shadow-1);
    transform: scale(1);
  }
  50% {
    background: var(--s-300);
    border-color: var(--s-200);
    box-shadow: var(--shadow-2);
    transform: scale(1.02);
  }
}

.pulsing-glow {
  animation: pulsing-glow 1.2s var(--motion-ease-in-out) infinite !important;
  border-color: var(--primary) !important;
  background: var(--primary) !important;
  color: var(--on-primary) !important;
}

.pulsing-glow .new-cycle-hint {
  color: var(--on-primary) !important;
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

.text-red { color: var(--status-error-text); }
.text-green { color: var(--primary); }
</style>
