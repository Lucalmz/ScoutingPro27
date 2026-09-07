import type { ScoutingRecord, OfficialMatch, RankingRow } from '@/types'

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
    const key = `${record.matchNumber}-${record.teamNumber}`
    const existing = uniqueRecords.get(key)
    if (!existing || new Date(record.updatedAt) > new Date(existing.updatedAt)) {
      uniqueRecords.set(key, record)
    }
  }

  for (const record of uniqueRecords.values()) {
    const match = officialMatches.find((m) => m.matchNum === record.matchNumber)
    if (!match || !match.scores) continue

    const team = match.teams.find((t) => t.teamNumber === record.teamNumber)
    if (!team) continue

    const alliance = team.alliance.toLowerCase() as 'red' | 'blue'
    const allianceScores = match.scores[alliance]
    if (!allianceScores) continue

    const matchKey = `${record.matchNumber}-${alliance}`
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
 * Aggregates scouting records by team, applies reliability weighting and penalty deductions,
 * calculates trend arrows ('up' | 'down' | 'stable' | 'new'), and returns sorted rankings.
 */
export function calculateRankings(
  records: ScoutingRecord[],
  officialMatches: OfficialMatch[],
  scoutReliability: Record<string, 'low' | 'high'>
): RankingRow[] {
  const map = new Map<number, ScoutingRecord[]>()
  for (const r of records) {
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
    // Sort records by matchNumber ascending to find the true progression
    const sortedRecs = teamRecs.sort((a, b) => a.matchNumber - b.matchNumber)
    const matchCount = sortedRecs.length

    let weightSum = 0
    let totalWeightedAuto = 0
    let totalWeightedTeleop = 0
    let totalWeightedEndgame = 0
    let totalWeightedScore = 0
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

      let realTotalScore = r.totalScore
      const match = officialMatches.find((m) => m.matchNum === r.matchNumber)
      if (match && match.scores) {
        const teamInfo = match.teams.find((t) => t.teamNumber === r.teamNumber)
        if (teamInfo) {
          const alliance = teamInfo.alliance.toLowerCase() as 'red' | 'blue'
          const allianceScores = match.scores[alliance]
          if (allianceScores) {
            realTotalScore = r.totalScore - allianceScores.penaltyPointsCommitted / 2
          }
        }
      }

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

    let trend: 'up' | 'down' | 'stable' | 'new' = 'new'
    const validCount = totalRealScoreForTrend.length
    if (validCount > 1) {
      const lastMatchScore = totalRealScoreForTrend[validCount - 1]!
      const previousMatches = totalRealScoreForTrend.slice(0, validCount - 1)
      const previousAvg = previousMatches.reduce((s, r) => s + r, 0) / previousMatches.length

      if (lastMatchScore > previousAvg * 1.15) {
        trend = 'up'
      } else if (lastMatchScore < previousAvg * 0.85) {
        trend = 'down'
      } else {
        trend = 'stable'
      }
    } else if (validCount === 1) {
      trend = 'new'
    }

    rows.push({
      teamNumber,
      matchCount,
      avgAutoScore: Math.round(avgAutoScore * 10) / 10,
      avgTeleopScore: Math.round(avgTeleopScore * 10) / 10,
      avgEndgameScore: Math.round(avgEndgameScore * 10) / 10,
      maxScore: realMaxScore,
      avgRating: Math.round(avgRating * 10) / 10,
      brokenCount,
      trend
    })
  }

  rows.sort((a, b) => b.avgRating - a.avgRating)
  return rows
}
