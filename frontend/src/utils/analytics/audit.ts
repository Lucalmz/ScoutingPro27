import type { ScoutingRecord, OfficialMatch } from '@/types'
import { getRecordTournamentLevel } from '@/utils/tournament'
import { i18n } from '@/i18n'
import { parseScoutRawData } from './rankings'

export interface AllianceDiscrepancyDetail {
  alliance: 'red' | 'blue'
  officialScore: number
  scoutScore: number
  diff: number
  signedDiff: number
  ratio: number
  isComplete: boolean
  endgameSharedContestRisk?: boolean
  g410RiskCount?: number
  scouts: Array<{
    scoutId: string
    scoutName: string
    teamNumber: number
    score: number
  }>
}

export interface MatchDiscrepancy {
  matchNumber: number
  tournamentLevel?: string
  rank?: number
  isTop5: boolean
  hasWarning: boolean
  maxDiff: number
  maxRatio: number
  red?: AllianceDiscrepancyDetail
  blue?: AllianceDiscrepancyDetail
  summaryMessage: string
  endgameContestHint?: string
}

/**
 * Calculates discrepancy between scouter-recorded total scores and FTC official scores.
 * Returns matches sorted descending by absolute score discrepancy.
 */
export function calculateMatchDiscrepancies(
  records: ScoutingRecord[],
  officialMatches: OfficialMatch[]
): MatchDiscrepancy[] {
  if (!Array.isArray(records) || !Array.isArray(officialMatches)) return []

  // 1. Deduplicate records per (tournamentLevel, matchNumber, teamNumber) keeping the latest updated active record
  const uniqueMap = new Map<string, ScoutingRecord>()
  for (const r of records) {
    if (r.isDeleted) continue
    const level = getRecordTournamentLevel(r)
    const key = `${level}-${r.matchNumber}-${r.teamNumber}`
    const existing = uniqueMap.get(key)
    if (!existing || new Date(r.updatedAt || 0) >= new Date(existing.updatedAt || 0)) {
      uniqueMap.set(key, r)
    }
  }

  const results: MatchDiscrepancy[] = []

  // 2. Iterate through each official match that has score data
  for (const m of officialMatches) {
    if (!m || !m.matchNum || !m.scores) continue

    const matchNum = Number(m.matchNum)
    const mLevel = (m.tournamentLevel || 'QUALIFICATION').toUpperCase()
    let redDetail: AllianceDiscrepancyDetail | undefined
    let blueDetail: AllianceDiscrepancyDetail | undefined

    for (const color of ['red', 'blue'] as const) {
      const allianceScoreObj = m.scores[color]
      if (!allianceScoreObj) continue

      const officialScore = allianceScoreObj.totalPointsNp ?? (allianceScoreObj as { finalScore?: number }).finalScore ?? 0

      // Identify teams belonging to this alliance in this official match
      const allianceTeams = (m.teams || [])
        .filter((t) => (t.alliance || '').toLowerCase().startsWith(color))
        .map((t) => Number(t.teamNumber))

      // Gather our scouts' records for this alliance
      const allianceRecords: ScoutingRecord[] = []
      for (const tNum of allianceTeams) {
        const found = uniqueMap.get(`${mLevel}-${matchNum}-${tNum}`)
        if (found) allianceRecords.push(found)
      }

      // If at least one scout record exists for this alliance
      if (allianceRecords.length > 0) {
        const scoutScore = allianceRecords.reduce((sum, r) => sum + (Number(r.totalScore) || 0), 0)
        const diff = Math.abs(scoutScore - officialScore)
        const signedDiff = scoutScore - officialScore
        const ratio = officialScore > 0 ? diff / officialScore : (scoutScore > 0 ? 1 : 0)

        const parsedEndgames = allianceRecords.map((r) => parseScoutRawData(r.rawData).endgame)
        const hasSharedEndgameElements = parsedEndgames.some(
          (e) =>
            e.flowerNectars > 0 ||
            e.flowerBottomBonusCount > 0 ||
            e.flowerPollens > 0 ||
            e.gardenBalls > 0 ||
            e.flowerDescore
        )
        const g410RiskCount = parsedEndgames.filter((e) => e.g410EarlyFlowerFoul).length

        const detail: AllianceDiscrepancyDetail = {
          alliance: color,
          officialScore,
          scoutScore,
          diff,
          signedDiff,
          ratio,
          isComplete: allianceRecords.length >= Math.min(2, allianceTeams.length),
          endgameSharedContestRisk: diff > 0 && (hasSharedEndgameElements || g410RiskCount > 0),
          g410RiskCount,
          scouts: allianceRecords.map((r) => ({
            scoutId: r.scoutId || '',
            scoutName: r.scoutName || 'Scout',
            teamNumber: Number(r.teamNumber),
            score: Number(r.totalScore) || 0
          }))
        }

        if (color === 'red') redDetail = detail
        else blueDetail = detail
      }
    }

    if (redDetail || blueDetail) {
      const redDiff = redDetail ? redDetail.diff : 0
      const blueDiff = blueDetail ? blueDetail.diff : 0
      const maxDiff = Math.max(redDiff, blueDiff)

      const redRatio = redDetail ? redDetail.ratio : 0
      const blueRatio = blueDetail ? blueDetail.ratio : 0
      const maxRatio = Math.max(redRatio, blueRatio)

      // Warning threshold: diff >= 20 pts OR (deviation ratio >= 25% with diff >= 10 pts)
      const hasWarning = maxDiff >= 20 || (maxRatio >= 0.25 && maxDiff >= 10)

      const dominant = (redDiff >= blueDiff ? redDetail : blueDetail) || redDetail || blueDetail
      const isZh = (i18n?.global?.locale?.value || i18n?.global?.locale) === 'zh'
      const dominantName = dominant?.alliance === 'red'
        ? (isZh ? '红方' : 'Red Alliance')
        : (isZh ? '蓝方' : 'Blue Alliance')
      const signStr = (dominant?.signedDiff || 0) >= 0 ? `+${dominant?.signedDiff}` : `${dominant?.signedDiff}`
      const hasContestRisk = Boolean(redDetail?.endgameSharedContestRisk || blueDetail?.endgameSharedContestRisk)
      const totalG410Risks = (redDetail?.g410RiskCount || 0) + (blueDetail?.g410RiskCount || 0)
      const endgameContestHint = hasContestRisk
        ? (isZh
            ? `Endgame 含共有 Flower 归属/Garden 残球${totalG410Risks > 0 ? '或 G410 判罚' : ''}差异可能`
            : `Possible Endgame shared Flower/Garden${totalG410Risks > 0 ? ' or G410 foul' : ''} variance`)
        : undefined
      const baseSummary = dominant
        ? (isZh
            ? `${dominantName}侦察总分 ${dominant.scoutScore}分 vs 官方 ${dominant.officialScore}分 (偏差 ${signStr}分, ${(dominant.ratio * 100).toFixed(0)}%)`
            : `${dominantName} Scouted ${dominant.scoutScore} vs Official ${dominant.officialScore} (Diff ${signStr} pts, ${(dominant.ratio * 100).toFixed(0)}%)`)
        : (isZh ? `差额 ±${maxDiff}分` : `Diff ±${maxDiff} pts`)
      const summaryMessage = endgameContestHint ? `${baseSummary} · ${endgameContestHint}` : baseSummary

      results.push({
        matchNumber: matchNum,
        tournamentLevel: m.tournamentLevel || 'QUALIFICATION',
        isTop5: false,
        hasWarning,
        maxDiff,
        maxRatio,
        red: redDetail,
        blue: blueDetail,
        summaryMessage,
        ...(endgameContestHint ? { endgameContestHint } : {})
      })
    }
  }

  // 3. Sort descending by score discrepancy (maxDiff)
  results.sort((a, b) => b.maxDiff - a.maxDiff || b.maxRatio - a.maxRatio || a.matchNumber - b.matchNumber)

  // 4. Assign rankings and isTop5 flag
  results.forEach((item, i) => {
    item.rank = i + 1
    if (i < 5 && item.maxDiff > 0) {
      item.isTop5 = true
      // All Top 5 matches with a discrepancy get flagged as warnings
      item.hasWarning = true
    }
  })

  return results
}
