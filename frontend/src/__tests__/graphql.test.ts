import { describe, it, expect } from 'vitest'
import { fetchEventMatches } from '@/services/graphql'

describe('GraphQL API', () => {
  it('should fetch matches for event CNCMPLB', async () => {
    // Increase timeout since this is a real network request
    const matches = await fetchEventMatches('CNCMPLB')
    
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
