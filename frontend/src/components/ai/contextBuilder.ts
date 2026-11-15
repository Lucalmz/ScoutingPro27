import type { ScoutingRecord, RankingRow, ScoutingEvent, TeamTagItem, PitScoutingRecord } from '@/types'
import { calculateBragIndex } from '@/utils/bragIndex'
import { parseScoutRawData } from '@/utils/analytics/rankings'
import { calcMatchPredictCycleTime } from '@/utils/analytics/predictCycleTime'
import { getRecordTournamentLevel, getTournamentLevelOrder } from '@/utils/tournament'

export interface ContextOptions {
  event?: ScoutingEvent | null
  rankings: RankingRow[]
  records: ScoutingRecord[]
  bannedTeams?: number[]
  tags?: TeamTagItem[]
  pitRecords?: PitScoutingRecord[]
}

/**
 * Cleanly formats preset or custom tags for AI prompt consumption
 */
function formatTagForPrompt(tag: TeamTagItem): string {
  return tag.tag
}

/**
 * Builds a structured, compact text snapshot of the entire event's scouting data
 * for consumption by LLMs (DeepSeek, Gemini, OpenAI, etc.).
 */
export function buildEventDataContext(options: ContextOptions): string {
  const { event, rankings, records, bannedTeams, tags, pitRecords } = options
  const activeRecords = records.filter(r => !r.isDeleted)
  const activePitRecords = (pitRecords || []).filter(p => !p.isDeleted)

  if (activeRecords.length === 0 && rankings.length === 0 && (!tags || tags.length === 0) && activePitRecords.length === 0) {
    return '[Current Event Data: No scouting records or match data have been recorded yet.]'
  }

  const lines: string[] = []
  lines.push('=== CURRENT FTC EVENT SCOUTING DATA ===')
  if (event) {
    lines.push(`Event Name: ${event.name}`)
    if (event.ftcEventCode) {
      lines.push(`Event Code: ${event.ftcEventCode} (Year: ${event.ftcYear || 'N/A'})`)
    }
  }
  lines.push(`Total Active Records: ${activeRecords.length} | Total Tracked Teams: ${rankings.length}${activePitRecords.length > 0 ? ` | Pit Profiles: ${activePitRecords.length}` : ''}`)

  if (bannedTeams && bannedTeams.length > 0) {
    lines.push(`Banned / Marked Weak Teams: ${bannedTeams.join(', ')}`)
  }

  // 1. Rankings & Aggregated Performance Summary
  if (rankings.length > 0) {
    lines.push('\n[Teams Overall Rankings & Aggregated Performance Summary]')
    const hasTips = rankings.some(r => r.avgTipsPerMatch !== undefined && r.avgTipsPerMatch > 0)
    const hasBiobuzzStats = rankings.some(
      r =>
        r.teleopParkRate !== undefined ||
        r.avgMobilityRpPts !== undefined ||
        r.avgFlowerNectars !== undefined ||
        r.predictCycleTime !== undefined
    )
    const headerParts = ['Team', 'Matches', 'Avg Auto', 'Avg TeleOp', 'Avg Endgame']
    if (hasTips) headerParts.push('Avg Tips')
    headerParts.push('Overall Avg', 'Max Score', 'Broken Matches', 'Trend')
    if (hasBiobuzzStats) {
      headerParts.push(
        'TeleOp Park %',
        'Mobility RP (/13)',
        'BIOBUZZ Endgame (N/B/P/G)',
        'G410 %',
        'Predict Cycle',
        'Est. Max Cycles'
      )
    }
    lines.push(headerParts.join(' | '))
    lines.push(headerParts.map(() => '---').join('|'))

    for (const r of rankings) {
      const rowParts: Array<string | number> = [
        r.teamNumber,
        r.matchCount,
        r.avgAutoScore,
        r.avgTeleopScore,
        r.avgEndgameScore
      ]
      if (hasTips) rowParts.push(r.avgTipsPerMatch ?? 0)
      rowParts.push(r.avgRating, r.maxScore, r.brokenCount, r.trend)
      if (hasBiobuzzStats) {
        const parkPct = `${Math.round((r.teleopParkRate ?? 0) * 100)}%`
        const mobilityRp = r.avgMobilityRpPts ?? 0
        const flowerSummary = `N:${r.avgFlowerNectars ?? 0} B:${r.avgFlowerBottomBonus ?? 0} P:${r.avgFlowerPollens ?? 0} G:${r.avgGardenBalls ?? 0}`
        const g410Pct = `${Math.round((r.g410FoulRate ?? 0) * 100)}%`
        const predictCycleStr =
          r.predictCycleTime != null
            ? `${r.predictCycleTime.toFixed(1)}s (${r.predictCycleMatches ?? 0}m)`
            : 'Insufficient'
        const estMaxCyclesStr = r.estimatedMaxCycles != null ? r.estimatedMaxCycles : '-'
        rowParts.push(parkPct, mobilityRp, flowerSummary, g410Pct, predictCycleStr, estMaxCyclesStr)
      }
      lines.push(rowParts.join(' | '))
    }
  }

  // 2. Scouter Tactical Observation Tags (Subjective Reference - V11, V18, V19, V20, V29)
  if (tags && tags.length > 0) {
    const tagLines: string[] = []
    tagLines.push('\n[Scouter Tactical Observation Tags (Subjective Field Notes - Cross-Validate with Match Stats)]')
    
    // Group tags by teamNumber
    const teamMap = new Map<number, string[]>()
    for (const t of tags) {
      const formatted = formatTagForPrompt(t)
      const list = teamMap.get(t.teamNumber) || []
      list.push(formatted)
      teamMap.set(t.teamNumber, list)
    }

    const sortedTeams = Array.from(teamMap.keys()).sort((a, b) => a - b)
    let tagsTotalChars = 0
    const MAX_TAG_CHARS = 1500
    let isTruncated = false

    for (const teamNum of sortedTeams) {
      const tagList = teamMap.get(teamNum) || []
      const teamLine = `Team ${teamNum}: ${tagList.join(', ')}`
      
      // Check length limit at line boundary (V29)
      if (tagsTotalChars + teamLine.length + 1 > MAX_TAG_CHARS) {
        isTruncated = true
        break
      }

      tagLines.push(teamLine)
      tagsTotalChars += teamLine.length + 1
    }

    if (isTruncated) {
      tagLines.push('[... Remaining team observation tags truncated for length limits ...]')
    }

    if (tagLines.length > 1) {
      lines.push(tagLines.join('\n'))
    }
  }

  // 3. Pit Scouting & Robot Hardware Profiles (Self-Reported Specs & Brag Audit)
  if (activePitRecords.length > 0) {
    lines.push('\n[Pit Scouting & Robot Hardware Profiles (Self-Reported Specs & Brag Audit)]')
    lines.push('Team # | Drivetrain | Ball Compat | Launcher | Flower Mech | Sensor | Odom | Claimed Auto | Claimed TeleOp | Claimed Endgame | Claimed Total | Brag Index (Audit) | Chassis Size')
    lines.push('---|---|---|---|---|---|---|---|---|---|---|---|---')
    const sortedPits = [...activePitRecords].sort((a, b) => a.teamNumber - b.teamNumber)
    for (const pit of sortedPits) {
      const teamMatches = activeRecords.filter(r => r.teamNumber === pit.teamNumber)
      const brag = calculateBragIndex(pit, teamMatches)
      const drivetrain = pit.drivetrainType || 'N/A'
      const chassisSize = pit.chassisSize || 'N/A'
      const odom = pit.odometryType || 'N/A'
      const totalStr = `${pit.claimedTotalScore} pts`

      let bragStr = 'Pending'
      if (brag) {
        if (brag.tier === 'pending') {
          bragStr = 'Pending (No Matches)'
        } else {
          const notices: string[] = []
          if (brag.flowerVerified || brag.endgameVerified || brag.hangVerified) {
            notices.push('Flower Verified')
          } else if (brag.flowerPending || brag.endgamePardoned || brag.hangPardoned) {
            notices.push('Flower Pending Verification')
          }
          if (brag.parkVerified) {
            notices.push('Park Verified')
          } else if (brag.parkPending) {
            notices.push('Park Unstable')
          }
          const bragNoticeStr = notices.length > 0 ? `, ${notices.join(', ')}` : ''
          bragStr = `${brag.overallRatio}x (${brag.tier}${bragNoticeStr})`
        }
      }

      const ballCompat = pit.ballCompatibility || 'N/A'
      const launcher = pit.launcherType || 'N/A'
      const flower = pit.flowerMechanism || 'N/A'
      const sensor = pit.hasColorSensor ? 'Yes' : 'No'
      const autoStr = pit.claimedAutoStrategy
        ? `${pit.claimedAutoScore} pts (${pit.claimedAutoStrategy})`
        : `${pit.claimedAutoScore} pts`
      const teleopStr = pit.claimedTeleopCycles != null
        ? `${pit.claimedTeleopScore} pts (${pit.claimedTeleopCycles} cycles)`
        : `${pit.claimedTeleopScore} pts`
      const endgameStr = `${pit.claimedEndgameScore ?? 0} pts`
      lines.push(`${pit.teamNumber} | ${drivetrain} | ${ballCompat} | ${launcher} | ${flower} | ${sensor} | ${odom} | ${autoStr} | ${teleopStr} | ${endgameStr} | ${totalStr} | ${bragStr} | ${chassisSize}`)
    }
  }

  // 4. Detailed Match Records
  if (activeRecords.length > 0) {
    lines.push('\n[Detailed Match Scouting Records]')
    lines.push('Match # | Team # | Scouter | Total Score | Auto | TeleOp | Endgame | Broken | Notes | Endgame Details | Predict Cycle')
    lines.push('---|---|---|---|---|---|---|---|---|---|---')
    // Sort chronologically by tournament level progression (QUALIFICATION first, then PLAYOFF), then matchNumber and teamNumber
    const sorted = [...activeRecords].sort((a, b) => {
      const diffLevel = getTournamentLevelOrder(getRecordTournamentLevel(a)) - getTournamentLevelOrder(getRecordTournamentLevel(b))
      if (diffLevel !== 0) return diffLevel
      return a.matchNumber - b.matchNumber || a.teamNumber - b.teamNumber
    })
    for (const rec of sorted) {
      const cleanNotes = (rec.notes || '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ').trim() || '-'
      const brokenStr = rec.isBroken ? 'YES (Broken)' : 'NO'
      const level = getRecordTournamentLevel(rec)
      const matchLabel = level === 'PLAYOFF' ? `Playoff Match ${rec.matchNumber}` : `Match ${rec.matchNumber}`

      const parsed = parseScoutRawData(rec.rawData)
      const detailTokens: string[] = []
      if (parsed.autoPark) detailTokens.push('AutoPark')
      if (parsed.endgame.teleopPark) detailTokens.push('EndPark')
      if (parsed.endgame.flowerNectars > 0) detailTokens.push(`N:${parsed.endgame.flowerNectars}`)
      if (parsed.endgame.flowerBottomBonusCount > 0) detailTokens.push(`B:${parsed.endgame.flowerBottomBonusCount}`)
      if (parsed.endgame.flowerPollens > 0) detailTokens.push(`P:${parsed.endgame.flowerPollens}`)
      if (parsed.endgame.gardenBalls > 0) detailTokens.push(`G:${parsed.endgame.gardenBalls}`)
      if (parsed.endgame.flowerDescore) detailTokens.push('Descore')
      if (parsed.endgame.g410EarlyFlowerFoul) detailTokens.push('G410!')
      const endgameDetailsStr = detailTokens.length > 0 ? detailTokens.join(' ') : '-'

      const matchPredictCycle =
        parsed.predictCycleTimeSec ??
        calcMatchPredictCycleTime(parsed.teleopCycles, parsed.teleopCycleTimestamps)
      const predictCycleStr = matchPredictCycle !== null ? `${matchPredictCycle.toFixed(1)}s` : '-'

      lines.push(`${matchLabel} | Team ${rec.teamNumber} | ${rec.scoutName || 'Scout'} | ${rec.totalScore} | ${rec.autoScore} | ${rec.teleopScore} | ${rec.endgameScore} | ${brokenStr} | ${cleanNotes} | ${endgameDetailsStr} | ${predictCycleStr}`)
    }
  }

  lines.push('=== END OF EVENT DATA ===')
  return lines.join('\n')
}
