import { getHlcFunctions } from 'tinybase'
import { MAX_CLOCK_SKEW_MS } from '@/services/clock'

const [, , , decodeHlc] = getHlcFunctions()

// TinyBase HLC strings are strictly 16 characters in custom base-64 alphabet
const HLC_STRING_REGEX = /^[-0-9A-Z_a-z]{16}$/

// Numeric TinyBase synchronizer message codes (matches tinybase/synchronizers Message const enum without runtime enum access)
const MSG_RESPONSE = 0
const MSG_CONTENT_DIFF = 3

export interface HlcScanResult {
  maxIncomingPt: number
  maxSkewMs: number
  hasFutureSkew: boolean
  offendingHlc?: string
  scannedStamps: number
}

function inspectHlcCandidate(
  hlc: unknown,
  localNowMs: number,
  maxSkewMs: number,
  state: HlcScanResult
): void {
  if (typeof hlc !== 'string' || !HLC_STRING_REGEX.test(hlc)) return
  try {
    const [logicalTime] = decodeHlc(hlc)
    if (typeof logicalTime !== 'number' || !Number.isFinite(logicalTime) || logicalTime <= 0) {
      return
    }
    state.scannedStamps++
    if (logicalTime > state.maxIncomingPt) {
      state.maxIncomingPt = logicalTime
    }
    const skew = logicalTime - localNowMs
    if (skew > state.maxSkewMs) {
      state.maxSkewMs = skew
    }
    if (skew > maxSkewMs) {
      state.hasFutureSkew = true
      if (!state.offendingHlc) {
        state.offendingHlc = hlc
      }
    }
  } catch {
    // Ignore malformed HLC strings; TinyBase internal validator also guards them
  }
}

/**
 * Walks ONLY TinyBase Stamp tuples `[data, hlc?, hash?]`, inspecting exclusively stamp slot `[1]`
 * so raw user cell values at `[0]` (even 16-char strings) NEVER trigger false-positive skew alerts.
 *
 * depths:
 *  - 0: CellStamp / ValueStamp -> `[primitiveValue, hlc?, hash?]`
 *  - 1: RowStamp / ValuesStamp -> `[Record<id, childStamp>, hlc?, hash?]`
 *  - 2: TableStamp -> `[Record<rowId, RowStamp>, hlc?, hash?]`
 *  - 3: TablesStamp -> `[Record<tableId, TableStamp>, hlc?, hash?]`
 */
export function scanStampNode(
  node: unknown,
  depth: number,
  localNowMs: number,
  maxSkewMs: number,
  state: HlcScanResult
): void {
  if (!Array.isArray(node)) return
  if (node.length >= 2) {
    inspectHlcCandidate(node[1], localNowMs, maxSkewMs, state)
  }
  if (depth <= 0) {
    // Slot [0] is a leaf primitive cell value — do NOT inspect or descend into it!
    return
  }
  const childMap = node[0]
  if (!childMap || typeof childMap !== 'object' || Array.isArray(childMap)) return
  for (const child of Object.values(childMap as Record<string, unknown>)) {
    scanStampNode(child, depth - 1, localNowMs, maxSkewMs, state)
  }
}

export function scanMergeableContent(
  content: unknown,
  localNowMs: number,
  maxSkewMs = MAX_CLOCK_SKEW_MS
): HlcScanResult {
  const state: HlcScanResult = {
    maxIncomingPt: 0,
    maxSkewMs: 0,
    hasFutureSkew: false,
    scannedStamps: 0
  }
  if (!Array.isArray(content)) return state
  if (content.length >= 1) {
    scanStampNode(content[0], 3, localNowMs, maxSkewMs, state)
  }
  if (content.length >= 2) {
    scanStampNode(content[1], 1, localNowMs, maxSkewMs, state)
  }
  return state
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

/**
 * Inspects inbound TinyBase Synchronizer `message` + `body` BEFORE feeding it to MergeableStore,
 * catching poisoned >300s future HLC timestamps so caller can emit `FORCE_CLOCK_RESYNC`.
 */
export function scanSyncMessageBody(
  message: number,
  body: unknown,
  localNowMs: number,
  maxSkewMs = MAX_CLOCK_SKEW_MS
): HlcScanResult {
  const state: HlcScanResult = {
    maxIncomingPt: 0,
    maxSkewMs: 0,
    hasFutureSkew: false,
    scannedStamps: 0
  }

  if (message === MSG_CONTENT_DIFF) {
    return scanMergeableContent(body, localNowMs, maxSkewMs)
  }

  if (message === MSG_RESPONSE && Array.isArray(body)) {
    // Response may be:
    // 1. GetTableDiff / GetRowDiff: [TablesStamp, differingHashes] where TablesStamp = [ { tableId: TableStamp }, tablesHlc?, ... ]
    if (body.length >= 1 && Array.isArray(body[0]) && isPlainObject(body[0][0])) {
      scanStampNode(body[0], 3, localNowMs, maxSkewMs, state)
      return state
    }
    // 2. GetCellDiff: TablesStamp = [ { tableId: TableStamp }, ... ]
    if (body.length >= 1 && isPlainObject(body[0])) {
      scanStampNode(body, 3, localNowMs, maxSkewMs, state)
      // 3. GetValueDiff: ValuesStamp = [ { valueId: [primitive, hlc] }, valuesHlc? ]
      scanStampNode(body, 1, localNowMs, maxSkewMs, state)
      return state
    }
  }

  return state
}

export function extractMaxHlcPtFromSnapshot(snapshot: unknown): number {
  const res = scanMergeableContent(snapshot, 0, Number.POSITIVE_INFINITY)
  return res.maxIncomingPt
}
