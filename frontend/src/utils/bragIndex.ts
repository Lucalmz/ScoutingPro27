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
      hangUnfulfilled: false,
      label: '⏳ 待实测'
    }
  }

  const maxTotalScore = Math.max(...validMatches.map((r) => r.totalScore || 0), 0)
  const avgTotalScore = validMatches.reduce((s, r) => s + (r.totalScore || 0), 0) / validMatches.length
  const maxAutoScore = Math.max(...validMatches.map((r) => r.autoScore || 0), 0)
  const maxTeleopScore = Math.max(...validMatches.map((r) => r.teleopScore || 0), 0)
  const maxEndgameScore = Math.max(...validMatches.map((r) => r.endgameScore || 0), 0)

  // 1. 总分吹牛倍率 (综合实际最高分与带 5% 浮动的平均分)
  const totalBaseline = Math.max(maxTotalScore, avgTotalScore * 1.05, 1)
  const overallRatio = claimed.claimedTotalScore > 0
    ? Number((claimed.claimedTotalScore / totalBaseline).toFixed(2))
    : 1.0

  // 2. 自主吹牛倍率
  const autoRatio = claimed.claimedAutoScore > 0
    ? Number((claimed.claimedAutoScore / Math.max(maxAutoScore, 1)).toFixed(2))
    : 1.0

  // 3. 手动吹牛倍率
  const teleopRatio = claimed.claimedTeleopScore > 0
    ? Number((claimed.claimedTeleopScore / Math.max(maxTeleopScore, 1)).toFixed(2))
    : 1.0

  // 4. 悬挂与高难机构履约核验 (自述能上高杠 Level 2/3，FTC 终局高悬挂一般 >= 15 分)
  // 【特赦核心逻辑】：高悬挂结构（如单向棘轮卷扬、级联滑轨）在赛场复位极其耗时繁琐，
  // 1) 只要在比赛中有至少 1 次标注成功（打出过一次高悬挂 >= 15 分），即铁证如山：证明战队具备该硬件实力，绝未说谎！
  // 2) 若打满多场（>= 2场）但在常规赛暂未挂出（0次），属于典型“结构难复位常规赛留力”，予以特赦免责，不直接降级为吹牛。
  const claimsHighHang = claimed.claimedEndgameHangLevel >= 2
  const hangVerified = claimsHighHang && maxEndgameScore >= 15
  const hangUnfulfilled = claimsHighHang && validMatches.length >= 2 && maxEndgameScore < 15
  const hangPardoned = hangUnfulfilled // 针对高悬挂难复位特赦免责

  // 5. 判定档位（以赛场实际展现的峰值上限与产出比率为准）
  let tier: BragTier = 'realistic'
  let label = `${overallRatio}x 真实守信 🎯`

  if (overallRatio > 2.0) {
    tier = 'mythical'
    label = `${overallRatio}x 吹破牛皮 🔥`
  } else if (overallRatio > 1.45) {
    tier = 'overclaimed'
    label = `${overallRatio}x 夸大其词 ⚠️`
  } else if (overallRatio > 1.15) {
    tier = 'optimistic'
    label = `${overallRatio}x 略偏乐观 🟡`
  } else {
    tier = 'realistic'
    label = `${overallRatio}x 真实守信 🎯`
  }

  // 标注状态修饰
  if (hangVerified) {
    label += ' (高杠已证实 🧗)'
  } else if (hangPardoned) {
    label += ' (高挂待验证 🧗)'
  }

  return {
    tier,
    overallRatio,
    autoRatio,
    teleopRatio,
    hangUnfulfilled,
    hangPardoned,
    hangVerified,
    label
  }
}
