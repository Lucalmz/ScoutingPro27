import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchEventMatches, fetchEventRankings, fetchEventAdvancement } from '@/services/ftcApi'
import * as api from '@/services/api'
import type { OfficialMatch, OfficialRanking, AdvancementDetail } from '@/types'

vi.mock('@/services/api', () => ({
  fetchFtcMatches: vi.fn(),
  fetchFtcScores: vi.fn(),
  fetchFtcRankings: vi.fn(),
  fetchFtcAdvancement: vi.fn()
}))

describe('FTC Events Official API Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty arrays for missing season or eventCode without calling API', async () => {
    expect(await fetchEventMatches(0, 'CNCMPLB')).toEqual([])
    expect(await fetchEventMatches(2025, '')).toEqual([])
    expect(await fetchEventRankings(0, 'CNCMPLB')).toEqual([])
    expect(await fetchEventRankings(2025, '')).toEqual([])
    expect(await fetchEventAdvancement(0, 'CNCMPLB')).toEqual([])
    expect(await fetchEventAdvancement(2025, '')).toEqual([])
    expect(api.fetchFtcMatches).not.toHaveBeenCalled()
    expect(api.fetchFtcRankings).not.toHaveBeenCalled()
    expect(api.fetchFtcAdvancement).not.toHaveBeenCalled()
  })

  it('fetches and trims eventCode for matches, rankings, and advancement', async () => {
    const mockMatches: OfficialMatch[] = [
      {
        matchNum: 1,
        scores: {
          red: { penaltyPointsCommitted: 5, totalPointsNp: 136 },
          blue: { penaltyPointsCommitted: 15, totalPointsNp: 152 }
        },
        teams: [
          { teamNumber: 19666, alliance: 'Red' },
          { teamNumber: 30319, alliance: 'Red' },
          { teamNumber: 25720, alliance: 'Blue' },
          { teamNumber: 19705, alliance: 'Blue' }
        ]
      }
    ]
    const mockRankings: OfficialRanking[] = [
      { rank: 1, teamNumber: 27570, sortOrder1: 140, sortOrder2: 120, wins: 5, losses: 0, ties: 0, qualMatchesPlayed: 5 }
    ]
    const mockAdvancement: AdvancementDetail[] = [
      { teamNumber: 27570, advancementRank: 1, totalAdvancementPoints: 136, advancementStatus: 'ADVANCING' } as any
    ]

    vi.mocked(api.fetchFtcMatches).mockResolvedValue(mockMatches)
    vi.mocked(api.fetchFtcRankings).mockResolvedValue(mockRankings)
    vi.mocked(api.fetchFtcAdvancement).mockResolvedValue(mockAdvancement)

    const matches = await fetchEventMatches(2025, '  CNCMPLB  ')
    expect(api.fetchFtcMatches).toHaveBeenCalledWith(2025, 'CNCMPLB')
    expect(matches).toHaveLength(1)
    expect(matches[0].scores?.red.totalPointsNp).toBe(136)

    const rankings = await fetchEventRankings(2025, '  CNCMPLB ')
    expect(api.fetchFtcRankings).toHaveBeenCalledWith(2025, 'CNCMPLB')
    expect(rankings).toEqual(mockRankings)

    const advancement = await fetchEventAdvancement(2025, ' CNCMPLB\t')
    expect(api.fetchFtcAdvancement).toHaveBeenCalledWith(2025, 'CNCMPLB')
    expect(advancement).toEqual(mockAdvancement)
  })

  it('guards against non-array payloads and API errors across all three endpoints', async () => {
    vi.mocked(api.fetchFtcMatches).mockResolvedValue({ unexpected: true } as any)
    vi.mocked(api.fetchFtcRankings).mockResolvedValue(null as any)
    vi.mocked(api.fetchFtcAdvancement).mockResolvedValue('invalid' as any)

    expect(await fetchEventMatches(2025, 'CNCMPLB')).toEqual([])
    expect(await fetchEventRankings(2025, 'CNCMPLB')).toEqual([])
    expect(await fetchEventAdvancement(2025, 'CNCMPLB')).toEqual([])

    vi.mocked(api.fetchFtcMatches).mockRejectedValue(new Error('Network error'))
    vi.mocked(api.fetchFtcRankings).mockRejectedValue(new Error('500'))
    vi.mocked(api.fetchFtcAdvancement).mockRejectedValue(new Error('Timeout'))

    expect(await fetchEventMatches(2025, 'INVALID')).toEqual([])
    expect(await fetchEventRankings(2025, 'INVALID')).toEqual([])
    expect(await fetchEventAdvancement(2025, 'INVALID')).toEqual([])
  })
})
