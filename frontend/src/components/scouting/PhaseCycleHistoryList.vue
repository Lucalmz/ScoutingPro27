<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getAccuracyPillClass,
  getCycleAccuracyText
} from './composables/usePhaseCycleTracker'

const props = defineProps<{
  phase: 'auto' | 'teleop'
  cycles: number[]
  missedCycles: number[]
  lastCycleIndex: number
  isExpanded: boolean
  getBumpClass: (idx: number, key?: string) => string
  clearBump: (idx: number, key?: string) => void
}>()

const emit = defineEmits<{
  (e: 'incrementCycle', cIdx: number): void
  (e: 'decrementCycle', cIdx: number): void
  (e: 'userScrollChange', scrolledUp: boolean): void
}>()

const { t } = useI18n()
const listRef = ref<HTMLElement | null>(null)

function scrollToBottom(smooth = true) {
  nextTick(() => {
    if (listRef.value && typeof listRef.value.scrollTo === 'function') {
      listRef.value.scrollTo({
        top: listRef.value.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
      })
    }
  })
}

function handleScroll() {
  if (!listRef.value) return
  const { scrollTop, scrollHeight, clientHeight } = listRef.value
  emit('userScrollChange', scrollHeight - scrollTop - clientHeight > 28)
}

onMounted(() => {
  scrollToBottom(false)
})

defineExpose({
  scrollToBottom
})
</script>

<template>
  <div v-if="cycles.length > 0" class="cycles-history-wrapper">
    <div
      ref="listRef"
      class="cycles-scroll-container cycle-history-list"
      :class="{ 'is-expanded': isExpanded, 'auto-cycle-list': props.phase === 'auto' }"
      @scroll="handleScroll"
    >
      <div
        v-for="(count, cIdx) in cycles"
        :key="cIdx"
        class="cycle-row-item cycle-history-item"
        :class="{ 'is-active-row': cIdx === lastCycleIndex }"
      >
        <div class="cycle-row-left">
          <span class="cycle-row-badge cycle-badge-index">{{ t('scouting.cycle_num', { num: cIdx + 1 }) }}</span>
          <span class="cycle-row-stat-text">
            {{ t('scouting.balls_summary', { inCount: count, missCount: missedCycles[cIdx] ?? 0 }) }}
          </span>
          <span
            class="cycle-row-acc-pill"
            :class="getAccuracyPillClass(count, count + (missedCycles[cIdx] ?? 0))"
          >
            {{ getCycleAccuracyText(count, missedCycles[cIdx] ?? 0) }}
          </span>
        </div>

        <!-- 历史微调控制器 -->
        <div class="cycle-row-counter counter-field cycle-item-counter">
          <button
            type="button"
            class="mini-counter-btn counter-btn"
            :disabled="count <= 0"
            @click="emit('decrementCycle', cIdx)"
          >-</button>
          <span
            class="mini-counter-val counter-val"
            :class="getBumpClass(cIdx, 'cycle')"
            @animationend="clearBump(cIdx, 'cycle')"
          >{{ count }}</span>
          <button
            type="button"
            class="mini-counter-btn counter-btn"
            :disabled="(count + (missedCycles[cIdx] ?? 0)) >= 4"
            @click="emit('incrementCycle', cIdx)"
          >+</button>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="cycle-empty-hint">
    <span class="material-icons">touch_app</span>
    <span>{{ t('scouting.empty_cycles_hint') }}</span>
  </div>
</template>

<style scoped>
.cycles-history-wrapper {
  margin-top: 4px;
}

.cycles-scroll-container {
  --history-phase-accent: var(--phase-teleop);
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 172px;
  overflow-y: auto;
  padding-right: 4px;
  scroll-behavior: smooth;
  transition: max-height var(--motion-duration-moderate) var(--motion-ease-out);
}

.cycles-scroll-container.auto-cycle-list {
  --history-phase-accent: var(--phase-auto);
}

.cycles-scroll-container.is-expanded {
  max-height: none;
  overflow-y: visible;
}

.cycle-row-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--surface-recessed);
  border: 1px solid var(--border);
  border-radius: 8px;
  gap: 8px;
}

.cycle-row-item.is-active-row {
  border-color: color-mix(in srgb, var(--history-phase-accent) 45%, var(--border));
  background: color-mix(in srgb, var(--history-phase-accent) 9%, var(--surface-recessed));
}

.cycle-row-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cycle-row-badge {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  font-weight: 700;
  color: var(--muted-foreground);
  min-width: 50px;
}

.cycle-row-stat-text {
  font-size: 12px;
  font-weight: 700;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.cycle-row-acc-pill {
  font-family: var(--font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
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

.cycle-row-counter {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mini-counter-btn {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--card);
  color: var(--foreground);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-out), border-color var(--motion-duration-fast) var(--motion-ease-out), color var(--motion-duration-fast) var(--motion-ease-out);
}

.mini-counter-btn:not(:disabled):hover {
  background: var(--surface-hover);
  border-color: var(--primary);
  color: var(--primary);
}

.mini-counter-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.mini-counter-val {
  min-width: 26px;
  text-align: center;
  font-family: var(--font-numeric);
  font-size: 15px;
  font-weight: 800;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
  display: inline-block;
}

.mini-counter-val.bump-up,
.mini-counter-val.bump-up-a {
  animation: val-bump-up-a var(--motion-duration-moderate) var(--motion-ease-spring);
}

.mini-counter-val.bump-up-b {
  animation: val-bump-up-b var(--motion-duration-moderate) var(--motion-ease-spring);
}

.mini-counter-val.bump-down,
.mini-counter-val.bump-down-a {
  animation: val-bump-down-a var(--motion-duration-moderate) var(--motion-ease-spring);
}

.mini-counter-val.bump-down-b {
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

.cycle-empty-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  background: var(--surface-recessed);
  border: 1px dashed var(--border);
  border-radius: 10px;
  color: var(--muted-foreground);
  font-size: 13px;
}

.cycle-empty-hint .material-icons {
  font-size: 18px;
}
</style>
