import type { PitScoutingRecord, ScoutingRecord, BragInfo, BragTier } from '@/types'
import { i18n } from '@/i18n'

interface ParsedMatchEndgame {
  didFlower: boolean
  didPark: boolean
}

function translate(key: string, params?: Record<string, unknown>): string {
  try {
    if (i18n?.global?.t) {
      return String(params ? i18n.global.t(key, params) : i18n.global.t(key))
    }
  } catch {
    // Fallback to key if i18n is unavailable in isolated test runners
  }
  return key
}

function isNoneFlowerMech(mech?: string): boolean {
  const normalized = (mech || '').trim().toLowerCase()
  return !normalized || normalized === 'none' || normalized === '无' || normalized === 'n/a'
}

function parseMatchEndgame(rawData?: string): ParsedMatchEndgame {
  if (!rawData || typeof rawData !== 'string') {
    return { didFlower: false, didPark: false }
  }
  try {
    const parsed = JSON.parse(rawData)
    if (!parsed || typeof parsed !== 'object') {
      return { didFlower: false, didPark: false }
    }
    const didFlower =
      Number(parsed.flowerNectars || 0) > 0 ||
      Number(parsed.flowerBottomBonusCount || 0) > 0 ||
      parsed.flowerPlaced === true ||
      parsed.flowerBottomBonus === true
    const didPark = parsed.teleopPark === true
    return { didFlower, didPark }
  } catch {
    return { didFlower: false, didPark: false }
  }
}

function buildPendingResult(labelKey: string): BragInfo {
  return {
    tier: 'pending',
    overallRatio: 1.0,
    autoRatio: 1.0,
    teleopRatio: 1.0,
    endgameRatio: 1.0,
    endgameUnfulfilled: false,
    endgamePardoned: false,
    endgameVerified: false,
    flowerVerified: false,
    flowerPending: false,
    parkVerified: false,
    parkPending: false,
    statusKeys: [],
    labelKey,
    hangUnfulfilled: false,
    hangPardoned: false,
    hangVerified: false,
    label: translate(labelKey)
  }
}

/**
 * 战队"吹牛指数" (Brag Index) 自动化计算工具
 * 将展位自述量化数据 (claimed) 与赛场实际排位赛表现 (actualMatches) 进行多维对账 (BIOBUZZ 2026-2027)
 */
export function calculateBragIndex(
  claimed?: PitScoutingRecord | null,
  actualMatches: ScoutingRecord[] = []
): BragInfo | undefined {
  if (!claimed) {
    return undefined
  }

  const validMatches = actualMatches.filter((r) => !r.isDeleted)

  // 尚未登场打比赛
  if (validMatches.length === 0) {
    return buildPendingResult('pit_scout.brag_pending_matches')
  }

  // 未填写自述得分
  if (!claimed.claimedTotalScore || claimed.claimedTotalScore <= 0) {
    return buildPendingResult('pit_scout.brag_pending_claims')
  }

  // 过滤机械/断电故障场次（若存在正常场次则排除 isBroken 干扰；若全为故障场次则保留作为参考）
  const normalMatches = validMatches.filter((r) => !r.isBroken)
  const evalMatches = normalMatches.length > 0 ? normalMatches : validMatches

  const maxTotalScore = Math.max(...evalMatches.map((r) => r.totalScore || 0), 0)
  const avgTotalScore = evalMatches.reduce((s, r) => s + (r.totalScore || 0), 0) / evalMatches.length
  const maxAutoScore = Math.max(...evalMatches.map((r) => r.autoScore || 0), 0)
  const maxTeleopScore = Math.max(...evalMatches.map((r) => r.teleopScore || 0), 0)
  const maxEndgameScore = Math.max(...evalMatches.map((r) => r.endgameScore || 0), 0)

  // 1. 总分吹牛倍率 (综合实际最高分与带 5% 浮动的平均分)
  const totalBaseline = Math.max(maxTotalScore, avgTotalScore * 1.05, 1)
  const overallRatio = Number((claimed.claimedTotalScore / totalBaseline).toFixed(2))

  // 2. 自主吹牛倍率
  const autoRatio = claimed.claimedAutoScore > 0
    ? Number((claimed.claimedAutoScore / Math.max(maxAutoScore, 1)).toFixed(2))
    : 1.0

  // 3. 手动吹牛倍率
  const teleopRatio = claimed.claimedTeleopScore > 0
    ? Number((claimed.claimedTeleopScore / Math.max(maxTeleopScore, 1)).toFixed(2))
    : 1.0

  // 4. 终局吹牛倍率
  const claimedEndgame = claimed.claimedEndgameScore || 0
  const endgameRatio = claimedEndgame > 0
    ? Number((claimedEndgame / Math.max(maxEndgameScore, 1)).toFixed(2))
    : 1.0

  // 5. BIOBUZZ 真实 rawData 履约核验（花朵投放与终局停泊，不依赖总分 >= 10 猜测）
  const validParsed = validMatches.map((m) => parseMatchEndgame(m.rawData))
  const evalParsed = evalMatches.map((m) => parseMatchEndgame(m.rawData))

  const claimsFlower =
    !isNoneFlowerMech(claimed.flowerMechanism) ||
    (claimed.claimedFlowerNectars ?? 0) > 0 ||
    (claimed.claimedFlowerBottomBonus ?? 0) > 0

  const actualFlowerMatches = validParsed.filter((p) => p.didFlower).length
  const flowerVerified = claimsFlower && actualFlowerMatches > 0
  const flowerPending = claimsFlower && !flowerVerified
  const endgameUnfulfilled = claimsFlower && !flowerVerified && validMatches.length >= 2
  const endgamePardoned = endgameUnfulfilled
  const endgameVerified = flowerVerified

  const claimsPark = Boolean(claimed.claimedTeleopPark)
  const actualParkMatches = evalParsed.filter((p) => p.didPark).length
  const parkRate = evalMatches.length > 0 ? actualParkMatches / evalMatches.length : 0
  const parkVerified = claimsPark && actualParkMatches > 0 && parkRate >= 0.5
  const parkPending = claimsPark && !parkVerified

  // 6. 判定档位
  let tier: BragTier = 'realistic'
  if (overallRatio > 2.2) {
    tier = 'mythical'
  } else if (overallRatio > 1.65) {
    tier = 'overclaimed'
  } else if (overallRatio > 1.25) {
    tier = 'optimistic'
  }

  const labelKey = `pit_scout.brag_tiers.${tier}`
  const statusKeys: string[] = []
  if (flowerVerified) {
    statusKeys.push('pit_scout.flower_verified')
  } else if (flowerPending) {
    statusKeys.push('pit_scout.flower_pending_verify')
  }
  if (parkVerified) {
    statusKeys.push('pit_scout.park_verified')
  } else if (parkPending) {
    statusKeys.push('pit_scout.park_pending')
  }

  const tierText = translate(labelKey)
  let label = translate('pit_scout.brag_label_format', { ratio: overallRatio, tier: tierText })
  if (statusKeys.length > 0) {
    const statusText = statusKeys.map((k) => translate(k)).join(' · ')
    label += ` (${statusText})`
  }

  return {
    tier,
    overallRatio,
    autoRatio,
    teleopRatio,
    endgameRatio,
    endgameUnfulfilled,
    endgamePardoned,
    endgameVerified,
    flowerVerified,
    flowerPending,
    parkVerified,
    parkPending,
    statusKeys,
    labelKey,
    hangUnfulfilled: endgameUnfulfilled,
    hangPardoned: endgamePardoned,
    hangVerified: endgameVerified,
    label
  }
}
