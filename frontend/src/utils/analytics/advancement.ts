import type {
  OfficialRanking,
  OfficialAlliance,
  OfficialAward,
  OfficialMatch,
  OfficialAdvancementResponse,
  OfficialAdvancementSlot,
  AdvancementDetail,
  AdvancementStatus
} from '@/types'

export const FTC_ADVANCEMENT_ALPHA = 1.07
export const DEFAULT_ADVANCEMENT_SLOTS = 4

/**
 * Abramowitz & Stegun erf(x) approximation (Formula 7.1.26)
 */
export function erf(x: number): number {
  if (x === 0) return 0
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911

  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x)

  const t = 1.0 / (1.0 + p * absX)
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX)
  return sign * y
}

/**
 * 高精度逆误差函数 (Inverse Error Function - invErf)
 * Winitzki 初始逼近 + 2 轮 Newton-Raphson 精炼迭代
 */
export function invErf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN
  if (x <= -1) return -Infinity
  if (x >= 1) return Infinity
  if (x === 0) return 0

  const a = 0.147
  const log1MinusX2 = Math.log(1.0 - x * x)
  const term1 = 2.0 / (Math.PI * a) + log1MinusX2 / 2.0
  const term2 = log1MinusX2 / a
  const sign = x < 0 ? -1 : 1

  let w = sign * Math.sqrt(Math.max(0, Math.sqrt(term1 * term1 - term2) - term1))

  // 2 轮 Newton-Raphson 迭代
  const c = 2.0 / Math.sqrt(Math.PI)
  for (let i = 0; i < 2; i++) {
    const f = erf(w) - x
    const fp = c * Math.exp(-w * w)
    if (fp !== 0) {
      w = w - f / fp
    }
  }
  return w
}

/**
 * 计算资格赛表现分 (Qualification Phase Performance Points)
 * FTC 官方标准公式: ceil( invErf((N - 2R + 2) / (alpha * N)) * (7 / invErf(1 / alpha)) + 9 )
 * 结果严格取值于 2 至 16 积分之间
 */
export function calcQualPoints(rank: number, totalTeams: number): number {
  if (totalTeams <= 0 || rank <= 0) return 0
  if (totalTeams === 1) return 16

  const denom = invErf(1.0 / FTC_ADVANCEMENT_ALPHA)
  const rawArg = (totalTeams - 2.0 * rank + 2.0) / (FTC_ADVANCEMENT_ALPHA * totalTeams)
  const clampedArg = Math.max(-0.999999, Math.min(0.999999, rawArg))

  const inv = invErf(clampedArg)
  const pts = Math.ceil(inv * (7.0 / denom) + 9.0)
  return Math.max(2, Math.min(16, pts))
}

/**
 * 安全提取队伍编号：兼容平铺整数及 FTC Official API v2.0 AllianceTeam 对象
 */
export function extractAllianceTeamNumber(ref: unknown): number {
  if (typeof ref === 'number' && Number.isFinite(ref)) {
    return ref > 0 ? Math.trunc(ref) : 0
  }
  if (typeof ref === 'string') {
    const parsed = Number.parseInt(ref.trim(), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  if (ref && typeof ref === 'object') {
    const obj = ref as Record<string, unknown>
    return extractAllianceTeamNumber(obj.teamNumber ?? obj.TeamNumber ?? obj.team)
  }
  return 0
}

/**
 * 计算选队联盟分 (Alliance Selection Results Points)
 * Table 4-1: 联盟队长与第 1 顺位选定队伍获 21 - Alliance Number 分
 */
export function calcAlliancePoints(seed: number, isCaptainOrPick: boolean, isSecondPick = false, totalAlliances = 4): number {
  if (seed <= 0) return 0
  if (isCaptainOrPick) {
    return Math.max(0, 21 - seed)
  }
  if (isSecondPick) {
    const n = totalAlliances > 0 ? totalAlliances : 4
    // 第二顺位选拔分（蛇形逆序：第 N 联盟为第 N+1 顺位，第 1 联盟为第 2N 顺位）
    return Math.max(0, 21 - (2 * n - seed + 1))
  }
  return 0
}

export function calcRound3AlliancePoints(seed: number, totalAlliances = 4): number {
  if (seed <= 0) return 0
  const n = totalAlliances > 0 ? totalAlliances : 4
  return Math.max(0, 21 - (2 * n + seed))
}

/**
 * 计算淘汰赛晋级分 (Playoff Advancement Points)
 * Table 4-1:
 * - 冠军 (Winners): 40 分
 * - 亚军 (Finalists): 20 分
 * - 季军 (3rd Place): 10 分
 * - 殿军 (4th Place): 5 分
 */
export function calcPlayoffPoints(playoffResult?: string | null): number {
  if (!playoffResult) return 0
  const res = playoffResult.trim().toUpperCase()
  if (res.includes('WIN') || res.includes('CHAMPION') || res === '1' || res === '1ST') {
    return 40
  }
  if ((res.includes('FINAL') && !res.includes('QUARTER') && !res.includes('SEMI')) || res.includes('RUNNER') || res === '2' || res === '2ND') {
    return 20
  }
  if (res.includes('3RD') || res.includes('THIRD') || res === '3') {
    return 10
  }
  if (res.includes('4TH') || res.includes('FOURTH') || res === '4') {
    return 5
  }
  return 0
}

export function isExcludedAwardName(lowerName: string): boolean {
  return lowerName.includes('dean') ||
    lowerName.includes('compass') ||
    lowerName.includes('promote') ||
    lowerName.includes('volunteer') ||
    lowerName.includes('safety')
}

export function isJudgedTeamAwardName(lowerName: string): boolean {
  return lowerName.includes('inspire') || lowerName.includes('启迪') ||
    lowerName.includes('think') || lowerName.includes('思考') ||
    lowerName.includes('connect') || lowerName.includes('连接') || lowerName.includes('联络') ||
    lowerName.includes('innovat') || lowerName.includes('创新') ||
    lowerName.includes('design') || lowerName.includes('设计') ||
    lowerName.includes('motivat') || lowerName.includes('激励') ||
    lowerName.includes('control') || lowerName.includes('控制') ||
    lowerName.includes('sustain') || lowerName.includes('持续') ||
    lowerName.includes('reach') || lowerName.includes('普及') || lowerName.includes('拓展') ||
    lowerName.includes('judge') || lowerName.includes('裁判')
}

/**
 * 计算评审团队奖项分 (Judged Team Award Points)
 * Table 4-1:
 * - 启迪奖 (Inspire Award): 1st=60, 2nd=30, 3rd=15
 * - 其他官方团队评审奖 (Think, Connect, Innovate, Design, Motivate, Control, Sustain, Reach, Judges' Choice):
 *   1st=12, 2nd=6, 3rd=3
 * - 个人奖项 (Dean's List) 及非团队奖项不计分
 */
export function calcAwardPoints(awardName?: string | null, series = 1): number {
  if (!awardName) return 0
  const name = awardName.trim().toLowerCase()

  // 过滤个人奖项与非晋级奖项
  if (isExcludedAwardName(name)) {
    return 0
  }

  let effectiveSeries = series > 0 ? series : 1
  if (effectiveSeries <= 1) {
    if (name.includes('2nd') || name.includes('second') || name.includes('finalist') || name.includes('第二') || name.includes('第2')) {
      effectiveSeries = 2
    } else if (name.includes('3rd') || name.includes('third') || name.includes('第三') || name.includes('第3')) {
      effectiveSeries = 3
    }
  }

  if (name.includes('inspire') || name.includes('启迪')) {
    if (effectiveSeries === 1) return 60
    if (effectiveSeries === 2) return 30
    if (effectiveSeries === 3) return 15
    return 0
  }

  if (isJudgedTeamAwardName(name)) {
    if (effectiveSeries === 1) return 12
    if (effectiveSeries === 2) return 6
    if (effectiveSeries === 3) return 3
  }

  return 0
}

interface TeamAccumulator {
  teamNumber: number
  qualRank: number
  advancementRank: number
  qualPoints: number
  alliancePoints: number
  playoffPoints: number
  awardPoints: number
  totalAdvancementPoints: number
  advancementStatus: AdvancementStatus
  officialStatus?: string
  declined?: boolean
  rolledDown?: boolean
  advancementSlot?: number
  advancementCriteria?: string
  advancesTo?: string
  tiebreakerSort1: number
  tiebreakerSort2: number
}

interface ParsedOfficialSlot {
  slot: number
  criteria: string
  declined: boolean
  rawStatus: string
  skippedStatus: AdvancementStatus | null
  isActiveFirst: boolean
}

function parseOfficialAdvancementMap(
  officialAdvancement?: OfficialAdvancementResponse | null
): { advancesTo: string; slotMap: Map<number, ParsedOfficialSlot>; officialFirstCount: number } {
  const advancesTo = (officialAdvancement?.advancesTo || '').trim()
  const slotMap = new Map<number, ParsedOfficialSlot>()
  const list: OfficialAdvancementSlot[] = Array.isArray(officialAdvancement?.advancement)
    ? officialAdvancement!.advancement!
    : []

  for (const item of list) {
    if (!item) continue
    const teamNum =
      typeof item.team === 'number' && Number.isFinite(item.team)
        ? item.team
        : Number.parseInt(String(item.displayTeam || ''), 10)
    if (!Number.isFinite(teamNum) || teamNum <= 0 || slotMap.has(teamNum)) continue

    const declined = Boolean(item.declined)
    let rawStatus = String(item.status || '').trim().toUpperCase()
    if (rawStatus === 'ALREADY_ADVANCED') rawStatus = 'ALREADY_ADVANCING'

    let skippedStatus: AdvancementStatus | null = null
    if (rawStatus === 'ALREADY_ADVANCING') skippedStatus = 'ALREADY_ADVANCING'
    else if (rawStatus === 'INELIGIBLE') skippedStatus = 'INELIGIBLE'
    else if (declined) skippedStatus = 'DECLINED'

    slotMap.set(teamNum, {
      slot: Number(item.slot) || 0,
      criteria: String(item.criteria || '').trim(),
      declined,
      rawStatus,
      skippedStatus,
      isActiveFirst: skippedStatus === null && rawStatus === 'FIRST'
    })
  }

  let officialFirstCount = 0
  for (const info of slotMap.values()) {
    if (info.isActiveFirst) officialFirstCount++
  }

  return { advancesTo, slotMap, officialFirstCount }
}

/**
 * 严格按照 FTC 官方竞赛规则实时汇算全部战队的晋级分与晋级状态（支持官方晋级列表与顺延）
 */
export function calculateAdvancement(
  officialRankings: OfficialRanking[] = [],
  officialAlliances: OfficialAlliance[] = [],
  officialAwards: OfficialAward[] = [],
  officialMatches: OfficialMatch[] = [],
  advancementSlots?: number,
  officialAdvancement?: OfficialAdvancementResponse | null,
  explicitSlotsOverride = false
): AdvancementDetail[] {
  const slots =
    advancementSlots && advancementSlots > 0
      ? advancementSlots
      : (officialAdvancement?.slots && officialAdvancement.slots > 0
          ? officialAdvancement.slots
          : DEFAULT_ADVANCEMENT_SLOTS)
  const teamMap = new Map<number, TeamAccumulator>()

  const totalTeams = officialRankings.length

  // 1. 资格赛表现分
  for (const r of officialRankings) {
    if (!r || r.teamNumber <= 0) continue
    const entry: TeamAccumulator = {
      teamNumber: r.teamNumber,
      qualRank: r.rank || 0,
      advancementRank: 0,
      qualPoints: calcQualPoints(r.rank, totalTeams),
      alliancePoints: 0,
      playoffPoints: 0,
      awardPoints: 0,
      totalAdvancementPoints: 0,
      advancementStatus: 'COMPETING',
      tiebreakerSort1: Number(r.sortOrder1) || 0,
      tiebreakerSort2: Number(r.sortOrder2) || 0
    }
    teamMap.set(r.teamNumber, entry)
  }

  // 2. 选队联盟分（兼容整型及 FTC Official API v2.0 AllianceTeam 对象）
  if (officialAlliances.length > 0) {
    let maxSeed = 0
    for (const a of officialAlliances) {
      if (a && a.number > maxSeed) maxSeed = a.number
    }
    const totalAlliances = officialAlliances.length >= 2
      ? Math.max(officialAlliances.length, maxSeed)
      : Math.max(4, maxSeed)

    for (const a of officialAlliances) {
      if (!a) continue
      const seed = a.number || 0
      const captain = extractAllianceTeamNumber(a.captain)
      const round1 = extractAllianceTeamNumber(a.round1)
      const round2 = extractAllianceTeamNumber(a.round2)
      const round3 = extractAllianceTeamNumber(a.round3)

      if (captain > 0) {
        let entry = teamMap.get(captain)
        if (!entry) {
          entry = createDefaultAccumulator(captain)
          teamMap.set(captain, entry)
        }
        entry.alliancePoints = calcAlliancePoints(seed, true, false, totalAlliances)
      }
      if (round1 > 0) {
        let entry = teamMap.get(round1)
        if (!entry) {
          entry = createDefaultAccumulator(round1)
          teamMap.set(round1, entry)
        }
        entry.alliancePoints = calcAlliancePoints(seed, true, false, totalAlliances)
      }
      if (round2 > 0) {
        let entry = teamMap.get(round2)
        if (!entry) {
          entry = createDefaultAccumulator(round2)
          teamMap.set(round2, entry)
        }
        entry.alliancePoints = calcAlliancePoints(seed, false, true, totalAlliances)
      }
      if (round3 > 0) {
        let entry = teamMap.get(round3)
        if (!entry) {
          entry = createDefaultAccumulator(round3)
          teamMap.set(round3, entry)
        }
        entry.alliancePoints = calcRound3AlliancePoints(seed, totalAlliances)
      }
    }
  }

  // 3. 淘汰赛晋级分计算 (结合 officialAwards 与 officialMatches)
  const officialWinnerTeams = new Set<number>()
  const officialFinalistTeams = new Set<number>()
  const official3rdPlaceTeams = new Set<number>()
  const official4thPlaceTeams = new Set<number>()

  for (const aw of officialAwards) {
    if (!aw || aw.teamNumber <= 0) continue
    const name = (aw.name || '').toLowerCase()
    if (isExcludedAwardName(name) || isJudgedTeamAwardName(name)) continue

    if (name.includes('winning alliance') || name.includes('获胜联盟') || name.includes('冠军联盟') || name.includes('优胜联盟') ||
      (!name.includes('semi') && !name.includes('quarter') && (name.includes('champion') || name.includes('winner')))) {
      officialWinnerTeams.add(aw.teamNumber)
    } else if (name.includes('finalist alliance') || name.includes('决赛联盟') || name.includes('亚军联盟') ||
      (!name.includes('semi') && !name.includes('quarter') && (name.includes('finalist') || name.includes('runner')))) {
      officialFinalistTeams.add(aw.teamNumber)
    } else if (name.includes('3rd') || name.includes('third') || name.includes('季军')) {
      official3rdPlaceTeams.add(aw.teamNumber)
    } else if (name.includes('4th') || name.includes('fourth') || name.includes('殿军')) {
      official4thPlaceTeams.add(aw.teamNumber)
    }
  }

  let isDoubleElim = false
  const finalsTeams = new Set<number>()
  const finalsWins = new Map<number, number>()
  const semifinalTeams = new Set<number>()
  const semifinalWins = new Map<number, number>()
  const nonFinalMaxSeries = new Map<number, number>()

  for (const m of officialMatches) {
    if (!m || (m.tournamentLevel || '').toUpperCase() !== 'PLAYOFF') continue
    if (!m.scores || !m.teams) continue

    const red = m.scores.red
    const blue = m.scores.blue
    if (!red || !blue) continue

    const redScore = red.finalScore ?? red.totalPointsNp ?? 0
    const blueScore = blue.finalScore ?? blue.totalPointsNp ?? 0
    const winningAlliance = redScore > blueScore ? 'red' : (blueScore > redScore ? 'blue' : 'tie')
    const matchNum = m.matchNum || 0
    const series = (m as any).series || 0
    const desc = ((m as any).description || '').toLowerCase()
    if (desc.includes('upper bracket') || desc.includes('lower bracket') || desc.includes('final bracket')) {
      isDoubleElim = true
    }
    const isFinals = desc.length > 0
      ? (!desc.includes('upper bracket') && !desc.includes('lower bracket') && !desc.includes('semi') && !desc.includes('quarter') && desc.includes('final'))
      : (series === 3 || (series === 0 && matchNum >= 5))

    const matchCompleted = (redScore > 0 || blueScore > 0) && winningAlliance !== 'tie'
    const bracketStep = series > 0 ? series : matchNum

    for (const t of m.teams) {
      if (!t || t.teamNumber <= 0) continue
      const alliance = (t.alliance || '').toLowerCase()
      const won = alliance === winningAlliance
      if (isFinals) {
        finalsTeams.add(t.teamNumber)
        if (matchCompleted && won) {
          finalsWins.set(t.teamNumber, (finalsWins.get(t.teamNumber) || 0) + 1)
        }
      } else {
        semifinalTeams.add(t.teamNumber)
        nonFinalMaxSeries.set(t.teamNumber, Math.max(nonFinalMaxSeries.get(t.teamNumber) || 0, bracketStep))
        if (matchCompleted && won) {
          semifinalWins.set(t.teamNumber, (semifinalWins.get(t.teamNumber) || 0) + 1)
        }
      }
    }
  }

  const playoffPtsMap = new Map<number, number>()

  // 1. 确定 Finals 队伍分值
  for (const tNum of officialWinnerTeams) {
    playoffPtsMap.set(tNum, 40)
  }
  for (const tNum of officialFinalistTeams) {
    playoffPtsMap.set(tNum, 20)
  }

  if (finalsTeams.size > 0) {
    let maxWins = 0
    for (const tNum of finalsTeams) {
      maxWins = Math.max(maxWins, finalsWins.get(tNum) || 0)
    }

    let hasDecisiveWinner = false
    if (maxWins > 0) {
      for (const other of finalsTeams) {
        if ((finalsWins.get(other) || 0) < maxWins) {
          hasDecisiveWinner = true
          break
        }
      }
    }

    for (const tNum of finalsTeams) {
      if (officialWinnerTeams.has(tNum)) {
        playoffPtsMap.set(tNum, 40)
      } else if (officialFinalistTeams.has(tNum)) {
        playoffPtsMap.set(tNum, 20)
      } else if (hasDecisiveWinner && (finalsWins.get(tNum) || 0) === maxWins) {
        playoffPtsMap.set(tNum, 40)
      } else {
        playoffPtsMap.set(tNum, 20)
      }
    }
  }

  // 2. 确定 Semifinals / 双败非决赛队伍分值
  let distinctLowerSeries: number[] = []
  if (isDoubleElim && finalsTeams.size > 0) {
    const stepSet = new Set<number>()
    for (const tNum of semifinalTeams) {
      if (!finalsTeams.has(tNum) && !officialWinnerTeams.has(tNum) && !officialFinalistTeams.has(tNum)) {
        stepSet.add(nonFinalMaxSeries.get(tNum) || 0)
      }
    }
    distinctLowerSeries = Array.from(stepSet).sort((a, b) => b - a)
  }

  for (const tNum of semifinalTeams) {
    if (finalsTeams.has(tNum) || officialWinnerTeams.has(tNum) || officialFinalistTeams.has(tNum)) {
      continue
    }

    if (official3rdPlaceTeams.has(tNum)) {
      playoffPtsMap.set(tNum, 10)
    } else if (official4thPlaceTeams.has(tNum)) {
      playoffPtsMap.set(tNum, 5)
    } else if (finalsTeams.size === 0) {
      const sfWins = semifinalWins.get(tNum) || 0
      playoffPtsMap.set(tNum, sfWins > 0 ? 20 : 5)
    } else if (isDoubleElim && distinctLowerSeries.length >= 2) {
      const tierIndex = distinctLowerSeries.indexOf(nonFinalMaxSeries.get(tNum) || 0)
      if (tierIndex === 0) {
        playoffPtsMap.set(tNum, 10)
      } else if (tierIndex === 1) {
        playoffPtsMap.set(tNum, 5)
      }
    } else {
      const sfWins = semifinalWins.get(tNum) || 0
      playoffPtsMap.set(tNum, sfWins > 0 ? 10 : 5)
    }
  }

  // 3. 补齐官方 3rd / 4th 奖项队伍
  for (const tNum of official3rdPlaceTeams) {
    if (!playoffPtsMap.has(tNum)) playoffPtsMap.set(tNum, 10)
  }
  for (const tNum of official4thPlaceTeams) {
    if (!playoffPtsMap.has(tNum)) playoffPtsMap.set(tNum, 5)
  }

  for (const [tNum, pts] of playoffPtsMap) {
    let entry = teamMap.get(tNum)
    if (!entry) {
      entry = createDefaultAccumulator(tNum)
      teamMap.set(tNum, entry)
    }
    entry.playoffPoints = pts
  }

  // 4. 评审奖项分
  for (const aw of officialAwards) {
    if (!aw || aw.teamNumber <= 0) continue
    const pts = calcAwardPoints(aw.name, aw.series)
    if (pts > 0) {
      let entry = teamMap.get(aw.teamNumber)
      if (!entry) {
        entry = createDefaultAccumulator(aw.teamNumber)
        teamMap.set(aw.teamNumber, entry)
      }
      // Rule A215: 单支队伍每站仅取最高一项评审奖项积分
      entry.awardPoints = Math.max(entry.awardPoints, pts)
    }
  }

  // 5. 汇算总分并按 Table 4-2 规则排序
  const entries = Array.from(teamMap.values())
  for (const e of entries) {
    e.totalAdvancementPoints = e.qualPoints + e.alliancePoints + e.playoffPoints + e.awardPoints
  }

  entries.sort((a, b) => {
    // 1. 总晋级分降序 (Total Advancement Points)
    if (a.totalAdvancementPoints !== b.totalAdvancementPoints) {
      return b.totalAdvancementPoints - a.totalAdvancementPoints
    }
    // 2. 评审奖项分降序 (Judged Team Award Points)
    if (a.awardPoints !== b.awardPoints) {
      return b.awardPoints - a.awardPoints
    }
    // 3. 淘汰赛表现分降序 (Playoff Advancement Points)
    if (a.playoffPoints !== b.playoffPoints) {
      return b.playoffPoints - a.playoffPoints
    }
    // 4. 选队结果分降序 (Alliance Selection Results Points)
    if (a.alliancePoints !== b.alliancePoints) {
      return b.alliancePoints - a.alliancePoints
    }
    // 5. 资格赛表现分降序 (Qualification Phase Performance Points)
    if (a.qualPoints !== b.qualPoints) {
      return b.qualPoints - a.qualPoints
    }
    // 6. 平均比赛得分 (sortOrder1)
    if (a.tiebreakerSort1 !== b.tiebreakerSort1) {
      return b.tiebreakerSort1 - a.tiebreakerSort1
    }
    // 7. Tiebreaker 2 (sortOrder2)
    if (a.tiebreakerSort2 !== b.tiebreakerSort2) {
      return b.tiebreakerSort2 - a.tiebreakerSort2
    }
    return a.teamNumber - b.teamNumber
  })

  // 6. 结合 FTC 官方晋级列表与顺延状态确定最终晋级排位和状态
  const { advancesTo, slotMap, officialFirstCount } = parseOfficialAdvancementMap(officialAdvancement)
  const skippedTeams = new Set<number>()

  let rankIdx = 0
  for (const e of entries) {
    rankIdx += 1
    e.advancementRank = rankIdx
    e.rolledDown = false
    if (advancesTo) e.advancesTo = advancesTo

    const info = slotMap.get(e.teamNumber)
    if (info) {
      e.declined = info.declined
      if (info.slot > 0) e.advancementSlot = info.slot
      if (info.criteria) e.advancementCriteria = info.criteria
      e.officialStatus = info.rawStatus || (info.declined ? 'DECLINED' : undefined)
      if (info.skippedStatus) {
        e.advancementStatus = info.skippedStatus
        skippedTeams.add(e.teamNumber)
      }
    }
  }

  let activeAssigned = 0
  if (!explicitSlotsOverride && officialFirstCount > 0) {
    for (const e of entries) {
      if (skippedTeams.has(e.teamNumber)) continue
      const info = slotMap.get(e.teamNumber)
      if (info?.isActiveFirst && activeAssigned < slots) {
        e.advancementStatus = 'ADVANCING'
        e.rolledDown = ((e.advancementSlot ?? 0) > slots) || (e.advancementRank > slots)
        activeAssigned++
      }
    }
  }

  for (const e of entries) {
    if (activeAssigned >= slots) break
    if (skippedTeams.has(e.teamNumber) || e.advancementStatus === 'ADVANCING') continue
    e.advancementStatus = 'ADVANCING'
    e.rolledDown = ((e.advancementSlot ?? 0) > slots) || (e.advancementRank > slots)
    activeAssigned++
  }

  let bubbleCount = 0
  for (const e of entries) {
    if (skippedTeams.has(e.teamNumber) || e.advancementStatus === 'ADVANCING') continue
    if (bubbleCount < 2) {
      e.advancementStatus = 'BUBBLE'
      bubbleCount++
    } else {
      e.advancementStatus = 'COMPETING'
    }
  }

  return entries.map((e) => {
    const detail: AdvancementDetail = {
      teamNumber: e.teamNumber,
      advancementRank: e.advancementRank,
      totalAdvancementPoints: e.totalAdvancementPoints,
      qualRank: e.qualRank,
      qualPoints: e.qualPoints,
      alliancePoints: e.alliancePoints,
      playoffPoints: e.playoffPoints,
      awardPoints: e.awardPoints,
      advancementStatus: e.advancementStatus,
      rolledDown: Boolean(e.rolledDown),
      breakdown: {
        qualPoints: e.qualPoints,
        alliancePoints: e.alliancePoints,
        playoffPoints: e.playoffPoints,
        awardPoints: e.awardPoints
      }
    }
    if (e.declined) detail.declined = true
    if (e.officialStatus) detail.officialStatus = e.officialStatus
    if (e.advancementSlot) detail.advancementSlot = e.advancementSlot
    if (e.advancementCriteria) detail.advancementCriteria = e.advancementCriteria
    if (e.advancesTo) detail.advancesTo = e.advancesTo
    return detail
  })
}

function createDefaultAccumulator(teamNumber: number): TeamAccumulator {
  return {
    teamNumber,
    qualRank: 0,
    advancementRank: 0,
    qualPoints: 0,
    alliancePoints: 0,
    playoffPoints: 0,
    awardPoints: 0,
    totalAdvancementPoints: 0,
    advancementStatus: 'COMPETING',
    tiebreakerSort1: 0,
    tiebreakerSort2: 0
  }
}

export function buildAdvancementMap(details: AdvancementDetail[]): Map<number, AdvancementDetail> {
  const map = new Map<number, AdvancementDetail>()
  for (const d of details) {
    map.set(d.teamNumber, d)
  }
  return map
}
