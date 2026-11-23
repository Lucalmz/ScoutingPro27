import type {
  ScoutingRecord,
  RankingRow,
  ScoutingEvent,
  TeamTagItem,
  PitScoutingRecord,
  MatchScheduleItem,
  CustomFieldDefinition,
  AiContextSections,
  AiContextFocusMatch
} from '@/types'
import { calculateBragIndex } from '@/utils/bragIndex'
import { parseScoutRawData } from '@/utils/analytics/rankings'
import { calcMatchPredictCycleTime } from '@/utils/analytics/predictCycleTime'
import { getRecordTournamentLevel, getTournamentLevelOrder } from '@/utils/tournament'
import { computeTeamMatchCustomMetrics } from '@/views/composables/useTeamCustomMetrics'

export interface ContextOptions {
  event?: ScoutingEvent | null
  rankings: RankingRow[]
  records: ScoutingRecord[]
  bannedTeams?: number[]
  tags?: TeamTagItem[]
  pitRecords?: PitScoutingRecord[]
  schedules?: MatchScheduleItem[]
  customFields?: CustomFieldDefinition[]
  myTeamNumber?: number | null
  focusTeams?: number[]
  focusMatch?: AiContextFocusMatch | null
  sections?: Partial<AiContextSections>
  maxCharsBudget?: number
}

export interface ContextPreviewStats {
  text: string
  estimatedTokens: number
  chars: number
  activeRecordsCount: number
  trackedTeamsCount: number
  pitCount: number
  scheduleCount: number
  focusTeamsCount: number
  truncatedMatchesCount: number
}

const DEFAULT_MAX_CHARS_BUDGET = 28000

function formatTagForPrompt(tag: TeamTagItem): string {
  return tag.tag
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0
  let cjkChars = 0
  let otherChars = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjkChars++
    } else {
      otherChars++
    }
  }
  return Math.ceil(cjkChars * 1.2 + otherChars / 3.4)
}

function buildMatchLine(rec: ScoutingRecord): string {
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

  return `${matchLabel} | Team ${rec.teamNumber} | ${rec.scoutName || 'Scout'} | ${rec.totalScore} | ${rec.autoScore} | ${rec.teleopScore} | ${rec.endgameScore} | ${brokenStr} | ${cleanNotes} | ${endgameDetailsStr} | ${predictCycleStr}`
}

function appendFocusSection(
  lines: string[],
  myTeamNumber: number | null | undefined,
  focusSet: Set<number>,
  focusMatch: AiContextFocusMatch | null | undefined
): void {
  if (!myTeamNumber && focusSet.size === 0 && !focusMatch) return
  const focusParts: string[] = []
  if (myTeamNumber) focusParts.push(`My Team: #${myTeamNumber}`)
  if (focusSet.size > 0) focusParts.push(`Focused Teams: ${Array.from(focusSet).map(t => `#${t}`).join(', ')}`)
  if (focusMatch) {
    const lvl = (focusMatch.tournamentLevel || '').toUpperCase() === 'PLAYOFF' ? 'Playoff' : 'Qual'
    focusParts.push(`Focused Match: ${lvl} Match ${focusMatch.matchNumber}`)
  }
  lines.push(`\n[Perspective & Focus]\n${focusParts.join(' | ')}`)
}

function appendRankingsSection(lines: string[], rankings: RankingRow[]): void {
  if (rankings.length === 0) return
  lines.push('\n[Teams Overall Rankings & Aggregated Performance Summary]')
  const hasTips = rankings.some(r => r.avgTipsPerMatch !== undefined && r.avgTipsPerMatch > 0)
  const hasBiobuzzStats = rankings.some(
    r =>
      r.teleopParkRate !== undefined ||
      r.avgMobilityRpPts !== undefined ||
      r.avgFlowerNectars !== undefined ||
      r.predictCycleTime !== undefined
  )
  const hasSpreadOrDescore = rankings.some(
    r => r.predictCycleSpread != null || (r.descoreRate != null && r.descoreRate > 0)
  )
  const hasAdvancement = rankings.some(
    r => (r.advancementPoints ?? 0) > 0 || (r.advancementStatus != null && r.advancementStatus !== 'NONE')
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
  if (hasSpreadOrDescore) headerParts.push('Cycle Spread', 'Descore %')
  if (hasAdvancement) headerParts.push('Advancement Pts', 'Advancement Status')

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
    if (hasSpreadOrDescore) {
      rowParts.push(
        r.predictCycleSpread != null ? `${r.predictCycleSpread.toFixed(1)}s` : '-',
        `${Math.round((r.descoreRate ?? 0) * 100)}%`
      )
    }
    if (hasAdvancement) {
      const advStatus = r.advancementStatus || '-'
      rowParts.push(
        r.advancementPoints ?? 0,
        r.advancementRolledDown ? `${advStatus} (Rolled Down)` : advStatus
      )
    }
    lines.push(rowParts.join(' | '))
  }
}

function appendScheduleSection(
  lines: string[],
  scheduleList: MatchScheduleItem[],
  myTeamNumber: number | null | undefined,
  focusSet: Set<number>,
  focusMatch: AiContextFocusMatch | null | undefined
): void {
  if (scheduleList.length === 0) return
  const sortedSched = [...scheduleList].sort((a, b) => {
    const ordDiff = getTournamentLevelOrder(a.tournamentLevel) - getTournamentLevelOrder(b.tournamentLevel)
    return ordDiff !== 0 ? ordDiff : a.matchNumber - b.matchNumber
  })

  const isRelevantSchedule = (m: MatchScheduleItem) => {
    if (focusMatch && m.matchNumber === focusMatch.matchNumber) {
      const ml = (m.tournamentLevel || 'QUALIFICATION').toUpperCase()
      const fl = (focusMatch.tournamentLevel || ml).toUpperCase()
      if (ml === fl) return true
    }
    const teams = [m.red1, m.red2, m.blue1, m.blue2]
    if (myTeamNumber && teams.includes(myTeamNumber)) return true
    return teams.some(t => focusSet.has(t))
  }

  const prioritized = sortedSched.filter(isRelevantSchedule)
  const rest = sortedSched.filter(m => !isRelevantSchedule(m))
  const selectedSched = [...prioritized, ...rest.slice(0, Math.max(0, 32 - prioritized.length))]
    .sort((a, b) => {
      const ordDiff = getTournamentLevelOrder(a.tournamentLevel) - getTournamentLevelOrder(b.tournamentLevel)
      return ordDiff !== 0 ? ordDiff : a.matchNumber - b.matchNumber
    })

  lines.push('\n[Match Schedule]')
  lines.push('Match | Red Alliance | Blue Alliance | Official Score')
  lines.push('---|---|---|---')
  for (const m of selectedSched) {
    const prefix = (m.tournamentLevel || '').toUpperCase() === 'PLAYOFF' ? 'P' : 'Q'
    const scoreStr =
      m.scoreRedFinal != null && m.scoreBlueFinal != null
        ? `${m.scoreRedFinal} - ${m.scoreBlueFinal}`
        : 'Upcoming'
    lines.push(`${prefix}${m.matchNumber} | #${m.red1}, #${m.red2} | #${m.blue1}, #${m.blue2} | ${scoreStr}`)
  }
  if (sortedSched.length > selectedSched.length) {
    lines.push(`[... ${sortedSched.length - selectedSched.length} other non-focus scheduled matches omitted ...]`)
  }
}

function appendTagsSection(lines: string[], tags: TeamTagItem[] | undefined): void {
  if (!tags || tags.length === 0) return
  const tagLines: string[] = [
    '\n[Scouter Tactical Observation Tags (Subjective Field Notes - Cross-Validate with Match Stats)]'
  ]

  const teamMap = new Map<number, string[]>()
  for (const t of tags) {
    const list = teamMap.get(t.teamNumber) || []
    list.push(formatTagForPrompt(t))
    teamMap.set(t.teamNumber, list)
  }

  const sortedTeams = Array.from(teamMap.keys()).sort((a, b) => a - b)
  let tagsTotalChars = 0
  const MAX_TAG_CHARS = 1500
  let isTruncated = false

  for (const teamNum of sortedTeams) {
    const teamLine = `Team ${teamNum}: ${(teamMap.get(teamNum) || []).join(', ')}`
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

function appendPitSection(
  lines: string[],
  activePitRecords: PitScoutingRecord[],
  activeRecords: ScoutingRecord[]
): void {
  if (activePitRecords.length === 0) return
  const hasExtraHardwareNotes = activePitRecords.some(
    p => p.weightLbs > 0 || p.hasDescoreMech || p.hasApriltagVision || p.claimedTeleopPark
  )
  lines.push('\n[Pit Scouting & Robot Hardware Profiles (Self-Reported Specs & Brag Audit)]')
  lines.push(
    hasExtraHardwareNotes
      ? 'Team # | Drivetrain | Ball Compat | Launcher | Flower Mech | Sensor | Odom | Claimed Auto | Claimed TeleOp | Claimed Endgame | Claimed Total | Brag Index (Audit) | Chassis Size | Weight & Capabilities'
      : 'Team # | Drivetrain | Ball Compat | Launcher | Flower Mech | Sensor | Odom | Claimed Auto | Claimed TeleOp | Claimed Endgame | Claimed Total | Brag Index (Audit) | Chassis Size'
  )
  lines.push(
    hasExtraHardwareNotes
      ? '---|---|---|---|---|---|---|---|---|---|---|---|---|---'
      : '---|---|---|---|---|---|---|---|---|---|---|---|---'
  )

  const sortedPits = [...activePitRecords].sort((a, b) => a.teamNumber - b.teamNumber)
  for (const pit of sortedPits) {
    const teamMatches = activeRecords.filter(r => r.teamNumber === pit.teamNumber)
    const brag = calculateBragIndex(pit, teamMatches)

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

    const autoStr = pit.claimedAutoStrategy
      ? `${pit.claimedAutoScore} pts (${pit.claimedAutoStrategy})`
      : `${pit.claimedAutoScore} pts`
    const teleopStr = pit.claimedTeleopCycles != null
      ? `${pit.claimedTeleopScore} pts (${pit.claimedTeleopCycles} cycles)`
      : `${pit.claimedTeleopScore} pts`
    const baseRow = [
      pit.teamNumber,
      pit.drivetrainType || 'N/A',
      pit.ballCompatibility || 'N/A',
      pit.launcherType || 'N/A',
      pit.flowerMechanism || 'N/A',
      pit.hasColorSensor ? 'Yes' : 'No',
      pit.odometryType || 'N/A',
      autoStr,
      teleopStr,
      `${pit.claimedEndgameScore ?? 0} pts`,
      `${pit.claimedTotalScore} pts`,
      bragStr,
      pit.chassisSize || 'N/A'
    ].join(' | ')

    if (hasExtraHardwareNotes) {
      const capTokens: string[] = []
      if (pit.weightLbs > 0) capTokens.push(`${pit.weightLbs}lbs`)
      if (pit.hasDescoreMech) capTokens.push('DescoreMech')
      if (pit.hasApriltagVision) capTokens.push('AprilTag')
      if (pit.claimedTeleopPark) capTokens.push('ClaimsTeleOpPark')
      lines.push(`${baseRow} | ${capTokens.length > 0 ? capTokens.join(', ') : '-'}`)
    } else {
      lines.push(baseRow)
    }
  }
}

function appendCustomMetricsSection(
  lines: string[],
  customFields: CustomFieldDefinition[] | undefined,
  activeRecords: ScoutingRecord[]
): void {
  const activeMatchFields = (customFields || []).filter(f => f.isActive && f.target === 'MATCH')
  if (activeMatchFields.length === 0 || activeRecords.length === 0) return

  const byTeam = new Map<number, ScoutingRecord[]>()
  for (const r of activeRecords) {
    const list = byTeam.get(r.teamNumber) || []
    list.push(r)
    byTeam.set(r.teamNumber, list)
  }

  const customLines: string[] = []
  for (const teamNum of Array.from(byTeam.keys()).sort((a, b) => a - b)) {
    const summaries = computeTeamMatchCustomMetrics(activeMatchFields, byTeam.get(teamNum)!)
    if (summaries.length === 0) continue
    const tokens: string[] = []
    for (const s of summaries) {
      if (s.fieldType === 'boolean' && s.rate != null) {
        tokens.push(`${s.definition.name}: ${Math.round(s.rate)}%`)
      } else if (s.avg != null) {
        tokens.push(`${s.definition.name}: ${s.avg.toFixed(1)}${s.definition.unit || ''}`)
      }
    }
    if (tokens.length > 0) {
      customLines.push(`Team ${teamNum}: ${tokens.join(' · ')}`)
    }
  }

  if (customLines.length > 0) {
    lines.push('\n[Custom Metrics]')
    lines.push(...customLines)
  }
}

function appendBudgetedMatchesSection(
  lines: string[],
  activeRecords: ScoutingRecord[],
  myTeamNumber: number | null | undefined,
  focusSet: Set<number>,
  focusMatch: AiContextFocusMatch | null | undefined,
  maxCharsBudget: number
): number {
  if (activeRecords.length === 0) return 0
  const sorted = [...activeRecords].sort((a, b) => {
    const diffLevel = getTournamentLevelOrder(getRecordTournamentLevel(a)) - getTournamentLevelOrder(getRecordTournamentLevel(b))
    if (diffLevel !== 0) return diffLevel
    return a.matchNumber - b.matchNumber || a.teamNumber - b.teamNumber
  })

  const isFocusedRecord = (rec: ScoutingRecord) => {
    if (focusSet.has(rec.teamNumber) || (myTeamNumber && rec.teamNumber === myTeamNumber)) {
      return true
    }
    if (focusMatch && rec.matchNumber === focusMatch.matchNumber) {
      const rl = getRecordTournamentLevel(rec).toUpperCase()
      const fl = (focusMatch.tournamentLevel || rl).toUpperCase()
      if (rl === fl) return true
    }
    return false
  }

  const baseChars = lines.join('\n').length + 140
  let remainingChars = Math.max(2000, maxCharsBudget - baseChars)
  const focusedIndices = new Set<number>()
  const builtLines = sorted.map(buildMatchLine)

  for (let i = 0; i < sorted.length; i++) {
    if (isFocusedRecord(sorted[i]!)) {
      focusedIndices.add(i)
      remainingChars -= builtLines[i]!.length + 1
    }
  }

  let truncatedMatchesCount = 0
  const selectedIndices = new Set<number>(focusedIndices)
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (selectedIndices.has(i)) continue
    const len = builtLines[i]!.length + 1
    if (remainingChars - len < 0) {
      truncatedMatchesCount++
      continue
    }
    remainingChars -= len
    selectedIndices.add(i)
  }

  lines.push('\n[Detailed Match Scouting Records]')
  lines.push('Match # | Team # | Scouter | Total Score | Auto | TeleOp | Endgame | Broken | Notes | Endgame Details | Predict Cycle')
  lines.push('---|---|---|---|---|---|---|---|---|---|---')
  for (let i = 0; i < sorted.length; i++) {
    if (selectedIndices.has(i)) {
      lines.push(builtLines[i]!)
    }
  }
  if (truncatedMatchesCount > 0) {
    lines.push(`[... ${truncatedMatchesCount} earlier non-focus match records omitted to stay within ~${maxCharsBudget} chars context budget ...]`)
  }
  return truncatedMatchesCount
}

function buildContextInternal(options: ContextOptions): {
  text: string
  truncatedMatchesCount: number
  activeRecordsCount: number
  trackedTeamsCount: number
  pitCount: number
  scheduleCount: number
} {
  const {
    event,
    rankings,
    records,
    bannedTeams,
    tags,
    pitRecords,
    schedules,
    customFields,
    myTeamNumber,
    focusTeams,
    focusMatch,
    sections,
    maxCharsBudget = DEFAULT_MAX_CHARS_BUDGET
  } = options

  const secRankings = sections?.rankings !== false
  const secSchedule = sections?.schedule !== false
  const secPit = sections?.pit !== false
  const secMatches = sections?.matches !== false
  const secTags = sections?.tags !== false

  const activeRecords = records.filter(r => !r.isDeleted)
  const activePitRecords = (pitRecords || []).filter(p => !p.isDeleted)
  const scheduleList = schedules || []
  const focusSet = new Set<number>((focusTeams || []).map(Number).filter(n => !isNaN(n) && n > 0))

  if (
    activeRecords.length === 0 &&
    rankings.length === 0 &&
    (!tags || tags.length === 0) &&
    activePitRecords.length === 0 &&
    scheduleList.length === 0
  ) {
    return {
      text: '[Current Event Data: No scouting records or match data have been recorded yet.]',
      truncatedMatchesCount: 0,
      activeRecordsCount: 0,
      trackedTeamsCount: 0,
      pitCount: 0,
      scheduleCount: 0
    }
  }

  const lines: string[] = ['=== CURRENT FTC EVENT SCOUTING DATA ===']
  if (event) {
    lines.push(`Event Name: ${event.name}`)
    if (event.ftcEventCode) {
      lines.push(`Event Code: ${event.ftcEventCode} (Year: ${event.ftcYear || 'N/A'})`)
    }
  }
  lines.push(
    `Total Active Records: ${activeRecords.length} | Total Tracked Teams: ${rankings.length}` +
      `${activePitRecords.length > 0 ? ` | Pit Profiles: ${activePitRecords.length}` : ''}` +
      `${scheduleList.length > 0 ? ` | Scheduled Matches: ${scheduleList.length}` : ''}`
  )

  appendFocusSection(lines, myTeamNumber, focusSet, focusMatch)
  if (bannedTeams && bannedTeams.length > 0) {
    lines.push(`Banned / Marked Weak Teams: ${bannedTeams.join(', ')}`)
  }
  if (secRankings) appendRankingsSection(lines, rankings)
  if (secSchedule) appendScheduleSection(lines, scheduleList, myTeamNumber, focusSet, focusMatch)
  if (secTags) appendTagsSection(lines, tags)
  if (secPit) appendPitSection(lines, activePitRecords, activeRecords)
  if (secRankings) appendCustomMetricsSection(lines, customFields, activeRecords)

  const truncatedMatchesCount = secMatches
    ? appendBudgetedMatchesSection(lines, activeRecords, myTeamNumber, focusSet, focusMatch, maxCharsBudget)
    : 0

  lines.push('=== END OF EVENT DATA ===')
  return {
    text: lines.join('\n'),
    truncatedMatchesCount,
    activeRecordsCount: activeRecords.length,
    trackedTeamsCount: rankings.length,
    pitCount: activePitRecords.length,
    scheduleCount: scheduleList.length
  }
}

export function buildContextPreviewStats(options: ContextOptions): ContextPreviewStats {
  const res = buildContextInternal(options)
  return {
    text: res.text,
    estimatedTokens: estimateTokenCount(res.text),
    chars: res.text.length,
    activeRecordsCount: res.activeRecordsCount,
    trackedTeamsCount: res.trackedTeamsCount,
    pitCount: res.pitCount,
    scheduleCount: res.scheduleCount,
    focusTeamsCount: (options.focusTeams || []).length,
    truncatedMatchesCount: res.truncatedMatchesCount
  }
}

/**
 * Builds a structured, compact text snapshot of the entire event's scouting data
 * for consumption by OpenAI, Gemini, and Anthropic models.
 */
export function buildEventDataContext(options: ContextOptions): string {
  return buildContextInternal(options).text
}
