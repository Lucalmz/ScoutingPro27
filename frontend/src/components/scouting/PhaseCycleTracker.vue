<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBumpAnimation } from '@/composables/useBumpAnimation'
import { hapticLight, hapticMedium, hapticSelection } from '@/utils/haptics'

const props = withDefaults(
  defineProps<{
    phase: 'auto' | 'teleop'
    title: string
    icon: string
    rateText: string
    modelValue: number[]
  }>(),
  {
    modelValue: () => []
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', val: number[]): void
  (e: 'change', val: number[]): void
}>()

const { t } = useI18n()
// 每个组件实例使用独立的动画状态，消除跨阶段耦合
const { bump, getBumpClass, clearBump } = useBumpAnimation()

const isExpanded = ref(false)
const listRef = ref<HTMLElement | null>(null)
const userScrolledUp = ref(false)
const isTappingNewCycle = ref(false)
let tapTimeout: any = null

const cycles = computed({
  get: () => props.modelValue,
  set: (val: number[]) => {
    emit('update:modelValue', val)
    emit('change', val)
  }
})

const totalCycles = computed(() => cycles.value.length)
const totalBalls = computed(() => cycles.value.reduce((sum, b) => sum + b, 0))
const avgBallsPerCycle = computed(() => {
  if (cycles.value.length === 0) return '0.0'
  return (totalBalls.value / cycles.value.length).toFixed(1)
})

const lastCycleIndex = computed(() => cycles.value.length - 1)
const currentCycleBalls = computed(() => {
  if (cycles.value.length === 0) return 0
  return cycles.value[lastCycleIndex.value] ?? 0
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
  // 如果距离底部超过 28px，视作用户在主动上滑查看历史
  userScrolledUp.value = scrollHeight - scrollTop - clientHeight > 28
}

function handleNewCycle() {
  // 点击开新 cycle，默认是 0 个球
  const updated = [...cycles.value, 0]
  cycles.value = updated
  userScrolledUp.value = false
  scrollToBottom(true)

  // 流畅的荧光绿光影变亮回弹动效
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

function incrementCurrentCycle() {
  if (cycles.value.length === 0) {
    // 若暂无 cycle，点击加球直接开启第 1 轮并设为 1
    cycles.value = [1]
    userScrolledUp.value = false
    scrollToBottom(true)
    hapticMedium()
    bump(0, 'cycle', 'up')
    return
  }

  const idx = lastCycleIndex.value
  const cur = cycles.value[idx] ?? 0
  // 当达到 4 球上限后强制锁定防止误触
  if (cur < 4) {
    const next = [...cycles.value]
    next[idx] = cur + 1
    cycles.value = next
    hapticMedium()
    bump(idx, 'cycle', 'up')
    if (!userScrolledUp.value) {
      scrollToBottom(true)
    }
  } else {
    hapticLight()
  }
}

function decrementCurrentCycle() {
  if (cycles.value.length === 0) return
  const idx = lastCycleIndex.value
  const cur = cycles.value[idx] ?? 0
  if (cur > 0) {
    const next = [...cycles.value]
    next[idx] = cur - 1
    cycles.value = next
    hapticLight()
    bump(idx, 'cycle', 'down')
  }
}

function setPresetBalls(val: number) {
  if (cycles.value.length === 0) {
    cycles.value = [val]
    userScrolledUp.value = false
    scrollToBottom(true)
  } else {
    const idx = lastCycleIndex.value
    const next = [...cycles.value]
    next[idx] = val
    cycles.value = next
  }
  hapticSelection()
  bump(lastCycleIndex.value, 'cycle', 'up')
}

function undoLastCycle() {
  if (cycles.value.length > 0) {
    const next = [...cycles.value]
    next.pop()
    cycles.value = next
    hapticLight()
  }
}

function incrementSpecificCycle(cIdx: number) {
  const cur = cycles.value[cIdx]
  if (cur !== undefined && cur < 4) {
    const next = [...cycles.value]
    next[cIdx] = cur + 1
    cycles.value = next
    hapticMedium()
    bump(cIdx, 'cycle', 'up')
  }
}

function decrementSpecificCycle(cIdx: number) {
  const cur = cycles.value[cIdx]
  if (cur !== undefined && cur > 0) {
    const next = [...cycles.value]
    next[cIdx] = cur - 1
    cycles.value = next
    hapticLight()
    bump(cIdx, 'cycle', 'down')
  }
}

function toggleExpand() {
  isExpanded.value = !isExpanded.value
  if (!isExpanded.value) {
    // 收起时重置滚至底部最新一轮
    userScrolledUp.value = false
    scrollToBottom(false)
  }
}

watch(
  () => cycles.value.length,
  (newLen, oldLen) => {
    if (newLen > oldLen) {
      // 外部或重置后新增，保证滚到最新
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

    <!-- KPI 卡片统计 -->
    <div class="cycle-kpis-grid">
      <div class="kpi-card">
        <span class="kpi-num">{{ totalCycles }}</span>
        <span class="kpi-label">{{ t('scouting.total_cycles') }} ({{ t('scouting.unit_cycles') }})</span>
      </div>
      <div class="kpi-card highlight-balls">
        <span class="kpi-num">{{ totalBalls }}</span>
        <span class="kpi-label">{{ t('scouting.total_balls') }} ({{ t('scouting.unit_balls') }})</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-num">{{ avgBallsPerCycle }}</span>
        <span class="kpi-label">{{ t('scouting.avg_balls_per_cycle') }}</span>
      </div>
    </div>

    <!-- 当前轮次录入与快捷操作栏 -->
    <div class="active-cycle-card">
      <div class="active-cycle-top">
        <!-- 开启新轮次按钮 (短促微起伏反馈，去除长发光) -->
        <button
          type="button"
          class="btn-new-cycle btn-action-new-cycle"
          :class="{ 'btn-tapping': isTappingNewCycle }"
          @click="handleNewCycle"
        >
          <span class="material-icons">add_circle</span>
          <span>{{ t('scouting.btn_new_cycle') }}</span>
        </button>

        <!-- 当前轮次球数步进加减框 -->
        <div class="active-counter-group">
          <span class="active-counter-label" v-if="cycles.length > 0">
            {{ t('scouting.cycle_num', { num: cycles.length }) }}:
          </span>
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
              :disabled="currentCycleBalls >= 4"
              @click="incrementCurrentCycle"
              :title="currentCycleBalls >= 4 ? t('scouting.cap_reached_hint') : ''"
            >+</button>
          </div>
          <span class="balls-unit-tag">{{ t('scouting.balls_unit', { count: currentCycleBalls }) }}</span>
        </div>

        <!-- 撤销按钮 -->
        <button
          type="button"
          class="btn-undo-cycle btn-action-undo"
          :disabled="cycles.length === 0"
          @click="undoLastCycle"
          :title="t('scouting.btn_undo_cycle')"
        >
          <span class="material-icons">undo</span>
          <span>{{ t('scouting.btn_undo_cycle') }}</span>
        </button>
      </div>

      <!-- 直接点选球数芯片 (44px 触控标准) -->
      <div class="quick-chips-row quick-ball-chips">
        <span class="quick-chips-title quick-chips-label">{{ t('scouting.btn_add_ball') }}:</span>
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
        <span v-if="currentCycleBalls >= 4" class="cap-badge">
          {{ t('scouting.cap_reached_hint') }}
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
          <span class="cycle-row-badge cycle-badge-index">{{ t('scouting.cycle_num', { num: cIdx + 1 }) }}</span>
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
              :disabled="count >= 4"
              @click="incrementSpecificCycle(cIdx)"
            >+</button>
          </div>
          <span class="cycle-row-unit">{{ t('scouting.balls_unit', { count }) }}</span>
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

/* KPI 卡片 */
.cycle-kpis-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
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
  font-size: 20px;
  font-weight: 800;
  color: var(--foreground, #f8fafc);
  font-variant-numeric: tabular-nums;
}

.highlight-balls .kpi-num {
  color: var(--primary, #38bdf8);
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
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.active-cycle-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

/* 新建轮次按钮 (荧光绿加微光影，点击流畅变亮回弹) */
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

.btn-new-cycle:hover {
  filter: brightness(1.08);
  box-shadow: 0 0 18px rgba(57, 255, 20, 0.55), inset 0 1px 1px rgba(255, 255, 255, 0.45);
  transform: translateY(-1px);
}

.btn-new-cycle:active {
  transform: scale(0.95);
}

.btn-new-cycle.btn-tapping {
  animation: cycle-btn-bloom 0.45s cubic-bezier(0.2, 0.9, 0.3, 1) forwards;
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

/* 当前轮次球数步进加减按钮及数值 */
.counter-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  white-space: nowrap;
}

.counter-btn {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  border: 1px solid var(--input, rgba(255, 255, 255, 0.15));
  background: var(--border, rgba(255, 255, 255, 0.08));
  color: var(--foreground, #f8fafc);
  font-size: 20px;
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
  font-size: 20px;
  font-weight: 700;
  min-width: 36px;
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

.balls-unit-tag {
  font-size: 12px;
  color: var(--muted-foreground, #94a3b8);
}

.btn-undo-cycle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  background: rgba(255, 255, 255, 0.04);
  color: var(--muted-foreground, #94a3b8);
  font-size: 13px;
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

/* 直选芯片 (44px 触控目标) */
.quick-chips-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-top: 4px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
}

.quick-chips-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--muted-foreground, #94a3b8);
}

.chips-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chip-ball-btn {
  min-width: 44px;
  height: 44px;
  border-radius: 8px;
  border: 1.5px solid var(--border, rgba(255, 255, 255, 0.15));
  background: var(--card, #131826);
  color: var(--foreground, #f8fafc);
  font-size: 16px;
  font-weight: 800;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.chip-ball-btn:hover {
  border-color: var(--primary, #38bdf8);
  transform: translateY(-1px);
}

.chip-ball-btn:active {
  transform: scale(0.94);
}

.chip-ball-btn.is-selected {
  background: var(--primary, #38bdf8);
  color: #000;
  border-color: var(--primary, #38bdf8);
  box-shadow: 0 0 10px rgba(56, 189, 248, 0.4);
}

.cap-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

/* 轮次列表与滚动视口 */
.cycles-history-wrapper {
  margin-top: 4px;
}

.cycles-scroll-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 172px; /* 约 3 轮高度 */
  overflow-y: auto;
  padding-right: 4px;
  scroll-behavior: smooth;
  transition: max-height 0.25s ease;
}

.cycles-scroll-container.is-expanded {
  max-height: none;
  overflow-y: visible;
}

.cycles-scroll-container::-webkit-scrollbar {
  width: 5px;
}

.cycles-scroll-container::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 4px;
}

.cycle-row-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  border-radius: 8px;
  transition: background 0.15s ease;
}

.cycle-row-item.is-active-row {
  border-color: rgba(56, 189, 248, 0.4);
  background: rgba(56, 189, 248, 0.04);
}

.cycle-row-badge {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted-foreground, #94a3b8);
  min-width: 54px;
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
  border-color: var(--primary, #38bdf8);
}

.mini-counter-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.mini-counter-val {
  min-width: 28px;
  text-align: center;
  font-size: 16px;
  font-weight: 800;
  color: var(--foreground, #f8fafc);
  font-variant-numeric: tabular-nums;
  display: inline-block;
}

.cycle-row-unit {
  font-size: 12px;
  color: var(--muted-foreground, #94a3b8);
  min-width: 40px;
  text-align: right;
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

@media (max-width: 480px) {
  .active-cycle-top {
    flex-direction: column;
    align-items: stretch;
  }
  .btn-new-cycle,
  .btn-undo-cycle {
    width: 100%;
    justify-content: center;
  }
  .active-counter-group {
    justify-content: center;
  }
  .quick-chips-row {
    justify-content: center;
  }
}
</style>
