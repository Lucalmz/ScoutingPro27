import { createMergeableStore, type MergeableContent, type MergeableStore } from 'tinybase'
import { createIndexedDbPersister, type IndexedDbPersister } from 'tinybase/persisters/persister-indexed-db'
import type { CalibratedMonotonicClock } from '@/services/clock'
import { isStaticCloudHost } from '@/services/api'
import { isPlaceholderEventId } from '@/services/webrtc/epochStore'
import {
  defaultCrdtHttpTransport,
  type CrdtHttpTransport,
  type CrdtSaveStateResponse
} from './crdtApi'
import { extractMaxHlcPtFromSnapshot } from './hlcGuard'

export const DEFAULT_CRDT_DEBOUNCE_MS = 1500
export const DEFAULT_CRDT_MAX_WAIT_MS = 5000

export interface CrdtPersistenceOptions {
  eventId: string
  store: MergeableStore
  clock: CalibratedMonotonicClock
  getHostEpoch: () => number
  debounceMs?: number
  maxWaitMs?: number
  transport?: CrdtHttpTransport
  enableHttp?: boolean
  enableIndexedDb?: boolean
  onStaleRevision?: (res: CrdtSaveStateResponse) => void
  onPersistError?: (err: unknown) => void
}

export interface FlushOptions {
  keepalive?: boolean
  fullProjection?: boolean
}

function isVitestRuntime(): boolean {
  return Boolean(
    (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || process.env?.VITEST === 'true')) ||
      (globalThis as Record<string, unknown>).__vitest_worker__
  )
}

function hasUsableIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

export interface CrdtHydrateResult {
  loaded: boolean
  hostEpoch: number
  snapshotRevision: number
  hasLocalDiff: boolean
}

export interface CrdtPersistenceController {
  initLocalPersistence: () => Promise<void>
  hydrateFromH2: () => Promise<CrdtHydrateResult>
  applyMergeableSnapshot: (snapshot: unknown, markAllDirty?: boolean) => boolean
  markAllRowsDirty: () => void
  scheduleFlush: () => void
  flushNow: (options?: FlushOptions) => Promise<CrdtSaveStateResponse | null>
  getPendingDirtyRows: () => Record<string, string[]>
  getSnapshotRevision: () => number
  setHostEpochResolver: (resolver: () => number) => void
  destroy: () => Promise<void>
}

export function createCrdtPersistenceController(opts: CrdtPersistenceOptions): CrdtPersistenceController {
  const { eventId, store, clock } = opts
  const debounceMs = opts.debounceMs ?? DEFAULT_CRDT_DEBOUNCE_MS
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_CRDT_MAX_WAIT_MS
  const transport = opts.transport ?? defaultCrdtHttpTransport
  const isHttpEnabled =
    opts.enableHttp ??
    (!isVitestRuntime() ||
      Boolean(opts.transport) ||
      Boolean((globalThis as Record<string, unknown>).__TEST_ENABLE_CRDT_HTTP__))
  const isIndexedDbEnabled =
    opts.enableIndexedDb ??
    (hasUsableIndexedDb() &&
      (!isVitestRuntime() || Boolean((globalThis as Record<string, unknown>).__TEST_ENABLE_CRDT_IDB__)))

  function canUseHttpForEvent(): boolean {
    if (!isHttpEnabled) return false
    if (!opts.transport && opts.enableHttp !== true && (isStaticCloudHost() || isPlaceholderEventId(eventId))) {
      return false
    }
    return true
  }

  let getHostEpoch = opts.getHostEpoch
  let snapshotRevision = 0
  let suppressDirtyTracking = 0
  let idbPersister: IndexedDbPersister | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  let inFlightPromise: Promise<CrdtSaveStateResponse | null> | null = null
  let queuedFlush = false
  let queuedFlushOpts: FlushOptions = {}
  let destroyed = false

  const pendingDirtyRows = new Map<string, Set<string>>()

  function addDirtyRow(tableId: string, rowId: string): void {
    let set = pendingDirtyRows.get(tableId)
    if (!set) {
      set = new Set<string>()
      pendingDirtyRows.set(tableId, set)
    }
    set.add(rowId)
  }

  function snapshotAndClearDirtyRows(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [tableId, rowSet] of pendingDirtyRows.entries()) {
      if (rowSet.size > 0) {
        out[tableId] = Array.from(rowSet)
      }
    }
    pendingDirtyRows.clear()
    return out
  }

  function restoreDirtyRows(batch: Record<string, string[]>): void {
    for (const [tableId, ids] of Object.entries(batch)) {
      for (const rid of ids) {
        addDirtyRow(tableId, rid)
      }
    }
  }

  function hasPendingDirty(): boolean {
    for (const rowSet of pendingDirtyRows.values()) {
      if (rowSet.size > 0) return true
    }
    return false
  }

  function clearTimers(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer)
      maxWaitTimer = null
    }
  }

  function scheduleFlush(): void {
    if (destroyed || !canUseHttpForEvent()) return
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (maxWaitTimer) {
        clearTimeout(maxWaitTimer)
        maxWaitTimer = null
      }
      void flushNow()
    }, debounceMs)

    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = null
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = null
        }
        void flushNow()
      }, maxWaitMs)
    }
  }

  const listenerId = store.addDidFinishTransactionListener(() => {
    if (suppressDirtyTracking > 0 || destroyed) return
    const [changedTables] = store.getTransactionChanges()
    if (!changedTables || typeof changedTables !== 'object') return

    let touched = false
    for (const [tableId, rows] of Object.entries(changedTables)) {
      if (!rows || typeof rows !== 'object') continue
      for (const rowId of Object.keys(rows)) {
        addDirtyRow(tableId, rowId)
        touched = true
      }
    }

    if (touched) {
      clock.recordCommittedHlcPt(clock.now())
      scheduleFlush()
    }
  })

  function markAllRowsDirty(): void {
    const tables = store.getTables()
    for (const [tableId, rows] of Object.entries(tables)) {
      if (!rows || typeof rows !== 'object') continue
      for (const rowId of Object.keys(rows)) {
        addDirtyRow(tableId, rowId)
      }
    }
  }

  function applyMergeableSnapshot(snapshot: unknown, markAllDirty = false): boolean {
    if (!Array.isArray(snapshot) || snapshot.length < 2) {
      return false
    }
    const tablesStamp = snapshot[0]
    const valuesStamp = snapshot[1]
    if (!Array.isArray(tablesStamp) || !Array.isArray(valuesStamp)) {
      return false
    }

    const maxPt = extractMaxHlcPtFromSnapshot(snapshot)
    if (maxPt > 0 && maxPt <= clock.now() + 300_000) {
      clock.recordCommittedHlcPt(maxPt)
    }

    if (markAllDirty) {
      store.applyMergeableChanges([tablesStamp, valuesStamp, 1] as unknown as MergeableContent)
      return true
    }

    suppressDirtyTracking++
    try {
      store.applyMergeableChanges([tablesStamp, valuesStamp, 1] as unknown as MergeableContent)
    } finally {
      suppressDirtyTracking--
    }
    return true
  }

  async function initLocalPersistence(): Promise<void> {
    if (!isIndexedDbEnabled || idbPersister || destroyed) return
    try {
      idbPersister = createIndexedDbPersister(store, `sp27_crdt_${eventId}`)
      suppressDirtyTracking++
      try {
        await idbPersister.load()
      } finally {
        suppressDirtyTracking--
      }
      const maxPt = extractMaxHlcPtFromSnapshot(store.getMergeableContent())
      if (maxPt > 0 && maxPt <= clock.now() + 300_000) {
        clock.recordCommittedHlcPt(maxPt)
      }
      await idbPersister.startAutoSave()
    } catch {
      idbPersister = null
    }
  }

  function hasNonEmptyLocalContent(): boolean {
    const hashes = store.getMergeableContentHashes()
    return hashes[0] !== 0 || hashes[1] !== 0
  }

  function snapshotDiffersFromStore(snapshot: unknown): boolean {
    if (!Array.isArray(snapshot) || snapshot.length < 2) {
      return hasNonEmptyLocalContent()
    }
    try {
      const probe = createMergeableStore('crdt_diff_probe', () => clock.now(), 300)
      probe.applyMergeableChanges([snapshot[0], snapshot[1], 1] as unknown as MergeableContent)
      const localHashes = store.getMergeableContentHashes()
      const remoteHashes = probe.getMergeableContentHashes()
      return localHashes[0] !== remoteHashes[0] || localHashes[1] !== remoteHashes[1]
    } catch {
      return hasNonEmptyLocalContent()
    }
  }

  async function hydrateFromH2(): Promise<CrdtHydrateResult> {
    if (!canUseHttpForEvent()) {
      return {
        loaded: false,
        hostEpoch: getHostEpoch(),
        snapshotRevision,
        hasLocalDiff: hasNonEmptyLocalContent()
      }
    }
    try {
      const res = await transport.loadState(eventId)
      if (!res) {
        return {
          loaded: false,
          hostEpoch: getHostEpoch(),
          snapshotRevision,
          hasLocalDiff: hasNonEmptyLocalContent()
        }
      }
      if (typeof res.snapshotRevision === 'number' && res.snapshotRevision > snapshotRevision) {
        snapshotRevision = res.snapshotRevision
      }
      let loaded = false
      let hasLocalDiff = false
      if (res.exists && res.snapshot) {
        loaded = applyMergeableSnapshot(res.snapshot, false)
        hasLocalDiff = snapshotDiffersFromStore(res.snapshot)
      } else {
        hasLocalDiff = hasNonEmptyLocalContent()
      }
      return {
        loaded,
        hostEpoch: res.hostEpoch || 1,
        snapshotRevision,
        hasLocalDiff
      }
    } catch {
      return {
        loaded: false,
        hostEpoch: getHostEpoch(),
        snapshotRevision,
        hasLocalDiff: hasNonEmptyLocalContent()
      }
    }
  }

  async function executeFlush(flushOpts: FlushOptions): Promise<CrdtSaveStateResponse | null> {
    const batchDirty = snapshotAndClearDirtyRows()
    if (!flushOpts.fullProjection && Object.keys(batchDirty).length === 0) {
      return null
    }

    snapshotRevision += 1
    const sentRev = snapshotRevision
    const sentEpoch = Math.max(1, getHostEpoch())
    const snapshot = store.getMergeableContent()

    try {
      const res = await transport.saveState(
        eventId,
        {
          hostEpoch: sentEpoch,
          snapshotRevision: sentRev,
          snapshot,
          dirtyRows: batchDirty,
          fullProjection: Boolean(flushOpts.fullProjection)
        },
        { keepalive: flushOpts.keepalive }
      )

      if (res.stale) {
        restoreDirtyRows(batchDirty)
        if (typeof res.snapshotRevision === 'number' && res.snapshotRevision >= snapshotRevision) {
          snapshotRevision = res.snapshotRevision
        }
        opts.onStaleRevision?.(res)
        return res
      }

      if (typeof res.snapshotRevision === 'number' && res.snapshotRevision > snapshotRevision) {
        snapshotRevision = res.snapshotRevision
      }
      return res
    } catch (err) {
      restoreDirtyRows(batchDirty)
      opts.onPersistError?.(err)
      return null
    }
  }

  async function flushNow(flushOpts: FlushOptions = {}): Promise<CrdtSaveStateResponse | null> {
    clearTimers()
    if (!canUseHttpForEvent()) return null
    if (!flushOpts.fullProjection && !hasPendingDirty() && !inFlightPromise) {
      return null
    }

    if (inFlightPromise) {
      queuedFlush = true
      queuedFlushOpts = {
        keepalive: queuedFlushOpts.keepalive || flushOpts.keepalive,
        fullProjection: queuedFlushOpts.fullProjection || flushOpts.fullProjection
      }
      await inFlightPromise
      if (queuedFlush && (hasPendingDirty() || queuedFlushOpts.fullProjection)) {
        const nextOpts = { ...queuedFlushOpts }
        queuedFlush = false
        queuedFlushOpts = {}
        return await flushNow(nextOpts)
      }
      return null
    }

    const run = (async (): Promise<CrdtSaveStateResponse | null> => {
      let lastRes: CrdtSaveStateResponse | null = null
      lastRes = await executeFlush(flushOpts)
      while (queuedFlush && !destroyed && (hasPendingDirty() || queuedFlushOpts.fullProjection)) {
        const nextOpts = { ...queuedFlushOpts }
        queuedFlush = false
        queuedFlushOpts = {}
        lastRes = await executeFlush(nextOpts)
      }
      return lastRes
    })()

    inFlightPromise = run
    try {
      return await run
    } finally {
      if (inFlightPromise === run) {
        inFlightPromise = null
      }
    }
  }

  async function destroy(): Promise<void> {
    destroyed = true
    clearTimers()
    store.delListener(listenerId)
    if (idbPersister) {
      try {
        await idbPersister.save()
        await idbPersister.destroy()
      } catch {}
      idbPersister = null
    }
  }

  return {
    initLocalPersistence,
    hydrateFromH2,
    applyMergeableSnapshot,
    markAllRowsDirty,
    scheduleFlush,
    flushNow,
    getPendingDirtyRows: () => {
      const out: Record<string, string[]> = {}
      for (const [t, set] of pendingDirtyRows.entries()) {
        if (set.size > 0) out[t] = Array.from(set)
      }
      return out
    },
    getSnapshotRevision: () => snapshotRevision,
    setHostEpochResolver: (resolver: () => number) => {
      getHostEpoch = resolver
    },
    destroy
  }
}
