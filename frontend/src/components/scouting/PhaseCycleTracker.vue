<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import PhaseCycleHistoryList from './PhaseCycleHistoryList.vue'
import {
  usePhaseCycleTracker,
  getAccuracyPillClass,
  getCycleAccuracyText
} from './composables/usePhaseCycleTracker'

const props = withDefaults(
  defineProps<{
    phase: 'auto' | 'teleop'
    title: string
    icon: string
    rateText: string
    modelValue: number[]
    missedValue?: number[]
    timestampsValue?: number[]
  }>(),
  {
    modelValue: () => [],
    missedValue: () => []
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', val: number[]): void
  (e: 'update:missedValue', val: number[]): void
  (e: 'update:timestampsValue', val: number[]): void
  (e: 'change', scored: number[], missed: number[]): void
}>()

const { t } = useI18n()

const {
  bump,
  getBumpClass,
  clearBump,
  isExpanded,
  listRef,
  userScrolledUp,
  isTappingNewCycle,
  currentCycleHistory,
  cycles,
  missedCycles,
  totalCycles,
  totalBalls,
  totalMissed,
  totalAttempts,
  overallAccuracy,
  avgBallsPerCycle,
  accuracyClass,
  lastCycleIndex,
  currentCycleBalls,
  currentCycleMissed,
  currentCycleAttempts,
  currentCycleAccuracy,
  canStartNewCycle,
  scrollToBottom,
  handleScroll,
  handleNewCycle,
  recordHit,
  recordMiss,
  incrementCurrentCycle,
  decrementCurrentCycle,
  setPresetBalls,
  undoLastAction,
  undoLastCycle,
  incrementSpecificCycle,
  decrementSpecificCycle,
  incrementSpecificMiss,
  decrementSpecificMiss,
  toggleExpand
} = usePhaseCycleTracker({
  getModelValue: () => props.modelValue,
  getMissedValue: () => props.missedValue,
  emitModelValue: (val) => emit('update:modelValue', val),
  emitMissedValue: (val) => emit('update:missedValue', val),
  emitChange: (scored, missed) => emit('change', scored, missed),
  getTimestampsValue: () => (props.phase === 'teleop' ? props.timestampsValue : undefined),
  emitTimestampsValue: (val) => {
    if (props.phase === 'teleop' && props.timestampsValue !== undefined) {
      emit('update:timestampsValue', val)
    }
  }
})

defineExpose({
  scrollToBottom,
  handleNewCycle,
  recordHit,
  recordMiss,
  undoLastAction,
  incrementCurrentCycle,
  decrementCurrentCycle,
  setPresetBalls,
  undoLastCycle
})
</script>

<template>
  <div class="phase-cycle-tracker" :class="`phase-${props.phase}`">
    <!-- 头部标题与积分胶囊 -->
    <div class="tracker-header">
      <div class="header-left">
        <span class="material-icons tracker-icon">{{ props.icon }}</span>
        <h4 class="tracker-title">{{ props.title }}</h4>
        <span class="rate-capsule">{{ props.rateText }}</span>
      </div>

      <div class="header-right" v-if="cycles.length > 3">
        <button
          type="button"
          class="btn-toggle-expand"
          @click="toggleExpand"
        >
          <span class="material-icons icon-toggle">{{ isExpanded ? 'expand_less' : 'expand_more' }}</span>
          <span>{{ isExpanded ? t('scouting.collapse_cycles') : t('scouting.expand_cycles', { count: cycles.length }) }}</span>
        </button>
      </div>
    </div>

    <!-- KPI 卡片统计看板 (4项统计：总轮次、进球、未进、命中率) -->
    <div class="cycle-kpis-grid">
      <div class="kpi-card">
        <span class="kpi-num">{{ totalCycles }}</span>
        <span class="kpi-label">{{ t('scouting.total_cycles') }} ({{ t('scouting.unit_cycles') }})</span>
      </div>
      <div class="kpi-card highlight-balls">
        <span class="kpi-num">{{ totalBalls }}</span>
        <span class="kpi-label">{{ t('scouting.total_balls') }} ({{ t('scouting.unit_balls') }})</span>
      </div>
      <div class="kpi-card highlight-misses">
        <span class="kpi-num">{{ totalMissed }}</span>
        <span class="kpi-label">{{ t('scouting.total_missed') }}</span>
      </div>
      <div class="kpi-card" :class="accuracyClass">
        <span class="kpi-num">{{ overallAccuracy }}</span>
        <span class="kpi-label">{{ t('scouting.accuracy') }}</span>
      </div>
    </div>

    <!-- 当前轮次录入与盲操控制台 (Claude Matte Tactical Telemetry Deck) -->
    <div class="active-cycle-card">
      <!-- Row 1: 轮次状态栏 + 4槽弹药指示器 + 快捷直选芯片 -->
      <div class="active-cycle-header-row">
        <div class="active-cycle-title-wrap">
          <span class="active-cycle-badge" v-if="cycles.length > 0">
            {{ t('scouting.cycle_num', { num: cycles.length }) }}
          </span>
          <span class="active-cycle-badge" v-else>
            {{ t('scouting.cycle_num', { num: 1 }) }}
          </span>

          <!-- 4-Chamber Visual Ball Indicator -->
          <div class="chamber-dots" aria-hidden="true">
            <span
              v-for="slot in 4"
              :key="slot"
              class="chamber-dot"
              :class="{
                'is-hit': slot <= currentCycleBalls,
                'is-miss': slot > currentCycleBalls && slot <= currentCycleAttempts
              }"
            ></span>
          </div>

          <span class="active-cycle-attempts-hint">
            {{ t('scouting.current_cycle_attempts', { attempts: currentCycleAttempts }) }}
          </span>
          <span
            v-if="currentCycleAttempts > 0"
            class="cycle-acc-pill"
            :class="getAccuracyPillClass(currentCycleBalls, currentCycleAttempts)"
          >
            {{ t('scouting.current_cycle_accuracy') }}: {{ currentCycleAccuracy }}
          </span>
          <span v-if="currentCycleAttempts >= 4" class="cap-badge">
            <span class="material-icons icon-alert">lock</span>
            {{ t('scouting.cap_reached_hint') }}
          </span>
        </div>

        <!-- 0-4 球直选预设矩阵 -->
        <div class="chips-group">
          <button
            v-for="val in [0, 1, 2, 3, 4]"
            :key="val"
            type="button"
            class="chip-ball-btn quick-ball-btn"
            :class="{ 'is-selected': cycles.length > 0 && currentCycleBalls === val }"
            @click="setPresetBalls(val)"
          >
            {{ val }}
          </button>
        </div>
      </div>

      <!-- Row 2: 🎮 主副双靶区战术触发器 (左主 HIT 进球 / 右副 MISS 未进) -->
      <div class="blind-touchpad-container">
        <!-- 🎯 进球键 (HIT) - 主武器触发器 -->
        <button
          type="button"
          class="pad-action-btn pad-hit-btn"
          :disabled="currentCycleAttempts >= 4"
          @click="recordHit"
        >
          <div class="pad-main-info">
            <div class="pad-icon-row">
              <span class="material-icons pad-icon">gps_fixed</span>
              <span class="pad-title">{{ t('scouting.hit_ball') }}</span>
              <span class="pad-step-badge">+1</span>
            </div>
            <span class="pad-current-count">{{ t('scouting.balls_in', { count: currentCycleBalls }) }}</span>
          </div>
          <div class="pad-big-readout tabular-nums">{{ currentCycleBalls }}</div>
        </button>

        <!-- ❌ 未进键 (MISS) - 副触发器 -->
        <button
          type="button"
          class="pad-action-btn pad-miss-btn"
          :disabled="currentCycleAttempts >= 4"
          @click="recordMiss"
        >
          <div class="pad-main-info">
            <div class="pad-icon-row">
              <span class="material-icons pad-icon">close</span>
              <span class="pad-title">{{ t('scouting.miss_ball') }}</span>
              <span class="pad-step-badge">+1</span>
            </div>
            <span class="pad-current-count">{{ t('scouting.balls_missed', { count: currentCycleMissed }) }}</span>
          </div>
          <div class="pad-big-readout tabular-nums">{{ currentCycleMissed }}</div>
        </button>
      </div>

      <!-- Row 3: 底部一体化战术控制栏 (微调步进 + 撤销 + 下一轮次) -->
      <div class="tactical-control-bar fine-tuning-row new-cycle-bar">
        <div class="active-counter-group">
          <span class="active-counter-label">{{ t('scouting.hit_ball') }}</span>
          <div class="counter-controls" :class="{ 'auto-stepper': props.phase === 'auto' }">
            <button
              type="button"
              class="counter-btn"
              :disabled="cycles.length === 0 || currentCycleBalls <= 0"
              @click="decrementCurrentCycle"
            >-</button>
            <span
              class="counter-val"
              :class="cycles.length > 0 ? getBumpClass(lastCycleIndex, 'cycle') : ''"
              @animationend="cycles.length > 0 ? clearBump(lastCycleIndex, 'cycle') : null"
            >{{ currentCycleBalls }}</span>
            <button
              type="button"
              class="counter-btn"
              :disabled="currentCycleAttempts >= 4"
              @click="incrementCurrentCycle"
              :title="currentCycleAttempts >= 4 ? t('scouting.cap_reached_hint') : ''"
            >+</button>
          </div>
        </div>

        <button
          type="button"
          class="btn-undo-cycle btn-action-undo"
          :disabled="cycles.length === 0 && currentCycleAttempts === 0"
          @click="undoLastAction"
          :title="t('scouting.undo_last_shot')"
        >
          <span class="material-icons">undo</span>
          <span>{{ t('scouting.undo_last_shot') }}</span>
        </button>

        <div class="new-cycle-action-wrap">
          <button
            type="button"
            class="btn-new-cycle btn-action-new-cycle"
            :class="{
              'btn-tapping': isTappingNewCycle,
              'is-suggested': canStartNewCycle && currentCycleAttempts >= 4
            }"
            :disabled="!canStartNewCycle"
            :title="!canStartNewCycle ? t('scouting.cannot_start_empty_cycle') : ''"
            @click="handleNewCycle"
          >
            <span class="material-icons">skip_next</span>
            <span>{{ t('scouting.btn_new_cycle') }}</span>
          </button>
          <span v-if="!canStartNewCycle && cycles.length > 0" class="empty-block-hint">
            {{ t('scouting.cannot_start_empty_cycle') }}
          </span>
        </div>
      </div>
    </div>

    <!-- 轮次瀑布历史 (折叠/展开与视口滚动) -->
    <PhaseCycleHistoryList
      :phase="props.phase"
      :cycles="cycles"
      :missed-cycles="missedCycles"
      :last-cycle-index="lastCycleIndex"
      :is-expanded="isExpanded"
      :get-bump-class="getBumpClass"
      :clear-bump="clearBump"
      @increment-cycle="incrementSpecificCycle"
      @decrement-cycle="decrementSpecificCycle"
      @user-scroll-change="(val) => (userScrolledUp = val)"
    />
  </div>
</template>

<style scoped>
.phase-cycle-tracker {
  --phase-color: var(--primary);
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  border-left: 3px solid var(--phase-color);
  padding-left: 12px;
}

.phase-cycle-tracker.phase-auto {
  --phase-color: var(--phase-auto);
}

.phase-cycle-tracker.phase-teleop {
  --phase-color: var(--phase-teleop);
}

.form-section.phase-auto > .phase-cycle-tracker,
.form-section.phase-teleop > .phase-cycle-tracker {
  border-left: none;
  padding-left: 0;
}

/* 头部 */
.tracker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tracker-icon {
  font-size: 20px;
  color: var(--phase-color);
}

.tracker-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--foreground);
}

.rate-capsule {
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  padding: 2px 8px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--phase-color) 12%, transparent);
  color: var(--phase-color);
  border: 1px solid color-mix(in srgb, var(--phase-color) 35%, transparent);
}

.btn-toggle-expand {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-toggle-expand:hover {
  color: var(--foreground);
  border-color: var(--phase-color);
}

.icon-toggle {
  font-size: 16px;
}

/* KPI 卡片看板 */
.cycle-kpis-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

@media (max-width: 480px) {
  .cycle-kpis-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.kpi-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px 6px;
  border-radius: 10px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  text-align: center;
}

.kpi-num {
  font-family: var(--font-numeric);
  font-size: 18px;
  font-weight: 800;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.highlight-balls .kpi-num {
  color: var(--primary);
}

.highlight-misses .kpi-num {
  color: var(--status-error);
}

.accuracy-high .kpi-num {
  color: var(--primary);
}

.accuracy-medium .kpi-num {
  color: var(--status-warning);
}

.accuracy-low .kpi-num {
  color: var(--status-error);
}

.kpi-label {
  font-size: 11px;
  color: var(--muted-foreground);
  margin-top: 2px;
}

/* 当前操作卡片 — Pit Wall Flat Dark Tactical Deck */
.active-cycle-card {
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.active-cycle-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-subtle);
}

.active-cycle-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.active-cycle-badge {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 800;
  color: var(--foreground);
  background: var(--card);
  border: 1px solid var(--border-strong);
  padding: 4px 10px;
  border-radius: 6px;
  letter-spacing: 0.04em;
}

/* 4-Chamber Ball Indicator */
.chamber-dots {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 999px;
}

.chamber-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--g-750);
  border: 1px solid var(--border-strong);
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out);
}

.chamber-dot.is-hit {
  background: var(--primary);
  border-color: var(--primary);
}

.chamber-dot.is-miss {
  background: var(--status-error);
  border-color: var(--status-error);
}

.active-cycle-attempts-hint {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.cycle-acc-pill {
  font-family: var(--font-numeric);
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 6px;
  font-variant-numeric: tabular-nums;
}

.acc-high {
  background: var(--status-success-bg);
  color: var(--status-success);
  border: 1px solid var(--status-success-border);
}

.acc-med {
  background: var(--status-warning-bg);
  color: var(--status-warning);
  border: 1px solid var(--status-warning-border);
}

.acc-low {
  background: var(--status-error-bg);
  color: var(--status-error);
  border: 1px solid var(--status-error-border);
}

.acc-none {
  background: var(--card);
  color: var(--muted-foreground);
  border: 1px solid var(--border);
}

/* 主副双靶区战术触发器 (左 HIT 1.35fr / 右 MISS 1fr) */
.blind-touchpad-container {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 10px;
  width: 100%;
}

.pad-action-btn {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 14px 18px;
  min-height: 76px;
  border-radius: 10px;
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  overflow: hidden;
  transition: transform var(--motion-duration-fast) var(--motion-ease-spring), background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), box-shadow var(--motion-duration-fast) var(--motion-ease-out);
}

.pad-action-btn::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
}

.pad-action-btn:active:not(:disabled) {
  transform: scale(0.96);
}

.pad-action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  transform: none;
  filter: grayscale(0.5);
}

/* 进球键 (HIT) */
.pad-hit-btn {
  background: var(--status-success-bg);
  border: 1.5px solid var(--status-success-border);
  color: var(--primary);
  box-shadow: var(--shadow-1);
}

.pad-hit-btn::before {
  background: var(--primary);
}

.pad-hit-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--s-800) 65%, var(--s-900));
  border-color: var(--primary);
  box-shadow: var(--shadow-2);
}

.pad-hit-btn:active:not(:disabled) {
  background: var(--s-800);
}

/* 未进键 (MISS) */
.pad-miss-btn {
  background: var(--status-error-bg);
  border: 1.5px solid var(--status-error-border);
  color: var(--status-error-text);
  box-shadow: var(--shadow-1);
}

.pad-miss-btn::before {
  background: var(--status-error);
}

.pad-miss-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--status-error) 14%, var(--status-error-bg));
  border-color: var(--status-error);
  color: var(--status-error);
  box-shadow: var(--shadow-2);
}

.pad-miss-btn:active:not(:disabled) {
  background: color-mix(in srgb, var(--status-error) 22%, var(--status-error-bg));
}

.pad-main-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
}

.pad-icon-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pad-icon {
  font-size: 20px;
}

.pad-title {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: var(--foreground);
}

.pad-hit-btn .pad-title {
  color: var(--s-200);
}

.pad-miss-btn .pad-title {
  color: var(--status-error-text);
}

.pad-step-badge {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  font-weight: 800;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--surface-recessed);
  border: 1px solid currentColor;
}

.pad-current-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
}

.pad-big-readout {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 26px;
  font-weight: 900;
  line-height: 1;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  min-width: 46px;
  text-align: center;
}

.pad-hit-btn .pad-big-readout {
  color: var(--primary);
}

.pad-miss-btn .pad-big-readout {
  color: var(--status-error);
}

.cap-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--status-error-bg);
  color: var(--status-error-text);
  border: 1px solid var(--status-error-border);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.icon-alert {
  font-size: 13px;
}

/* 底部一体化战术控制栏 (微调 + 撤销 + 下一轮次) */
.tactical-control-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border-subtle);
}

.active-counter-group {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 8px;
}

.active-counter-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted-foreground);
}

.counter-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  white-space: nowrap;
}

.counter-btn {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--surface-hover);
  color: var(--foreground);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out), transform var(--motion-duration-fast) var(--motion-ease-out);
  user-select: none;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.counter-btn:hover:not(:disabled) {
  background: var(--g-700);
  border-color: var(--primary);
  color: var(--primary);
}

.counter-btn:active:not(:disabled) {
  transform: scale(0.92);
}

.counter-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.counter-val {
  font-family: var(--font-numeric);
  font-size: 16px;
  font-weight: 800;
  min-width: 26px;
  text-align: center;
  user-select: none;
  font-variant-numeric: tabular-nums;
  display: inline-block;
  color: var(--foreground);
  transition: transform var(--motion-duration-fast) var(--motion-ease-spring), color var(--motion-duration-fast) var(--motion-ease-out);
}

.counter-val.bump-up,
.counter-val.bump-up-a {
  animation: val-bump-up-a var(--motion-duration-moderate) var(--motion-ease-spring);
}

.counter-val.bump-up-b {
  animation: val-bump-up-b var(--motion-duration-moderate) var(--motion-ease-spring);
}

.counter-val.bump-down,
.counter-val.bump-down-a {
  animation: val-bump-down-a var(--motion-duration-moderate) var(--motion-ease-spring);
}

.counter-val.bump-down-b {
  animation: val-bump-down-b var(--motion-duration-moderate) var(--motion-ease-spring);
}

@keyframes val-bump-up-a {
  0% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-3px) scale(1.15); color: var(--primary); }
  100% { transform: translateY(0) scale(1); }
}

@keyframes val-bump-up-b {
  0% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-3px) scale(1.15); color: var(--primary); }
  100% { transform: translateY(0) scale(1); }
}

@keyframes val-bump-down-a {
  0% { transform: translateY(0) scale(1); }
  50% { transform: translateY(2px) scale(0.92); color: var(--status-error); }
  100% { transform: translateY(0) scale(1); }
}

@keyframes val-bump-down-b {
  0% { transform: translateY(0) scale(1); }
  50% { transform: translateY(2px) scale(0.92); color: var(--status-error); }
  100% { transform: translateY(0) scale(1); }
}

.chips-group {
  display: flex;
  align-items: center;
  gap: 5px;
}

.chip-ball-btn {
  min-width: 32px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--muted-foreground);
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
  user-select: none;
}

.chip-ball-btn:hover {
  border-color: var(--primary);
  color: var(--foreground);
}

.chip-ball-btn.is-selected {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
  box-shadow: none;
}

/* 开启新轮次按钮区 */
.new-cycle-action-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.btn-new-cycle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--card);
  color: var(--primary);
  font-weight: 800;
  font-size: 13px;
  min-height: 40px;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1.5px solid var(--primary);
  cursor: pointer;
  user-select: none;
  box-shadow: var(--shadow-1);
  transition: transform var(--motion-duration-fast) var(--motion-ease-spring), box-shadow var(--motion-duration-fast) var(--motion-ease-out), background-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.btn-new-cycle:hover:not(:disabled) {
  background: var(--primary);
  color: var(--on-primary);
  box-shadow: var(--shadow-2);
  transform: translateY(-1px);
}

.btn-new-cycle:active:not(:disabled) {
  transform: scale(0.95);
}

.btn-new-cycle:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  border-color: var(--border-strong);
  color: var(--muted-foreground);
  box-shadow: none;
  transform: none;
}

.btn-new-cycle.btn-tapping {
  animation: cycle-btn-bloom var(--motion-duration-slow) var(--motion-ease-out) forwards;
}

.btn-new-cycle.is-suggested {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
  animation: pulse-cycle-suggest 1.4s var(--motion-ease-in-out) infinite;
}

@keyframes pulse-cycle-suggest {
  0%, 100% {
    background: var(--primary);
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

@keyframes cycle-btn-bloom {
  0% {
    transform: scale(0.96);
    filter: brightness(1);
    box-shadow: var(--shadow-1);
  }
  30% {
    transform: scale(1.03);
    filter: brightness(1.15);
    box-shadow: var(--shadow-2);
  }
  100% {
    transform: scale(1);
    filter: brightness(1);
    box-shadow: var(--shadow-1);
  }
}

.empty-block-hint {
  font-size: 11px;
  color: var(--status-warning);
  font-weight: 600;
}

.btn-undo-cycle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 40px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--card);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}

.btn-undo-cycle .material-icons {
  font-size: 16px;
}

.btn-undo-cycle:not(:disabled):hover {
  background: var(--status-warning-bg);
  color: var(--status-warning);
  border-color: var(--status-warning-border);
}

.btn-undo-cycle:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
