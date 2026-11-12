<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import DynamicFieldsRenderer from '@/components/customFields/DynamicFieldsRenderer.vue'
import type { CustomFieldDefinition } from '@/types'
import type { MobileTeamScoutData } from './useMobileWizardForm'

defineProps<{
  team: MobileTeamScoutData
  teleopScore: number
  teleopBallsTotal: number
  teleopMissedTotal: number
  teleopAccuracy: string
  lastTeleopCycleIndex: number
  currentTeleopHits: number
  currentTeleopMisses: number
  currentTeleopAttempts: number
  canStartNewTeleopCycle: boolean
  teleopPulsingGlow: boolean
  teleopCustomDefinitions: CustomFieldDefinition[]
}>()

const emit = defineEmits<{
  addTeleopCycleShot: []
  addTeleopMiss: []
  setTeleopPresetBalls: [val: number]
  handleNewTeleopCycle: []
  undoTeleop: []
  decrementCycleAtIndex: [idx: number]
  removeCycleAtIndex: [idx: number]
}>()

const { t } = useI18n()
</script>

<template>
  <section class="step-pane step-teleop">
    <div class="pane-header">
      <div class="pane-header-row">
        <div>
          <h2 class="pane-title">{{ t('scouting.teleop') }} (120s)</h2>
          <span class="pane-subtitle">{{ t('wizard.teleop_sub') }}</span>
        </div>
        <div class="phase-score-badge">
          <span class="score-val">{{ teleopScore }}</span>
          <span class="score-unit">{{ t('wizard.pts_unit') }}</span>
        </div>
      </div>
    </div>

    <!-- Live Cycles Ticker -->
    <div class="cycles-ticker-bar">
      <div class="ticker-stat">
        <span class="ticker-label">{{ t('wizard.total_scored') }}</span>
        <span class="ticker-val text-green">{{ teleopBallsTotal }}</span>
      </div>
      <div class="ticker-divider"></div>
      <div class="ticker-stat">
        <span class="ticker-label">{{ t('wizard.completed_cycles') }}</span>
        <span class="ticker-val">{{ team.teleopCycles.length }} {{ t('wizard.cycles_unit') }}</span>
      </div>
      <div class="ticker-divider"></div>
      <div class="ticker-stat">
        <span class="ticker-label">{{ t('wizard.missed_balls') }}</span>
        <span class="ticker-val text-red">{{ teleopMissedTotal }}</span>
      </div>
      <div class="ticker-divider"></div>
      <div class="ticker-stat">
        <span class="ticker-label">{{ t('wizard.accuracy') }}</span>
        <span class="ticker-val">{{ teleopAccuracy }}</span>
      </div>
    </div>

    <!-- Cycle History Chips Row (clickable to adjust/delete) -->
    <div v-if="team.teleopCycles.length > 0" class="cycle-chips-scroll">
      <button
        v-for="(balls, idx) in team.teleopCycles"
        :key="'c-' + idx"
        type="button"
        class="cycle-chip"
        :class="{ 'is-current': idx === lastTeleopCycleIndex }"
        @click="emit('decrementCycleAtIndex', idx)"
        :title="t('wizard.undo_btn')"
      >
        <span class="chip-idx">#{{ idx + 1 }}</span>
        <span class="chip-val">{{ balls }} {{ t('wizard.balls_unit') }}</span>
        <span v-if="(team.teleopMissedCycles[idx] || 0) > 0" class="chip-miss-val text-red">
          ({{ team.teleopMissedCycles[idx] }}{{ t('wizard.missed_short') }})
        </span>
        <span class="material-icons chip-remove-icon" @click.stop="emit('removeCycleAtIndex', idx)">close</span>
      </button>
    </div>

    <!-- Current Cycle Indicator & Preset Capsules -->
    <div class="current-cycle-status-card">
      <div class="current-cycle-meta">
        <span class="cycle-badge">
          {{ t('wizard.cycle_in_progress', { cycle: team.teleopCycles.length || 1 }) }}
        </span>
        <div class="ball-slots-row">
          <span
            v-for="dotIdx in 4"
            :key="'dot-' + dotIdx"
            class="slot-dot"
            :class="{
              'is-hit': dotIdx <= currentTeleopHits,
              'is-miss': dotIdx > currentTeleopHits && dotIdx <= currentTeleopHits + currentTeleopMisses
            }"
          ></span>
        </div>
      </div>

      <!-- 4 Quick Preset Capsules with Safety Truncation -->
      <div class="preset-capsules-grid">
        <button
          v-for="k in [1, 2, 3, 4]"
          :key="'preset-' + k"
          type="button"
          class="btn-preset-capsule"
          :class="{ 'is-active': currentTeleopHits === k }"
          @click="emit('setTeleopPresetBalls', k)"
        >
          {{ t('wizard.preset_balls', { count: k }) }}
        </button>
      </div>
    </div>

    <!-- Tactical Thumb Cockpit Deck for TeleOp (HIT + MISS / UNDO + NEXT CYCLE) -->
    <div class="mobile-tactical-deck">
      <div class="tactical-trigger-grid hero-button-wrap hero-teleop-wrap">
        <button
          type="button"
          class="btn-hero-hit teleop-hero-hit"
          @click="emit('addTeleopCycleShot')"
        >
          <div class="hero-btn-inner">
            <span class="material-icons hero-icon-giant">gps_fixed</span>
            <div class="hero-text-col">
              <span class="hero-giant-title">{{ t('wizard.teleop_giant_hit') }}</span>
              <span class="hero-giant-subtitle">
                {{ currentTeleopAttempts >= 4 ? t('wizard.cap_reached_tip') : t('wizard.teleop_giant_sub') }}
              </span>
            </div>
          </div>
          <span class="hero-readout-pill tabular-nums">{{ currentTeleopHits }}</span>
        </button>

        <button type="button" class="btn-secondary-action btn-miss" @click="emit('addTeleopMiss')">
          <div class="miss-btn-top">
            <span class="material-icons" style="font-size: 20px;">close</span>
            <span>{{ t('wizard.teleop_miss') }}</span>
          </div>
          <span class="miss-readout-pill tabular-nums">{{ currentTeleopMisses }}</span>
          <span v-if="teleopMissedTotal > 0" class="mini-count-badge">{{ teleopMissedTotal }}</span>
        </button>
      </div>

      <div class="tactical-cycle-control-row secondary-actions-grid next-cycle-action-row">
        <button type="button" class="btn-secondary-action btn-undo" @click="emit('undoTeleop')">
          <span class="material-icons" style="font-size: 18px;">undo</span>
          <span>{{ t('wizard.teleop_undo') }}</span>
        </button>

        <button
          type="button"
          class="btn-new-cycle"
          :class="{
            'pulsing-glow': teleopPulsingGlow,
            'is-disabled-soft': !canStartNewTeleopCycle
          }"
          @click="emit('handleNewTeleopCycle')"
        >
          <span class="material-icons">skip_next</span>
          <span class="new-cycle-text">{{ t('wizard.next_cycle_btn') }}</span>
          <span class="new-cycle-hint">({{ t('wizard.next_cycle_sub') }})</span>
        </button>
      </div>
    </div>

    <!-- Custom Fields (TeleOp) -->
    <div v-if="teleopCustomDefinitions.length > 0" class="custom-fields-box">
      <DynamicFieldsRenderer :definitions="teleopCustomDefinitions" v-model="team.customFields" />
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

/* Ticker & Chips */
.cycles-ticker-bar {
  display: flex;
  align-items: center;
  justify-content: space-around;
  background: #141413;
  border: 1px solid #262624;
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
  color: var(--muted-foreground, #8e8d87);
}

.ticker-val {
  font-size: 15px;
  font-weight: 800;
  font-family: 'Orbitron', monospace;
  font-variant-numeric: tabular-nums;
}

.ticker-divider {
  width: 1px;
  height: 24px;
  background: #262624;
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
  background: #141413;
  border: 1px solid #353532;
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  white-space: nowrap;
  color: var(--foreground, #f0efe9);
  cursor: pointer;
}

.cycle-chip:active {
  background: #1b1111;
  border-color: #ef4444;
}

.cycle-chip.is-current {
  border-color: #39ff14;
  background: #141d12;
  box-shadow: 0 0 10px rgba(57, 255, 20, 0.25);
}

.chip-idx {
  color: var(--muted-foreground, #8e8d87);
  font-family: 'Orbitron', monospace;
  font-size: 10px;
}

.chip-val {
  color: #39ff14;
  font-weight: 700;
}

.chip-miss-val {
  font-size: 11px;
  font-weight: 600;
}

.chip-remove-icon {
  font-size: 12px;
  color: var(--muted-foreground, #8e8d87);
  margin-left: 2px;
}

/* Current Cycle Status Card & Preset Capsules */
.current-cycle-status-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #141413;
  border: 1px solid #262624;
  border-radius: 12px;
  padding: 10px 12px;
}

.current-cycle-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.cycle-badge {
  font-family: 'Orbitron', sans-serif;
  font-size: 12px;
  font-weight: 700;
  color: #39ff14;
}

.ball-slots-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background: #080807;
  border: 1px solid #262624;
  border-radius: 999px;
}

.slot-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid #353532;
  background: #1c1c1a;
  transition: all 0.2s ease;
}

.slot-dot.is-hit {
  background: #39ff14;
  border-color: #39ff14;
  box-shadow: 0 0 8px rgba(57, 255, 20, 0.6);
}

.slot-dot.is-miss {
  background: #ef4444;
  border-color: #ef4444;
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.6);
}

.preset-capsules-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.btn-preset-capsule {
  height: 34px;
  border-radius: 8px;
  background: #080807;
  border: 1px solid #262624;
  color: var(--foreground, #f0efe9);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-preset-capsule:active {
  transform: scale(0.95);
}

.btn-preset-capsule.is-active {
  background: #39ff14;
  border-color: #39ff14;
  color: #080807;
  box-shadow: 0 0 10px rgba(57, 255, 20, 0.35);
}

/* Tactical Deck */
.mobile-tactical-deck {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: #080807;
  border: 1px solid #262624;
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
  border: 1.5px solid rgba(57, 255, 20, 0.55);
  background: #141413;
  color: var(--foreground, #f0efe9);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  transition: transform 0.12s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.12s, background-color 0.12s;
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
  background: #39ff14;
  box-shadow: 0 0 10px #39ff14;
}

.btn-hero-hit:active {
  transform: scale(0.96);
  background: #1c2419;
  border-color: #39ff14;
}

.hero-btn-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.hero-icon-giant {
  font-size: 26px;
  color: #39ff14;
  flex-shrink: 0;
}

.hero-text-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
  min-width: 0;
}

.hero-giant-title {
  font-size: 1.05rem;
  font-weight: 900;
  letter-spacing: 0.02em;
  color: #39ff14;
  line-height: 1.15;
}

.hero-giant-subtitle {
  font-size: 10px;
  color: var(--muted-foreground, #8e8d87);
  margin-top: 2px;
  line-height: 1.2;
}

.hero-readout-pill {
  font-family: 'Orbitron', monospace;
  font-size: 22px;
  font-weight: 900;
  color: #39ff14;
  background: #080807;
  border: 1px solid #262624;
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
  background: #141413;
  border: 1px solid #262624;
  color: var(--foreground, #f0efe9);
  transition: all 0.16s ease;
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
  background: #161111;
  border: 1.5px solid rgba(239, 68, 68, 0.45);
  color: #f87171;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
}

.btn-miss::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: #ef4444;
  box-shadow: 0 0 10px #ef4444;
}

.btn-miss:active {
  background: #241414;
  border-color: #ef4444;
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
  font-family: 'Orbitron', monospace;
  font-size: 20px;
  font-weight: 900;
  color: #f87171;
  background: #080807;
  border: 1px solid #262624;
  border-radius: 8px;
  padding: 6px 9px;
  min-width: 34px;
  text-align: center;
}

.mini-count-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  background: #ef4444;
  color: #ffffff;
  font-size: 10px;
  font-weight: 800;
  border-radius: 9999px;
  padding: 1px 5px;
}

.tactical-cycle-control-row {
  display: grid;
  grid-template-columns: 1fr 1.65fr;
  gap: 10px;
  margin-top: 0;
}

.btn-undo {
  height: 46px;
  background: #141413;
  border: 1px solid #353532;
  color: var(--foreground, #f0efe9);
  border-radius: 10px;
}

.btn-undo:active {
  background: #201912;
  border-color: #f59e0b;
  color: #fbbf24;
}

.btn-new-cycle {
  width: 100%;
  height: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 10px;
  background: #141413;
  border: 1.5px solid #39ff14;
  color: #39ff14;
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-new-cycle:active {
  transform: scale(0.97);
}

.btn-new-cycle .new-cycle-hint {
  font-size: 10px;
  font-weight: 500;
  color: var(--muted-foreground, #8e8d87);
}

.btn-new-cycle.is-disabled-soft {
  opacity: 0.4;
  border-color: #353532;
  color: var(--muted-foreground, #8e8d87);
}

@keyframes pulsing-glow {
  0% {
    box-shadow: 0 0 0 0 rgba(57, 255, 20, 0.8);
    transform: scale(1);
  }
  50% {
    box-shadow: 0 0 20px 4px rgba(57, 255, 20, 0.75);
    transform: scale(1.02);
    border-color: #39ff14;
  }
  100% {
    box-shadow: 0 0 0 0 rgba(57, 255, 20, 0);
    transform: scale(1);
  }
}

.pulsing-glow {
  animation: pulsing-glow 1.2s infinite ease-in-out !important;
  border-color: #39ff14 !important;
  background: #39ff14 !important;
  color: #080807 !important;
}

.pulsing-glow .new-cycle-hint {
  color: #080807 !important;
}

.text-red { color: #f87171; }
.text-green { color: #39ff14; }
</style>
