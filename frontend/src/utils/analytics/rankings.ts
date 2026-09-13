import type { ScoutingRecord, OfficialMatch, RankingRow } from '@/types'
import { getRecordTournamentLevel, getTournamentLevelOrder } from '@/utils/tournament'

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
  try {
    if (!r.rawData) return 0
    const parsed = typeof r.rawData === 'string' ? JSON.parse(r.rawData) : r.rawData
    const autoBalls = typeof parsed.autoBalls === 'number'
      ? parsed.autoBalls
      : ((parsed.autoPreload ? 1 : 0) + (parsed.autoSecondary ? 1 : 0))
    if (Array.isArray(parsed.teleopCycles)) {
      const teleopBalls = parsed.teleopCycles.reduce((sum: number, c: number) => sum + (Number(c) || 0), 0)
      return autoBalls + teleopBalls
    }
    return autoBalls
  } catch {
    return 0
  }
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
  scoutReliability: Record<string, 'low' | 'high'>
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
    let totalAllocatedTips = 0
    let realMaxScore = 0
    const totalRealScoreForTrend: number[] = []
    let brokenCount = 0

    for (const r of sortedRecs) {
      if (r.isBroken) {
        brokenCount++
        continue // Ignore broken matches in calculations
      }

      const weight = scoutReliability[r.scoutId] === 'low' ? 0.5 : 1.0
      weightSum += weight

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

    rows.push({
      teamNumber,
      matchCount,
      avgAutoScore: Math.round(avgAutoScore * 10) / 10,
      avgTeleopScore: Math.round(avgTeleopScore * 10) / 10,
      avgEndgameScore: Math.round(avgEndgameScore * 10) / 10,
      avgTipsPerMatch,
      maxScore: realMaxScore,
      avgRating: Math.round(avgRating * 10) / 10,
      brokenCount,
      trend
    })
  }

  rows.sort((a, b) => b.avgRating - a.avgRating)
  return rows
}
