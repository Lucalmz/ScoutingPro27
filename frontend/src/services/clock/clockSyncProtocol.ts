import type { WebRtcClockSyncReq, WebRtcClockSyncRes } from '@/types'
import type { CalibratedMonotonicClock, ClockSyncSample } from './calibratedClock'

export interface ClockSyncDriverOptions {
  clock: () => CalibratedMonotonicClock | null
  sendReq: (req: WebRtcClockSyncReq) => Promise<void>
  monoNow?: () => number
  sampleCount?: number
  sampleTimeoutMs?: number
  sampleDelayMs?: number
  onCalibrated?: (result: { applied: boolean; samplesCollected: number; minRttMs?: number; hostEpoch?: number }) => void
}

export interface ClockSyncRunResult {
  applied: boolean
  samplesCollected: number
  minRttMs?: number
  hostEpoch?: number
}

interface PendingSample {
  clientMonoM1: number
  resolve: (sample: ClockSyncSample | null) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Stateless 3-sample min-RTT handshake clock calibration driver.
 * Decoupled from WebRTC internals via narrow `sendReq` callback.
 */
export function createClockSyncDriver(opts: ClockSyncDriverOptions) {
  const monoNow =
    opts.monoNow ??
    (() => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()))
  const sampleCount = opts.sampleCount ?? 3
  const sampleTimeoutMs = opts.sampleTimeoutMs ?? 1500
  const sampleDelayMs = opts.sampleDelayMs ?? 25

  const pending = new Map<string, PendingSample>()
  let inFlightPromise: Promise<ClockSyncRunResult> | null = null
  let queuedForceReanchor = false
  let cancelled = false
  let seq = 0

  function cancelPending(): void {
    cancelled = true
    queuedForceReanchor = false
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve(null)
    }
    pending.clear()
  }

  function handleResponse(res: WebRtcClockSyncRes): void {
    if (!res || !res.reqId) return
    const entry = pending.get(res.reqId)
    if (!entry) return
    pending.delete(res.reqId)
    clearTimeout(entry.timer)

    const clientMonoM2 = monoNow()
    const rttMs = Math.max(0, clientMonoM2 - entry.clientMonoM1)
    entry.resolve({
      hostNow: Number(res.hostNow),
      clientMonoM1: entry.clientMonoM1,
      clientMonoM2,
      rttMs,
      hostEpoch: typeof res.hostEpoch === 'number' ? res.hostEpoch : undefined
    })
  }

  async function executeSingleSample(): Promise<ClockSyncSample | null> {
    if (cancelled) return null
    const reqId = `cs_${Date.now().toString(36)}_${++seq}_${Math.random().toString(36).slice(2, 6)}`
    const clientMonoM1 = monoNow()

    return new Promise<ClockSyncSample | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(reqId)
        resolve(null)
      }, sampleTimeoutMs)

      pending.set(reqId, { clientMonoM1, resolve, timer })

      opts
        .sendReq({
          type: 'CLOCK_SYNC_REQ',
          reqId,
          clientMonoM1
        })
        .catch(() => {
          const entry = pending.get(reqId)
          if (entry) {
            pending.delete(reqId)
            clearTimeout(entry.timer)
            resolve(null)
          }
        })
    })
  }

  async function runCalibrationInternal(forceReanchor: boolean): Promise<ClockSyncRunResult> {
    cancelled = false
    const samples: ClockSyncSample[] = []

    for (let i = 0; i < sampleCount; i++) {
      if (cancelled) break
      const sample = await executeSingleSample()
      if (sample && Number.isFinite(sample.hostNow) && sample.hostNow > 0) {
        samples.push(sample)
      }
      if (i < sampleCount - 1 && sampleDelayMs > 0 && !cancelled) {
        await new Promise((r) => setTimeout(r, sampleDelayMs))
      }
    }

    const targetClock = opts.clock()
    if (!targetClock || samples.length === 0) {
      return { applied: false, samplesCollected: samples.length }
    }

    const applied = targetClock.calibrateFromHostSamples(samples, { forceReanchor })
    const latestEpoch = samples.reduce<number | undefined>(
      (maxEp, s) => (typeof s.hostEpoch === 'number' ? Math.max(maxEp ?? 0, s.hostEpoch) : maxEp),
      undefined
    )
    const result: ClockSyncRunResult = {
      applied: applied.applied,
      samplesCollected: samples.length,
      minRttMs: applied.minRttMs,
      hostEpoch: latestEpoch
    }
    opts.onCalibrated?.(result)
    return result
  }

  function runCalibration(options?: { forceReanchor?: boolean }): Promise<ClockSyncRunResult> {
    const forceReanchor = Boolean(options?.forceReanchor)
    if (inFlightPromise) {
      if (forceReanchor) {
        queuedForceReanchor = true
      }
      return inFlightPromise
    }

    inFlightPromise = runCalibrationInternal(forceReanchor).finally(() => {
      inFlightPromise = null
      if (queuedForceReanchor && !cancelled) {
        queuedForceReanchor = false
        void runCalibration({ forceReanchor: true })
      }
    })
    return inFlightPromise
  }

  return {
    runCalibration,
    handleResponse,
    cancelPending
  }
}
