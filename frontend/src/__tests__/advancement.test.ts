import { describe, it, expect } from 'vitest'
import {
  erf,
  invErf,
  calcQualPoints,
  calcAlliancePoints,
  calcPlayoffPoints,
  calcAwardPoints,
  calculateAdvancement,
  buildAdvancementMap
} from '@/utils/analytics/advancement'
import type {
  OfficialRanking,
  OfficialAlliance,
  OfficialAward,
  OfficialMatch,
  OfficialAdvancementResponse
} from '@/types'

describe('FTC Official Advancement Points Calculator', () => {
  describe('Mathematical Foundation: erf and invErf', () => {
    it('computes erf with high accuracy', () => {
      expect(erf(0)).toBe(0)
      expect(Math.abs(erf(0.5) - 0.5204998778)).toBeLessThan(1e-4)
      expect(Math.abs(erf(1.0) - 0.8427007929)).toBeLessThan(1e-4)
      expect(erf(-0.5)).toBe(-erf(0.5))
    })

    it('computes invErf across standard domain and boundary limits', () => {
      expect(invErf(0)).toBe(0)
      expect(invErf(1)).toBe(Infinity)
      expect(invErf(-1)).toBe(-Infinity)

      // Inverse of erf(x) should yield x
      const x = 0.65
      const y = erf(x)
      expect(Math.abs(invErf(y) - x)).toBeLessThan(1e-4)

      // invErf(1 / 1.07) ~ 1.30275
      const invAlpha = invErf(1 / 1.07)
      expect(Math.abs(invAlpha - 1.30275)).toBeLessThan(1e-3)
    })
  })

  describe('Qualification Phase Performance Points (Table 4-1 Normal Distribution)', () => {
    it('bounds points strictly between 2 and 16 points', () => {
      for (let N = 2; N <= 48; N += 5) {
        for (let R = 1; R <= N; R++) {
          const pts = calcQualPoints(R, N)
          expect(pts).toBeGreaterThanOrEqual(2)
          expect(pts).toBeLessThanOrEqual(16)
        }
      }
    })

    it('awards Rank 1 exactly 16 points for any field size', () => {
      expect(calcQualPoints(1, 1)).toBe(16)
      expect(calcQualPoints(1, 10)).toBe(16)
      expect(calcQualPoints(1, 24)).toBe(16)
      expect(calcQualPoints(1, 40)).toBe(16)
    })

    it('exhibits monotonic non-increasing behavior across ranks', () => {
      const N = 32
      let prev = 16
      for (let r = 1; r <= N; r++) {
        const pts = calcQualPoints(r, N)
        expect(pts).toBeLessThanOrEqual(prev)
        prev = pts
      }
    })

    it('handles edge and invalid inputs safely', () => {
      expect(calcQualPoints(0, 24)).toBe(0)
      expect(calcQualPoints(-1, 24)).toBe(0)
      expect(calcQualPoints(1, 0)).toBe(0)
      expect(calcQualPoints(1, -5)).toBe(0)
    })
  })

  describe('Alliance Selection Results Points', () => {
    it('awards 21 - seed for Captains and Pick 1', () => {
      expect(calcAlliancePoints(1, true, false)).toBe(20)
      expect(calcAlliancePoints(2, true, false)).toBe(19)
      expect(calcAlliancePoints(3, true, false)).toBe(18)
      expect(calcAlliancePoints(4, true, false)).toBe(17)
    })

    it('awards correct points for 2nd picks in snake draft', () => {
      expect(calcAlliancePoints(4, false, true)).toBe(16)
      expect(calcAlliancePoints(3, false, true)).toBe(15)
      expect(calcAlliancePoints(2, false, true)).toBe(14)
      expect(calcAlliancePoints(1, false, true)).toBe(13)
    })

    it('awards 0 points for unselected teams', () => {
      expect(calcAlliancePoints(0, false, false)).toBe(0)
      expect(calcAlliancePoints(5, false, false)).toBe(0)
    })
  })

  describe('Playoff Advancement Points', () => {
    it('awards correct points for Winners, Finalists, 3rd and 4th place', () => {
      expect(calcPlayoffPoints('WINNER')).toBe(40)
      expect(calcPlayoffPoints('Winning Alliance')).toBe(40)
      expect(calcPlayoffPoints('CHAMPION')).toBe(40)

      expect(calcPlayoffPoints('FINALIST')).toBe(20)
      expect(calcPlayoffPoints('Finalist Alliance')).toBe(20)

      expect(calcPlayoffPoints('3RD')).toBe(10)
      expect(calcPlayoffPoints('3rd Place')).toBe(10)

      expect(calcPlayoffPoints('4TH')).toBe(5)
      expect(calcPlayoffPoints('4th Place')).toBe(5)

      // Excludes quarterfinalists or unselected
      expect(calcPlayoffPoints('QUARTERFINALIST')).toBe(0)
      expect(calcPlayoffPoints(null)).toBe(0)
    })
  })

  describe('Judged Team Award Points', () => {
    it('awards 60/30/15 for Inspire Award places 1, 2, 3', () => {
      expect(calcAwardPoints('Inspire Award', 1)).toBe(60)
      expect(calcAwardPoints('Inspire Award', 2)).toBe(30)
      expect(calcAwardPoints('Inspire Award', 3)).toBe(15)
      expect(calcAwardPoints('Inspire Award', 4)).toBe(0)
    })

    it('awards 12/6/3 for official judged awards places 1, 2, 3', () => {
      expect(calcAwardPoints('Think Award', 1)).toBe(12)
      expect(calcAwardPoints('Connect Award', 2)).toBe(6)
      expect(calcAwardPoints('Innovate Award sponsored by Raytheon', 3)).toBe(3)
      expect(calcAwardPoints('Design Award', 1)).toBe(12)
      expect(calcAwardPoints('Motivate Award', 1)).toBe(12)
      expect(calcAwardPoints('Control Award', 1)).toBe(12)
      expect(calcAwardPoints('Judges Choice Award', 1)).toBe(12)
    })

    it('strictly excludes non-judged or individual awards', () => {
      expect(calcAwardPoints("Dean's List Finalist", 1)).toBe(0)
      expect(calcAwardPoints('Compass Award', 1)).toBe(0)
      expect(calcAwardPoints('Promote Award', 1)).toBe(0)
      expect(calcAwardPoints('Volunteer of the Year', 1)).toBe(0)
    })
  })

  describe('Full Tournament Advancement Calculation & Table 4-2 Tiebreaker Hierarchy', () => {
    it('calculates total advancement points and sorts by official hierarchy', () => {
      const rankings: OfficialRanking[] = [
        { rank: 1, teamNumber: 27570, sortOrder1: 140, sortOrder2: 120 },
        { rank: 2, teamNumber: 11115, sortOrder1: 130, sortOrder2: 110 },
        { rank: 3, teamNumber: 8417, sortOrder1: 125, sortOrder2: 95 },
        { rank: 4, teamNumber: 18457, sortOrder1: 115, sortOrder2: 85 },
        { rank: 5, teamNumber: 11260, sortOrder1: 100, sortOrder2: 70 }
      ]

      const alliances: OfficialAlliance[] = [
        { number: 1, captain: 27570, round1: 11115 },
        { number: 2, captain: 8417, round1: 18457 }
      ]

      const awards: OfficialAward[] = [
        { name: 'Inspire Award', series: 1, teamNumber: 27570 },
        { name: 'Winning Alliance Captain', series: 1, teamNumber: 27570 },
        { name: 'Winning Alliance 1st Pick', series: 1, teamNumber: 11115 },
        { name: 'Think Award', series: 1, teamNumber: 8417 }
      ]

      const advancement = calculateAdvancement(rankings, alliances, awards, [], 2)
      expect(advancement.length).toBe(5)

      // Top team 27570: Qual (16) + Alliance 1 (20) + Playoff Winner (40) + Inspire 1 (60) = 136 pts
      const top = advancement[0]
      expect(top.teamNumber).toBe(27570)
      expect(top.advancementRank).toBe(1)
      expect(top.totalAdvancementPoints).toBe(136)
      expect(top.advancementStatus).toBe('ADVANCING')
      expect(top.breakdown.qualPoints).toBe(16)
      expect(top.breakdown.alliancePoints).toBe(20)
      expect(top.breakdown.playoffPoints).toBe(40)
      expect(top.breakdown.awardPoints).toBe(60)

      // 2nd team 11115: Qual (12) + Alliance 1 (20) + Playoff Winner (40) = 72 pts
      const second = advancement[1]
      expect(second.teamNumber).toBe(11115)
      expect(second.advancementRank).toBe(2)
      expect(second.totalAdvancementPoints).toBe(72)
      expect(second.advancementStatus).toBe('ADVANCING')

      // 3rd team 8417: Qual (10) + Alliance 2 (19) + Think Award 1st (12) = 41 pts -> BUBBLE (rank 3, slots=2)
      const third = advancement[2]
      expect(third.teamNumber).toBe(8417)
      expect(third.advancementRank).toBe(3)
      expect(third.totalAdvancementPoints).toBe(41)
      expect(third.advancementStatus).toBe('BUBBLE')

      // Build map helper
      const map = buildAdvancementMap(advancement)
      expect(map.get(27570)?.totalAdvancementPoints).toBe(136)
      expect(map.get(11115)?.totalAdvancementPoints).toBe(72)
    })

    it('excludes personal/mentor awards from playoff points', () => {
      const rankings: OfficialRanking[] = [
        { rank: 1, teamNumber: 9999, sortOrder1: 100 }
      ]
      const awards: OfficialAward[] = [
        { name: "Dean's List Finalist", teamNumber: 9999, series: 1 },
        { name: 'Compass Award Winner', teamNumber: 9999, series: 1 }
      ]
      const adv = calculateAdvancement(rankings, [], awards, [], 4)
      expect(adv[0].playoffPoints).toBe(0)
      expect(adv[0].awardPoints).toBe(0)
    })

    it('correctly distinguishes Semifinal playoff matches from Finals matches', () => {
      const rankings: OfficialRanking[] = [
        { rank: 1, teamNumber: 1001 },
        { rank: 2, teamNumber: 2001 },
        { rank: 3, teamNumber: 1002 }
      ]
      const semiMatches: OfficialMatch[] = [
        {
          matchNum: 1,
          series: 1,
          description: 'Semifinals 1 Match 1',
          tournamentLevel: 'PLAYOFF',
          scores: {
            red: { finalScore: 120, penaltyPointsCommitted: 0, totalPointsNp: 120 },
            blue: { finalScore: 80, penaltyPointsCommitted: 0, totalPointsNp: 80 }
          },
          teams: [
            { teamNumber: 1001, alliance: 'Red' },
            { teamNumber: 2001, alliance: 'Blue' }
          ]
        }
      ]
      const advSemi = calculateAdvancement(rankings, [], [], semiMatches, 4)
      const t1001Semi = advSemi.find(t => t.teamNumber === 1001)
      const t2001Semi = advSemi.find(t => t.teamNumber === 2001)
      expect(t1001Semi?.playoffPoints).toBe(20) // Semifinal winner, NOT 40
      expect(t2001Semi?.playoffPoints).toBe(5)  // Semifinal loser, NOT 20

      const finalsMatches: OfficialMatch[] = [
        ...semiMatches,
        {
          matchNum: 1,
          series: 3,
          description: 'Finals 1',
          tournamentLevel: 'PLAYOFF',
          scores: {
            red: { finalScore: 150, penaltyPointsCommitted: 0, totalPointsNp: 150 },
            blue: { finalScore: 130, penaltyPointsCommitted: 0, totalPointsNp: 130 }
          },
          teams: [
            { teamNumber: 1001, alliance: 'Red' },
            { teamNumber: 1002, alliance: 'Blue' }
          ]
        }
      ]
      const advFinals = calculateAdvancement(rankings, [], [], finalsMatches, 4)
      const t1001Finals = advFinals.find(t => t.teamNumber === 1001)
      const t1002Finals = advFinals.find(t => t.teamNumber === 1002)
      expect(t1001Finals?.playoffPoints).toBe(40) // Finals winner
      expect(t1002Finals?.playoffPoints).toBe(20) // Finals runner-up
    })

    it('awards 40 to champion and 20 to runner-up in a multi-match Finals series where runner-up won a match', () => {
      const rankings: OfficialRanking[] = [
        { rank: 1, teamNumber: 1001 },
        { rank: 2, teamNumber: 1002 }
      ]
      const matches: OfficialMatch[] = [
        {
          matchNum: 1,
          series: 3,
          description: 'Finals 1',
          tournamentLevel: 'PLAYOFF',
          scores: { red: { finalScore: 150, penaltyPointsCommitted: 0, totalPointsNp: 150 }, blue: { finalScore: 130, penaltyPointsCommitted: 0, totalPointsNp: 130 } },
          teams: [{ teamNumber: 1001, alliance: 'Red' }, { teamNumber: 1002, alliance: 'Blue' }]
        },
        {
          matchNum: 2,
          series: 3,
          description: 'Finals 2',
          tournamentLevel: 'PLAYOFF',
          scores: { red: { finalScore: 120, penaltyPointsCommitted: 0, totalPointsNp: 120 }, blue: { finalScore: 140, penaltyPointsCommitted: 0, totalPointsNp: 140 } },
          teams: [{ teamNumber: 1001, alliance: 'Red' }, { teamNumber: 1002, alliance: 'Blue' }]
        },
        {
          matchNum: 3,
          series: 3,
          description: 'Finals 3',
          tournamentLevel: 'PLAYOFF',
          scores: { red: { finalScore: 160, penaltyPointsCommitted: 0, totalPointsNp: 160 }, blue: { finalScore: 110, penaltyPointsCommitted: 0, totalPointsNp: 110 } },
          teams: [{ teamNumber: 1001, alliance: 'Red' }, { teamNumber: 1002, alliance: 'Blue' }]
        }
      ]
      const adv = calculateAdvancement(rankings, [], [], matches, 2)
      const t1001 = adv.find(t => t.teamNumber === 1001)
      const t1002 = adv.find(t => t.teamNumber === 1002)
      expect(t1001?.playoffPoints).toBe(40) // Champion (2 wins)
      expect(t1002?.playoffPoints).toBe(20) // Finalist (1 win, NOT 40!)
    })

    it('does not leak playoff points from judged awards with "Winner" or "Finalist" in title', () => {
      const rankings: OfficialRanking[] = [
        { rank: 5, teamNumber: 8417 },
        { rank: 6, teamNumber: 19600 }
      ]
      const awards: OfficialAward[] = [
        { name: 'Think Award Winner', teamNumber: 8417, series: 1 },
        { name: 'Design Award Finalist', teamNumber: 19600, series: 1 }
      ]
      const adv = calculateAdvancement(rankings, [], awards, [], 4)
      const t8417 = adv.find(t => t.teamNumber === 8417)
      const t19600 = adv.find(t => t.teamNumber === 19600)
      expect(t8417?.playoffPoints).toBe(0)
      expect(t8417?.awardPoints).toBe(12)
      expect(t19600?.playoffPoints).toBe(0)
      expect(t19600?.awardPoints).toBe(6) // inferred series 2 from "Finalist"
    })

    it('assigns 10 or 5 points, never 20 points, to eliminated semifinalists once Finals is active', () => {
      const rankings: OfficialRanking[] = [
        { rank: 1, teamNumber: 1001 },
        { rank: 2, teamNumber: 1002 },
        { rank: 3, teamNumber: 2001 },
        { rank: 4, teamNumber: 2002 }
      ]
      const matches: OfficialMatch[] = [
        // SF1 (1001 vs 2001, 1001 wins 2-1)
        { matchNum: 1, series: 1, description: 'Semifinals 1 Match 1', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 120 }, blue: { finalScore: 80 } }, teams: [{ teamNumber: 1001, alliance: 'Red' }, { teamNumber: 2001, alliance: 'Blue' }] },
        { matchNum: 2, series: 1, description: 'Semifinals 1 Match 2', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 90 }, blue: { finalScore: 110 } }, teams: [{ teamNumber: 1001, alliance: 'Red' }, { teamNumber: 2001, alliance: 'Blue' }] },
        { matchNum: 3, series: 1, description: 'Semifinals 1 Match 3', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 130 }, blue: { finalScore: 85 } }, teams: [{ teamNumber: 1001, alliance: 'Red' }, { teamNumber: 2001, alliance: 'Blue' }] },
        // SF2 (1002 vs 2002, 1002 sweeps 2-0)
        { matchNum: 1, series: 2, description: 'Semifinals 2 Match 1', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 100 }, blue: { finalScore: 70 } }, teams: [{ teamNumber: 1002, alliance: 'Red' }, { teamNumber: 2002, alliance: 'Blue' }] },
        { matchNum: 2, series: 2, description: 'Semifinals 2 Match 2', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 105 }, blue: { finalScore: 60 } }, teams: [{ teamNumber: 1002, alliance: 'Red' }, { teamNumber: 2002, alliance: 'Blue' }] },
        // Finals 1 (1001 vs 1002)
        { matchNum: 1, series: 3, description: 'Finals 1', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 150 }, blue: { finalScore: 120 } }, teams: [{ teamNumber: 1001, alliance: 'Red' }, { teamNumber: 1002, alliance: 'Blue' }] }
      ]
      const adv = calculateAdvancement(rankings, [], [], matches, 4)
      const t1001 = adv.find(t => t.teamNumber === 1001)
      const t1002 = adv.find(t => t.teamNumber === 1002)
      const t2001 = adv.find(t => t.teamNumber === 2001)
      const t2002 = adv.find(t => t.teamNumber === 2002)

      expect(t1001?.playoffPoints).toBe(40) // Finals winner
      expect(t1002?.playoffPoints).toBe(20) // Finalist
      expect(t2001?.playoffPoints).toBe(10) // 3rd place (won 1 SF match, NOT 20)
      expect(t2002?.playoffPoints).toBe(5)  // 4th place (0 SF wins, NOT 20)
    })

    it('supports Sustain/Reach awards, nested AllianceTeam objects, 6-alliance snake draft, and Rule A215 cap', () => {
      expect(calcAwardPoints('Sustain Award', 1)).toBe(12)
      expect(calcAwardPoints('Reach Award', 2)).toBe(6)
      expect(calcAwardPoints('Sustain Award', 3)).toBe(3)

      const rankings: OfficialRanking[] = [
        { rank: 1, teamNumber: 23400 },
        { rank: 2, teamNumber: 11115 }
      ]
      const alliances: OfficialAlliance[] = Array.from({ length: 6 }, (_, idx) => ({
        number: idx + 1,
        captain: { teamNumber: 2001 + idx },
        round1: { teamNumber: 3001 + idx },
        round2: { teamNumber: 4001 + idx }
      }))
      const awards: OfficialAward[] = [
        { name: 'Inspire Award', series: 1, teamNumber: 23400 },
        { name: 'Sustain Award', series: 1, teamNumber: 23400 },
        { name: 'Reach Award', series: 1, teamNumber: 11115 }
      ]

      const adv = calculateAdvancement(rankings, alliances, awards, [], 4)
      expect(adv.find(t => t.teamNumber === 23400)?.awardPoints).toBe(60)
      expect(adv.find(t => t.teamNumber === 11115)?.awardPoints).toBe(12)
      expect(adv.find(t => t.teamNumber === 2001)?.alliancePoints).toBe(20)
      expect(adv.find(t => t.teamNumber === 4001)?.alliancePoints).toBe(9)
    })

    it('correctly classifies Double Elimination Lower Bracket series 3 as 3rd/4th instead of Finals', () => {
      const rankings: OfficialRanking[] = [
        { rank: 1, teamNumber: 15215 },
        { rank: 2, teamNumber: 32920 },
        { rank: 3, teamNumber: 19584 },
        { rank: 4, teamNumber: 24736 }
      ]
      const matches: OfficialMatch[] = [
        { matchNum: 1, series: 1, description: 'Upper Bracket  Round 1 Match 1', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 110 }, blue: { finalScore: 58 } }, teams: [{ teamNumber: 15215, alliance: 'Red' }, { teamNumber: 19584, alliance: 'Blue' }] },
        { matchNum: 1, series: 2, description: 'Upper Bracket  Round 1 Match 2', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 67 }, blue: { finalScore: 54 } }, teams: [{ teamNumber: 32920, alliance: 'Red' }, { teamNumber: 24736, alliance: 'Blue' }] },
        { matchNum: 1, series: 3, description: 'Lower Bracket  Round 2 Match 3', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 75 }, blue: { finalScore: 71 } }, teams: [{ teamNumber: 19584, alliance: 'Red' }, { teamNumber: 24736, alliance: 'Blue' }] },
        { matchNum: 1, series: 4, description: 'Upper Bracket  Round 2 Match 4', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 122 }, blue: { finalScore: 71 } }, teams: [{ teamNumber: 15215, alliance: 'Red' }, { teamNumber: 32920, alliance: 'Blue' }] },
        { matchNum: 1, series: 5, description: 'Lower Bracket  Round 3 Match 5', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 141 }, blue: { finalScore: 71 } }, teams: [{ teamNumber: 32920, alliance: 'Red' }, { teamNumber: 19584, alliance: 'Blue' }] },
        { matchNum: 1, series: 6, description: 'Final Bracket  Round 4 Match 6', tournamentLevel: 'PLAYOFF', scores: { red: { finalScore: 123 }, blue: { finalScore: 54 } }, teams: [{ teamNumber: 15215, alliance: 'Red' }, { teamNumber: 32920, alliance: 'Blue' }] }
      ]
      const adv = calculateAdvancement(rankings, [], [], matches, 4)
      expect(adv.find(t => t.teamNumber === 15215)?.playoffPoints).toBe(40)
      expect(adv.find(t => t.teamNumber === 32920)?.playoffPoints).toBe(20)
      expect(adv.find(t => t.teamNumber === 19584)?.playoffPoints).toBe(10)
      expect(adv.find(t => t.teamNumber === 24736)?.playoffPoints).toBe(5)
    })

    it('applies official FTC roll-down statuses (ALREADY_ADVANCING, DECLINED, INELIGIBLE -> rolledDown FIRST)', () => {
      const rankings: OfficialRanking[] = [
        { rank: 1, teamNumber: 30781 },
        { rank: 2, teamNumber: 15215 },
        { rank: 3, teamNumber: 18611 },
        { rank: 4, teamNumber: 32920 },
        { rank: 5, teamNumber: 15210 },
        { rank: 6, teamNumber: 24736 }
      ]
      const officialAdv: OfficialAdvancementResponse = {
        advancesTo: 'AUCMP',
        slots: 2,
        fcmpReserved: 0,
        advancement: [
          { team: 30781, slot: 1, criteria: 'Points', declined: false, status: 'ALREADY_ADVANCING' },
          { team: 15215, slot: 2, criteria: 'Points', declined: false, status: 'FIRST' },
          { team: 18611, slot: 3, criteria: 'Points', declined: true, status: 'FIRST' },
          { team: 32920, slot: 4, criteria: 'Points', declined: false, status: 'INELIGIBLE' },
          { team: 15210, slot: 5, criteria: 'Points', declined: false, status: 'FIRST' }
        ]
      }
      const adv = calculateAdvancement(rankings, [], [], [], undefined, officialAdv, false)
      expect(adv.find(t => t.teamNumber === 30781)?.advancementStatus).toBe('ALREADY_ADVANCING')
      expect(adv.find(t => t.teamNumber === 15215)?.advancementStatus).toBe('ADVANCING')
      expect(adv.find(t => t.teamNumber === 15215)?.rolledDown).toBe(false)
      expect(adv.find(t => t.teamNumber === 18611)?.advancementStatus).toBe('DECLINED')
      expect(adv.find(t => t.teamNumber === 32920)?.advancementStatus).toBe('INELIGIBLE')
      expect(adv.find(t => t.teamNumber === 15210)?.advancementStatus).toBe('ADVANCING')
      expect(adv.find(t => t.teamNumber === 15210)?.rolledDown).toBe(true)
      expect(adv.find(t => t.teamNumber === 24736)?.advancementStatus).toBe('BUBBLE')
    })

    it('supports PascalCase official payloads, safe boolean string parsing, and non-finite/non-positive slots fallback', () => {
      const rankings = [
        { Rank: 1, TeamNumber: 1001, SortOrder1: 90 },
        { Rank: 2, TeamNumber: 1002, SortOrder1: 80 },
        { Rank: 3, TeamNumber: 1003, SortOrder1: 70 },
        { Rank: 4, TeamNumber: 1004, SortOrder1: 60 }
      ] as unknown as OfficialRanking[]
      const officialAdv = {
        AdvancesTo: 'CMP',
        Slots: 2,
        Advancement: [
          { TeamNumber: '1001', Slot: 1, Declined: 'false', Status: 'FIRST' },
          { Team: 1002, Slot: 2, Declined: 'true', Status: 'FIRST' },
          { Team: 1003, Slot: 3, Declined: false, Status: 'FIRST' }
        ]
      } as unknown as OfficialAdvancementResponse

      const adv = calculateAdvancement(rankings, [], [], [], Number.POSITIVE_INFINITY, officialAdv, false)
      expect(adv.find(t => t.teamNumber === 1001)?.advancementStatus).toBe('ADVANCING')
      expect(adv.find(t => t.teamNumber === 1002)?.advancementStatus).toBe('DECLINED')
      expect(adv.find(t => t.teamNumber === 1003)?.advancementStatus).toBe('ADVANCING')
      expect(adv.find(t => t.teamNumber === 1003)?.rolledDown).toBe(true)
      expect(adv.find(t => t.teamNumber === 1004)?.advancementStatus).toBe('BUBBLE')
    })
  })
})
