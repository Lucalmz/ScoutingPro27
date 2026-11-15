import type { OfficialMatch, OfficialRanking, AdvancementDetail } from '@/types'
import { fetchFtcMatches, fetchFtcRankings, fetchFtcAdvancement } from '@/services/api'

/**
 * 获取官方比赛场次与比分数据
 * 请求统一走 Java 后端安全代理，避免浏览器端 CORS 限制与 Token 明文泄漏。
 */
export async function fetchEventMatches(season: number, eventCode: string): Promise<OfficialMatch[]> {
  if (!season || !eventCode) {
    return []
  }

  try {
    const matches = await fetchFtcMatches(season, eventCode.trim())
    return Array.isArray(matches) ? matches : []
  } catch (e: any) {
    console.error(`[FTC API] Failed to fetch matches for season ${season} event ${eventCode}:`, e)
    return []
  }
}

/**
 * 获取官方排位数据
 */
export async function fetchEventRankings(season: number, eventCode: string): Promise<OfficialRanking[]> {
  if (!season || !eventCode) {
    return []
  }

  try {
    const rankings = await fetchFtcRankings(season, eventCode.trim())
    return Array.isArray(rankings) ? rankings : []
  } catch (e: any) {
    console.error(`[FTC API] Failed to fetch rankings for season ${season} event ${eventCode}:`, e)
    return []
  }
}

/**
 * 实时获取/计算战队晋级分与晋级状态
 */
export async function fetchEventAdvancement(season: number, eventCode: string): Promise<AdvancementDetail[]> {
  if (!season || !eventCode) {
    return []
  }

  try {
    const advancement = await fetchFtcAdvancement(season, eventCode.trim())
    return Array.isArray(advancement) ? advancement : []
  } catch (e: any) {
    console.error(`[FTC API] Failed to fetch advancement for season ${season} event ${eventCode}:`, e)
    return []
  }
}
