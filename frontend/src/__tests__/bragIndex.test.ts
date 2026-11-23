import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { calculateBragIndex } from '../utils/bragIndex'
import { i18n, switchLanguage } from '../i18n'
import { usePitScoutStore } from '../stores/pitScout'
import { useRecordStore } from '../stores/records'
import * as api from '../services/api'
import type { PitScoutingRecord, ScoutingRecord } from '../types'

const createDummyMatch = (
  matchNumber: number,
  autoScore: number,
  teleopScore: number,
  endgameScore: number,
  rawDataObj: Record<string, unknown> = {},
  overrides: Partial<ScoutingRecord> = {}
): ScoutingRecord => ({
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
  rawData: JSON.stringify(rawDataObj),
  syncStatus: 'SYNCED',
  createdAt: '',
  updatedAt: '',
  ...overrides
})

const createClaimedRecord = (
  claimedAuto: number,
  claimedTeleop: number,
  claimedEndgame: number,
  claimedTotal: number,
  overrides: Partial<PitScoutingRecord> = {}
): PitScoutingRecord => ({
  id: 'pit_1',
  eventId: 'evt_test',
  teamNumber: 27570,
  scoutId: 's1',
  scoutName: 'Scout 1',
  drivetrainType: 'mecanum',
  weightLbs: 38.0,
  chassisSize: '标准中型 (16"-17")',
  ballCompatibility: 'universal',
  launcherType: '差速双飞轮',
  flowerMechanism: '垂直级联高抬升',
  hasColorSensor: true,
  hasDescoreMech: false,
  hasApriltagVision: true,
  odometryType: 'two_wheel',
  claimedAutoStrategy: '3 balls',
  claimedAutoScore: claimedAuto,
  claimedTeleopCycles: 6,
  claimedTeleopScore: claimedTeleop,
  claimedTeleopPark: false,
  claimedFlowerNectars: 2,
  claimedFlowerBottomBonus: 1,
  claimedFlowerPollens: 0,
  claimedGardenBalls: 0,
  claimedEndgameScore: claimedEndgame,
  claimedTotalScore: claimedTotal,
  version: 1,
  ...overrides
})

describe('Brag Index Calculator (BIOBUZZ 2026-2027)', () => {
  const origLocale = i18n.global.locale.value

  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    switchLanguage('en')
  })

  afterEach(() => {
    localStorage.clear()
    switchLanguage(origLocale as 'zh' | 'en')
    vi.restoreAllMocks()
  })

  it('returns undefined if no claimed pit record', () => {
    expect(calculateBragIndex(null, [])).toBeUndefined()
  })

  it('returns pending tier when team has not played any match yet in both EN and ZH locales', () => {
    const claimed = createClaimedRecord(60, 80, 9, 149)

    const enRes = calculateBragIndex(claimed, [])
    expect(enRes).toBeDefined()
    expect(enRes?.tier).toBe('pending')
    expect(enRes?.labelKey).toBe('pit_scout.brag_pending_matches')
    expect(enRes?.label).toBe('Pending Matches')
    expect(/[\u4e00-\u9fa5]/.test(enRes!.label)).toBe(false)

    switchLanguage('zh')
    const zhRes = calculateBragIndex(claimed, [])
    expect(zhRes?.label).toContain('待实测')
  })

  it('identifies realistic, optimistic, overclaimed, and mythical tiers cleanly with endgameRatio', () => {
    const matches = [
      createDummyMatch(1, 45, 55, 10, { flowerNectars: 2, teleopPark: true }), // 110
      createDummyMatch(2, 50, 60, 10, { flowerNectars: 2, teleopPark: true })  // 120 -> baseline max(120, 115*1.05)=120.75
    ]

    const realistic = calculateBragIndex(createClaimedRecord(50, 60, 10, 120), matches)
    expect(realistic?.tier).toBe('realistic')
    expect(realistic?.overallRatio).toBeLessThanOrEqual(1.25)
    expect(realistic?.endgameRatio).toBe(1)

    const optimistic = calculateBragIndex(createClaimedRecord(70, 80, 20, 170), matches)
    expect(optimistic?.tier).toBe('optimistic')
    expect(optimistic?.overallRatio).toBeGreaterThan(1.25)
    expect(optimistic?.overallRatio).toBeLessThanOrEqual(1.65)
    expect(optimistic?.endgameRatio).toBe(2)

    const overclaimed = calculateBragIndex(createClaimedRecord(90, 110, 20, 220), matches)
    expect(overclaimed?.tier).toBe('overclaimed')
    expect(overclaimed?.overallRatio).toBeGreaterThan(1.65)
    expect(overclaimed?.overallRatio).toBeLessThanOrEqual(2.2)

    const mythical = calculateBragIndex(createClaimedRecord(120, 150, 30, 300), matches)
    expect(mythical?.tier).toBe('mythical')
    expect(mythical?.overallRatio).toBeGreaterThan(2.2)
  })

  it('verifies flower from rawData (flowerNectars / flowerBottomBonusCount / legacy flowerPlaced) without hardcoded Chinese in EN mode', () => {
    const claimed = createClaimedRecord(50, 60, 9, 119, {
      flowerMechanism: 'Vertical Cascading Lift',
      claimedFlowerNectars: 2,
      claimedFlowerBottomBonus: 1
    })
    const matches = [
      createDummyMatch(1, 40, 50, 0, { flowerNectars: 0 }),
      createDummyMatch(2, 45, 55, 9, { flowerNectars: 2, flowerBottomBonusCount: 1 })
    ]

    const enRes = calculateBragIndex(claimed, matches)
    expect(enRes?.flowerVerified).toBe(true)
    expect(enRes?.flowerPending).toBe(false)
    expect(enRes?.endgameVerified).toBe(true)
    expect(enRes?.endgameUnfulfilled).toBe(false)
    expect(enRes?.statusKeys).toContain('pit_scout.flower_verified')
    expect(enRes?.label).toContain('Flower Verified')
    expect(/[\u4e00-\u9fa5]/.test(enRes!.label)).toBe(false)

    // Legacy flowerPlaced flag in rawData also counts as flower verification
    const legacyMatches = [
      createDummyMatch(1, 45, 55, 10, { flowerPlaced: true })
    ]
    const legacyRes = calculateBragIndex(claimed, legacyMatches)
    expect(legacyRes?.flowerVerified).toBe(true)

    switchLanguage('zh')
    const zhRes = calculateBragIndex(claimed, matches)
    expect(zhRes?.label).toContain('花朵已证实')
  })

  it('NEVER treats endgameScore >= 10 from teleopPark + gardenBalls as flowerVerified', () => {
    const claimed = createClaimedRecord(50, 60, 15, 125, {
      flowerMechanism: '垂直级联高抬升',
      claimedFlowerNectars: 2
    })
    const matches = [
      createDummyMatch(1, 45, 55, 12, { teleopPark: true, gardenBalls: 7, flowerNectars: 0, flowerBottomBonusCount: 0 }),
      createDummyMatch(2, 45, 55, 11, { teleopPark: true, gardenBalls: 6, flowerNectars: 0, flowerBottomBonusCount: 0 })
    ]

    const res = calculateBragIndex(claimed, matches)
    expect(res?.flowerVerified).toBe(false)
    expect(res?.flowerPending).toBe(true)
    expect(res?.endgameVerified).toBe(false)
    expect(res?.endgameUnfulfilled).toBe(true)
    expect(res?.endgamePardoned).toBe(true)
    expect(res?.statusKeys).toContain('pit_scout.flower_pending_verify')
    expect(res?.label).toContain('Flower Pending')
    expect(/[\u4e00-\u9fa5]/.test(res!.label)).toBe(false)
  })

  it('evaluates teleopPark execution rate (>= 50% -> parkVerified, < 50% -> parkPending)', () => {
    const claimedPark = createClaimedRecord(50, 60, 5, 115, {
      flowerMechanism: 'none',
      claimedFlowerNectars: 0,
      claimedFlowerBottomBonus: 0,
      claimedTeleopPark: true
    })

    const stableMatches = [
      createDummyMatch(1, 50, 60, 5, { teleopPark: true }),
      createDummyMatch(2, 50, 60, 0, { teleopPark: false })
    ]
    const verifiedRes = calculateBragIndex(claimedPark, stableMatches)
    expect(verifiedRes?.parkVerified).toBe(true)
    expect(verifiedRes?.parkPending).toBe(false)
    expect(verifiedRes?.flowerVerified).toBe(false)
    expect(verifiedRes?.flowerPending).toBe(false)
    expect(verifiedRes?.statusKeys).toContain('pit_scout.park_verified')

    const unstableMatches = [
      createDummyMatch(1, 50, 60, 5, { teleopPark: true }),
      createDummyMatch(2, 50, 60, 0, { teleopPark: false }),
      createDummyMatch(3, 50, 60, 0, { teleopPark: false })
    ]
    const pendingRes = calculateBragIndex(claimedPark, unstableMatches)
    expect(pendingRes?.parkVerified).toBe(false)
    expect(pendingRes?.parkPending).toBe(true)
    expect(pendingRes?.statusKeys).toContain('pit_scout.park_pending')
  })

  it('handles 0 or unfilled claimed total score gracefully without misidentifying as realistic', () => {
    const claimed = createClaimedRecord(0, 0, 0, 0)
    const matches = [
      createDummyMatch(1, 40, 50, 15, { flowerNectars: 2 }),
      createDummyMatch(2, 45, 55, 15, { flowerNectars: 2 })
    ]
    const enRes = calculateBragIndex(claimed, matches)
    expect(enRes?.tier).toBe('pending')
    expect(enRes?.labelKey).toBe('pit_scout.brag_pending_claims')
    expect(enRes?.label).toBe('Claims Incomplete')

    switchLanguage('zh')
    const zhRes = calculateBragIndex(claimed, matches)
    expect(zhRes?.label).toContain('自述待补充')
  })

  it('integrates PitScoutStore claims and RecordStore match observations through pending -> overclaimed -> flowerVerified', async () => {
    vi.spyOn(api, 'isStaticCloudHost').mockReturnValue(false)
    vi.spyOn(api, 'saveRecord').mockResolvedValue(undefined as any)

    const eventId = 'evt_brag_integration'
    const pitStore = usePitScoutStore()
    const recordStore = useRecordStore()
    pitStore.currentEventId = eventId
    recordStore.currentEventId = eventId

    const pitRecord = createClaimedRecord(60, 90, 30, 180, {
      id: 'pit_27570_001',
      eventId,
      teamNumber: 27570,
      scoutId: 'scout_alice_id',
      scoutName: 'Alice'
    })
    vi.spyOn(api, 'savePitRecord').mockResolvedValue({ success: true, record: pitRecord } as any)

    await pitStore.saveRecord(pitRecord)
    const storedPit = pitStore.getUnifiedTeam(27570)?.pitRecord
    expect(storedPit?.claimedTotalScore).toBe(180)

    const initialBrag = calculateBragIndex(storedPit, [])
    expect(initialBrag?.tier).toBe('pending')
    expect(initialBrag?.label).toContain('Pending')

    await recordStore.addRecord(
      createDummyMatch(1, 35, 50, 15, { allianceColor: 'red' }, { id: 'rec_m1', eventId, syncStatus: 'PENDING' })
    )
    expect(recordStore.rankings[0].maxScore).toBe(100)

    const overclaimedBrag = calculateBragIndex(
      pitStore.getUnifiedTeam(27570)?.pitRecord,
      recordStore.activeRecords.filter((r) => r.teamNumber === 27570)
    )
    expect(overclaimedBrag?.overallRatio).toBeGreaterThan(1.5)
    expect(overclaimedBrag?.overallRatio).toBeLessThan(2.0)
    expect(overclaimedBrag?.tier).toBe('overclaimed')
    expect(overclaimedBrag?.label).toContain('Overclaimed')

    await recordStore.addRecord(
      createDummyMatch(
        2,
        45,
        52,
        28,
        { allianceColor: 'blue', flowerNectars: 4, flowerBottomBonusCount: 3, teleopPark: true },
        { id: 'rec_m2', eventId, syncStatus: 'PENDING' }
      )
    )
    const updatedBrag = calculateBragIndex(
      pitStore.getUnifiedTeam(27570)?.pitRecord,
      recordStore.activeRecords.filter((r) => r.teamNumber === 27570)
    )
    expect(updatedBrag?.flowerVerified).toBe(true)
    expect(updatedBrag?.label).toContain('Flower Verified')
  })
})
