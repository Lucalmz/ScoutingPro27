import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchEventMatches } from '@/services/ftcApi'
import * as api from '@/services/api'
import type { OfficialMatch } from '@/types'

vi.mock('@/services/api', () => ({
  fetchFtcMatches: vi.fn(),
  fetchFtcScores: vi.fn()
}))

describe('FTC Events Official API Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return empty array for empty season or eventCode', async () => {
    const res1 = await fetchEventMatches(0, 'CNCMPLB')
    expect(res1).toEqual([])

    const res2 = await fetchEventMatches(2025, '')
    expect(res2).toEqual([])
  })

  it('should fetch and return official matches with penalty and np scores', async () => {
    const mockMatches: OfficialMatch[] = [
      {
        matchNum: 1,
        scores: {
          red: {
            penaltyPointsCommitted: 5,
            totalPointsNp: 136
          },
          blue: {
            penaltyPointsCommitted: 15,
            totalPointsNp: 152
          }
        },
        teams: [
          { teamNumber: 19666, alliance: 'Red' },
          { teamNumber: 30319, alliance: 'Red' },
          { teamNumber: 25720, alliance: 'Blue' },
          { teamNumber: 19705, alliance: 'Blue' }
        ]
      }
    ]

    vi.mocked(api.fetchFtcMatches).mockResolvedValue(mockMatches)

    const matches = await fetchEventMatches(2025, 'CNCMPLB')

    expect(api.fetchFtcMatches).toHaveBeenCalledWith(2025, 'CNCMPLB')
    expect(matches).toHaveLength(1)
    expect(matches[0].matchNum).toBe(1)
    expect(matches[0].scores?.red.penaltyPointsCommitted).toBe(5)
    expect(matches[0].scores?.red.totalPointsNp).toBe(136)
    expect(matches[0].scores?.blue.penaltyPointsCommitted).toBe(15)
    expect(matches[0].scores?.blue.totalPointsNp).toBe(152)
    expect(matches[0].teams).toHaveLength(4)
  })

  it('should handle API errors gracefully and return empty array', async () => {
    vi.mocked(api.fetchFtcMatches).mockRejectedValue(new Error('Network error or event not found'))

    const matches = await fetchEventMatches(2025, 'INVALID_EVENT')
    expect(matches).toEqual([])
  })
})
