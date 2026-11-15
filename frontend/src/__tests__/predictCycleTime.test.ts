import { describe, it, expect } from 'vitest'
import {
  PREDICT_CYCLE_MIN_INTERVALS,
  PREDICT_CYCLE_KEEP_COUNT,
  PREDICT_CYCLE_MAX_GAP_SEC,
  PREDICT_CYCLE_EFFECTIVE_WINDOW_SEC,
  extractMatchRetainedCycleIntervals,
  calcMatchPredictCycleTime,
  aggregateTeamPredictCycleStats
} from '@/utils/analytics/predictCycleTime'

describe('predictCycleTime analytics', () => {
  const baseMs = 1_700_000_000_000
  const toTimestamps = (gapsSec: number[]): number[] => {
    const out = [baseMs]
    let acc = baseMs
    for (const g of gapsSec) {
      acc += g * 1000
      out.push(acc)
    }
    return out
  }

  it('exposes the agreed BIOBUZZ Predict Cycle constants', () => {
    expect(PREDICT_CYCLE_MIN_INTERVALS).toBe(5)
    expect(PREDICT_CYCLE_KEEP_COUNT).toBe(4)
    expect(PREDICT_CYCLE_MAX_GAP_SEC).toBe(120)
    expect(PREDICT_CYCLE_EFFECTIVE_WINDOW_SEC).toBe(90)
  })

  it('returns null when a match has fewer than 5 valid intervals', () => {
    // 5 timestamps -> only 4 intervals (< 5 threshold)
    const ts4Intervals = toTimestamps([6, 7, 8, 9])
    expect(extractMatchRetainedCycleIntervals([2, 2, 2, 2, 2], ts4Intervals)).toBeNull()
    expect(calcMatchPredictCycleTime([2, 2, 2, 2, 2], ts4Intervals)).toBeNull()

    // Empty / undefined inputs
    expect(calcMatchPredictCycleTime(undefined, undefined)).toBeNull()
    expect(calcMatchPredictCycleTime([3, 3], [baseMs])).toBeNull()
  })

  it('drops the single shortest interval and averages the next 4 shorter intervals when >= 5 intervals exist', () => {
    // Sorted intervals: [4, 6, 8, 10, 12] -> drop 4, keep [6, 8, 10, 12] -> avg 9.0
    const ts5 = toTimestamps([10, 4, 12, 8, 6])
    const retained5 = extractMatchRetainedCycleIntervals([2, 2, 2, 2, 2, 2], ts5)
    expect(retained5).toEqual([6, 8, 10, 12])
    expect(calcMatchPredictCycleTime([2, 2, 2, 2, 2, 2], ts5)).toBe(9.0)

    // Sorted intervals: [3, 5, 7, 9, 11, 18, 25] -> drop 3, keep [5, 7, 9, 11] -> avg 8.0
    const ts7 = toTimestamps([18, 5, 25, 3, 9, 11, 7])
    const retained7 = extractMatchRetainedCycleIntervals(undefined, ts7)
    expect(retained7).toEqual([5, 7, 9, 11])
    expect(calcMatchPredictCycleTime(undefined, ts7)).toBe(8.0)
  })

  it('filters out non-positive (<= 0s) and long interruption (> 120s) gaps before checking threshold', () => {
    // Contains a 0s duplicate gap and a 135s stall gap; remaining 5 valid gaps [5, 7, 8, 10, 14]
    const tsWithAbnormal = toTimestamps([0, 7, 135, 10, 5, 14, 8])
    // Even if teleopCycles omitted 0/abnormal or has matching length 8:
    const retained = extractMatchRetainedCycleIntervals(new Array(8).fill(2), tsWithAbnormal)
    expect(retained).toEqual([7, 8, 10, 14])
    expect(calcMatchPredictCycleTime(new Array(8).fill(2), tsWithAbnormal)).toBe(9.8)

    // After filtering abnormal gaps, only 4 valid intervals remain -> must return null
    const tsTooFewAfterFilter = toTimestamps([0, 7, 135, 10, 5, 8])
    expect(calcMatchPredictCycleTime(new Array(7).fill(2), tsTooFewAfterFilter)).toBeNull()
  })

  it('aligns timestamps safely with teleopCycles count when mismatched', () => {
    // teleopCycles has 6 cycles, timestamps accidentally has 8 entries -> align to first 6 timestamps -> 5 intervals
    const tsLong = toTimestamps([4, 6, 8, 10, 12, 3, 3])
    const retained = extractMatchRetainedCycleIntervals([2, 2, 2, 2, 2, 2], tsLong)
    expect(retained).toEqual([6, 8, 10, 12])
    expect(calcMatchPredictCycleTime([2, 2, 2, 2, 2, 2], tsLong)).toBe(9.0)
  })

  it('aggregates qualifying matches for team stats, skipping broken and insufficient matches', () => {
    const matchQ1 = {
      isBroken: false,
      rawData: JSON.stringify({
        teleopCycles: [2, 2, 2, 2, 2, 2],
        teleopCycleTimestamps: toTimestamps([4, 8, 8, 8, 8]) // retained: [8, 8, 8, 8]
      })
    }
    const matchQ2 = {
      isBroken: false,
      rawData: JSON.stringify({
        teleopCycles: [2, 2, 2, 2, 2, 2, 2],
        teleopCycleTimestamps: toTimestamps([5, 10, 10, 10, 10, 20]) // retained: [10, 10, 10, 10]
      })
    }
    const matchInsufficient = {
      isBroken: false,
      rawData: JSON.stringify({
        teleopCycles: [2, 2, 2, 2],
        teleopCycleTimestamps: toTimestamps([5, 5, 5]) // 3 intervals -> skipped
      })
    }
    const matchBroken = {
      isBroken: true,
      rawData: JSON.stringify({
        teleopCycles: [2, 2, 2, 2, 2, 2],
        teleopCycleTimestamps: toTimestamps([2, 2, 2, 2, 2]) // broken -> skipped
      })
    }

    const stats = aggregateTeamPredictCycleStats([matchQ1, matchQ2, matchInsufficient, matchBroken])
    expect(stats.predictCycleMatches).toBe(2)
    // Mean across [8,8,8,8,10,10,10,10] = 9.0
    expect(stats.predictCycleTime).toBe(9.0)
    expect(stats.predictCycleSpread).not.toBeNull()
    expect(stats.predictCycleSpread!).toBeGreaterThan(0)
    // 90 / 9.0 = 10.0 cycles
    expect(stats.estimatedMaxCycles).toBe(10.0)
  })

  it('returns null stats when zero matches qualify', () => {
    const emptyStats = aggregateTeamPredictCycleStats([
      { isBroken: false, rawData: JSON.stringify({ teleopCycles: [2, 2], teleopCycleTimestamps: toTimestamps([5]) }) },
      { isBroken: true, rawData: JSON.stringify({ teleopCycles: [2, 2, 2, 2, 2, 2], teleopCycleTimestamps: toTimestamps([5, 5, 5, 5, 5]) }) }
    ])
    expect(emptyStats).toEqual({
      predictCycleTime: null,
      predictCycleMatches: 0,
      predictCycleSpread: null,
      estimatedMaxCycles: null
    })
  })
})
