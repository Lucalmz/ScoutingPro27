import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  CalibratedMonotonicClock,
  computeRobustWitnessMedian,
  getClockAnchorKey,
  getCalibratedClockForEvent,
  migrateClockAnchor,
  resetClockRegistryForTesting,
  MAX_OFFLINE_WALL_COMPENSATION_MS
} from '@/services/clock/calibratedClock'
import { createClockSyncDriver } from '@/services/clock/clockSyncProtocol'

function createMemoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    }
  }
}

describe('CalibratedMonotonicClock & 3-Sample Clock Sync Protocol', () => {
  beforeEach(() => {
    localStorage.clear()
    resetClockRegistryForTesting()
    delete (globalThis as Record<string, unknown>).__TEST_CLOCK_OFFSET_MS__
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TEST_CLOCK_OFFSET_MS__
    resetClockRegistryForTesting()
    localStorage.clear()
  })

  it('calibrates zero-point using minimum RTT sample across 3 samples', () => {
    let wall = 1_760_000_000_000
    let mono = 1000
    const storage = createMemoryStorage()
    const clock = new CalibratedMonotonicClock('evt-1', {
      wallNow: () => wall,
      monoNow: () => mono,
      storage
    })

    expect(clock.isCalibratedByHost()).toBe(false)

    // Current mono at calibration end is 1300
    mono = 1300
    const res = clock.calibrateFromHostSamples([
      // Sample 1: high latency jitter (120ms RTT) -> would overestimate/drift
      { hostNow: 1_760_000_500_000, clientMonoM1: 1000, clientMonoM2: 1120, rttMs: 120 },
      // Sample 2: tightest RTT (18ms) ending at mono 1218 -> elapsed 82ms to mono 1300
      { hostNow: 1_760_000_501_000, clientMonoM1: 1200, clientMonoM2: 1218, rttMs: 18 },
      // Sample 3: moderate RTT (95ms)
      { hostNow: 1_760_000_502_000, clientMonoM1: 1205, clientMonoM2: 1300, rttMs: 95 }
    ])

    expect(res.applied).toBe(true)
    expect(res.minRttMs).toBe(18)
    expect(clock.isCalibratedByHost()).toBe(true)
    // Sample 2 estimate = 1_760_000_501_000 + 18/2 + (1300 - 1218) = 1_760_000_501_091
    expect(res.estimatedHostNow).toBe(1_760_000_501_091)
    expect(clock.now()).toBe(1_760_000_501_091)
  })

  it('remains completely immune to +10yr and -1yr Date.now() system clock tampering after handshake', () => {
    let wall = 1_760_000_000_000
    let mono = 5000
    const storage = createMemoryStorage()
    const clock = new CalibratedMonotonicClock('evt-tamper', {
      wallNow: () => wall,
      monoNow: () => mono,
      storage
    })

    clock.calibrateFromHostSamples([
      { hostNow: 1_760_000_100_000, clientMonoM1: 4990, clientMonoM2: 5000, rttMs: 10 }
    ])
    const anchoredStart = clock.now()
    expect(anchoredStart).toBe(1_760_000_100_005)

    // System clock jumps +10 years while hardware oscillator advances 500ms
    wall += 10 * 365 * 24 * 3600 * 1000
    mono += 500
    expect(clock.now()).toBe(anchoredStart + 500)

    // System clock jumps -11 years (-1 year relative to baseline) while hardware oscillator advances 500ms
    wall -= 11 * 365 * 24 * 3600 * 1000
    mono += 500
    expect(clock.now()).toBe(anchoredStart + 1000)
  })

  it('compensates bounded offline sleep (0..12h) and rejects tampered jumps or online resumes', () => {
    let wall = 1_760_000_000_000
    let mono = 2000
    const storage = createMemoryStorage()
    const clock = new CalibratedMonotonicClock('evt-sleep', {
      wallNow: () => wall,
      monoNow: () => mono,
      storage,
      isOnline: () => false
    })

    clock.calibrateFromHostSamples([
      { hostNow: 1_760_000_000_000, clientMonoM1: 1990, clientMonoM2: 2000, rttMs: 10 }
    ])
    const beforeSleep = clock.now()

    // 1. Valid 2-hour offline sleep where performance.now() stayed frozen (deltaMono = 0)
    clock.markBackgrounded()
    const twoHoursMs = 2 * 3600 * 1000
    wall += twoHoursMs
    expect(clock.handleVisibilityResume(true)).toBe(true)
    expect(clock.now()).toBe(beforeSleep + twoHoursMs)

    // 2. Tampered +15h jump (> 12h threshold) rejected
    clock.markBackgrounded()
    const afterTwoHours = clock.now()
    wall += MAX_OFFLINE_WALL_COMPENSATION_MS + 3 * 3600 * 1000
    expect(clock.handleVisibilityResume(true)).toBe(false)
    expect(clock.now()).toBe(afterTwoHours)

    // 3. Negative wall jump (-1h) rejected and monotonic output preserved
    clock.markBackgrounded()
    wall -= 3600 * 1000
    expect(clock.handleVisibilityResume(true)).toBe(false)
    expect(clock.now()).toBe(afterTwoHours)

    // 4. Online resume ignores local sleep delta and defers to Host CLOCK_SYNC
    clock.markBackgrounded()
    wall += 30 * 60 * 1000
    expect(clock.handleVisibilityResume(false)).toBe(false)
    expect(clock.now()).toBe(afterTwoHours)
  })

  it('restores cold-restart anchors accurately without double-counting testOffsetMs or accepting +10yr reload tampering', () => {
    let wall = 1_760_000_000_000
    let mono = 100
    let testOffset = 0
    const storage = createMemoryStorage()

    const firstBoot = new CalibratedMonotonicClock('evt-cold', {
      wallNow: () => wall,
      monoNow: () => mono,
      testOffsetMs: () => testOffset,
      storage
    })

    firstBoot.calibrateFromHostSamples([
      { hostNow: 1_760_000_000_000, clientMonoM1: 90, clientMonoM2: 100, rttMs: 10 }
    ])
    firstBoot.recordCommittedHlcPt(1_760_000_000_020)

    // Apply +2h test clock offset in E2E simulation and re-persist anchor
    testOffset = 2 * 3600 * 1000
    mono = 1100 // +1s
    expect(firstBoot.now()).toBe(1_760_000_001_005 + testOffset)
    firstBoot.persistAnchor()

    // Case A: Warm reload 10 minutes later keeping same +2h testOffset
    wall += 10 * 60 * 1000
    mono = 50 // fresh OS process monotonic timer
    const secondBoot = new CalibratedMonotonicClock('evt-cold', {
      wallNow: () => wall,
      monoNow: () => mono,
      testOffsetMs: () => testOffset,
      storage
    })

    // Must be ~ +10min + 2h (ONLY one +2h, never +4h double counting)
    expect(secondBoot.isCalibratedByHost()).toBe(true)
    expect(secondBoot.now()).toBe(1_760_000_001_005 + 10 * 60 * 1000 + testOffset)

    // Case B: Cold reload with tampered +10yr wall clock
    const tamperedBoot = new CalibratedMonotonicClock('evt-cold', {
      wallNow: () => wall + 10 * 365 * 24 * 3600 * 1000,
      monoNow: () => 50,
      testOffsetMs: () => 0,
      storage
    })
    // Ignores +10yr delta, recovers max(savedCalibratedMs, lastCommittedHlcPt + 1)
    expect(tamperedBoot.now()).toBe(1_760_000_001_005)
    expect(storage.getItem(getClockAnchorKey('evt-cold'))).toBeTruthy()
  })

  it('migrates clock anchors safely from temporary invite/placeholder IDs to authoritative UUID', () => {
    const tmpClock = getCalibratedClockForEvent('ext_ABCD12')
    tmpClock.recordCommittedHlcPt(1_760_500_000_000)

    migrateClockAnchor('ext_ABCD12', 'uuid-real-event')

    const migratedRaw = localStorage.getItem(getClockAnchorKey('uuid-real-event'))
    expect(migratedRaw).toBeTruthy()
    expect(JSON.parse(migratedRaw!).lastHlcPt).toBe(1_760_500_000_000)

    const authClock = getCalibratedClockForEvent('uuid-real-event')
    expect(authClock.getLastCommittedHlcPt()).toBe(1_760_500_000_000)
  })

  it('computes Byzantine cluster-robust Witness median and aligns Host clock across outliers and dead CMOS', () => {
    const base = 1_760_000_000_000
    const tenYearsMs = 10 * 365 * 24 * 3600 * 1000

    // 3 normal Witnesses around base + 2h vs 1 poisoned Witness at +10yr
    const median = computeRobustWitnessMedian(
      [
        base + 2 * 3600 * 1000 + 100,
        base + tenYearsMs,
        base + 2 * 3600 * 1000 + 5000,
        base + 2 * 3600 * 1000 + 2500
      ],
      base
    )
    expect(median).toBe(base + 2 * 3600 * 1000 + 2500)

    // Single uncorroborated +10yr Witness (>30d ahead) must be rejected
    expect(computeRobustWitnessMedian([base + tenYearsMs], base)).toBeNull()

    // Host with dead CMOS battery (year 2020) receiving 2 corroborated 2026 Witnesses
    let hostWall = 1_577_836_800_000 // 2020-01-01
    let hostMono = 1000
    const deadCmosHostClock = new CalibratedMonotonicClock('evt-cmos', {
      wallNow: () => hostWall,
      monoNow: () => hostMono,
      storage: createMemoryStorage()
    })

    const witnessTs1 = base + 5000
    const witnessTs2 = base + 9000
    const aligned = deadCmosHostClock.alignHostWithWitnesses([witnessTs1, witnessTs2])
    expect(aligned).toBe(witnessTs1 + 1)
    expect(deadCmosHostClock.now()).toBe(witnessTs1 + 1)

    hostMono += 250
    expect(deadCmosHostClock.now()).toBe(witnessTs1 + 251)
  })

  it('drives 3-sample CLOCK_SYNC roundtrips via createClockSyncDriver and supports forceReanchor recovery', async () => {
    let mono = 1000
    const wall = 1_760_000_000_000
    const storage = createMemoryStorage()
    const clock = new CalibratedMonotonicClock('evt-driver', {
      wallNow: () => wall + 60 * 365 * 24 * 3600 * 1000, // poisoned future local clock initially!
      monoNow: () => mono,
      storage
    })

    // Simulate local clock poisoned in 2036 with committed HLC
    clock.recordCommittedHlcPt(wall + 10 * 365 * 24 * 3600 * 1000)
    expect(clock.now()).toBeGreaterThan(wall + 365 * 24 * 3600 * 1000)

    const rtts = [60, 14, 48]
    let sampleIdx = 0
    const calibratedEvents: any[] = []

    const driver = createClockSyncDriver({
      clock: () => clock,
      monoNow: () => mono,
      sampleDelayMs: 0,
      sampleTimeoutMs: 500,
      sendReq: async (req) => {
        const rtt = rtts[sampleIdx++] ?? 20
        mono += rtt
        driver.handleResponse({
          type: 'CLOCK_SYNC_RES',
          reqId: req.reqId,
          hostNow: 1_760_000_200_000,
          clientMonoM1: req.clientMonoM1,
          hostEpoch: 2
        })
      },
      onCalibrated: (res) => calibratedEvents.push(res)
    })

    // Normal calibration preserves committed future HLC? No, forceReanchor is false so 10yr committed Pt > estimatedNow+300s -> falls back to estimatedNow!
    const normalRes = await driver.runCalibration()
    expect(normalRes.applied).toBe(true)
    expect(normalRes.samplesCollected).toBe(3)
    expect(normalRes.minRttMs).toBe(14)
    expect(normalRes.hostEpoch).toBe(2)

    // Verify forceReanchor explicitly resets lastCommittedHlcPt even for smaller future skews (e.g. +10s)
    sampleIdx = 0
    clock.recordCommittedHlcPt(1_760_000_210_000) // +10s within 300s window
    const reanchorRes = await driver.runCalibration({ forceReanchor: true })
    expect(reanchorRes.applied).toBe(true)
    expect(clock.getLastCommittedHlcPt()).toBe(0)
    // Sample 2 (minRtt=14ms -> +7ms half-RTT) finished 48ms (Sample 3 RTT) before calibrateFromHostSamples ran
    expect(clock.now()).toBe(1_760_000_200_000 + 7 + 48)
    expect(calibratedEvents.length).toBe(2)
  })
})
