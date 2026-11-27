import type {
  AiTurboActionResult,
  CustomFieldAggregationMode,
  CustomFieldDisplayFormat,
  CustomFieldPhase,
  CustomFieldTarget,
  CustomFieldType,
  MatchScheduleItem,
  PitScoutingRecord,
  ScoutingFormData,
  ScoutingRecord,
  StationType,
  TeamTagItem,
  CustomFieldDefinition
} from '@/types'
import { isZhLocale } from '@/components/ai/constants'
import { calcBiobuzzEndgameScore, parseBiobuzzEndgame, parseScoutRawData } from '@/utils/analytics/rankings'
import { getRecordTournamentLevel, getTournamentLevelOrder } from '@/utils/tournament'
import { validateFormulaGraph } from '@/utils/formula'
import { useRecordStore } from '@/stores/records'
import { usePitScoutStore } from '@/stores/pitScout'
import { useScheduleStore } from '@/stores/schedule'
import { useCustomFieldsStore } from '@/stores/customFields'
import { useAiStore } from '@/stores/ai'

export interface TurboParsedAction {
  type: string
  [key: string]: any
}

export interface TurboSystemPromptParams {
  username: string
  userId: string
  isHost: boolean
  locale: string
}

export interface TurboSnapshotParams {
  userId: string
  records: ScoutingRecord[]
  customFields: CustomFieldDefinition[]
  schedules: MatchScheduleItem[]
  assignments: Record<string, { matchNumber: number; tournamentLevel?: string; station: StationType; teamNumber: number; scoutId?: string | null; scoutName?: string | null }>
  tags: TeamTagItem[]
  bannedTeams: number[]
}

export interface TurboExecutionParams {
  eventId: string
  actions: TurboParsedAction[]
  userId: string
  username: string
  isHost: boolean
  locale: string
}

const MAX_ACTIONS_PER_TURN = 20
const VALID_TAG_COLORS = new Set(['red', 'orange', 'green', 'blue', 'purple', 'gray', 'yellow'])
const VALID_DRIVETRAINS = new Set(['mecanum', 'tank', 'swerve', 'other'])
const VALID_BALL_COMPAT = new Set(['universal', 'sorting', 'pollen_only'])
const VALID_STATIONS = new Set<StationType>(['red1', 'red2', 'blue1', 'blue2'])
const VALID_TARGETS = new Set<CustomFieldTarget>(['MATCH', 'PIT', 'TEAM'])
const VALID_PHASES = new Set<CustomFieldPhase>(['auto', 'teleop', 'endgame', 'overall', 'hardware', 'strategy'])
const VALID_FIELD_TYPES = new Set<CustomFieldType>(['boolean', 'number', 'timer', 'level', 'select', 'multi_select', 'text', 'formula'])
const VALID_AGG_MODES = new Set<CustomFieldAggregationMode>(['avg', 'median', 'max', 'min', 'sum', 'last3', 'trimmed_avg', 'stddev', 'rate'])
const VALID_DISPLAY_FORMATS = new Set<CustomFieldDisplayFormat>(['number', 'integer', 'percent', 'boolean', 'tier'])

function clampInt(val: unknown, min: number, max: number): number {
  const n = Number(val)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.round(n)))
}

function toFiniteNumber(val: unknown, fallback = 0): number {
  const n = Number(val)
  return Number.isFinite(n) ? n : fallback
}

function sanitizeSnapshotText(raw: unknown, maxLen = 120): string {
  if (raw == null) return ''
  return String(raw)
    .replace(/```+/g, "'''")
    .replace(/={3,}/g, '---')
    .replace(/[\r\n\t|]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen)
}

export function buildTurboSystemPromptSection(params: TurboSystemPromptParams): string {
  const isZh = isZhLocale(params.locale)
  const roleLabel = params.isHost ? (isZh ? '赛事 Host（拥有全部数据管理权限）' : 'Event Host (full management permissions)') : (isZh ? '赛事成员 Scout（仅可修改本人记录与新增标签/展位数据）' : 'Event Member / Scout (can add tags, create pit/match records, edit/delete own records)')

  if (isZh) {
    return [
      '【⚡ TURBO 直接执行模式已开启】',
      `当前操作用户身份：${params.username || 'User'} (userId: ${params.userId || 'unknown'}) | 权限角色：${roleLabel}`,
      '当且仅当用户明确要求创建、修改、删除、打标、禁选、排班、设置我方队号或管理自定义字段时，你必须在回复末尾输出一个或多个 ```sp27-action 代码块（JSON 格式），前端将立即以该用户身份真实写入系统并同步给团队。',
      '如果用户只是在询问/分析数据而没有要求改动数据，请正常回答，不要输出 sp27-action 代码块。',
      '如果用户的要求超出其当前权限（例如非 Host 请求禁选队伍、排班或修改自定义字段/他人记录），请明确提示权限不足，不要伪造已执行成功。',
      '',
      '【sp27-action JSON 协议规范】',
      '格式示例：',
      '```sp27-action',
      '{"actions":[{"type":"add_tag","teamNumber":27570,"tag":"fast-cycle","color":"green"}]}',
      '```',
      '支持的 action type（最多 20 条/轮）：',
      '1. add_tag: {"type":"add_tag","teamNumber":27570,"tag":"标签名(不含点号.,1-30字符)","color":"red|orange|green|blue|purple|gray|yellow"}',
      '2. remove_tag: {"type":"remove_tag","teamNumber":27570,"tag":"标签名"} （仅创建者或 Host 可删）',
      '3. create_match_record: {"type":"create_match_record","matchNumber":5,"teamNumber":27570,"tournamentLevel":"QUALIFICATION|PLAYOFF","allianceColor":"red|blue","autoLeave":true,"autoBalls":2,"autoPark":false,"teleopCycles":[3,4],"teleopBalls":7,"teleopPark":true,"flowerNectars":2,"flowerBottomBonusCount":1,"flowerPollens":0,"gardenBalls":1,"flowerDescore":false,"g410EarlyFlowerFoul":false,"isBroken":false,"notes":"备注","customFields":{}}',
      '4. update_match_record: {"type":"update_match_record","recordId":"可选精确ID","matchNumber":5,"teamNumber":27570,"tournamentLevel":"QUALIFICATION","patch":{...任意上述字段或notes/isBroken/customFields...}} （仅作者本人或 Host）',
      '5. delete_match_record: {"type":"delete_match_record","recordId":"可选精确ID","matchNumber":5,"teamNumber":27570,"tournamentLevel":"QUALIFICATION"} （仅作者本人或 Host）',
      '6. upsert_pit_record: {"type":"upsert_pit_record","teamNumber":27570,"patch":{"robotName":"...","drivetrainType":"mecanum|tank|swerve|other","weightLbs":36,"chassisSize":"...","ballCompatibility":"universal|sorting|pollen_only","launcherType":"...","flowerMechanism":"...","hasColorSensor":true,"hasDescoreMech":false,"hasApriltagVision":false,"odometryType":"two_wheel","claimedAutoStrategy":"...","claimedAutoScore":25,"claimedTeleopCycles":6,"claimedTeleopScore":48,"claimedTeleopPark":true,"claimedFlowerNectars":2,"claimedFlowerBottomBonus":1,"claimedFlowerPollens":0,"claimedGardenBalls":0,"customFields":{}}}',
      '7. ban_team / unban_team: {"type":"ban_team","teamNumber":27570} 或 {"type":"unban_team","teamNumber":27570} （仅 Host）',
      '8. assign_scout: {"type":"assign_scout","matchNumber":5,"station":"red1|red2|blue1|blue2","tournamentLevel":"QUALIFICATION","scoutId":"可选或self","scoutName":"侦察员名(传null或空串清空)"} （仅 Host）',
      '9. set_my_team: {"type":"set_my_team","teamNumber":27570} （传入 null 清除）',
      '10. create_custom_field: {"type":"create_custom_field","name":"字段名","target":"MATCH|PIT|TEAM","fieldType":"boolean|number|timer|level|select|multi_select|text|formula","phase":"auto|teleop|endgame|overall|hardware|strategy","fieldKey":"可选小写下划线key","formulaExpr":"formula类型必填","unit":"","description":""} （仅 Host）',
      '11. update_custom_field: {"type":"update_custom_field","id":"可选ID","fieldKey":"可选key","patch":{...}} （仅 Host）',
      '12. delete_custom_field: {"type":"delete_custom_field","id":"可选ID","fieldKey":"可选key"} （仅 Host）',
      '注意：修改已有记录时，务必优先引用下方「可编辑实体索引」中的精确 recordId / id / fieldKey；所有队伍编号依然在正文中使用 #27570 格式。'
    ].join('\n')
  }

  return [
    '[⚡ TURBO EXECUTION MODE ENABLED]',
    `Acting User Identity: ${params.username || 'User'} (userId: ${params.userId || 'unknown'}) | Role: ${roleLabel}`,
    'ONLY when the user explicitly asks to create, edit, delete, tag, ban/unban, assign scouts, set my team, or manage custom fields, emit one or more ```sp27-action fenced JSON blocks at the end of your reply. The client will execute them immediately as this user.',
    'If the user is only asking a question or requesting analysis, answer normally WITHOUT any sp27-action block.',
    'If the request exceeds the user’s permissions (e.g., non-Host asking to ban a team, assign scouts, manage custom fields, or edit another scout’s record), explain the permission restriction and do NOT emit invalid actions.',
    '',
    '[sp27-action JSON Protocol]',
    '```sp27-action',
    '{"actions":[{"type":"add_tag","teamNumber":27570,"tag":"fast-cycle","color":"green"}]}',
    '```',
    'Supported action types (max 20 per turn):',
    '1. add_tag: {"type":"add_tag","teamNumber":27570,"tag":"label (no dot ., 1-30 chars)","color":"red|orange|green|blue|purple|gray|yellow"}',
    '2. remove_tag: {"type":"remove_tag","teamNumber":27570,"tag":"label"} (creator or Host)',
    '3. create_match_record: {"type":"create_match_record","matchNumber":5,"teamNumber":27570,"tournamentLevel":"QUALIFICATION|PLAYOFF","allianceColor":"red|blue","autoLeave":true,"autoBalls":2,"autoPark":false,"teleopCycles":[3,4],"teleopBalls":7,"teleopPark":true,"flowerNectars":2,"flowerBottomBonusCount":1,"flowerPollens":0,"gardenBalls":1,"flowerDescore":false,"g410EarlyFlowerFoul":false,"isBroken":false,"notes":"...","customFields":{}}',
    '4. update_match_record: {"type":"update_match_record","recordId":"optional","matchNumber":5,"teamNumber":27570,"tournamentLevel":"QUALIFICATION","patch":{...}} (owner or Host)',
    '5. delete_match_record: {"type":"delete_match_record","recordId":"optional","matchNumber":5,"teamNumber":27570,"tournamentLevel":"QUALIFICATION"} (owner or Host)',
    '6. upsert_pit_record: {"type":"upsert_pit_record","teamNumber":27570,"patch":{...}}',
    '7. ban_team / unban_team: {"type":"ban_team","teamNumber":27570} | {"type":"unban_team","teamNumber":27570} (Host only)',
    '8. assign_scout: {"type":"assign_scout","matchNumber":5,"station":"red1|red2|blue1|blue2","tournamentLevel":"QUALIFICATION","scoutId":"optional or self","scoutName":"name or null"} (Host only)',
    '9. set_my_team: {"type":"set_my_team","teamNumber":27570}',
    '10. create_custom_field / update_custom_field / delete_custom_field (Host only)',
    'Always reference exact IDs from the [Editable Entity Index] below when modifying or deleting existing records or custom fields.'
  ].join('\n')
}

export function buildTurboEditableEntitySnapshot(params: TurboSnapshotParams): string {
  const lines: string[] = ['\n[Editable Entity Index (For Turbo Actions)]']

  const activeRecords = params.records
    .filter(r => !r.isDeleted)
    .sort((a, b) => {
      const ord = getTournamentLevelOrder(getRecordTournamentLevel(a)) - getTournamentLevelOrder(getRecordTournamentLevel(b))
      return ord !== 0 ? ord : a.matchNumber - b.matchNumber || a.teamNumber - b.teamNumber
    })

  if (activeRecords.length > 0) {
    lines.push('Match Records (max 45 recent):')
    for (const rec of activeRecords.slice(-45)) {
      const lvl = getRecordTournamentLevel(rec) === 'PLAYOFF' ? 'P' : 'Q'
      const ownership = rec.scoutId === params.userId ? 'own' : 'other'
      const who = sanitizeSnapshotText(rec.scoutName || rec.scoutId, 48)
      const notePreview = sanitizeSnapshotText(rec.notes, 32)
      lines.push(
        `- [id:${rec.id}] ${lvl}${rec.matchNumber} #${rec.teamNumber} (${who}, ${ownership}) | A:${rec.autoScore} T:${rec.teleopScore} E:${rec.endgameScore} Tot:${rec.totalScore}${rec.isBroken ? ' BROKEN' : ''}${notePreview ? ` "${notePreview}"` : ''}`
      )
    }
  } else {
    lines.push('Match Records: (none)')
  }

  if (params.customFields.length > 0) {
    lines.push('Custom Fields:')
    for (const f of params.customFields) {
      lines.push(`- [id:${f.id}] key=${sanitizeSnapshotText(f.fieldKey, 64)} "${sanitizeSnapshotText(f.name, 80)}" (${f.target}/${f.fieldType}, ${f.isActive ? 'active' : 'inactive'})`)
    }
  }

  if (params.schedules.length > 0) {
    lines.push('Schedule & Assignments (max 25):')
    const sortedSched = [...params.schedules].sort((a, b) => {
      const ord = getTournamentLevelOrder(a.tournamentLevel) - getTournamentLevelOrder(b.tournamentLevel)
      return ord !== 0 ? ord : a.matchNumber - b.matchNumber
    })
    for (const s of sortedSched.slice(0, 25)) {
      const lvl = (s.tournamentLevel || 'QUALIFICATION').toUpperCase()
      const prefix = lvl === 'PLAYOFF' ? 'P' : 'Q'
      const stLabels = (['red1', 'red2', 'blue1', 'blue2'] as const).map(st => {
        const team = s[st]
        const a =
          params.assignments[`${lvl}_${s.matchNumber}_${st}`] ||
          (lvl === 'QUALIFICATION' ? params.assignments[`${s.matchNumber}_${st}`] : undefined)
        const who = sanitizeSnapshotText(a?.scoutName || a?.scoutId || '-', 40) || '-'
        return `${st}:#${team}(${who})`
      })
      lines.push(`- ${prefix}${s.matchNumber}: ${stLabels.join(', ')}`)
    }
  }

  if (params.bannedTeams.length > 0) {
    lines.push(`Banned Teams: ${params.bannedTeams.map(n => `#${n}`).join(', ')}`)
  }

  if (params.tags.length > 0) {
    const byTeam = new Map<number, string[]>()
    for (const t of params.tags) {
      const arr = byTeam.get(t.teamNumber) || []
      arr.push(`${sanitizeSnapshotText(t.tag, 40)}(${t.color})`)
      byTeam.set(t.teamNumber, arr)
    }
    lines.push('Existing Tags:')
    for (const [tn, tList] of Array.from(byTeam.entries()).sort((a, b) => a[0] - b[0])) {
      lines.push(`- #${tn}: ${tList.join(', ')}`)
    }
  }

  return lines.join('\n')
}

export function extractTurboActionsFromContent(content: string): TurboParsedAction[] {
  if (!content) return []
  const blockRegex = /```sp27-action[ \t]*\r?\n([\s\S]*?)```/gi
  const collected: TurboParsedAction[] = []
  let match: RegExpExecArray | null

  while ((match = blockRegex.exec(content)) !== null) {
    const rawJson = (match[1] || '').trim()
    if (!rawJson) continue
    try {
      const parsed = JSON.parse(rawJson)
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray(parsed.actions)
          ? parsed.actions
          : parsed && typeof parsed === 'object' && typeof parsed.type === 'string'
            ? [parsed]
            : []
      for (const item of list) {
        if (item && typeof item === 'object' && typeof item.type === 'string' && item.type.trim()) {
          collected.push({ ...item, type: item.type.trim() })
          if (collected.length >= MAX_ACTIONS_PER_TURN) {
            return collected
          }
        }
      }
    } catch {
      // Ignore malformed JSON action blocks gracefully
    }
  }

  return collected
}

export function stripTurboActionBlocks(content: string): {
  displayContent: string
  hasPendingBlock: boolean
} {
  if (!content) {
    return { displayContent: '', hasPendingBlock: false }
  }
  let stripped = content.replace(/```sp27-action[ \t]*(?:\r?\n)?[\s\S]*?```/gi, '')
  let hasPendingBlock = false
  const openIdx = stripped.search(/```sp27-action(?:\s|$)/i)
  if (openIdx !== -1) {
    hasPendingBlock = true
    stripped = stripped.slice(0, openIdx)
  }
  return {
    displayContent: stripped.replace(/\n{3,}/g, '\n\n').trim(),
    hasPendingBlock
  }
}

function buildMatchRawDataAndScores(input: Record<string, any>, existingRaw?: ParsedFallbackRaw): {
  autoScore: number
  teleopScore: number
  endgameScore: number
  totalScore: number
  rawData: string
  isBroken: boolean
  notes: string
  matchNumber: number
  teamNumber: number
} {
  const matchNumber = clampInt(input.matchNumber ?? existingRaw?.matchNumber ?? 1, 1, 9999)
  const teamNumber = clampInt(input.teamNumber ?? existingRaw?.teamNumber ?? 1, 1, 9999999)
  const tournamentLevel = String(input.tournamentLevel || existingRaw?.tournamentLevel || 'QUALIFICATION').toUpperCase()
  const allianceRaw = String(input.allianceColor || existingRaw?.allianceColor || 'red').toLowerCase()
  const allianceColor: 'none' | 'red' | 'blue' =
    allianceRaw === 'blue' ? 'blue' : allianceRaw === 'none' ? 'none' : 'red'
  const isBroken = input.isBroken !== undefined ? Boolean(input.isBroken) : Boolean(existingRaw?.isBroken)
  const notes = input.notes !== undefined ? String(input.notes ?? '') : String(existingRaw?.notes ?? '')

  const autoLeave = input.autoLeave !== undefined ? Boolean(input.autoLeave) : Boolean(existingRaw?.autoLeave)
  const autoBalls = input.autoBalls !== undefined
    ? clampInt(input.autoBalls, 0, 50)
    : clampInt(existingRaw?.autoBalls ?? 0, 0, 50)
  const autoPark = input.autoPark !== undefined ? Boolean(input.autoPark) : Boolean(existingRaw?.autoPark)

  let teleopCycles: number[] = Array.isArray(existingRaw?.teleopCycles) ? [...existingRaw.teleopCycles] : []
  if (Array.isArray(input.teleopCycles)) {
    teleopCycles = input.teleopCycles.map((v: unknown) => Math.max(0, Math.round(toFiniteNumber(v, 0))))
  } else if (input.teleopBalls !== undefined) {
    const balls = Math.max(0, Math.round(toFiniteNumber(input.teleopBalls, 0)))
    teleopCycles = balls > 0 ? [balls] : []
  }

  const teleopPark = input.teleopPark !== undefined ? Boolean(input.teleopPark) : Boolean(existingRaw?.teleopPark)
  const flowerNectars = input.flowerNectars !== undefined
    ? clampInt(input.flowerNectars, 0, 8)
    : clampInt(existingRaw?.flowerNectars ?? 0, 0, 8)
  const rawBottomBonus = input.flowerBottomBonusCount !== undefined
    ? clampInt(input.flowerBottomBonusCount, 0, 4)
    : clampInt(existingRaw?.flowerBottomBonusCount ?? 0, 0, 4)
  const flowerBottomBonusCount = Math.min(rawBottomBonus, flowerNectars)
  const flowerPollens = input.flowerPollens !== undefined
    ? clampInt(input.flowerPollens, 0, 12)
    : clampInt(existingRaw?.flowerPollens ?? 0, 0, 12)
  const gardenBalls = input.gardenBalls !== undefined
    ? clampInt(input.gardenBalls, 0, 12)
    : clampInt(existingRaw?.gardenBalls ?? 0, 0, 12)
  const flowerDescore = input.flowerDescore !== undefined ? Boolean(input.flowerDescore) : Boolean(existingRaw?.flowerDescore)
  const g410EarlyFlowerFoul = input.g410EarlyFlowerFoul !== undefined
    ? Boolean(input.g410EarlyFlowerFoul)
    : Boolean(existingRaw?.g410EarlyFlowerFoul)

  const customFields = {
    ...(existingRaw?.customFields || {}),
    ...(input.customFields && typeof input.customFields === 'object' ? input.customFields : {})
  }

  const formData: ScoutingFormData = {
    matchNumber,
    tournamentLevel,
    teamNumber,
    allianceColor,
    isBroken,
    autoLeave,
    autoBalls,
    autoCycles: Array.isArray(input.autoCycles)
      ? input.autoCycles.map((v: unknown) => Math.max(0, Math.round(toFiniteNumber(v, 0))))
      : existingRaw?.autoCycles || (autoBalls > 0 ? [autoBalls] : []),
    autoMissedCycles: existingRaw?.autoMissedCycles || [],
    autoCycleTimestamps: existingRaw?.autoCycleTimestamps || [],
    autoCycleTimeSec: existingRaw?.autoCycleTimeSec ?? null,
    autoPark,
    teleopCycles,
    teleopMissedCycles: existingRaw?.teleopMissedCycles || [],
    teleopCycleTimestamps: existingRaw?.teleopCycleTimestamps || [],
    predictCycleTimeSec: existingRaw?.predictCycleTimeSec ?? null,
    teleopPark,
    flowerNectars,
    flowerBottomBonusCount,
    flowerPollens,
    gardenBalls,
    flowerDescore,
    g410EarlyFlowerFoul,
    flowerPlaced: flowerNectars > 0,
    flowerBottomBonus: flowerBottomBonusCount > 0,
    customFields
  }

  const computedAuto = (autoLeave ? 3 : 0) + autoBalls * 3 + (autoPark ? 5 : 0)
  const totalTeleopBalls = teleopCycles.reduce((sum, n) => sum + (Number(n) || 0), 0)
  const computedTeleop = totalTeleopBalls * 2
  const computedEndgame = calcBiobuzzEndgameScore(parseBiobuzzEndgame(formData))

  const hasAutoStructured = input.autoLeave !== undefined || input.autoBalls !== undefined || input.autoPark !== undefined
  const hasTeleopStructured = Array.isArray(input.teleopCycles) || input.teleopBalls !== undefined
  const hasEndgameStructured =
    input.teleopPark !== undefined ||
    input.flowerNectars !== undefined ||
    input.flowerBottomBonusCount !== undefined ||
    input.flowerPollens !== undefined ||
    input.gardenBalls !== undefined

  const autoScore = !hasAutoStructured && input.autoScore !== undefined
    ? Math.max(0, Math.round(toFiniteNumber(input.autoScore, computedAuto)))
    : (hasAutoStructured || existingRaw == null || existingRaw.hasStructuredAuto)
      ? computedAuto
      : (existingRaw.autoScore ?? computedAuto)

  const teleopScore = !hasTeleopStructured && input.teleopScore !== undefined
    ? Math.max(0, Math.round(toFiniteNumber(input.teleopScore, computedTeleop)))
    : (hasTeleopStructured || existingRaw == null || existingRaw.hasStructuredTeleop)
      ? computedTeleop
      : (existingRaw.teleopScore ?? computedTeleop)

  const endgameScore = !hasEndgameStructured && input.endgameScore !== undefined
    ? Math.max(0, Math.round(toFiniteNumber(input.endgameScore, computedEndgame)))
    : (hasEndgameStructured || existingRaw == null || existingRaw.hasStructuredEndgame)
      ? computedEndgame
      : (existingRaw.endgameScore ?? computedEndgame)

  const totalScore = autoScore + teleopScore + endgameScore

  return {
    autoScore,
    teleopScore,
    endgameScore,
    totalScore,
    rawData: JSON.stringify(formData),
    isBroken,
    notes,
    matchNumber,
    teamNumber
  }
}

interface ParsedFallbackRaw {
  matchNumber: number
  teamNumber: number
  tournamentLevel: string
  allianceColor: string
  isBroken: boolean
  notes: string
  autoLeave: boolean
  autoBalls: number
  autoCycles: number[]
  autoMissedCycles: number[]
  autoCycleTimestamps: number[]
  autoCycleTimeSec: number | null
  autoPark: boolean
  teleopCycles: number[]
  teleopMissedCycles: number[]
  teleopCycleTimestamps: number[]
  predictCycleTimeSec: number | null
  teleopPark: boolean
  flowerNectars: number
  flowerBottomBonusCount: number
  flowerPollens: number
  gardenBalls: number
  flowerDescore: boolean
  g410EarlyFlowerFoul: boolean
  customFields: Record<string, any>
  autoScore: number
  teleopScore: number
  endgameScore: number
  hasStructuredAuto: boolean
  hasStructuredTeleop: boolean
  hasStructuredEndgame: boolean
}

function extractExistingMatchRaw(rec: ScoutingRecord): ParsedFallbackRaw {
  let rawObj: Record<string, any> = {}
  try {
    rawObj = rec.rawData ? JSON.parse(rec.rawData) : {}
  } catch {
    rawObj = {}
  }
  const parsed = parseScoutRawData(rec.rawData)
  return {
    matchNumber: rec.matchNumber,
    teamNumber: rec.teamNumber,
    tournamentLevel: getRecordTournamentLevel(rec),
    allianceColor: String(rawObj.allianceColor || 'red'),
    isBroken: Boolean(rec.isBroken),
    notes: rec.notes || '',
    autoLeave: parsed.autoLeave,
    autoBalls: parsed.autoBalls,
    autoCycles: parsed.autoCycles,
    autoMissedCycles: Array.isArray(rawObj.autoMissedCycles) ? rawObj.autoMissedCycles : [],
    autoCycleTimestamps: parsed.autoCycleTimestamps,
    autoCycleTimeSec: parsed.autoCycleTimeSec,
    autoPark: parsed.autoPark,
    teleopCycles: parsed.teleopCycles,
    teleopMissedCycles: parsed.teleopMissedCycles,
    teleopCycleTimestamps: parsed.teleopCycleTimestamps,
    predictCycleTimeSec: parsed.predictCycleTimeSec,
    teleopPark: parsed.endgame.teleopPark,
    flowerNectars: parsed.endgame.flowerNectars,
    flowerBottomBonusCount: parsed.endgame.flowerBottomBonusCount,
    flowerPollens: parsed.endgame.flowerPollens,
    gardenBalls: parsed.endgame.gardenBalls,
    flowerDescore: parsed.endgame.flowerDescore,
    g410EarlyFlowerFoul: parsed.endgame.g410EarlyFlowerFoul,
    customFields: rawObj.customFields && typeof rawObj.customFields === 'object' ? rawObj.customFields : {},
    autoScore: rec.autoScore,
    teleopScore: rec.teleopScore,
    endgameScore: rec.endgameScore,
    hasStructuredAuto: parsed.autoLeave || parsed.autoBalls > 0 || parsed.autoPark,
    hasStructuredTeleop: parsed.teleopCycles.length > 0,
    hasStructuredEndgame:
      parsed.endgame.teleopPark ||
      parsed.endgame.flowerNectars > 0 ||
      parsed.endgame.flowerBottomBonusCount > 0 ||
      parsed.endgame.flowerPollens > 0 ||
      parsed.endgame.gardenBalls > 0
  }
}

function findTargetMatchRecord(
  records: ScoutingRecord[],
  eventId: string,
  action: TurboParsedAction,
  userId: string
): ScoutingRecord | undefined {
  const active = records.filter(r => !r.isDeleted && (!eventId || r.eventId === eventId))
  if (typeof action.recordId === 'string' && action.recordId.trim()) {
    return active.find(r => r.id === action.recordId.trim())
  }
  const matchNum = Number(action.matchNumber)
  const teamNum = Number(action.teamNumber)
  if (!Number.isFinite(matchNum) || matchNum <= 0 || !Number.isFinite(teamNum) || teamNum <= 0) {
    return undefined
  }
  const targetLevel = action.tournamentLevel ? String(action.tournamentLevel).toUpperCase() : null
  const candidates = active.filter(r => {
    if (r.matchNumber !== matchNum || r.teamNumber !== teamNum) return false
    if (targetLevel && getRecordTournamentLevel(r) !== targetLevel) return false
    return true
  })
  return candidates.find(r => r.scoutId === userId) || candidates[0]
}

export async function executeTurboActions(params: TurboExecutionParams): Promise<AiTurboActionResult[]> {
  const { eventId, actions, userId, username, isHost, locale } = params
  const isZh = isZhLocale(locale)
  const recordStore = useRecordStore()
  const pitStore = usePitScoutStore()
  const scheduleStore = useScheduleStore()
  const customFieldsStore = useCustomFieldsStore()
  const aiStore = useAiStore()

  const results: AiTurboActionResult[] = []

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!
    const actionId = `turbo_${Date.now()}_${i}`
    const executedAt = new Date().toISOString()

    const fail = (summary: string, error: string): AiTurboActionResult => ({
      id: actionId,
      type: action.type,
      status: 'error',
      summary,
      error,
      actedAsUsername: username,
      executedAt
    })

    const ok = (summary: string, detail?: string): AiTurboActionResult => ({
      id: actionId,
      type: action.type,
      status: 'success',
      summary,
      detail,
      actedAsUsername: username,
      executedAt
    })

    try {
      switch (action.type) {
        case 'add_tag': {
          const teamNumber = Math.round(toFiniteNumber(action.teamNumber, 0))
          const tag = String(action.tag || '').trim()
          if (teamNumber <= 0 || !tag) {
            results.push(fail(isZh ? '添加标签' : 'Add tag', isZh ? '缺少有效队号或标签名' : 'Invalid teamNumber or tag'))
            break
          }
          if (tag.includes('.') || tag.length > 30) {
            results.push(fail(isZh ? `为 #${teamNumber} 添加标签` : `Tag #${teamNumber}`, isZh ? '标签长度需在 1-30 字符且不能包含 "."' : 'Tag must be 1-30 chars without "."'))
            break
          }
          const color = VALID_TAG_COLORS.has(String(action.color || '').toLowerCase())
            ? String(action.color).toLowerCase()
            : 'blue'
          const res = await recordStore.addTag(eventId, teamNumber, tag, color)
          if (!res.success) {
            results.push(fail(isZh ? `为 #${teamNumber} 添加标签「${tag}」` : `Add tag "${tag}" to #${teamNumber}`, res.error || 'Failed to add tag'))
          } else {
            results.push(ok(isZh ? `已为 #${teamNumber} 添加标签「${res.tag?.tag || tag}」` : `Added tag "${res.tag?.tag || tag}" to #${teamNumber}`))
          }
          break
        }

        case 'remove_tag': {
          const teamNumber = Math.round(toFiniteNumber(action.teamNumber, 0))
          const tag = String(action.tag || '').trim()
          if (teamNumber <= 0 || !tag) {
            results.push(fail(isZh ? '移除标签' : 'Remove tag', isZh ? '缺少有效队号或标签名' : 'Invalid teamNumber or tag'))
            break
          }
          const existingTag = recordStore.teamTags.find(
            t => (!t.eventId || t.eventId === eventId) && t.teamNumber === teamNumber && t.tag.toLowerCase() === tag.toLowerCase()
          )
          if (existingTag && !isHost && existingTag.createdBy && existingTag.createdBy !== userId) {
            results.push(fail(isZh ? `移除 #${teamNumber} 标签「${tag}」` : `Remove tag "${tag}" on #${teamNumber}`, isZh ? '权限不足：仅标签创建者或赛事 Host 可删除他人标签' : 'Permission denied: only tag creator or event Host can remove this tag'))
            break
          }
          const res = await recordStore.removeTag(eventId, teamNumber, tag)
          if (!res.success) {
            results.push(fail(isZh ? `移除 #${teamNumber} 标签「${tag}」` : `Remove tag "${tag}" on #${teamNumber}`, res.error || 'Failed to remove tag'))
          } else {
            results.push(ok(isZh ? `已移除 #${teamNumber} 标签「${tag}」` : `Removed tag "${tag}" from #${teamNumber}`))
          }
          break
        }

        case 'create_match_record': {
          const teamNumber = Math.round(toFiniteNumber(action.teamNumber, 0))
          const matchNumber = Math.round(toFiniteNumber(action.matchNumber, 0))
          if (teamNumber <= 0 || matchNumber <= 0) {
            results.push(fail(isZh ? '创建比赛侦察记录' : 'Create match record', isZh ? '缺少有效场次号或队号' : 'Invalid matchNumber or teamNumber'))
            break
          }
          const built = buildMatchRawDataAndScores(action)
          const nowIso = new Date().toISOString()
          const id =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          const newRec: ScoutingRecord = {
            id,
            eventId,
            scoutId: userId,
            scoutName: username,
            matchNumber: built.matchNumber,
            teamNumber: built.teamNumber,
            autoScore: built.autoScore,
            teleopScore: built.teleopScore,
            endgameScore: built.endgameScore,
            totalScore: built.totalScore,
            notes: built.notes,
            rawData: built.rawData,
            syncStatus: 'PENDING',
            createdAt: nowIso,
            updatedAt: nowIso,
            isBroken: built.isBroken,
            version: 0
          }
          await recordStore.addRecord(newRec)
          results.push(
            ok(
              isZh
                ? `已新增 M${built.matchNumber} #${built.teamNumber} 比赛记录（总分 ${built.totalScore}）`
                : `Created M${built.matchNumber} #${built.teamNumber} match record (Total ${built.totalScore})`,
              `Auto ${built.autoScore} / TeleOp ${built.teleopScore} / Endgame ${built.endgameScore}`
            )
          )
          break
        }

        case 'update_match_record': {
          const target = findTargetMatchRecord(recordStore.records, eventId, action, userId)
          if (!target) {
            results.push(fail(isZh ? '更新比赛记录' : 'Update match record', isZh ? '未找到匹配的比赛记录' : 'Target match record not found'))
            break
          }
          if (!isHost && target.scoutId && target.scoutId !== userId) {
            results.push(fail(isZh ? `更新 M${target.matchNumber} #${target.teamNumber} 记录` : `Update M${target.matchNumber} #${target.teamNumber}`, isZh ? '权限不足：非 Host 只能修改本人提交的记录' : 'Permission denied: only the record author or event Host can edit this record'))
            break
          }
          const patch = action.patch && typeof action.patch === 'object' ? action.patch : action
          const existingRaw = extractExistingMatchRaw(target)
          const built = buildMatchRawDataAndScores(patch, existingRaw)
          const updatedRec: ScoutingRecord = {
            ...target,
            matchNumber: built.matchNumber,
            teamNumber: built.teamNumber,
            autoScore: built.autoScore,
            teleopScore: built.teleopScore,
            endgameScore: built.endgameScore,
            totalScore: built.totalScore,
            notes: built.notes,
            rawData: built.rawData,
            isBroken: built.isBroken
          }
          await recordStore.updateRecord(updatedRec)
          results.push(
            ok(
              isZh
                ? `已更新 M${updatedRec.matchNumber} #${updatedRec.teamNumber} 记录（总分 ${updatedRec.totalScore}）`
                : `Updated M${updatedRec.matchNumber} #${updatedRec.teamNumber} (Total ${updatedRec.totalScore})`
            )
          )
          break
        }

        case 'delete_match_record': {
          const target = findTargetMatchRecord(recordStore.records, eventId, action, userId)
          if (!target) {
            results.push(fail(isZh ? '删除比赛记录' : 'Delete match record', isZh ? '未找到匹配的比赛记录' : 'Target match record not found'))
            break
          }
          if (!isHost && target.scoutId && target.scoutId !== userId) {
            results.push(fail(isZh ? `删除 M${target.matchNumber} #${target.teamNumber} 记录` : `Delete M${target.matchNumber} #${target.teamNumber}`, isZh ? '权限不足：非 Host 只能删除本人提交的记录' : 'Permission denied: only the record author or event Host can delete this record'))
            break
          }
          const res = await recordStore.deleteRecord(target.id)
          if (!res.success) {
            results.push(fail(isZh ? `删除 M${target.matchNumber} #${target.teamNumber} 记录` : `Delete M${target.matchNumber} #${target.teamNumber}`, 'Delete failed'))
          } else {
            results.push(ok(isZh ? `已删除 M${target.matchNumber} #${target.teamNumber} 记录` : `Deleted M${target.matchNumber} #${target.teamNumber} record`))
          }
          break
        }

        case 'upsert_pit_record': {
          const teamNumber = Math.round(toFiniteNumber(action.teamNumber, 0))
          if (teamNumber <= 0 || teamNumber > 9999999) {
            results.push(fail(isZh ? '更新展位记录' : 'Upsert pit record', isZh ? '缺少有效队号' : 'Invalid teamNumber'))
            break
          }
          const patch = action.patch && typeof action.patch === 'object' ? action.patch : action
          const existing = pitStore.activeRecords.find(p => p.teamNumber === teamNumber && (!p.eventId || p.eventId === eventId))
          let existingCustomFields: Record<string, any> = {}
          if (existing?.customFields && typeof existing.customFields === 'object') {
            existingCustomFields = { ...existing.customFields }
          } else if (existing?.rawData) {
            try {
              const parsedRaw = JSON.parse(existing.rawData)
              if (parsedRaw?.customFields && typeof parsedRaw.customFields === 'object') {
                existingCustomFields = { ...parsedRaw.customFields }
              }
            } catch {}
          }

          const mergedCustomFields = {
            ...existingCustomFields,
            ...(patch.customFields && typeof patch.customFields === 'object' ? patch.customFields : {})
          }

          const drivetrainType = VALID_DRIVETRAINS.has(patch.drivetrainType)
            ? patch.drivetrainType
            : existing?.drivetrainType || 'mecanum'
          const ballCompatibility = VALID_BALL_COMPAT.has(patch.ballCompatibility)
            ? patch.ballCompatibility
            : existing?.ballCompatibility || 'universal'
          const claimedAutoScore = Math.max(0, Math.round(toFiniteNumber(patch.claimedAutoScore, existing?.claimedAutoScore ?? 0)))
          const claimedTeleopCycles = Math.max(0, Math.round(toFiniteNumber(patch.claimedTeleopCycles, existing?.claimedTeleopCycles ?? 0)))
          const claimedTeleopScore = Math.max(0, Math.round(toFiniteNumber(patch.claimedTeleopScore, existing?.claimedTeleopScore ?? 0)))
          const claimedTeleopPark = patch.claimedTeleopPark !== undefined ? Boolean(patch.claimedTeleopPark) : Boolean(existing?.claimedTeleopPark)
          const claimedFlowerNectars = clampInt(patch.claimedFlowerNectars ?? existing?.claimedFlowerNectars ?? 0, 0, 8)
          const claimedFlowerBottomBonus = clampInt(
            patch.claimedFlowerBottomBonus ?? existing?.claimedFlowerBottomBonus ?? 0,
            0,
            Math.min(4, claimedFlowerNectars)
          )
          const claimedFlowerPollens = Math.max(0, Math.round(toFiniteNumber(patch.claimedFlowerPollens, existing?.claimedFlowerPollens ?? 0)))
          const claimedGardenBalls = Math.max(0, Math.round(toFiniteNumber(patch.claimedGardenBalls, existing?.claimedGardenBalls ?? 0)))

          const hasStructuredEndgame =
            claimedTeleopPark ||
            claimedFlowerNectars > 0 ||
            claimedFlowerBottomBonus > 0 ||
            claimedFlowerPollens > 0 ||
            claimedGardenBalls > 0
          const structuredEndgame =
            (claimedTeleopPark ? 5 : 0) +
            claimedFlowerNectars * 2 +
            claimedFlowerBottomBonus * 5 +
            claimedFlowerPollens * 2 +
            claimedGardenBalls
          const claimedEndgameScore = hasStructuredEndgame
            ? structuredEndgame
            : Math.max(0, Math.round(toFiniteNumber(patch.claimedEndgameScore, existing?.claimedEndgameScore ?? 0)))
          const claimedTotalScore =
            !hasStructuredEndgame && patch.claimedTotalScore !== undefined
              ? Math.max(0, Math.round(toFiniteNumber(patch.claimedTotalScore, claimedAutoScore + claimedTeleopScore + claimedEndgameScore)))
              : claimedAutoScore + claimedTeleopScore + claimedEndgameScore

          const pitRecord: PitScoutingRecord = {
            id: existing?.id || `${eventId}_pit_${teamNumber}`,
            eventId,
            teamNumber,
            scoutId: userId,
            scoutName: username,
            robotName: patch.robotName !== undefined ? String(patch.robotName).slice(0, 100) : existing?.robotName,
            drivetrainType,
            weightLbs: Math.max(0, toFiniteNumber(patch.weightLbs, existing?.weightLbs ?? 0)),
            chassisSize: patch.chassisSize !== undefined ? String(patch.chassisSize).slice(0, 64) : existing?.chassisSize || '',
            ballCompatibility,
            launcherType: patch.launcherType !== undefined ? String(patch.launcherType).slice(0, 100) : existing?.launcherType || '',
            flowerMechanism: patch.flowerMechanism !== undefined ? String(patch.flowerMechanism).slice(0, 100) : existing?.flowerMechanism || '',
            hasColorSensor: patch.hasColorSensor !== undefined ? Boolean(patch.hasColorSensor) : Boolean(existing?.hasColorSensor),
            hasDescoreMech: patch.hasDescoreMech !== undefined ? Boolean(patch.hasDescoreMech) : Boolean(existing?.hasDescoreMech),
            hasApriltagVision: patch.hasApriltagVision !== undefined ? Boolean(patch.hasApriltagVision) : Boolean(existing?.hasApriltagVision),
            odometryType: patch.odometryType !== undefined ? String(patch.odometryType).slice(0, 30) : existing?.odometryType || 'none',
            claimedAutoStrategy: patch.claimedAutoStrategy !== undefined ? String(patch.claimedAutoStrategy).slice(0, 500) : existing?.claimedAutoStrategy || '',
            claimedAutoScore,
            claimedTeleopCycles,
            claimedTeleopScore,
            claimedTeleopPark,
            claimedFlowerNectars,
            claimedFlowerBottomBonus,
            claimedFlowerPollens,
            claimedGardenBalls,
            claimedEndgameScore,
            claimedTotalScore,
            photoKeys: existing?.photoKeys || [],
            customFields: mergedCustomFields,
            rawData: JSON.stringify({ customFields: mergedCustomFields }),
            version: existing?.version || 0,
            createdAt: existing?.createdAt || new Date().toISOString()
          }

          if (pitStore.currentEventId !== eventId) {
            pitStore.currentEventId = eventId
          }
          await pitStore.saveRecord(pitRecord)
          results.push(
            ok(
              isZh
                ? `已保存 #${teamNumber} 展位档案（自述总分 ${claimedTotalScore}）`
                : `Saved Pit profile for #${teamNumber} (Claimed Total ${claimedTotalScore})`
            )
          )
          break
        }

        case 'ban_team': {
          const teamNumber = Math.round(toFiniteNumber(action.teamNumber, 0))
          if (!isHost) {
            results.push(fail(isZh ? `禁选 #${teamNumber}` : `Ban #${teamNumber}`, isZh ? '权限不足：仅赛事 Host 可禁选队伍' : 'Permission denied: only event Host can ban teams'))
            break
          }
          if (teamNumber <= 0) {
            results.push(fail(isZh ? '禁选队伍' : 'Ban team', isZh ? '无效队号' : 'Invalid teamNumber'))
            break
          }
          await recordStore.banTeam(eventId, teamNumber)
          results.push(ok(isZh ? `已将 #${teamNumber} 加入禁选名单` : `Banned team #${teamNumber}`))
          break
        }

        case 'unban_team': {
          const teamNumber = Math.round(toFiniteNumber(action.teamNumber, 0))
          if (!isHost) {
            results.push(fail(isZh ? `取消禁选 #${teamNumber}` : `Unban #${teamNumber}`, isZh ? '权限不足：仅赛事 Host 可取消禁选' : 'Permission denied: only event Host can unban teams'))
            break
          }
          if (teamNumber <= 0) {
            results.push(fail(isZh ? '取消禁选队伍' : 'Unban team', isZh ? '无效队号' : 'Invalid teamNumber'))
            break
          }
          await recordStore.unbanTeam(eventId, teamNumber)
          results.push(ok(isZh ? `已将 #${teamNumber} 移出禁选名单` : `Unbanned team #${teamNumber}`))
          break
        }

        case 'assign_scout': {
          const matchNumber = Math.round(toFiniteNumber(action.matchNumber, 0))
          const station = String(action.station || '').toLowerCase() as StationType
          const tournamentLevel = String(action.tournamentLevel || 'QUALIFICATION').toUpperCase()
          if (!isHost) {
            results.push(fail(isZh ? `排班 M${matchNumber}` : `Assign M${matchNumber}`, isZh ? '权限不足：仅赛事 Host 可调整排班' : 'Permission denied: only event Host can modify scout assignments'))
            break
          }
          if (matchNumber <= 0 || !VALID_STATIONS.has(station)) {
            results.push(fail(isZh ? '调整工位排班' : 'Assign station', isZh ? '无效场次号或工位 (red1/red2/blue1/blue2)' : 'Invalid matchNumber or station'))
            break
          }
          let targetScoutId: string | null = action.scoutId != null ? String(action.scoutId).trim() : null
          let targetScoutName: string | null = action.scoutName != null ? String(action.scoutName).trim() : null
          if (targetScoutId === '' || targetScoutId === 'null') targetScoutId = null
          if (targetScoutName === '' || targetScoutName === 'null') targetScoutName = null

          if (
            targetScoutId?.toLowerCase() === 'self' ||
            targetScoutName?.toLowerCase() === 'self' ||
            (targetScoutName && targetScoutName.toLowerCase() === username.toLowerCase())
          ) {
            targetScoutId = userId
            targetScoutName = username
          } else if (targetScoutName && !targetScoutId) {
            const matchedAssign = Object.values(scheduleStore.assignments).find(
              a => a.scoutName && a.scoutName.toLowerCase() === targetScoutName!.toLowerCase() && a.scoutId
            )
            const matchedRec = recordStore.records.find(
              r => r.scoutName && r.scoutName.toLowerCase() === targetScoutName!.toLowerCase() && r.scoutId
            )
            targetScoutId = matchedAssign?.scoutId || matchedRec?.scoutId || targetScoutName
          } else if (targetScoutId && !targetScoutName) {
            targetScoutName = targetScoutId === userId ? username : targetScoutId
          }

          await scheduleStore.assignStation(eventId, matchNumber, station, targetScoutId, targetScoutName, true, tournamentLevel)
          results.push(
            ok(
              targetScoutName
                ? isZh
                  ? `已指派 ${targetScoutName} 侦察 ${tournamentLevel === 'PLAYOFF' ? 'P' : 'Q'}${matchNumber} ${station}`
                  : `Assigned ${targetScoutName} to ${tournamentLevel === 'PLAYOFF' ? 'P' : 'Q'}${matchNumber} ${station}`
                : isZh
                  ? `已清空 ${tournamentLevel === 'PLAYOFF' ? 'P' : 'Q'}${matchNumber} ${station} 排班`
                  : `Unassigned ${tournamentLevel === 'PLAYOFF' ? 'P' : 'Q'}${matchNumber} ${station}`
            )
          )
          break
        }

        case 'set_my_team': {
          const rawTeam = action.teamNumber
          const nextNum = rawTeam === null || rawTeam === '' || Number(rawTeam) <= 0 ? null : Math.round(Number(rawTeam))
          aiStore.setMyTeamNumber(eventId, nextNum)
          results.push(
            ok(
              nextNum
                ? isZh
                  ? `已将我方队号设为 #${nextNum}`
                  : `Set my team number to #${nextNum}`
                : isZh
                  ? '已清除我方队号设置'
                  : 'Cleared my team number'
            )
          )
          break
        }

        case 'create_custom_field': {
          if (!isHost) {
            results.push(fail(isZh ? '创建自定义字段' : 'Create custom field', isZh ? '权限不足：仅赛事 Host 可管理自定义字段' : 'Permission denied: only event Host can manage custom fields'))
            break
          }
          const name = String(action.name || '').trim().slice(0, 100)
          const target = String(action.target || 'MATCH').toUpperCase() as CustomFieldTarget
          const rawFieldType = String(action.fieldType || (target === 'TEAM' ? 'formula' : 'number')).toLowerCase() as CustomFieldType
          if (!name || !VALID_TARGETS.has(target) || !VALID_FIELD_TYPES.has(rawFieldType)) {
            results.push(fail(isZh ? '创建自定义字段' : 'Create custom field', isZh ? '字段名、target 或 fieldType 无效' : 'Invalid name, target, or fieldType'))
            break
          }
          const fieldType: CustomFieldType = target === 'TEAM' ? 'formula' : rawFieldType
          const phase = VALID_PHASES.has(action.phase) ? (action.phase as CustomFieldPhase) : 'overall'
          const rawKey = String(action.fieldKey || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100)
          const fieldKey = rawKey || `field_${Math.random().toString(16).slice(2, 10)}`

          if (fieldType === 'formula') {
            const expr = String(action.formulaExpr || '').trim()
            if (!expr) {
              results.push(fail(isZh ? `创建公式字段「${name}」` : `Create formula "${name}"`, isZh ? 'formula 类型必须提供 formulaExpr' : 'formulaExpr is required for formula fieldType'))
              break
            }
            const existingFields = customFieldsStore.getFields(eventId)
            const check = validateFormulaGraph({ target, fieldKey, fieldType: 'formula', formulaExpr: expr }, existingFields)
            if (!check.valid) {
              results.push(fail(isZh ? `创建公式字段「${name}」` : `Create formula "${name}"`, check.error || check.errorCode || 'Invalid formula'))
              break
            }
          }

          const created = await customFieldsStore.createField(eventId, {
            name,
            target,
            phase,
            fieldKey,
            fieldType,
            formulaExpr: fieldType === 'formula' ? String(action.formulaExpr || '').trim() : null,
            unit: action.unit !== undefined ? String(action.unit).slice(0, 30) : null,
            description: action.description !== undefined ? String(action.description).slice(0, 300) : null,
            required: Boolean(action.required),
            defaultVal: action.defaultVal !== undefined ? String(action.defaultVal) : null,
            minVal: action.minVal != null ? Number(action.minVal) : null,
            maxVal: action.maxVal != null ? Number(action.maxVal) : null,
            stepVal: action.stepVal != null ? Number(action.stepVal) : null,
            options: Array.isArray(action.options) ? action.options : undefined,
            aggregationMode: VALID_AGG_MODES.has(action.aggregationMode) ? action.aggregationMode : 'avg',
            displayFormat: VALID_DISPLAY_FORMATS.has(action.displayFormat) ? action.displayFormat : 'number',
            isActive: action.isActive !== false
          })
          results.push(ok(isZh ? `已创建自定义字段「${created.name}」(${created.fieldKey})` : `Created custom field "${created.name}" (${created.fieldKey})`))
          break
        }

        case 'update_custom_field': {
          if (!isHost) {
            results.push(fail(isZh ? '更新自定义字段' : 'Update custom field', isZh ? '权限不足：仅赛事 Host 可管理自定义字段' : 'Permission denied: only event Host can manage custom fields'))
            break
          }
          const existingFields = customFieldsStore.getFields(eventId)
          const targetField =
            (action.id && existingFields.find(f => f.id === String(action.id))) ||
            (action.fieldKey && existingFields.find(f => f.fieldKey === String(action.fieldKey)))
          if (!targetField) {
            results.push(fail(isZh ? '更新自定义字段' : 'Update custom field', isZh ? '未找到目标自定义字段' : 'Target custom field not found'))
            break
          }
          const patch = action.patch && typeof action.patch === 'object' ? action.patch : action
          const nextType = VALID_FIELD_TYPES.has(patch.fieldType) ? (patch.fieldType as CustomFieldType) : targetField.fieldType
          const nextExpr = patch.formulaExpr !== undefined ? String(patch.formulaExpr || '').trim() : targetField.formulaExpr
          if (nextType === 'formula') {
            const check = validateFormulaGraph(
              { ...targetField, ...patch, id: targetField.id, target: targetField.target, fieldType: 'formula', formulaExpr: nextExpr },
              existingFields
            )
            if (!check.valid) {
              results.push(fail(isZh ? `更新字段「${targetField.name}」` : `Update field "${targetField.name}"`, check.error || check.errorCode || 'Invalid formula'))
              break
            }
          }
          const updated = await customFieldsStore.updateField(eventId, targetField.id, {
            ...targetField,
            name: patch.name !== undefined ? (String(patch.name).trim().slice(0, 100) || targetField.name) : targetField.name,
            phase: patch.phase !== undefined && VALID_PHASES.has(patch.phase) ? patch.phase : targetField.phase,
            unit: patch.unit !== undefined ? (patch.unit === null ? null : String(patch.unit).slice(0, 30)) : targetField.unit,
            description: patch.description !== undefined ? (patch.description === null ? null : String(patch.description).slice(0, 300)) : targetField.description,
            required: patch.required !== undefined ? Boolean(patch.required) : targetField.required,
            defaultVal: patch.defaultVal !== undefined ? (patch.defaultVal === null ? null : String(patch.defaultVal)) : targetField.defaultVal,
            minVal: patch.minVal !== undefined ? (patch.minVal == null ? null : Number(patch.minVal)) : targetField.minVal,
            maxVal: patch.maxVal !== undefined ? (patch.maxVal == null ? null : Number(patch.maxVal)) : targetField.maxVal,
            stepVal: patch.stepVal !== undefined ? (patch.stepVal == null ? null : Number(patch.stepVal)) : targetField.stepVal,
            options: Array.isArray(patch.options) ? patch.options : targetField.options,
            aggregationMode: patch.aggregationMode !== undefined && VALID_AGG_MODES.has(patch.aggregationMode) ? patch.aggregationMode : targetField.aggregationMode,
            displayFormat: patch.displayFormat !== undefined && VALID_DISPLAY_FORMATS.has(patch.displayFormat) ? patch.displayFormat : targetField.displayFormat,
            isActive: patch.isActive !== undefined ? Boolean(patch.isActive) : targetField.isActive,
            id: targetField.id,
            eventId: targetField.eventId,
            target: targetField.target,
            fieldKey: targetField.fieldKey,
            fieldType: nextType,
            formulaExpr: nextType === 'formula' ? nextExpr : null
          })
          results.push(ok(isZh ? `已更新自定义字段「${updated.name}」` : `Updated custom field "${updated.name}"`))
          break
        }

        case 'delete_custom_field': {
          if (!isHost) {
            results.push(fail(isZh ? '删除自定义字段' : 'Delete custom field', isZh ? '权限不足：仅赛事 Host 可管理自定义字段' : 'Permission denied: only event Host can manage custom fields'))
            break
          }
          const existingFields = customFieldsStore.getFields(eventId)
          const targetField =
            (action.id && existingFields.find(f => f.id === String(action.id))) ||
            (action.fieldKey && existingFields.find(f => f.fieldKey === String(action.fieldKey)))
          if (!targetField) {
            results.push(fail(isZh ? '删除自定义字段' : 'Delete custom field', isZh ? '未找到目标自定义字段' : 'Target custom field not found'))
            break
          }
          await customFieldsStore.deleteField(eventId, targetField.id)
          results.push(ok(isZh ? `已删除自定义字段「${targetField.name}」` : `Deleted custom field "${targetField.name}"`))
          break
        }

        default:
          results.push(fail(action.type, isZh ? `不支持的操作类型: ${action.type}` : `Unsupported action type: ${action.type}`))
      }
    } catch (err: any) {
      results.push(
        fail(
          action.type,
          err?.message ? String(err.message) : String(err)
        )
      )
    }
  }

  return results
}
