import { ref } from 'vue'
import { hapticLight, hapticMedium, hapticSelection } from '@/utils/haptics'
import { useBumpAnimation } from '@/composables/useBumpAnimation'
import type { TeamScoutData } from './useScoutingDraft'

export interface CycleTapState {
  teamIndex: number
  phase: 'auto' | 'teleop'
  timestamp: number
  timer?: any
}

export function useScoutingFormCycles() {
  const { bump, getBumpClass, clearBump } = useBumpAnimation()
  const activeCycleTap = ref<CycleTapState | null>(null)
  const TAP_WINDOW_MS = 2000

  function syncAutoBalls(team: TeamScoutData) {
    team.autoBalls = team.autoCycles.reduce((sum, b) => sum + b, 0)
  }

  function isCycleTapping(teamIndex: number, phase: 'auto' | 'teleop'): boolean {
    return (
      !!activeCycleTap.value &&
      activeCycleTap.value.teamIndex === teamIndex &&
      activeCycleTap.value.phase === phase
    )
  }

  function getLastCycleBalls(team: TeamScoutData, phase: 'auto' | 'teleop'): number {
    const cycles = phase === 'auto' ? team.autoCycles : team.teleopCycles
    return cycles.length > 0 ? (cycles[cycles.length - 1] ?? 0) : 0
  }

  function addCycle(
    team: TeamScoutData,
    ballsOrPhase: number | 'auto' | 'teleop' = 1,
    phaseOrIndex: 'auto' | 'teleop' | number = 'teleop',
    teamIndex: number = 0
  ) {
    let initialBalls = 1
    let phase: 'auto' | 'teleop' = 'teleop'
    let idx = teamIndex
    let isExplicitBalls = false

    if (typeof ballsOrPhase === 'number') {
      initialBalls = ballsOrPhase
      isExplicitBalls = true
      if (typeof phaseOrIndex === 'string') {
        phase = phaseOrIndex
      } else if (typeof phaseOrIndex === 'number') {
        idx = phaseOrIndex
      }
    } else {
      phase = ballsOrPhase
      if (typeof phaseOrIndex === 'number') {
        idx = phaseOrIndex
      }
    }

    const cycles = phase === 'auto' ? team.autoCycles : team.teleopCycles
    const now = Date.now()

    // 显式指定球数调用 (如单测 addCycle(team, 2))：直接添加并返回
    if (isExplicitBalls) {
      cycles.push(initialBalls)
      hapticMedium()
      if (phase === 'auto') {
        syncAutoBalls(team)
      }
      if (activeCycleTap.value?.timer) clearTimeout(activeCycleTap.value.timer)
      activeCycleTap.value = null
      return
    }

    const isRecent =
      activeCycleTap.value &&
      activeCycleTap.value.teamIndex === idx &&
      activeCycleTap.value.phase === phase &&
      now - activeCycleTap.value.timestamp < TAP_WINDOW_MS &&
      cycles.length > 0

    if (isRecent) {
      // 连续点击：在同一轮次累加球数 (0 -> 1 -> 2 -> 3 -> 4)
      const lastIdx = cycles.length - 1
      const current = cycles[lastIdx] ?? 0
      if (current < 4) {
        cycles[lastIdx] = current + 1
        hapticMedium()
        bump(lastIdx, phase === 'auto' ? 'autoCycle' : 'teleopCycle', 'up')
        if (phase === 'auto') {
          syncAutoBalls(team)
        }
      } else {
        hapticLight()
      }
    } else {
      // 开启新一轮打球，默认从 0 开始
      cycles.push(0)
      hapticMedium()
      if (phase === 'auto') {
        syncAutoBalls(team)
      }
    }

    if (activeCycleTap.value?.timer) {
      clearTimeout(activeCycleTap.value.timer)
    }

    const timer = setTimeout(() => {
      if (
        activeCycleTap.value &&
        activeCycleTap.value.teamIndex === idx &&
        activeCycleTap.value.phase === phase
      ) {
        activeCycleTap.value = null
      }
    }, TAP_WINDOW_MS)

    activeCycleTap.value = {
      teamIndex: idx,
      phase,
      timestamp: now,
      timer
    }
  }

  function setLastCycleBalls(
    team: TeamScoutData,
    balls: number,
    phase: 'auto' | 'teleop' = 'teleop',
    teamIndex: number = 0
  ) {
    const cycles = phase === 'auto' ? team.autoCycles : team.teleopCycles
    if (phase === 'auto' && balls === 0) {
      team.autoCycles = []
      syncAutoBalls(team)
      if (activeCycleTap.value?.timer) clearTimeout(activeCycleTap.value.timer)
      activeCycleTap.value = null
      hapticSelection()
      return
    }

    if (cycles.length === 0) {
      cycles.push(balls)
    } else {
      cycles[cycles.length - 1] = balls
    }

    bump(cycles.length - 1, phase === 'auto' ? 'autoCycle' : 'teleopCycle', 'up')
    if (phase === 'auto') {
      syncAutoBalls(team)
    }
    hapticSelection()

    if (activeCycleTap.value?.timer) clearTimeout(activeCycleTap.value.timer)
    activeCycleTap.value = null
  }

  function undoLastCycle(
    team: TeamScoutData,
    phase: 'auto' | 'teleop' = 'teleop',
    _teamIndex: number = 0
  ) {
    const cycles = phase === 'auto' ? team.autoCycles : team.teleopCycles
    if (cycles.length > 0) {
      cycles.pop()
      if (phase === 'auto') {
        syncAutoBalls(team)
      }
      hapticLight()
    }
    if (activeCycleTap.value?.timer) clearTimeout(activeCycleTap.value.timer)
    activeCycleTap.value = null
  }

  function incrementCycle(
    team: TeamScoutData,
    cIndex: number,
    phase: 'auto' | 'teleop' = 'teleop',
    _teamIndex: number = 0
  ) {
    const cycles = phase === 'auto' ? team.autoCycles : team.teleopCycles
    const current = cycles[cIndex]
    if (current !== undefined && current < 4) {
      cycles[cIndex] = current + 1
      hapticMedium()
      bump(cIndex, phase === 'auto' ? 'autoCycle' : 'teleopCycle', 'up')
      if (phase === 'auto') {
        syncAutoBalls(team)
      }
    }
  }

  function decrementCycle(
    team: TeamScoutData,
    cIndex: number,
    phase: 'auto' | 'teleop' = 'teleop',
    _teamIndex: number = 0
  ) {
    const cycles = phase === 'auto' ? team.autoCycles : team.teleopCycles
    const current = cycles[cIndex]
    if (current !== undefined && current > 0) {
      cycles[cIndex] = current - 1
      hapticLight()
      bump(cIndex, phase === 'auto' ? 'autoCycle' : 'teleopCycle', 'down')
      if (phase === 'auto') {
        syncAutoBalls(team)
      }
    }
  }

  function getCycleBallsTotal(team: TeamScoutData, phase: 'auto' | 'teleop' = 'teleop'): number {
    const cycles = phase === 'auto' ? team.autoCycles : team.teleopCycles
    return cycles.reduce((sum, b) => sum + b, 0)
  }

  function getAvgBallsPerCycle(team: TeamScoutData, phase: 'auto' | 'teleop' = 'teleop'): string {
    const cycles = phase === 'auto' ? team.autoCycles : team.teleopCycles
    if (cycles.length === 0) return '0.0'
    return (getCycleBallsTotal(team, phase) / cycles.length).toFixed(1)
  }

  function incrementAutoBalls(team: TeamScoutData, index: number = 0) {
    if (team.autoCycles.length === 0) {
      team.autoCycles.push(1)
    } else {
      const lastIdx = team.autoCycles.length - 1
      const cur = team.autoCycles[lastIdx]
      if (cur !== undefined && cur < 4) {
        team.autoCycles[lastIdx] = cur + 1
      } else {
        team.autoCycles.push(1)
      }
    }
    syncAutoBalls(team)
    hapticMedium()
    bump(index, 'autoBalls', 'up')
  }

  function decrementAutoBalls(team: TeamScoutData, index: number = 0) {
    if (team.autoBalls > 0) {
      if (team.autoCycles.length > 0) {
        const lastIdx = team.autoCycles.length - 1
        const cur = team.autoCycles[lastIdx]
        if (cur !== undefined && cur > 1) {
          team.autoCycles[lastIdx] = cur - 1
        } else {
          team.autoCycles.pop()
        }
      }
      syncAutoBalls(team)
      hapticLight()
      bump(index, 'autoBalls', 'down')
    }
  }

  function setAutoBalls(team: TeamScoutData, val: number, index: number = 0) {
    setLastCycleBalls(team, val, 'auto', index)
  }

  function calcTeamTotal(team: TeamScoutData) {
    const auto = (team.autoLeave ? 3 : 0) +
                 ((team.autoBalls || 0) * 3) +
                 (team.autoPark ? 5 : 0)
    const totalBalls = getCycleBallsTotal(team)
    const teleop = totalBalls * 2
    const endgame = (team.flowerPlaced ? 10 : 0) +
                    (team.flowerBottomBonus ? 5 : 0) +
                    (team.teleopPark ? 5 : 0)
    return auto + teleop + endgame
  }

  return {
    bump,
    getBumpClass,
    clearBump,
    activeCycleTap,
    syncAutoBalls,
    isCycleTapping,
    getLastCycleBalls,
    addCycle,
    setLastCycleBalls,
    undoLastCycle,
    incrementCycle,
    decrementCycle,
    getCycleBallsTotal,
    getAvgBallsPerCycle,
    incrementAutoBalls,
    decrementAutoBalls,
    setAutoBalls,
    calcTeamTotal
  }
}
