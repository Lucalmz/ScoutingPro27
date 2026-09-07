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

const createClaimedRecord = (claimedAuto: number, claimedTeleop: number, claimedHang: number, claimedTotal: number): PitScoutingRecord => ({
  id: 'pit_1',
  eventId: 'evt_test',
  teamNumber: 27570,
  scoutId: 's1',
  scoutName: 'Scout 1',
  drivetrainType: 'mecanum',
  weightLbs: 38.0,
  sizingPassed: true,
  mechanismType: 'slide_claw',
  hangType: 'winch',
  odometryType: 'two_wheel',
  claimedAutoScore: claimedAuto,
  claimedAutoPieces: 3,
  claimedAutoHangLevel: 1,
  claimedTeleopScore: claimedTeleop,
  claimedTeleopCycleSec: 8.0,
  claimedEndgameHangLevel: claimedHang,
  claimedEndgameTimeSec: 4.0,
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

  it('identifies realistic team (真实守信, ratio <= 1.15)', () => {
    const claimed = createClaimedRecord(50, 60, 2, 130)
    const matches = [
      createDummyMatch(1, 45, 55, 20), // total 120
      createDummyMatch(2, 50, 60, 20)  // total 130
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.tier).toBe('realistic')
    expect(res?.overallRatio).toBeLessThanOrEqual(1.15)
    expect(res?.hangUnfulfilled).toBe(false)
  })

  it('identifies optimistic team (略偏乐观, 1.15 < ratio <= 1.45)', () => {
    const claimed = createClaimedRecord(70, 80, 2, 170)
    const matches = [
      createDummyMatch(1, 45, 55, 20), // 120
      createDummyMatch(2, 50, 60, 20)  // 130
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.tier).toBe('optimistic')
    expect(res?.overallRatio).toBeGreaterThan(1.15)
    expect(res?.overallRatio).toBeLessThanOrEqual(1.45)
  })

  it('identifies overclaimed team (夸大其词, 1.45 < ratio <= 2.0)', () => {
    const claimed = createClaimedRecord(90, 100, 2, 210)
    const matches = [
      createDummyMatch(1, 40, 50, 20), // 110
      createDummyMatch(2, 45, 55, 20)  // 120
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.tier).toBe('overclaimed')
    expect(res?.overallRatio).toBeGreaterThan(1.45)
    expect(res?.overallRatio).toBeLessThanOrEqual(2.0)
  })

  it('identifies mythical team (吹破牛皮, ratio > 2.0)', () => {
    const claimed = createClaimedRecord(120, 140, 3, 290)
    const matches = [
      createDummyMatch(1, 30, 40, 10), // 80
      createDummyMatch(2, 35, 45, 10)  // 90
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.tier).toBe('mythical')
    expect(res?.overallRatio).toBeGreaterThan(2.0)
  })

  it('grants pardon for high hang unfulfilled (claimed high hang but never scored hang in 3 matches, pardoned due to reset difficulty)', () => {
    const claimed = createClaimedRecord(50, 60, 3, 130)
    const matches = [
      createDummyMatch(1, 40, 50, 0),
      createDummyMatch(2, 45, 55, 0),
      createDummyMatch(3, 40, 50, 0)
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.hangUnfulfilled).toBe(true)
    expect(res?.hangPardoned).toBe(true)
    // 130 / 100 = 1.30x => optimistic, NOT penalized to mythical or overclaimed
    expect(res?.tier).toBe('optimistic')
    expect(res?.label).toContain('高挂待验证')
  })

  it('confirms high hang verified (as long as at least 1 match scored high hang, proves they did not lie)', () => {
    const claimed = createClaimedRecord(50, 60, 3, 140)
    const matches = [
      createDummyMatch(1, 40, 50, 0),
      createDummyMatch(2, 45, 55, 30), // Achieved High Hang here!
      createDummyMatch(3, 40, 50, 0)
    ]
    const res = calculateBragIndex(claimed, matches)
    expect(res).toBeDefined()
    expect(res?.hangVerified).toBe(true)
    expect(res?.hangUnfulfilled).toBe(false)
    expect(res?.hangPardoned).toBe(false)
    expect(res?.label).toContain('高杠已证实')
  })
})
