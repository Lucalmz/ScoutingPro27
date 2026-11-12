import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useBumpAnimation } from '@/composables/useBumpAnimation'
import { hapticLight, hapticMedium, hapticSelection, hapticWarning } from '@/utils/haptics'

export interface UsePhaseCycleTrackerOptions {
  getModelValue: () => number[]
  getMissedValue: () => number[]
  emitModelValue: (val: number[]) => void
  emitMissedValue: (val: number[]) => void
  emitChange: (scored: number[], missed: number[]) => void
}

export function getAccuracyPillClass(scored: number, attempts: number): string {
  if (attempts === 0) return 'acc-none'
  const pct = (scored / attempts) * 100
  if (pct >= 75) return 'acc-high'
  if (pct >= 45) return 'acc-med'
  return 'acc-low'
}

export function getCycleAccuracyText(scored: number, missed: number): string {
  const att = scored + missed
  if (att === 0) return '--'
  return `${((scored / att) * 100).toFixed(0)}%`
}

export function usePhaseCycleTracker(options: UsePhaseCycleTrackerOptions) {
  const {
    getModelValue,
    getMissedValue,
    emitModelValue,
    emitMissedValue,
    emitChange
  } = options

  const { bump, getBumpClass, clearBump } = useBumpAnimation()

  const isExpanded = ref(false)
  const listRef = ref<HTMLElement | null>(null)
  const userScrolledUp = ref(false)
  const isTappingNewCycle = ref(false)
  let tapTimeout: any = null

  // 操作历史栈，用于单球精准撤销 ('hit' | 'miss')
  const currentCycleHistory = ref<('hit' | 'miss')[]>([])

  const cycles = computed({
    get: () => getModelValue(),
    set: (val: number[]) => {
      emitModelValue(val)
      emitChange(val, missedCycles.value)
    }
  })

  const missedCycles = computed({
    get: () => {
      const m = [...getMissedValue()]
      while (m.length < cycles.value.length) {
        m.push(0)
      }
      return m
    },
    set: (val: number[]) => {
      emitMissedValue(val)
      emitChange(cycles.value, val)
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
    emitModelValue(nextCycles)
    emitMissedValue(nextMissed)
    emitChange(nextCycles, nextMissed)

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
      emitModelValue(nextCycles)
      emitMissedValue(nextMissed)
      emitChange(nextCycles, nextMissed)
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
      emitModelValue(nextCycles)
      emitChange(nextCycles, missedCycles.value)
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
      emitModelValue(nextCycles)
      emitMissedValue(nextMissed)
      emitChange(nextCycles, nextMissed)
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
      emitMissedValue(nextMissed)
      emitChange(cycles.value, nextMissed)
      currentCycleHistory.value.push('miss')
      hapticWarning()
      if (!userScrolledUp.value) scrollToBottom(true)
    } else {
      hapticLight()
    }
  }

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
      emitModelValue(next)
      emitChange(next, missedCycles.value)
      hapticLight()
      bump(idx, 'cycle', 'down')
    }
  }

  function setPresetBalls(val: number) {
    if (cycles.value.length === 0) {
      const nextCycles = [val]
      const nextMissed = [0]
      emitModelValue(nextCycles)
      emitMissedValue(nextMissed)
      emitChange(nextCycles, nextMissed)
      userScrolledUp.value = false
      scrollToBottom(true)
    } else {
      const idx = lastCycleIndex.value
      const nextCycles = [...cycles.value]
      nextCycles[idx] = val
      emitModelValue(nextCycles)
      emitChange(nextCycles, missedCycles.value)
    }
    hapticSelection()
    bump(lastCycleIndex.value, 'cycle', 'up')
  }

  function undoLastCycle() {
    if (cycles.value.length > 0) {
      const nextCycles = [...cycles.value]
      nextCycles.pop()
      const nextMissed = [...missedCycles.value]
      nextMissed.pop()
      emitModelValue(nextCycles)
      emitMissedValue(nextMissed)
      emitChange(nextCycles, nextMissed)
      currentCycleHistory.value = []
      hapticLight()
    }
  }

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
        emitModelValue(nextCycles)
        emitChange(nextCycles, missedCycles.value)
        bump(idx, 'cycle', 'down')
        hapticLight()
        return
      } else if (lastAction === 'miss' && curMisses > 0) {
        const nextMissed = [...missedCycles.value]
        nextMissed[idx] = curMisses - 1
        emitMissedValue(nextMissed)
        emitChange(cycles.value, nextMissed)
        hapticLight()
        return
      }
    }

    if (curHits > 0) {
      const nextCycles = [...cycles.value]
      nextCycles[idx] = curHits - 1
      emitModelValue(nextCycles)
      emitChange(nextCycles, missedCycles.value)
      bump(idx, 'cycle', 'down')
      hapticLight()
      return
    } else if (curMisses > 0) {
      const nextMissed = [...missedCycles.value]
      nextMissed[idx] = curMisses - 1
      emitMissedValue(nextMissed)
      emitChange(cycles.value, nextMissed)
      hapticLight()
      return
    }

    undoLastCycle()
  }

  function incrementSpecificCycle(cIdx: number) {
    const curHits = cycles.value[cIdx] ?? 0
    const curMisses = missedCycles.value[cIdx] ?? 0
    if (curHits + curMisses < 4) {
      const nextCycles = [...cycles.value]
      nextCycles[cIdx] = curHits + 1
      emitModelValue(nextCycles)
      emitChange(nextCycles, missedCycles.value)
      hapticMedium()
      bump(cIdx, 'cycle', 'up')
    }
  }

  function decrementSpecificCycle(cIdx: number) {
    const curHits = cycles.value[cIdx] ?? 0
    if (curHits > 0) {
      const nextCycles = [...cycles.value]
      nextCycles[cIdx] = curHits - 1
      emitModelValue(nextCycles)
      emitChange(nextCycles, missedCycles.value)
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
      emitMissedValue(nextMissed)
      emitChange(cycles.value, nextMissed)
      hapticWarning()
    }
  }

  function decrementSpecificMiss(cIdx: number) {
    const curMisses = missedCycles.value[cIdx] ?? 0
    if (curMisses > 0) {
      const nextMissed = [...missedCycles.value]
      nextMissed[cIdx] = curMisses - 1
      emitMissedValue(nextMissed)
      emitChange(cycles.value, nextMissed)
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

  return {
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
  }
}
