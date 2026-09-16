import type { PitScoutingRecord, ScoutingRecord, BragInfo, BragTier } from '@/types'

/**
 * 战队"吹牛指数" (Brag Index) 自动化计算工具
 * 将展位自述标准量化数据 (claimed) 与赛场实际排位赛表现 (actualMatches) 进行多维对账
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
    return {
      tier: 'pending',
      overallRatio: 1.0,
      autoRatio: 1.0,
      teleopRatio: 1.0,
      endgameUnfulfilled: false,
      hangUnfulfilled: false,
      label: '待实测'
    }
  }

  // 未填写自述得分
  if (!claimed.claimedTotalScore || claimed.claimedTotalScore <= 0) {
    return {
      tier: 'pending',
      overallRatio: 1.0,
      autoRatio: 1.0,
      teleopRatio: 1.0,
      endgameUnfulfilled: false,
      hangUnfulfilled: false,
      label: '自述待补充'
    }
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

  // 4. 残局与高难花朵机构履约核验 (BIOBUZZ 2026-2027: 花朵放置 10-15 分, 停靠 5 分)
  const claimedEndgame = claimed.claimedEndgameScore || 0
  const claimsFlower = claimedEndgame >= 10
  const endgameVerified = claimsFlower && maxEndgameScore >= 10
  const endgameUnfulfilled = claimsFlower && validMatches.length >= 2 && maxEndgameScore < 10
  const endgamePardoned = endgameUnfulfilled // 针对花朵机构策略性留力特赦免责

  // 5. 判定档位（以赛场实际展现的峰值上限与产出比率为准，放宽阈值以包容赛场正常波动与最佳成绩自报）
  let tier: BragTier = 'realistic'
  let label = `${overallRatio}x 真实守信`

  if (overallRatio > 2.2) {
    tier = 'mythical'
    label = `${overallRatio}x 吹破牛皮`
  } else if (overallRatio > 1.65) {
    tier = 'overclaimed'
    label = `${overallRatio}x 夸大其词`
  } else if (overallRatio > 1.25) {
    tier = 'optimistic'
    label = `${overallRatio}x 略偏乐观`
  } else {
    tier = 'realistic'
    label = `${overallRatio}x 真实守信`
  }

  // 标注状态修饰
  if (endgameVerified) {
    label += ' (花朵已证实)'
  } else if (endgamePardoned) {
    label += ' (花朵待验证)'
  }

  return {
    tier,
    overallRatio,
    autoRatio,
    teleopRatio,
    endgameUnfulfilled,
    endgamePardoned,
    endgameVerified,
    hangUnfulfilled: endgameUnfulfilled,
    hangPardoned: endgamePardoned,
    hangVerified: endgameVerified,
    label
  }
}
