import type { AdvancementDetail, OfficialMatch, ScoutingRecord } from '@/types'
import { getRecordTournamentLevel } from '@/utils/tournament'

export type SpNpOprConfidence = 'high' | 'medium' | 'low' | 'scout_only'

export interface TeamNpOprResult {
  teamNumber: number
  spNpOpr: number
  rawNpOpr: number | null
  spNpOprAuto: number | null
  spNpOprTeleop: number | null
  spNpOprEndgame: number | null
  spNpOprDelta: number | null
  spNpOprConfidence: SpNpOprConfidence
  spNpOprConfidenceScore: number
  spNpOprOfficialMatches: number
  spNpOprBrokenExcluded: number
}

const PRIOR_MAX_LAMBDA = 1.8
const PRIOR_SCALE = 0.45
const GLOBAL_SMOOTHING_GAMMA = 0.08
const RAW_OPR_RIDGE = 1e-4
const BROKEN_WITH_SCORE_WEIGHT = 0.25

function roundTo1Decimal(value: number): number {
  const rounded = Math.round(value * 10) / 10
  return Object.is(rounded, -0) ? 0 : rounded
}

/**
 * Solves linear system A * x = b using Gaussian elimination with partial pivoting.
 * Returns null if the matrix is singular.
 */
export function solveLinearSystem(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length
  if (n === 0) return []

  const a = matrix.map((row) => row.slice())
  const b = rhs.slice()

  for (let col = 0; col < n; col++) {
    let pivotRow = col
    let maxAbs = Math.abs(a[col]![col]!)
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(a[row]![col]!)
      if (val > maxAbs) {
        maxAbs = val
        pivotRow = row
      }
    }

    if (maxAbs < 1e-12 || !Number.isFinite(maxAbs)) {
      return null
    }

    if (pivotRow !== col) {
      const tmpRow = a[col]!
      a[col] = a[pivotRow]!
      a[pivotRow] = tmpRow
      const tmpB = b[col]!
      b[col] = b[pivotRow]!
      b[pivotRow] = tmpB
    }

    const pivot = a[col]![col]!
    for (let row = col + 1; row < n; row++) {
      const factor = a[row]![col]! / pivot
      if (factor === 0) continue
      a[row]![col] = 0
      for (let k = col + 1; k < n; k++) {
        a[row]![k] = a[row]![k]! - factor * a[col]![k]!
      }
      b[row] = b[row]! - factor * b[col]!
    }
  }

  const x = new Array<number>(n).fill(0)
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row]!
    for (let k = row + 1; k < n; k++) {
      sum -= a[row]![k]! * x[k]!
    }
    const diag = a[row]![row]!
    if (Math.abs(diag) < 1e-12 || !Number.isFinite(diag)) {
      return null
    }
    x[row] = sum / diag
  }

  return x
}

function deduplicateRecords(records: ScoutingRecord[]): Map<string, ScoutingRecord> {
  const uniqueRecords = new Map<string, ScoutingRecord>()
  for (const record of records) {
    if (record.isDeleted) continue
    const level = getRecordTournamentLevel(record)
    const key = `${level}-${record.matchNumber}-${record.teamNumber}`
    const existing = uniqueRecords.get(key)
    if (!existing || new Date(record.updatedAt) > new Date(existing.updatedAt)) {
      uniqueRecords.set(key, record)
    }
  }
  return uniqueRecords
}

function computeConfidence(
  officialMatches: number,
  scoutMatchesUsed: number,
  brokenExcluded: number
): { confidence: SpNpOprConfidence; score: number } {
  if (officialMatches === 0) {
    const score = Math.max(0, Math.min(45, scoutMatchesUsed * 12 - brokenExcluded * 5))
    return { confidence: 'scout_only', score }
  }

  const base = officialMatches * 14 + scoutMatchesUsed * 10 - brokenExcluded * 5
  const score = Math.max(10, Math.min(100, Math.round(base)))

  if (officialMatches >= 4 && scoutMatchesUsed >= 2) {
    return { confidence: 'high', score: Math.max(75, score) }
  }
  if (officialMatches >= 2) {
    return { confidence: 'medium', score: Math.max(45, Math.min(74, score)) }
  }
  return { confidence: 'low', score: Math.min(44, score) }
}

/**
 * Computes Scout-Prior Non-Penalty OPR (SP-NP OPR) and Raw FTCScout NP OPR
 * across all teams appearing in scouting records, official matches, or advancement data.
 */
export function calculateEventNpOpr(
  records: ScoutingRecord[],
  officialMatches: OfficialMatch[],
  scoutReliability: Record<string, 'low' | 'high'>,
  advancementMap?: Map<number, AdvancementDetail>
): Map<number, TeamNpOprResult> {
  const results = new Map<number, TeamNpOprResult>()
  const uniqueRecords = deduplicateRecords(records)

  const teamSet = new Set<number>()
  for (const rec of uniqueRecords.values()) {
    if (rec.teamNumber > 0) teamSet.add(rec.teamNumber)
  }
  for (const match of officialMatches) {
    if (!Array.isArray(match.teams)) continue
    for (const t of match.teams) {
      if (t.teamNumber > 0) teamSet.add(t.teamNumber)
    }
  }
  if (advancementMap) {
    for (const teamNum of advancementMap.keys()) {
      if (teamNum > 0) teamSet.add(teamNum)
    }
  }

  const teams = Array.from(teamSet).sort((a, b) => a - b)
  const n = teams.length
  if (n === 0) return results

  const teamIndex = new Map<number, number>()
  teams.forEach((t, idx) => teamIndex.set(t, idx))

  // 1. Compute scout priors per team
  const scoutWeightSum = new Array<number>(n).fill(0)
  const scoutWeightedTotal = new Array<number>(n).fill(0)
  const scoutWeightedAuto = new Array<number>(n).fill(0)
  const scoutWeightedTeleop = new Array<number>(n).fill(0)
  const scoutWeightedEndgame = new Array<number>(n).fill(0)
  const scoutMatchesUsed = new Array<number>(n).fill(0)
  const brokenExcluded = new Array<number>(n).fill(0)

  for (const rec of uniqueRecords.values()) {
    const idx = teamIndex.get(rec.teamNumber)
    if (idx === undefined) continue
    if (rec.isBroken) {
      brokenExcluded[idx] = brokenExcluded[idx]! + 1
      continue
    }
    const w = scoutReliability[rec.scoutId] === 'low' ? 0.5 : 1.0
    scoutWeightSum[idx] = scoutWeightSum[idx]! + w
    scoutWeightedTotal[idx] = scoutWeightedTotal[idx]! + rec.totalScore * w
    scoutWeightedAuto[idx] = scoutWeightedAuto[idx]! + rec.autoScore * w
    scoutWeightedTeleop[idx] = scoutWeightedTeleop[idx]! + rec.teleopScore * w
    scoutWeightedEndgame[idx] = scoutWeightedEndgame[idx]! + rec.endgameScore * w
    scoutMatchesUsed[idx] = scoutMatchesUsed[idx]! + 1
  }

  const muScout = new Array<number>(n).fill(0)
  const lambda = new Array<number>(n).fill(0)
  let priorSum = 0
  let priorCount = 0

  for (let i = 0; i < n; i++) {
    const wSum = scoutWeightSum[i]!
    if (wSum > 0) {
      muScout[i] = scoutWeightedTotal[i]! / wSum
      lambda[i] = Math.min(PRIOR_MAX_LAMBDA, PRIOR_SCALE * Math.sqrt(wSum))
      priorSum += muScout[i]!
      priorCount++
    }
  }

  // Global event mean fallback
  let globalMean = priorCount > 0 ? priorSum / priorCount : 0
  if (priorCount === 0 && officialMatches.length > 0) {
    let officialSum = 0
    let officialAllianceCount = 0
    for (const m of officialMatches) {
      if (!m.scores) continue
      for (const alliance of ['red', 'blue'] as const) {
        const pts = m.scores[alliance]?.totalPointsNp
        const allianceTeams = (m.teams || []).filter((t) => t.alliance.toLowerCase() === alliance)
        if (typeof pts === 'number' && Number.isFinite(pts) && allianceTeams.length > 0) {
          officialSum += pts / allianceTeams.length
          officialAllianceCount++
        }
      }
    }
    if (officialAllianceCount > 0) {
      globalMean = officialSum / officialAllianceCount
    }
  }

  // 2. Build normal equations for SP-NP OPR and Raw NP OPR
  const aSp: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  const bSp = new Array<number>(n).fill(0)

  const aRaw: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  const bRaw = new Array<number>(n).fill(0)
  const officialMatchesCount = new Array<number>(n).fill(0)
  let rawEquationCount = 0

  for (const match of officialMatches) {
    if (!match.scores || !Array.isArray(match.teams)) continue
    const mLevel = (match.tournamentLevel || 'QUALIFICATION').toUpperCase()

    for (const alliance of ['red', 'blue'] as const) {
      const y = match.scores[alliance]?.totalPointsNp
      if (typeof y !== 'number' || !Number.isFinite(y)) continue

      const allianceTeams = match.teams.filter((t) => t.alliance.toLowerCase() === alliance)
      if (allianceTeams.length === 0) continue

      const rawIndices: number[] = []
      const spIndices: number[] = []
      let eqWeight = 1.0

      for (const t of allianceTeams) {
        const idx = teamIndex.get(t.teamNumber)
        if (idx === undefined) continue
        rawIndices.push(idx)
        officialMatchesCount[idx] = officialMatchesCount[idx]! + 1

        const rec = uniqueRecords.get(`${mLevel}-${match.matchNum}-${t.teamNumber}`)
        const tMeta = t as { teamNumber: number; alliance: string; onField?: boolean; dq?: boolean }
        const isBroken = Boolean(rec?.isBroken)
        const scoutTotal = rec ? rec.totalScore : 0

        const zeroContribution =
          tMeta.onField === false ||
          tMeta.dq === true ||
          (isBroken && scoutTotal <= 0)

        if (!zeroContribution) {
          spIndices.push(idx)
          if (isBroken && scoutTotal > 0) {
            eqWeight = BROKEN_WITH_SCORE_WEIGHT
          }
        }
      }

      if (rawIndices.length > 0) {
        rawEquationCount++
        for (const r of rawIndices) {
          bRaw[r] = bRaw[r]! + y
          for (const c of rawIndices) {
            aRaw[r]![c] = aRaw[r]![c]! + 1
          }
        }
      }

      // Skip SP-NP OPR equation if all alliance teams have M = 0
      if (spIndices.length > 0) {
        for (const r of spIndices) {
          bSp[r] = bSp[r]! + eqWeight * y
          for (const c of spIndices) {
            aSp[r]![c] = aSp[r]![c]! + eqWeight
          }
        }
      }
    }
  }

  // Add Ridge priors to SP-NP OPR and Raw NP OPR
  for (let i = 0; i < n; i++) {
    aSp[i]![i] = aSp[i]![i]! + lambda[i]! + GLOBAL_SMOOTHING_GAMMA
    bSp[i] = bSp[i]! + lambda[i]! * muScout[i]! + GLOBAL_SMOOTHING_GAMMA * globalMean
    aRaw[i]![i] = aRaw[i]![i]! + RAW_OPR_RIDGE
  }

  const spSolution = solveLinearSystem(aSp, bSp)
  const rawSolution = rawEquationCount > 0 ? solveLinearSystem(aRaw, bRaw) : null

  for (let i = 0; i < n; i++) {
    const teamNumber = teams[i]!
    const rawSp = spSolution && Number.isFinite(spSolution[i]) ? spSolution[i]! : muScout[i]!
    const spNpOpr = roundTo1Decimal(rawSp)

    const offCount = officialMatchesCount[i]!
    const rawNpOpr =
      offCount >= 2 && rawSolution && Number.isFinite(rawSolution[i])
        ? roundTo1Decimal(rawSolution[i]!)
        : null

    let spNpOprAuto: number | null = null
    let spNpOprTeleop: number | null = null
    let spNpOprEndgame: number | null = null

    const wSum = scoutWeightSum[i]!
    if (scoutMatchesUsed[i]! > 0 && wSum > 0) {
      const autoAvg = scoutWeightedAuto[i]! / wSum
      const teleopAvg = scoutWeightedTeleop[i]! / wSum
      const endgameAvg = scoutWeightedEndgame[i]! / wSum
      const stageSum = autoAvg + teleopAvg + endgameAvg

      if (stageSum > 0) {
        spNpOprAuto = roundTo1Decimal(spNpOpr * (autoAvg / stageSum))
        spNpOprTeleop = roundTo1Decimal(spNpOpr * (teleopAvg / stageSum))
        spNpOprEndgame = roundTo1Decimal(spNpOpr - spNpOprAuto - spNpOprTeleop)
      }
    }

    const spNpOprDelta = rawNpOpr !== null ? roundTo1Decimal(spNpOpr - rawNpOpr) : null
    const { confidence, score } = computeConfidence(
      offCount,
      scoutMatchesUsed[i]!,
      brokenExcluded[i]!
    )

    results.set(teamNumber, {
      teamNumber,
      spNpOpr,
      rawNpOpr,
      spNpOprAuto,
      spNpOprTeleop,
      spNpOprEndgame,
      spNpOprDelta,
      spNpOprConfidence: confidence,
      spNpOprConfidenceScore: score,
      spNpOprOfficialMatches: offCount,
      spNpOprBrokenExcluded: brokenExcluded[i]!
    })
  }

  return results
}
