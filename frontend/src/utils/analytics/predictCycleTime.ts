import type { ScoutingFormData } from '@/types'

/** Minimum valid inter-cycle intervals required per match (drop 1 shortest + keep 4). */
export const PREDICT_CYCLE_MIN_INTERVALS = 5

/** Number of shorter valid intervals retained per qualifying match after dropping the fastest 1. */
export const PREDICT_CYCLE_KEEP_COUNT = 4

/** Maximum valid gap in seconds between consecutive cycles before treating it as a robot stall/pause. */
export const PREDICT_CYCLE_MAX_GAP_SEC = 120

/**
 * Effective active TeleOp scoring window (seconds) used for `estimatedMaxCycles`.
 * Out of the 120s TeleOp period, ~30s is typically spent on first preload transition,
 * defense evasion, and Endgame Flower/Garden/Park positioning, leaving ~90s of pure cycle time.
 */
export const PREDICT_CYCLE_EFFECTIVE_WINDOW_SEC = 90

export interface TeamPredictCycleStats {
  predictCycleTime: number | null
  predictCycleMatches: number
  predictCycleSpread: number | null
  estimatedMaxCycles: number | null
}

export interface PredictCycleMatchInput {
  teleopCycles?: number[]
  teleopCycleTimestamps?: number[]
  rawData?: string | null
  isBroken?: boolean
}

function roundTo1Decimal(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Extracts valid TeleOp inter-cycle intervals (seconds) for a single match and returns
 * the sorted 4 shorter intervals after removing the fastest single outlier (`slice(1, 5)`).
 *
 * Returns `null` when fewer than `PREDICT_CYCLE_MIN_INTERVALS` (5) valid intervals exist.
 */
export function extractMatchRetainedCycleIntervals(
  teleopCycles?: number[],
  timestamps?: number[]
): number[] | null {
  if (!Array.isArray(timestamps) || timestamps.length < PREDICT_CYCLE_MIN_INTERVALS + 1) {
    return null
  }

  const alignedLength = Array.isArray(teleopCycles)
    ? Math.min(teleopCycles.length, timestamps.length)
    : timestamps.length

  if (alignedLength < PREDICT_CYCLE_MIN_INTERVALS + 1) {
    return null
  }

  // Filter strictly finite, positive, monotonically increasing timestamps first so
  // an out-of-order clock artifact never produces negative intervals or corrupts adjacent pairs.
  const validTimestamps: number[] = []
  for (let i = 0; i < alignedLength; i++) {
    const ts = Number(timestamps[i])
    if (!Number.isFinite(ts) || ts <= 0) continue
    const lastValid = validTimestamps[validTimestamps.length - 1]
    if (lastValid !== undefined && ts <= lastValid) {
      continue
    }
    validTimestamps.push(ts)
  }

  if (validTimestamps.length < PREDICT_CYCLE_MIN_INTERVALS + 1) {
    return null
  }

  const validIntervals: number[] = []
  for (let i = 1; i < validTimestamps.length; i++) {
    const currTs = validTimestamps[i]
    const prevTs = validTimestamps[i - 1]
    if (currTs === undefined || prevTs === undefined) continue
    const dtSec = (currTs - prevTs) / 1000
    if (dtSec > 0 && dtSec <= PREDICT_CYCLE_MAX_GAP_SEC) {
      validIntervals.push(dtSec)
    }
  }

  if (validIntervals.length < PREDICT_CYCLE_MIN_INTERVALS) {
    return null
  }

  validIntervals.sort((a, b) => a - b)
  // Drop the single fastest cycle interval (`slice(1)`) and keep the next 4 shorter intervals.
  return validIntervals.slice(1, 1 + PREDICT_CYCLE_KEEP_COUNT)
}

/**
 * Computes a single match's Predict Cycle Time (in seconds, rounded to 1 decimal place).
 * Returns `null` when the match does not reach the 5-interval minimum threshold.
 */
export function calcMatchPredictCycleTime(
  teleopCycles?: number[],
  timestamps?: number[]
): number | null {
  const retained = extractMatchRetainedCycleIntervals(teleopCycles, timestamps)
  if (!retained || retained.length < PREDICT_CYCLE_KEEP_COUNT) {
    return null
  }
  const sum = retained.reduce((acc, sec) => acc + sec, 0)
  return roundTo1Decimal(sum / retained.length)
}

/**
 * Aggregates Predict Cycle Time statistics across a team's matches.
 * Uses all retained `4 * qualifyingMatches` intervals from non-broken qualifying matches
 * (each qualifying match contributes equal weight of 4 intervals).
 */
export function aggregateTeamPredictCycleStats(
  matches: PredictCycleMatchInput[]
): TeamPredictCycleStats {
  const allRetained: number[] = []
  let predictCycleMatches = 0

  for (const match of matches) {
    if (match.isBroken) continue
    let teleopCycles = match.teleopCycles
    let timestamps = match.teleopCycleTimestamps
    if ((!timestamps || timestamps.length === 0) && match.rawData) {
      try {
        const parsed = JSON.parse(match.rawData) as Partial<Pick<ScoutingFormData, 'teleopCycles' | 'teleopCycleTimestamps'>>
        if (Array.isArray(parsed.teleopCycles)) teleopCycles = parsed.teleopCycles
        if (Array.isArray(parsed.teleopCycleTimestamps)) timestamps = parsed.teleopCycleTimestamps
      } catch {
        // Ignore malformed rawData JSON
      }
    }
    const retained = extractMatchRetainedCycleIntervals(teleopCycles, timestamps)
    if (!retained || retained.length < PREDICT_CYCLE_KEEP_COUNT) continue
    predictCycleMatches++
    allRetained.push(...retained)
  }

  if (predictCycleMatches === 0 || allRetained.length === 0) {
    return {
      predictCycleTime: null,
      predictCycleMatches: 0,
      predictCycleSpread: null,
      estimatedMaxCycles: null
    }
  }

  const rawMean = allRetained.reduce((acc, sec) => acc + sec, 0) / allRetained.length
  const predictCycleTime = roundTo1Decimal(rawMean)

  const variance =
    allRetained.reduce((acc, sec) => {
      const diff = sec - rawMean
      return acc + diff * diff
    }, 0) / allRetained.length
  const predictCycleSpread = roundTo1Decimal(Math.sqrt(variance))

  const estimatedMaxCycles =
    predictCycleTime > 0
      ? roundTo1Decimal(PREDICT_CYCLE_EFFECTIVE_WINDOW_SEC / predictCycleTime)
      : null

  return {
    predictCycleTime,
    predictCycleMatches,
    predictCycleSpread,
    estimatedMaxCycles
  }
}
