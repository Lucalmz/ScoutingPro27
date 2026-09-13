import { describe, it, expect } from 'vitest'
import { calculateBragIndex } from '../utils/bragIndex'
import type { PitScoutingRecord, ScoutingRecord } from '../types'

const createDummyMatch = (matchNumber: number, autoScore: number, teleopScore: number, endgameScore: number): ScoutingRecord => ({
  id: `m_${matchNumber}`,
  eventId: 'evt_test',
  scoutId: 's1',
  scoutName: 'Scout 1',
  matchNumber,
  teamNumber: 27570,
  autoScore,
  teleopScore,
  endgameScore,
  totalScore: autoScore + teleopScore + endgameScore,
  notes: '',
  rawData: '{}',
  syncStatus: 'SYNCED',
  createdAt: '',
  updatedAt: ''
})

const createClaimedRecord = (claimedAuto: number, claimedTeleop: number, claimedEndgame: number, claimedTotal: number): PitScoutingRecord => ({
  id: 'pit_1',
  eventId: 'evt_test',
  teamNumber: 27570,
  scoutId: 's1',
  scoutName: 'Scout 1',
  drivetrainType: 'mecanum',
  weightLbs: 38.0,
  ballCompatibility: 'universal',
  launcherType: '差速双飞轮',
  flowerMechanism: '垂直级联高抬升',
  hasColorSensor: true,
  odometryType: 'two_wheel',
  claimedAutoStrategy: '3 balls',
  claimedAutoScore: claimedAuto,
  claimedTeleopCycles: 6,
  claimedTeleopScore: claimedTeleop,
  claimedEndgameScore: claimedEndgame,
  claimedTotalScore: claimedTotal,
  version: 1
})

describe('Brag Index Calculator (吹牛指数算法)', () => {
  it('returns undefined if no claimed pit record', () => {
    expect(calculateBragIndex(null, [])).toBeUndefined()
  })

  it('returns pending tier when team has not played any match yet', () => {
    const claimed = createClaimedRecord(60, 80, 2, 160)
    const res = calculateBragIndex(claimed, [])
    expect(res).toBeDefined()
    expect(res?.tier).toBe('pending')
    expect(res?.label).toContain('待实测')
  })

  it('identifies realistic team (真实守信, ratio <= 1.25)', () => {
    const claimed = createClaimedRecord(50, 60, 2, 130)
    const matches = [
      createDummyMatch(1, 45, 55, 20), // total 120
      createDummyMatch(2, 50, 60, 20)  // total 130
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.tier).toBe('realistic')
    expect(res?.overallRatio).toBeLessThanOrEqual(1.25)
    expect(res?.hangUnfulfilled).toBe(false)
  })

  it('identifies optimistic team (略偏乐观, 1.25 < ratio <= 1.65)', () => {
    const claimed = createClaimedRecord(70, 80, 2, 170)
    const matches = [
      createDummyMatch(1, 45, 55, 20), // 120
      createDummyMatch(2, 50, 60, 20)  // 130
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.tier).toBe('optimistic')
    expect(res?.overallRatio).toBeGreaterThan(1.25)
    expect(res?.overallRatio).toBeLessThanOrEqual(1.65)
  })

  it('identifies overclaimed team (夸大其词, 1.65 < ratio <= 2.2)', () => {
    const claimed = createClaimedRecord(90, 100, 2, 210)
    const matches = [
      createDummyMatch(1, 40, 50, 20), // 110
      createDummyMatch(2, 45, 55, 20)  // 120
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.tier).toBe('overclaimed')
    expect(res?.overallRatio).toBeGreaterThan(1.65)
    expect(res?.overallRatio).toBeLessThanOrEqual(2.2)
  })

  it('identifies mythical team (吹破牛皮, ratio > 2.2)', () => {
    const claimed = createClaimedRecord(120, 140, 3, 290)
    const matches = [
      createDummyMatch(1, 30, 40, 10), // 80
      createDummyMatch(2, 35, 45, 10)  // 90
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.tier).toBe('mythical')
    expect(res?.overallRatio).toBeGreaterThan(2.2)
  })

  it('grants pardon for endgame flower unfulfilled (claimed flower but never scored in 3 matches, pardoned due to strategy)', () => {
    const claimed = createClaimedRecord(50, 60, 15, 130)
    const matches = [
      createDummyMatch(1, 40, 50, 0),
      createDummyMatch(2, 45, 55, 0),
      createDummyMatch(3, 40, 50, 0)
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.endgameUnfulfilled).toBe(true)
    expect(res?.endgamePardoned).toBe(true)
    // 130 / 100 = 1.30x => optimistic, NOT penalized to mythical or overclaimed
    expect(res?.tier).toBe('optimistic')
    expect(res?.label).toContain('花朵待验证')
  })

  it('confirms endgame flower verified (as long as at least 1 match scored flower >= 10 pts, proves they did not lie)', () => {
    const claimed = createClaimedRecord(50, 60, 15, 140)
    const matches = [
      createDummyMatch(1, 40, 50, 0),
      createDummyMatch(2, 45, 55, 15), // Achieved Flower + Bonus here!
      createDummyMatch(3, 40, 50, 0)
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.endgameVerified).toBe(true)
    expect(res?.endgameUnfulfilled).toBe(false)
    expect(res?.endgamePardoned).toBe(false)
    expect(res?.label).toContain('花朵已证实')
  })

  it('handles 0 or unfilled claimed total score gracefully without misidentifying as realistic', () => {
    const claimed = createClaimedRecord(0, 0, 0, 0)
    const matches = [
      createDummyMatch(1, 40, 50, 15),
      createDummyMatch(2, 45, 55, 15)
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.tier).toBe('pending')
    expect(res?.label).toContain('自述待补充')
  })

  it('rejects flower verification when claimed flower (>=10 pts) but only park (5 pts) was achieved', () => {
    const claimed = createClaimedRecord(50, 60, 15, 140) // Claims flower (15 pts)
    const matches = [
      createDummyMatch(1, 40, 50, 5), // Only park achieved (5 pts)
      createDummyMatch(2, 45, 55, 5)
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.endgameVerified).toBe(false)
    expect(res?.endgameUnfulfilled).toBe(true)
    expect(res?.label).not.toContain('花朵已证实')
  })
})
