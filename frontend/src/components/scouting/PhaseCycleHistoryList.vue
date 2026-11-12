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
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 172px;
  overflow-y: auto;
  padding-right: 4px;
  scroll-behavior: smooth;
  transition: max-height 0.25s ease;
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
  background: #080807;
  border: 1px solid #262624;
  border-radius: 8px;
  gap: 8px;
}

.cycle-row-item.is-active-row {
  border-color: rgba(57, 255, 20, 0.45);
  background: #11160f;
}

.cycle-row-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cycle-row-badge {
  font-family: 'Orbitron', monospace;
  font-size: 11px;
  font-weight: 700;
  color: var(--muted-foreground, #8e8d87);
  min-width: 50px;
}

.cycle-row-stat-text {
  font-size: 12px;
  font-weight: 700;
  color: var(--foreground, #f0efe9);
}

.cycle-row-acc-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
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

.cycle-row-counter {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mini-counter-btn {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid #353532;
  background: #141413;
  color: var(--foreground, #f0efe9);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s ease;
}

.mini-counter-btn:not(:disabled):hover {
  background: #1c1c1a;
  border-color: var(--primary, #39ff14);
  color: var(--primary, #39ff14);
}

.mini-counter-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.mini-counter-val {
  min-width: 26px;
  text-align: center;
  font-size: 15px;
  font-weight: 800;
  color: var(--foreground, #f0efe9);
  font-variant-numeric: tabular-nums;
  display: inline-block;
}

.mini-counter-val.bump-up,
.mini-counter-val.bump-up-a {
  animation: val-bump-up-a 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.mini-counter-val.bump-up-b {
  animation: val-bump-up-b 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.mini-counter-val.bump-down,
.mini-counter-val.bump-down-a {
  animation: val-bump-down-a 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.mini-counter-val.bump-down-b {
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

.cycle-empty-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  background: #080807;
  border: 1px dashed #262624;
  border-radius: 10px;
  color: var(--muted-foreground, #8e8d87);
  font-size: 13px;
}

.cycle-empty-hint .material-icons {
  font-size: 18px;
}
</style>
