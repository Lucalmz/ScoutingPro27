/**
 * Anti-Poisoning Calibrated Monotonic Clock (Crystal Oscillator Anchored)
 *
 * Pure, framework-agnostic clock module (zero Vue/Pinia/WebRTC dependencies):
 * 1. Anchors logical physical time via 3-sample min-RTT handshake calibration.
 * 2. Advances strictly via performance.now() monotonic oscillator, making runtime
 *    Date.now() tampering (+10yr / -1yr) completely ineffective.
 * 3. Smoothly compensates bounded offline sleep gaps (0..12h) via visibilitychange
 *    while rejecting tampered wall-clock jumps outside [0, 12h].
 * 4. Persists per-event anchors (`sp27_clock_anchor_${eventId}`) to survive
 *    offline PWA restarts without trusting tampered system clocks.
 * 5. Aligns newly promoted Hosts with cluster-robust median of online Witness HLCs.
 */

export const CLOCK_ANCHOR_PREFIX = 'sp27_clock_anchor_'
export const MAX_OFFLINE_WALL_COMPENSATION_MS = 12 * 3600 * 1000 // 12 hours
export const WITNESS_CLUSTER_WINDOW_MS = 300_000 // 5 minutes
export const MAX_SINGLE_WITNESS_JUMP_MS = 30 * 24 * 3600 * 1000 // 30 days
export const MAX_CLOCK_SKEW_MS = 300_000 // 300s TinyBase skew guard

export interface ClockEnvironment {
  wallNow?: () => number
  monoNow?: () => number
  testOffsetMs?: () => number
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  isOnline?: () => boolean
}

export interface ClockAnchorSnapshot {
  lastHlcPt: number
  savedCalibratedMs: number
  savedWallMs: number
  calibratedByHost: boolean
  updatedAtWallMs: number
}

export interface ClockSyncSample {
  hostNow: number
  clientMonoM1: number
  clientMonoM2: number
  rttMs: number
  hostEpoch?: number
}

export interface CalibrationApplyResult {
  applied: boolean
  estimatedHostNow?: number
  minRttMs?: number
}

interface ResolvedClockEnvironment {
  wallNow: () => number
  monoNow: () => number
  testOffsetMs: () => number
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  isOnline: () => boolean
}

function resolveEnvironment(env?: ClockEnvironment): ResolvedClockEnvironment {
  return {
    wallNow: env?.wallNow ?? (() => Date.now()),
    monoNow:
      env?.monoNow ??
      (() => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now())),
    testOffsetMs:
      env?.testOffsetMs ??
      (() => {
        const raw = (globalThis as Record<string, unknown>).__TEST_CLOCK_OFFSET_MS__
        return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
      }),
    storage: env && 'storage' in env ? (env.storage ?? null) : typeof localStorage !== 'undefined' ? localStorage : null,
    isOnline: env?.isOnline ?? (() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true))
  }
}

export function getClockAnchorKey(eventId: string): string {
  return `${CLOCK_ANCHOR_PREFIX}${eventId}`
}

/**
 * Computes a Byzantine-resilient median from online Witness max HLC timestamps.
 * Groups timestamps within a 5-minute diameter cluster, selects the largest cluster
 * (breaking ties toward the smaller timestamp so a +10yr poisoned peer cannot win),
 * and guards against an uncorroborated single +10yr outlier.
 */
export function computeRobustWitnessMedian(witnessPts: number[], referenceNowMs: number): number | null {
  const valid = witnessPts
    .filter((pt) => typeof pt === 'number' && Number.isFinite(pt) && pt > 0)
    .sort((a, b) => a - b)

  if (valid.length === 0) return null

  const clusters: number[][] = []
  for (const pt of valid) {
    const lastCluster = clusters[clusters.length - 1]
    if (lastCluster && lastCluster.length > 0 && pt - lastCluster[0]! <= WITNESS_CLUSTER_WINDOW_MS) {
      lastCluster.push(pt)
    } else {
      clusters.push([pt])
    }
  }

  let bestCluster = clusters[0]!
  for (let i = 1; i < clusters.length; i++) {
    const candidate = clusters[i]!
    if (candidate.length > bestCluster.length) {
      bestCluster = candidate
    }
    // On equal cluster sizes, keep the earlier cluster (smaller median) to prevent future poisoning
  }

  const median = bestCluster[Math.floor((bestCluster.length - 1) / 2)]!
  if (bestCluster.length === 1 && median - referenceNowMs > MAX_SINGLE_WITNESS_JUMP_MS) {
    return null
  }
  return median
}

export class CalibratedMonotonicClock {
  readonly eventId: string
  private readonly env: ResolvedClockEnvironment
  private baseHostMs: number
  private baseMonoMs: number
  private lastReturnedMs: number
  private lastCommittedHlcPt: number
  private calibratedByHost: boolean
  private lastActiveWallMs: number
  private lastActiveMonoMs: number

  constructor(eventId: string, env?: ClockEnvironment) {
    this.eventId = eventId
    this.env = resolveEnvironment(env)

    const currentWall = this.env.wallNow()
    const currentMono = this.env.monoNow()
    const currentOffset = this.env.testOffsetMs()

    const anchor = this.readAnchor()
    if (anchor) {
      const wallDelta = currentWall - anchor.savedWallMs
      const wallTrusted = wallDelta >= 0 && wallDelta <= MAX_OFFLINE_WALL_COMPENSATION_MS
      const projectedBase = wallTrusted ? anchor.savedCalibratedMs + wallDelta : anchor.savedCalibratedMs
      const minRequiredBase = anchor.lastHlcPt > 0 ? anchor.lastHlcPt + 1 - currentOffset : projectedBase

      this.baseHostMs = Math.max(projectedBase, minRequiredBase)
      this.lastCommittedHlcPt = anchor.lastHlcPt
      this.calibratedByHost = anchor.calibratedByHost
    } else {
      this.baseHostMs = currentWall
      this.lastCommittedHlcPt = 0
      this.calibratedByHost = false
    }

    this.baseMonoMs = currentMono
    this.lastReturnedMs = Math.floor(this.baseHostMs + currentOffset)
    this.lastActiveWallMs = currentWall
    this.lastActiveMonoMs = currentMono
  }

  private readAnchor(): ClockAnchorSnapshot | null {
    if (!this.env.storage || !this.eventId) return null
    try {
      const raw = this.env.storage.getItem(getClockAnchorKey(this.eventId))
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<ClockAnchorSnapshot>
      if (
        typeof parsed.savedCalibratedMs === 'number' &&
        Number.isFinite(parsed.savedCalibratedMs) &&
        typeof parsed.savedWallMs === 'number' &&
        Number.isFinite(parsed.savedWallMs)
      ) {
        return {
          lastHlcPt: typeof parsed.lastHlcPt === 'number' && Number.isFinite(parsed.lastHlcPt) ? parsed.lastHlcPt : 0,
          savedCalibratedMs: parsed.savedCalibratedMs,
          savedWallMs: parsed.savedWallMs,
          calibratedByHost: Boolean(parsed.calibratedByHost),
          updatedAtWallMs:
            typeof parsed.updatedAtWallMs === 'number' && Number.isFinite(parsed.updatedAtWallMs)
              ? parsed.updatedAtWallMs
              : parsed.savedWallMs
        }
      }
    } catch {
      // Ignore corrupt anchor
    }
    return null
  }

  private currentBaseWithoutOffset(): number {
    const elapsed = Math.max(0, this.env.monoNow() - this.baseMonoMs)
    return Math.floor(this.baseHostMs + elapsed)
  }

  /**
   * Returns current calibrated monotonic logical-physical timestamp (ms).
   * Strictly reads performance.now() oscillator; never invokes Date.now().
   */
  now(): number {
    const elapsed = Math.max(0, this.env.monoNow() - this.baseMonoMs)
    const candidate = Math.floor(this.baseHostMs + elapsed + this.env.testOffsetMs())
    const result = Math.max(candidate, this.lastReturnedMs)
    this.lastReturnedMs = result
    return result
  }

  getLastCommittedHlcPt(): number {
    return this.lastCommittedHlcPt
  }

  isCalibratedByHost(): boolean {
    return this.calibratedByHost
  }

  /**
   * Records a committed CRDT HLC physical timestamp and persists the cold-restart anchor.
   */
  recordCommittedHlcPt(pt: number): void {
    if (typeof pt !== 'number' || !Number.isFinite(pt) || pt <= 0) return
    if (pt > this.lastCommittedHlcPt) {
      this.lastCommittedHlcPt = Math.floor(pt)
      this.persistAnchor()
    }
  }

  /**
   * Anchors zero-point from 3-sample min-RTT Host CLOCK_SYNC responses.
   */
  calibrateFromHostSamples(
    samples: ClockSyncSample[],
    options?: { forceReanchor?: boolean }
  ): CalibrationApplyResult {
    const valid = samples.filter(
      (s) =>
        typeof s.hostNow === 'number' &&
        Number.isFinite(s.hostNow) &&
        s.hostNow > 0 &&
        typeof s.rttMs === 'number' &&
        Number.isFinite(s.rttMs) &&
        s.rttMs >= 0 &&
        typeof s.clientMonoM1 === 'number' &&
        typeof s.clientMonoM2 === 'number' &&
        s.clientMonoM2 >= s.clientMonoM1
    )
    if (valid.length === 0) {
      return { applied: false }
    }

    let best = valid[0]!
    for (let i = 1; i < valid.length; i++) {
      if (valid[i]!.rttMs < best.rttMs) {
        best = valid[i]!
      }
    }

    const estimatedHostNow = Math.floor(best.hostNow + best.rttMs / 2)
    const currentMono = this.env.monoNow()
    const anchorMono = best.clientMonoM2 <= currentMono ? best.clientMonoM2 : currentMono
    const elapsedSinceSample = Math.max(0, currentMono - anchorMono)
    const estimatedNow = Math.floor(estimatedHostNow + elapsedSinceSample)
    const currentOffset = this.env.testOffsetMs()

    let targetNow: number
    if (options?.forceReanchor) {
      this.lastCommittedHlcPt = 0
      targetNow = estimatedNow
    } else if (
      this.lastCommittedHlcPt > 0 &&
      this.lastCommittedHlcPt <= estimatedNow + MAX_CLOCK_SKEW_MS
    ) {
      targetNow = Math.max(estimatedNow, this.lastCommittedHlcPt + 1)
    } else {
      targetNow = estimatedNow
    }

    this.baseHostMs = targetNow - currentOffset
    this.baseMonoMs = currentMono
    this.lastReturnedMs = targetNow
    this.calibratedByHost = true
    this.lastActiveWallMs = this.env.wallNow()
    this.lastActiveMonoMs = currentMono
    this.persistAnchor()

    return {
      applied: true,
      estimatedHostNow: targetNow,
      minRttMs: best.rttMs
    }
  }

  /**
   * Aligns a newly promoted Host clock with the cluster-robust median of online Witness HLCs.
   * Ensures the Host's subsequent writes are strictly newer than historical offline data.
   */
  alignHostWithWitnesses(witnessMaxPts: number[]): number {
    const currentNow = this.now()
    const median = computeRobustWitnessMedian(witnessMaxPts, currentNow)
    if (median !== null && median >= currentNow) {
      const targetNow = Math.floor(median) + 1
      this.baseHostMs = targetNow - this.env.testOffsetMs()
      this.baseMonoMs = this.env.monoNow()
      this.lastReturnedMs = targetNow
      this.lastActiveWallMs = this.env.wallNow()
      this.lastActiveMonoMs = this.baseMonoMs
      this.persistAnchor()
      return targetNow
    }
    return currentNow
  }

  markBackgrounded(): void {
    this.lastActiveWallMs = this.env.wallNow()
    this.lastActiveMonoMs = this.env.monoNow()
    this.persistAnchor()
  }

  /**
   * Compensates frozen CLOCK_MONOTONIC during mobile deep sleep while offline.
   * Rejects negative or >12h wall-clock deltas as system clock tampering.
   */
  handleVisibilityResume(isOfflineOverride?: boolean): boolean {
    const currentWall = this.env.wallNow()
    const currentMono = this.env.monoNow()
    const deltaWall = currentWall - this.lastActiveWallMs
    const deltaMono = Math.max(0, currentMono - this.lastActiveMonoMs)
    const sleepGap = deltaWall - deltaMono

    this.lastActiveWallMs = currentWall
    this.lastActiveMonoMs = currentMono

    const isOffline = isOfflineOverride ?? !this.env.isOnline()
    if (!isOffline) {
      return false
    }

    if (sleepGap > 0 && sleepGap <= MAX_OFFLINE_WALL_COMPENSATION_MS) {
      const currentNow = this.now()
      const targetNow = Math.floor(currentNow + sleepGap)
      this.baseHostMs = targetNow - this.env.testOffsetMs()
      this.baseMonoMs = currentMono
      this.lastReturnedMs = Math.max(this.lastReturnedMs, targetNow)
      this.persistAnchor()
      return true
    }

    return false
  }

  persistAnchor(): void {
    if (!this.env.storage || !this.eventId) return
    try {
      const wall = this.env.wallNow()
      const snapshot: ClockAnchorSnapshot = {
        lastHlcPt: this.lastCommittedHlcPt,
        savedCalibratedMs: this.currentBaseWithoutOffset(),
        savedWallMs: wall,
        calibratedByHost: this.calibratedByHost,
        updatedAtWallMs: wall
      }
      this.env.storage.setItem(getClockAnchorKey(this.eventId), JSON.stringify(snapshot))
    } catch {
      // Ignore storage quota errors
    }
  }
}

// --- Event-Scoped Clock Registry ---
const clockRegistry = new Map<string, CalibratedMonotonicClock>()
let visibilityListenerAttached = false

function handleGlobalVisibilityChange(): void {
  if (typeof document === 'undefined') return
  if (document.visibilityState === 'hidden') {
    clockRegistry.forEach((clock) => clock.markBackgrounded())
  } else if (document.visibilityState === 'visible') {
    clockRegistry.forEach((clock) => clock.handleVisibilityResume())
  }
}

function ensureVisibilityListener(): void {
  if (visibilityListenerAttached || typeof document === 'undefined') return
  document.addEventListener('visibilitychange', handleGlobalVisibilityChange)
  visibilityListenerAttached = true
}

export function getCalibratedClockForEvent(eventId: string, env?: ClockEnvironment): CalibratedMonotonicClock {
  const key = (eventId || 'default').trim()
  let existing = clockRegistry.get(key)
  if (!existing) {
    existing = new CalibratedMonotonicClock(key, env)
    clockRegistry.set(key, existing)
    if (!env) {
      ensureVisibilityListener()
    }
  }
  return existing
}

export function migrateClockAnchor(oldEventId: string, newEventId: string): void {
  if (!oldEventId || !newEventId || oldEventId === newEventId) return
  if (typeof localStorage !== 'undefined') {
    try {
      const oldKey = getClockAnchorKey(oldEventId)
      const newKey = getClockAnchorKey(newEventId)
      const oldRaw = localStorage.getItem(oldKey)
      if (oldRaw) {
        const newRaw = localStorage.getItem(newKey)
        if (!newRaw) {
          localStorage.setItem(newKey, oldRaw)
        } else {
          const oldSnap = JSON.parse(oldRaw) as Partial<ClockAnchorSnapshot>
          const newSnap = JSON.parse(newRaw) as Partial<ClockAnchorSnapshot>
          if ((oldSnap.lastHlcPt || 0) > (newSnap.lastHlcPt || 0)) {
            localStorage.setItem(newKey, oldRaw)
          }
        }
      }
    } catch {
      // Ignore storage errors
    }
  }
  const existingOld = clockRegistry.get(oldEventId)
  if (existingOld && !clockRegistry.has(newEventId)) {
    existingOld.persistAnchor()
    clockRegistry.set(newEventId, new CalibratedMonotonicClock(newEventId))
  }
}

export function resetClockRegistryForTesting(): void {
  clockRegistry.clear()
}
