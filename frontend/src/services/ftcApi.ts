import type { OfficialMatch } from '@/types'
import { fetchFtcMatches } from '@/services/api'

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
