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
  }>(),
  {
    modelValue: () => [],
    missedValue: () => []
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', val: number[]): void
  (e: 'update:missedValue', val: number[]): void
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
  emitChange: (scored, missed) => emit('change', scored, missed)
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
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
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
  color: var(--primary, #38bdf8);
}

.tracker-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--foreground, #f8fafc);
}

.rate-capsule {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 12px;
  background: rgba(56, 189, 248, 0.15);
  color: var(--primary, #38bdf8);
  border: 1px solid rgba(56, 189, 248, 0.3);
}

.btn-toggle-expand {
  background: transparent;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  color: var(--muted-foreground, #94a3b8);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s ease;
}

.btn-toggle-expand:hover {
  color: var(--foreground, #f8fafc);
  border-color: var(--primary, #38bdf8);
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
  background: var(--surface-recessed, #080807);
  border: 1px solid var(--border, #262624);
  text-align: center;
}

.kpi-num {
  font-size: 18px;
  font-weight: 800;
  color: var(--foreground, #f0efe9);
  font-variant-numeric: tabular-nums;
}

.highlight-balls .kpi-num {
  color: var(--primary, #39ff14);
}

.highlight-misses .kpi-num {
  color: #ef4444;
}

.accuracy-high .kpi-num {
  color: var(--primary, #39ff14);
  text-shadow: 0 0 8px rgba(57, 255, 20, 0.35);
}

.accuracy-medium .kpi-num {
  color: #f59e0b;
}

.accuracy-low .kpi-num {
  color: #ef4444;
}

.kpi-label {
  font-size: 11px;
  color: var(--muted-foreground, #8e8d87);
  margin-top: 2px;
}

/* 当前操作卡片 — Claude Matte Flat Dark Tactical Deck */
.active-cycle-card {
  background: var(--surface-recessed, #080807);
  border: 1px solid var(--border, #262624);
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
  border-bottom: 1px solid var(--border-subtle, #1e1e1c);
}

.active-cycle-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.active-cycle-badge {
  font-family: 'Orbitron', sans-serif;
  font-size: 12px;
  font-weight: 800;
  color: var(--foreground, #f0efe9);
  background: #141413;
  border: 1px solid #353532;
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
  background: #141413;
  border: 1px solid #262624;
  border-radius: 999px;
}

.chamber-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #262624;
  border: 1px solid #353532;
  transition: all 0.15s ease;
}

.chamber-dot.is-hit {
  background: var(--primary, #39ff14);
  border-color: var(--primary, #39ff14);
  box-shadow: 0 0 8px rgba(57, 255, 20, 0.65);
}

.chamber-dot.is-miss {
  background: #ef4444;
  border-color: #ef4444;
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.55);
}

.active-cycle-attempts-hint {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground, #8e8d87);
  font-variant-numeric: tabular-nums;
}

.cycle-acc-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 6px;
  font-variant-numeric: tabular-nums;
}

.acc-high {
  background: rgba(57, 255, 20, 0.12);
  color: #39ff14;
  border: 1px solid rgba(57, 255, 20, 0.3);
}

.acc-med {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.acc-low {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.acc-none {
  background: #141413;
  color: var(--muted-foreground, #8e8d87);
  border: 1px solid #262624;
}

/* 🎮 主副双靶区战术触发器 (左 HIT 1.35fr / 右 MISS 1fr) */
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
  transition: all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
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

/* 🎯 进球键 (HIT) - Claude Matte Elevated + Tactical Neon/Alliance Rail */
.pad-hit-btn {
  background: #141413;
  border: 1.5px solid rgba(57, 255, 20, 0.55);
  color: var(--primary, #39ff14);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5), 0 0 14px rgba(57, 255, 20, 0.12);
}

.pad-hit-btn::before {
  background: var(--primary, #39ff14);
  box-shadow: 0 0 10px var(--primary, #39ff14);
}

.pad-hit-btn:hover:not(:disabled) {
  background: #191d17;
  border-color: var(--primary, #39ff14);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.65), 0 0 20px rgba(57, 255, 20, 0.28);
}

.pad-hit-btn:active:not(:disabled) {
  background: #1f281b;
}

/* ❌ 未进键 (MISS) - Claude Matte Elevated + Crimson Rail */
.pad-miss-btn {
  background: #161111;
  border: 1.5px solid rgba(239, 68, 68, 0.45);
  color: #f87171;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
}

.pad-miss-btn::before {
  background: #ef4444;
  box-shadow: 0 0 10px #ef4444;
}

.pad-miss-btn:hover:not(:disabled) {
  background: #1f1414;
  border-color: #ef4444;
  color: #ef4444;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.65), 0 0 16px rgba(239, 68, 68, 0.25);
}

.pad-miss-btn:active:not(:disabled) {
  background: #281616;
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
  color: var(--foreground, #f0efe9);
}

.pad-hit-btn .pad-title {
  color: var(--primary, #39ff14);
}

.pad-miss-btn .pad-title {
  color: #f87171;
}

.pad-step-badge {
  font-family: 'Orbitron', monospace;
  font-size: 10px;
  font-weight: 800;
  padding: 2px 6px;
  border-radius: 4px;
  background: #080807;
  border: 1px solid currentColor;
}

.pad-current-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground, #8e8d87);
}

.pad-big-readout {
  font-family: 'Orbitron', monospace;
  font-size: 26px;
  font-weight: 900;
  line-height: 1;
  padding: 8px 12px;
  border-radius: 8px;
  background: #080807;
  border: 1px solid #262624;
  min-width: 46px;
  text-align: center;
}

.cap-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.14);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.35);
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
  border-top: 1px solid var(--border-subtle, #1e1e1c);
}

.active-counter-group {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #141413;
  border: 1px solid #262624;
  border-radius: 8px;
  padding: 4px 8px;
}

.active-counter-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted-foreground, #8e8d87);
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
  border: 1px solid #353532;
  background: #1c1c1a;
  color: var(--foreground, #f0efe9);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  user-select: none;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.counter-btn:hover:not(:disabled) {
  background: #262624;
  border-color: var(--primary, #39ff14);
  color: var(--primary, #39ff14);
}

.counter-btn:active:not(:disabled) {
  transform: scale(0.92);
}

.counter-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.counter-val {
  font-size: 16px;
  font-weight: 800;
  min-width: 26px;
  text-align: center;
  user-select: none;
  font-variant-numeric: tabular-nums;
  display: inline-block;
  color: var(--foreground, #f0efe9);
  transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), color 0.15s ease;
}

.counter-val.bump-up,
.counter-val.bump-up-a {
  animation: val-bump-up-a 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.counter-val.bump-up-b {
  animation: val-bump-up-b 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.counter-val.bump-down,
.counter-val.bump-down-a {
  animation: val-bump-down-a 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.counter-val.bump-down-b {
  animation: val-bump-down-b 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes val-bump-up-a {
  0% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-3px) scale(1.15); color: var(--primary, #39ff14); }
  100% { transform: translateY(0) scale(1); }
}

@keyframes val-bump-up-b {
  0% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-3px) scale(1.15); color: var(--primary, #39ff14); }
  100% { transform: translateY(0) scale(1); }
}

@keyframes val-bump-down-a {
  0% { transform: translateY(0) scale(1); }
  50% { transform: translateY(2px) scale(0.92); color: var(--status-error, #ef4444); }
  100% { transform: translateY(0) scale(1); }
}

@keyframes val-bump-down-b {
  0% { transform: translateY(0) scale(1); }
  50% { transform: translateY(2px) scale(0.92); color: var(--status-error, #ef4444); }
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
  border: 1px solid #262624;
  background: #141413;
  color: var(--muted-foreground, #8e8d87);
  font-family: 'Orbitron', monospace;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  user-select: none;
}

.chip-ball-btn:hover {
  border-color: var(--primary, #39ff14);
  color: var(--foreground, #f0efe9);
}

.chip-ball-btn.is-selected {
  background: var(--primary, #39ff14);
  color: #080807;
  border-color: var(--primary, #39ff14);
  box-shadow: 0 0 10px rgba(57, 255, 20, 0.35);
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
  background: #141413;
  color: var(--primary, #39ff14);
  font-weight: 800;
  font-size: 13px;
  min-height: 40px;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1.5px solid var(--primary, #39ff14);
  cursor: pointer;
  user-select: none;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
  transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.18s ease, background-color 0.18s ease, color 0.18s ease;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.btn-new-cycle:hover:not(:disabled) {
  background: var(--primary, #39ff14);
  color: #080807;
  box-shadow: 0 0 16px rgba(57, 255, 20, 0.4);
  transform: translateY(-1px);
}

.btn-new-cycle:active:not(:disabled) {
  transform: scale(0.95);
}

.btn-new-cycle:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  border-color: #353532;
  color: var(--muted-foreground, #8e8d87);
  box-shadow: none;
  transform: none;
}

.btn-new-cycle.btn-tapping {
  animation: cycle-btn-bloom 0.45s cubic-bezier(0.2, 0.9, 0.3, 1) forwards;
}

.btn-new-cycle.is-suggested {
  background: var(--primary, #39ff14);
  color: #080807;
  border-color: var(--primary, #39ff14);
  animation: pulse-cycle-suggest 1.4s ease-in-out infinite;
}

@keyframes pulse-cycle-suggest {
  0%, 100% {
    box-shadow: 0 0 14px rgba(57, 255, 20, 0.4);
    transform: scale(1);
  }
  50% {
    box-shadow: 0 0 24px rgba(57, 255, 20, 0.8), 0 0 36px rgba(57, 255, 20, 0.4);
    transform: scale(1.02);
  }
}

@keyframes cycle-btn-bloom {
  0% {
    transform: scale(0.96);
    filter: brightness(1);
    box-shadow: 0 0 14px rgba(57, 255, 20, 0.4);
  }
  30% {
    transform: scale(1.03);
    filter: brightness(1.35) saturate(1.2);
    box-shadow: 0 0 26px rgba(57, 255, 20, 0.85), 0 0 45px rgba(57, 255, 20, 0.45);
  }
  100% {
    transform: scale(1);
    filter: brightness(1);
    box-shadow: 0 0 14px rgba(57, 255, 20, 0.4);
  }
}

.empty-block-hint {
  font-size: 11px;
  color: #f59e0b;
  font-weight: 600;
}

.btn-undo-cycle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 40px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid #353532;
  background: #141413;
  color: var(--foreground, #f0efe9);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-undo-cycle .material-icons {
  font-size: 16px;
}

.btn-undo-cycle:not(:disabled):hover {
  background: #201912;
  color: #fbbf24;
  border-color: #f59e0b;
}

.btn-undo-cycle:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
