import { describe, it, expect } from 'vitest'
import { fetchEventMatches } from '@/services/graphql'

describe('GraphQL API', () => {
  it('should fetch matches for event CNCMPLB', async () => {
    // 2025 season, CNCMPLB event code
    const matches = await fetchEventMatches(2025, 'CNCMPLB')
    
    expect(Array.isArray(matches)).toBe(true)
    expect(matches.length).toBeGreaterThan(0)
    
    // Check structure of first match
    const firstMatch = matches[0]
    expect(firstMatch).toHaveProperty('matchNum')
    expect(firstMatch).toHaveProperty('scores')
    expect(firstMatch).toHaveProperty('teams')
    expect(Array.isArray(firstMatch.teams)).toBe(true)
  }, 10000)
})
