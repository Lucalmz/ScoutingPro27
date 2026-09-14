<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBumpAnimation } from '@/composables/useBumpAnimation'
import { hapticLight, hapticMedium, hapticSelection, hapticWarning } from '@/utils/haptics'

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
const { bump, getBumpClass, clearBump } = useBumpAnimation()

const isExpanded = ref(false)
const listRef = ref<HTMLElement | null>(null)
const userScrolledUp = ref(false)
const isTappingNewCycle = ref(false)
let tapTimeout: any = null

// 操作历史栈，用于单球精准撤销 ('hit' | 'miss')
const currentCycleHistory = ref<('hit' | 'miss')[]>([])

const cycles = computed({
  get: () => props.modelValue,
  set: (val: number[]) => {
    emit('update:modelValue', val)
    emit('change', val, missedCycles.value)
  }
})

const missedCycles = computed({
  get: () => {
    const m = [...props.missedValue]
    while (m.length < cycles.value.length) {
      m.push(0)
    }
    return m
  },
  set: (val: number[]) => {
    emit('update:missedValue', val)
    emit('change', cycles.value, val)
  }
})

// 统计量计算
const totalCycles = computed(() => cycles.value.length)
const totalBalls = computed(() => cycles.value.reduce((sum, b) => sum + (Number(b) || 0), 0))
const totalMissed = computed(() => missedCycles.value.reduce((sum, b) => sum + (Number(b) || 0), 0))
const totalAttempts = computed(() => totalBalls.value + totalMissed.value)

const overallAccuracy = computed(() => {
  if (totalAttempts.value === 0) return '--'
  return `${((totalBalls.value / totalAttempts.value) * 100).toFixed(0)}%`
})

const avgBallsPerCycle = computed(() => {
  if (cycles.value.length === 0) return '0.0'
  return (totalBalls.value / cycles.value.length).toFixed(1)
})

const accuracyClass = computed(() => {
  if (totalAttempts.value === 0) return ''
  const pct = (totalBalls.value / totalAttempts.value) * 100
  if (pct >= 75) return 'accuracy-high'
  if (pct >= 45) return 'accuracy-medium'
  return 'accuracy-low'
})

// 当前轮次状态
const lastCycleIndex = computed(() => cycles.value.length - 1)

const currentCycleBalls = computed(() => {
  if (cycles.value.length === 0) return 0
  return cycles.value[lastCycleIndex.value] ?? 0
})

const currentCycleMissed = computed(() => {
  if (cycles.value.length === 0) return 0
  return missedCycles.value[lastCycleIndex.value] ?? 0
})

const currentCycleAttempts = computed(() => currentCycleBalls.value + currentCycleMissed.value)

const currentCycleAccuracy = computed(() => {
  if (currentCycleAttempts.value === 0) return '--'
  return `${((currentCycleBalls.value / currentCycleAttempts.value) * 100).toFixed(0)}%`
})

// 0 球严格拦截：若已有轮次且当前轮次尚未出球，禁止开新轮
const canStartNewCycle = computed(() => {
  if (cycles.value.length === 0) return true
  return currentCycleAttempts.value > 0
})

function scrollToBottom(smooth = true) {
  nextTick(() => {
    if (listRef.value) {
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
  userScrolledUp.value = scrollHeight - scrollTop - clientHeight > 28
}

// 开启新轮次
function handleNewCycle() {
  if (!canStartNewCycle.value) {
    hapticWarning()
    return
  }

  const nextCycles = [...cycles.value, 0]
  const nextMissed = [...missedCycles.value, 0]
  emit('update:modelValue', nextCycles)
  emit('update:missedValue', nextMissed)
  emit('change', nextCycles, nextMissed)

  currentCycleHistory.value = []
  userScrolledUp.value = false
  scrollToBottom(true)

  isTappingNewCycle.value = false
  nextTick(() => {
    isTappingNewCycle.value = true
    if (tapTimeout) clearTimeout(tapTimeout)
    tapTimeout = setTimeout(() => {
      isTappingNewCycle.value = false
    }, 450)
  })

  hapticMedium()
}

// 🎯 盲操：进球 / HIT (+1)
function recordHit() {
  if (cycles.value.length === 0) {
    const nextCycles = [1]
    const nextMissed = [0]
    emit('update:modelValue', nextCycles)
    emit('update:missedValue', nextMissed)
    emit('change', nextCycles, nextMissed)
    currentCycleHistory.value = ['hit']
    userScrolledUp.value = false
    scrollToBottom(true)
    hapticMedium()
    bump(0, 'cycle', 'up')
    return
  }

  const idx = lastCycleIndex.value
  const curHits = cycles.value[idx] ?? 0
  const curMisses = missedCycles.value[idx] ?? 0

  if (curHits + curMisses < 4) {
    const nextCycles = [...cycles.value]
    nextCycles[idx] = curHits + 1
    emit('update:modelValue', nextCycles)
    emit('change', nextCycles, missedCycles.value)
    currentCycleHistory.value.push('hit')
    hapticMedium()
    bump(idx, 'cycle', 'up')
    if (!userScrolledUp.value) scrollToBottom(true)
  } else {
    hapticLight()
  }
}

// ❌ 盲操：未进 / MISS (+1)
function recordMiss() {
  if (cycles.value.length === 0) {
    const nextCycles = [0]
    const nextMissed = [1]
    emit('update:modelValue', nextCycles)
    emit('update:missedValue', nextMissed)
    emit('change', nextCycles, nextMissed)
    currentCycleHistory.value = ['miss']
    userScrolledUp.value = false
    scrollToBottom(true)
    hapticWarning()
    return
  }

  const idx = lastCycleIndex.value
  const curHits = cycles.value[idx] ?? 0
  const curMisses = missedCycles.value[idx] ?? 0

  if (curHits + curMisses < 4) {
    const nextMissed = [...missedCycles.value]
    nextMissed[idx] = curMisses + 1
    emit('update:missedValue', nextMissed)
    emit('change', cycles.value, nextMissed)
    currentCycleHistory.value.push('miss')
    hapticWarning()
    if (!userScrolledUp.value) scrollToBottom(true)
  } else {
    hapticLight()
  }
}

// 步进兼容方法
function incrementCurrentCycle() {
  recordHit()
}

function decrementCurrentCycle() {
  if (cycles.value.length === 0) return
  const idx = lastCycleIndex.value
  const cur = cycles.value[idx] ?? 0
  if (cur > 0) {
    const next = [...cycles.value]
    next[idx] = cur - 1
    emit('update:modelValue', next)
    emit('change', next, missedCycles.value)
    hapticLight()
    bump(idx, 'cycle', 'down')
  }
}

function setPresetBalls(val: number) {
  if (cycles.value.length === 0) {
    const nextCycles = [val]
    const nextMissed = [0]
    emit('update:modelValue', nextCycles)
    emit('update:missedValue', nextMissed)
    emit('change', nextCycles, nextMissed)
    userScrolledUp.value = false
    scrollToBottom(true)
  } else {
    const idx = lastCycleIndex.value
    const nextCycles = [...cycles.value]
    nextCycles[idx] = val
    emit('update:modelValue', nextCycles)
    emit('change', nextCycles, missedCycles.value)
  }
  hapticSelection()
  bump(lastCycleIndex.value, 'cycle', 'up')
}

// 撤销最近一次动作（优先撤单球，空轮次则撤整轮）
function undoLastAction() {
  if (cycles.value.length === 0) return

  const idx = lastCycleIndex.value
  const curHits = cycles.value[idx] ?? 0
  const curMisses = missedCycles.value[idx] ?? 0

  if (currentCycleHistory.value.length > 0) {
    const lastAction = currentCycleHistory.value.pop()
    if (lastAction === 'hit' && curHits > 0) {
      const nextCycles = [...cycles.value]
      nextCycles[idx] = curHits - 1
      emit('update:modelValue', nextCycles)
      emit('change', nextCycles, missedCycles.value)
      bump(idx, 'cycle', 'down')
      hapticLight()
      return
    } else if (lastAction === 'miss' && curMisses > 0) {
      const nextMissed = [...missedCycles.value]
      nextMissed[idx] = curMisses - 1
      emit('update:missedValue', nextMissed)
      emit('change', cycles.value, nextMissed)
      hapticLight()
      return
    }
  }

  if (curHits > 0) {
    const nextCycles = [...cycles.value]
    nextCycles[idx] = curHits - 1
    emit('update:modelValue', nextCycles)
    emit('change', nextCycles, missedCycles.value)
    bump(idx, 'cycle', 'down')
    hapticLight()
    return
  } else if (curMisses > 0) {
    const nextMissed = [...missedCycles.value]
    nextMissed[idx] = curMisses - 1
    emit('update:missedValue', nextMissed)
    emit('change', cycles.value, nextMissed)
    hapticLight()
    return
  }

  undoLastCycle()
}

function undoLastCycle() {
  if (cycles.value.length > 0) {
    const nextCycles = [...cycles.value]
    nextCycles.pop()
    const nextMissed = [...missedCycles.value]
    nextMissed.pop()
    emit('update:modelValue', nextCycles)
    emit('update:missedValue', nextMissed)
    emit('change', nextCycles, nextMissed)
    currentCycleHistory.value = []
    hapticLight()
  }
}

// 历史瀑布调整
function incrementSpecificCycle(cIdx: number) {
  const curHits = cycles.value[cIdx] ?? 0
  const curMisses = missedCycles.value[cIdx] ?? 0
  if (curHits + curMisses < 4) {
    const nextCycles = [...cycles.value]
    nextCycles[cIdx] = curHits + 1
    emit('update:modelValue', nextCycles)
    emit('change', nextCycles, missedCycles.value)
    hapticMedium()
    bump(cIdx, 'cycle', 'up')
  }
}

function decrementSpecificCycle(cIdx: number) {
  const curHits = cycles.value[cIdx] ?? 0
  if (curHits > 0) {
    const nextCycles = [...cycles.value]
    nextCycles[cIdx] = curHits - 1
    emit('update:modelValue', nextCycles)
    emit('change', nextCycles, missedCycles.value)
    hapticLight()
    bump(cIdx, 'cycle', 'down')
  }
}

function incrementSpecificMiss(cIdx: number) {
  const curHits = cycles.value[cIdx] ?? 0
  const curMisses = missedCycles.value[cIdx] ?? 0
  if (curHits + curMisses < 4) {
    const nextMissed = [...missedCycles.value]
    nextMissed[cIdx] = curMisses + 1
    emit('update:missedValue', nextMissed)
    emit('change', cycles.value, nextMissed)
    hapticWarning()
  }
}

function decrementSpecificMiss(cIdx: number) {
  const curMisses = missedCycles.value[cIdx] ?? 0
  if (curMisses > 0) {
    const nextMissed = [...missedCycles.value]
    nextMissed[cIdx] = curMisses - 1
    emit('update:missedValue', nextMissed)
    emit('change', cycles.value, nextMissed)
    hapticLight()
  }
}

function toggleExpand() {
  isExpanded.value = !isExpanded.value
  if (!isExpanded.value) {
    userScrolledUp.value = false
    scrollToBottom(false)
  }
}

function getAccuracyPillClass(scored: number, attempts: number) {
  if (attempts === 0) return 'acc-none'
  const pct = (scored / attempts) * 100
  if (pct >= 75) return 'acc-high'
  if (pct >= 45) return 'acc-med'
  return 'acc-low'
}

function getCycleAccuracyText(scored: number, missed: number) {
  const att = scored + missed
  if (att === 0) return '--'
  return `${((scored / att) * 100).toFixed(0)}%`
}

watch(
  () => cycles.value.length,
  (newLen, oldLen) => {
    if (newLen > oldLen) {
      userScrolledUp.value = false
      scrollToBottom(true)
    }
  }
)

onMounted(() => {
  scrollToBottom(false)
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

    <!-- 当前轮次录入与盲操控制台 -->
    <div class="active-cycle-card">
      <!-- 轮次状态栏与撤销操作 -->
      <div class="active-cycle-header-row">
        <div class="active-cycle-title-wrap">
          <span class="active-cycle-badge" v-if="cycles.length > 0">
            {{ t('scouting.cycle_num', { num: cycles.length }) }}
          </span>
          <span class="active-cycle-badge" v-else>
            {{ t('scouting.cycle_num', { num: 1 }) }}
          </span>
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
      </div>

      <!-- 🎮 双巨靶区盲操控件 (左右两指直按，触觉差异化反馈) -->
      <div class="blind-touchpad-container">
        <!-- ❌ 未进键 (MISS) - 红系双震 -->
        <button
          type="button"
          class="pad-action-btn pad-miss-btn"
          :disabled="currentCycleAttempts >= 4"
          @click="recordMiss"
        >
          <div class="pad-icon-row">
            <span class="material-icons pad-icon">close</span>
            <span class="pad-title">{{ t('scouting.miss_ball') }}</span>
          </div>
          <div class="pad-stat-row">
            <span class="pad-step-badge">+1</span>
            <span class="pad-current-count">{{ currentCycleMissed }} 丢</span>
          </div>
        </button>

        <!-- 🎯 进球键 (HIT) - 荧光绿清脆单震 -->
        <button
          type="button"
          class="pad-action-btn pad-hit-btn"
          :disabled="currentCycleAttempts >= 4"
          @click="recordHit"
        >
          <div class="pad-icon-row">
            <span class="material-icons pad-icon">stars</span>
            <span class="pad-title">{{ t('scouting.hit_ball') }}</span>
          </div>
          <div class="pad-stat-row">
            <span class="pad-step-badge">+1</span>
            <span class="pad-current-count">{{ currentCycleBalls }} 进</span>
          </div>
        </button>
      </div>

      <!-- 满 4 球警示标签 -->
      <div v-if="currentCycleAttempts >= 4" class="cap-alert-row">
        <span class="cap-badge">
          <span class="material-icons icon-alert">lock</span>
          {{ t('scouting.cap_reached_hint') }}
        </span>
      </div>

      <!-- 步进器微调与直选芯片 (保留精细调整能力) -->
      <div class="fine-tuning-row">
        <div class="active-counter-group">
          <span class="active-counter-label">{{ t('scouting.hit_ball') }}:</span>
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

      <!-- 开启新轮次按钮 (0球时严格禁用，4球满额时高亮引导) -->
      <div class="new-cycle-bar">
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
          <span class="material-icons">add_circle</span>
          <span>{{ t('scouting.btn_new_cycle') }}</span>
        </button>
        <span v-if="!canStartNewCycle && cycles.length > 0" class="empty-block-hint">
          {{ t('scouting.cannot_start_empty_cycle') }}
        </span>
      </div>
    </div>

    <!-- 轮次瀑布历史 (折叠/展开与视口滚动) -->
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
              {{ count }} 进 / {{ missedCycles[cIdx] ?? 0 }} 丢
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
              @click="decrementSpecificCycle(cIdx)"
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
              @click="incrementSpecificCycle(cIdx)"
            >+</button>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="cycle-empty-hint">
      <span class="material-icons">touch_app</span>
      <span>{{ t('scouting.empty_cycles_hint') }}</span>
    </div>
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
  background: var(--background, #0b0f19);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  text-align: center;
}

.kpi-num {
  font-size: 18px;
  font-weight: 800;
  color: var(--foreground, #f8fafc);
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
  color: var(--muted-foreground, #94a3b8);
  margin-top: 2px;
}

/* 当前操作卡片 */
.active-cycle-card {
  background: var(--background, #0b0f19);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
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
  gap: 8px;
}

.active-cycle-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.active-cycle-badge {
  font-size: 13px;
  font-weight: 800;
  color: var(--foreground, #f8fafc);
  background: rgba(255, 255, 255, 0.08);
  padding: 3px 8px;
  border-radius: 6px;
}

.active-cycle-attempts-hint {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground, #94a3b8);
}

.cycle-acc-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 6px;
}

.acc-high {
  background: rgba(57, 255, 20, 0.15);
  color: #39ff14;
  border: 1px solid rgba(57, 255, 20, 0.3);
}

.acc-med {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.acc-low {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.acc-none {
  background: rgba(255, 255, 255, 0.05);
  color: var(--muted-foreground, #94a3b8);
}

/* 🎮 双巨靶区盲操控件 */
.blind-touchpad-container {
  display: grid;
  grid-template-columns: 1fr 1.3fr;
  gap: 12px;
  width: 100%;
}

.pad-action-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 14px 10px;
  min-height: 74px;
  border-radius: 12px;
  cursor: pointer;
  user-select: none;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.pad-action-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.pad-action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  transform: none;
  filter: grayscale(0.4);
}

/* ❌ 未进键 (MISS) */
.pad-miss-btn {
  background: rgba(239, 68, 68, 0.12);
  border: 1.5px solid rgba(239, 68, 68, 0.4);
  color: #ef4444;
}

.pad-miss-btn:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.22);
  border-color: #ef4444;
  box-shadow: 0 0 14px rgba(239, 68, 68, 0.35);
}

.pad-miss-btn:active:not(:disabled) {
  background: rgba(239, 68, 68, 0.35);
}

/* 🎯 进球键 (HIT) */
.pad-hit-btn {
  background: linear-gradient(180deg, rgba(57, 255, 20, 0.2) 0%, rgba(57, 255, 20, 0.1) 100%);
  border: 1.5px solid rgba(57, 255, 20, 0.55);
  color: #39ff14;
  box-shadow: 0 0 12px rgba(57, 255, 20, 0.2);
}

.pad-hit-btn:hover:not(:disabled) {
  background: linear-gradient(180deg, rgba(57, 255, 20, 0.35) 0%, rgba(57, 255, 20, 0.2) 100%);
  border-color: #39ff14;
  box-shadow: 0 0 18px rgba(57, 255, 20, 0.45);
}

.pad-hit-btn:active:not(:disabled) {
  background: rgba(57, 255, 20, 0.45);
}

.pad-icon-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pad-icon {
  font-size: 22px;
}

.pad-title {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.5px;
}

.pad-stat-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.pad-step-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
}

.pad-current-count {
  font-size: 13px;
  font-weight: 700;
  opacity: 0.9;
}

.cap-alert-row {
  display: flex;
  justify-content: center;
}

.cap-badge {
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.icon-alert {
  font-size: 14px;
}

/* 微调行 */
.fine-tuning-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
}

.active-counter-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.active-counter-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--foreground, #f8fafc);
}

.counter-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  white-space: nowrap;
}

.counter-btn {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  border: 1px solid var(--input, rgba(255, 255, 255, 0.15));
  background: var(--border, rgba(255, 255, 255, 0.08));
  color: var(--foreground, #f8fafc);
  font-size: 18px;
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
  background: var(--input, rgba(255, 255, 255, 0.15));
  border-color: var(--primary, #39ff14);
}

.counter-btn:active:not(:disabled) {
  transform: scale(0.92);
}

.counter-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.counter-val {
  font-size: 18px;
  font-weight: 700;
  min-width: 32px;
  text-align: center;
  user-select: none;
  font-variant-numeric: tabular-nums;
  display: inline-block;
  color: var(--foreground, #f8fafc);
  transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), color 0.15s ease;
}

.counter-val.bump-up,
.counter-val.bump-up-a,
.mini-counter-val.bump-up,
.mini-counter-val.bump-up-a {
  animation: val-bump-up-a 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.counter-val.bump-up-b,
.mini-counter-val.bump-up-b {
  animation: val-bump-up-b 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.counter-val.bump-down,
.counter-val.bump-down-a,
.mini-counter-val.bump-down,
.mini-counter-val.bump-down-a {
  animation: val-bump-down-a 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.counter-val.bump-down-b,
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

.chips-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.chip-ball-btn {
  min-width: 38px;
  height: 38px;
  border-radius: 8px;
  border: 1.5px solid var(--border, rgba(255, 255, 255, 0.15));
  background: var(--card, #131826);
  color: var(--foreground, #f8fafc);
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  user-select: none;
}

.chip-ball-btn:hover {
  border-color: var(--primary, #39ff14);
}

.chip-ball-btn.is-selected {
  background: var(--primary, #39ff14);
  color: #000;
  border-color: var(--primary, #39ff14);
  box-shadow: 0 0 10px rgba(57, 255, 20, 0.4);
}

/* 开启新轮次条 */
.new-cycle-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.btn-new-cycle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: linear-gradient(180deg, #4efd2d 0%, #39ff14 100%);
  color: #000000;
  font-weight: 800;
  font-size: 14px;
  min-height: 44px;
  padding: 8px 18px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  cursor: pointer;
  user-select: none;
  box-shadow: 0 0 14px rgba(57, 255, 20, 0.4), inset 0 1px 1px rgba(255, 255, 255, 0.35);
  transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.18s ease, filter 0.18s ease;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.btn-new-cycle:hover:not(:disabled) {
  filter: brightness(1.08);
  box-shadow: 0 0 18px rgba(57, 255, 20, 0.55), inset 0 1px 1px rgba(255, 255, 255, 0.45);
  transform: translateY(-1px);
}

.btn-new-cycle:active:not(:disabled) {
  transform: scale(0.95);
}

.btn-new-cycle:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  filter: grayscale(0.7);
  box-shadow: none;
  transform: none;
}

.btn-new-cycle.btn-tapping {
  animation: cycle-btn-bloom 0.45s cubic-bezier(0.2, 0.9, 0.3, 1) forwards;
}

.btn-new-cycle.is-suggested {
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
  gap: 4px;
  min-height: 36px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  background: rgba(255, 255, 255, 0.04);
  color: var(--muted-foreground, #94a3b8);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-undo-cycle:not(:disabled):hover {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.3);
}

.btn-undo-cycle:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* 轮次历史列表 */
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
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  border-radius: 8px;
  gap: 8px;
}

.cycle-row-item.is-active-row {
  border-color: rgba(57, 255, 20, 0.35);
  background: rgba(57, 255, 20, 0.04);
}

.cycle-row-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cycle-row-badge {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted-foreground, #94a3b8);
  min-width: 50px;
}

.cycle-row-stat-text {
  font-size: 12px;
  font-weight: 700;
  color: var(--foreground, #f8fafc);
}

.cycle-row-acc-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
}

.cycle-row-counter {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mini-counter-btn {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
  background: rgba(255, 255, 255, 0.06);
  color: var(--foreground, #f8fafc);
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s ease;
}

.mini-counter-btn:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: var(--primary, #39ff14);
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
  color: var(--foreground, #f8fafc);
  font-variant-numeric: tabular-nums;
  display: inline-block;
}

.cycle-empty-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px;
  border: 1px dashed var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  color: var(--muted-foreground, #94a3b8);
  font-size: 13px;
}

.cycle-empty-hint .material-icons {
  font-size: 18px;
}
</style>
