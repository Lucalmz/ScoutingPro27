import type { ScoutingRecord, RankingRow, ScoutingEvent, TeamTagItem } from '@/types'

export interface ContextOptions {
  event?: ScoutingEvent | null
  rankings: RankingRow[]
  records: ScoutingRecord[]
  bannedTeams?: number[]
  tags?: TeamTagItem[]
}

/**
 * Cleanly formats preset or custom tags for AI prompt consumption
 */
function formatTagForPrompt(tag: TeamTagItem): string {
  if (tag.isPreset || tag.tag.startsWith('preset.')) {
    return tag.tag.replace(/^preset\./, '').replace(/_/g, ' ')
  }
  return tag.tag
}

/**
 * Builds a structured, compact text snapshot of the entire event's scouting data
 * for consumption by LLMs (DeepSeek, Gemini, OpenAI, etc.).
 */
export function buildEventDataContext(options: ContextOptions): string {
  const { event, rankings, records, bannedTeams, tags } = options
  const activeRecords = records.filter(r => !r.isDeleted)

  if (activeRecords.length === 0 && rankings.length === 0 && (!tags || tags.length === 0)) {
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
  lines.push(`Total Active Records: ${activeRecords.length} | Total Tracked Teams: ${rankings.length}`)

  if (bannedTeams && bannedTeams.length > 0) {
    lines.push(`Banned / Marked Weak Teams: ${bannedTeams.join(', ')}`)
  }

  // 1. Rankings & Aggregated Performance Summary
  if (rankings.length > 0) {
    lines.push('\n[Teams Overall Rankings & Aggregated Performance Summary]')
    lines.push('Team | Matches | Avg Auto | Avg TeleOp | Avg Endgame | Overall Avg | Max Score | Broken Matches | Trend')
    lines.push('---|---|---|---|---|---|---|---|---')
    for (const r of rankings) {
      lines.push(`${r.teamNumber} | ${r.matchCount} | ${r.avgAutoScore} | ${r.avgTeleopScore} | ${r.avgEndgameScore} | ${r.avgRating} | ${r.maxScore} | ${r.brokenCount} | ${r.trend}`)
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

  // 3. Detailed Match Records
  if (activeRecords.length > 0) {
    lines.push('\n[Detailed Match Scouting Records]')
    lines.push('Match # | Team # | Scouter | Total Score | Auto | TeleOp | Endgame | Broken | Notes')
    lines.push('---|---|---|---|---|---|---|---|---')
    // Sort by matchNumber ascending, then teamNumber ascending
    const sorted = [...activeRecords].sort((a, b) => a.matchNumber - b.matchNumber || a.teamNumber - b.teamNumber)
    for (const rec of sorted) {
      const cleanNotes = (rec.notes || '').replace(/[\r\n]+/g, ' ').trim() || '-'
      const brokenStr = rec.isBroken ? 'YES (Broken)' : 'NO'
      lines.push(`Match ${rec.matchNumber} | Team ${rec.teamNumber} | ${rec.scoutName || 'Scout'} | ${rec.totalScore} | ${rec.autoScore} | ${rec.teleopScore} | ${rec.endgameScore} | ${brokenStr} | ${cleanNotes}`)
    }
  }

  lines.push('=== END OF EVENT DATA ===')
  return lines.join('\n')
}
