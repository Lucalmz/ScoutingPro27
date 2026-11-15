import type { ScoutingRecord, OfficialMatch, RankingRow, AdvancementDetail } from '@/types'
import { getRecordTournamentLevel, getTournamentLevelOrder } from '@/utils/tournament'
import { aggregateTeamPredictCycleStats } from './predictCycleTime'

export interface BiobuzzEndgameFields {
  flowerNectars: number
  flowerBottomBonusCount: number
  flowerPollens: number
  gardenBalls: number
  flowerDescore: boolean
  g410EarlyFlowerFoul: boolean
  teleopPark: boolean
  flowerPlaced: boolean
  flowerBottomBonus: boolean
}

export interface ParsedScoutRawData {
  autoLeave: boolean
  autoBalls: number
  autoPark: boolean
  teleopCycles: number[]
  teleopMissedCycles: number[]
  teleopCycleTimestamps: number[]
  predictCycleTimeSec: number | null
  endgame: BiobuzzEndgameFields
}

function clampInt(value: unknown, min: number, max: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return min
  return Math.max(min, Math.min(max, Math.round(num)))
}

/**
 * Normalizes BIOBUZZ Endgame fields from raw scouting JSON, falling back cleanly
 * for legacy records that only stored boolean `flowerPlaced` / `flowerBottomBonus`.
 */
export function parseBiobuzzEndgame(raw: Record<string, any> | null | undefined): BiobuzzEndgameFields {
  const data = raw ?? {}
  const flowerNectars = typeof data.flowerNectars === 'number'
    ? clampInt(data.flowerNectars, 0, 8)
    : (data.flowerPlaced ? 1 : 0)

  const rawBottomBonusCount = typeof data.flowerBottomBonusCount === 'number'
    ? clampInt(data.flowerBottomBonusCount, 0, 4)
    : (data.flowerBottomBonus ? 1 : 0)
  // A flower can only earn the +5 bottom bonus if that alliance owns >= 1 Nectar on it.
  const flowerBottomBonusCount = Math.min(rawBottomBonusCount, flowerNectars)

  const flowerPollens = typeof data.flowerPollens === 'number'
    ? clampInt(data.flowerPollens, 0, 12)
    : 0
  const gardenBalls = typeof data.gardenBalls === 'number'
    ? clampInt(data.gardenBalls, 0, 12)
    : 0
  const flowerDescore = Boolean(data.flowerDescore)
  const g410EarlyFlowerFoul = Boolean(data.g410EarlyFlowerFoul)
  const teleopPark = Boolean(data.teleopPark)

  return {
    flowerNectars,
    flowerBottomBonusCount,
    flowerPollens,
    gardenBalls,
    flowerDescore,
    g410EarlyFlowerFoul,
    teleopPark,
    flowerPlaced: flowerNectars > 0,
    flowerBottomBonus: flowerBottomBonusCount > 0
  }
}

/**
 * Calculates BIOBUZZ 2026-2027 Endgame score:
 * TeleOp Park (+5) + Flower Nectars (+2/ball) + Flower Bottom Bonus (+5/flower)
 * + Flower Pollens (+2/ball) + Garden Balls (+1/ball).
 */
export function calcBiobuzzEndgameScore(endgame: Pick<
  BiobuzzEndgameFields,
  'teleopPark' | 'flowerNectars' | 'flowerBottomBonusCount' | 'flowerPollens' | 'gardenBalls'
>): number {
  const nectars = clampInt(endgame.flowerNectars, 0, 8)
  const bottomBonusCount = Math.min(clampInt(endgame.flowerBottomBonusCount, 0, 4), nectars)
  const pollens = clampInt(endgame.flowerPollens, 0, 12)
  const garden = clampInt(endgame.gardenBalls, 0, 12)
  return (
    (endgame.teleopPark ? 5 : 0) +
    nectars * 2 +
    bottomBonusCount * 5 +
    pollens * 2 +
    garden
  )
}

/**
 * Parses `ScoutingRecord.rawData` (JSON string or plain object) into normalized BIOBUZZ fields.
 */
export function parseScoutRawData(rawData: unknown): ParsedScoutRawData {
  let parsed: Record<string, any> = {}
  try {
    if (typeof rawData === 'string' && rawData.trim()) {
      parsed = JSON.parse(rawData)
    } else if (rawData && typeof rawData === 'object') {
      parsed = rawData as Record<string, any>
    }
  } catch {
    parsed = {}
  }

  const autoLeave = Boolean(parsed.autoLeave)
  const autoBalls = typeof parsed.autoBalls === 'number'
    ? Math.max(0, Math.round(parsed.autoBalls))
    : ((parsed.autoPreload ? 1 : 0) + (parsed.autoSecondary ? 1 : 0))
  const autoPark = Boolean(parsed.autoPark)

  const teleopCycles = Array.isArray(parsed.teleopCycles)
    ? parsed.teleopCycles.map((c: unknown) => Math.max(0, Number(c) || 0))
    : []
  const teleopMissedCycles = Array.isArray(parsed.teleopMissedCycles)
    ? parsed.teleopMissedCycles.map((c: unknown) => Math.max(0, Number(c) || 0))
    : []
  const teleopCycleTimestamps = Array.isArray(parsed.teleopCycleTimestamps)
    ? parsed.teleopCycleTimestamps.map((ts: unknown) => Number(ts)).filter((ts: number) => Number.isFinite(ts) && ts > 0)
    : []
  const predictCycleTimeSec = typeof parsed.predictCycleTimeSec === 'number' && Number.isFinite(parsed.predictCycleTimeSec)
    ? parsed.predictCycleTimeSec
    : null

  return {
    autoLeave,
    autoBalls,
    autoPark,
    teleopCycles,
    teleopMissedCycles,
    teleopCycleTimestamps,
    predictCycleTimeSec,
    endgame: parseBiobuzzEndgame(parsed)
  }
}

/**
 * Calculates reliability rating ('low' | 'high') for each scout based on
 * historical deviation from official FTC match scores.
 */
export function calculateScoutReliability(
  records: ScoutingRecord[],
  officialMatches: OfficialMatch[]
): Record<string, 'low' | 'high'> {
  const matchAlliances: Record<string, { officialTotal: number; scouts: { scoutId: string; score: number }[] }> = {}

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

  for (const record of uniqueRecords.values()) {
    const rLevel = getRecordTournamentLevel(record)
    const match = officialMatches.find((m) => {
      if (m.matchNum !== record.matchNumber) return false
      const mLevel = (m.tournamentLevel || 'QUALIFICATION').toUpperCase()
      return mLevel === rLevel
    })
    if (!match || !match.scores) continue

    const team = match.teams.find((t) => t.teamNumber === record.teamNumber)
    if (!team) continue

    const alliance = team.alliance.toLowerCase() as 'red' | 'blue'
    const allianceScores = match.scores[alliance]
    if (!allianceScores) continue

    const matchKey = `${rLevel}-${record.matchNumber}-${alliance}`
    if (!matchAlliances[matchKey]) {
      matchAlliances[matchKey] = { officialTotal: allianceScores.totalPointsNp, scouts: [] }
    }
    matchAlliances[matchKey].scouts.push({ scoutId: record.scoutId, score: record.totalScore })
  }

  const scoutStats: Record<string, { totalDeviation: number; count: number }> = {}

  for (const data of Object.values(matchAlliances)) {
    if (data.scouts.length < 2) continue // single record or no records, skip

    const officialToCompare = data.officialTotal
    if (officialToCompare <= 0) continue // Skip matches with 0 official score to prevent huge deviation

    const scoutTotal = data.scouts.reduce((sum, s) => sum + s.score, 0)
    const deviation = Math.abs(scoutTotal - officialToCompare) / officialToCompare

    for (const s of data.scouts) {
      let stat = scoutStats[s.scoutId]
      if (!stat) {
        stat = { totalDeviation: 0, count: 0 }
        scoutStats[s.scoutId] = stat
      }
      stat.totalDeviation += deviation
      stat.count++
    }
  }

  const reliability: Record<string, 'low' | 'high'> = {}
  for (const [scoutId, stat] of Object.entries(scoutStats)) {
    reliability[scoutId] = stat.totalDeviation / stat.count > 0.3 ? 'low' : 'high'
  }
  return reliability
}

/**
 * Helper to extract total scored balls from a scouting record's rawData (2026 BIOBUZZ autoBalls + teleopCycles or legacy fields).
 */
export function getScoutedBalls(r: ScoutingRecord): number {
  const parsed = parseScoutRawData(r.rawData)
  const teleopBalls = parsed.teleopCycles.reduce((sum, c) => sum + c, 0)
  return parsed.autoBalls + teleopBalls
}

/**
 * Aggregates scouting records by team, applies reliability weighting,
 * allocates official match tips based on ball count ratios,
 * calculates trend arrows ('up' | 'down' | 'stable' | 'new'), and returns sorted rankings.
 * Note: Official penalties are currently ignored per 2026-2027 BIOBUZZ rules.
 */
export function calculateRankings(
  records: ScoutingRecord[],
  officialMatches: OfficialMatch[],
  scoutReliability: Record<string, 'low' | 'high'>,
  advancementMap?: Map<number, AdvancementDetail>
): RankingRow[] {
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

  const map = new Map<number, ScoutingRecord[]>()
  for (const r of uniqueRecords.values()) {
    if (r.isDeleted) continue
    let teamRecs = map.get(r.teamNumber)
    if (!teamRecs) {
      teamRecs = []
      map.set(r.teamNumber, teamRecs)
    }
    teamRecs.push(r)
  }

  const rows: RankingRow[] = []
  for (const [teamNumber, teamRecs] of map) {
    // Sort records by tournament level progression (QUALIFICATION first, then PLAYOFF) and matchNumber ascending
    const sortedRecs = teamRecs.slice().sort((a, b) => {
      const diffLevel = getTournamentLevelOrder(getRecordTournamentLevel(a)) - getTournamentLevelOrder(getRecordTournamentLevel(b))
      if (diffLevel !== 0) return diffLevel
      return a.matchNumber - b.matchNumber
    })
    const matchCount = sortedRecs.length

    let weightSum = 0
    let totalWeightedAuto = 0
    let totalWeightedTeleop = 0
    let totalWeightedEndgame = 0
    let totalWeightedScore = 0
    let totalWeightedTeleopPark = 0
    let totalWeightedMobilityRpPts = 0
    let totalWeightedFlowerNectars = 0
    let totalWeightedFlowerBottomBonus = 0
    let totalWeightedFlowerPollens = 0
    let totalWeightedGardenBalls = 0
    let totalWeightedDescore = 0
    let totalWeightedG410Foul = 0
    let totalAllocatedTips = 0
    let realMaxScore = 0
    const totalRealScoreForTrend: number[] = []
    const predictCycleInputs: Array<{ teleopCycles: number[]; teleopCycleTimestamps: number[]; isBroken?: boolean }> = []
    let brokenCount = 0

    for (const r of sortedRecs) {
      if (r.isBroken) {
        brokenCount++
        continue // Ignore broken matches in calculations
      }

      const weight = scoutReliability[r.scoutId] === 'low' ? 0.5 : 1.0
      weightSum += weight

      const parsedRaw = parseScoutRawData(r.rawData)
      const mobilityPts =
        (parsedRaw.autoLeave ? 3 : 0) +
        (parsedRaw.autoPark ? 5 : 0) +
        (parsedRaw.endgame.teleopPark ? 5 : 0)

      totalWeightedTeleopPark += (parsedRaw.endgame.teleopPark ? 1 : 0) * weight
      totalWeightedMobilityRpPts += mobilityPts * weight
      totalWeightedFlowerNectars += parsedRaw.endgame.flowerNectars * weight
      totalWeightedFlowerBottomBonus += parsedRaw.endgame.flowerBottomBonusCount * weight
      totalWeightedFlowerPollens += parsedRaw.endgame.flowerPollens * weight
      totalWeightedGardenBalls += parsedRaw.endgame.gardenBalls * weight
      totalWeightedDescore += (parsedRaw.endgame.flowerDescore ? 1 : 0) * weight
      totalWeightedG410Foul += (parsedRaw.endgame.g410EarlyFlowerFoul ? 1 : 0) * weight
      predictCycleInputs.push({
        teleopCycles: parsedRaw.teleopCycles,
        teleopCycleTimestamps: parsedRaw.teleopCycleTimestamps,
        isBroken: r.isBroken
      })

      // 官方判罚分目前忽略，纯粹聚焦战队自身得分能力
      const realTotalScore = r.totalScore
      const rLevel = getRecordTournamentLevel(r)
      const match = officialMatches.find((m) => {
        if (m.matchNum !== r.matchNumber) return false
        const mLevel = (m.tournamentLevel || 'QUALIFICATION').toUpperCase()
        return mLevel === rLevel
      })

      // Tips 比例分配计算：依据出球比例进行场均贡献分配
      let allocatedTips = 0
      if (match && match.scores && match.teams) {
        const teamInfo = match.teams.find((t) => t.teamNumber === r.teamNumber)
        if (teamInfo) {
          const alliance = teamInfo.alliance.toLowerCase() as 'red' | 'blue'
          const allianceScores = match.scores[alliance]
          const totalTips = allianceScores?.totalTips ?? 0
          if (totalTips > 0) {
            const myBalls = getScoutedBalls(r)
            const partnerTeams = match.teams.filter(
              (t) => t.alliance.toLowerCase() === alliance && t.teamNumber !== r.teamNumber
            )
            if (partnerTeams.length > 0) {
              let partnerBalls = 0
              let foundPartner = false
              for (const pt of partnerTeams) {
                const partnerRec = uniqueRecords.get(`${rLevel}-${r.matchNumber}-${pt.teamNumber}`)
                if (partnerRec && !partnerRec.isBroken) {
                  partnerBalls += getScoutedBalls(partnerRec)
                  foundPartner = true
                }
              }
              if (foundPartner && (myBalls + partnerBalls) > 0) {
                allocatedTips = totalTips * (myBalls / (myBalls + partnerBalls))
              } else {
                allocatedTips = totalTips * 0.5
              }
            } else {
              allocatedTips = totalTips * 0.5
            }
          }
        }
      }

      totalAllocatedTips += allocatedTips
      totalWeightedAuto += r.autoScore * weight
      totalWeightedTeleop += r.teleopScore * weight
      totalWeightedEndgame += r.endgameScore * weight
      totalWeightedScore += realTotalScore * weight
      totalRealScoreForTrend.push(realTotalScore)

      if (realTotalScore > realMaxScore) {
        realMaxScore = realTotalScore
      }
    }

    const effectiveWeight = weightSum || 1
    const avgAutoScore = totalWeightedAuto / effectiveWeight
    const avgTeleopScore = totalWeightedTeleop / effectiveWeight
    const avgEndgameScore = totalWeightedEndgame / effectiveWeight
    const avgRating = totalWeightedScore / effectiveWeight

    const validMatchesCount = totalRealScoreForTrend.length
    const avgTipsPerMatch = validMatchesCount > 0
      ? Math.round((totalAllocatedTips / validMatchesCount) * 10) / 10
      : 0

    let trend: 'up' | 'down' | 'stable' | 'new' = 'new'
    if (validMatchesCount > 1) {
      const lastMatchScore = totalRealScoreForTrend[validMatchesCount - 1]!
      const previousMatches = totalRealScoreForTrend.slice(0, validMatchesCount - 1)
      const previousAvg = previousMatches.reduce((s, r) => s + r, 0) / previousMatches.length

      if (lastMatchScore > previousAvg * 1.15) {
        trend = 'up'
      } else if (lastMatchScore < previousAvg * 0.85) {
        trend = 'down'
      } else {
        trend = 'stable'
      }
    } else if (validMatchesCount === 1) {
      trend = 'new'
    }

    const predictStats = aggregateTeamPredictCycleStats(predictCycleInputs)
    const adv = advancementMap ? advancementMap.get(teamNumber) : undefined

    rows.push({
      teamNumber,
      matchCount,
      advancementPoints: adv ? adv.totalAdvancementPoints : 0,
      advancementRank: adv ? adv.advancementRank : undefined,
      advancementStatus: adv ? adv.advancementStatus : 'NONE',
      advancementOfficialStatus: adv?.officialStatus,
      advancementDeclined: adv?.declined,
      advancementRolledDown: adv?.rolledDown,
      advancementSlot: adv?.advancementSlot,
      advancementCriteria: adv?.advancementCriteria,
      advancementAdvancesTo: adv?.advancesTo,
      advancementBreakdown: adv ? adv.breakdown : undefined,
      avgAutoScore: Math.round(avgAutoScore * 10) / 10,
      avgTeleopScore: Math.round(avgTeleopScore * 10) / 10,
      avgEndgameScore: Math.round(avgEndgameScore * 10) / 10,
      avgTipsPerMatch,
      maxScore: realMaxScore,
      avgRating: Math.round(avgRating * 10) / 10,
      brokenCount,
      trend,
      teleopParkRate: Math.round((totalWeightedTeleopPark / effectiveWeight) * 1000) / 1000,
      avgMobilityRpPts: Math.round((totalWeightedMobilityRpPts / effectiveWeight) * 10) / 10,
      avgFlowerNectars: Math.round((totalWeightedFlowerNectars / effectiveWeight) * 10) / 10,
      avgFlowerBottomBonus: Math.round((totalWeightedFlowerBottomBonus / effectiveWeight) * 10) / 10,
      avgFlowerPollens: Math.round((totalWeightedFlowerPollens / effectiveWeight) * 10) / 10,
      avgGardenBalls: Math.round((totalWeightedGardenBalls / effectiveWeight) * 10) / 10,
      descoreRate: Math.round((totalWeightedDescore / effectiveWeight) * 1000) / 1000,
      g410FoulRate: Math.round((totalWeightedG410Foul / effectiveWeight) * 1000) / 1000,
      predictCycleTime: predictStats.predictCycleTime,
      predictCycleMatches: predictStats.predictCycleMatches,
      predictCycleSpread: predictStats.predictCycleSpread,
      estimatedMaxCycles: predictStats.estimatedMaxCycles
    })
  }

  // 若传入了官方晋级数据，将尚未有记录的战队作为初始行加入列表
  if (advancementMap) {
    for (const [teamNum, adv] of advancementMap) {
      if (!map.has(teamNum)) {
        rows.push({
          teamNumber: teamNum,
          matchCount: 0,
          advancementPoints: adv.totalAdvancementPoints,
          advancementRank: adv.advancementRank,
          advancementStatus: adv.advancementStatus,
          advancementOfficialStatus: adv.officialStatus,
          advancementDeclined: adv.declined,
          advancementRolledDown: adv.rolledDown,
          advancementSlot: adv.advancementSlot,
          advancementCriteria: adv.advancementCriteria,
          advancementAdvancesTo: adv.advancesTo,
          advancementBreakdown: adv.breakdown,
          avgAutoScore: 0,
          avgTeleopScore: 0,
          avgEndgameScore: 0,
          maxScore: 0,
          avgRating: 0,
          brokenCount: 0,
          trend: 'new'
        })
      }
    }
  }

  const hasAdvancementData = rows.some(r => (r.advancementPoints ?? 0) > 0)
  if (hasAdvancementData) {
    rows.sort((a, b) => {
      const aPts = a.advancementPoints ?? 0
      const bPts = b.advancementPoints ?? 0
      if (aPts !== bPts) return bPts - aPts
      const aRank = a.advancementRank ?? 9999
      const bRank = b.advancementRank ?? 9999
      if (aRank !== bRank) return aRank - bRank
      if ((a.avgRating ?? 0) !== (b.avgRating ?? 0)) return (b.avgRating ?? 0) - (a.avgRating ?? 0)
      return a.teamNumber - b.teamNumber
    })
  } else {
    rows.sort((a, b) => b.avgRating - a.avgRating)
  }
  return rows
}
